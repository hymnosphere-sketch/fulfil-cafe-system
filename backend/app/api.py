"""Flask routes under /api/v1 (BE-06). Thin: parse, call a service, wrap.

Every route returns the JSON envelope from API_CONTRACT section 3.
"""
import json

from flask import Blueprint, current_app, g, jsonify, request
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

from . import reports
from .core import algorithms as alg
from .core import commands as cmd
from .core.canonical import norm_uuid, parse_json_strict
from .core.errors import ApiError, invalid_request, validation_error
from .core.quantities import MAX_SAFE, is_json_integer
from .core.timeutil import canonical_timestamp, parse_timestamp
from .db import session_scope
from .models import (Allocation, Batch, Category, Item, Movement, ProcessedOperation)
from . import services as svc

bp = Blueprint("api", __name__, url_prefix="/api/v1")


# ------------------------------------------------------------------ helpers
def ok(data, status=200, meta=None):
    body = {"success": True, "data": data}
    if meta is not None:
        body["meta"] = meta
    return jsonify(body), status


def scope(write=False):
    """Read-only by default. Mutation routes ask for write=True explicitly."""
    return session_scope(current_app.extensions["session_factory"], write=write)


def now_fn():
    return current_app.config["NOW"]()


def body_object():
    raw = request.get_data()
    if not raw:
        raise invalid_request("A JSON body is required.")
    data = parse_json_strict(raw)
    if not isinstance(data, dict):
        raise invalid_request("The JSON body must be an object.")
    return data


def path_uuid(value, field):
    try:
        return norm_uuid(value, field)
    except ApiError:
        raise invalid_request("The identifier in the path is not a valid UUID.")


def query_uuid(name):
    v = request.args.get(name)
    if v is None:
        return None
    try:
        return norm_uuid(v, name)
    except ApiError:
        raise invalid_request(f"{name} must be a valid UUID.")


def paginate(rows):
    def pos_int(name, default, maximum=None):
        raw = request.args.get(name)
        if raw is None:
            return default
        if not raw.isdigit() or int(raw) < 1 or (maximum and int(raw) > maximum):
            raise invalid_request(f"{name} must be a positive whole number.")
        return int(raw)

    page, size = pos_int("page", 1), pos_int("page_size", 25, 100)
    start = (page - 1) * size
    return rows[start:start + size], {"page": page, "page_size": size, "total": len(rows)}


def one_of(name, allowed, default):
    v = request.args.get(name, default)
    if v not in allowed:
        raise invalid_request(f"{name} must be one of: {', '.join(allowed)}.")
    return v


def bool_arg(name, default):
    return one_of(name, ("true", "false"), default) == "true"


def ts_arg(name):
    v = request.args.get(name)
    if v is None:
        return None
    try:
        return canonical_timestamp(parse_timestamp(v, name))
    except ApiError:
        raise invalid_request(f"{name} must be a UTC timestamp like 2026-11-18T00:00:00Z.")


def check_generation(session):
    """Mutations must carry the server generation id (API_CONTRACT section 2)."""
    if not current_app.config["REQUIRE_GENERATION"]:
        return
    sent = request.headers.get("X-Inventory-Generation")
    try:
        sent = norm_uuid(sent, "X-Inventory-Generation")
    except ApiError:
        raise invalid_request("X-Inventory-Generation header is missing or malformed.")
    if sent != current_generation(session):
        raise ApiError("RECOVERY_REQUIRED",
                       "The server generation changed. Keep local work and wait for review.", 409)


def current_generation(session):
    from .models import Setting
    row = session.get(Setting, "server_generation_id")
    return json.loads(row.value)


# ------------------------------------------------------------- error handling
@bp.app_errorhandler(ApiError)
def handle_api_error(e):
    return jsonify({"success": False, "error": {
        "code": e.code, "message": e.message, "details": e.details}}), e.status


@bp.app_errorhandler(404)
def handle_404(_e):
    return jsonify({"success": False, "error": {
        "code": "INVALID_REQUEST", "message": "No such route.", "details": {}}}), 404


@bp.app_errorhandler(405)
def handle_405(_e):
    return jsonify({"success": False, "error": {
        "code": "INVALID_REQUEST", "message": "Method not allowed.", "details": {}}}), 405


@bp.app_errorhandler(OperationalError)
def handle_database_unavailable(e):
    """Locked or unreachable database: temporary, so the client keeps the
    operation pending and retries the same command (API_CONTRACT sections 9, 13).
    The raw database message stays in the log, never in the response."""
    current_app.logger.warning("Database temporarily unavailable: %s", e.__class__.__name__)
    resp = jsonify({"success": False, "error": {
        "code": "SYNC_FAILED",
        "message": "The service is temporarily unavailable. Keep the operation pending and retry.",
        "details": {}}})
    resp.status_code = 503
    resp.headers["Retry-After"] = "2"
    return resp


@bp.app_errorhandler(Exception)
def handle_unexpected(e):
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):  # e.g. 413, 415: keep the real status
        return jsonify({"success": False, "error": {
            "code": "INVALID_REQUEST", "message": e.description or "Bad request.",
            "details": {}}}), e.code
    current_app.logger.exception("Unhandled error")  # stack trace stays in the log only
    return jsonify({"success": False, "error": {
        "code": "SERVER_ERROR", "message": "An unexpected server problem occurred.",
        "details": {}}}), 500


@bp.after_request
def add_headers(resp):
    resp.headers["Cache-Control"] = "no-store"
    origin = request.headers.get("Origin")
    if origin and origin in current_app.config["CORS_ORIGINS"]:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Headers"] = (
            "Content-Type, Accept, X-Inventory-Generation, Retry-After")
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS"
        resp.headers["Access-Control-Expose-Headers"] = (
            "X-Inventory-Generation, X-Inventory-Settings-Version, Retry-After")
    if "generation" in g:
        resp.headers["X-Inventory-Generation"] = g.generation
        resp.headers["X-Inventory-Settings-Version"] = str(g.settings_version)
    return resp


@bp.before_request
def load_headers_info():
    with scope() as s:
        g.generation = current_generation(s)
        g.settings_version = reports.get_settings(s)["settings_version"]


# ---------------------------------------------------------------- mutations
def direct_mutation(operation_type, entity_id, status_on_new):
    """Direct routes build the same command as /sync and use the same service."""
    data = body_object()
    for field in ("operation_id", "created_at"):
        if field not in data:
            raise validation_error({field: "This field is required."})
    operation_id, created_at = data.pop("operation_id"), data.pop("created_at")
    with scope(write=True) as s:
        check_generation(s)
        res = svc.process_command(
            s, now_fn, operation_id=operation_id, operation_type=operation_type,
            entity_id=entity_id if entity_id else data.get(ENTITY_FIELD[operation_type]),
            created_at=created_at, payload=data)
    status = status_on_new if res["outcome"] == "accepted" else 200
    return ok(res["result"], status)


ENTITY_FIELD = {"create_category": "category_id", "create_item": "item_id",
                "record_stock_movement": "movement_id"}


@bp.post("/inventory")
def create_item():
    return direct_mutation("create_item", None, 201)


@bp.patch("/inventory/<item_id>")
def update_item(item_id):
    return direct_mutation("update_item", path_uuid(item_id, "item_id"), 200)


@bp.post("/inventory/<item_id>/archive")
def archive_item(item_id):
    return direct_mutation("archive_item", path_uuid(item_id, "item_id"), 200)


@bp.post("/categories")
def create_category():
    return direct_mutation("create_category", None, 201)


@bp.patch("/categories/<category_id>")
def update_category(category_id):
    return direct_mutation("update_category", path_uuid(category_id, "category_id"), 200)


@bp.post("/categories/<category_id>/archive")
def archive_category(category_id):
    return direct_mutation("archive_category", path_uuid(category_id, "category_id"), 200)


@bp.post("/stock-movements")
def create_movement():
    return direct_mutation("record_stock_movement", None, 201)


SYNC_FIELDS = ("operation_id", "operation_type", "entity_id", "payload", "created_at",
               "local_sequence")


@bp.post("/sync")
def sync():
    data = body_object()
    if set(data) != set(SYNC_FIELDS):
        raise invalid_request("The sync envelope needs exactly these fields.",
                              {"fields": list(SYNC_FIELDS)})
    seq = data["local_sequence"]
    if not is_json_integer(seq) or seq < 1 or seq > MAX_SAFE:
        raise validation_error({"local_sequence": "Must be a positive whole number."})
    op_id = data["operation_id"] if isinstance(data["operation_id"], str) else None
    try:
        with scope(write=True) as s:
            check_generation(s)
            res = svc.process_command(
                s, now_fn, operation_id=data["operation_id"],
                operation_type=data["operation_type"], entity_id=data["entity_id"],
                created_at=data["created_at"], payload=data["payload"])
    except ApiError as e:
        # Give the tablet the operation context it needs to mark the queue entry.
        if op_id and e.code != "RECOVERY_REQUIRED" and e.status != 400:
            e.details.setdefault("operation_id", op_id)
            e.details.setdefault("outcome", "rejected")
        raise
    return ok(res)


# -------------------------------------------------------------------- reads
@bp.get("/inventory")
def list_inventory():
    q = request.args.get("q")
    category_id = query_uuid("category_id")
    status = request.args.get("stock_status")
    if status is not None and status not in (alg.OUT_OF_STOCK, alg.LOW_STOCK, alg.SUFFICIENT):
        raise invalid_request("Invalid stock_status.")
    record = one_of("record_status", ("active", "archived", "all"), "active")
    sort = one_of("sort", ("name", "available_quantity"), "name")
    order = one_of("order", ("asc", "desc"), "asc")
    with scope() as s:
        rows = svc.all_item_views(s)
    if record != "all":
        rows = [r for r in rows if r["is_active"] == (record == "active")]
    if category_id:
        rows = [r for r in rows if r["category_id"] == category_id]
    if status:
        rows = [r for r in rows if r["stock_status"] == status]
    if q:
        rows = alg.search_items(rows, q)
    rows = alg.sort_items(rows, sort, descending=(order == "desc"))
    page, meta = paginate(rows)
    return ok(page, meta=meta)


@bp.get("/inventory/<item_id>")
def get_inventory_item(item_id):
    item_id = path_uuid(item_id, "item_id")
    with scope() as s:
        return ok(svc.item_view(s, svc.get_item(s, item_id)))


@bp.get("/inventory/<item_id>/batches")
def list_batches(item_id):
    item_id = path_uuid(item_id, "item_id")
    only_remaining = bool_arg("remaining_only", "false")
    with scope() as s:
        svc.get_item(s, item_id)
        batches = s.scalars(select(Batch).where(Batch.item_id == item_id)
                            .order_by(Batch.created_at, Batch.batch_id)).all()
        rows = [svc.batch_view(s, b) for b in batches]
    if only_remaining:
        rows = [r for r in rows if r["remaining_quantity"] > 0]
    page, meta = paginate(rows)
    return ok(page, meta=meta)


@bp.get("/batches/<batch_id>")
def get_batch(batch_id):
    batch_id = path_uuid(batch_id, "batch_id")
    with scope() as s:
        b = s.get(Batch, batch_id)
        if b is None:
            raise ApiError("BATCH_NOT_FOUND", "The batch was not found.", 404)
        return ok(svc.batch_view(s, b))


@bp.get("/categories")
def list_categories():
    q = request.args.get("q")
    record = one_of("record_status", ("active", "archived", "all"), "active")
    with scope() as s:
        cats = s.scalars(select(Category).order_by(Category.normalized_name,
                                                   Category.category_id)).all()
        rows = [svc.category_view(c) for c in cats]
    if record != "all":
        rows = [r for r in rows if r["is_active"] == (record == "active")]
    if q:
        from .core.normalize import normalize_name
        term = normalize_name(q)
        rows = [r for r in rows if term in r["normalized_name"]]
    page, meta = paginate(rows)
    return ok(page, meta=meta)


@bp.get("/categories/<category_id>")
def get_category(category_id):
    category_id = path_uuid(category_id, "category_id")
    with scope() as s:
        return ok(svc.category_view(svc.get_category(s, category_id)))


def movement_filters():
    item_id = query_uuid("item_id")
    mtype = request.args.get("movement_type")
    if mtype is not None and mtype not in cmd.MOVEMENT_TYPES:
        raise invalid_request("Invalid movement_type.")
    return item_id, mtype, ts_arg("from"), ts_arg("to")


@bp.get("/stock-movements")
def list_movements():
    item_id, mtype, start, end = movement_filters()
    with scope() as s:
        if item_id:
            svc.get_item(s, item_id)
        q = select(Movement)
        if item_id:
            q = q.where(Movement.item_id == item_id)
        if mtype:
            q = q.where(Movement.movement_type == mtype)
        if start:
            q = q.where(Movement.created_at >= start)
        if end:
            q = q.where(Movement.created_at < end)
        q = q.order_by(Movement.created_at.desc(), Movement.movement_id.desc())
        rows = [svc.movement_view(s, m) for m in s.scalars(q)]
    page, meta = paginate(rows)
    return ok(page, meta=meta)


@bp.get("/stock-movements/<movement_id>")
def get_movement(movement_id):
    movement_id = path_uuid(movement_id, "movement_id")
    with scope() as s:
        m = s.get(Movement, movement_id)
        if m is None:
            raise ApiError("MOVEMENT_NOT_FOUND", "The movement was not found.", 404)
        return ok(svc.movement_view(s, m))


# ------------------------------------------------------------------ reports
@bp.get("/reports/dashboard")
def report_dashboard():
    category_id = query_uuid("category_id")
    raw = request.args.get("recent_limit", "5")
    if not raw.isdigit() or not 1 <= int(raw) <= 25:
        raise invalid_request("recent_limit must be between 1 and 25.")
    with scope() as s:
        if category_id:
            svc.get_category(s, category_id)
        return ok(reports.dashboard(s, now_fn, category_id, int(raw)))


@bp.get("/reports/low-stock")
def report_low_stock():
    category_id = query_uuid("category_id")
    include_out = bool_arg("include_out_of_stock", "true")
    with scope() as s:
        if category_id:
            svc.get_category(s, category_id)
        items = [i for i in svc.all_item_views(s) if i["is_active"]
                 and (category_id is None or i["category_id"] == category_id)]
    rows = alg.restocking_order(items)
    if not include_out:
        rows = [r for r in rows if r["stock_status"] != alg.OUT_OF_STOCK]
    page, meta = paginate(rows)
    return ok(page, meta=meta)


@bp.get("/reports/expiring")
def report_expiring():
    category_id = query_uuid("category_id")
    status = one_of("status", ("expired", "expiring_soon", "all"), "default")  \
        if "status" in request.args else None
    with scope() as s:
        if category_id:
            svc.get_category(s, category_id)
        settings = reports.get_settings(s)
        from .core.timeutil import business_date
        today = business_date(now_fn(), settings["business_timezone"])
        rows = reports.dated_batches(s, today, settings["expiration_warning_days"], category_id)
    exp_status = reports.expiration_status(settings, rows)
    if status is None:
        rows = [r for r in rows if r["expiration_status"] is not None]
    elif status != "all":
        rows = [r for r in rows if r["expiration_status"] == status]
    page, meta = paginate(rows)
    meta["expiration_status"] = exp_status
    return ok(page, meta=meta)


@bp.get("/reports/stock-movements")
def report_movements():
    item_id, mtype, start, end = movement_filters()
    with scope() as s:
        if item_id:
            svc.get_item(s, item_id)
        rows = reports.movement_summary(s, item_id, mtype, start, end)
    page, meta = paginate(rows)
    return ok(page, meta=meta)


# ----------------------------------------------------------------- snapshot
@bp.get("/snapshot")
def snapshot():
    receipt_ids = request.args.getlist("receipt_id")
    if len(receipt_ids) > 100:
        raise invalid_request("At most 100 receipt_id values per request.")
    ids = [path_uuid(r, "receipt_id") for r in receipt_ids]
    with scope() as s:
        checks = []
        for rid in ids:
            r = s.get(ProcessedOperation, rid)
            checks.append({"operation_id": rid,
                           "status": "accepted" if r else "missing",
                           "processed_at": svc.out_ts(r.processed_at) if r else None})
        items = svc.all_item_views(s)
        allocs = s.scalars(select(Allocation).order_by(Allocation.allocation_id)).all()

        # Check migration status to determine if replay order is authoritative
        from .db import _check_migration_status
        migration_status = _check_migration_status(s.bind)

        # Build movement -> commit_seq map for authoritative replay order
        # Join on entity_id (durable association recorded at commit time)
        movement_commit_seq = {}
        movement_metadata = {}  # track migration_metadata per movement
        for m_id, c_seq, meta in s.execute(
            select(Movement.movement_id, ProcessedOperation.commit_seq, ProcessedOperation.migration_metadata)
            .join(ProcessedOperation, ProcessedOperation.entity_id == Movement.movement_id)
            .where(ProcessedOperation.operation_type == "record_stock_movement")
        ):
            movement_commit_seq[m_id] = c_seq
            movement_metadata[m_id] = meta or "verified"

        # Get all movements and sort
        all_movements = s.scalars(select(Movement)).all()
        # For provisional migrations, fall back to created_at ordering and flag
        movements = sorted(
            all_movements,
            key=lambda m: (movement_commit_seq.get(m.movement_id, 0), m.created_at, m.movement_id)
        )

        last = s.scalars(select(ProcessedOperation).order_by(
            ProcessedOperation.commit_seq.desc())
            .limit(1)).first()
        data = {
            "schema_version": 2,
            "server_generation_id": current_generation(s),
            "receipt_checks": checks,
            "snapshot_at": canonical_timestamp(now_fn()).replace(".000Z", "Z"),
            "categories": [svc.category_view(c) for c in s.scalars(
                select(Category).order_by(Category.category_id))],
            "inventory_items": sorted(items, key=lambda i: i["item_id"]),
            "stock_batches": [svc.batch_view(s, b) for b in s.scalars(
                select(Batch).order_by(Batch.batch_id))],
            "stock_movements": [
                {
                    **{k: v for k, v in svc.movement_view(s, m).items() if k != "allocations"},
                    "commit_seq": movement_commit_seq.get(m.movement_id),
                    "replay_status": movement_metadata.get(m.movement_id, "verified")
                }
                for m in movements
            ],
            "batch_allocations": [{"allocation_id": a.allocation_id, "batch_id": a.batch_id,
                                   "quantity_change": a.quantity_change,
                                   "movement_id": a.movement_id} for a in allocs],
            "settings": reports.get_settings(s),
            "sync": {"last_committed_operation_id": last.operation_id if last else None,
                     "last_committed_at": svc.out_ts(last.processed_at) if last else None,
                     "last_commit_seq": last.commit_seq if last else 0},
            "backup": {"last_successful_backup_at": None},
            "migration": {
                "status": migration_status["status"],
                "has_provisional": migration_status.get("has_provisional", False),
                "provisional_count": migration_status.get("provisional_count", 0)
            }
        }
    return ok(data)


@bp.get("/health")
def health():
    return ok({"status": "ok"})
