"""Cross-endpoint recovery and chronological acceptance regressions."""
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import sqlite3
import unittest

from sqlalchemy import event

from app import create_app
from app.db import session_scope
from app.models import ProcessedOperation
from app.receipts import acceptance_digest, read_receipt
from tests.test_integrity_migration import LEGACY_FIELDS, LEGACY_SCHEMA


def uid(number):
    return f"abcdefab-0000-4000-8000-{number:012d}"


NOW = "2026-11-18T03:00:00Z"
BACK = "2026-11-18T02:00:00Z"
CATEGORY, ITEM, BATCH, SIBLING = map(uid, (100, 200, 301, 302))
IN, OUT = uid(400), uid(401)


class CrossEndpointReplayTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name, "inventory.sqlite")
        self.config = {
            "DATABASE_URL": f"sqlite:///{self.path.as_posix()}",
            "TESTING": True, "EXPIRATION_WARNING_DAYS": 4,
            "NOW": lambda: datetime(2026, 11, 18, 4, tzinfo=timezone.utc),
        }
        self.reopen()

    def reopen(self):
        if hasattr(self, "app"):
            self.app.extensions["engine"].dispose()
        self.app = create_app(self.config)
        self.addCleanup(self.app.extensions["engine"].dispose)
        self.client = self.app.test_client()
        self.headers = {"X-Inventory-Generation":
                        self.client.get("/api/v1/health").headers["X-Inventory-Generation"]}

    def execute(self, statement, args=()):
        with closing(sqlite3.connect(self.path)) as conn, conn:
            return conn.execute(statement, args).fetchall()

    def records(self):
        return {table: self.execute(f"SELECT * FROM {table} ORDER BY 1") for table in (
            "categories", "inventory_items", "stock_batches", "stock_movements",
            "batch_allocations", "processed_operations", "receipt_ledger_head",
        )}

    def command(self, number, kind, entity, payload, stamp=NOW):
        return {"operation_id": uid(number), "operation_type": kind, "entity_id": entity,
                "payload": payload, "created_at": stamp, "local_sequence": number}

    def category(self, number=1, category=CATEGORY):
        return self.command(number, "create_category", category.upper(),
                            {"category_id": category, "name": f"Category {number}"})

    def item(self, number=2, item=ITEM, category=CATEGORY):
        return self.command(number, "create_item", item, {
            "item_id": item, "category_id": category.upper(), "name": f"Cups {number}",
            "unit_of_measurement": "piece", "minimum_stock_level": 16,
        })

    def movement(self, number, movement, allocations, *, incoming=False, item=ITEM):
        rows = [{"allocation_id": uid(aid), "batch_id": batch, "quantity_change": delta}
                for aid, batch, delta in allocations]
        payload = {"movement_id": movement, "item_id": item,
                   "movement_type": "stock_in" if incoming else "stock_out",
                   "quantity_change": sum(row["quantity_change"] for row in rows),
                   "allocations": rows}
        if incoming:
            payload["new_batches"] = [
                {"batch_id": row["batch_id"], "received_quantity": row["quantity_change"],
                 "expiration_date": "2026-11-21"} for row in rows
            ]
        return self.command(number, "record_stock_movement", movement.upper(), payload,
                            NOW if incoming else BACK)

    def submit(self, command, version=2):
        return self.client.post(f"/api/v{version}/sync", headers=self.headers, json=command)

    def ok(self, response):
        self.assertEqual(response.status_code, 200, response.json)
        return response.json["data"]

    def recovery(self, response):
        self.assertEqual(response.status_code, 409, response.json)
        self.assertEqual(response.json, {"success": False, "error": {
            "code": "RECOVERY_REQUIRED", "message": "Inventory history requires reconciliation.",
            "details": {},
        }})

    def accept(self, *commands):
        results = [self.ok(self.submit(command)) for command in commands]
        self.assertTrue(all(result["outcome"] == "accepted" for result in results))
        return results

    def stock(self, *, split=False):
        incoming, outgoing = [(500, BATCH, 20)], [(600, BATCH, -5)]
        if split:
            incoming.append((501, SIBLING, 7))
            outgoing.append((601, SIBLING, -2))
        commands = [self.category(), self.item(), self.movement(3, IN, incoming, incoming=True),
                    self.movement(4, OUT, outgoing)]
        self.accept(*commands)
        return commands

    def snapshot(self, version, *filters):
        return self.client.get(f"/api/v{version}/snapshot",
                               query_string=[("receipt_id", operation) for operation in filters])

    def filter_ids(self):
        return [(), (uid(3),), (uid(3), uid(4), uid(999)), (uid(999),)]

    def assert_recovery(self, commands, *, check_reads=False):
        before = self.records()
        for version in (1, 2):
            for filters in self.filter_ids():
                with self.subTest(version=version, filters=filters):
                    self.recovery(self.snapshot(version, *filters))
            for command in commands:
                with self.subTest(version=version, operation=command["operation_id"]):
                    self.recovery(self.submit(command, version))
            self.recovery(self.submit(self.category(98, uid(988)), version))
        if check_reads:
            for path in (
                f"/inventory/{ITEM}", "/inventory", f"/batches/{BATCH}", f"/batches/{SIBLING}",
                f"/inventory/{ITEM}/batches", "/reports/dashboard", "/reports/low-stock",
                "/reports/expiring?status=all", "/stock-movements",
                f"/stock-movements/{IN}", f"/stock-movements/{OUT}",
                "/reports/stock-movements", "/stock-movements?movement_type=stock_in",
            ):
                with self.subTest(path=path):
                    self.recovery(self.client.get(f"/api/v1{path}"))
        self.assertEqual(self.records(), before)

    def reseal(self, *operation_ids):
        with session_scope(self.app.extensions["session_factory"]) as session:
            for operation_id in operation_ids:
                receipt = session.get(ProcessedOperation, operation_id)
                receipt.acceptance_digest = acceptance_digest(receipt)
                self.assertIsNotNone(read_receipt(receipt), operation_id)

    def swap(self, first, second):
        with closing(sqlite3.connect(self.path)) as conn, conn:
            prior = [conn.execute("SELECT commit_seq FROM processed_operations WHERE operation_id=?",
                                 (op,)).fetchone()[0] for op in (first, second)]
            for op, sequence in zip((first, second, first), (99, prior[0], prior[1])):
                conn.execute("UPDATE processed_operations SET commit_seq=? WHERE operation_id=?",
                             (sequence, op))
        self.reseal(first, second)

    def test_all_stock_reads_and_retries_fail_closed_after_any_history_damage(self):
        damages = {
            "stock-in allocation loss": ("DELETE FROM batch_allocations WHERE allocation_id=?", (uid(500),)),
            "stock-out allocation loss": ("DELETE FROM batch_allocations WHERE allocation_id=?", (uid(600),)),
            "split sibling allocation loss": ("DELETE FROM batch_allocations WHERE allocation_id=?", (uid(601),)),
            "allocation amount": ("UPDATE batch_allocations SET quantity_change=-6 WHERE allocation_id=?", (uid(600),)),
            "movement amount": ("UPDATE stock_movements SET quantity_change=-6 WHERE movement_id=?", (OUT,)),
            "received amount": ("UPDATE stock_batches SET received_quantity=21 WHERE batch_id=?", (BATCH,)),
            "missing movement": ("DELETE FROM stock_movements WHERE movement_id=?", (OUT,)),
            "missing batch": ("DELETE FROM stock_batches WHERE batch_id=?", (SIBLING,)),
            "missing receipt": ("DELETE FROM processed_operations WHERE operation_id=?", (uid(4),)),
            "truncated receipt": ("UPDATE processed_operations SET processing_result='{' WHERE operation_id=?", (uid(4),)),
            "acceptance checksum": ("UPDATE processed_operations SET acceptance_digest='damaged' WHERE operation_id=?", (uid(4),)),
            "invalid timestamp": ("UPDATE processed_operations SET processed_at='bad time' WHERE operation_id=?", (uid(4),)),
            "invalid active flag": ("UPDATE inventory_items SET is_active=2 WHERE item_id=?", (ITEM,)),
        }
        commands = self.stock(split=True)
        self.assertEqual(self.ok(self.client.get(f"/api/v1/inventory/{ITEM}"))["available_quantity"], 20)
        self.assertEqual([self.ok(self.client.get(f"/api/v1/batches/{bid}"))["remaining_quantity"]
                          for bid in (BATCH, SIBLING)], [15, 5])
        for name, (sql, args) in damages.items():
            with self.subTest(damage=name):
                with closing(sqlite3.connect(self.path)) as connection:
                    original = sqlite3.connect(":memory:")
                    with closing(original):
                        connection.backup(original)
                        self.execute(sql, args)
                        try:
                            self.assert_recovery(commands, check_reads=True)
                        finally:
                            original.backup(connection)
        # Keep two shape-valid, individually sealed receipts claiming one movement.
        extra = uid(5)
        moved = self.execute("SELECT name FROM sqlite_master WHERE type='index' AND sql LIKE "
                             "'%UNIQUE%processed_operations%entity_id%'")
        self.assertEqual(len(moved), 1)
        self.execute(f'DROP INDEX "{moved[0][0]}"')
        self.execute("""INSERT INTO processed_operations (
                operation_id, operation_type, request_fingerprint, fingerprint_profile, processed_at,
                processing_result, entity_id, commit_seq, migration_metadata, acceptance_command, acceptance_digest)
            SELECT ?, operation_type, request_fingerprint, fingerprint_profile, processed_at,
                   processing_result, entity_id, 5, migration_metadata, acceptance_command, acceptance_digest
            FROM processed_operations WHERE operation_id=?""", (extra, uid(4)))
        self.execute("UPDATE receipt_ledger_head SET committed_seq=5")
        self.reseal(extra)
        self.assert_recovery(commands, check_reads=True)

    def test_category_before_item_and_item_before_movement(self):
        commands = self.stock()
        for first, second in ((1, 2), (2, 3)):
            with self.subTest(positions=(first, second)):
                self.swap(uid(first), uid(second))
                try:
                    self.assert_recovery(commands)
                finally:
                    self.swap(uid(first), uid(second))

    def test_historical_item_result_uses_stock_then_and_preserves_untouched_fields(self):
        commands = self.stock()
        update = self.command(5, "update_item", ITEM, {"minimum_stock_level": 4}, BACK)
        later = self.movement(6, uid(402), [(602, BATCH, -1)])
        another = self.command(7, "update_item", ITEM, {"name": "Renamed cups"})
        result, _, _ = self.accept(update, later, another)
        self.assertEqual(result["result"]["available_quantity"], 15)
        self.assertEqual(self.ok(self.snapshot(2))["inventory_items"][0]["available_quantity"], 14)
        for version in (1, 2):
            retry = self.ok(self.submit(update, version))
            self.assertEqual(retry["result"], result["result"])
            if version == 2:
                self.assertEqual(retry["commit_seq"], 5)
        operation_id = update["operation_id"]
        original = result["result"]
        for change in ({"available_quantity": 19}, {"name": "Invented", "normalized_name": "invented"},
                       {"created_at": "2026-11-18T01:00:00Z"}):
            with self.subTest(change=change):
                self.execute("UPDATE processed_operations SET processing_result=? WHERE operation_id=?",
                             (json.dumps(original | change), operation_id))
                self.reseal(operation_id)
                self.assert_recovery(commands + [update, later, another])

    def test_archive_dependencies_and_repeated_archive_follow_backend_policy(self):
        commands = self.stock()
        drain = self.movement(5, uid(402), [(602, BATCH, -15)])
        item_archive = self.command(6, "archive_item", ITEM, {}, BACK)
        repeat_item = self.command(7, "archive_item", ITEM.upper(), {})
        category_archive = self.command(8, "archive_category", CATEGORY, {}, BACK)
        repeat_category = self.command(9, "archive_category", CATEGORY.upper(), {})
        results = self.accept(drain, item_archive, repeat_item, category_archive, repeat_category)
        self.assertEqual(results[1]["result"], results[2]["result"])
        self.assertEqual(results[3]["result"], results[4]["result"])
        self.assertEqual(self.ok(self.snapshot(2))["replay"]["status"], "authoritative")
        self.swap(uid(6), uid(8))
        self.assert_recovery(commands + [item_archive, category_archive])

    def migrate(self):
        fields = ", ".join(LEGACY_FIELDS)
        for statement in (
            f"CREATE TABLE original_receipts ({LEGACY_SCHEMA})",
            f"INSERT INTO original_receipts ({fields}) SELECT {fields} FROM processed_operations",
            "DROP TABLE processed_operations",
            "ALTER TABLE original_receipts RENAME TO processed_operations",
            "DROP TABLE receipt_ledger_head",
        ):
            self.execute(statement)
        self.reopen()

    def test_provisional_suffix_rules_and_restart(self):
        commands = self.stock()
        self.accept(self.command(5, "update_item", ITEM, {"name": "Legacy name"}, BACK),
                    self.command(6, "update_item", ITEM, {"name": "Boundary name"}, NOW))
        self.migrate()
        category, item = uid(101), uid(201)
        category_command = self.category(7, category)
        item_command = self.item(8, item, category)
        incoming = self.movement(9, uid(404), [(610, SIBLING, 13)], incoming=True, item=item)
        outgoing = self.movement(10, uid(405), [(620, SIBLING, -3)], item=item)
        update_old = self.command(11, "update_item", ITEM, {"minimum_stock_level": 10}, BACK)
        results = self.accept(category_command, item_command, incoming, outgoing, update_old)
        self.assertEqual(results[-1]["result"]["name"], "Boundary name")
        self.assertEqual(results[-1]["result"]["available_quantity"], 15)
        self.assertTrue(all(row["commit_seq"] is None and row["replay_status"] == "provisional"
                            for row in results))
        self.reopen()
        for filters in self.filter_ids():
            snapshot = self.ok(self.snapshot(2, *filters))
            self.assertEqual(snapshot["replay"], {
                "status": "provisional", "order": None, "installation_blocked": True,
            })
        self.assertEqual(self.ok(self.snapshot(1))["schema_version"], 1)
        self.assertEqual(self.ok(self.client.get(f"/api/v1/batches/{SIBLING}"))["remaining_quantity"], 10)
        for version in (1, 2):
            self.assertEqual(self.ok(self.submit(outgoing, version))["outcome"], "already_processed")
        for first, second in ((9, 10), (7, 8), (8, 9)):
            with self.subTest(suffix=(first, second)):
                self.swap(uid(first), uid(second))
                try:
                    self.assert_recovery([*commands, category_command, item_command, incoming, outgoing, update_old])
                    self.assertEqual(self.execute("SELECT committed_seq, legacy_through FROM receipt_ledger_head"),
                                     [(11, 6)])
                finally:
                    self.swap(uid(first), uid(second))
        self.execute("DELETE FROM processed_operations WHERE operation_id=?", (uid(10),))
        self.assert_recovery([incoming, outgoing])
        self.assertEqual(self.execute("SELECT committed_seq, legacy_through FROM receipt_ledger_head"), [(11, 6)])

    def test_provisional_duplicate_suffix_position_blocks_both_versions(self):
        self.stock()
        self.migrate()
        first, second = self.category(5, uid(105)), self.category(6, uid(106))
        self.accept(first, second)
        indexes = self.execute("SELECT name FROM sqlite_master WHERE type='index' AND sql LIKE "
                               "'%UNIQUE%processed_operations%commit_seq%'")
        self.assertEqual(len(indexes), 1)
        self.execute(f'DROP INDEX "{indexes[0][0]}"')
        self.execute("UPDATE processed_operations SET commit_seq=5 WHERE operation_id=?", (uid(6),))
        self.reseal(uid(6))
        self.assert_recovery([first, second])

    def test_snapshot_uses_one_read_transaction_across_a_concurrent_commit(self):
        self.stock()
        self.assertEqual(self.execute("PRAGMA journal_mode=WAL"), [("wal",)])
        other = create_app(self.config)
        self.addCleanup(other.extensions["engine"].dispose)
        writer = other.test_client()
        outgoing = self.movement(5, uid(405), [(610, BATCH, -1)])
        committed = []

        def write_after_first_read(_conn, _cursor, statement, _parameters, _context, _many):
            if "FROM categories" in statement and not committed:
                response = writer.post("/api/v2/sync", json=outgoing, headers=self.headers)
                committed.append(self.ok(response)["commit_seq"])

        engine = self.app.extensions["engine"]
        event.listen(engine, "after_cursor_execute", write_after_first_read)
        try:
            initial = self.ok(self.snapshot(2, uid(5)))
        finally:
            event.remove(engine, "after_cursor_execute", write_after_first_read)
        self.assertEqual(committed, [5])
        self.assertEqual(initial["sync"]["last_commit_seq"], 4)
        self.assertEqual(initial["inventory_items"][0]["available_quantity"], 15)
        self.assertEqual(initial["receipt_checks"][0]["status"], "missing")
        updated = self.ok(self.snapshot(2, uid(5)))
        self.assertEqual(updated["sync"]["last_commit_seq"], 5)
        self.assertEqual(updated["inventory_items"][0]["available_quantity"], 14)
        self.assertEqual(updated["receipt_checks"][0]["status"], "accepted")

    def test_snapshot_query_and_empty_verified_contract(self):
        for version in (1, 2):
            for filters in self.filter_ids():
                data = self.ok(self.snapshot(version, *filters))
                self.assertEqual(data["stock_movements"], [])
                self.assertTrue(all(check["status"] == "missing" for check in data["receipt_checks"]))
                if version == 2:
                    self.assertEqual(data["replay"]["status"], "authoritative")
            for filters in (("malformed",), (uid(3), "malformed"), (uid(3),) * 101):
                response = self.snapshot(version, *filters)
                self.assertEqual((response.status_code, response.json["error"]["code"]),
                                 (400, "INVALID_REQUEST"))
        self.stock()
        self.execute("UPDATE processed_operations SET processed_at='bad time' WHERE operation_id=?", (uid(4),))
        for version in (1, 2):
            response = self.snapshot(version, uid(3), "malformed")
            self.assertEqual((response.status_code, response.json["error"]["code"]),
                             (400, "INVALID_REQUEST"))
