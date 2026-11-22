"""Regression tests for exact inventory quantities and transactional rollback."""
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from app import create_app
from app.core.canonical import PROFILE, build_command, canonical_json, fingerprint
from app.core.commands import validate_payload
from app.core.quantities import MAX_SAFE
from app.models import ProcessedOperation
from app.receipts import acceptance_digest


def uid(value):
    return str(UUID(int=value))


NOW = datetime(2026, 11, 18, 3, 0, tzinfo=timezone.utc)
EVENT = "2026-11-18T01:00:00Z"
CAT, ITEM, BATCH = uid(1), uid(2), uid(3)


class QuantityIntegrityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.database = Path(temporary.name, "quantities.sqlite")
        app = create_app({
            "DATABASE_URL": f"sqlite:///{self.database.as_posix()}",
            "TESTING": True,
            "NOW": lambda: NOW,
            "EXPIRATION_WARNING_DAYS": 4,
        })
        self.addCleanup(app.extensions["engine"].dispose)
        self.client = app.test_client()
        generation = self.client.get("/api/v1/health").headers["X-Inventory-Generation"]
        self.headers = {"X-Inventory-Generation": generation}
        self.accept(10, "create_category", CAT, {"category_id": CAT, "name": "Supplies"})
        self.accept(11, "create_item", ITEM, {
            "item_id": ITEM, "category_id": CAT, "name": "Cups",
            "unit_of_measurement": "piece", "minimum_stock_level": 5,
        })

    def sync(self, operation, operation_type, entity_id, payload):
        return self.client.post("/api/v1/sync", headers=self.headers, json={
            "operation_id": uid(operation), "operation_type": operation_type,
            "entity_id": entity_id, "payload": payload, "created_at": EVENT,
            "local_sequence": operation,
        })

    def accept(self, operation, operation_type, entity_id, payload, *, outcome="accepted"):
        response = self.sync(operation, operation_type, entity_id, payload)
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.json["data"]["outcome"], outcome)
        return response.json["data"]

    def movement(self, entity, kind, allocations, *, new_batches=()):
        return {
            "movement_id": uid(entity), "item_id": ITEM, "movement_type": kind,
            "quantity_change": sum(quantity for _, quantity in allocations),
            "reason": "Fictional test movement",
            "allocations": [
                {"allocation_id": uid(entity * 100 + index), "batch_id": batch,
                 "quantity_change": quantity}
                for index, (batch, quantity) in enumerate(allocations)
            ],
            "new_batches": [
                {"batch_id": batch, "received_quantity": quantity, "expiration_date": "2026-11-21"}
                for batch, quantity in new_batches
            ],
        }

    def receipt(self, entity, batch, quantity):
        return self.movement(entity, "stock_in", [(batch, quantity)],
                             new_batches=[(batch, quantity)])

    def accept_movement(self, operation, payload, *, outcome="accepted"):
        return self.accept(operation, "record_stock_movement", payload["movement_id"],
                           payload, outcome=outcome)

    def ledger_rows(self):
        """Compare complete rows, including the operation receipt and allocations."""
        with closing(sqlite3.connect(self.database)) as connection, connection:
            return {
                table: connection.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
                for table in (
                    "inventory_items", "stock_batches", "stock_movements",
                    "batch_allocations", "processed_operations", "receipt_ledger_head",
                )
            }

    def assert_quantity(self, route, field, expected):
        response = self.client.get("/api/v1/" + route)
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.json["data"][field], expected)

    def assert_invalid(self, response):
        self.assertEqual(response.status_code, 422, response.get_json())
        self.assertFalse(response.json["success"])
        self.assertEqual(response.json["error"]["code"], "VALIDATION_ERROR")
        self.assertNotIn("sqlite", response.get_data(as_text=True).lower())

    def assert_recovery(self, response):
        self.assertEqual(response.status_code, 409, response.get_json())
        self.assertEqual(response.json["error"]["code"], "RECOVERY_REQUIRED")
        self.assertNotIn("data", response.json)

    def test_rejected_max_plus_one_and_two_leave_every_table_unchanged(self):
        receipt = self.receipt(20, BATCH, MAX_SAFE)
        accepted = self.accept_movement(21, receipt)
        before = self.ledger_rows()
        for offset in (1, 2):
            for extra in (
                self.receipt(25, uid(4), offset),
                self.movement(26, "positive_adjustment", [(BATCH, offset)]),
            ):
                with self.subTest(offset=offset, movement=extra["movement_type"]):
                    response = self.sync(22, "record_stock_movement", extra["movement_id"], extra)
                    self.assert_invalid(response)
                    self.assertEqual(response.json["error"]["details"]["operation_id"], uid(22))
                    self.assertEqual(self.ledger_rows(), before)
        self.assert_quantity(f"inventory/{ITEM}", "available_quantity", MAX_SAFE)
        self.assert_quantity(f"batches/{BATCH}", "remaining_quantity", MAX_SAFE)
        retry = self.accept_movement(21, receipt, outcome="already_processed")
        self.assertEqual(retry, {**accepted, "outcome": "already_processed"})
        self.assertEqual(self.ledger_rows(), before)
        withdrawal = self.movement(23, "stock_out", [(BATCH, -MAX_SAFE)])
        self.accept_movement(24, withdrawal)
        with closing(sqlite3.connect(self.database)) as connection:
            positions = dict(connection.execute("SELECT operation_id, commit_seq FROM processed_operations"))
        self.assertEqual(positions[uid(24)], positions[uid(21)] + 1)
        self.assert_quantity(f"inventory/{ITEM}", "available_quantity", 0)
        self.assert_quantity(f"batches/{BATCH}", "remaining_quantity", 0)

    def test_offsetting_allocation_damage_cannot_seed_a_new_write(self):
        self.accept_movement(21, self.receipt(20, BATCH, 5))
        self.accept_movement(23, self.receipt(22, uid(4), 7))
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE batch_allocations SET quantity_change = 6")
        # The total is still 12, but neither allocation proves its movement.
        before = self.ledger_rows()
        self.assert_recovery(self.client.get(f"/api/v1/inventory/{ITEM}"))
        extra = self.movement(24, "positive_adjustment", [(BATCH, 1)])
        response = self.sync(25, "record_stock_movement", uid(24), extra)
        self.assertEqual(response.status_code, 409, response.json)
        self.assertEqual(response.json["error"]["code"], "RECOVERY_REQUIRED")
        self.assertEqual(self.ledger_rows(), before)

    def test_adjustments_and_outgoing_allocations_preserve_batch_and_item_totals(self):
        self.accept_movement(21, self.receipt(20, BATCH, 5))
        new_batch = uid(4)
        self.accept_movement(23, self.movement(
            22, "positive_adjustment", [(BATCH, 3), (new_batch, 2)], new_batches=[(new_batch, 2)],
        ))
        self.accept_movement(25, self.movement(24, "wastage", [(BATCH, -7), (new_batch, -1)]))
        self.accept_movement(27, self.movement(26, "negative_adjustment", [(BATCH, -1)]))
        self.assert_quantity(f"inventory/{ITEM}", "available_quantity", 1)
        self.assert_quantity(f"batches/{BATCH}", "remaining_quantity", 0)
        self.assert_quantity(f"batches/{new_batch}", "remaining_quantity", 1)
        self.assert_quantity("reports/dashboard", "low_stock_items", 1)
        rows = self.client.get("/api/v1/reports/expiring?status=expiring_soon")
        self.assertEqual(rows.status_code, 200, rows.json)
        self.assertEqual([(r["batch_id"], r["remaining_quantity"]) for r in rows.json["data"]],
                         [(new_batch, 1)])
        self.assertEqual(rows.json["meta"]["total"], 1)
        history = self.client.get(
            f"/api/v1/reports/stock-movements?item_id={ITEM}&movement_type=wastage"
            "&from=2026-11-18T01:00:00Z&to=2026-11-18T01:00:01Z&page_size=1")
        self.assertEqual(history.status_code, 200, history.json)
        self.assertEqual(history.json["meta"], {"page": 1, "page_size": 1, "total": 1})
        self.assertEqual(history.json["data"], [{
            "item_id": ITEM, "unit_of_measurement": "piece", "movement_type": "wastage",
            "movement_count": 1, "total_quantity_change": -8,
        }])

    def test_balances_are_exact_when_sqlite_sum_would_overflow_before_cancellation(self):
        """The same signs stored together need not be the historical replay order."""
        self.accept_movement(21, self.receipt(20, BATCH, MAX_SAFE))
        with closing(sqlite3.connect(self.database)) as connection, connection:
            # 1,025 maximum-size positives exceed signed 64-bit range. The
            # migration can leave physical row order different from replay order.
            # One receipt plus 1,024 cycles of use and correction, and a final
            # use, is a legal zero-balance history when funds alternate.
            # Bulk-load a coherent ledger so the route test also exercises
            # the integrity boundary. Its commit order alternates the signs.
            for start, count, quantity, kind, first_position in (
                (10000, 1024, MAX_SAFE, "positive_adjustment", 5),
                (20000, 1025, -MAX_SAFE, "stock_out", 4),
            ):
                for offset in range(count):
                    value = start + offset
                    movement_id = uid(value)
                    allocation_id = uid(value + 50000)
                    connection.execute(
                        "INSERT INTO stock_movements (movement_id, item_id, movement_type, "
                        "quantity_change, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (movement_id, ITEM, kind, quantity, "Historical movement", EVENT),
                    )
                    connection.execute(
                        "INSERT INTO batch_allocations (allocation_id, movement_id, batch_id, "
                        "quantity_change) VALUES (?, ?, ?, ?)",
                        (allocation_id, movement_id, BATCH, quantity),
                    )
                    result = {
                        "movement_id": movement_id, "item_id": ITEM, "movement_type": kind,
                        "quantity_change": quantity, "reason": "Historical movement",
                        "recorded_by": None, "created_at": EVENT,
                        "allocations": [{"allocation_id": allocation_id, "batch_id": BATCH,
                                         "quantity_change": quantity}],
                    }
                    payload = {key: item for key, item in result.items() if key != "created_at"}
                    operation = "record_stock_movement"
                    command = build_command(operation, movement_id, EVENT, validate_payload(operation, payload))
                    receipt = ProcessedOperation(
                        operation_id=uid(value + 100000), operation_type=operation, entity_id=movement_id,
                        request_fingerprint=fingerprint(command), fingerprint_profile=PROFILE,
                        processed_at=EVENT, processing_result=json.dumps(result),
                        commit_seq=first_position + 2 * offset, migration_metadata="verified",
                        acceptance_command=canonical_json(command),
                    )
                    connection.execute("""
                        INSERT INTO processed_operations
                        (operation_id, operation_type, entity_id, request_fingerprint, fingerprint_profile,
                         processed_at, processing_result, commit_seq, migration_metadata, acceptance_command,
                         acceptance_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        receipt.operation_id, receipt.operation_type, receipt.entity_id, receipt.request_fingerprint,
                        receipt.fingerprint_profile, receipt.processed_at, receipt.processing_result,
                        receipt.commit_seq, receipt.migration_metadata, receipt.acceptance_command,
                        acceptance_digest(receipt),
                    ))
            connection.execute("UPDATE receipt_ledger_head SET committed_seq=2052")
            for table in ("stock_movements", "batch_allocations"):
                with self.assertRaisesRegex(sqlite3.OperationalError, "integer overflow"):
                    connection.execute(
                        f"SELECT sum(quantity_change) FROM (SELECT quantity_change FROM {table} "
                        "ORDER BY quantity_change DESC LIMIT -1)"
                    ).fetchone()

        self.assert_quantity(f"inventory/{ITEM}", "available_quantity", 0)
        self.assert_quantity(f"batches/{BATCH}", "remaining_quantity", 0)
        self.assert_quantity("reports/dashboard", "out_of_stock_items", 1)
        expiration = self.client.get("/api/v1/reports/expiring")
        self.assertEqual(expiration.status_code, 200, expiration.json)
        self.assertEqual(expiration.json["data"], [])
        snapshot = self.client.get("/api/v2/snapshot")
        self.assertEqual(snapshot.status_code, 200, snapshot.json)
        self.assertEqual(snapshot.json["data"]["sync"]["last_commit_seq"], 2052)
        self.assertEqual(snapshot.json["data"]["inventory_items"][0]["available_quantity"], 0)

    def test_existing_fractional_data_is_rejected_without_coercion(self):
        self.accept_movement(21, self.receipt(20, BATCH, 1))
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE stock_movements SET quantity_change=1.25")
            connection.execute("UPDATE batch_allocations SET quantity_change=1.25")
            self.assertEqual(connection.execute(
                "SELECT typeof(quantity_change) FROM batch_allocations").fetchone(), ("real",))
        for route in (
            f"inventory/{ITEM}", "inventory", f"batches/{BATCH}",
            "reports/dashboard", "reports/low-stock", "reports/expiring?status=all",
            "reports/stock-movements", f"stock-movements/{uid(20)}",
        ):
            with self.subTest(route=route):
                self.assert_recovery(self.client.get("/api/v1/" + route))

    def test_dated_report_rejects_unsafe_legacy_batch_balance(self):
        self.accept_movement(21, self.receipt(20, BATCH, MAX_SAFE))
        # Recreate data an older server could already have committed.
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                "INSERT INTO stock_movements (movement_id, item_id, movement_type, "
                "quantity_change, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (uid(22), ITEM, "positive_adjustment", 2, "Historical correction", EVENT),
            )
            connection.execute(
                "INSERT INTO batch_allocations (allocation_id, movement_id, batch_id, "
                "quantity_change) VALUES (?, ?, ?, ?)",
                (uid(2200), uid(22), BATCH, 2),
            )
        before = self.ledger_rows()
        self.assert_recovery(self.client.get("/api/v1/reports/expiring?status=all"))
        self.assertEqual(self.ledger_rows(), before)

    def test_inconsistent_stored_batch_totals_cannot_seed_a_new_transaction(self):
        self.accept_movement(21, self.receipt(20, BATCH, 5))
        # A legacy defect can remove part of the incoming allocation without
        # changing the independently recorded item total.
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE batch_allocations SET quantity_change=4")
        before = self.ledger_rows()
        next_movement = self.receipt(22, uid(4), 1)
        response = self.sync(23, "record_stock_movement", next_movement["movement_id"], next_movement)
        self.assertEqual(response.status_code, 409, response.json)
        self.assertEqual(response.json["error"]["code"], "RECOVERY_REQUIRED")
        self.assertEqual(self.ledger_rows(), before)


if __name__ == "__main__":
    unittest.main()
