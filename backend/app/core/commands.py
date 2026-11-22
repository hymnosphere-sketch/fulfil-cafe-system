"""Shape validation for every command payload (API_CONTRACT 4-6, 9).

These functions check structure and field values only. Checks that need the
database (does the category exist? is there enough stock?) live in the
services. Every function returns a cleaned payload and raises ApiError.
"""
from .canonical import norm_uuid
from .errors import ApiError, validation_error
from .normalize import display_name, normalize_name
from .quantities import MAX_SAFE, check_safe, is_json_integer, scale_for
from .timeutil import parse_date

OPERATION_TYPES = (
    "create_category",
    "update_category",
    "archive_category",
    "create_item",
    "update_item",
    "archive_item",
    "record_stock_movement",
)

MOVEMENT_TYPES = (
    "initial_stock",
    "stock_in",
    "stock_out",
    "wastage",
    "positive_adjustment",
    "negative_adjustment",
)
POSITIVE_TYPES = ("initial_stock", "stock_in", "positive_adjustment")
NEGATIVE_TYPES = ("stock_out", "wastage", "negative_adjustment")
REASON_REQUIRED = ("wastage", "positive_adjustment", "negative_adjustment")


def _only(payload, allowed, required=()):
    """Reject unknown fields; require the listed ones."""
    if not isinstance(payload, dict):
        raise validation_error({"payload": "Must be a JSON object."})
    unknown = sorted(set(payload) - set(allowed))
    if unknown:
        raise validation_error({k: "This field is not allowed." for k in unknown})
    missing = [k for k in required if k not in payload]
    if missing:
        raise validation_error({k: "This field is required." for k in missing})


def _is_text(value):
    return isinstance(value, str) and not any(0xD800 <= ord(char) <= 0xDFFF for char in value)


def _name(value, field="name"):
    if not _is_text(value):
        raise validation_error({field: "Enter a name."})
    cleaned = display_name(value)
    if not cleaned or not normalize_name(cleaned):
        raise validation_error({field: "Enter a name."})
    return cleaned


def _movement_quantity(value, field, *, positive_only=False):
    """Quantity rule for movements (API_CONTRACT section 13).

    A value that is not a JSON integer is a plain VALIDATION_ERROR (wrong type).
    A whole number that is zero, out of range, or (when positive_only) negative
    is INVALID_QUANTITY: the contract reserves that code for "unsupported
    scale, sign, bound, or zero value for a movement".
    """
    if not is_json_integer(value):
        raise validation_error({field: "Must be a whole number (JSON integer)."})
    if value == 0:
        raise ApiErrorQty(f"{field} must not be zero.")
    if abs(value) > MAX_SAFE:
        raise ApiErrorQty(f"{field} is outside the supported range.")
    if positive_only and value < 0:
        raise ApiErrorQty(f"{field} must be positive.")
    return value


def _text_or_null(value, field):
    if value is None:
        return None
    if not _is_text(value):
        raise validation_error({field: "Must be text or null."})
    return display_name(value) or None


# ---- categories ---------------------------------------------------------


def create_category(p):
    _only(p, ("category_id", "name", "description"), ("category_id", "name"))
    out = {"category_id": norm_uuid(p["category_id"], "category_id"), "name": _name(p["name"])}
    out["description"] = _text_or_null(p.get("description"), "description")
    return out


def update_category(p):
    _only(p, ("name", "description"))
    if not p:
        raise validation_error({"payload": "Supply at least one field to change."})
    out = {}
    if "name" in p:
        out["name"] = _name(p["name"])
    if "description" in p:  # explicit null clears; omission leaves unchanged
        out["description"] = _text_or_null(p["description"], "description")
    return out


# ---- items --------------------------------------------------------------


def create_item(p):
    _only(
        p,
        ("item_id", "category_id", "name", "unit_of_measurement", "minimum_stock_level"),
        ("item_id", "category_id", "name", "unit_of_measurement", "minimum_stock_level"),
    )
    scale_for(p["unit_of_measurement"])
    return {
        "item_id": norm_uuid(p["item_id"], "item_id"),
        "category_id": norm_uuid(p["category_id"], "category_id"),
        "name": _name(p["name"]),
        "unit_of_measurement": p["unit_of_measurement"],
        "minimum_stock_level": check_safe(
            p["minimum_stock_level"], "minimum_stock_level", nonnegative=True
        ),
    }


def update_item(p):
    forbidden = {"available_quantity", "stock_status", "is_active", "normalized_name"}
    bad = sorted(forbidden & set(p)) if isinstance(p, dict) else []
    if bad:
        raise validation_error({k: "This value is calculated and cannot be edited." for k in bad})
    _only(p, ("name", "category_id", "minimum_stock_level", "unit_of_measurement"))
    if not p:
        raise validation_error({"payload": "Supply at least one field to change."})
    out = {}
    if "name" in p:
        out["name"] = _name(p["name"])
    if "category_id" in p:
        out["category_id"] = norm_uuid(p["category_id"], "category_id")
    if "minimum_stock_level" in p:
        out["minimum_stock_level"] = check_safe(
            p["minimum_stock_level"], "minimum_stock_level", nonnegative=True
        )
    if "unit_of_measurement" in p:
        scale_for(p["unit_of_measurement"])
        out["unit_of_measurement"] = p["unit_of_measurement"]
    return out


def archive(p):
    _only(p, ())
    return {}


# ---- stock movements ----------------------------------------------------


def record_stock_movement(p):
    _only(
        p,
        (
            "movement_id", "item_id", "movement_type", "quantity_change",
            "reason", "recorded_by", "allocations", "new_batches",
        ),
        ("movement_id", "item_id", "movement_type", "quantity_change", "allocations"),
    )
    mtype = p["movement_type"]
    if mtype not in MOVEMENT_TYPES:
        raise validation_error({"movement_type": "Unknown movement type."})
    qty = _movement_quantity(p["quantity_change"], "quantity_change")
    if mtype in POSITIVE_TYPES and qty < 0:
        raise ApiErrorQty("quantity_change must be positive for this movement type.")
    if mtype in NEGATIVE_TYPES and qty > 0:
        raise ApiErrorQty("quantity_change must be negative for this movement type.")
    reason = _text_or_null(p.get("reason"), "reason")
    if mtype in REASON_REQUIRED and not reason:
        raise validation_error({"reason": "A reason is required for this movement type."})
    if p.get("recorded_by") is not None:
        raise validation_error({"recorded_by": "Staff attribution is not enabled yet."})

    allocs = p["allocations"]
    if not isinstance(allocs, list) or not allocs:
        raise validation_error({"allocations": "Supply at least one allocation."})
    clean_allocs, allocations_by_batch, seen_allocations = [], {}, set()
    for a in allocs:
        _only(a, ("allocation_id", "batch_id", "quantity_change"),
              ("allocation_id", "batch_id", "quantity_change"))
        aq = _movement_quantity(a["quantity_change"], "allocations.quantity_change")
        allocation_id = norm_uuid(a["allocation_id"], "allocations.allocation_id")
        if allocation_id in seen_allocations:
            raise ApiError("RESOURCE_CONFLICT", "An allocation ID appears more than once.", 409)
        seen_allocations.add(allocation_id)
        batch_id = norm_uuid(a["batch_id"], "allocations.batch_id")
        if batch_id in allocations_by_batch:
            raise ApiErrorAlloc("Each batch may appear only once per movement.")
        allocations_by_batch[batch_id] = aq
        clean_allocs.append(
            {"allocation_id": allocation_id,
             "batch_id": batch_id, "quantity_change": aq}
        )
    if sum(a["quantity_change"] for a in clean_allocs) != qty:
        raise ApiErrorAlloc("Allocations must add up to quantity_change.")
    if any((a["quantity_change"] > 0) != (qty > 0) for a in clean_allocs):
        raise ApiErrorAlloc("Allocations must have the same sign as the movement.")

    new_batches = p.get("new_batches", [])
    if not isinstance(new_batches, list):
        raise validation_error({"new_batches": "Must be a list."})
    clean_new, seen_new = [], set()
    for b in new_batches:
        _only(b, ("batch_id", "received_quantity", "purchase_date", "purchase_cost", "expiration_date"),
              ("batch_id", "received_quantity"))
        bid = norm_uuid(b["batch_id"], "new_batches.batch_id")
        if bid in seen_new:
            raise ApiErrorAlloc("Duplicate batch in new_batches.")
        seen_new.add(bid)
        nb = {
            "batch_id": bid,
            "received_quantity": _movement_quantity(
                b["received_quantity"], "received_quantity", positive_only=True),
            "purchase_date": None, "purchase_cost": None, "expiration_date": None,
        }
        if b.get("purchase_date") is not None:
            nb["purchase_date"] = parse_date(b["purchase_date"], "purchase_date").isoformat()
        if b.get("expiration_date") is not None:
            nb["expiration_date"] = parse_date(b["expiration_date"], "expiration_date").isoformat()
        if b.get("purchase_cost") is not None:
            nb["purchase_cost"] = check_safe(b["purchase_cost"], "purchase_cost", nonnegative=True)
        clean_new.append(nb)
    if not seen_new <= allocations_by_batch.keys():
        raise ApiErrorAlloc("Every new batch needs a matching allocation.")
    if mtype not in POSITIVE_TYPES and clean_new:
        raise ApiErrorAlloc("Only incoming movements can create batches.")
    # Positive-type movements may only allocate to batches created by this movement
    # (existing-batch positive adjustments are a pending business rule).
    if mtype in ("initial_stock", "stock_in") and allocations_by_batch.keys() != seen_new:
        raise ApiErrorAlloc("Incoming stock must create its batch in new_batches.")
    for nb in clean_new:
        if allocations_by_batch[nb["batch_id"]] != nb["received_quantity"]:
            raise ApiErrorAlloc("A new batch's allocation must equal its received quantity.")

    out = {
        "movement_id": norm_uuid(p["movement_id"], "movement_id"),
        "item_id": norm_uuid(p["item_id"], "item_id"),
        "movement_type": mtype,
        "quantity_change": qty,
        "reason": reason,
        "recorded_by": None,
        "allocations": sorted(clean_allocs, key=lambda a: a["allocation_id"]),
        "new_batches": sorted(clean_new, key=lambda b: b["batch_id"]),
    }
    return out


def ApiErrorQty(message):
    return ApiError("INVALID_QUANTITY", message, 422)


def ApiErrorAlloc(message):
    return ApiError("INVALID_BATCH_ALLOCATION", message, 422)


VALIDATORS = {
    "create_category": create_category,
    "update_category": update_category,
    "archive_category": archive,
    "create_item": create_item,
    "update_item": update_item,
    "archive_item": archive,
    "record_stock_movement": record_stock_movement,
}


def validate_payload(operation_type, payload):
    if not isinstance(operation_type, str) or operation_type not in VALIDATORS:
        raise validation_error({"operation_type": "Unsupported operation type."})
    return VALIDATORS[operation_type](payload)
