"""Tests for the pure-logic core (no database). Run: python -m unittest -v"""
import unittest
from datetime import date

from app.core import algorithms as alg
from app.core import commands
from app.core.canonical import build_command, fingerprint, norm_uuid, parse_json_strict
from app.core.errors import ApiError
from app.core.normalize import normalize_name
from app.core.quantities import MAX_SAFE, check_safe, format_quantity, parse_decimal
from app.core.timeutil import canonical_timestamp, parse_timestamp

U = lambda n: f"00000000-0000-4000-8000-{n:012d}"


class QuantityTests(unittest.TestCase):  # ALG-08 / shared "Quantity conversion"
    def test_decimal_text_to_scaled_integer(self):
        self.assertEqual(parse_decimal("1.5", "kg"), 1500)
        self.assertEqual(parse_decimal("1.500", "kg"), 1500)

    def test_excess_precision_is_rejected_not_rounded(self):
        with self.assertRaises(ApiError):
            parse_decimal("1.5001", "kg")

    def test_wire_integer_rules(self):
        for bad in (True, "5", 1.5, 1e3):
            with self.assertRaises(ApiError, msg=repr(bad)):
                check_safe(bad, "q")
        with self.assertRaises(ApiError):
            check_safe(MAX_SAFE + 1, "q")
        self.assertEqual(check_safe(MAX_SAFE, "q"), MAX_SAFE)

    def test_format_round_trip(self):
        self.assertEqual(format_quantity(1500, "kg"), "1.500")
        self.assertEqual(format_quantity(-5, "kg"), "-0.005")
        self.assertEqual(format_quantity(15, "piece"), "15")


class NormalizeTests(unittest.TestCase):  # ALG-03 / "Unicode matching"
    def test_composed_and_decomposed_match(self):
        self.assertEqual(normalize_name("Caf\u00e9"), normalize_name("Cafe\u0301"))

    def test_whitespace_and_case(self):
        self.assertEqual(normalize_name("  COFFEE \u00a0  Beans "), "coffee beans")

    def test_full_case_fold(self):
        self.assertEqual(normalize_name("Straße"), normalize_name("STRASSE"))


class StockRuleTests(unittest.TestCase):
    def test_low_stock_boundaries(self):  # ALG-05
        got = [alg.classify_stock(b, 10) for b in (11, 10, 1, 0)]
        self.assertEqual(got, ["sufficient", "low_stock", "low_stock", "out_of_stock"])

    def test_expiration_boundaries(self):  # ALG-06
        d = date(2026, 11, 18)
        c = lambda off, w=3: alg.classify_expiry(date.fromordinal(d.toordinal() + off), d, w)
        self.assertEqual(c(-1), "expired")
        self.assertEqual(c(0), "expiring_soon")
        self.assertEqual(c(3), "expiring_soon")
        self.assertIsNone(c(4))
        self.assertIsNone(alg.classify_expiry(None, d, 3))
        # no warning period: expired still visible, nothing "soon"
        self.assertEqual(c(-1, None), "expired")
        self.assertIsNone(c(0, None))

    def test_name_sort_and_quantity_ties_and_units(self):  # ALG-02
        mk = lambda n, q, u="piece": {
            "item_id": U(len(n)), "normalized_name": n.lower(),
            "unit_of_measurement": u, "available_quantity": q}
        items = [mk("Milk", 25), mk("Coffee Beans", 100), mk("Paper Cups", 0), mk("Chocolate Syrup", 5)]
        names = [i["normalized_name"] for i in alg.sort_items(items, "name")]
        self.assertEqual(names, ["chocolate syrup", "coffee beans", "milk", "paper cups"])
        qty = [i["available_quantity"] for i in alg.sort_items(items, "available_quantity")]
        self.assertEqual(qty, [0, 5, 25, 100])
        mixed = [mk("a", 5, "kg"), mk("b", 1, "piece")]
        self.assertEqual(alg.sort_items(mixed, "available_quantity")[0]["unit_of_measurement"], "kg")

    def test_restocking_order_and_report_counts(self):  # ALG-07
        items = [
            {"item_id": "1", "normalized_name": "coffee beans", "stock_status": "sufficient"},
            {"item_id": "2", "normalized_name": "milk", "stock_status": "low_stock"},
            {"item_id": "3", "normalized_name": "chocolate syrup", "stock_status": "low_stock"},
            {"item_id": "4", "normalized_name": "paper cups", "stock_status": "out_of_stock"},
        ]
        order = [i["item_id"] for i in alg.restocking_order(items)]
        self.assertEqual(order, ["4", "3", "2"])

    def test_aggregate_keeps_units_separate(self):
        rows = [
            {"item_id": "a", "unit_of_measurement": "kg", "movement_type": "stock_out", "quantity_change": -300},
            {"item_id": "a", "unit_of_measurement": "kg", "movement_type": "stock_out", "quantity_change": -400},
            {"item_id": "b", "unit_of_measurement": "piece", "movement_type": "stock_out", "quantity_change": -2},
        ]
        got = alg.aggregate_movements(rows)
        self.assertEqual(got[0]["total_quantity_change"], -700)
        self.assertEqual(got[0]["movement_count"], 2)
        self.assertEqual(len(got), 2)

    def test_find_duplicates_warns_without_merging(self):
        items = [{"item_id": U(1), "normalized_name": "coffee beans"}]
        self.assertEqual(len(alg.find_duplicates("  COFFEE   beans", items)), 1)
        self.assertEqual(alg.find_duplicates("Tea", items), [])


class CanonicalTests(unittest.TestCase):  # "Equivalent command" fixture
    def test_timestamp_gets_three_fraction_digits(self):
        t = parse_timestamp("2026-11-18T02:00:00Z")
        self.assertEqual(canonical_timestamp(t), "2026-11-18T02:00:00.000Z")

    def test_bad_timestamps(self):
        for bad in ("2026-11-18T02:00:00+08:00", "2026-13-40T02:00:00Z", "yesterday", 5):
            with self.assertRaises(ApiError, msg=str(bad)):
                parse_timestamp(bad)

    def test_equivalent_commands_share_a_fingerprint(self):
        a = commands.validate_payload("create_category", {"category_id": U(1), "name": "Ingredients"})
        b = commands.validate_payload(
            "create_category", {"name": "  Ingredients ", "description": None, "category_id": U(1).upper()})
        ca = build_command("create_category", U(1), "2026-11-18T02:00:00Z", a)
        cb = build_command("create_category", U(1).upper(), "2026-11-18T02:00:00.000Z", b)
        self.assertEqual(fingerprint(ca), fingerprint(cb))

    def test_changed_content_changes_fingerprint(self):
        a = commands.validate_payload("create_category", {"category_id": U(1), "name": "Ingredients"})
        b = commands.validate_payload("create_category", {"category_id": U(1), "name": "Packaging"})
        self.assertNotEqual(
            fingerprint(build_command("create_category", U(1), "2026-11-18T02:00:00Z", a)),
            fingerprint(build_command("create_category", U(1), "2026-11-18T02:00:00Z", b)))

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaises(ApiError):
            parse_json_strict(b'{"a": 1, "a": 2}')

    def test_patch_null_vs_omitted_are_different(self):
        self.assertEqual(commands.update_category({"name": "X"}), {"name": "X"})
        self.assertEqual(commands.update_category({"description": None}), {"description": None})

    def test_uuid_lowercased(self):
        self.assertEqual(norm_uuid(U(1).upper(), "x"), U(1))


def move(mtype, qty, allocs, new=None, reason=None):
    p = {"movement_id": U(100), "item_id": U(2), "movement_type": mtype,
         "quantity_change": qty, "allocations": allocs}
    if reason:
        p["reason"] = reason
    if new is not None:
        p["new_batches"] = new
    return p


A = lambda n, q, b=3: {"allocation_id": U(n), "batch_id": U(b), "quantity_change": q}
NB = lambda q, b=3, **kw: {"batch_id": U(b), "received_quantity": q, **kw}


class MovementValidationTests(unittest.TestCase):  # DB-06
    def code(self, payload):
        with self.assertRaises(ApiError) as cm:
            commands.record_stock_movement(payload)
        return cm.exception.code

    def test_valid_receipt_and_usage(self):
        ok = commands.record_stock_movement(move("stock_in", 20, [A(5, 20)], [NB(20)]))
        self.assertEqual(ok["new_batches"][0]["received_quantity"], 20)
        commands.record_stock_movement(move("stock_out", -5, [A(6, -5)]))

    def test_zero_wrong_sign_and_sum(self):
        self.assertEqual(self.code(move("stock_in", 0, [A(5, 1)], [NB(1)])), "INVALID_QUANTITY")
        self.assertEqual(self.code(move("stock_out", 5, [A(6, 5)])), "INVALID_QUANTITY")
        self.assertEqual(self.code(move("stock_out", -5, [A(6, -4)])), "INVALID_BATCH_ALLOCATION")

    def test_wastage_needs_reason(self):
        self.assertEqual(self.code(move("wastage", -1, [A(6, -1)])), "VALIDATION_ERROR")
        commands.record_stock_movement(move("wastage", -1, [A(6, -1)], reason="Spilled"))

    def test_unknown_field_and_bad_types(self):
        p = move("stock_out", -5, [A(6, -5)]); p["available_quantity"] = 3
        self.assertEqual(self.code(p), "VALIDATION_ERROR")
        self.assertEqual(self.code(move("stock_out", "5", [A(6, -5)])), "VALIDATION_ERROR")

    def test_duplicate_batch_in_allocations(self):
        self.assertEqual(self.code(move("stock_out", -5, [A(6, -2), A(7, -3)])), "INVALID_BATCH_ALLOCATION")

    def test_incoming_stock_must_create_batch(self):
        self.assertEqual(self.code(move("stock_in", 20, [A(5, 20)])), "INVALID_BATCH_ALLOCATION")


class ItemValidationTests(unittest.TestCase):
    def test_direct_quantity_patch_rejected(self):  # DB-02 / API-02
        with self.assertRaises(ApiError) as cm:
            commands.update_item({"available_quantity": 5})
        self.assertEqual(cm.exception.code, "VALIDATION_ERROR")

    def test_create_item_rules(self):
        base = {"item_id": U(2), "category_id": U(1), "name": "Coffee Beans",
                "unit_of_measurement": "kg", "minimum_stock_level": 1000}
        self.assertEqual(commands.create_item(base)["name"], "Coffee Beans")
        for change in ({"name": "   "}, {"unit_of_measurement": "bucket"},
                       {"minimum_stock_level": -1}, {"minimum_stock_level": 1.5}):
            with self.assertRaises(ApiError, msg=str(change)):
                commands.create_item({**base, **change})


if __name__ == "__main__":
    unittest.main()
