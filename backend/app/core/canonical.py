"""Canonical command + fingerprint (API_CONTRACT 'Canonical command profile').

Direct routes and /sync both build the same canonical command, so a retry
through either path produces the same fingerprint. The fingerprint is a
SHA-256 over a sorted-key, compact JSON encoding (RFC 8785 style).
"""
import hashlib
import json
import re
import uuid

from .errors import invalid_request, validation_error
from .timeutil import canonical_timestamp, parse_timestamp

COMMAND_SCHEMA_VERSION = 1
PROFILE = "1:/api/v1"

_UUID = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def norm_uuid(value, field):
    """Validate a UUID string and return its lowercase canonical form."""
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        raise validation_error({field: "Must be a valid UUID."})
    return str(uuid.UUID(value))


def parse_json_strict(raw_bytes):
    """Parse JSON, rejecting duplicate keys (the contract requires it)."""

    def no_dupes(pairs):
        seen = {}
        for k, v in pairs:
            if k in seen:
                raise invalid_request("Duplicate JSON key.", {"key": k})
            seen[k] = v
        return seen

    def reject_nonfinite(_token):
        raise invalid_request("JSON numbers must be finite.")

    try:
        return json.loads(raw_bytes, object_pairs_hook=no_dupes, parse_constant=reject_nonfinite)
    except (ValueError, RecursionError):
        raise invalid_request("Malformed JSON.")


def canonical_json(obj):
    """Sorted keys, no spaces, UTF-8: stable for hashing."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def fingerprint(command):
    return hashlib.sha256(canonical_json(command).encode("utf-8")).hexdigest()


def build_command(operation_type, entity_id, created_at, payload):
    """Assemble the canonical command object used for fingerprinting."""
    return {
        "command_schema_version": COMMAND_SCHEMA_VERSION,
        "operation_type": operation_type,
        "entity_id": norm_uuid(entity_id, "entity_id"),
        "created_at": canonical_timestamp(parse_timestamp(created_at)),
        "payload": payload,
    }
