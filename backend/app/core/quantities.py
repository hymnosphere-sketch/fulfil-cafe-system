"""Scaled-integer quantities (API_CONTRACT section 2, DATABASE_DESIGN 4).

A unit profile fixes how many decimal places a quantity has. With the
fictional `kg` profile (scale 3) the integer 1500 means 1.500 kg. All
arithmetic is on integers, so there is never any rounding.

These unit profiles are FICTIONAL placeholders (open decision A-01).
"""
import re

from .errors import validation_error

MAX_SAFE = 9_007_199_254_740_991

# unit id -> scale (digits after the decimal point). Immutable once used.
UNIT_PROFILES = {
    "piece": 0,
    "kg": 3,
    "l": 3,
}

_DECIMAL = re.compile(r"^(\d+)(?:\.(\d+))?$")


def scale_for(unit_id):
    if unit_id not in UNIT_PROFILES:
        raise validation_error({"unit_of_measurement": "Choose an approved unit."})
    return UNIT_PROFILES[unit_id]


def is_json_integer(value):
    """True only for real JSON integers (bool is excluded on purpose)."""
    return isinstance(value, int) and not isinstance(value, bool)


def check_safe(value, field, *, nonnegative=False, nonzero=False):
    """Validate a wire integer: type, safe range, sign and zero rules."""
    if not is_json_integer(value):
        raise validation_error({field: "Must be a whole number (JSON integer)."})
    if abs(value) > MAX_SAFE:
        raise validation_error({field: "Number is outside the supported range."})
    if nonnegative and value < 0:
        raise validation_error({field: "Must not be negative."})
    if nonzero and value == 0:
        raise validation_error({field: "Must not be zero."})
    return value


def parse_decimal(text, unit_id):
    """Turn form text such as '1.5' into a scaled integer, exactly.

    Rejects excess precision instead of rounding: '1.5001' at scale 3 fails.
    """
    scale = scale_for(unit_id)
    if not isinstance(text, str):
        raise validation_error({"quantity": "Enter the quantity as text."})
    m = _DECIMAL.match(text.strip())
    if not m:
        raise validation_error({"quantity": "Enter a valid number."})
    whole, frac = m.group(1), m.group(2) or ""
    if len(frac) > scale:
        raise validation_error({"quantity": f"At most {scale} decimal places."})
    value = int(whole + frac.ljust(scale, "0"))
    if value > MAX_SAFE:
        raise validation_error({"quantity": "Number is outside the supported range."})
    return value


def format_quantity(value, unit_id):
    """Inverse of parse_decimal, for display and logs."""
    scale = scale_for(unit_id)
    sign = "-" if value < 0 else ""
    digits = str(abs(value)).rjust(scale + 1, "0")
    if scale == 0:
        return sign + digits
    return f"{sign}{digits[:-scale]}.{digits[-scale:]}"
