"""API + database tests (API-xx, DB-xx, the first vertical slice).

Needs Flask and SQLAlchemy:  pip install -r requirements.txt
Run:  python -m unittest -v
If SQLAlchemy is missing these tests are SKIPPED, not passed.
"""
import copy
import os
import tempfile
import unittest
from datetime import datetime, timezone

try:
    import sqlalchemy  # noqa: F401
    HAVE_DB = True
except ImportError:  # pragma: no cover
    HAVE_DB = False

U = lambda n: f"00000000-0000-4000-8000-{n:012d}"
CAT, ITEM, BATCH = U(1), U(2), U(3)
FIXED_NOW = datetime(2026, 11, 18, 3, 1, 0, tzinfo=timezone.utc)


@unittest.skipUnless(HAVE_DB, "SQLAlchemy is not installed")
class ApiCase(unittest.TestCase):
    def setUp(self):
        from app import create_app
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.config = {"DATABASE_URL": "sqlite:///" + self.path, "NOW": lambda: FIXED_NOW,
                       "EXPIRATION_WARNING_DAYS": 3, "TESTING": True}
        self.boot()

    def boot(self):
        from app import create_app
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.gen = self.client.get("/api/v1/health").headers["X-Inventory-Generation"]

    def tearDown(self):
        self.app.extensions["engine"].dispose()
        os.remove(self.path)

    # -- helpers
    def sync(self, op_id, op_type, entity, payload, seq=1, created="2026-11-18T02:00:00Z", gen=True):
        body = {"operation_id": U(op_id), "operation_type": op_type, "entity_id": entity,
                "payload": payload, "created_at": created, "local_sequence": seq}
        headers = {"X-Inventory-Generation": self.gen} if gen else {}
        return self.client.post("/api/v1/sync", json=body, headers=headers)

    def seed(self):
        self.assertEqual(self.sync(40, "create_category", CAT,
                                   {"category_id": CAT, "name": "Ingredients"}).status_code, 200)
        self.assertEqual(self.sync(41, "create_item", ITEM, {
            "item_id": ITEM, "category_id": CAT, "name": "Coffee Beans",
            "unit_of_measurement": "piece", "minimum_stock_level": 10}, 2).status_code, 200)

    STOCK_IN = {"movement_id": U(4), "item_id": ITEM, "movement_type": "stock_in",
                "quantity_change": 20, "reason": "Delivery",
                "allocations": [{"allocation_id": U(5), "batch_id": BATCH, "quantity_change": 20}],
                "new_batches": [{"batch_id": BATCH, "received_quantity": 20,
                                 "purchase_date": "2026-11-18", "expiration_date": "2026-11-20"}]}
    STOCK_OUT = {"movement_id": U(6), "item_id": ITEM, "movement_type": "stock_out",
                 "quantity_change": -5, "reason": "Used during service",
                 "allocations": [{"allocation_id": U(7), "batch_id": BATCH, "quantity_change": -5}]}

    def balance(self):
        return self.client.get(f"/api/v1/inventory/{ITEM}").get_json()["data"]["available_quantity"]


class VerticalSliceTests(ApiCase):
    def test_20_in_5_out_balance_15_and_retry_is_idempotent(self):
        self.seed()
        r = self.sync(42, "record_stock_movement", U(4), self.STOCK_IN, 3)
        self.assertEqual(r.get_json()["data"]["outcome"], "accepted")
        r = self.sync(43, "record_stock_movement", U(6), self.STOCK_OUT, 4)
        self.assertEqual(r.get_json()["data"]["outcome"], "accepted")
        self.assertEqual(self.balance(), 15)
        # lost acknowledgment: resend the identical request
        again = self.sync(43, "record_stock_movement", U(6), self.STOCK_OUT, 4)
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.get_json()["data"]["outcome"], "already_processed")
        self.assertEqual(self.balance(), 15)
        moves = self.client.get("/api/v1/stock-movements").get_json()
        self.assertEqual(moves["meta"]["total"], 2)  # one occurrence of each movement

    def test_state_survives_restart(self):
        self.seed()
        self.sync(42, "record_stock_movement", U(4), self.STOCK_IN, 3)
        self.app.extensions["engine"].dispose()
        self.boot_same_generation()
        self.assertEqual(self.balance(), 20)

    def boot_same_generation(self):
        old = self.gen
        self.boot()
        self.assertEqual(self.gen, old)  # generation is persisted, not regenerated

    def test_changed_payload_with_same_operation_id_conflicts(self):
        self.seed()
        self.sync(42, "record_stock_movement", U(4), self.STOCK_IN, 3)
        self.sync(43, "record_stock_movement", U(6), self.STOCK_OUT, 4)
        changed = copy.deepcopy(self.STOCK_OUT)
        changed["quantity_change"] = -4
        changed["allocations"][0]["quantity_change"] = -4
        r = self.sync(43, "record_stock_movement", U(6), changed, 4)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.get_json()["error"]["code"], "OPERATION_ID_CONFLICT")
        self.assertEqual(self.balance(), 15)

    def test_overdraw_is_rejected_and_leaves_no_partial_write(self):  # sync example F
        self.seed()
        self.sync(42, "record_stock_movement", U(4), self.STOCK_IN, 3)
        big = copy.deepcopy(self.STOCK_OUT)
        big.update(movement_id=U(9), quantity_change=-25)
        big["allocations"] = [{"allocation_id": U(10), "batch_id": BATCH, "quantity_change": -25}]
        r = self.sync(44, "record_stock_movement", U(9), big, 4)
        err = r.get_json()["error"]
        self.assertEqual((r.status_code, err["code"]), (422, "INSUFFICIENT_STOCK"))
        self.assertEqual(err["details"]["outcome"], "rejected")
        self.assertEqual(err["details"]["available_quantity"], 20)
        self.assertEqual(self.balance(), 20)
        self.assertEqual(self.client.get("/api/v1/stock-movements").get_json()["meta"]["total"], 1)
        # a rejected command leaves no receipt, so a corrected command may reuse nothing
        snap = self.client.get(f"/api/v1/snapshot?receipt_id={U(44)}").get_json()["data"]
        self.assertEqual(snap["receipt_checks"][0]["status"], "missing")


class RuleTests(ApiCase):
    def test_generation_header_required_and_checked(self):
        r = self.sync(40, "create_category", CAT, {"category_id": CAT, "name": "X"}, gen=False)
        self.assertEqual((r.status_code, r.get_json()["error"]["code"]), (400, "INVALID_REQUEST"))
        self.gen = U(999)
        r = self.sync(40, "create_category", CAT, {"category_id": CAT, "name": "X"})
        self.assertEqual((r.status_code, r.get_json()["error"]["code"]), (409, "RECOVERY_REQUIRED"))

    def test_item_needs_existing_category_and_blocks_duplicates(self):  # DB-03
        r = self.sync(41, "create_item", ITEM, {"item_id": ITEM, "category_id": CAT,
                      "name": "Coffee Beans", "unit_of_measurement": "piece",
                      "minimum_stock_level": 10})
        self.assertEqual((r.status_code, r.get_json()["error"]["code"]), (404, "CATEGORY_NOT_FOUND"))
        self.seed()
        r = self.sync(50, "create_item", U(20), {"item_id": U(20), "category_id": CAT,
                      "name": "  COFFEE   beans ", "unit_of_measurement": "piece",
                      "minimum_stock_level": 10}, 3)
        self.assertEqual((r.status_code, r.get_json()["error"]["code"]), (409, "DUPLICATE_ITEM"))

    def test_quantity_cannot_be_patched_directly(self):  # API-02 / DB-02
        self.seed()
        r = self.client.patch(f"/api/v1/inventory/{ITEM}", headers={"X-Inventory-Generation": self.gen},
                              json={"operation_id": U(60), "created_at": "2026-11-18T02:05:00Z",
                                    "available_quantity": 99})
        self.assertEqual((r.status_code, r.get_json()["error"]["code"]), (422, "VALIDATION_ERROR"))
        self.assertEqual(self.balance(), 0)

    def test_archive_guards(self):  # DB-07
        self.seed()
        r = self.sync(61, "archive_category", CAT, {}, 3)
        self.assertEqual(r.get_json()["error"]["code"], "CATEGORY_IN_USE")
        self.sync(42, "record_stock_movement", U(4), self.STOCK_IN, 4)
        r = self.sync(62, "archive_item", ITEM, {}, 5)
        self.assertEqual(r.get_json()["error"]["code"], "ITEM_HAS_STOCK")
        clear = copy.deepcopy(self.STOCK_OUT)
        clear.update(movement_id=U(8), quantity_change=-20)
        clear["allocations"] = [{"allocation_id": U(11), "batch_id": BATCH, "quantity_change": -20}]
        self.assertEqual(self.sync(63, "record_stock_movement", U(8), clear, 6).status_code, 200)
        r = self.sync(64, "archive_item", ITEM, {}, 7)
        self.assertFalse(r.get_json()["data"]["result"]["is_active"])
        history = self.client.get(f"/api/v1/stock-movements?item_id={ITEM}").get_json()
        self.assertEqual(history["meta"]["total"], 2)  # history kept

    def test_direct_route_shares_receipts_with_sync(self):
        h = {"X-Inventory-Generation": self.gen}
        body = {"operation_id": U(40), "created_at": "2026-11-18T02:00:00Z",
                "category_id": CAT, "name": "Ingredients"}
        r = self.client.post("/api/v1/categories", json=body, headers=h)
        self.assertEqual(r.status_code, 201)
        r = self.client.post("/api/v1/categories", json=body, headers=h)  # replay
        self.assertEqual(r.status_code, 200)
        # the same command arriving through /sync is recognized too
        r = self.sync(40, "create_category", CAT, {"category_id": CAT, "name": "Ingredients"})
        self.assertEqual(r.get_json()["data"]["outcome"], "already_processed")

    def test_malformed_requests(self):
        h = {"X-Inventory-Generation": self.gen}
        r = self.client.post("/api/v1/sync", data=b'{"a":1,"a":2}', headers=h,
                             content_type="application/json")
        self.assertEqual(r.status_code, 400)
        r = self.client.get("/api/v1/inventory/not-a-uuid")
        self.assertEqual((r.status_code, r.get_json()["error"]["code"]), (400, "INVALID_REQUEST"))
        r = self.client.get(f"/api/v1/inventory/{U(77)}")
        self.assertEqual((r.status_code, r.get_json()["error"]["code"]), (404, "ITEM_NOT_FOUND"))
        r = self.client.get("/api/v1/inventory?page_size=1000")
        self.assertEqual(r.status_code, 400)


class ReadAndReportTests(ApiCase):
    def setUp(self):
        super().setUp()
        self.seed()
        self.sync(42, "record_stock_movement", U(4), self.STOCK_IN, 3)
        self.sync(43, "record_stock_movement", U(6), self.STOCK_OUT, 4,
                  created="2026-11-18T03:00:00Z")

    def test_inventory_list_filters_and_status(self):
        d = self.client.get("/api/v1/inventory?q=coffee&stock_status=sufficient").get_json()
        self.assertEqual(d["meta"]["total"], 1)
        self.assertEqual(d["data"][0]["available_quantity"], 15)
        self.assertEqual(self.client.get("/api/v1/inventory?stock_status=low_stock")
                         .get_json()["meta"]["total"], 0)

    def test_batch_remaining(self):
        b = self.client.get(f"/api/v1/batches/{BATCH}").get_json()["data"]
        self.assertEqual((b["received_quantity"], b["remaining_quantity"]), (20, 15))

    def test_dashboard_and_expiry(self):
        d = self.client.get("/api/v1/reports/dashboard?recent_limit=1").get_json()["data"]
        self.assertEqual(d["total_active_items"], 1)
        self.assertEqual(d["sufficient_stock_items"], 1)
        self.assertEqual(d["expiring_soon_items"], 1)   # expires 2026-11-20, 3-day window
        self.assertEqual(d["recent_movements"][0]["movement_id"], U(6))
        e = self.client.get("/api/v1/reports/expiring?status=expiring_soon").get_json()
        self.assertEqual(e["meta"]["expiration_status"], "available")
        self.assertEqual(e["data"][0]["remaining_quantity"], 15)

    def test_movement_summary_date_filter(self):
        url = (f"/api/v1/reports/stock-movements?item_id={ITEM}&movement_type=stock_out"
               "&from=2026-11-18T00:00:00Z&to=2026-11-19T00:00:00Z")
        row = self.client.get(url).get_json()["data"][0]
        self.assertEqual((row["movement_count"], row["total_quantity_change"]), (1, -5))
        excl = self.client.get(f"/api/v1/reports/stock-movements?to=2026-11-18T03:00:00Z"
                               "&movement_type=stock_out").get_json()
        self.assertEqual(excl["meta"]["total"], 0)  # end is exclusive

    def test_snapshot_reconciles(self):
        s = self.client.get(f"/api/v1/snapshot?receipt_id={U(43)}&receipt_id={U(1234)}").get_json()["data"]
        self.assertEqual([c["status"] for c in s["receipt_checks"]], ["accepted", "missing"])
        self.assertEqual(s["inventory_items"][0]["available_quantity"], 15)
        self.assertEqual(sum(a["quantity_change"] for a in s["batch_allocations"]), 15)
        self.assertEqual(s["server_generation_id"], self.gen)


if __name__ == "__main__":
    unittest.main()
