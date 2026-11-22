# FE-09C — Isolated API v2 initialization (review implementation)

**Status:** Draft development contribution, not connected application functionality.

**Approvals:** Project leader reports that both teams approved the proposed API v2 contract; the frontend/project-leader approval is recorded on [Issue #23](https://github.com/hymnosphere-sketch/fulfil-cafe-system/issues/23). Backend approval was reported verbally and is **not independently evidenced by a backend GitHub comment**. This draft PR remains subject to review of the committed shared v2 specification and executable tests.

**Pinned starting points**
- Frontend: `frontend-dev` at `32ad6365b4dd8d89f0810a51f7788d2011b1cbf7`.
- Backend: `backend-dev` at `9d4af373764dd88896bf0988fc2c4fed7a7856af` (merged [PR #21](https://github.com/hymnosphere-sketch/fulfil-cafe-system/pull/21)).
- [BE-09B integrity and v2 behavior](https://github.com/hymnosphere-sketch/fulfil-cafe-system/blob/backend-dev/backend/INTEGRITY_REMEDIATION.md) on backend-dev.

## Explicit boundaries

1. **FE-09B v1 is intact.** Its API route, parser, schema-1 response rules, and demo store have not been changed. The shared transport's `apiVersion` option defaults to 1. The new client opts in to 2 explicitly.
2. **No FE-09D code is enabled.** `createIsolatedV2Client` exposes only `health()` and `snapshot()`, not `sync()`. There is no queue drain, ordinary route integration, startup hook, Service Worker trigger, or automatically configured API endpoint.
3. **No production data.** The only supported initial setup is an explicitly invoked test harness, with a disposable Flask/SQLite server and named IndexedDB database starting `fulfil-cafe-fe09c-v2-isolated`. Never use the café's real inventory or server. The existing IndexedDB database `fulfil-cafe-demo-inventory` is never opened by this implementation.
4. **Snapshot is not an upload command.** The client never sends inventory mutations. FE-09D and all live synchronization need their own approvals, authentication, backup/recovery and Android device acceptance.

## Versioned v2 response contract

- V2 health: `GET /api/v2/health` returns the unchanged health envelope and generation/settings-version headers.
- V2 snapshot: `GET /api/v2/snapshot` returns `schema_version: 2`, the original v1 collections plus `replay`, `migration`, `sync.last_commit_seq`, and per-movement `commit_seq` / `replay_status`. Receipt checks have both sequence and replay status.
- The v2 parser requires exact known keys and validates generation UUIDs, timestamps, safe integer fields, signed movements, allocations, catalog and batch references, final derived balances, strict receipt checks and commit-order constraints. It reuses the existing, unchanged v1 inventory validator only after removing v2-only fields in a **temporary in-memory projection**.
- **Authoritative:** `replay: { status: "authoritative", order: "commit_seq", installation_blocked: false }`, `migration.status: "verified"`. Movement sequences are positive safe integers, increasing, and leave room for prerequisite category and item creation. Catalog changes can occupy intervening positions. A positive ledger head requires a retained category. Each retained inactive catalog row requires a separate archive commit. A fresh empty verified ledger has null last commit markers and is eligible for isolated installation.
- **Provisional:** `replay: { status: "provisional", order: null, installation_blocked: true }`, `migration.status: "provisional"`. Movement and receipt positions, and the last-commit metadata, are null. The response can be inspected but **cannot be installed**. Never manufacture an ordering from event timestamps or UUIDs.
- A `409 RECOVERY_REQUIRED`, malformed result, generation/settings mismatch, `400 INVALID_REQUEST`, or `503 SYNC_FAILED` cannot install data. The v2 client preserves safe, distinct error categories and Retry-After; it is read-only.
- V1 sync responses and shared command fingerprinting are unchanged. The backend's proposed v2 sync acknowledgment remains a contract description for *future FE-09D*, not a live client method in FE-09C.

## Isolated IndexedDB staging and activation

`frontend/src/db/v2-isolated-initialization.js` exports:
- `FE09C_TEST_CONSENT`: required literal `ISOLATED_FE09C_TEST_ONLY`.
- `FE09C_TEST_DATABASE`: default `fulfil-cafe-fe09c-v2-isolated`.
- `initializeIsolatedV2({ client, consent, indexedDB, databaseName, createSlot, signal })`.
- `readIsolatedV2({ indexedDB, databaseName })`.

Steps:
1. Capture the active slot and its validated snapshot before fetching. Validate the incoming authoritative snapshot and its generation and settings headers. Routine initialization rejects a different generation or an older commit position. The same commit is a no-op when its contents agree, allowing the response's `snapshot_at` to differ.
2. A **new unique slot** receives catalog, items, batches, movements, allocations, settings and metadata in one IndexedDB `readwrite` transaction. Failed or interrupted staging aborts the transaction and preserves the active slot.
3. Close and reopen IndexedDB. Compare the reconstructed staged snapshot with the complete input using type-preserving equality, and validate the reconstructed snapshot before activation.
4. In that same transaction, check that the active pointer still matches the captured slot and switch it only after verification. Concurrent changes reject the install. Cancellation aborts the activation while IndexedDB can still roll back the transaction. A completed commit is reported as successful.
5. Confirm transaction completion before reporting success. Subsequent reads use only the active slot. Older inactive slots are retained. Generation rotation and rollback require a separately approved supervised recovery workflow.

**Manual test-only example** (execute in an isolated test harness; not in `src/main.js`):

```js
import { createIsolatedV2Client } from './src/api/v2-client.js'
import { initializeIsolatedV2, FE09C_TEST_CONSENT } from './src/db/v2-isolated-initialization.js'

const client = createIsolatedV2Client({ baseUrl: 'http://127.0.0.1:5000' })
const result = await initializeIsolatedV2({
  client,
  consent: FE09C_TEST_CONSENT,
  databaseName: 'fulfil-cafe-fe09c-v2-isolated-local-test',
})
console.log(result) // only safe summary counts and test generation, no secrets
```

The example permits loopback HTTP only because the shared FE-09B transport already restricts non-loopback endpoints to HTTPS. For this stage, use only disposable loopback test data; do not point at live HTTPS hosts.

## Test matrix and reproduction

From `frontend/`:
```powershell
npm ci
node --test tests/*.test.js
npm run build
git diff --check
```

The new `tests/api-v2-snapshot.test.js` covers authoritative and empty snapshots, backward timestamps with +20/−5 = 15, provisional receipt checks, duplicates, bad sequence, missing allocation, incorrect final balance, unsafe metadata, incorrect generation, HTTP 409 and 503, explicit consent and demo-store exclusion.

For native IndexedDB, use a fresh Chrome profile and Vite on an isolated origin, set `FE09C_APP_URL` and `FE09C_CHROME_URL` to the active loopback servers, then run:

```powershell
node tests/fe09c-isolated.browser.mjs
```

The browser script uses fresh suffixed databases and checks successful installation, reload, duplicate initialization, concurrent requests, rollback, staging and read errors, generation changes, and cancellation. To test a full restart, set `FE09C_RESTART_EVIDENCE` to a temporary file path before running the script, exit Chrome, and relaunch it with the same dedicated profile and Vite origin. Update `FE09C_CHROME_URL` and run `node tests/fe09c-isolated.browser.mjs --verify-restart`. The script uses fictional fixtures.

**Evidence requirement:** Tests must actually run in an appropriate Node + isolated Chrome environment before this PR can be marked ready to merge. Source creation alone is not test execution.

## Open decisions

- Joint sign-off on the written versioned fixture/response key list and the limited demo behavior in [Issue #23](https://github.com/hymnosphere-sketch/fulfil-cafe-system/issues/23).
- FE-09D locking, pending command receipts, supervised rejection repair and server generation rotation.
- Authentication, protected backups, restore authorization, real device performance and all formal acceptance cases.
