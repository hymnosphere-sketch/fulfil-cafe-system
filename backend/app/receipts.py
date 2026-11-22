"""Validation and integrity evidence for the original accepted receipt."""
from dataclasses import dataclass

from .core import commands
from .core.algorithms import classify_stock
from .core.canonical import build_command, canonical_json, fingerprint, norm_uuid, parse_json_strict
from .core.errors import ApiError
from .core.normalize import display_name, normalize_name
from .core.quantities import MAX_SAFE, scale_for
from .core.timeutil import canonical_timestamp, parse_timestamp
from .db import STOCK_OPERATION, receipt_has_verifiable_identity


_CATEGORY_FIELDS = {"category_id", "name", "normalized_name", "description",
                    "is_active", "created_at", "updated_at"}
_ITEM_FIELDS = {"item_id", "category_id", "name", "normalized_name", "unit_of_measurement",
                "minimum_stock_level", "is_active", "created_at", "updated_at",
                "available_quantity", "stock_status"}
_MOVEMENT_FIELDS = {"movement_id", "item_id", "movement_type", "quantity_change",
                    "reason", "recorded_by", "created_at", "allocations"}


@dataclass(frozen=True)
class ReceiptEvidence:
    result: dict
    command: dict | None


def acceptance_digest(receipt):
    """Bind the exact saved result to the command, receipt identity, and position."""
    return fingerprint({
        "evidence_version": 1,
        "operation_id": receipt.operation_id,
        "operation_type": receipt.operation_type,
        "entity_id": receipt.entity_id,
        "profile": receipt.fingerprint_profile,
        "request_fingerprint": receipt.request_fingerprint,
        "processed_at": receipt.processed_at,
        "commit_seq": receipt.commit_seq,
        "command": receipt.acceptance_command,
        "result": receipt.processing_result,
    })


def _canonical_id(value):
    return norm_uuid(value, "receipt identifier") == value


def _timestamp(value):
    timestamp = canonical_timestamp(parse_timestamp(value))
    return timestamp if value in (timestamp, timestamp.replace(".000Z", "Z")) else None


def _name(value):
    return (isinstance(value, str) and bool(value) and not any(
        0xD800 <= ord(character) <= 0xDFFF for character in value)
        and display_name(value) == value)


def _safe_nonnegative(value):
    return type(value) is int and 0 <= value <= MAX_SAFE


def _catalog_result(operation, entity_id, result, command):
    category = operation.endswith("_category")
    id_key = "category_id" if category else "item_id"
    if (set(result) != (_CATEGORY_FIELDS if category else _ITEM_FIELDS)
            or result[id_key] != entity_id or not _canonical_id(entity_id)
            or not _name(result["name"]) or not normalize_name(result["name"])
            or result["normalized_name"] != normalize_name(result["name"])
            or result["is_active"] is not (not operation.startswith("archive_"))):
        return False
    created = _timestamp(result["created_at"])
    updated = _timestamp(result["updated_at"])
    if created is None or updated is None:
        return False
    if category:
        description = result["description"]
        if description is not None and not _name(description):
            return False
    else:
        scale_for(result["unit_of_measurement"])
        available, minimum = result["available_quantity"], result["minimum_stock_level"]
        if (not _canonical_id(result["category_id"])
                or not _safe_nonnegative(available) or not _safe_nonnegative(minimum)
                or (operation.startswith(("create_", "archive_")) and available != 0)
                or result["stock_status"] != classify_stock(available, minimum)):
            return False
    if operation.startswith("create_") and created != updated:
        return False
    if command is None:
        return True
    if operation.startswith("create_") and created != command["created_at"]:
        return False
    if not operation.startswith("archive_") and updated != command["created_at"]:
        return False
    return all(result[field] == value for field, value in command["payload"].items())


def _stock_result(entity_id, result, command):
    if (set(result) != _MOVEMENT_FIELDS or result["movement_id"] != entity_id
            or not _canonical_id(entity_id) or _timestamp(result["created_at"]) is None):
        return False
    payload = {field: value for field, value in result.items() if field != "created_at"}
    # A historical result omits new_batches. A stock-in or initial-stock must
    # allocate only to new batches, so its allocation rows supply the required
    # shape for validation. This does not manufacture acceptance evidence.
    if result["movement_type"] in ("initial_stock", "stock_in"):
        allocations = result["allocations"]
        if not isinstance(allocations, list):
            return False
        payload["new_batches"] = [
            {"batch_id": row["batch_id"], "received_quantity": row["quantity_change"]}
            for row in allocations
        ]
    clean = commands.validate_payload(STOCK_OPERATION, payload)
    normalized = {field: value for field, value in clean.items() if field != "new_batches"}
    if normalized != {field: value for field, value in result.items() if field != "created_at"}:
        return False
    if command is None:
        return True
    original = {field: value for field, value in command["payload"].items() if field != "new_batches"}
    return normalized == original and _timestamp(result["created_at"]) == command["created_at"]


def matches_result(operation, entity_id, result, command=None):
    """Validate the historical result without using a mutable catalog resource."""
    if not isinstance(result, dict):
        return False
    try:
        if operation == STOCK_OPERATION:
            return _stock_result(entity_id, result, command)
        return _catalog_result(operation, entity_id, result, command)
    except (ApiError, KeyError, TypeError, ValueError, OverflowError):
        return False


def read_receipt(receipt):
    """Validate a stored receipt and return command evidence when available."""
    try:
        if not receipt_has_verifiable_identity(receipt) or _timestamp(receipt.processed_at) is None:
            return None
        result = parse_json_strict(receipt.processing_result)
        command = None
        if receipt.acceptance_command is not None or receipt.acceptance_digest is not None:
            recorded = parse_json_strict(receipt.acceptance_command)
            if not isinstance(recorded, dict):
                return None
            kind = recorded["operation_type"]
            command = build_command(kind, recorded["entity_id"], recorded["created_at"],
                                    commands.validate_payload(kind, recorded["payload"]))
            if (canonical_json(command) != receipt.acceptance_command
                    or kind != receipt.operation_type or command["entity_id"] != receipt.entity_id
                    or fingerprint(command) != receipt.request_fingerprint
                    or acceptance_digest(receipt) != receipt.acceptance_digest):
                return None
        if matches_result(receipt.operation_type, receipt.entity_id, result, command):
            return ReceiptEvidence(result, command)
    except (ApiError, KeyError, TypeError, ValueError, OverflowError, RecursionError):
        pass
    return None
