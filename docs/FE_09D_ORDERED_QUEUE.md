# FE-09D — Isolated ordered queue synchronization

FE-09D tests delivery from a separate fictional IndexedDB queue to a disposable loopback Flask server. Delivery is a single explicit call. The engine has no startup, reconnect, timer, or Service Worker hook.

## Entry points

- `prepareIsolatedV2Queue({ consent, databaseName, generation, settingsVersion, commands })` seeds a new fixture queue once. Use `FE09D_TEST_CONSENT`, a unique name starting with `fulfil-cafe-fe09d-queue-`, the generation and settings version from the disposable server, and the six-field wire commands. Duplicate operation IDs or sequences fail. An existing queue cannot be replaced by reseeding.
- `drainIsolatedV2Queue({ consent, databaseName, baseUrl, signal })` uses an exclusive origin-scoped Web Lock without waiting or stealing it. A second tab gets `busy`. An unavailable lock returns `lock_unavailable`. The base URL must be a loopback origin.
- `readIsolatedV2Queue({ consent, databaseName })` reads the saved fixture queue and its audit state. It is used by the test harness to check receipts and pending work.

The drain inspects a read-only v2 snapshot before its first POST. A provisional history, generation mismatch, settings mismatch, or recovery response pauses delivery. It then visits commands using the IndexedDB sequence index. Each successful v2 receipt must identify the submitted operation and carry its matching result, verified replay status, increasing commit sequence, generation, and settings version. The engine saves the receipt and delivery status in the same IndexedDB transaction before sending the next command. It writes queue state only, so it never reapplies stock locally.

A correlated business rejection or operation ID conflict is retained as `failed / needs_review` and blocks the remaining queue. Unknown delivery remains pending with the original wire command. Timed or transient failures with retry guidance persist a retry deadline. A later explicit drain can retry after that deadline. Access denial pauses the current drain. Generation, settings, or recovery mismatches persist a recovery pause. A failed local receipt write leaves the command pending. After a browser closes with an unresolved request, replay sends the identical command, and Flask returns the original receipt if the request already committed.

## Verification

Run the full Node suite and production build from `frontend/`. For native IndexedDB and Flask compatibility, export `backend-dev` at `9d4af373764dd88896bf0988fc2c4fed7a7856af` into a temporary directory and install its requirements in a disposable Python environment. Start Vite on `127.0.0.1` and set `FE09D_APP_URL` to that origin, `FE09D_CHROME_BIN` to the Chrome executable, `FE09D_PYTHON` to the disposable Python executable and `FE09D_BACKEND_ROOT` to the exported backend directory containing `app/`.

Run `node tests/fe09d-queue.browser.mjs`. The runner starts Flask on ephemeral loopback ports with new SQLite files and runs Chrome with a fresh headless profile. It closes and reopens that profile to test an interrupted delivery and checks the existing demo queue for changes.

Generation rotation, supervised repair, production authentication, live delivery, and synchronization UI remain separate work. The fixture browser tests run on desktop Chrome. Device acceptance remains a later workchart step.
