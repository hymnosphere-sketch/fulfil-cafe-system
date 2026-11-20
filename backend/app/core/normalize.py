"""Name normalization used for duplicate detection (DATABASE_DESIGN 5.C).

Display names keep their case; the *matching* value is NFC, trimmed,
whitespace-collapsed, then case-folded. Python's str.casefold() is the
Unicode default full case fold, so "Straße" and "STRASSE" match.
"""
import re
import unicodedata

# Unicode White_Space characters (not just ASCII space).
_WS = re.compile(
    "[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+"
)


def display_name(raw):
    """Trim and collapse whitespace, keep the user's capitalization."""
    text = unicodedata.normalize("NFC", raw)
    return _WS.sub(" ", text).strip()


def normalize_name(raw):
    """Canonical matching form of a name."""
    folded = display_name(raw).casefold()
    return unicodedata.normalize("NFC", folded)
