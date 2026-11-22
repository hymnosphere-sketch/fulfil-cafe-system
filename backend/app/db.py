"""SQLite engine, transaction scopes, and data-preserving receipt migration."""
from collections import Counter, defaultdict
from contextlib import contextmanager
import threading

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from .core.canonical import PROFILE, norm_uuid, parse_json_strict
from .core.errors import ApiError
from .core.quantities import MAX_SAFE
from .core.timeutil import parse_timestamp
from .models import Base, VERIFIED_ORDER_STATES


# Writers acquire SQLite's lock before validating stock or reading a sequence.
# Reads use a plain transaction and retain one consistent snapshot.
_mode = threading.local()
STOCK_OPERATION = "record_stock_movement"
_ORDER_STATES = {*VERIFIED_ORDER_STATES, "provisional", "unverified"}
_RECEIPT_COLUMNS = {
    "entity_id": "VARCHAR(36)",
    "commit_seq": "BIGINT",
    "migration_metadata": "TEXT",
    "acceptance_command": "TEXT",
    "acceptance_digest": "VARCHAR(64)",
}
_ENTITY_FIELDS = {
    "create_category": "category_id",
    "update_category": "category_id",
    "archive_category": "category_id",
    "create_item": "item_id",
    "update_item": "item_id",
    "archive_item": "item_id",
    STOCK_OPERATION: "movement_id",
}


def make_engine(url):
    engine = create_engine(url, future=True)

    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_conn, _record):
        dbapi_conn.isolation_level = None  # we control BEGIN ourselves
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    @event.listens_for(engine, "begin")
    def _on_begin(conn):
        write = getattr(_mode, "write", True)
        conn.exec_driver_sql("BEGIN IMMEDIATE" if write else "BEGIN")

    return engine


def _canonical_uuid(value):
    try:
        return norm_uuid(value, "receipt association")
    except (ApiError, ValueError):
        return None


def receipt_has_verifiable_identity(receipt):
    """Check that retained receipt metadata can support exact replay in this profile."""
    operation_id = _canonical_uuid(receipt.operation_id)
    digest = receipt.request_fingerprint
    if (operation_id is None or operation_id != receipt.operation_id
            or receipt.operation_type not in _ENTITY_FIELDS or receipt.fingerprint_profile != PROFILE
            or not isinstance(digest, str) or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)):
        return False
    try:
        parse_timestamp(receipt.processed_at)
    except (ApiError, TypeError, ValueError, OverflowError):
        return False
    return True


def _recorded_result(receipt):
    try:
        result = parse_json_strict(receipt.processing_result)
    except (ApiError, TypeError, ValueError, RecursionError):
        return {}
    return result if isinstance(result, dict) else {}


def _recorded_entity(receipt, result):
    """A stored entity ID may corroborate the result, or contradict it."""
    result_id = _canonical_uuid(result.get(_ENTITY_FIELDS.get(receipt.operation_type)))
    if receipt.entity_id is not None and _canonical_uuid(receipt.entity_id) != result_id:
        return None
    return result_id


def _matches_movement(result, movement, allocations):
    required = {"item_id", "movement_type", "quantity_change", "reason", "recorded_by",
                "created_at", "allocations"}
    if not required.issubset(result):
        return False
    quantity = result["quantity_change"]
    if (_canonical_uuid(result["item_id"]) != movement.item_id
            or result["movement_type"] != movement.movement_type
            or type(quantity) is not int or quantity != movement.quantity_change
            or result["reason"] != movement.reason or result["recorded_by"] != movement.recorded_by):
        return False
    try:
        if parse_timestamp(result["created_at"]) != parse_timestamp(movement.created_at):
            return False
    except (ApiError, TypeError, ValueError, OverflowError):
        return False

    recorded = result["allocations"]
    if not isinstance(recorded, list) or not recorded or len(recorded) != len(allocations):
        return False
    remaining = {allocation.allocation_id: (allocation.batch_id, allocation.quantity_change)
                 for allocation in allocations}
    for entry in recorded:
        if not isinstance(entry, dict) or type(entry.get("quantity_change")) is not int:
            return False
        expected = remaining.pop(_canonical_uuid(entry.get("allocation_id")), None)
        if expected != (_canonical_uuid(entry.get("batch_id")), entry["quantity_change"]):
            return False
    return not remaining


def _movement_receipt_links(receipts, movements, allocations, results):
    # Count both an explicit ID and a result ID as claims. Even a contradictory
    # receipt can make another claim about the same movement ambiguous.
    claims = defaultdict(set)
    candidates = {}
    for receipt in receipts:
        if receipt.operation_type != STOCK_OPERATION:
            continue
        result = results[receipt.operation_id]
        for value in (receipt.entity_id, result.get("movement_id")):
            entity = _canonical_uuid(value)
            if entity:
                claims[entity].add(receipt.operation_id)
        entity = _recorded_entity(receipt, result)
        if entity:
            candidates[entity] = receipt

    allocations_by_movement = defaultdict(list)
    for allocation in allocations:
        allocations_by_movement[allocation.movement_id].append(allocation)

    links = {}
    for movement in movements:
        movement_id = movement.movement_id
        receipt = candidates.get(movement_id)
        if (receipt is not None and len(claims[movement_id]) == 1
                and _matches_movement(results[receipt.operation_id], movement,
                                      allocations_by_movement[movement_id])):
            links[movement_id] = receipt
    return links


def movement_receipt_links(receipts, movements, allocations):
    """Match unique, corroborated stock receipts without relying on ID equality or order.

    Callers supply materialized rows or ORM objects from one transaction. A
    valid link identifies a movement's receipt but cannot prove its sequence.
    """
    stock_receipts = [row for row in receipts if row.operation_type == STOCK_OPERATION]
    results = {row.operation_id: _recorded_result(row) for row in stock_receipts}
    return _movement_receipt_links(stock_receipts, movements, allocations, results)


def _safe_sequence(value):
    return type(value) is int and 0 < value <= MAX_SAFE


def _migrate_receipts(conn):
    columns = {row["name"]: row for row in conn.exec_driver_sql(
        "PRAGMA table_info(processed_operations)"
    ).mappings()}
    native = columns.get("commit_seq")
    # PR #18 wrote actual positions to BIGINT NOT NULL with no default.
    # A nullable column (or a default) could be an interrupted PR #21 backfill.
    native_sequence = ("migration_metadata" not in columns and native is not None
                       and native["type"].upper() == "BIGINT" and native["notnull"]
                       and native["dflt_value"] is None)

    for name, definition in _RECEIPT_COLUMNS.items():
        if name not in columns:
            conn.exec_driver_sql(f"ALTER TABLE processed_operations ADD COLUMN {name} {definition}")

    receipts = conn.exec_driver_sql("""
        SELECT operation_id, operation_type, entity_id, commit_seq, migration_metadata,
               processing_result, request_fingerprint, fingerprint_profile, processed_at
        FROM processed_operations ORDER BY processed_at, operation_id
    """).all()
    valid_positions = Counter(row.commit_seq for row in receipts if _safe_sequence(row.commit_seq))
    next_position = max(valid_positions, default=0)
    native_sequence = native_sequence and len(valid_positions) == len(receipts) == next_position

    results = {row.operation_id: _recorded_result(row) for row in receipts}
    movements = conn.exec_driver_sql("""
        SELECT movement_id, item_id, movement_type, quantity_change, reason, recorded_by, created_at
        FROM stock_movements
    """).all()
    allocations = conn.exec_driver_sql("""
        SELECT allocation_id, movement_id, batch_id, quantity_change FROM batch_allocations
    """).all()
    links = _movement_receipt_links(receipts, movements, allocations, results)
    movement_by_receipt = {row.operation_id: movement_id for movement_id, row in links.items()}

    changes = []
    for row in receipts:
        if row.operation_type == STOCK_OPERATION:
            entity = movement_by_receipt.get(row.operation_id)
        else:
            entity = _recorded_entity(row, results[row.operation_id])

        status = row.migration_metadata
        if status is None:
            status = "verified_legacy" if native_sequence else "provisional"
        if status not in _ORDER_STATES:
            status = "unverified"

        position = row.commit_seq
        if status == "provisional" and (position is None or position == 0) and next_position < MAX_SAFE:
            # Deterministic positions are reserved only as provisional estimates.
            next_position += 1
            position = next_position
        unsupported_authority = (status in VERIFIED_ORDER_STATES and (
            entity is None or not receipt_has_verifiable_identity(row)))
        if not _safe_sequence(position) or valid_positions[position] > 1 or unsupported_authority:
            status = "unverified"

        # A failed match leaves the old claim and original receipt JSON intact.
        # Downstream verification excludes it using the same association rules.
        entity = entity if entity is not None else row.entity_id
        if (entity, position, status) != (row.entity_id, row.commit_seq, row.migration_metadata):
            changes.append((entity, position, status, row.operation_id))

    if changes:
        conn.exec_driver_sql("""
            UPDATE processed_operations SET entity_id = ?, commit_seq = ?, migration_metadata = ?
            WHERE operation_id = ?
        """, changes)

    # Existing databases and fresh databases share these same enforcement
    # points. Provisional or invalid legacy data remains available for recovery.
    conn.exec_driver_sql("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_processed_operations_verified_sequence
        ON processed_operations (commit_seq) WHERE migration_metadata IN ('verified', 'verified_legacy')
    """)
    conn.exec_driver_sql("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_processed_operations_verified_movement
        ON processed_operations (entity_id)
        WHERE migration_metadata IN ('verified', 'verified_legacy') AND operation_type = 'record_stock_movement'
    """)


def init_db(engine):
    # The schema, backfill, and ledger head share one transaction.
    with engine.begin() as conn:
        previous = {row["name"] for row in conn.exec_driver_sql(
            "PRAGMA table_info(processed_operations)"
        ).mappings()}
        Base.metadata.create_all(conn)
        if _RECEIPT_COLUMNS.keys() <= previous:
            # A missing head or damaged evidence on an upgraded database is
            # handled as recovery. Recreating it here would hide receipt loss.
            return
        _migrate_receipts(conn)
        if conn.exec_driver_sql("SELECT 1 FROM receipt_ledger_head").first() is None:
            position = conn.exec_driver_sql("""
                SELECT COALESCE(MAX(commit_seq), 0) FROM processed_operations
                WHERE typeof(commit_seq) = 'integer' AND commit_seq BETWEEN 1 AND ?
            """, (MAX_SAFE,)).scalar_one()
            # A historical maximum prevents reuse going forward. It cannot
            # prove that no historical receipts were lost before the upgrade.
            conn.exec_driver_sql("""
                INSERT INTO receipt_ledger_head (singleton_id, committed_seq, legacy_through)
                VALUES (1, ?, ?)
            """, (position, position if previous else None))


def make_session_factory(engine):
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


@contextmanager
def session_scope(factory, write=True):
    """Use one transaction for a request and roll back every write on failure."""
    previous = getattr(_mode, "write", True)
    _mode.write = write
    session = factory()
    try:
        yield session
        session.commit()
    except BaseException:
        session.rollback()
        raise
    finally:
        session.close()
        _mode.write = previous
