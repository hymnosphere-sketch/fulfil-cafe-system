# FE-09B standalone inventory API client

FE-09B provides the client and test fixtures for the unauthenticated inventory API profile at `backend-dev` commit `76eec40bb5c645bd41b5df501ee8ac9c7ccf5564`. The running application continues to use the local demonstration repository and IndexedDB schema version 1. The client has no startup integration or storage dependencies. See the [API contract](API_CONTRACT.md), [architecture](ARCHITECTURE.md), [database design](DATABASE_DESIGN.md), and [open decisions](OPEN_DECISIONS.md).

## Client interface

Import `createInventoryApiClient` and `ApiClientError` from `frontend/src/api/client.js`. Configure `baseUrl` explicitly with an origin or a URL ending in `/api/v1`. The caller chooses the trusted endpoint. The client accepts HTTPS and permits HTTP for `localhost`, `127.0.0.1`, or `[::1]`. Use a string to validate the supplied spelling before URL normalization. Empty query and fragment delimiters and dot-segment paths fail configuration, as do credentials and other paths. If callers construct a `URL` first, any path segments that constructor removed are unavailable to the client. The live test harness restricts Flask to `127.0.0.1`. [Client source](../frontend/src/api/client.js)

| Method | Verified result |
| --- | --- |
| `health({ signal } = {})` | `GET /api/v1/health` returns `{ data, generation, settingsVersion }`. A successful response verifies the API health envelope and service metadata. A timeout, HTTP failure, or invalid response carries a different error classification. The client is independent of the browser connectivity indicator. |
| `snapshot({ receiptIds = [], signal } = {})` | `GET /api/v1/snapshot` accepts up to 100 receipt UUIDs. It returns `{ data, generation, settingsVersion, installable, installationBlocker }`, with `installable: false` for this version. |
| `sync(record, { generation, signal } = {})` | `POST /api/v1/sync` validates and adapts an eligible queue record, sends the expected generation, and returns `{ data, generation, settingsVersion }` after validating an `accepted` or `already_processed` receipt. |

An invocation sends at most one request. The client uses Fetch with `credentials: 'omit'` and manual redirect handling. It sends `Accept: application/json`, and mutation requests also send `Content-Type: application/json` and `X-Inventory-Generation`. Successful responses require the generation and settings-version headers. Sync compares the returned generation with the caller's expected value. Snapshot verifies agreement between its body and the two headers. Acknowledgments require the original operation ID, a valid processing timestamp, and the expected resource, including relevant IDs, values, and allocation identities.

The default timeout is 10 seconds. `timeoutMs` accepts integers from 1 to 120,000 milliseconds. The deadline covers Fetch and response-body reading. A caller `AbortSignal` can cancel the request. Redirects and non-JSON replies discard unread bodies without waiting for the stream to settle. Configuration accepts an injected Fetch-compatible `fetch`, `now`, `setTimer`, and `clearTimer` for deterministic testing. Injected Fetch responses supply the standard `arrayBuffer()` method for JSON. The client gives retry guidance to its caller and leaves the scheduling and queue state to later integration.

## Command boundary

`adaptQueueCommand` requires `wire_version: 1`, `fictional: false`, and `upload_eligible: true`. It copies six explicitly selected fields into the request body. [Adapter source](../frontend/src/api/commands.js)

```text
operation_id, operation_type, entity_id, payload, created_at, local_sequence
```

The wire version selects the route profile. Delivery state, retries, synchronization timestamps, resolution state, eligibility flags, and local stock confirmation receipts stay in IndexedDB. The adapter copies the command and nested entries without modifying the caller's record. It accepts hyphenated UUID text, compares UUIDs case-insensitively, and keeps the supplied IDs as written. Timestamps use UTC with a `Z` suffix, whole seconds or exactly three fractional digits, and a real calendar date. The `local_sequence` is a positive safe integer.

The supported operations are `create_category`, `update_category`, `archive_category`, `create_item`, `update_item`, `archive_item`, and `record_stock_movement`. Creates and stock movements must use matching entity and resource IDs. Archive commands send `{}`. Omitting a patch field leaves it unchanged, and explicit `null` clears nullable fields. Unknown fields, types, or units fail validation. The stock payload checks allocation signs, unique allocation and batch IDs, exact totals, and the relationship between a new batch and its allocation. The backend applies rules that require current database state.

The ordinary demo builds fictional, upload-ineligible records. The separate loopback test helper accepts an exact wire command only when its operation ID was generated by that helper during the test run. It uses fresh fictional resources and disposable SQLite data. It does not read the demo store or translate its unit labels.

## Numerical safety and snapshot inspection

The audited test profiles use `piece` at scale 0 and `kg` and `l` at scale 3. A wire value of `1500` for a scale-3 unit represents 1.500 units. Frontend demonstration labels such as `pieces` or `bags` have no approved mapping. Quantities, minimums, costs, sequences, and numeric metadata use exact JSON integers in the JavaScript safe range. Each field also has its own sign, range, or nullability rule. The client checks each allocation sum as it is accumulated.

The response reader decodes the original bytes as strict UTF-8. Invalid byte sequences fail as `invalid_json`. A genuinely encoded replacement character is valid Unicode. The reader rejects fractional and exponent forms and unsafe integer literals before using any parsed value. This catches input such as `9007199254740991.1`, which JavaScript can round into an integer within its safe range during JSON parsing. The reader also rejects duplicate JSON object keys so a later field cannot conceal a mismatched acknowledgment. The wire-command validator receives JavaScript values, so numeric spelling already lost to an upstream parser is unavailable at that boundary. Exact decimal input needs validation before conversion into the scaled value. Snapshot totals use internal `BigInt` sums of checked integers to avoid order-dependent rounding. JSON command bodies contain ordinary numbers.

Catalog acknowledgment and snapshot validation compare the returned display and normalized names using the audited display cleanup and an explicitly verified subset of Python Unicode case folding. The subset covers Latin-1 plus the tested Greek omicron and sigma variants, Greek mu, capital sharp S, the `ﬃ` ligature, U+FEFF, and U+FFFD. A name outside this subset yields a protocol compatibility error and leaves a mutation's outcome unknown. The client preserves the submitted and returned names as provided. Broader Unicode support needs a shared, versioned normalization profile. [Response validation](../frontend/src/api/responses.js)

Snapshot inspection checks generation, schema version, settings, receipts, resource shapes, references, movement and allocation agreement, and the final derived item and batch balances. Receipt checks must agree with the last committed marker when it identifies the same operation, and repeated requests for an ID must agree. An opening or receiving movement identifies its batch introduction under this profile. A positive adjustment can create a new batch or augment an existing one, so a matching quantity and timestamp can establish a possible introduction without establishing order. The inspection preserves the returned arrays. An empty response carries `isolated_inspection_only`. A nonempty response carries `missing_authoritative_replay_order` because the backend's timestamp and UUID ordering can place a withdrawal before its receipt. An unsafe aggregate makes the response an invalid protocol result. There is no snapshot installation or stock replay in this stage.

## Outcomes and retry guidance

Failures expose `ApiClientError` fields `kind`, `code`, `status`, `outcome`, `retry`, `retryAfterMs`, `generation`, and `settingsVersion`. Generic error messages omit server-provided text, details, and command bodies.

| Evidence | Classification and sync guidance |
| --- | --- |
| Invalid local generation, wire command, or queue eligibility | `invalid_command`, outcome `not_sent`. Correct the input. |
| Pinned `400 INVALID_REQUEST` pre-processing response | `server_rejection` for this attempt, with valid response metadata from the expected generation and a documented detail shape. A previous uncertain delivery still requires receipt reconciliation. |
| Known business-rule status and code | `server_rejection` with valid response metadata from the expected generation, matching operation ID, and `rejected` outcome. Contradictory, malformed, or missing evidence leaves the outcome unknown. |
| `409 OPERATION_ID_CONFLICT` with matching operation and definitive rejection | `operation_id_conflict`. Pause for review of the existing operation ID and command. |
| `409 RECOVERY_REQUIRED` or a returned generation mismatch | `recovery_required`. Pause and verify the server generation. An apparent success with the wrong generation has unknown commit outcome. |
| Recognized `401 UNAUTHORIZED` or `403 FORBIDDEN` | `access_denied`. Pause for access review. Authorization is a future backend work package. |
| `503 SYNC_FAILED` or `500 SERVER_ERROR` | `temporary_failure` or `http_failure`. Retain the original command because its outcome may be unknown. |
| Network failure, timeout, redirect, bad JSON, non-JSON HTTP error, or incompatible envelope | The client distinguishes `network_failure`, `timeout`, `redirect`, `invalid_json`, `http_failure`, and `invalid_protocol`. An uncertain sync outcome means preserve the same ID and body for a later attempt. |
| Caller cancellation | `cancelled`. A pre-aborted write was unsent. Cancellation after Fetch begins leaves the write outcome unknown. |

For eligible error responses the client reads visible `Retry-After` as delta seconds or a standard GMT HTTP date. The delay is bounded to 0–60 seconds, with a 2-second fallback when the value is unavailable, hidden by CORS, or malformed. The server can commit before a reply is lost or fails client validation. Keeping the original operation ID and command lets the backend return the stored receipt on retry. Applying the acknowledgment to the local stock ledger would repeat a change already saved on the tablet.

## Backend response compatibility

The supported response contract remains pinned to `76eec40bb5c645bd41b5df501ee8ac9c7ccf5564`. PR #18 at `f8a1adf8289119d33d54a1e69a68681e2aec1ae9` adds `commit_seq` to first acknowledgments and `sync.last_commit_seq` to schema-1 snapshots. The strict client rejects those shapes as `invalid_protocol`. A first acknowledgment with this error leaves the outcome unknown and retains the original command for reconciliation. PR #18's `already_processed` reply omits `commit_seq` and has the same shape as the pinned replay. This individual reply can validate, while support for the full contract still requires an explicit, reviewed protocol version. [Captured backend response fixtures](../frontend/tests/fixtures/api-v1-backend-responses.json)

## Contract fixtures and verification

The shared fixtures have deterministic inputs and expected results. The Python runner exports the pinned backend through Git into a temporary directory, executes its 59-test suite, compares canonical JSON and SHA-256 outputs, and checks rejection cases using Flask and disposable SQLite. The JavaScript fixture checks cover wire validation and compare fixture bytes and hashes for the supported examples. Live HTTP tests mint fresh IDs and use the standalone client against a separate temporary SQLite database. [Shared JSON fixtures](../frontend/tests/fixtures/api-v1-commands.json)

The fingerprint profile belongs to the pinned backend. It hashes compact UTF-8 JSON with object keys sorted by Unicode code point after payload validation, UUID normalization, and timestamp canonicalization. Operation ID selects the stored receipt. Sequence is a delivery concern and is excluded from the fingerprint. The tests compare equivalent command forms and differing material fields. Unicode samples expose how full Python case folding can differ from JavaScript lowercasing, and how ordinary JavaScript property enumeration or UTF-16 key sorting can produce different bytes. Fixture verification does not establish a general JavaScript fingerprint implementation. Keep the same validated command content for retries.

Command validation visits each allocation and batch once and indexes their IDs using maps and sets. Its time and extra space are linear in the variable payload size, including the copied records. Canonicalization also reads the payload and sorts the order-insensitive arrays and object keys. The sorting work is O(n log n) for an array of n entries or an object with n keys, plus the time to normalize and serialize the text and hash the bytes. Snapshot inspection is linear in resource and allocation counts, using maps for relationship checks and totals.

### Reproduce the checks

From the frontend directory, use the repository's Node version with native Fetch and WebSocket. Install existing dependencies with `npm ci` when needed.

```powershell
node --test tests/*.test.js
npm run build
git diff --check
```

For any untracked FE-09B file on Windows, run `git diff --no-index --check -- NUL <path>` from the repository root to check its added lines before staging.

Run the backend checks from the repository root. This PowerShell example installs the declared backend dependencies from the pinned Git object into a temporary virtual environment. The runner itself exports the pinned backend and manages the database lifetime.

```powershell
$fe09bPin = '76eec40bb5c645bd41b5df501ee8ac9c7ccf5564'
$fe09bEnv = Join-Path ([IO.Path]::GetTempPath()) ('fulfil-fe09b-env-' + [Guid]::NewGuid())
py -3 -m venv $fe09bEnv
$fe09bPython = Join-Path $fe09bEnv 'Scripts/python.exe'
git show "${fe09bPin}:backend/requirements.txt" | Set-Content (Join-Path $fe09bEnv 'requirements.txt') -Encoding ASCII
& $fe09bPython -m pip install -r (Join-Path $fe09bEnv 'requirements.txt')
& $fe09bPython -B frontend/tests/api-v1-python.py
node frontend/tests/api-v1-loopback.mjs $fe09bPython
```

Use `--backend-tests-only` with the Python runner for the backend suite alone. To include actual browser CORS probes, set `FE09B_CHROME_URL` to an isolated Chrome DevTools HTTP endpoint with a fresh profile. The probe serves its approved test page on `127.0.0.1:5173` and checks a second, unlisted loopback origin. Keep port 5173 available for that check. The Node runner reports whether the optional probes ran and closes its disposable Flask process.

For the established Chrome and IndexedDB regressions, serve the frontend through the Vite development server on loopback. Open a fresh isolated Chrome profile with `--headless`, `--enable-automation`, and a loopback DevTools port. Set `FE08_CHROME_URL`, `INDEXEDDB_CHROME_URL`, and `REPORTS_CHROME_URL` to that endpoint. Set their corresponding `*_APP_URL` values to the loopback Vite URL, and set `FE08_DEDICATED_PROFILE` to the absolute isolated profile path.

From the frontend directory, run each existing `tests/*.browser.mjs` script with Node. Give `indexeddb-app-persistence.browser.mjs` an absolute evidence directory. Also run `indexeddb-enhancements.browser.mjs` with an evidence directory followed by `--deferred-refresh` and again with `--lifecycle`. Seed the stock case on `127.0.0.1` and run the inline case on `localhost` with its own evidence directory followed by `--seed-restart`. Fully exit Chrome, reopen the same profile, and rerun the stock script with its original origin and evidence directory followed by `--reopen`. Rerun the inline script on its original `localhost` origin with its evidence directory followed by `--verify-restart`.

## Work required before connected inventory

- **Backend team** — Provide consistent original sequence metadata on first delivery and replay, add authoritative movement replay order to a reviewed versioned contract, enforce safe derived bounds before commit, and provide an existing-database migration or an explicit compatibility gate. PR #18 corrects malformed unit handling, `Retry-After` exposure, and unsafe stock-movement report totals. Both tested refs still accept unsafe stock commits, and the latest expiry report can still expose an unsafe batch balance. FE-09C requires a separate, explicitly opted-in integration dataset and atomic installation after validating the reviewed contract. A disposable empty-server initialization can be scoped separately.
- **Both teams** — Agree on connected unit profiles, duplicate normalization, whitespace and null semantics, archived-name handling, opening stock, adjustment and expiry rules, prices, and staff attribution. The pinned backend uses active-row uniqueness, Unicode full case folding, provisional unit IDs, and nullable server-owned expiry settings. Production policy decisions remain with the café and project leadership.
- **FE-09D** — Define one owner for ordered queue delivery, one in-flight request, durable acknowledgment and rejection changes, identical retries for unknown outcomes, and a reviewed response to generation changes. Keep acknowledgment updates separate from stock and protect previously stored demo records from upload.
- **Backend team and project leadership** — Authorization and protected backup/restore work must precede deployment involving actual café data.
