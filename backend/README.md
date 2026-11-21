# Fulfil Cafe backend (Flask + SQLAlchemy + SQLite)

Work packages BE-01 to BE-08 and BE-11 (first pass). Not included: BE-09
(authentication, awaiting approval) and BE-10 (backup and restore, awaiting
approval). All data and unit profiles are **fictional** (open decision A-01).

## Run it (Windows)

From the repository root:

```bat
cd backend
py -3 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

The API is at `http://127.0.0.1:5000/api/v1` (try `/api/v1/health`). The
database file is created in `backend/instance/`. Stop with `Ctrl + C`.

`requirements.txt` includes `tzdata`: Windows has no time-zone database, and the
dashboard/expiry reports need `Asia/Manila`. If you already created the venv,
run `pip install -r requirements.txt` again. If you have an older
`instance/fulfil_dev.db` (fictional data only), delete it once so the new
database checks (movement sign/type/reason, indexes) are created; there is no
migration tool yet.

## Run the tests

```bat
python -m unittest -v
```

`tests/test_core.py` needs nothing installed. `tests/test_api.py` needs
`pip install -r requirements.txt`; without SQLAlchemy those tests are skipped.

## How the code is organised

| Path | Job | Plain-language idea |
|---|---|---|
| `app/core/quantities.py` | scaled integers | 1.500 kg is stored as `1500`, so no rounding errors |
| `app/core/normalize.py` | name matching | "  COFFEE  beans " and "Coffee Beans" match |
| `app/core/algorithms.py` | BE-05 algorithms | search, sort, duplicates, low-stock, expiry, totals |
| `app/core/commands.py` | payload validation | rejects unknown fields, wrong signs, bad sums |
| `app/core/canonical.py` | fingerprint | same command -> same SHA-256, however it is written |
| `app/models.py` | BE-02 tables | balances are never stored, always summed from history |
| `app/services.py` | BE-03/04/07 | one `process_command` used by `/sync` and direct routes |
| `app/reports.py` | BE-08 | dashboard, low-stock, expiring, movement totals |
| `app/api.py` | BE-06 routes | thin wrappers that return the JSON envelope |

### The idempotency idea (explain this in your defense)

Every queued tablet command has an `operation_id`. `process_command` first
looks for a **receipt** with that ID. If one exists and the command's
fingerprint matches, it returns the original result and changes nothing
(`already_processed`). If the fingerprint differs it returns `409
OPERATION_ID_CONFLICT`. Otherwise it applies the change and saves the receipt
**in the same SQLite transaction**, so a crash can never leave a stock change
without its receipt (or the reverse). `BEGIN IMMEDIATE` serializes writers.

## Endpoints (API_CONTRACT sections 4-10)

Reads: `GET /inventory`, `/inventory/{id}`, `/inventory/{id}/batches`,
`/batches/{id}`, `/categories`, `/categories/{id}`, `/stock-movements`,
`/stock-movements/{id}`, `/reports/dashboard|low-stock|expiring|stock-movements`,
`/snapshot`, plus `/health`.

Writes: `POST /sync` (the tablet's normal path) and the direct routes
`POST /inventory`, `PATCH /inventory/{id}`, `POST /inventory/{id}/archive`,
the same three for `/categories`, and `POST /stock-movements`.

Every write needs the `X-Inventory-Generation` header. Read it from any
response header or from `GET /snapshot` (`server_generation_id`).

## Rules I had to choose (please confirm with your team / the café)

These are marked "pending" in the docs. I picked the proposed option so the
code works; each is a one-place change.

1. **Item duplicate rule:** same normalized name + same category + same unit
   among *active* items -> `409 DUPLICATE_ITEM`. (`services._check_item_duplicate`)
2. **Category names:** unique among active categories. (`services._create_category`)
3. **Units:** only `piece` (scale 0), `kg` and `l` (scale 3). (`core/quantities.py`)
4. **Expiration warning days:** unset (`null`) until configured, so the
   dashboard reports `warning_period_not_configured`. Set
   `EXPIRATION_WARNING_DAYS` in `create_app` config to try alerts.
5. **Batch choice:** the caller names the batch (no FIFO/FEFO yet).
6. **Staff attribution:** `recorded_by` must be `null` (staff records not approved).
7. **Wastage and adjustments require a reason** (the proposed rule).

## Known limits

- No authentication or permissions yet (BE-09); do not expose beyond localhost.
- No backup/restore routes (BE-10) and no recovery tooling beyond `/snapshot`.
- No migrations tool; tables are created on first start (`create_all`).
- Reports load all items in memory, fine for one café, not for huge data.
