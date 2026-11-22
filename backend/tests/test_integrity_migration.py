"""Populated legacy schemas, migration restart, and SQLite rollback."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone

from sqlalchemy import event
from sqlalchemy.engine import URL

from app import create_app
from app.core.quantities import MAX_SAFE
from app.db import init_db, make_engine


def uid(number):
    return f"abcdefab-0000-4000-8000-{number:012d}"


CATEGORY, ITEM, BATCH = map(uid, (1, 2, 3))
RECEIPT_MOVEMENT, USAGE_MOVEMENT = map(uid, (4, 5))
RECEIPT, USAGE = map(uid, (19, 16))
LEGACY_FIELDS = (
    "operation_id", "operation_type", "request_fingerprint", "fingerprint_profile",
    "processed_at", "processing_result",
)
LEGACY_SCHEMA = """
    operation_id VARCHAR(36) PRIMARY KEY NOT NULL,
    operation_type VARCHAR(32) NOT NULL,
    request_fingerprint VARCHAR(64) NOT NULL,
    fingerprint_profile VARCHAR(32) NOT NULL,
    processed_at VARCHAR(24) NOT NULL,
    processing_result TEXT NOT NULL
"""


class IntegrityMigrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "ledger.sqlite"
        self.url = URL.create("sqlite", database=str(self.path))
        self.commands = [
            (uid(20), "create_category", CATEGORY,
             {"category_id": CATEGORY, "name": "Migration fixtures"}),
            (uid(18), "create_item", ITEM,
             {"item_id": ITEM, "category_id": CATEGORY, "name": "Migration cups",
              "unit_of_measurement": "piece", "minimum_stock_level": 0}),
            (RECEIPT, "record_stock_movement", RECEIPT_MOVEMENT,
             {"movement_id": RECEIPT_MOVEMENT, "item_id": ITEM, "movement_type": "stock_in",
              "quantity_change": 20,
              "allocations": [{"allocation_id": uid(6), "batch_id": BATCH, "quantity_change": 20}],
              "new_batches": [{"batch_id": BATCH, "received_quantity": 20}]}),
            (USAGE, "record_stock_movement", USAGE_MOVEMENT,
             {"movement_id": USAGE_MOVEMENT, "item_id": ITEM, "movement_type": "stock_out",
              "quantity_change": -5,
              "allocations": [{"allocation_id": uid(7), "batch_id": BATCH, "quantity_change": -5}]}),
        ]

    @contextmanager
    def application(self):
        app = create_app({
            "DATABASE_URL": self.url, "TESTING": True,
            "NOW": lambda: datetime(2026, 11, 19, 3, tzinfo=timezone.utc),
        })
        try:
            yield app.test_client()
        finally:
            app.extensions["engine"].dispose()

    @contextmanager
    def database(self):
        connection = sqlite3.connect(self.path)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def post(self, client, command_index):
        op_id, operation_type, entity_id, payload = self.commands[command_index]
        generation = client.get("/api/v1/health").headers["X-Inventory-Generation"]
        # A backward event clock exercises the distinction from commit order.
        created_at = "2026-11-18T01:00:00Z" if command_index == 3 else "2026-11-18T02:00:00Z"
        response = client.post("/api/v1/sync", headers={"X-Inventory-Generation": generation}, json={
            "operation_id": op_id, "operation_type": operation_type, "entity_id": entity_id,
            "payload": payload, "created_at": created_at, "local_sequence": command_index + 1,
        })
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()["data"]

    def seed(self):
        with self.application() as client:
            for index in range(4):
                self.assertEqual(self.post(client, index)["outcome"], "accepted")

    def recreate_receipts(self, extra_schema=(), extra_fields=()):
        """Project real fixture receipts into the exact legacy column layouts."""
        schema = ", ".join((LEGACY_SCHEMA, *extra_schema))
        names = ", ".join((*LEGACY_FIELDS, *extra_fields))
        with self.database() as conn:
            conn.execute(f"CREATE TABLE legacy_receipts ({schema})")
            conn.execute(
                f"INSERT INTO legacy_receipts ({names}) SELECT {names} FROM processed_operations"
            )
            conn.execute("DROP TABLE processed_operations")
            conn.execute("ALTER TABLE legacy_receipts RENAME TO processed_operations")
            # Historical installations had no C3 ledger-head table.
            conn.execute("DROP TABLE receipt_ledger_head")

    def cols(self):
        with self.database() as conn:
            return [row[1] for row in conn.execute("PRAGMA table_info(processed_operations)")]

    def receipt_rows(self):
        with self.database() as conn:
            return {op: (entity, seq, status) for op, entity, seq, status in conn.execute(
                "SELECT operation_id, entity_id, commit_seq, migration_metadata FROM processed_operations"
            )}

    def inventory_rows(self):
        """Include all business fields and original receipt bytes in the comparison."""
        tables = {
            "categories": "*", "inventory_items": "*", "stock_batches": "*",
            "stock_movements": "*", "batch_allocations": "*",
            "processed_operations": ", ".join(LEGACY_FIELDS), "application_settings": "*",
        }
        with self.database() as conn:
            return {table: conn.execute(f"SELECT {fields} FROM {table} ORDER BY 1").fetchall()
                    for table, fields in tables.items()}

    def assert_history_preserved(self, expected, *, retry_allowed=True):
        self.assertEqual(self.inventory_rows(), expected)
        self.assertEqual([len(expected[name]) for name in (
            "categories", "inventory_items", "stock_batches", "stock_movements",
            "batch_allocations", "processed_operations",
        )], [1, 1, 1, 2, 2, 4])
        with self.application() as client:
            item = client.get(f"/api/v1/inventory/{ITEM}")
            batch = client.get(f"/api/v1/batches/{BATCH}")
            if retry_allowed:
                self.assertEqual(item.status_code, 200)
                self.assertEqual(batch.status_code, 200)
                self.assertEqual(item.get_json()["data"]["available_quantity"], 15)
                self.assertEqual(batch.get_json()["data"]["remaining_quantity"], 15)
                self.assertEqual(self.post(client, 2)["outcome"], "already_processed")
            else:
                for read in (item, batch):
                    self.assertEqual(read.status_code, 409, read.get_json())
                    self.assertEqual(read.get_json()["error"]["code"], "RECOVERY_REQUIRED")
                op, kind, entity, payload = self.commands[2]
                generation = client.get("/api/v1/health").headers["X-Inventory-Generation"]
                retry = client.post("/api/v1/sync", headers={"X-Inventory-Generation": generation}, json={
                    "operation_id": op, "operation_type": kind, "entity_id": entity, "payload": payload,
                    "created_at": "2026-11-18T02:00:00Z", "local_sequence": 3,
                })
                self.assertEqual(retry.status_code, 409, retry.get_json())
                self.assertEqual(retry.get_json()["error"]["code"], "RECOVERY_REQUIRED")
        self.assertEqual(self.inventory_rows(), expected)

    def test_fresh_receipts_are_authoritative_and_persist(self):
        self.seed()
        self.assertEqual(self.receipt_rows()[RECEIPT], (RECEIPT_MOVEMENT, 3, "verified"))
        self.assertEqual(self.receipt_rows()[USAGE], (USAGE_MOVEMENT, 4, "verified"))
        self.assert_history_preserved(self.inventory_rows())

    def test_pr18_populated_native_sequence_survives_independent_column_additions(self):
        self.seed()
        self.recreate_receipts(("commit_seq BIGINT NOT NULL",), ("commit_seq",))
        original_rows = self.inventory_rows()
        with self.application() as client:
            self.assertEqual(client.get("/api/v1/health").status_code, 200)
        self.assertIn("entity_id", self.cols())
        self.assertIn("migration_metadata", self.cols())
        upgraded = self.receipt_rows()
        self.assertEqual(upgraded[RECEIPT], (RECEIPT_MOVEMENT, 3, "verified_legacy"))
        self.assertEqual(upgraded[USAGE], (USAGE_MOVEMENT, 4, "verified_legacy"))
        with self.application() as client:
            response = client.get("/api/v2/snapshot")
            self.assertEqual(response.status_code, 200, response.get_json())
            snapshot = response.get_json()["data"]
            self.assertTrue(snapshot["replay"]["installation_blocked"])
            self.assertEqual(snapshot["migration"]["status"], "provisional")
            self.assertIsNone(snapshot["sync"]["last_commit_seq"])
        with self.database() as conn:
            self.assertEqual(conn.execute(
                "SELECT committed_seq, legacy_through FROM receipt_ledger_head").fetchone(), (4, 4))
        self.assert_history_preserved(original_rows)
        self.assertEqual(self.receipt_rows(), upgraded)

    def test_original_populated_schema_recovers_links_but_never_promotes_reconstructed_order(self):
        self.seed()
        self.recreate_receipts()
        original_rows = self.inventory_rows()
        with self.application():
            upgraded = self.receipt_rows()
        self.assertEqual(upgraded[RECEIPT][0], RECEIPT_MOVEMENT)
        self.assertEqual(upgraded[USAGE][0], USAGE_MOVEMENT)
        self.assertTrue(all(seq > 0 and status == "provisional" for _, seq, status in upgraded.values()))
        self.assert_history_preserved(original_rows)
        self.assertEqual(self.receipt_rows(), upgraded)

    def test_partial_migration_preserves_existing_positions_and_adds_missing_metadata(self):
        self.seed()
        self.recreate_receipts(("entity_id TEXT", "commit_seq INTEGER DEFAULT 0"),
                               ("entity_id", "commit_seq"))
        with self.database() as conn:
            conn.execute("UPDATE processed_operations SET commit_seq = 0")
            conn.execute("UPDATE processed_operations SET commit_seq = 12 WHERE operation_id = ?", (USAGE,))
        original_rows = self.inventory_rows()
        with self.application():
            self.assertIn("migration_metadata", self.cols())
            upgraded = self.receipt_rows()
        self.assertEqual(upgraded[USAGE], (USAGE_MOVEMENT, 12, "provisional"))
        self.assertGreater(upgraded[RECEIPT][1], 12)
        self.assertTrue(all(status == "provisional" for _, _, status in upgraded.values()))
        self.assert_history_preserved(original_rows, retry_allowed=False)
        self.assertEqual(self.receipt_rows(), upgraded)

    def test_durable_result_damage_prevents_reconstruction(self):
        self.seed()
        self.recreate_receipts()
        with self.database() as conn:
            result, = conn.execute(
                "SELECT processing_result FROM processed_operations WHERE operation_id = ?", (RECEIPT,)
            ).fetchone()
            receipt = json.loads(result)
            receipt["allocations"][0]["quantity_change"] = 19
            conn.execute("UPDATE processed_operations SET processing_result = ? WHERE operation_id = ?",
                         (json.dumps(receipt), RECEIPT))
        original_rows = self.inventory_rows()
        with self.application():
            upgraded = self.receipt_rows()
        self.assertIsNone(upgraded[RECEIPT][0])
        self.assertEqual(upgraded[USAGE][0], USAGE_MOVEMENT)
        self.assertEqual(self.inventory_rows(), original_rows)
        with self.application():
            self.assertEqual(self.receipt_rows(), upgraded)

    def test_duplicate_claims_are_preserved_but_unverified(self):
        self.seed()
        with self.database() as conn:
            result, = conn.execute(
                "SELECT processing_result FROM processed_operations WHERE operation_id = ?", (RECEIPT,)
            ).fetchone()
        self.recreate_receipts(("entity_id TEXT", "commit_seq BIGINT", "migration_metadata TEXT"),
                               ("entity_id", "commit_seq", "migration_metadata"))
        with self.database() as conn:
            conn.execute(
                "UPDATE processed_operations SET entity_id = ?, processing_result = ? WHERE operation_id = ?",
                (RECEIPT_MOVEMENT, result, USAGE),
            )
        original_rows = self.inventory_rows()
        with self.application():
            upgraded = self.receipt_rows()
        self.assertEqual(upgraded[RECEIPT], (RECEIPT_MOVEMENT, 3, "unverified"))
        self.assertEqual(upgraded[USAGE], (RECEIPT_MOVEMENT, 4, "unverified"))
        self.assertEqual(self.inventory_rows(), original_rows)

    def test_duplicate_and_out_of_range_positions_are_preserved_without_authority(self):
        self.seed()
        self.recreate_receipts(("entity_id TEXT", "commit_seq BIGINT", "migration_metadata TEXT"),
                               ("entity_id", "commit_seq", "migration_metadata"))
        with self.database() as conn:
            conn.execute("UPDATE processed_operations SET commit_seq = 3 WHERE operation_id = ?", (USAGE,))
            conn.execute("UPDATE processed_operations SET commit_seq = ? WHERE operation_id = ?", (MAX_SAFE + 1, uid(20)))
        with self.application():
            upgraded = self.receipt_rows()
        for operation, position in ((RECEIPT, 3), (USAGE, 3), (uid(20), MAX_SAFE + 1)):
            self.assertEqual(upgraded[operation][1:], (position, "unverified"))

    def test_interrupted_migration_rolls_back_earlier_ddl_and_can_retry(self):
        self.seed()
        self.recreate_receipts()
        original_rows = self.inventory_rows()
        original_columns = self.cols()
        engine = make_engine(self.url)
        try:
            def abort_midway(conn, cursor, statement, parameters, context, executemany):
                if "ADD COLUMN commit_seq" in statement:
                    raise RuntimeError("Injected migration interruption")

            event.listen(engine, "before_cursor_execute", abort_midway)
            with self.assertRaisesRegex(RuntimeError, "Injected migration interruption"):
                init_db(engine)
        finally:
            engine.dispose()
        self.assertEqual(self.cols(), original_columns)
        self.assertEqual(self.inventory_rows(), original_rows)
        with self.application():
            self.assertEqual(self.receipt_rows()[RECEIPT][2], "provisional")
        self.assert_history_preserved(original_rows)

    def test_missing_entity_column_recovers_links_without_changing_verified_positions(self):
        self.seed()
        self.recreate_receipts(("commit_seq BIGINT NOT NULL", "migration_metadata TEXT NOT NULL"),
                               ("commit_seq", "migration_metadata"))
        original_rows = self.inventory_rows()
        with self.application():
            upgraded = self.receipt_rows()
        self.assertEqual(upgraded[RECEIPT], (RECEIPT_MOVEMENT, 3, "verified"))
        self.assertEqual(upgraded[USAGE], (USAGE_MOVEMENT, 4, "verified"))
        self.assert_history_preserved(original_rows)

    def test_missing_sequence_column_cannot_inherit_a_verified_marker(self):
        self.seed()
        self.recreate_receipts(("entity_id TEXT", "migration_metadata TEXT"),
                               ("entity_id", "migration_metadata"))
        original_rows = self.inventory_rows()
        with self.application():
            self.assertIn("commit_seq", self.cols())
            upgraded = self.receipt_rows()
        self.assertEqual(upgraded[RECEIPT], (RECEIPT_MOVEMENT, None, "unverified"))
        self.assert_history_preserved(original_rows, retry_allowed=False)
        self.assertEqual(self.receipt_rows(), upgraded)

    def test_prior_uppercase_entity_is_canonicalized_from_the_original_result(self):
        self.seed()
        self.recreate_receipts(("entity_id TEXT", "commit_seq BIGINT", "migration_metadata TEXT"),
                               ("entity_id", "commit_seq", "migration_metadata"))
        with self.database() as conn:
            conn.execute("UPDATE processed_operations SET entity_id = ? WHERE operation_id = ?",
                         (RECEIPT_MOVEMENT.upper(), RECEIPT))
        original_rows = self.inventory_rows()
        with self.application():
            self.assertEqual(self.receipt_rows()[RECEIPT], (RECEIPT_MOVEMENT, 3, "verified"))
        self.assert_history_preserved(original_rows)

    def test_authoritative_indexes_reject_duplicate_positions_and_movement_links(self):
        self.seed()
        self.recreate_receipts(("commit_seq BIGINT NOT NULL",), ("commit_seq",))
        with self.application():
            original_rows = self.inventory_rows()
        bad_receipts = ((uid(30), RECEIPT_MOVEMENT, 20, "entity_id"), (uid(31), uid(33), 3, "commit_seq"))
        for operation_id, entity_id, position, duplicate_field in bad_receipts:
            with self.subTest(operation_id=operation_id), self.database() as conn:
                with self.assertRaisesRegex(sqlite3.IntegrityError, f"UNIQUE.*processed_operations.{duplicate_field}"):
                    conn.execute("""
                        INSERT INTO processed_operations
                        (operation_id, operation_type, entity_id, request_fingerprint, fingerprint_profile,
                         processed_at, processing_result, commit_seq, migration_metadata)
                        VALUES (?, 'record_stock_movement', ?, 'fixture', '1:/api/v1',
                                '2026-11-18T02:00:00.000Z', '{}', ?, 'verified')
                    """, (operation_id, entity_id, position))
        self.assertEqual(self.inventory_rows(), original_rows)

    def test_invalid_fingerprint_evidence_cannot_keep_verified_positions(self):
        self.seed()
        self.recreate_receipts(("entity_id TEXT", "commit_seq BIGINT", "migration_metadata TEXT"),
                               ("entity_id", "commit_seq", "migration_metadata"))
        with self.database() as conn:
            conn.execute("UPDATE processed_operations SET fingerprint_profile = ? WHERE operation_id = ?",
                         ("unknown-profile", RECEIPT))
            conn.execute("UPDATE processed_operations SET request_fingerprint = ? WHERE operation_id = ?",
                         ("g" * 64, USAGE))
        original_rows = self.inventory_rows()
        with self.application() as client:
            upgraded = self.receipt_rows()
            self.assertEqual(upgraded[RECEIPT], (RECEIPT_MOVEMENT, 3, "unverified"))
            self.assertEqual(upgraded[USAGE], (USAGE_MOVEMENT, 4, "unverified"))
            response = client.get("/api/v2/snapshot", query_string=[
                ("receipt_id", RECEIPT), ("receipt_id", USAGE),
            ])
            self.assertEqual(response.status_code, 409, response.get_json())
            self.assertEqual(response.get_json()["error"]["code"], "RECOVERY_REQUIRED")
            self.assertNotIn("data", response.get_json())
        self.assertEqual(self.inventory_rows(), original_rows)
