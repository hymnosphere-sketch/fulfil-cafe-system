"""Inventory algorithms (BE-05). Pure functions: no database, no Flask.

Each function documents its input, output and cost so it can be explained
in the project defense. They mirror DATABASE_DESIGN section 5 and are meant
to give the same answers as the frontend JavaScript for the same inputs.
"""
from .normalize import normalize_name

OUT_OF_STOCK = "out_of_stock"
LOW_STOCK = "low_stock"
SUFFICIENT = "sufficient"


def classify_stock(balance, minimum):
    """O(1). 0 -> out of stock; 0 < balance <= minimum -> low; else sufficient."""
    if balance == 0:
        return OUT_OF_STOCK
    if balance <= minimum:
        return LOW_STOCK
    return SUFFICIENT


def sum_quantities(changes):
    """O(k). Balance of an item or batch from its signed changes."""
    return sum(changes)


def classify_expiry(expiration_date, today, warning_days):
    """O(1). Returns 'expired', 'expiring_soon' or None.

    Before today -> expired. Today through today+warning_days (inclusive) ->
    expiring soon. With no warning period configured, already-expired stock is
    still flagged but nothing is ever 'expiring soon'. Undated -> None.
    """
    if expiration_date is None:
        return None
    if expiration_date < today:
        return "expired"
    if warning_days is None:
        return None
    from datetime import timedelta

    if expiration_date <= today + timedelta(days=warning_days):
        return "expiring_soon"
    return None


def find_duplicates(draft_name, items, exclude_id=None):
    """O(n). Items whose normalized name equals the draft's normalized name.

    A match is only a *candidate*: the caller decides (category, unit, ...)
    whether it is a real conflict. Nothing is merged automatically.
    """
    target = normalize_name(draft_name)
    return [
        it
        for it in items
        if it["normalized_name"] == target and it["item_id"] != exclude_id
    ]


def search_items(items, query):
    """O(n). Normalized substring match, or an exact item id."""
    term = normalize_name(query)
    return [
        it
        for it in items
        if term in it["normalized_name"] or it["item_id"] == query.strip().lower()
    ]


def sort_items(items, key, descending=False):
    """O(n log n). Stable ordering with deterministic tie-breakers.

    'name'    -> normalized name, then id.
    'quantity'-> grouped by unit id first (unlike units are never compared),
                 then by quantity, normalized name, id.
    """
    if key == "name":
        ordered = sorted(items, key=lambda i: (i["normalized_name"], i["item_id"]))
    elif key == "available_quantity":
        ordered = sorted(
            items,
            key=lambda i: (
                i["unit_of_measurement"],
                i["available_quantity"],
                i["normalized_name"],
                i["item_id"],
            ),
        )
    else:
        raise ValueError(f"unknown sort key {key!r}")
    return list(reversed(ordered)) if descending else ordered


def restocking_order(items):
    """O(n log n). Out-of-stock first, then low-stock, then name and id."""
    rank = {OUT_OF_STOCK: 0, LOW_STOCK: 1}
    candidates = [i for i in items if i["stock_status"] in rank]
    return sorted(
        candidates,
        key=lambda i: (rank[i["stock_status"]], i["normalized_name"], i["item_id"]),
    )


def aggregate_movements(rows):
    """O(m). Group (item, unit, type) -> count and signed total.

    Unlike units are never combined because the unit is part of the key.
    """
    groups = {}
    for r in rows:
        k = (r["item_id"], r["unit_of_measurement"], r["movement_type"])
        g = groups.setdefault(k, {"movement_count": 0, "total_quantity_change": 0})
        g["movement_count"] += 1
        g["total_quantity_change"] += r["quantity_change"]
    return [
        {
            "item_id": k[0],
            "unit_of_measurement": k[1],
            "movement_type": k[2],
            **groups[k],
        }
        for k in sorted(groups)
    ]
