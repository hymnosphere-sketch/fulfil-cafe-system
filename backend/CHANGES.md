# Backend fixes (checked against docs/API_CONTRACT.md and docs/DATABASE_DESIGN.md)

| # | Problem | Fix | File |
|---|---|---|---|
| 1 | `INSUFFICIENT_STOCK` reported `available_quantity: -5` (balance after the rejected withdrawal) instead of the real balance. Contract example F says 800. The existing test `test_overdraw_is_rejected...` was failing. | Read the balance before the movement is written. | `services.py` |
| 2 | Zero or out-of-range movement quantities returned `VALIDATION_ERROR`; contract section 13 reserves `INVALID_QUANTITY`. | New `_movement_quantity` check (wrong JSON type stays `VALIDATION_ERROR`). | `core/commands.py` |
| 3 | No `503 SYNC_FAILED` (sections 3, 9, 13). A locked database became `500 SERVER_ERROR`. | Handler for database-unavailable errors, with `Retry-After`, no raw DB text. | `api.py` |
| 4 | Every request, including GETs, ran `BEGIN IMMEDIATE`, so reads queued behind writers. | Only mutations take the write lock; reads use a plain `BEGIN`. | `db.py`, `api.py` |
| 5 | Windows has no time-zone data: `ZoneInfo("Asia/Manila")` would crash `/reports/dashboard` and `/reports/expiring` with 500. | `tzdata` added to requirements; start-up check with a clear message. | `requirements.txt`, `__init__.py` |
| 6 | DATABASE_DESIGN section 7 items missing: row checks for movement type, sign-by-type, reason-when-required, nonblank normalized names, nonnegative cost; indexes on `category_id`, `expiration_date`, movement history; `ON DELETE RESTRICT`. | Added to the models. | `models.py` |

Tests: `tests/test_contract.py` (new, 16 tests) replays contract examples A-F and covers the rules above.
`tests/test_core.py` changed one assertion: zero quantity is now `INVALID_QUANTITY`.
Result: 59 tests, all passing (`python -m unittest`).

## Not done (the docs say these need approval first, so I did not invent them)
- BE-09 authentication/roles and `recorded_by` staff attribution (StaffUsers table).
- BE-10 backup and restore routes (API contract section 11: "route paths deferred"). FR-019 stays open.
- Schema migrations / schema versioning (DATABASE_DESIGN section 7).
- Changing `expiration_warning_days` after first start: it is seeded once into the database; there is no settings route yet.
