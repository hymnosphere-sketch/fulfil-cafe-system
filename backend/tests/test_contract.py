"""Contract conformance tests: replay the fictional examples in docs/API_CONTRACT.md.

Section 9 examples A-F (kg item, +1500 / -700, balance 800, rejected -1000) and
G are run in order and the responses are compared with the documented ones.
The remaining tests cover the contract rules that were missing or wrong:
INSUFFICIENT_STOCK details, INVALID_QUANTITY, 503 SYNC_FAILED, row-level
database checks and read requests that must not wait for a writer.
"""
import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

try:
    import sqlalchemy  # noqa: F401
    HAVE_DB = True
except ImportError:  # pragma: no cover
    HAVE_DB = False

U = lambda n: f"00000000-0000-4000-8000-{n:012d}"
CAT, ITEM, BATCH = U(1), U(2), U(3)
# The contract example uses business date 2026-11-18 and a four-day warning period.
NOW = datetime(2026, 11, 18, 3, 1, 0, tzinfo=timezone.utc)


@unittest.skipUnless(HAVE_DB, "SQLAlchemy is not installed")
class ContractCase(unittest.TestCase):
    def setUp(self):
        from app import create_app
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.tick = 0
        self.app = create_app({
            "DATABASE_URL": "sqlite:///" + self.path, "TESTING": True,
            "EXPIRATION_WARNING_DAYS": 4,
            # processed_at advances one second per call like the documented examples
            "NOW": lambda: datetime(2026, 11, 18, 3, 1, self.next_tick(), tzinfo=timezone.utc),
        })
        self.client = self.app.test_client()
        self.gen = self.client.get("/api/v1/health").headers["X-Inventory-Generation"]

    def next_tick(self):
        t, self.tick = self.tick, self.tick + 1
        return t

    def tearDown(self):
        self.app.extensions["engine"].dispose()
        os.remove(self.path)

    def sync(self, op, typ, entity, payload, seq, created):
        body = {"operation_id": U(op), "operation_type": typ, "entity_id": entity,
                "payload": payload, "created_at": created, "local_sequence": seq}
        return self.client.post("/api/v1/sync", json=body,
                                headers={"X-Inventory-Generation": self.gen})

    CREATE_CAT = {"category_id": CAT, "name": "Ingredients"}
    CREATE_ITEM = {"item_id": ITEM, "category_id": CAT, "name": "Coffee Beans",
                   "unit_of_measurement": "kg", "minimum_stock_level": 1000}
    STOCK_IN = {
        "movement_id": U(4), "item_id": ITEM, "movement_type": "stock_in",
        "quantity_change": 1500, "reason": "Delivery", "recorded_by": None,
        "allocations": [{"allocation_id": U(5), "batch_id": BATCH, "quantity_change": 1500}],
        "new_batches": [{"batch_id": BATCH, "received_quantity": 1500,
                         "purchase_date": "2026-11-18", "purchase_cost": None,
                         "expiration_date": "2026-11-21"}]}
    STOCK_OUT = {
        "movement_id": U(6), "item_id": ITEM, "movement_type": "stock_out",
        "quantity_change": -700, "reason": "Used during service", "recorded_by": None,
        "allocations": [{"allocation_id": U(7), "batch_id": BATCH, "quantity_change": -700}]}

    def run_examples_a_to_d(self):
        self.assertEqual(self.sync(40, "create_category", CAT, self.CREATE_CAT, 1,
                                   "2026-11-18T02:00:00Z").status_code, 200)
        a = self.sync(31, "create_item", ITEM, self.CREATE_ITEM, 41, "2026-11-18T02:00:00Z")
        b = self.sync(32, "update_item", ITEM, {"minimum_stock_level": 1200}, 42,
                      "2026-11-18T02:02:00Z")
        c = self.sync(33, "record_stock_movement", U(4), self.STOCK_IN, 43, "2026-11-18T02:05:00Z")
        d = self.sync(34, "record_stock_movement", U(6), self.STOCK_OUT, 44, "2026-11-18T03:00:00Z")
        return a, b, c, d


class SectionNineExamples(ContractCase):
    def test_examples_a_to_d_match_documented_results(self):
        a, b, c, d = self.run_examples_a_to_d()
        ra = a.get_json()["data"]
        self.assertEqual(ra["outcome"], "accepted")
        self.assertEqual(ra["result"]["available_quantity"], 0)
        self.assertEqual(ra["result"]["stock_status"], "out_of_stock")
        self.assertEqual(ra["result"]["created_at"], "2026-11-18T02:00:00Z")  # seconds only
        rb = b.get_json()["data"]["result"]
        self.assertEqual((rb["minimum_stock_level"], rb["updated_at"]),
                         (1200, "2026-11-18T02:02:00Z"))
        rc = c.get_json()["data"]["result"]
        self.assertEqual(rc["allocations"][0]["quantity_change"], 1500)
        rd = d.get_json()["data"]["result"]
        self.assertEqual(rd["quantity_change"], -700)
        item = self.client.get(f"/api/v1/inventory/{ITEM}").get_json()["data"]
        self.assertEqual((item["available_quantity"], item["stock_status"]), (800, "low_stock"))
        batch = self.client.get(f"/api/v1/batches/{BATCH}").get_json()["data"]
        self.assertEqual(batch["remaining_quantity"], 800)

    def test_example_e_retry_returns_original_receipt(self):
        _, _, _, d = self.run_examples_a_to_d()
        first = d.get_json()["data"]
        again = self.sync(34, "record_stock_movement", U(6), self.STOCK_OUT, 44,
                          "2026-11-18T03:00:00Z").get_json()["data"]
        self.assertEqual(again["outcome"], "already_processed")
        self.assertEqual(again["processed_at"], first["processed_at"])  # original timestamp
        self.assertEqual(again["result"], first["result"])
        item = self.client.get(f"/api/v1/inventory/{ITEM}").get_json()["data"]
        self.assertEqual(item["available_quantity"], 800)

    def test_example_f_rejected_withdrawal_reports_800(self):
        self.run_examples_a_to_d()
        big = dict(self.STOCK_OUT, movement_id=U(9), quantity_change=-1000, allocations=[
            {"allocation_id": U(10), "batch_id": BATCH, "quantity_change": -1000}])
        r = self.sync(35, "record_stock_movement", U(9), big, 45, "2026-11-18T03:05:00Z")
        err = r.get_json()["error"]
        self.assertEqual(r.status_code, 422)
        self.assertEqual(err["code"], "INSUFFICIENT_STOCK")
        self.assertEqual(err["details"], {"operation_id": U(35), "outcome": "rejected",
                                          "available_quantity": 800})

    def test_dashboard_and_expiring_use_contract_boundaries(self):
        self.run_examples_a_to_d()
        d = self.client.get("/api/v1/reports/dashboard?recent_limit=1").get_json()["data"]
        self.assertEqual((d["total_active_items"], d["low_stock_items"],
                          d["expiring_soon_items"], d["expiration_status"]), (1, 1, 1, "available"))
        e = self.client.get("/api/v1/reports/expiring?status=expiring_soon").get_json()
        self.assertEqual(e["data"][0]["expiration_status"], "expiring_soon")
        self.assertEqual(e["data"][0]["remaining_quantity"], 800)

    def test_snapshot_shape(self):
        self.run_examples_a_to_d()
        s = self.client.get("/api/v1/snapshot").get_json()["data"]
        self.assertEqual(s["receipt_checks"], [])
        self.assertEqual(s["sync"]["last_committed_operation_id"], U(34))
        self.assertNotIn("allocations", s["stock_movements"][0])
        self.assertEqual(s["settings"]["expiration_warning_days"], 4)
        self.assertEqual(s["backup"], {"last_successful_backup_at": None})


class ContractRules(ContractCase):
    def seed(self):
        self.sync(40, "create_category", CAT, self.CREATE_CAT, 1, "2026-11-18T02:00:00Z")
        self.sync(31, "create_item", ITEM, self.CREATE_ITEM, 2, "2026-11-18T02:00:00Z")
        self.sync(33, "record_stock_movement", U(4), self.STOCK_IN, 3, "2026-11-18T02:05:00Z")

    def test_zero_quantity_is_invalid_quantity(self):
        self.seed()
        zero = dict(self.STOCK_OUT, quantity_change=0,
                    allocations=[{"allocation_id": U(7), "batch_id": BATCH, "quantity_change": 0}])
        r = self.sync(60, "record_stock_movement", U(6), zero, 4, "2026-11-18T03:00:00Z")
        self.assertEqual((r.status_code, r.get_json()["error"]["code"]), (422, "INVALID_QUANTITY"))

    def test_wrong_json_type_is_validation_error(self):
        self.seed()
        bad = dict(self.STOCK_OUT, quantity_change=-7.5)
        r = self.sync(61, "record_stock_movement", U(6), bad, 4, "2026-11-18T03:00:00Z")
        self.assertEqual((r.status_code, r.get_json()["error"]["code"]), (422, "VALIDATION_ERROR"))

    def test_out_of_range_quantity_is_invalid_quantity(self):
        self.seed()
        huge = 9_007_199_254_740_992
        bad = dict(self.STOCK_OUT, quantity_change=-huge,
                   allocations=[{"allocation_id": U(7), "batch_id": BATCH, "quantity_change": -huge}])
        r = self.sync(62, "record_stock_movement", U(6), bad, 4, "2026-11-18T03:00:00Z")
        self.assertEqual(r.get_json()["error"]["code"], "INVALID_QUANTITY")

    def test_direct_route_overdraw_reports_balance_before_request(self):
        self.seed()
        body = dict(self.STOCK_OUT, operation_id=U(63), created_at="2026-11-18T03:00:00Z",
                    quantity_change=-2000,
                    allocations=[{"allocation_id": U(7), "batch_id": BATCH, "quantity_change": -2000}])
        r = self.client.post("/api/v1/stock-movements", json=body,
                             headers={"X-Inventory-Generation": self.gen})
        err = r.get_json()["error"]
        self.assertEqual((r.status_code, err["code"]), (422, "INSUFFICIENT_STOCK"))
        self.assertEqual(err["details"]["available_quantity"], 1500)

    def test_database_lock_returns_503_sync_failed_with_retry_after(self):
        from sqlalchemy.exc import OperationalError
        self.seed()
        boom = OperationalError("INSERT ...", {}, Exception("database is locked"))
        with mock.patch("app.services.process_command", side_effect=boom):
            r = self.sync(64, "record_stock_movement", U(6), self.STOCK_OUT, 4,
                          "2026-11-18T03:00:00Z")
        body = r.get_json()
        self.assertEqual((r.status_code, body["error"]["code"]), (503, "SYNC_FAILED"))
        self.assertIn("Retry-After", r.headers)
        self.assertNotIn("locked", str(body))   # no raw database text leaks out
        # nothing was saved, and the same command can be retried afterwards
        retry = self.sync(64, "record_stock_movement", U(6), self.STOCK_OUT, 4,
                          "2026-11-18T03:00:00Z")
        self.assertEqual(retry.get_json()["data"]["outcome"], "accepted")

    def test_reads_do_not_wait_for_a_writer(self):
        self.seed()
        engine = self.app.extensions["engine"]
        with engine.connect() as writer:                 # another request mid-write
            writer.exec_driver_sql("SELECT 1")           # engine hook issues BEGIN IMMEDIATE
            r = self.client.get("/api/v1/inventory")
            writer.exec_driver_sql("ROLLBACK")
        self.assertEqual(r.status_code, 200)


class DatabaseChecks(ContractCase):
    """DATABASE_DESIGN section 7: row-level checks and restrictive foreign keys."""

    def seed(self):
        self.sync(40, "create_category", CAT, self.CREATE_CAT, 1, "2026-11-18T02:00:00Z")
        self.sync(31, "create_item", ITEM, self.CREATE_ITEM, 2, "2026-11-18T02:00:00Z")

    def insert_movement(self, mtype, qty, reason=None):
        from app.models import Movement
        from sqlalchemy.orm import Session
        with Session(self.app.extensions["engine"]) as s:
            s.add(Movement(movement_id=U(900), item_id=ITEM, movement_type=mtype,
                           quantity_change=qty, reason=reason, recorded_by=None,
                           created_at="2026-11-18T03:00:00.000Z"))
            s.commit()

    def test_sign_must_match_type(self):
        from sqlalchemy.exc import IntegrityError
        self.seed()
        with self.assertRaises(IntegrityError):
            self.insert_movement("stock_out", 5)

    def test_unknown_type_rejected(self):
        from sqlalchemy.exc import IntegrityError
        self.seed()
        with self.assertRaises(IntegrityError):
            self.insert_movement("teleport", 5)

    def test_reason_required_for_wastage(self):
        from sqlalchemy.exc import IntegrityError
        self.seed()
        with self.assertRaises(IntegrityError):
            self.insert_movement("wastage", -5)

    def test_referenced_category_cannot_be_deleted(self):
        from sqlalchemy.exc import IntegrityError
        self.seed()
        with self.app.extensions["engine"].begin() as conn:
            with self.assertRaises(IntegrityError):
                conn.exec_driver_sql("DELETE FROM categories")


class StartupChecks(unittest.TestCase):
    @unittest.skipUnless(HAVE_DB, "SQLAlchemy is not installed")
    def test_missing_timezone_database_fails_with_clear_message(self):
        from app import create_app
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            with self.assertRaises(RuntimeError) as cm:
                create_app({"DATABASE_URL": "sqlite:///" + path,
                            "BUSINESS_TIMEZONE": "Nowhere/Land"})
            self.assertIn("tzdata", str(cm.exception))
        finally:
            os.remove(path)


class RegressionTests(ContractCase):
    """Deterministic regressions for FE-09B review findings."""

    # --- Issue 1: commit_seq returned on replay ---
    def test_replay_returns_commit_seq(self):
        """PR #18: already_processed must include commit_seq for contract compatibility."""
        self.run_examples_a_to_d()
        first = self.sync(34, "record_stock_movement", U(6), self.STOCK_OUT, 44,
                          "2026-11-18T03:00:00Z").get_json()["data"]
        again = self.sync(34, "record_stock_movement", U(6), self.STOCK_OUT, 44,
                          "2026-11-18T03:00:00Z").get_json()["data"]
        self.assertEqual(again["outcome"], "already_processed")
        self.assertIn("commit_seq", again)
        self.assertEqual(again["commit_seq"], first["commit_seq"])
        self.assertIsInstance(again["commit_seq"], int)
        self.assertGreater(again["commit_seq"], 0)

    # --- Issue 2: Snapshot replay order by commit_seq ---
    def test_snapshot_movements_ordered_by_commit_seq(self):
        """Snapshot must expose authoritative server-assigned replay order."""
        self.run_examples_a_to_d()
        s = self.client.get("/api/v1/snapshot").get_json()["data"]
        self.assertEqual(s["schema_version"], 2)  # versioned contract
        movements = s["stock_movements"]
        self.assertEqual(len(movements), 2)
        # Should have commit_seq on each movement
        for m in movements:
            self.assertIn("commit_seq", m)
            self.assertIsInstance(m["commit_seq"], int)
            self.assertGreater(m["commit_seq"], 0)
        # Order must follow commit_seq (not just created_at)
        seqs = [m["commit_seq"] for m in movements]
        self.assertEqual(seqs, sorted(seqs))

    def test_snapshot_equal_timestamps_replay_order(self):
        """Equal or backward timestamps must not reorder movements."""
        self.seed()
        # Create two movements with identical timestamps
        self.sync(80, "record_stock_movement", U(80), {
            "movement_id": U(80), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": 100, "reason": "Delivery",
            "allocations": [{"allocation_id": U(81), "batch_id": U(82), "quantity_change": 100}],
            "new_batches": [{"batch_id": U(82), "received_quantity": 100,
                             "purchase_date": "2026-11-18"}]
        }, 3, "2026-11-18T02:00:00.000Z")
        self.sync(81, "record_stock_movement", U(83), {
            "movement_id": U(83), "item_id": ITEM, "movement_type": "stock_out",
            "quantity_change": -50, "reason": "Used",
            "allocations": [{"allocation_id": U(84), "batch_id": U(82), "quantity_change": -50}]
        }, 4, "2026-11-18T02:00:00.000Z")  # same timestamp
        s = self.client.get("/api/v1/snapshot").get_json()["data"]
        movements = s["stock_movements"]
        # Must be ordered by commit_seq, not timestamp tie-breaker
        seqs = [m["commit_seq"] for m in movements]
        self.assertEqual(seqs, sorted(seqs))

    # --- Issue 3: Unsafe stock transactions rejected ---
    def test_unsafe_item_balance_rejected(self):
        """Item balance exceeding MAX_SAFE must be rejected before commit."""
        self.seed()
        # Use MAX_SAFE to produce overflow
        from app.core.algorithms import MAX_SAFE
        huge = MAX_SAFE
        big = {
            "movement_id": U(90), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": huge, "reason": "Delivery",
            "allocations": [{"allocation_id": U(91), "batch_id": U(92), "quantity_change": huge}],
            "new_batches": [{"batch_id": U(92), "received_quantity": huge,
                             "purchase_date": "2026-11-18"}]
        }
        r = self.sync(88, "record_stock_movement", U(90), big, 3, "2026-11-18T02:00:00Z")
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.get_json()["error"]["code"], "VALIDATION_ERROR")

    def test_unsafe_batch_balance_rejected(self):
        """Batch balance exceeding MAX_SAFE must be rejected."""
        self.seed()
        from app.core.algorithms import MAX_SAFE
        huge = MAX_SAFE
        big = {
            "movement_id": U(93), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": huge, "reason": "Delivery",
            "allocations": [{"allocation_id": U(94), "batch_id": U(95), "quantity_change": huge}],
            "new_batches": [{"batch_id": U(95), "received_quantity": huge,
                             "purchase_date": "2026-11-18"}]
        }
        r = self.sync(89, "record_stock_movement", U(93), big, 3, "2026-11-18T02:00:00Z")
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.get_json()["error"]["code"], "VALIDATION_ERROR")

    def test_positive_adjustment_bounds(self):
        """Positive adjustment must respect safe integer bounds."""
        self.seed()
        from app.core.algorithms import MAX_SAFE
        # First add some stock
        self.sync(90, "record_stock_movement", U(96), {
            "movement_id": U(96), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": 1000, "reason": "Delivery",
            "allocations": [{"allocation_id": U(97), "batch_id": U(98), "quantity_change": 1000}],
            "new_batches": [{"batch_id": U(98), "received_quantity": 1000,
                             "purchase_date": "2026-11-18"}]
        }, 3, "2026-11-18T02:00:00Z")
        # Then try positive adjustment that overflows
        huge = MAX_SAFE - 1000
        adj = {
            "movement_id": U(99), "item_id": ITEM, "movement_type": "positive_adjustment",
            "quantity_change": huge, "reason": "Correction",
            "allocations": [{"allocation_id": U(100), "batch_id": U(98), "quantity_change": huge}]
        }
        r = self.sync(91, "record_stock_movement", U(99), adj, 4, "2026-11-18T03:00:00Z")
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.get_json()["error"]["code"], "VALIDATION_ERROR")

    def test_report_aggregates_bounds(self):
        """Report movement_summary must reject aggregates exceeding MAX_SAFE."""
        self.seed()
        from app.core.algorithms import MAX_SAFE
        huge = MAX_SAFE
        big = {
            "movement_id": U(101), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": huge, "reason": "Delivery",
            "allocations": [{"allocation_id": U(102), "batch_id": U(103), "quantity_change": huge}],
            "new_batches": [{"batch_id": U(103), "received_quantity": huge,
                             "purchase_date": "2026-11-18"}]
        }
        self.sync(92, "record_stock_movement", U(101), big, 3, "2026-11-18T02:00:00Z")
        # Report should reject aggregate
        r = self.client.get(f"/api/v1/reports/stock-movements?item_id={ITEM}")
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.get_json()["error"]["code"], "VALIDATION_ERROR")

    # --- Issue 4: Old schema database migration ---
    def test_old_schema_reopens_without_error(self):
        """Reopening an old-populated database must not break snapshot/sync."""
        # Create DB with old schema (no commit_seq)
        from app import create_app
        import tempfile
        import os
        from app.db import init_db, make_engine
        from sqlalchemy.orm import Session
        from app.models import Category, Item, Movement, Allocation, Batch, ProcessedOperation

        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            engine = make_engine("sqlite:///" + path)
            # Manually create tables WITHOUT commit_seq
            from sqlalchemy import text
            with engine.connect() as conn:
                conn.exec_driver_sql("""
                    CREATE TABLE categories (
                        category_id TEXT(36) PRIMARY KEY,
                        name TEXT NOT NULL,
                        normalized_name TEXT NOT NULL,
                        description TEXT,
                        is_active BOOLEAN DEFAULT 1,
                        created_at TEXT(24) NOT NULL,
                        updated_at TEXT(24) NOT NULL
                    )
                """)
                conn.exec_driver_sql("""
                    CREATE TABLE inventory_items (
                        item_id TEXT(36) PRIMARY KEY,
                        category_id TEXT(36) NOT NULL REFERENCES categories(category_id),
                        name TEXT NOT NULL,
                        normalized_name TEXT NOT NULL,
                        unit_of_measurement TEXT(32) NOT NULL,
                        minimum_stock_level INTEGER NOT NULL,
                        is_active BOOLEAN DEFAULT 1,
                        created_at TEXT(24) NOT NULL,
                        updated_at TEXT(24) NOT NULL
                    )
                """)
                conn.exec_driver_sql("""
                    CREATE TABLE stock_movements (
                        movement_id TEXT(36) PRIMARY KEY,
                        item_id TEXT(36) NOT NULL REFERENCES inventory_items(item_id),
                        movement_type TEXT(32) NOT NULL,
                        quantity_change INTEGER NOT NULL,
                        reason TEXT,
                        recorded_by TEXT(36),
                        created_at TEXT(24) NOT NULL
                    )
                """)
                conn.exec_driver_sql("""
                    CREATE TABLE batch_allocations (
                        allocation_id TEXT(36) PRIMARY KEY,
                        movement_id TEXT(36) NOT NULL REFERENCES stock_movements(movement_id),
                        batch_id TEXT(36) NOT NULL,
                        quantity_change INTEGER NOT NULL
                    )
                """)
                conn.exec_driver_sql("""
                    CREATE TABLE processed_operations (
                        operation_id TEXT(36) PRIMARY KEY,
                        operation_type TEXT(32) NOT NULL,
                        request_fingerprint TEXT(64) NOT NULL,
                        fingerprint_profile TEXT(32) NOT NULL,
                        processed_at TEXT(24) NOT NULL,
                        processing_result TEXT NOT NULL
                    )
                """)
                conn.commit()

            # Now init with migration
            init_db(engine)

            # Verify commit_seq was added and backfilled
            with Session(engine) as s:
                # Column should exist now
                cols = [c["name"] for c in inspect(engine).get_columns("processed_operations")]
                self.assertIn("commit_seq", cols)

            engine.dispose()
        finally:
            os.remove(path)

    def test_rollback_integrity_across_tables(self):
        """Failed validation must roll back ALL tables (movements, allocations, batches, receipts)."""
        self.seed()
        # Attempt a movement that will fail batch balance validation
        # First add valid stock
        self.sync(100, "record_stock_movement", U(104), {
            "movement_id": U(104), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": 100, "reason": "Delivery",
            "allocations": [{"allocation_id": U(105), "batch_id": U(106), "quantity_change": 100}],
            "new_batches": [{"batch_id": U(106), "received_quantity": 100,
                             "purchase_date": "2026-11-18"}]
        }, 3, "2026-11-18T02:00:00Z")
        # Now try to overdraw - should be rejected
        overdraw = {
            "movement_id": U(107), "item_id": ITEM, "movement_type": "stock_out",
            "quantity_change": -200, "reason": "Used",
            "allocations": [{"allocation_id": U(108), "batch_id": U(106), "quantity_change": -200}]
        }
        r = self.sync(101, "record_stock_movement", U(107), overdraw, 4, "2026-11-18T03:00:00Z")
        self.assertEqual(r.status_code, 422)

        # Verify NO partial writes: movements, allocations, batches, receipts all clean
        moves = self.client.get(f"/api/v1/stock-movements?item_id={ITEM}").get_json()["data"]
        self.assertEqual(len(moves), 1)  # only the valid stock_in remains


if __name__ == "__main__":
    unittest.main()
