"""Validate inventory and classify acceptance evidence in a single transaction."""
from collections import defaultdict
from dataclasses import dataclass

from sqlalchemy import select

from .core.commands import MOVEMENT_TYPES, POSITIVE_TYPES
from .core.errors import ApiError
from .core.quantities import MAX_SAFE
from .core.timeutil import parse_timestamp
from .db import STOCK_OPERATION, movement_receipt_links
from .models import Allocation, Batch, Category, Item, Movement, ProcessedOperation, ReceiptLedgerHead
from .receipts import ReceiptEvidence, read_receipt


def _quantity(value, *, signed=False):
    minimum = -MAX_SAFE if signed else 0
    return type(value) is int and minimum <= value <= MAX_SAFE


def recovery_required():
    return ApiError("RECOVERY_REQUIRED", "Inventory history requires reconciliation.", 409)


@dataclass
class Inventory:
    categories: list[Category]
    items: list[Item]
    batches: list[Batch]
    movements: list[Movement]
    allocations: list[Allocation]
    item_totals: dict
    batch_totals: dict
    by_movement: dict


@dataclass
class LedgerReview:
    head: ReceiptLedgerHead | None
    receipts: dict[str, ProcessedOperation]
    evidence: dict[str, ReceiptEvidence]
    linked: dict[str, ProcessedOperation]
    state: str

    def order(self, receipt):
        return {
            "commit_seq": receipt.commit_seq if self.state == "verified" else None,
            "replay_status": {"verified": "verified", "provisional": "provisional",
                              "recovery_required": "unverified"}[self.state],
        }

    def movement_order(self, movement):
        receipt = self.linked.get(movement.movement_id)
        if receipt is None:
            return {"commit_seq": None, "replay_status": "unverified"}
        return self.order(receipt)

    def migration(self, movements):
        status = self.state
        total = len(self.receipts)
        return {
            "status": status,
            "verified_receipt_count": total if status == "verified" else 0,
            "verified_legacy_count": 0,
            "provisional_count": total if status == "provisional" else 0,
            "unverified_receipt_count": total if status == "recovery_required" else 0,
            "unassociated_stock_receipt_count": sum(
                receipt.operation_type == STOCK_OPERATION for receipt in self.receipts.values())
                - len(self.linked),
            "unassociated_movement_count": len(movements) - len(self.linked),
            "unverified_movement_count": sum(self.movement_order(movement)["replay_status"] != "verified"
                                             for movement in movements),
        }


def _read_catalog(session, model, order_by):
    # An ORM Boolean would convert any nonzero stored integer to True.
    flag_is_valid = model.is_active.in_((False, True)).label("active_flag_valid")
    rows = session.execute(select(model, flag_is_valid).order_by(order_by))
    catalog = []
    for row, active_flag_valid in rows:
        if active_flag_valid is not True:
            raise recovery_required()
        catalog.append(row)
    return catalog


def read_inventory(session):
    """Read and validate final accounting without assuming historical chronology."""
    categories = _read_catalog(session, Category, Category.category_id)
    items = _read_catalog(session, Item, Item.item_id)
    try:
        batches = list(session.scalars(select(Batch).order_by(Batch.batch_id)))
    except (TypeError, ValueError, OverflowError):
        # SQLAlchemy date parsing can fail on damaged persisted values.
        raise recovery_required() from None
    movements = list(session.scalars(select(Movement).order_by(Movement.created_at, Movement.movement_id)))
    allocations = list(session.scalars(select(Allocation).order_by(Allocation.allocation_id)))

    category_ids = {category.category_id: category.is_active for category in categories}
    item_totals = {item.item_id: 0 for item in items}
    batch_totals = {batch.batch_id: 0 for batch in batches}
    for item in items:
        category_active = category_ids.get(item.category_id)
        if (category_active is None or (item.is_active and not category_active)
                or not _quantity(item.minimum_stock_level)):
            raise recovery_required()
    batches_by_id = {batch.batch_id: batch for batch in batches}
    if any(batch.item_id not in item_totals or not _quantity(batch.received_quantity)
           or not batch.received_quantity
           or (batch.purchase_cost is not None and not _quantity(batch.purchase_cost))
           for batch in batches):
        raise recovery_required()

    by_movement = defaultdict(list)
    movement_totals = {movement.movement_id: 0 for movement in movements}
    movements_by_id = {movement.movement_id: movement for movement in movements}
    pairs = set()
    for allocation in allocations:
        movement = movements_by_id.get(allocation.movement_id)
        batch = batches_by_id.get(allocation.batch_id)
        pair = (allocation.movement_id, allocation.batch_id)
        delta = allocation.quantity_change
        if (movement is None or batch is None or batch.item_id != movement.item_id
                or pair in pairs or not _quantity(delta, signed=True) or not delta
                or not _quantity(movement.quantity_change, signed=True)
                or (delta > 0) != (movement.quantity_change > 0)):
            raise recovery_required()
        pairs.add(pair)
        by_movement[movement.movement_id].append(allocation)
        movement_totals[movement.movement_id] += delta
        batch_totals[batch.batch_id] += delta
    for movement in movements:
        delta = movement.quantity_change
        if (movement.item_id not in item_totals or movement.movement_type not in MOVEMENT_TYPES
                or not _quantity(delta, signed=True) or not delta
                or (delta > 0) != (movement.movement_type in POSITIVE_TYPES)
                or movement_totals[movement.movement_id] != delta):
            raise recovery_required()
        item_totals[movement.item_id] += delta
    for item in items:
        total = item_totals[item.item_id]
        if not _quantity(total) or (not item.is_active and total != 0):
            raise recovery_required()
    if any(not _quantity(total) for total in batch_totals.values()):
        raise recovery_required()
    return Inventory(categories, items, batches, movements, allocations,
                     item_totals, batch_totals, by_movement)


def _same_batch(batch, fields, command):
    return (
        batch is not None
        and batch.item_id == command["payload"]["item_id"]
        and batch.received_quantity == fields["received_quantity"]
        and batch.purchase_cost == fields["purchase_cost"]
        and (batch.purchase_date.isoformat() if batch.purchase_date else None) == fields["purchase_date"]
        and (batch.expiration_date.isoformat() if batch.expiration_date else None) == fields["expiration_date"]
        and parse_timestamp(batch.created_at) == parse_timestamp(command["created_at"])
    )


CATEGORY_FIELDS = ("category_id", "name", "normalized_name", "description",
                   "is_active", "created_at", "updated_at")
ITEM_FIELDS = ("item_id", "name", "normalized_name", "category_id", "unit_of_measurement",
               "minimum_stock_level", "is_active", "created_at", "updated_at")
STOCK_IN_TYPES = ("initial_stock", "stock_in")


def _catalog_facts(result, fields):
    return {field: (parse_timestamp(result[field]) if field.endswith("_at") else result[field])
            for field in fields}


def _current_catalog(rows, fields):
    return {getattr(row, fields[0]): _catalog_facts(
        {field: getattr(row, field) for field in fields}, fields) for row in rows}


def _category_name(facts):
    return facts["normalized_name"]


def _item_key(facts):
    return facts["normalized_name"], facts["category_id"], facts["unit_of_measurement"]


class Catalog:
    """Track candidate catalog facts and index the possible active relationships."""

    def __init__(self, *keys):
        self.facts = {}
        self.indexes = {key: defaultdict(set) for key in keys}

    def put(self, entity_id, options):
        before = self.facts.get(entity_id, ())
        for key, index in self.indexes.items():
            old_keys = {key(facts) for facts in before if facts["is_active"]}
            new_keys = {key(facts) for facts in options if facts["is_active"]}
            for value in old_keys - new_keys:
                index[value].remove(entity_id)
                if not index[value]:
                    del index[value]
            for value in new_keys - old_keys:
                index[value].add(entity_id)
        self.facts[entity_id] = options

    def active(self, entity_id):
        return any(facts["is_active"] for facts in self.facts.get(entity_id, ()))

    def exclude(self, key, value, except_id=None):
        # A known accepted command can rule out a possible legacy boundary
        # fact. Carry that constraint forward without assigning a legacy order.
        for entity_id in self.indexes[key].get(value, set()).copy():
            if entity_id == except_id:
                continue
            options = [facts for facts in self.facts[entity_id]
                       if not facts["is_active"] or key(facts) != value]
            if not options:
                return False
            self.put(entity_id, options)
        return True

    def matches(self, current):
        return self.facts.keys() == current.keys() and all(
            facts in self.facts[entity_id] for entity_id, facts in current.items()
        )


def _item_category(facts):
    return facts["category_id"]


def _legacy_catalog(rows, current, changed, catalog, categories=None):
    """Find possible final facts for each legacy entity, ignoring legacy order."""
    for entity_id, results in rows.items():
        created = results["create"]
        if len(created) != 1:
            return False
        original_time = created[0]["created_at"]
        archived = results["archive"]
        possible = archived or results["update"] or created
        if any(facts["created_at"] != original_time for group in results.values() for facts in group):
            return False
        if archived and any(facts != archived[0] for facts in archived):
            return False
        if entity_id not in changed:
            possible = [facts for facts in possible if facts == current.get(entity_id)]
        if categories is not None:
            if any(facts["category_id"] not in categories.facts
                   for group in results.values() for facts in group):
                return False
            possible = [facts for facts in possible
                        if not facts["is_active"] or categories.active(facts["category_id"])]
        if not possible:
            return False
        catalog.put(entity_id, possible)
    return True


def _catalog_step(catalog, action, entity_id, result, command, *, immutable=()):
    before = catalog.facts.get(entity_id)
    if action == "create":
        return before is None
    if not before:
        return False
    if action == "archive":
        for facts in before:
            if facts["is_active"]:
                expected = {**facts, "is_active": False, "updated_at": parse_timestamp(command["created_at"])}
            else:
                expected = facts
            if result == expected:
                return True
        return False

    changed = (command["payload"].keys() | {"updated_at"}) - set(immutable)
    if "name" in changed:
        changed.add("normalized_name")
    return any(facts["is_active"] and all(
        value == result[field] for field, value in facts.items() if field not in changed
    ) for facts in before)


def _legacy_batches(movements, allocations, batches, items):
    """Use surviving legacy stock effects as boundary facts, without replaying their positions."""
    batch_totals = defaultdict(int)
    origins = set()
    stock_in_origins = set()
    for movement in movements:
        if movement.item_id not in items.facts:
            return None
        for allocation in allocations[movement.movement_id]:
            bid = allocation.batch_id
            batch = batches[bid]
            batch_totals[bid] += allocation.quantity_change
            if movement.movement_type in STOCK_IN_TYPES:
                if bid in stock_in_origins:
                    return None
                stock_in_origins.add(bid)
                if (allocation.quantity_change != batch.received_quantity
                        or parse_timestamp(movement.created_at) != parse_timestamp(batch.created_at)):
                    return None
                origins.add(bid)
            elif (movement.movement_type == "positive_adjustment"
                  and allocation.quantity_change == batch.received_quantity
                  and parse_timestamp(movement.created_at) == parse_timestamp(batch.created_at)):
                # Historical adjustment receipts did not record explicitly
                # whether the target batch was new. This is a possible origin.
                origins.add(bid)
    if batch_totals.keys() != origins or any(not _quantity(total) for total in batch_totals.values()):
        return None
    return dict(batch_totals)


def _verify_timeline(inventory, ordered, evidence, legacy):
    """Replay each evidence-backed command against its state at that commit."""
    categories = Catalog(_category_name)
    items = Catalog(_item_key, _item_category)
    final_categories = _current_catalog(inventory.categories, CATEGORY_FIELDS)
    final_items = _current_catalog(inventory.items, ITEM_FIELDS)
    movements = {movement.movement_id: movement for movement in inventory.movements}
    batches = {batch.batch_id: batch for batch in inventory.batches}
    item_totals = defaultdict(int)
    batch_totals = {}
    used_items = set()
    if legacy:
        historical = {"category": defaultdict(lambda: defaultdict(list)),
                      "item": defaultdict(lambda: defaultdict(list))}
        past_movements = []
        for row in ordered[:legacy]:
            if row.operation_type == STOCK_OPERATION:
                past_movements.append(movements[row.entity_id])
                continue
            action, kind = row.operation_type.split("_")
            fields = CATEGORY_FIELDS if kind == "category" else ITEM_FIELDS
            historical[kind][row.entity_id][action].append(
                _catalog_facts(evidence[row.operation_id].result, fields))
        changed = defaultdict(set)
        for row in ordered[legacy:]:
            if row.operation_type != STOCK_OPERATION:
                changed[row.operation_type.split("_")[1]].add(row.entity_id)
        if (not _legacy_catalog(historical["category"], final_categories, changed["category"], categories)
                or not _legacy_catalog(historical["item"], final_items, changed["item"], items, categories)):
            return False
        batch_totals = _legacy_batches(past_movements, inventory.by_movement, batches, items)
        if batch_totals is None:
            return False
        for movement in past_movements:
            used_items.add(movement.item_id)
            item_totals[movement.item_id] += movement.quantity_change
        if any(not _quantity(total) or (total and not items.active(iid))
               for iid, total in item_totals.items()):
            return False

    for row in ordered[legacy:]:
        saved = evidence[row.operation_id]
        command = saved.command
        if row.operation_type == STOCK_OPERATION:
            movement = movements[row.entity_id]
            iid = movement.item_id
            if not items.active(iid):
                return False
            for fields in command["payload"]["new_batches"]:
                bid = fields["batch_id"]
                if bid in batch_totals or not _same_batch(batches.get(bid), fields, command):
                    return False
                batch_totals[bid] = 0
            for allocation in inventory.by_movement[movement.movement_id]:
                bid = allocation.batch_id
                if bid not in batch_totals:
                    return False
                batch_totals[bid] += allocation.quantity_change
                if not _quantity(batch_totals[bid]):
                    return False
            item_totals[iid] += movement.quantity_change
            if not _quantity(item_totals[iid]):
                return False
            used_items.add(iid)
            continue

        action, kind = row.operation_type.split("_")
        entity_id = row.entity_id
        if kind == "category":
            result = _catalog_facts(saved.result, CATEGORY_FIELDS)
            if not _catalog_step(categories, action, entity_id, result, command):
                return False
            if action == "archive":
                if not items.exclude(_item_category, entity_id):
                    return False
            elif not categories.exclude(_category_name, result["normalized_name"], entity_id):
                return False
            categories.put(entity_id, [result])
        else:
            result = _catalog_facts(saved.result, ITEM_FIELDS)
            immutable = ("unit_of_measurement",) if entity_id in used_items else ()
            if (not _catalog_step(items, action, entity_id, result, command, immutable=immutable)
                    or saved.result["available_quantity"] != item_totals[entity_id]):
                return False
            if result["is_active"]:
                if not categories.active(result["category_id"]) or not items.exclude(
                    _item_key, _item_key(result), entity_id
                ):
                    return False
            items.put(entity_id, [result])

    return (categories.matches(final_categories) and items.matches(final_items)
            and batch_totals == inventory.batch_totals and all(
                item_totals[item_id] == total for item_id, total in inventory.item_totals.items()
            ))


def inspect_ledger(session, inventory):
    """Use the same receipt evidence and replay gate for reads and command delivery."""
    head = session.get(ReceiptLedgerHead, 1)
    receipts = {row.operation_id: row for row in session.scalars(select(ProcessedOperation))}
    evidence = {}
    for row in receipts.values():
        saved = read_receipt(row)
        if saved is not None:
            evidence[row.operation_id] = saved
    linked = movement_receipt_links(receipts.values(), inventory.movements, inventory.allocations)
    review = LedgerReview(head, receipts, evidence, linked, "recovery_required")
    positions = {row.commit_seq for row in receipts.values() if _quantity(row.commit_seq) and row.commit_seq}
    if (head is None or not _quantity(head.committed_seq)
            or len(positions) != len(receipts) or len(receipts) != head.committed_seq
            or max(positions, default=0) != head.committed_seq or len(evidence) != len(receipts)
            or len(linked) != len(inventory.movements)):
        return review
    legacy = head.legacy_through
    if legacy is not None and (not _quantity(legacy) or legacy > head.committed_seq):
        return review

    linked_operations = {row.operation_id for row in linked.values()}
    ordered = sorted(receipts.values(), key=lambda row: row.commit_seq)
    try:
        for row in ordered:
            older = legacy is not None and row.commit_seq <= legacy
            if (older != (evidence[row.operation_id].command is None)
                    or (not older and row.migration_metadata != "verified")
                    or (row.operation_type == STOCK_OPERATION and row.operation_id not in linked_operations)):
                return review
        if _verify_timeline(inventory, ordered, evidence, legacy or 0):
            review.state = "verified" if legacy is None else "provisional"
    except (ApiError, ValueError, TypeError, OverflowError):
        pass
    return review


def require_history(session):
    """Use one transaction to verify every stock-dependent read, retry, and write."""
    inventory = read_inventory(session)
    review = inspect_ledger(session, inventory)
    if review.state == "recovery_required":
        raise recovery_required()
    return inventory, review
