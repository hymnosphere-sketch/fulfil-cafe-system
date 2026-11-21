"""Business services (BE-03, BE-04, BE-07).

`process_command` is the ONE entry point used by both POST /api/v1/sync and
the direct mutation routes. It:
  1. validates the payload shape and builds the canonical command,
  2. looks for an existing receipt (replay -> original result, conflict -> 409),
  3. applies the change and writes the receipt in the same transaction.
The caller owns the transaction (see db.session_scope), so a failure at any
step rolls back every partial write.
"""
import json
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from .core import algorithms as alg
from .core import commands as cmd
from .core.canonical import PROFILE, build_command, fingerprint, norm_uuid
from .core.errors import ApiError, validation_error
from .core.normalize import normalize_name
from .core.timeutil import canonical_timestamp, parse_timestamp, utc_now
from .models import (Allocation, Batch, Category, Item, Movement,
                     ProcessedOperation, Setting)


# --------------------------------------------------------------- formatting
def out_ts(stored):
    """Responses show seconds, dropping a '.000' fraction (contract examples)."""
    return stored.replace(".000Z", "Z")


def now_text(now_fn):
    return canonical_timestamp(now_fn())


def _next_commit_seq(session):
    """Get the next commit sequence number (monotonically increasing)."""
    from sqlalchemy import func
    from .models import ProcessedOperation
    max_seq = session.scalar(select(func.coalesce(func.max(ProcessedOperation.commit_seq), 0)))
    return max_seq + 1


# ------------------------------------------------------------------- views
def _check_balance_safe(balance, context):
    from .core.algorithms import MAX_SAFE
    if balance < -MAX_SAFE or balance > MAX_SAFE:
        raise ApiError("VALIDATION_ERROR", f"The {context} is outside the supported range.", 422)


def item_balance(session, item_id):
    q = select(func.coalesce(func.sum(Movement.quantity_change), 0)).where(
        Movement.item_id == item_id)
    balance = int(session.scalar(q))
    _check_balance_safe(balance, "item balance")
    return balance


def batch_remaining(session, batch_id):
    q = select(func.coalesce(func.sum(Allocation.quantity_change), 0)).where(
        Allocation.batch_id == batch_id)
    remaining = int(session.scalar(q))
    _check_balance_safe(remaining, "batch balance")
    return remaining


def category_view(c):
    return {
        "category_id": c.category_id, "name": c.name, "normalized_name": c.normalized_name,
        "description": c.description, "is_active": c.is_active,
        "created_at": out_ts(c.created_at), "updated_at": out_ts(c.updated_at),
    }


def item_view(session, it, balance=None):
    bal = item_balance(session, it.item_id) if balance is None else balance
    return {
        "item_id": it.item_id, "category_id": it.category_id, "name": it.name,
        "normalized_name": it.normalized_name,
        "unit_of_measurement": it.unit_of_measurement,
        "minimum_stock_level": it.minimum_stock_level, "is_active": it.is_active,
        "created_at": out_ts(it.created_at), "updated_at": out_ts(it.updated_at),
        "available_quantity": bal,
        "stock_status": alg.classify_stock(bal, it.minimum_stock_level),
    }


def all_item_views(session):
    """One grouped query for every balance instead of one query per item."""
    sums = dict(session.execute(
        select(Movement.item_id, func.sum(Movement.quantity_change))
        .group_by(Movement.item_id)).all())
    items = session.scalars(select(Item)).all()
    return [item_view(session, i, int(sums.get(i.item_id, 0))) for i in items]


def batch_view(session, b, remaining=None):
    rem = batch_remaining(session, b.batch_id) if remaining is None else remaining
    return {
        "batch_id": b.batch_id, "item_id": b.item_id,
        "received_quantity": b.received_quantity,
        "purchase_date": b.purchase_date.isoformat() if b.purchase_date else None,
        "purchase_cost": b.purchase_cost,
        "expiration_date": b.expiration_date.isoformat() if b.expiration_date else None,
        "created_at": out_ts(b.created_at), "remaining_quantity": rem,
    }


def movement_view(session, m):
    allocs = session.scalars(
        select(Allocation).where(Allocation.movement_id == m.movement_id)
        .order_by(Allocation.allocation_id)).all()
    return {
        "movement_id": m.movement_id, "item_id": m.item_id,
        "movement_type": m.movement_type, "quantity_change": m.quantity_change,
        "reason": m.reason, "recorded_by": m.recorded_by,
        "created_at": out_ts(m.created_at),
        "allocations": [{"allocation_id": a.allocation_id, "batch_id": a.batch_id,
                         "quantity_change": a.quantity_change} for a in allocs],
    }


# ---------------------------------------------------------------- lookups
def get_category(session, category_id):
    c = session.get(Category, category_id)
    if c is None:
        raise ApiError("CATEGORY_NOT_FOUND", "The category was not found.", 404)
    return c


def get_item(session, item_id):
    it = session.get(Item, item_id)
    if it is None:
        raise ApiError("ITEM_NOT_FOUND", "The item was not found.", 404)
    return it


def _conflict(message, code="RESOURCE_CONFLICT", details=None):
    return ApiError(code, message, 409, details)


# ----------------------------------------------------------- command handlers
def _create_category(session, entity_id, created, p):
    if p["category_id"] != entity_id:
        raise validation_error({"entity_id": "Must match category_id."})
    if session.get(Category, entity_id):
        raise _conflict("A category with this ID already exists.")
    norm = normalize_name(p["name"])
    dup = session.scalar(select(Category).where(
        Category.normalized_name == norm, Category.is_active.is_(True)))
    if dup:
        raise _conflict("A category with this name already exists.", "DUPLICATE_CATEGORY")
    c = Category(category_id=entity_id, name=p["name"], normalized_name=norm,
                 description=p.get("description"), is_active=True,
                 created_at=created, updated_at=created)
    session.add(c)
    session.flush()
    return category_view(c)


def _update_category(session, entity_id, created, p):
    c = get_category(session, entity_id)
    if not c.is_active:
        raise _conflict("The category is archived.")
    if "name" in p:
        norm = normalize_name(p["name"])
        dup = session.scalar(select(Category).where(
            Category.normalized_name == norm, Category.is_active.is_(True),
            Category.category_id != entity_id))
        if dup:
            raise _conflict("A category with this name already exists.", "DUPLICATE_CATEGORY")
        c.name, c.normalized_name = p["name"], norm
    if "description" in p:
        c.description = p["description"]
    c.updated_at = created
    session.flush()
    return category_view(c)


def _archive_category(session, entity_id, created, p):
    c = get_category(session, entity_id)
    if not c.is_active:
        return category_view(c)  # re-archiving returns the current state
    in_use = session.scalar(select(func.count()).select_from(Item).where(
        Item.category_id == entity_id, Item.is_active.is_(True)))
    if in_use:
        raise _conflict("Active items still use this category.", "CATEGORY_IN_USE")
    c.is_active, c.updated_at = False, created
    session.flush()
    return category_view(c)


def _check_item_duplicate(session, norm, category_id, unit, exclude_id=None):
    """Proposed rule (open decision): same name + category + unit among active items."""
    q = select(Item).where(Item.normalized_name == norm, Item.category_id == category_id,
                           Item.unit_of_measurement == unit, Item.is_active.is_(True))
    if exclude_id:
        q = q.where(Item.item_id != exclude_id)
    if session.scalar(q):
        raise _conflict("An item with this name, category and unit already exists.",
                        "DUPLICATE_ITEM")


def _usable_category(session, category_id):
    c = get_category(session, category_id)
    if not c.is_active:
        raise _conflict("The category is archived.")
    return c


def _create_item(session, entity_id, created, p):
    if p["item_id"] != entity_id:
        raise validation_error({"entity_id": "Must match item_id."})
    _usable_category(session, p["category_id"])
    if session.get(Item, entity_id):
        raise _conflict("An item with this ID already exists.")
    norm = normalize_name(p["name"])
    _check_item_duplicate(session, norm, p["category_id"], p["unit_of_measurement"])
    it = Item(item_id=entity_id, category_id=p["category_id"], name=p["name"],
              normalized_name=norm, unit_of_measurement=p["unit_of_measurement"],
              minimum_stock_level=p["minimum_stock_level"], is_active=True,
              created_at=created, updated_at=created)
    session.add(it)
    session.flush()
    return item_view(session, it, 0)


def _update_item(session, entity_id, created, p):
    it = get_item(session, entity_id)
    if not it.is_active:
        raise _conflict("The item is archived.")
    if "category_id" in p:
        _usable_category(session, p["category_id"])
    if "unit_of_measurement" in p and p["unit_of_measurement"] != it.unit_of_measurement:
        used = session.scalar(select(func.count()).select_from(Movement)
                              .where(Movement.item_id == entity_id))
        if used:
            raise validation_error(
                {"unit_of_measurement": "The unit cannot change after stock was recorded."})
    name = p.get("name", it.name)
    category_id = p.get("category_id", it.category_id)
    unit = p.get("unit_of_measurement", it.unit_of_measurement)
    norm = normalize_name(name)
    _check_item_duplicate(session, norm, category_id, unit, exclude_id=entity_id)
    it.name, it.normalized_name, it.category_id, it.unit_of_measurement = name, norm, category_id, unit
    if "minimum_stock_level" in p:
        it.minimum_stock_level = p["minimum_stock_level"]
    it.updated_at = created
    session.flush()
    return item_view(session, it)


def _archive_item(session, entity_id, created, p):
    it = get_item(session, entity_id)
    if not it.is_active:
        return item_view(session, it)
    if item_balance(session, entity_id) != 0:
        raise _conflict("Stock remains; account for it with a stock movement first.",
                        "ITEM_HAS_STOCK")
    it.is_active, it.updated_at = False, created
    session.flush()
    return item_view(session, it)


def _record_movement(session, entity_id, created, p):
    if p["movement_id"] != entity_id:
        raise validation_error({"entity_id": "Must match movement_id."})
    it = get_item(session, p["item_id"])
    if not it.is_active:
        raise _conflict("The item is archived.")
    if session.get(Movement, entity_id):
        raise _conflict("A movement with this ID already exists.")

    # Balance before this command touches anything. INSUFFICIENT_STOCK reports
    # this number (API_CONTRACT example F), not the half-applied balance.
    balance_before = item_balance(session, it.item_id)

    # Create the batches this movement introduces (received stock / opening stock).
    new_ids = set()
    for nb in p["new_batches"]:
        if session.get(Batch, nb["batch_id"]):
            raise _conflict("A batch with this ID already exists.")
        session.add(Batch(
            batch_id=nb["batch_id"], item_id=it.item_id,
            received_quantity=nb["received_quantity"],
            purchase_date=date.fromisoformat(nb["purchase_date"]) if nb["purchase_date"] else None,
            purchase_cost=nb["purchase_cost"],
            expiration_date=date.fromisoformat(nb["expiration_date"]) if nb["expiration_date"] else None,
            created_at=created))
        new_ids.add(nb["batch_id"])
    session.flush()

    session.add(Movement(movement_id=entity_id, item_id=it.item_id,
                         movement_type=p["movement_type"], quantity_change=p["quantity_change"],
                         reason=p["reason"], recorded_by=None, created_at=created))
    session.flush()

    for a in p["allocations"]:
        if session.get(Allocation, a["allocation_id"]):
            raise _conflict("An allocation with this ID already exists.")
        batch = session.get(Batch, a["batch_id"])
        if batch is None or batch.item_id != it.item_id:
            raise ApiError("INVALID_BATCH_ALLOCATION",
                           "The batch does not exist for this item.", 422)
        if a["quantity_change"] < 0:
            # Per-batch check: a batch can never go below zero. Because an
            # item's balance is the sum of its batches, this also keeps the
            # item balance from going negative.
            remaining = batch_remaining(session, a["batch_id"])
            if remaining + a["quantity_change"] < 0:
                raise ApiError(
                    "INSUFFICIENT_STOCK", "The recorded stock is too low for this withdrawal.",
                    422, {"available_quantity": balance_before})
        session.add(Allocation(allocation_id=a["allocation_id"], movement_id=entity_id,
                               batch_id=a["batch_id"], quantity_change=a["quantity_change"]))
        session.flush()

    # Safety net: a new batch must end up holding exactly what it received.
    for bid in new_ids:
        if batch_remaining(session, bid) != session.get(Batch, bid).received_quantity:
            raise ApiError("INVALID_BATCH_ALLOCATION",
                           "A new batch must be allocated exactly its received quantity.", 422)

    # Validate resulting item balance is within safe integer range
    item_bal = item_balance(session, it.item_id)
    from .core.algorithms import MAX_SAFE
    if item_bal < -MAX_SAFE or item_bal > MAX_SAFE:
        raise ApiError("VALIDATION_ERROR",
                       "The resulting item balance is outside the supported range.", 422)

    # Validate all batch balances for this item are within safe integer range
    from sqlalchemy import select as sql_select
    batch_ids = session.scalars(sql_select(Batch.batch_id).where(Batch.item_id == it.item_id)).all()
    for bid in batch_ids:
        batch_bal = batch_remaining(session, bid)
        if batch_bal < -MAX_SAFE or batch_bal > MAX_SAFE:
            raise ApiError("VALIDATION_ERROR",
                           "A resulting batch balance is outside the supported range.", 422)

    session.flush()
    return movement_view(session, session.get(Movement, entity_id))


HANDLERS = {
    "create_category": _create_category, "update_category": _update_category,
    "archive_category": _archive_category, "create_item": _create_item,
    "update_item": _update_item, "archive_item": _archive_item,
    "record_stock_movement": _record_movement,
}


# --------------------------------------------------------------- processor
def _receipt_response(receipt, fp):
    if receipt.request_fingerprint != fp:
        raise _conflict("This operation ID was already used for a different command.",
                        "OPERATION_ID_CONFLICT", {"operation_id": receipt.operation_id,
                                                  "outcome": "rejected"})
    return {"operation_id": receipt.operation_id, "outcome": "already_processed",
            "processed_at": out_ts(receipt.processed_at),
            "result": json.loads(receipt.processing_result),
            "commit_seq": receipt.commit_seq}


def process_command(session, now_fn, *, operation_id, operation_type, entity_id,
                    created_at, payload):
    """Validate, apply once, record a receipt. Returns the sync result dict."""
    operation_id = norm_uuid(operation_id, "operation_id")
    clean = cmd.validate_payload(operation_type, payload)
    command = build_command(operation_type, entity_id, created_at, clean)
    fp = fingerprint(command)

    receipt = session.get(ProcessedOperation, operation_id)
    if receipt:
        return _receipt_response(receipt, fp)

    created = command["created_at"]
    result = HANDLERS[operation_type](session, command["entity_id"], created, clean)
    processed_at = now_text(now_fn)
    commit_seq = _next_commit_seq(session)
    session.add(ProcessedOperation(
        operation_id=operation_id, operation_type=operation_type,
        entity_id=entity_id,  # durable association: movement_id, item_id, or category_id
        request_fingerprint=fp, fingerprint_profile=PROFILE,
        processed_at=processed_at, processing_result=json.dumps(result),
        commit_seq=commit_seq))
    try:
        session.flush()
    except IntegrityError:
        # A concurrent delivery of the same operation won the race.
        session.rollback()
        receipt = session.get(ProcessedOperation, operation_id)
        if receipt is None:
            raise
        return _receipt_response(receipt, fp)
    return {"operation_id": operation_id, "outcome": "accepted",
            "processed_at": out_ts(processed_at), "result": result, "commit_seq": commit_seq}
