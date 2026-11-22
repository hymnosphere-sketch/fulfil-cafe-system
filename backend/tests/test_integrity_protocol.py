"""Regression tests for version isolation and movement receipt evidence."""
from contextlib import closing
from copy import deepcopy
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from sqlalchemy import event, select

from app import create_app
from app.db import session_scope
from app.models import Allocation, Movement, ProcessedOperation
from app.receipts import acceptance_digest, read_receipt


STAMP = "2026-11-18T02:00:00Z"
EARLIER = "2026-11-18T01:00:00Z"


class IntegrityProtocol(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name, "inventory.sqlite").as_posix()
        self.config = {"DATABASE_URL": f"sqlite:///{self.path}", "TESTING": True,
                       "NOW": lambda: datetime(2026, 11, 18, tzinfo=timezone.utc)}
        self.app = create_app(self.config)
        self.addCleanup(self.app.extensions["engine"].dispose)
        self.client = self.app.test_client()
        self.generation = self.client.get("/api/v1/health").headers["X-Inventory-Generation"]
        self.headers = {"X-Inventory-Generation": self.generation}

    def command(self, typ, entity, payload, stamp=STAMP, op=None):
        return {"operation_id": op or str(uuid4()), "operation_type": typ,
                "entity_id": entity, "payload": payload, "created_at": stamp,
                "local_sequence": 1}

    def submit(self, command, version=1, headers=None):
        return self.client.post(f"/api/v{version}/sync", json=command,
                                headers=self.headers if headers is None else headers)

    def accepted(self, command, version=1):
        response = self.submit(command, version)
        self.assertEqual(response.status_code, 200, response.json)
        return response.json["data"]

    def snapshot(self, version=2, operation_id=None):
        query = {} if operation_id is None else {"receipt_id": operation_id}
        response = self.client.get(f"/api/v{version}/snapshot", query_string=query)
        self.assertEqual(response.status_code, 200, response.json)
        return response.json["data"]

    def assert_snapshot_recovery(self, operation_id=None):
        query = {} if operation_id is None else {"receipt_id": operation_id}
        for version in (1, 2):
            response = self.client.get(f"/api/v{version}/snapshot", query_string=query)
            self.assert_recovery(response)
            self.assertEqual(set(response.json), {"success", "error"})
            self.assertFalse(response.json["success"])

    def stock(self):
        category, item, batch, outgoing = (str(uuid4()) for _ in range(4))
        incoming = "abcdef00-0000-4000-8000-000000000001"
        self.accepted(self.command("create_category", category, {"category_id": category, "name": "Review"}))
        self.accepted(self.command("create_item", item, {"item_id": item, "category_id": category,
                      "name": "Cups", "unit_of_measurement": "piece", "minimum_stock_level": 0}))
        receipt = self.command("record_stock_movement", incoming.upper(),
            {"movement_id": incoming, "item_id": item, "movement_type": "stock_in", "quantity_change": 20,
             "new_batches": [{"batch_id": batch, "received_quantity": 20}],
             "allocations": [{"allocation_id": str(uuid4()), "batch_id": batch, "quantity_change": 20}]})
        usage = self.command("record_stock_movement", outgoing,
            {"movement_id": outgoing, "item_id": item, "movement_type": "stock_out", "quantity_change": -5,
             "allocations": [{"allocation_id": str(uuid4()), "batch_id": batch, "quantity_change": -5}]}, EARLIER)
        return receipt, usage

    def test_v1_success_shapes_remain_the_published_frontend_profile(self):
        receipt, _ = self.stock()
        first = self.accepted(receipt)
        replay = self.accepted(receipt)
        self.assertEqual(set(first), {"operation_id", "outcome", "processed_at", "result"})
        self.assertEqual(replay, {**first, "outcome": "already_processed"})
        snap = self.snapshot(1, receipt["operation_id"])
        self.assertEqual(snap["schema_version"], 1)
        self.assertEqual(set(snap["sync"]), {"last_committed_operation_id", "last_committed_at"})
        self.assertNotIn("commit_seq", snap["stock_movements"][0])
        self.assertEqual(set(snap["receipt_checks"][0]), {"operation_id", "processed_at", "status"})

    def test_canonical_entity_association_and_v2_sequence_survive_restart(self):
        receipt, usage = self.stock()
        first = self.accepted(receipt)
        self.accepted(usage)
        with session_scope(self.app.extensions["session_factory"], write=False) as session:
            stored = session.get(ProcessedOperation, receipt["operation_id"])
            self.assertEqual(stored.entity_id, receipt["entity_id"].lower())
            self.assertNotEqual(stored.entity_id, stored.operation_id)
        reopened = create_app(self.config)
        self.addCleanup(reopened.extensions["engine"].dispose)
        self.client = reopened.test_client()
        retry = self.accepted({**receipt, "entity_id": receipt["entity_id"].lower()}, 2)
        self.assertEqual(retry["result"], first["result"])
        self.assertEqual(retry["outcome"], "already_processed")
        snap = self.snapshot(2, receipt["operation_id"].upper())
        self.assertEqual(snap["schema_version"], 2)
        self.assertEqual(snap["replay"], {"status": "authoritative", "order": "commit_seq",
                                         "installation_blocked": False})
        self.assertEqual([row["quantity_change"] for row in snap["stock_movements"]], [20, -5])
        self.assertEqual([row["commit_seq"] for row in snap["stock_movements"]], [3, 4])
        self.assertEqual(retry["commit_seq"], 3)
        self.assertEqual(snap["receipt_checks"][0]["commit_seq"], 3)
        self.assertEqual(snap["inventory_items"][0]["available_quantity"], 15)

    def test_impossible_verified_sequence_blocks_replay_without_losing_records(self):
        receipt, usage = self.stock()
        self.accepted(receipt)
        self.accepted(usage)
        with session_scope(self.app.extensions["session_factory"]) as session:
            first = session.get(ProcessedOperation, receipt["operation_id"])
            second = session.get(ProcessedOperation, usage["operation_id"])
            first.commit_seq = 99
            session.flush()
            second.commit_seq = 3
            session.flush()
            first.commit_seq = 4
            # Recompute row checksums so the shared chronological proof itself
            # must detect the impossible prefix.
            first.acceptance_digest = acceptance_digest(first)
            second.acceptance_digest = acceptance_digest(second)
        before = self.raw_rows()
        self.assert_snapshot_recovery(usage["operation_id"])
        self.assert_recovery(self.submit(usage, 2))
        self.assert_recovery(self.submit(receipt, 1))
        self.assertEqual(self.raw_rows(), before)

    def test_missing_or_inconsistent_receipt_never_verifies_a_movement(self):
        receipt, usage = self.stock()
        self.accepted(receipt)
        self.accepted(usage)
        with session_scope(self.app.extensions["session_factory"]) as session:
            session.delete(session.get(ProcessedOperation, receipt["operation_id"]))
            remaining = session.get(ProcessedOperation, usage["operation_id"])
            contradictory = json.loads(remaining.processing_result)
            contradictory["quantity_change"] = -6
            remaining.processing_result = json.dumps(contradictory)
        self.assert_snapshot_recovery()
        retry = self.submit(usage, 2)
        self.assertEqual(retry.status_code, 409, retry.json)
        self.assertEqual(retry.json["error"]["code"], "RECOVERY_REQUIRED")

    def test_coordinated_stock_damage_cannot_change_an_exact_retry_result(self):
        receipt, usage = self.stock()
        self.accepted(receipt)
        accepted = self.accepted(usage)
        with session_scope(self.app.extensions["session_factory"]) as session:
            movement = session.get(Movement, usage["entity_id"])
            allocation = session.get(Allocation, usage["payload"]["allocations"][0]["allocation_id"])
            movement.quantity_change = allocation.quantity_change = -6
            saved = session.get(ProcessedOperation, usage["operation_id"])
            changed = {**accepted["result"], "quantity_change": -6}
            changed["allocations"][0]["quantity_change"] = -6
            saved.processing_result = json.dumps(changed)
        before = self.raw_rows()
        self.assert_snapshot_recovery(usage["operation_id"])
        for version in (1, 2):
            self.assert_recovery(self.submit(usage, version))
        self.assertEqual(self.raw_rows(), before)

    def test_ambiguous_live_stock_claim_blocks_acknowledgment_and_snapshot(self):
        receipt, _ = self.stock()
        self.accepted(receipt)
        with session_scope(self.app.extensions["session_factory"]) as session:
            saved = session.get(ProcessedOperation, receipt["operation_id"])
            session.add(ProcessedOperation(
                operation_id=str(uuid4()), operation_type=saved.operation_type, entity_id=saved.entity_id,
                request_fingerprint=saved.request_fingerprint, fingerprint_profile=saved.fingerprint_profile,
                processed_at=saved.processed_at, processing_result=saved.processing_result,
                commit_seq=4, migration_metadata="provisional"))
        self.assert_snapshot_recovery(receipt["operation_id"])
        retry = self.submit(receipt, 2)
        self.assertEqual(retry.status_code, 409, retry.json)
        self.assertEqual(retry.json["error"]["code"], "RECOVERY_REQUIRED")

    def test_gap_in_receipt_ledger_blocks_snapshot_replay(self):
        receipt, usage = self.stock()
        self.accepted(receipt)
        self.accepted(usage)
        with session_scope(self.app.extensions["session_factory"]) as session:
            session.delete(session.scalar(select(ProcessedOperation).where(ProcessedOperation.commit_seq == 1)))
        self.assert_snapshot_recovery()

    def test_corrupt_receipt_identity_blocks_snapshot_and_replay_before_reopening(self):
        receipt, _ = self.stock()
        self.accepted(receipt)
        with session_scope(self.app.extensions["session_factory"]) as session:
            stored = session.get(ProcessedOperation, receipt["operation_id"])
            stored.fingerprint_profile = "unsupported-profile"
        self.assert_snapshot_recovery(receipt["operation_id"])
        for version in (1, 2):
            retry = self.submit(receipt, version)
            self.assertEqual(retry.status_code, 409, retry.json)
            self.assertEqual(retry.json["error"]["code"], "RECOVERY_REQUIRED")

    def test_damaged_catalog_result_blocks_v2_authority_before_reopening(self):
        entity = str(uuid4())
        command = self.command("create_category", entity, {"category_id": entity, "name": "Review"})
        self.accepted(command)
        with session_scope(self.app.extensions["session_factory"]) as session:
            stored = session.get(ProcessedOperation, command["operation_id"])
            stored.processing_result = json.dumps({"category_id": entity})
        self.assert_snapshot_recovery(command["operation_id"])
        self.assert_recovery(self.submit(command))
        self.assert_recovery(self.submit(command, 2))

    def test_bad_operation_types_and_uuid_are_structured_validation_errors(self):
        entity = str(uuid4())
        valid = self.command("create_category", entity, {"category_id": entity, "name": "Test"})
        for changes in ({"operation_type": []}, {"operation_type": {}},
                        {"entity_id": entity + "\n"}, {"operation_id": valid["operation_id"] + "\n"},
                        {"payload": {"category_id": entity, "name": "\ud800"}}):
            with self.subTest(changes=repr(changes)):
                response = self.submit({**valid, **changes})
                self.assertEqual(response.status_code, 422, response.json)
                self.assertEqual(response.json["error"]["code"], "VALIDATION_ERROR")
        with session_scope(self.app.extensions["session_factory"], write=False) as session:
            self.assertIsNone(session.scalar(select(ProcessedOperation)))

    def test_malformed_pagination_and_nonfinite_json_fail_as_bad_requests(self):
        for value in ("²", "9" * 5000, "9007199254740992", "0"):
            with self.subTest(length=len(value), start=value[:5]):
                response = self.client.get("/api/v1/reports/stock-movements", query_string={"page": value})
                self.assertEqual(response.status_code, 400, response.json)
                self.assertEqual(response.json["error"]["code"], "INVALID_REQUEST")
        response = self.client.post("/api/v2/sync", data='{"local_sequence": NaN}',
                                    content_type="application/json", headers=self.headers)
        self.assertEqual(response.status_code, 400, response.json)
        self.assertEqual(response.json["error"]["message"], "JSON numbers must be finite.")

    def raw(self, sql, values=()):
        with closing(sqlite3.connect(self.path)) as conn, conn:
            return conn.execute(sql, values).fetchall()

    def raw_rows(self):
        return {table: self.raw(f"SELECT * FROM {table} ORDER BY 1") for table in (
            "categories", "inventory_items", "stock_batches", "stock_movements", "batch_allocations",
            "processed_operations", "receipt_ledger_head",
        )}

    def assert_recovery(self, response):
        self.assertEqual(response.status_code, 409, response.json)
        error = response.json["error"]
        self.assertEqual(error["code"], "RECOVERY_REQUIRED")
        self.assertEqual(error["details"], {})
        self.assertIn("reconciliation", error["message"])

    def assert_missing_tail(self, tail):
        accepted = self.accepted(tail, 2)
        position = accepted["commit_seq"]
        self.assertEqual(self.raw("SELECT committed_seq FROM receipt_ledger_head"), [(position,)])
        self.raw("DELETE FROM processed_operations WHERE operation_id=?", (tail["operation_id"],))
        before = self.raw_rows()
        reopened = create_app(self.config)
        self.addCleanup(reopened.extensions["engine"].dispose)
        self.client = reopened.test_client()
        self.assert_snapshot_recovery(tail["operation_id"])
        self.assert_recovery(self.submit(tail, 2))
        self.assert_recovery(self.submit(tail, 1))
        category = str(uuid4())
        self.assert_recovery(self.submit(self.command(
            "create_category", category, {"category_id": category, "name": "Unwritten"}), 2))
        self.assertEqual(self.raw_rows(), before)
        self.assertEqual(self.raw("SELECT committed_seq FROM receipt_ledger_head"), [(position,)])

    def test_missing_highest_catalog_receipt_cannot_reuse_position_after_restart(self):
        self.stock()
        category = self.snapshot()["categories"][0]["category_id"]
        self.assert_missing_tail(self.command("update_category", category, {"name": "New historical name"}))

    def test_missing_highest_movement_receipt_cannot_reuse_position_after_restart(self):
        receipt, _ = self.stock()
        self.assert_missing_tail(receipt)
        self.assertEqual(self.raw("SELECT quantity_change FROM stock_movements"), [(20,)])

    def test_missing_upgraded_head_is_not_rebuilt_from_raw_receipts(self):
        receipt, _ = self.stock()
        self.accepted(receipt, 2)
        self.raw("DELETE FROM receipt_ledger_head")
        before = self.raw_rows()
        reopened = create_app(self.config)
        self.addCleanup(reopened.extensions["engine"].dispose)
        self.client = reopened.test_client()
        self.assert_snapshot_recovery()
        self.assert_recovery(self.submit(receipt, 2))
        self.assertEqual(self.raw_rows(), before)

    def test_receipt_and_watermark_roll_back_after_flush_and_retry_across_restart(self):
        receipt, _ = self.stock()
        engine = self.app.extensions["engine"]
        before = self.raw_rows()
        self.assertEqual(before["receipt_ledger_head"], [(1, 2, None)])
        reached = []

        def fail_commit(conn):
            row = conn.exec_driver_sql("SELECT committed_seq FROM receipt_ledger_head").scalar_one()
            if row == 3:
                saved = conn.exec_driver_sql("SELECT acceptance_digest FROM processed_operations "
                                            "WHERE operation_id=?", (receipt["operation_id"],)).scalar_one()
                reached.append(saved)
                raise RuntimeError("verification fault after receipt and head flush")

        event.listen(engine, "commit", fail_commit)
        try:
            failed = self.submit(receipt, 2)
        finally:
            event.remove(engine, "commit", fail_commit)
        self.assertEqual(failed.status_code, 500, failed.json)
        self.assertEqual(failed.json["error"]["code"], "SERVER_ERROR")
        self.assertTrue(len(reached) == 1 and len(reached[0]) == 64)
        self.assertEqual(self.raw_rows(), before)
        accepted = self.accepted(receipt, 2)
        self.assertEqual(accepted["commit_seq"], 3)
        reopened = create_app(self.config)
        self.addCleanup(reopened.extensions["engine"].dispose)
        self.client = reopened.test_client()
        self.assertEqual(self.accepted(receipt, 2), {**accepted, "outcome": "already_processed"})
        self.assertEqual(self.snapshot()["sync"]["last_commit_seq"], 3)

    def test_duplicate_sequence_blocks_snapshot_and_intact_retry(self):
        receipt, usage = self.stock()
        self.accepted(receipt, 2)
        self.accepted(usage, 2)
        with session_scope(self.app.extensions["session_factory"]) as session:
            row = session.get(ProcessedOperation, usage["operation_id"])
            row.migration_metadata = "provisional"
            row.commit_seq = 3
            row.acceptance_digest = acceptance_digest(row)
        before = self.raw_rows()
        self.assert_snapshot_recovery(receipt["operation_id"])
        self.assert_recovery(self.submit(receipt, 2))
        self.assertEqual(self.raw_rows(), before)

    def test_unrecorded_catalog_change_cannot_pass_replay_gate(self):
        category = str(uuid4())
        original = self.command("create_category", category, {"category_id": category, "name": "Original"})
        self.accepted(original, 2)
        self.accepted(self.command("update_category", category, {"name": "Authorized change"}), 2)
        self.assertEqual(self.accepted(original, 2)["result"]["name"], "Original")
        self.assertFalse(self.snapshot()["replay"]["installation_blocked"])
        self.raw("UPDATE categories SET name='Outside the ledger', normalized_name='outside the ledger'")
        self.assert_snapshot_recovery()
        self.assert_recovery(self.submit(original, 2))

    def test_new_batch_metadata_is_bound_to_acceptance(self):
        receipt, _ = self.stock()
        self.accepted(receipt, 2)
        self.raw("UPDATE stock_batches SET purchase_cost=1")
        self.assert_snapshot_recovery()
        self.assert_recovery(self.submit(receipt, 2))

    def test_duplicate_allocation_ids_reject_before_writes_and_leave_watermark(self):
        receipt, _ = self.stock()
        receipt["entity_id"] = receipt["payload"]["movement_id"]
        payload = receipt["payload"]
        item_id = payload["item_id"]
        batch_ids = [str(uuid4()), str(uuid4())]
        allocation_ids = ["abcdef01-0000-4000-8000-000000000001", str(uuid4())]
        payload.update(quantity_change=2,
                       new_batches=[{"batch_id": bid, "received_quantity": 1} for bid in batch_ids],
                       allocations=[{"allocation_id": aid, "batch_id": bid, "quantity_change": 1}
                                    for aid, bid in zip(allocation_ids, batch_ids)])
        before = self.raw_rows()
        for duplicate in (allocation_ids[0], allocation_ids[0].upper()):
            with self.subTest(duplicate=duplicate):
                bad = deepcopy(receipt)
                bad["payload"]["allocations"][1]["allocation_id"] = duplicate
                rejected = self.submit(bad, 2)
                self.assertEqual(rejected.status_code, 409, rejected.json)
                self.assertEqual(rejected.json["error"]["code"], "RESOURCE_CONFLICT")
                self.assertEqual(self.raw_rows(), before)
        accepted = self.accepted(receipt, 2)
        self.assertEqual(accepted["commit_seq"], 3)
        self.assertEqual(accepted["result"]["item_id"], item_id)
        before = self.raw_rows()
        collision = deepcopy(receipt)
        collision["operation_id"] = str(uuid4())
        collision["entity_id"] = collision["payload"]["movement_id"] = str(uuid4())
        for batch, allocation in zip(collision["payload"]["new_batches"], collision["payload"]["allocations"]):
            batch["batch_id"] = allocation["batch_id"] = str(uuid4())
        rejected = self.submit(collision)
        self.assertEqual(rejected.status_code, 409, rejected.json)
        self.assertEqual(rejected.json["error"]["code"], "RESOURCE_CONFLICT")
        self.assertEqual(self.raw_rows(), before)

    def test_dashboard_limit_is_bounded_ascii_and_rejects_repeats(self):
        receipt, usage = self.stock()
        self.accepted(receipt)
        self.accepted(usage)
        path = "/api/v1/reports/dashboard"
        default = self.client.get(path)
        self.assertEqual(default.status_code, 200, default.json)
        self.assertEqual(len(default.json["data"]["recent_movements"]), 2)
        for limit, count in (("1", 1), ("25", 2)):
            response = self.client.get(path, query_string={"recent_limit": limit})
            self.assertEqual(response.status_code, 200, response.json)
            self.assertEqual(len(response.json["data"]["recent_movements"]), count)
        for limit in ("0", "26", "-1", "+1", "²", "１２", "", "9" * 5000, "0" * 100 + "1"):
            with self.subTest(length=len(limit), preview=limit[:10]):
                response = self.client.get(path, query_string={"recent_limit": limit})
                self.assertEqual(response.status_code, 400, response.json)
                self.assertEqual(response.json["error"]["code"], "INVALID_REQUEST")
        repeated = self.client.get(path, query_string=[("recent_limit", "1"), ("recent_limit", "2")])
        self.assertEqual(repeated.status_code, 400, repeated.json)
        self.assertEqual(repeated.json["error"]["code"], "INVALID_REQUEST")

    def test_missing_or_contradictory_stock_rows_return_recovery_in_both_versions(self):
        self.assertFalse(self.snapshot()["replay"]["installation_blocked"])
        receipt, _ = self.stock()
        result = self.accepted(receipt, 2)["result"]
        original_rows = self.raw_rows()
        self.assertFalse(self.snapshot()["replay"]["installation_blocked"])
        allocation_id = result["allocations"][0]["allocation_id"]
        batch_id = result["allocations"][0]["batch_id"]
        for damage, parameters, table in (
            ("DELETE FROM batch_allocations WHERE allocation_id=?", (allocation_id,), "batch_allocations"),
            ("DELETE FROM stock_batches WHERE batch_id=?", (batch_id,), "stock_batches"),
            ("UPDATE batch_allocations SET batch_id=? WHERE allocation_id=?",
             (str(uuid4()), allocation_id), "batch_allocations"),
            ("UPDATE batch_allocations SET quantity_change=19 WHERE allocation_id=?",
             (allocation_id,), "batch_allocations"),
        ):
            with self.subTest(damage=damage):
                self.raw(damage, parameters)
                for version in (1, 2):
                    self.assert_recovery(self.client.get(f"/api/v{version}/snapshot"))
                    self.assert_recovery(self.submit(receipt, version))
                # Restore only this disposable fixture between failure modes.
                self.raw(f"DELETE FROM {table}")
                for row in original_rows[table]:
                    placeholders = ", ".join("?" for _ in row)
                    self.raw(f"INSERT INTO {table} VALUES ({placeholders})", row)
                self.assertEqual(self.raw_rows(), original_rows)
        malformed = self.client.get("/api/v2/snapshot", query_string={"receipt_id": "not-a-uuid"})
        self.assertEqual(malformed.status_code, 400, malformed.json)
        self.assertEqual(malformed.json["error"]["code"], "INVALID_REQUEST")
        self.assertFalse(self.snapshot()["replay"]["installation_blocked"])

    def test_all_command_results_reject_missing_extra_typed_and_contradictory_fields(self):
        category, item, movement, batch = (str(uuid4()) for _ in range(4))
        catalog = [
            ("create_category", category, {"category_id": category, "name": "Cups"}),
            ("create_item", item, {"item_id": item, "category_id": category, "name": "Mugs",
                                  "unit_of_measurement": "piece", "minimum_stock_level": 1}),
            ("update_category", category, {"name": "Drinkware"}),
            ("update_item", item, {"minimum_stock_level": 3}),
            ("record_stock_movement", movement,
             {"movement_id": movement, "item_id": item, "movement_type": "stock_in",
              "quantity_change": 2, "new_batches": [{"batch_id": batch, "received_quantity": 2}],
              "allocations": [{"allocation_id": str(uuid4()), "batch_id": batch, "quantity_change": 2}]}),
            ("record_stock_movement", str(uuid4()), None),
            ("archive_item", item, {}),
            ("archive_category", category, {}),
        ]
        kind, usage, _ = catalog[5]
        catalog[5] = (kind, usage, {"movement_id": usage, "item_id": item, "movement_type": "stock_out",
                                  "quantity_change": -2,
                                  "allocations": [{"allocation_id": str(uuid4()),
                                                   "batch_id": batch, "quantity_change": -2}]})
        commands = [self.command(kind, entity, payload) for kind, entity, payload in catalog]
        accepted = [self.accepted(command, 2) for command in commands]
        self.assertFalse(self.snapshot()["replay"]["installation_blocked"])
        for command, acknowledgment in zip(commands, accepted):
            op_id = command["operation_id"]
            result = acknowledgment["result"]
            self.assertEqual(self.accepted(command, 2), {**acknowledgment, "outcome": "already_processed"})
            id_key = {"item": "item_id", "category": "category_id", "movement": "movement_id"}[
                command["operation_type"].rsplit("_", 1)[1]]
            broken = (
                {id_key: result[id_key]},
                {**result, "unexpected_field": 1},
                {**result, "created_at": False},
                {**result, id_key: str(uuid4())},
            )
            for index, changed in enumerate(broken):
                with self.subTest(kind=command["operation_type"], variant=index):
                    with session_scope(self.app.extensions["session_factory"]) as session:
                        saved = session.get(ProcessedOperation, op_id)
                        original = (saved.processing_result, saved.acceptance_digest)
                        self.assertIsNotNone(read_receipt(saved))
                        saved.processing_result = json.dumps(changed)
                        # Exercise shape and command checks even when the row
                        # checksum is internally consistent.
                        saved.acceptance_digest = acceptance_digest(saved)
                        self.assertIsNone(read_receipt(saved))
                    self.assert_recovery(self.submit(command, 1))
                    self.assert_recovery(self.submit(command, 2))
                    self.assert_snapshot_recovery(op_id)
                    with session_scope(self.app.extensions["session_factory"]) as session:
                        saved = session.get(ProcessedOperation, op_id)
                        saved.processing_result, saved.acceptance_digest = original
        self.assertFalse(self.snapshot()["replay"]["installation_blocked"])
