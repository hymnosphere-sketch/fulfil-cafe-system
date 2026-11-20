"""Timestamp and calendar-date rules (API_CONTRACT section 2)."""
import re
from datetime import date, datetime, timedelta, timezone

from .errors import validation_error

# 2026-11-18T02:00:00Z or with exactly three fractional digits.
_TS = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{3})?Z$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_timestamp(text, field="created_at"):
    """Parse a UTC ISO timestamp ending in Z; reject offsets and bad dates."""
    if not isinstance(text, str) or not _TS.match(text):
        raise validation_error({field: "Use a UTC time like 2026-11-18T02:00:00Z."})
    try:
        parsed = datetime.fromisoformat(text[:-1])
    except ValueError:
        raise validation_error({field: "Not a valid date and time."})
    return parsed.replace(tzinfo=timezone.utc)


def canonical_timestamp(dt):
    """Exactly three fractional digits, as the canonical command requires."""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_date(text, field):
    if not isinstance(text, str) or not _DATE.match(text):
        raise validation_error({field: "Use a date like 2026-11-18."})
    try:
        return date.fromisoformat(text)
    except ValueError:
        raise validation_error({field: "Not a valid calendar date."})


def utc_now():
    return datetime.now(timezone.utc)


def business_date(now_utc, tz_name):
    """The calendar date in the café's timezone (proposed Asia/Manila)."""
    from zoneinfo import ZoneInfo

    return now_utc.astimezone(ZoneInfo(tz_name)).date()


def warning_cutoff(today, warning_days):
    """Inclusive last day that still counts as 'expiring soon'."""
    return None if warning_days is None else today + timedelta(days=warning_days)
