"""Contract conformance tests: replay the fictional examples in docs/API_CONTRACT.md.

Section 9 examples A-F (kg item, +1500 / -700, balance 800, rejected -1000) and
G are run in order and the responses are compared with the documented ones.
The remaining tests cover the contract rules that were missing or wrong:
INSUFFICIENT_STOCK details, INVALID_QUANTITY, 503 SYNC_FAILED, row-level
database checks and read requests that must not wait for a writer.
"""
from contextlib import closing
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

from sqlalchemy import inspect

from app.core.quantities import MAX_SAFE

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

    def sync(self, op, typ, entity, payload, seq, created, version=1):
        body = {"operation_id": U(op), "operation_type": typ, "entity_id": entity,
                "payload": payload, "created_at": created, "local_sequence": seq}
        return self.client.post(f"/api/v{version}/sync", json=body,
                                headers={"X-Inventory-Generation": self.gen})

    def assert_accepted(self, response):
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["data"]["outcome"], "accepted")
        return response.get_json()["data"]

    def v2_snapshot(self):
        response = self.client.get("/api/v2/snapshot")
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()["data"]

    def seed(self):
        """Seed minimal data for tests that need it (with initial stock)."""
        self.seed_empty()
        self.assert_accepted(self.sync(33, "record_stock_movement", U(4), self.STOCK_IN, 3,
                                      "2026-11-18T02:05:00Z"))

    def seed_empty(self):
        """Seed minimal data WITHOUT initial stock for boundary tests."""
        self.assert_accepted(self.sync(40, "create_category", CAT, self.CREATE_CAT, 1, "2026-11-18T02:00:00Z"))
        self.assert_accepted(self.sync(31, "create_item", ITEM, self.CREATE_ITEM, 2, "2026-11-18T02:00:00Z"))

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
        for response in (a, b, c, d):
            self.assert_accepted(response)
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
        self.seed_empty()
        with self.app.extensions["engine"].connect() as conn:
            self.assertEqual(conn.exec_driver_sql(
                "SELECT category_id FROM categories"
            ).all(), [(CAT,)])
            self.assertEqual(conn.exec_driver_sql(
                "SELECT item_id, category_id FROM inventory_items"
            ).all(), [(ITEM, CAT)])

    def records(self):
        with self.app.extensions["engine"].connect() as conn:
            return {table: conn.exec_driver_sql(f"SELECT * FROM {table} ORDER BY 1").all()
                    for table in ("categories", "inventory_items", "stock_batches", "stock_movements",
                                  "batch_allocations", "processed_operations", "receipt_ledger_head")}

    def assert_movement_check(self, name, movement_type, quantity):
        from sqlalchemy.exc import IntegrityError
        self.seed()
        before = self.records()
        with self.assertRaisesRegex(IntegrityError, rf"CHECK constraint failed: {name}\b"):
            self.insert_movement(movement_type, quantity)
        self.assertEqual(self.records(), before)

    def insert_movement(self, mtype, qty, reason=None):
        from app.models import Movement
        from sqlalchemy.orm import Session
        with Session(self.app.extensions["engine"]) as s:
            s.add(Movement(movement_id=U(900), item_id=ITEM, movement_type=mtype,
                           quantity_change=qty, reason=reason, recorded_by=None,
                           created_at="2026-11-18T03:00:00.000Z"))
            s.commit()

    def test_sign_must_match_type(self):
        self.assert_movement_check("ck_movement_sign", "stock_out", 5)

    def test_unknown_type_rejected(self):
        self.assert_movement_check("ck_movement_type", "teleport", 5)

    def test_reason_required_for_wastage(self):
        self.assert_movement_check("ck_movement_reason", "wastage", -5)

    def test_referenced_category_cannot_be_deleted(self):
        from sqlalchemy.exc import IntegrityError
        self.seed()
        before = self.records()
        with self.app.extensions["engine"].begin() as conn:
            with self.assertRaisesRegex(IntegrityError, "FOREIGN KEY constraint failed"):
                conn.exec_driver_sql("DELETE FROM categories")
        self.assertEqual(self.records(), before)


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
        """A v2 retry retains the acceptance's original receipt and sequence."""
        self.seed()
        request = (34, "record_stock_movement", U(6), self.STOCK_OUT, 44, "2026-11-18T03:00:00Z")
        first = self.assert_accepted(self.sync(*request, version=2))
        replay = self.sync(*request, version=2)
        self.assertEqual(replay.status_code, 200, replay.get_json())
        self.assertEqual(replay.get_json()["data"], {**first, "outcome": "already_processed"})
        self.assertEqual(first["commit_seq"], 4)

    # --- Issue 2: Snapshot replay order by commit_seq ---
    def test_snapshot_movements_ordered_by_commit_seq(self):
        """Snapshot must expose authoritative server-assigned replay order."""
        self.run_examples_a_to_d()
        s = self.v2_snapshot()
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
        incoming = self.sync(80, "record_stock_movement", U(90), {
            "movement_id": U(90), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": 100, "reason": "Delivery",
            "allocations": [{"allocation_id": U(81), "batch_id": U(82), "quantity_change": 100}],
            "new_batches": [{"batch_id": U(82), "received_quantity": 100,
                             "purchase_date": "2026-11-18"}]
        }, 3, "2026-11-18T02:00:00.000Z")
        outgoing = self.sync(81, "record_stock_movement", U(83), {
            "movement_id": U(83), "item_id": ITEM, "movement_type": "stock_out",
            "quantity_change": -50, "reason": "Used",
            "allocations": [{"allocation_id": U(84), "batch_id": U(82), "quantity_change": -50}]
        }, 4, "2026-11-18T02:00:00.000Z")  # same timestamp
        self.assert_accepted(incoming)
        self.assert_accepted(outgoing)
        s = self.v2_snapshot()
        movements = s["stock_movements"]
        self.assertEqual([m["movement_id"] for m in movements], [U(4), U(90), U(83)])
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
        """An overflowing batch is caught before the derived item-total check."""
        self.seed_empty()
        huge = MAX_SAFE
        big = {
            "movement_id": U(93), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": huge,
            "allocations": [{"allocation_id": U(94), "batch_id": U(95), "quantity_change": huge}],
            "new_batches": [{"batch_id": U(95), "received_quantity": huge}],
        }
        self.assert_accepted(self.sync(89, "record_stock_movement", U(93), big, 3, "2026-11-18T02:00:00Z"))
        batch = self.client.get(f"/api/v1/batches/{U(95)}")
        self.assertEqual(batch.status_code, 200, batch.get_json())
        self.assertEqual(batch.get_json()["data"]["remaining_quantity"], MAX_SAFE)
        before = self.stock_rows()
        adjustment = {
            "movement_id": U(96), "item_id": ITEM, "movement_type": "positive_adjustment",
            "quantity_change": 1, "reason": "Correction",
            "allocations": [{"allocation_id": U(97), "batch_id": U(95), "quantity_change": 1}],
        }
        response = self.sync(90, "record_stock_movement", U(96), adjustment, 4, "2026-11-18T03:00:00Z")
        self.assert_batch_overflow(response, before)

    def test_positive_adjustment_bounds(self):
        """An accepted adjustment may reach MAX_SAFE, and the next unit is rejected."""
        self.seed_empty()
        start = MAX_SAFE - 2
        incoming = {
            "movement_id": U(96), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": start,
            "allocations": [{"allocation_id": U(97), "batch_id": U(98), "quantity_change": start}],
            "new_batches": [{"batch_id": U(98), "received_quantity": start}],
        }
        entered = self.sync(90, "record_stock_movement", U(96), incoming, 3, "2026-11-18T02:00:00Z")
        self.assert_accepted(entered)
        at_maximum = {
            "movement_id": U(99), "item_id": ITEM, "movement_type": "positive_adjustment",
            "quantity_change": 2, "reason": "Correction",
            "allocations": [{"allocation_id": U(100), "batch_id": U(98), "quantity_change": 2}],
        }
        self.assert_accepted(self.sync(91, "record_stock_movement", U(99), at_maximum, 4,
                                       "2026-11-18T03:00:00Z"))
        batch = self.client.get(f"/api/v1/batches/{U(98)}")
        self.assertEqual(batch.status_code, 200, batch.get_json())
        self.assertEqual(batch.get_json()["data"]["remaining_quantity"], MAX_SAFE)
        before = self.stock_rows()
        excess = {**at_maximum, "movement_id": U(110), "quantity_change": 1,
                  "allocations": [{"allocation_id": U(111), "batch_id": U(98), "quantity_change": 1}]}
        response = self.sync(92, "record_stock_movement", U(110), excess, 5, "2026-11-18T04:00:00Z")
        self.assert_batch_overflow(response, before)

    def stock_rows(self):
        with closing(sqlite3.connect(self.path)) as conn:
            return {table: conn.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
                    for table in ("stock_batches", "stock_movements", "batch_allocations",
                                  "processed_operations", "receipt_ledger_head")}

    def assert_batch_overflow(self, response, before):
        # A single nonnegative batch cannot exceed the safe item total on its
        # own. The field-specific error independently proves the batch guard ran.
        self.assertEqual(response.status_code, 422, response.get_json())
        self.assertEqual(response.get_json()["error"]["code"], "VALIDATION_ERROR")
        self.assertIn("resulting batch balance", response.get_json()["error"]["details"]["fields"])
        self.assertEqual(self.stock_rows(), before)


    def test_report_aggregates_bounds(self):
        """Legal current stock can coexist with an unrepresentable historical sum."""
        from app.core.quantities import MAX_SAFE

        for operation, kind, entity, payload in (
            (40, "create_category", CAT, self.CREATE_CAT),
            (31, "create_item", ITEM, self.CREATE_ITEM),
        ):
            prepared = self.sync(operation, kind, entity, payload, operation,
                                 "2026-11-18T01:00:00Z")
            self.assertEqual(prepared.status_code, 200, prepared.get_json())
            self.assertEqual(prepared.get_json()["data"]["outcome"], "accepted")

        first = {
            "movement_id": U(101), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": MAX_SAFE, "reason": "Delivery 1",
            "allocations": [{"allocation_id": U(102), "batch_id": U(103), "quantity_change": MAX_SAFE}],
            "new_batches": [{"batch_id": U(103), "received_quantity": MAX_SAFE}],
        }
        used = {
            "movement_id": U(107), "item_id": ITEM, "movement_type": "stock_out",
            "quantity_change": -MAX_SAFE, "reason": "Used all of delivery 1",
            "allocations": [{"allocation_id": U(108), "batch_id": U(103), "quantity_change": -MAX_SAFE}],
        }
        second = {
            "movement_id": U(104), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": 2, "reason": "Delivery 2",
            "allocations": [{"allocation_id": U(105), "batch_id": U(106), "quantity_change": 2}],
            "new_batches": [{"batch_id": U(106), "received_quantity": 2}],
        }
        for operation, payload, event, balance in (
            (92, first, "2026-11-18T02:00:00Z", MAX_SAFE),
            (94, used, "2026-11-18T02:02:00Z", 0),
            (93, second, "2026-11-18T02:05:00Z", 2),
        ):
            accepted = self.sync(operation, "record_stock_movement", payload["movement_id"],
                                 payload, operation, event)
            self.assertEqual(accepted.status_code, 200, accepted.get_json())
            self.assertEqual(accepted.get_json()["data"]["outcome"], "accepted")
            inventory = self.client.get(f"/api/v1/inventory/{ITEM}")
            self.assertEqual(inventory.status_code, 200, inventory.get_json())
            self.assertEqual(inventory.get_json()["data"]["available_quantity"], balance)

        url = f"/api/v1/reports/stock-movements?item_id={ITEM}&movement_type=stock_in"
        report = self.client.get(url)
        self.assertEqual(report.status_code, 422, report.get_json())
        self.assertEqual(report.get_json()["error"]["code"], "VALIDATION_ERROR")
        filtered = self.client.get(url + "&from=2026-11-18T02:05:00Z&page_size=1")
        self.assertEqual(filtered.status_code, 200, filtered.get_json())
        self.assertEqual(filtered.get_json()["meta"], {"page": 1, "page_size": 1, "total": 1})
        self.assertEqual(filtered.get_json()["data"], [{
            "item_id": ITEM, "unit_of_measurement": "kg", "movement_type": "stock_in",
            "movement_count": 1, "total_quantity_change": 2,
        }])

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
                from sqlalchemy import inspect
                cols = [c["name"] for c in inspect(engine).get_columns("processed_operations")]
                self.assertIn("commit_seq", cols)
                self.assertIn("migration_metadata", cols)

            engine.dispose()
        finally:
            os.remove(path)

    def test_rollback_integrity_across_tables(self):
        """Failed validation must roll back ALL tables (movements, allocations, batches, receipts)."""
        self.seed_empty()
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

    # --- Additional regressions requested ---

    def test_max_safe_integer_then_rejected(self):
        """Receiving MAX_SAFE then 2 more must reject and leave no new records."""
        self.seed_empty()
        from app.core.algorithms import MAX_SAFE

        # First receipt: MAX_SAFE
        first = {
            "movement_id": U(200), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": MAX_SAFE, "reason": "Delivery",
            "allocations": [{"allocation_id": U(201), "batch_id": U(202), "quantity_change": MAX_SAFE}],
            "new_batches": [{"batch_id": U(202), "received_quantity": MAX_SAFE,
                             "purchase_date": "2026-11-18"}]
        }
        r1 = self.sync(150, "record_stock_movement", U(200), first, 3, "2026-11-18T02:00:00Z")
        self.assertEqual(r1.status_code, 200)

        # Second receipt: +2 pieces (should overflow)
        second = {
            "movement_id": U(203), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": 2, "reason": "Delivery",
            "allocations": [{"allocation_id": U(204), "batch_id": U(205), "quantity_change": 2}],
            "new_batches": [{"batch_id": U(205), "received_quantity": 2,
                             "purchase_date": "2026-11-18"}]
        }
        r2 = self.sync(151, "record_stock_movement", U(203), second, 4, "2026-11-18T03:00:00Z")
        self.assertEqual(r2.status_code, 422)
        self.assertEqual(r2.get_json()["error"]["code"], "VALIDATION_ERROR")

        # Verify no new movement, allocation, batch, or receipt records
        moves = self.client.get(f"/api/v1/stock-movements?item_id={ITEM}").get_json()["data"]
        self.assertEqual(len(moves), 1)  # only first receipt remains
        snap = self.client.get(f"/api/v1/snapshot?receipt_id={U(151)}").get_json()["data"]
        self.assertEqual(snap["receipt_checks"][0]["status"], "missing")

    def test_existing_batch_adjustment_overflow(self):
        """Positive adjustment to existing batch must respect bounds."""
        self.seed()
        from app.core.algorithms import MAX_SAFE

        # Create stock with room for adjustment
        self.sync(160, "record_stock_movement", U(210), {
            "movement_id": U(210), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": 1000, "reason": "Delivery",
            "allocations": [{"allocation_id": U(211), "batch_id": U(212), "quantity_change": 1000}],
            "new_batches": [{"batch_id": U(212), "received_quantity": 1000,
                             "purchase_date": "2026-11-18"}]
        }, 3, "2026-11-18T02:00:00Z")

        # Try positive adjustment that would overflow
        huge = MAX_SAFE - 1000
        adj = {
            "movement_id": U(213), "item_id": ITEM, "movement_type": "positive_adjustment",
            "quantity_change": huge, "reason": "Correction",
            "allocations": [{"allocation_id": U(214), "batch_id": U(212), "quantity_change": huge}]
        }
        r = self.sync(161, "record_stock_movement", U(213), adj, 4, "2026-11-18T03:00:00Z")
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.get_json()["error"]["code"], "VALIDATION_ERROR")

        # Verify no partial write
        batch = self.client.get(f"/api/v1/batches/{U(212)}").get_json()["data"]
        self.assertEqual(batch["remaining_quantity"], 1000)

    def test_historical_migration_with_populated_records(self):
        """Migration must preserve real receipt, withdrawal, allocation, and processed-operation records."""
        from app import create_app
        import tempfile
        import os
        from app.db import init_db, make_engine
        from sqlalchemy.orm import Session
        from app.models import Category, Item, Movement, Allocation, Batch, ProcessedOperation
        from sqlalchemy import inspect

        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            engine = make_engine("sqlite:///" + path)
            # Create old schema
            from sqlalchemy import text
            with engine.connect() as conn:
                conn.exec_driver_sql("""
                    CREATE TABLE categories (
                        category_id TEXT(36) PRIMARY KEY,
                        name TEXT NOT NULL, normalized_name TEXT NOT NULL,
                        description TEXT, is_active BOOLEAN DEFAULT 1,
                        created_at TEXT(24) NOT NULL, updated_at TEXT(24) NOT NULL
                    )
                """)
                conn.exec_driver_sql("""
                    CREATE TABLE inventory_items (
                        item_id TEXT(36) PRIMARY KEY,
                        category_id TEXT(36) NOT NULL REFERENCES categories(category_id),
                        name TEXT NOT NULL, normalized_name TEXT NOT NULL,
                        unit_of_measurement TEXT(32) NOT NULL,
                        minimum_stock_level INTEGER NOT NULL,
                        is_active BOOLEAN DEFAULT 1,
                        created_at TEXT(24) NOT NULL, updated_at TEXT(24) NOT NULL
                    )
                """)
                conn.exec_driver_sql("""
                    CREATE TABLE stock_movements (
                        movement_id TEXT(36) PRIMARY KEY,
                        item_id TEXT(36) NOT NULL REFERENCES inventory_items(item_id),
                        movement_type TEXT(32) NOT NULL,
                        quantity_change INTEGER NOT NULL, reason TEXT,
                        recorded_by TEXT(36), created_at TEXT(24) NOT NULL
                    )
                """)
                conn.exec_driver_sql("""
                    CREATE TABLE stock_batches (
                        batch_id TEXT(36) PRIMARY KEY,
                        item_id TEXT(36) NOT NULL REFERENCES inventory_items(item_id),
                        received_quantity INTEGER NOT NULL,
                        purchase_date TEXT, purchase_cost INTEGER,
                        expiration_date TEXT, created_at TEXT(24) NOT NULL
                    )
                """)
                conn.exec_driver_sql("""
                    CREATE TABLE batch_allocations (
                        allocation_id TEXT(36) PRIMARY KEY,
                        movement_id TEXT(36) NOT NULL REFERENCES stock_movements(movement_id),
                        batch_id TEXT(36) NOT NULL, quantity_change INTEGER NOT NULL
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
                # Insert realistic historical data
                conn.exec_driver_sql("""
                    INSERT INTO categories VALUES ('cat-1', 'Ingredients', 'ingredients', NULL, 1, '2026-11-18T02:00:00.000Z', '2026-11-18T02:00:00.000Z')
                """)
                conn.exec_driver_sql("""
                    INSERT INTO inventory_items VALUES ('item-1', 'cat-1', 'Coffee Beans', 'coffee beans', 'piece', 10, 1, '2026-11-18T02:00:00.000Z', '2026-11-18T02:00:00.000Z')
                """)
                conn.exec_driver_sql("""
                    INSERT INTO stock_movements VALUES ('mov-1', 'item-1', 'stock_in', 100, 'Delivery', NULL, '2026-11-18T02:05:00.000Z')
                """)
                conn.exec_driver_sql("""
                    INSERT INTO stock_movements VALUES ('mov-2', 'item-1', 'stock_out', -30, 'Used', NULL, '2026-11-18T03:00:00.000Z')
                """)
                conn.exec_driver_sql("""
                    INSERT INTO stock_batches VALUES ('batch-1', 'item-1', 100, '2026-11-18', NULL, NULL, '2026-11-18T02:05:00.000Z')
                """)
                conn.exec_driver_sql("""
                    INSERT INTO batch_allocations VALUES ('alloc-1', 'mov-1', 'batch-1', 100)
                """)
                conn.exec_driver_sql("""
                    INSERT INTO batch_allocations VALUES ('alloc-2', 'mov-2', 'batch-1', -30)
                """)
                conn.exec_driver_sql("""
                    INSERT INTO processed_operations VALUES ('op-1', 'create_category', 'sha256', '1:/api/v1', '2026-11-18T03:01:00.000Z', '{}')
                """)
                conn.exec_driver_sql("""
                    INSERT INTO processed_operations VALUES ('op-2', 'create_item', 'sha256', '1:/api/v1', '2026-11-18T03:01:01.000Z', '{}')
                """)
                conn.exec_driver_sql("""
                    INSERT INTO processed_operations VALUES ('op-3', 'record_stock_movement', 'sha256', '1:/api/v1', '2026-11-18T03:01:02.000Z', '{}')
                """)
                conn.exec_driver_sql("""
                    INSERT INTO processed_operations VALUES ('op-4', 'record_stock_movement', 'sha256', '1:/api/v1', '2026-11-18T03:01:03.000Z', '{}')
                """)
                conn.commit()

            # Now init with migration
            init_db(engine)

            # Verify all historical data preserved
            with Session(engine) as s:
                # Column should exist now
                cols = [c["name"] for c in inspect(engine).get_columns("processed_operations")]
                self.assertIn("commit_seq", cols)
                self.assertIn("migration_metadata", cols)

                # All 4 processed operations should exist with provisional commit_seq
                ops = s.query(ProcessedOperation).all()
                self.assertEqual(len(ops), 4)
                for op in ops:
                    self.assertEqual(op.migration_metadata, "provisional")
                    self.assertGreater(op.commit_seq, 0)

                # Movements and allocations preserved
                movs = s.query(Movement).all()
                self.assertEqual(len(movs), 2)
                allocs = s.query(Allocation).all()
                self.assertEqual(len(allocs), 2)

                # Batches preserved
                batches = s.query(Batch).all()
                self.assertEqual(len(batches), 1)

            engine.dispose()
        finally:
            os.remove(path)

    def test_snapshot_replay_operation_id_differs_from_movement_id(self):
        """Snapshot replay order must use durable entity_id association, not operation_id."""
        self.run_examples_a_to_d()
        # Create two movements with DIFFERENT operation IDs than movement IDs
        # and identical timestamps - order must be by commit_seq from ProcessedOperation.entity_id
        first = self.sync(200, "record_stock_movement", U(201), {
            "movement_id": U(201), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": 50, "reason": "Delivery A",
            "allocations": [{"allocation_id": U(202), "batch_id": U(203), "quantity_change": 50}],
            "new_batches": [{"batch_id": U(203), "received_quantity": 50,
                             "purchase_date": "2026-11-18"}]
        }, 3, "2026-11-18T02:00:00.000Z")
        second = self.sync(204, "record_stock_movement", U(205), {
            "movement_id": U(205), "item_id": ITEM, "movement_type": "stock_in",
            "quantity_change": 30, "reason": "Delivery B",
            "allocations": [{"allocation_id": U(206), "batch_id": U(207), "quantity_change": 30}],
            "new_batches": [{"batch_id": U(207), "received_quantity": 30,
                             "purchase_date": "2026-11-18"}]
        }, 4, "2026-11-18T02:00:00.000Z")  # same timestamp

        self.assert_accepted(first)
        self.assert_accepted(second)
        # Verify snapshot has both movements with commit_seq and replay_status.
        s = self.v2_snapshot()
        movements = s["stock_movements"]
        self.assertEqual(len(movements), 4)  # 2 from run_examples_a_to_d + 2 new

        # Find our new movements
        new_movs = [m for m in movements if m["movement_id"] in (U(201), U(205))]
        self.assertEqual(len(new_movs), 2)

        # Both must have commit_seq and replay_status
        for m in new_movs:
            self.assertIn("commit_seq", m)
            self.assertIsInstance(m["commit_seq"], int)
            self.assertGreater(m["commit_seq"], 0)
            self.assertIn("replay_status", m)
            self.assertEqual(m["replay_status"], "verified")

        # Order must follow commit_seq
        seqs = [m["commit_seq"] for m in new_movs]
        self.assertEqual(seqs, sorted(seqs))


if __name__ == "__main__":
    unittest.main()
