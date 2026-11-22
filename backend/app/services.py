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

from .core import algorithms as alg
from .core import commands as cmd
from .core.canonical import PROFILE, build_command, canonical_json, fingerprint, norm_uuid
from .core.errors import ApiError, validation_error
from .core.normalize import normalize_name
from .core.quantities import MAX_SAFE, check_safe
from .core.timeutil import canonical_timestamp
from .models import Allocation, Batch, Category, Item, Movement, ProcessedOperation
from .receipts import acceptance_digest, matches_result
from .replay import recovery_required, require_history


# --------------------------------------------------------------- formatting
def out_ts(stored):
    """Responses show seconds, dropping a '.000' fraction (contract examples)."""
    return stored.replace(".000Z", "Z")


def now_text(now_fn):
    return canonical_timestamp(now_fn())


# ------------------------------------------------------------------- views
def _recorded_movement_quantity(kind, quantity):
    check_safe(quantity, "movement quantity", nonzero=True)
    if kind not in cmd.MOVEMENT_TYPES or (quantity > 0) != (kind in cmd.POSITIVE_TYPES):
        raise validation_error({"movement": "Recorded movement type and quantity disagree."})
    return quantity


def category_view(c):
    return {
        "category_id": c.category_id, "name": c.name, "normalized_name": c.normalized_name,
        "description": c.description, "is_active": c.is_active,
        "created_at": out_ts(c.created_at), "updated_at": out_ts(c.updated_at),
    }


def item_view(it, balance):
    return {
        "item_id": it.item_id, "category_id": it.category_id, "name": it.name,
        "normalized_name": it.normalized_name,
        "unit_of_measurement": it.unit_of_measurement,
        "minimum_stock_level": it.minimum_stock_level, "is_active": it.is_active,
        "created_at": out_ts(it.created_at), "updated_at": out_ts(it.updated_at),
        "available_quantity": balance,
        "stock_status": alg.classify_stock(balance, it.minimum_stock_level),
    }


def all_item_views(inventory):
    return [item_view(item, inventory.item_totals[item.item_id]) for item in inventory.items]


def batch_view(b, remaining):
    cost = b.purchase_cost
    return {
        "batch_id": b.batch_id, "item_id": b.item_id,
        "received_quantity": check_safe(b.received_quantity, "received quantity",
                                        nonnegative=True, nonzero=True),
        "purchase_date": b.purchase_date.isoformat() if b.purchase_date else None,
        "purchase_cost": None if cost is None else check_safe(cost, "purchase cost", nonnegative=True),
        "expiration_date": b.expiration_date.isoformat() if b.expiration_date else None,
        "created_at": out_ts(b.created_at),
        "remaining_quantity": check_safe(remaining, "batch balance", nonnegative=True),
    }


def movement_view(m, allocations):
    quantity = _recorded_movement_quantity(m.movement_type, m.quantity_change)
    rows = [
        {"allocation_id": allocation.allocation_id, "batch_id": allocation.batch_id,
         "quantity_change": check_safe(allocation.quantity_change, "allocation quantity", nonzero=True)}
        for allocation in allocations
    ]
    if (sum(row["quantity_change"] for row in rows) != quantity
            or any((row["quantity_change"] > 0) != (quantity > 0) for row in rows)):
        raise validation_error({"allocations": "Recorded allocations do not match the movement."})
    return {
        "movement_id": m.movement_id, "item_id": m.item_id,
        "movement_type": m.movement_type, "quantity_change": quantity,
        "reason": m.reason, "recorded_by": m.recorded_by,
        "created_at": out_ts(m.created_at),
        "allocations": rows,
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
def _create_category(session, entity_id, created, p, _inventory):
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


def _update_category(session, entity_id, created, p, _inventory):
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


def _archive_category(session, entity_id, created, p, _inventory):
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


def _create_item(session, entity_id, created, p, _inventory):
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
    return item_view(it, 0)


def _update_item(session, entity_id, created, p, inventory):
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
    return item_view(it, inventory.item_totals[entity_id])


def _archive_item(session, entity_id, created, p, inventory):
    it = get_item(session, entity_id)
    if not it.is_active:
        return item_view(it, inventory.item_totals[entity_id])
    if inventory.item_totals[entity_id] != 0:
        raise _conflict("Stock remains; account for it with a stock movement first.",
                        "ITEM_HAS_STOCK")
    it.is_active, it.updated_at = False, created
    session.flush()
    return item_view(it, inventory.item_totals[entity_id])


def _record_movement(session, entity_id, created, p, inventory):
    if p["movement_id"] != entity_id:
        raise validation_error({"entity_id": "Must match movement_id."})
    item = get_item(session, p["item_id"])
    if not item.is_active:
        raise _conflict("The item is archived.")
    if session.get(Movement, entity_id):
        raise _conflict("A movement with this ID already exists.")

    # BEGIN IMMEDIATE held by the caller serializes these reads with all writes.
    balance_before = inventory.item_totals[item.item_id]
    new_batches = {batch["batch_id"]: batch for batch in p["new_batches"]}
    for batch_id in new_batches:
        if session.get(Batch, batch_id):
            raise _conflict("A batch with this ID already exists.")

    allocations = []
    for allocation in p["allocations"]:
        allocation_id = allocation["allocation_id"]
        batch_id = allocation["batch_id"]
        quantity = allocation["quantity_change"]
        if session.get(Allocation, allocation_id):
            raise _conflict("An allocation with this ID already exists.")
        if batch_id not in new_batches:
            batch = session.get(Batch, batch_id)
            if batch is None or batch.item_id != item.item_id:
                raise ApiError("INVALID_BATCH_ALLOCATION",
                               "The batch does not exist for this item.", 422)
        proposed = inventory.batch_totals.get(batch_id, 0) + quantity
        if proposed < 0:
            raise ApiError(
                "INSUFFICIENT_STOCK", "The recorded stock is too low for this withdrawal.",
                422, {"available_quantity": balance_before})
        check_safe(proposed, "resulting batch balance", nonnegative=True)
        allocations.append(Allocation(allocation_id=allocation_id, movement_id=entity_id,
                                      batch_id=batch_id, quantity_change=quantity))
    check_safe(balance_before + p["quantity_change"], "resulting item balance", nonnegative=True)

    for batch_id, batch in new_batches.items():
        session.add(Batch(
            batch_id=batch_id, item_id=item.item_id, received_quantity=batch["received_quantity"],
            purchase_date=date.fromisoformat(batch["purchase_date"]) if batch["purchase_date"] else None,
            purchase_cost=batch["purchase_cost"],
            expiration_date=date.fromisoformat(batch["expiration_date"]) if batch["expiration_date"] else None,
            created_at=created))
    movement = Movement(movement_id=entity_id, item_id=item.item_id,
                        movement_type=p["movement_type"], quantity_change=p["quantity_change"],
                        reason=p["reason"], recorded_by=None, created_at=created)
    session.add(movement)
    session.flush()

    # The canonical command validator already matched receipt quantity and
    # allocation for each new batch, and matched allocations to the movement.
    session.add_all(allocations)
    session.flush()
    return movement_view(movement, allocations)


HANDLERS = {
    "create_category": _create_category, "update_category": _update_category,
    "archive_category": _archive_category, "create_item": _create_item,
    "update_item": _update_item, "archive_item": _archive_item,
    "record_stock_movement": _record_movement,
}


# --------------------------------------------------------------- processor
def _receipt_response(receipt, review, fp, command):
    if receipt.request_fingerprint != fp:
        raise _conflict("This operation ID was already used for a different command.",
                        "OPERATION_ID_CONFLICT", {"operation_id": receipt.operation_id,
                                                  "outcome": "rejected"})
    result = review.evidence[receipt.operation_id].result
    if (receipt.operation_type != command["operation_type"]
            or not matches_result(receipt.operation_type, command["entity_id"], result, command)):
        raise recovery_required()
    return {"operation_id": receipt.operation_id, "outcome": "already_processed",
            "processed_at": out_ts(receipt.processed_at), "result": result, **review.order(receipt)}


def process_command(session, now_fn, *, operation_id, operation_type, entity_id,
                    created_at, payload):
    """Validate, apply once, and advance the receipt ledger in one transaction."""
    operation_id = norm_uuid(operation_id, "operation_id")
    clean = cmd.validate_payload(operation_type, payload)
    command = build_command(operation_type, entity_id, created_at, clean)
    fp = fingerprint(command)

    # BEGIN IMMEDIATE keeps the shared replay gate, receipt lookup, and the
    # ledger advance consistent across competing writers and restarts.
    inventory, review = require_history(session)
    receipt = review.receipts.get(operation_id)
    if receipt is not None:
        return _receipt_response(receipt, review, fp, command)
    head = review.head
    if head.committed_seq == MAX_SAFE:
        raise recovery_required()

    result = HANDLERS[operation_type](session, command["entity_id"], command["created_at"], clean, inventory)
    if not matches_result(operation_type, command["entity_id"], result, command):
        raise RuntimeError("A new receipt failed result validation.")
    processed_at = now_text(now_fn)
    receipt = ProcessedOperation(
        operation_id=operation_id, operation_type=operation_type,
        entity_id=command["entity_id"], request_fingerprint=fp, fingerprint_profile=PROFILE,
        processed_at=processed_at, processing_result=json.dumps(result),
        commit_seq=head.committed_seq + 1, migration_metadata="verified",
        acceptance_command=canonical_json(command),
    )
    receipt.acceptance_digest = acceptance_digest(receipt)
    head.committed_seq = receipt.commit_seq
    session.add(receipt)
    session.flush()
    return {"operation_id": operation_id, "outcome": "accepted",
            "processed_at": out_ts(processed_at), "result": result, **review.order(receipt)}
