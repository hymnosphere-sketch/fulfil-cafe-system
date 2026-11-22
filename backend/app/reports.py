"""Server report queries (BE-08). They read committed server records only."""
from sqlalchemy import select

from .core import algorithms as alg
from .core.timeutil import business_date
from .models import Batch, Item, Movement
from .services import all_item_views, batch_view, movement_view


def get_settings(session):
    import json
    from .models import Setting
    rows = {s.setting_key: json.loads(s.value) for s in session.scalars(select(Setting))}
    return {
        "settings_version": rows.get("settings_version", 1),
        "business_timezone": rows.get("business_timezone", "Asia/Manila"),
        "expiration_warning_days": rows.get("expiration_warning_days"),
    }


def dated_batches(session, inventory, today, warning_days, category_id=None):
    """Active items' batches with stock left and an expiration date, classified."""
    q = select(Batch, Item).join(Item, Item.item_id == Batch.item_id).where(
        Item.is_active.is_(True), Batch.expiration_date.is_not(None))
    if category_id:
        q = q.where(Item.category_id == category_id)
    out = []
    for batch, item in session.execute(q):
        rem = inventory.batch_totals[batch.batch_id]
        if rem == 0:
            continue
        status = alg.classify_expiry(batch.expiration_date, today, warning_days)
        row = batch_view(batch, rem)
        row["item_name"] = item.name
        row["expiration_status"] = status
        out.append(row)
    out.sort(key=lambda r: (r["expiration_date"], r["batch_id"]))
    return out


def expiration_status(settings, rows_all):
    if settings["expiration_warning_days"] is None:
        return "warning_period_not_configured"
    return "available" if rows_all else "no_dated_stock"


def dashboard(session, inventory, now_fn, category_id, recent_limit):
    settings = get_settings(session)
    today = business_date(now_fn(), settings["business_timezone"])
    items = [i for i in all_item_views(inventory) if i["is_active"]
             and (category_id is None or i["category_id"] == category_id)]
    counts = {"sufficient": 0, "low_stock": 0, "out_of_stock": 0}
    for i in items:
        counts[i["stock_status"]] += 1
    batches = dated_batches(session, inventory, today, settings["expiration_warning_days"], category_id)
    status = expiration_status(settings, batches)
    soon = None
    if status == "available":
        soon = len({b["item_id"] for b in batches if b["expiration_status"] == "expiring_soon"})
    q = select(Movement).join(Item, Item.item_id == Movement.item_id)
    if category_id:
        q = q.where(Item.category_id == category_id)
    q = q.order_by(Movement.created_at.desc(), Movement.movement_id.desc()).limit(recent_limit)
    return {
        "total_active_items": len(items),
        "sufficient_stock_items": counts["sufficient"],
        "low_stock_items": counts["low_stock"],
        "out_of_stock_items": counts["out_of_stock"],
        "expiring_soon_items": soon,
        "expiration_status": status,
        "recent_movements": [movement_view(m, inventory.by_movement[m.movement_id])
                             for m in session.scalars(q)],
    }


def movement_summary(session, item_id, movement_type, start, end):
    q = select(Movement.item_id, Item.unit_of_measurement,
               Movement.movement_type, Movement.quantity_change).join(
                   Item, Item.item_id == Movement.item_id)
    if item_id:
        q = q.where(Movement.item_id == item_id)
    if movement_type:
        q = q.where(Movement.movement_type == movement_type)
    if start:
        q = q.where(Movement.created_at >= start)   # inclusive start
    if end:
        q = q.where(Movement.created_at < end)      # exclusive end
    return alg.aggregate_movements(session.execute(q).mappings())
