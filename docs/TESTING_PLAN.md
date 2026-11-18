# Testing Plan and Acceptance Criteria

## 1. Testing Objectives

Verify that the application records stock correctly, preserves data through failures, is usable on the intended Android tablet, and supports the café's daily inventory work. Check the interface, server reliability, API compatibility, offline operation, synchronization, backup restoration, and staff acceptance.

For Data Logic and Algorithm, students should explain the role of keyed records, lists, signed stock movements, and the ordered synchronization queue. Shared test inputs show how search, sorting, classification, and aggregation behave in JavaScript and Python. Boundary and failure cases let students demonstrate why an algorithm is correct, what its results mean, and where input size affects its cost.

## 2. Testing Scope

Stage 1 covers the dashboard, categories, inventory records, search, sorting, filtering, duplicate detection, receiving, usage, wastage, adjustments, alerts, expiration, movement history, and inventory reports. It also covers IndexedDB, offline operation, synchronization, backups, recovery, and PWA installation. Daily inventory operations use one Android tablet and save locally before synchronization.

Menu, orders, sales, top-selling reports, and recipe deductions remain conditional Stage 2 work. The plan follows the [project plan](PROJECT_PLAN.md), [requirements](REQUIREMENTS.md), [architecture](ARCHITECTURE.md), [database design](DATABASE_DESIGN.md), [API contract](API_CONTRACT.md), [team delegation](TEAM_DELEGATION.md), [Modern Café design system](DESIGN_SYSTEM.md), and [repository guidance](../AGENTS.md).

## 3. Testing Levels

| Level | What it verifies |
|---|---|
| Unit | Individual algorithms, validation rules, and calculations with known inputs and outputs. |
| Component | Forms, navigation, tables, buttons, and common states in reusable interface elements. |
| Database | Local and server persistence, relationships, constraints, and all-or-nothing writes. |
| API | Request and response schemas, statuses, errors, and duplicate-safe retries. |
| Integration | Compatibility between tablet and server, including the full local-save and sync workflow. |
| System | End-to-end behavior of the installed or browser-based application on the target tablet. |
| User acceptance | Fulfil Cafe's authorized owner or staff complete representative tasks and give feedback. |

## 4. Proposed Tools and Environments

| Area | Proposed tools and setup |
|---|---|
| Frontend | Browser Developer Tools, manual interface checks, and Vitest for JavaScript unit tests. Playwright is an optional browser end-to-end tool. |
| Backend | pytest, Flask test client, SQLAlchemy transaction checks, and an isolated SQLite test database. Use a disposable database file for restart tests. |
| API | Postman or an equivalent tool pointed at a test server, using the documented endpoints and fictional requests. |
| Offline | Developer Tools for request and storage inspection, including IndexedDB and Service Worker state. Use Android airplane mode and verify Wi-Fi is off for physical disconnection checks. |
| Accessibility | Browser accessibility inspection, contrast checks, and manual keyboard and touch tests. Check meaningful announcements using Android TalkBack where available. |
| Tablet and recovery | Use an HTTPS test deployment and dedicated tablet/browser test data. Restore backups into a separate disposable environment. |

Tool selection is proposed. Use existing capabilities where practical and obtain approval before adding test dependencies. Never use real café records, customer payment data, or live credentials as test fixtures.

## 5. Test Case Format and Shared Fixtures

Each case records a unique ID, module and objective, requirement IDs, responsible team, preconditions and data, steps, expected result, actual result, status, and evidence or notes. **Not Run** means execution has not started. **Passed** means observed behavior met expectations. **Failed** means an observed result differed. **Blocked** means a prerequisite prevented execution. **Not Applicable** means an approved scope or environment decision makes the case inapplicable. Use a dash for unfilled actual results and evidence. All cases start **Not Run**, including cases with policy or device prerequisites.

### Fictional fixtures for JavaScript and Python

Each case starts from a fresh fixture unless stated otherwise. Use stable, valid UUIDs when loading these labels into an application or API test. Quantities below are integer increments in the fixture's configured item unit. They set no business precision, unit conversions, purchase cost basis, or operating thresholds.

| Label | Item | Category | Active | Available | Minimum |
|---|---|---|---|---:|---:|
| I1 | Coffee Beans | Ingredients | Yes | 100 | 40 |
| I2 | Milk | Ingredients | Yes | 25 | 25 |
| I3 | Chocolate Syrup | Ingredients | Yes | 5 | 10 |
| I4 | Paper Cups | Packaging | Yes | 0 | 15 |
| I5 | Archived Tea | Ingredients | No | 0 | 10 |

Represent nonzero opening balances with initial stock movements and allocations. For the **stock replay fixture**, begin with an empty I1. Allocate opening stock +100 to B1, a receipt +40 to B2, usage −30 and wastage −10 to B1, and adjustments +5 and −5 to B2 under a fictional authorized adjustment policy. The remaining batches then hold 60 and 40. An explicit allocation of −60 and −40 brings both to zero. These allocations are fixture inputs and set no depletion policy.

For **expiration boundaries**, freeze the test business date at D with a fictional warning window of three calendar days and use positive-remaining batches dated D−1, D, D+3, and D+4. Include an undated batch and a zero-remaining batch with a date. Run these with the proposed inclusive warning boundary until the final rule is agreed. Use separate copies of fixtures for expiration cases and baseline dashboard totals.

### Shared command and recovery fixtures

Use these fictional fixtures in both JavaScript and Python. Expected outcomes are planning inputs. No test is executed by this document.

| Fixture | Input | Expected comparison |
|---|---|---|
| Quantity conversion | Fictional `kg` profile at scale 3, text inputs 1.5, 1.500, and 1.5001. | First two become integer 1500. Reject the last for excess precision. Reject boolean, numeric string, fraction, and exponent-form wire values for integer fields. Reject 9,007,199,254,740,992 and a safe maximum plus one. |
| Unit grouping | Two quantities in the same stable unit and one in an incompatible unit. | Sort values within unit groups. Keep the incompatible item in its own group. Equal quantities use normalized name then UUID. |
| Unicode matching | Composed and decomposed “Café,” padded words with repeated Unicode whitespace, and “Straße” and “STRASSE.” | Intended variants share the pinned matching form. Preserve display case and warn as candidates under the agreed identity rules. |
| Equivalent command | A fictional category creation with an omitted description, the same creation with null description and reversed key order, and its sync equivalent. Compare seconds with the same time ending in .000Z. | The same operation ID and normalized command return the existing receipt. Explicit null on a category PATCH clears the description, while omission preserves it. Those PATCH forms are materially different. |
| Changed command and invalid shapes | Reuse an accepted ID with a changed quantity and matching allocations. Try unknown or duplicate JSON keys and a null required field. | Changed payload returns 409 OPERATION_ID_CONFLICT. Reject invalid structures and values. Leave stock and receipts intact. |
| Expiration rules | Frozen business date D, a three-day warning, D−1 through D+4 boundary samples, remaining and depleted batches, and a null warning. Use proposed Asia/Manila in this fixture. | Calendar rules agree on both sides even across UTC midnight. D and D+3 are included with a warning set. With no warning, already expired stock remains visible and upcoming alerts are unavailable. |
| First vertical slice | One fictional category and item, one explicit batch of 20 demonstration pieces at scale 0, and −5 usage. | Local and synchronized balances reconcile at 15. Restart preserves history and queue records. Retrying the accepted usage does not create a second movement or stock change. |

## 6. Frontend Test Cases

| Case ID | Module and objective | Requirements | Responsible team | Preconditions and test data | Steps | Expected result | Actual result / Status / Evidence or notes |
|---|---|---|---|---|---|---|---|
| FE-01 | Navigation and sidebar | NFR-001, NFR-007 | Frontend | Tablet layout with all available MVP destinations. | Open Dashboard, expand and collapse the sidebar, and visit Inventory and History by touch and keyboard. | Navigation retains the active page marker. The narrower drawer opens with a labeled button, closes, and returns focus. | — / Not Run / — |
| FE-02 | Responsive layout and visual tokens | NFR-001, NFR-007 | Frontend | Landscape and portrait test viewports, Modern Café tokens. | Rotate both ways, open a form with the keyboard, and inspect type, key colors, and primary touch targets. | Content reflows without hidden essential actions, text stays legible, approved palette and Inter are used with fallback, and primary targets meet the 48 × 48 CSS pixel design goal. | — / Not Run / — |
| FE-03 | Dashboard and inventory list | FR-001, FR-002, FR-006, FR-011, FR-012 | Frontend | Baseline catalog and known movements. | Open dashboard and inventory. Search Coffee, filter Ingredients and low stock, then sort by name and quantity. | Dashboard counts match records and recent movements. Filters, units, statuses, and ordering are correct in both table and portrait list. | — / Not Run / — |
| FE-04 | Add and validate item | FR-003, FR-004, FR-007, FR-008 | Frontend | Agreed item fields and fictional duplicate rules. | Submit blank fields, then enter a variant of Coffee Beans, then save a valid distinct item. | Errors locate the invalid fields, duplicate warning appears with a route to existing stock-in, and the valid new item saves once with zero derived stock. | — / Not Run / — |
| FE-05 | Edit and confirm archive | FR-003, FR-005, FR-010 | Frontend | A zero-balance item with history, approved archive policy. | Edit its name and minimum, inspect the quantity field, cancel archival, then confirm it. | Editable fields save, quantity cannot be overwritten, cancel preserves activity, and confirmed archival hides it from active views while retaining history. | — / Not Run / — |
| FE-06 | Stock forms and confirmation | FR-009, FR-010, FR-013 | Frontend | Fictional batches and approved form rules. | Preview a receipt and usage, cancel one draft, submit a valid draft, then enter an excessive withdrawal. | Preview shows signed effect and correct unit, cancel makes no movement, confirm saves once, and invalid usage shows actionable feedback with no change. | — / Not Run / — |
| FE-07 | Loading, empty, and error states | FR-001, FR-006, NFR-001 | Frontend | Delayed local read, an empty fixture, no matching filters, and a controlled read failure. | Open dashboard and inventory under each condition. | Loading is distinct from empty or error, no synthetic counts appear, and errors and no-match states provide a relevant next action. | — / Not Run / — |
| FE-08 | Connectivity and sync messages | FR-002, FR-017, FR-018 | Frontend | Initialized app, delayed acknowledgment and rejected test command. | Disconnect, save a valid movement, reconnect, delay its acknowledgment, then exercise a rejection. | Offline and queue states are separate. Local save shows pending until confirmation. A rejection remains visible with review guidance. | — / Not Run / — |
| FE-09 | Accessibility and focus | NFR-001, NFR-007 | Frontend | Keyboard, touch, accessibility inspection, and representative status badges. | Tab through navigation, forms and confirmation, resize text, inspect contrast and status announcements, and repeat key actions by touch. | Focus is visible and unobscured, controls have usable names, and labels and error text carry meaning independently of color or icons. | — / Not Run / — |
| FE-10 | Frontend build and maintainability | NFR-005, NFR-006 | Frontend | Implemented feature on a review branch with shared documentation and fictional fixtures. | Run the agreed Vite build. Review UI, rules, storage and API separation, matching names and contracts, and contributor explanations. | The frontend builds. Relevant docs match behavior, fixtures contain no confidential records, and reviewers can follow the workflow and explain its logic. | — / Not Run / — |

## 7. Backend and Database Test Cases

Use isolated test databases with fictional records. Compare pre- and post-operation records, including transaction history, to catch partial writes.

| Case ID | Module and objective | Requirements | Responsible team | Preconditions and test data | Steps | Expected result | Actual result / Status / Evidence or notes |
|---|---|---|---|---|---|---|---|
| DB-01 | Create and retrieve records | FR-003, FR-004, NFR-003 | Backend | Fresh isolated SQLite database. | Create a category and item, then retrieve both after reloading the database session. | Keys and category relationship persist, and derived opening stock is zero until a movement exists. | — / Not Run / — |
| DB-02 | Permitted edits and history protection | FR-003, FR-009, FR-010, FR-013 | Backend | I1 with an opening stock movement. | Edit permitted metadata, then attempt a direct availability edit. | Metadata saves. The quantity edit is rejected and the balance and immutable history still match. | — / Not Run / — |
| DB-03 | Constraints and duplicate rules | FR-004, FR-007, NFR-003 | Backend | Foreign keys enabled, agreed duplicate rules or fictional equivalent. | Try a blank required name, a nonexisting category FK, and agreed duplicate-name variants. | Invalid records are refused without partial changes, and valid distinct records remain retrievable. | — / Not Run / — |
| DB-04 | Receipt and new batch | FR-008, FR-009, FR-010, FR-012 | Backend | I1 exists. Receiving fixture has +40 with an optional expiry. | Commit the receipt and retrieve its batch, allocation, and movement. | One batch and one movement exist for the receipt, allocated +40 to the same item. Availability changes by +40. | — / Not Run / — |
| DB-05 | Usage, wastage, and adjustments | FR-009, FR-010, FR-013 | Backend | Stock replay fixture and approved reason rules. | Apply the negative usage and wastage and both signed adjustments, then query the history. | Each accepted event remains separately traceable with the applicable reason and allocations, and both balances reconcile. | — / Not Run / — |
| DB-06 | Quantity and allocation rejection | FR-009, FR-010, NFR-003 | Backend | I1 has 100 and a second item has its own batch. | Try zero change, wrong sign, an overdraw, cross-item or unequal allocations, and out-of-range scaled values. | Each malformed or insufficient movement leaves the item, batches, and history as they were. | — / Not Run / — |
| DB-07 | Approved archival rules | FR-005, FR-013 | Backend | Zero-balance item with history, item with stock, and category with active items. Confirm safeguards first. | Attempt each archive and then recheck history and references. | Allowed records leave active views. Approved stock and category guards prevent invalid transitions, with history retained. | — / Not Run / — |
| DB-08 | Restart and atomic rollback | FR-010, FR-013, FR-018, NFR-003, NFR-008 | Backend | Disposable SQLite file and controlled failure before a stock transaction commits. | Persist one successful movement, restart the server, then interrupt another write before commit and reopen the database. | Committed data survives restart. Uncommitted stock, allocation, history, and receipt changes are absent. | — / Not Run / — |

## 8. Data Structures and Algorithm Tests

Run every case below with the same fixture inputs and expected outputs in JavaScript and Python. Document the rules used for ties, normalization, and date boundaries.

| Case ID | Module and objective | Requirements | Responsible team | Preconditions and test data | Steps | Expected result | Actual result / Status / Evidence or notes |
|---|---|---|---|---|---|---|---|
| ALG-01 | Search by ID and name | FR-006 | Shared | Known UUIDs plus baseline catalog. | Look up I1 by its UUID. Search names using COFFEE, partial term bean, and an absent term. | Exact ID returns I1 only. Normalized case-insensitive and supported partial name searches find I1. Absent input returns no matches. | — / Not Run / — |
| ALG-02 | Sorting and category grouping | FR-006, FR-011 | Shared | Active catalog copied into one compatible fictional unit group for the numeric ordering check, an empty list, and a copy where Milk and Syrup share a quantity. | Sort by name and quantity, group by category, repeat with equal values, then sort the empty input. | Name order is Chocolate Syrup, Coffee Beans, Milk, Paper Cups. Quantity ascending is 0, 5, 25, 100 in the numeric fixture; ties and groups follow agreed tie-breakers, and empty produces empty. | — / Not Run / — |
| ALG-03 | Duplicate candidates | FR-007, FR-008 | Shared | I1, a case and whitespace variant, and a similar but distinct fictional product under the test uniqueness rules. | Run matching for identical, uppercase, padded, and repeated-space names. Compare relevant attributes for the similar product. | Equivalent names warn before creation, and a legitimate distinct product remains separate. Matching does not change stock or merge records. | — / Not Run / — |
| ALG-04 | Signed stock and zero balance | FR-009, FR-010 | Shared | Stock replay fixture from empty I1. | Apply +100, +40, −30, −10, +5, −5 and the final −100 movement. Attempt one further deduction. | Intermediate amounts are 100, 140, 110, 100, 105, 100, and 0. The last attempt is rejected, each allocation sum matches its movement, and history is preserved. | — / Not Run / — |
| ALG-05 | Low-stock boundaries | FR-011 | Shared | Minimum of 10 with balances 11, 10, 1, and 0. | Classify each balance in JavaScript and Python. | The outputs are sufficient, low stock, low stock, and out of stock respectively. | — / Not Run / — |
| ALG-06 | Expiration boundaries | FR-012 | Shared | Frozen-date fixture, an unset warning period, and the proposed inclusive rule. | Classify each dated, undated, and depleted batch on D, then advance to D+1 and repeat the D batch with warnings unset. | D−1 is expired, D and D+3 are expiring soon, D+4 is not expiring soon, undated has no expiration date, and depleted is excluded. At D+1 the D batch is expired; unset period cannot imply an upcoming warning. | — / Not Run / — |
| ALG-07 | Aggregation and report filters | FR-001, FR-011, FR-013, FR-014 | Shared | Baseline catalog and stock replay movement fixture in separate datasets. | Count active items and statuses in the catalog. Aggregate replay movement quantities by item, unit, and type in a chosen fixture date range. | Active count is 4, sufficient 1, low stock 2, out of stock 1. Movement totals match matching signed entries, exclude filtered records, and keep unlike units separate. | — / Not Run / — |
| ALG-08 | Decimal precision and unit grouping | FR-006, FR-009, FR-010, NFR-003 | Shared | Shared fictional quantity and unit fixtures. | Compare conversions, bounds, rejected wire values, mixed units and deterministic tie results in JavaScript and Python. | Both languages match the fixture. No rounding, reinterpretation, or cross-unit numeric ranking occurs. | — / Not Run / — |
| ALG-09 | Versioned date settings | FR-012, FR-014, FR-015 | Shared | Server settings versions, a lost connection, and calendar boundary fixtures. | Initialize the tablet, classify batches while offline, then announce and load a newer approved version after reconnection. Repeat with warning period unset. | Both environments agree given the same settings. Offline uses the last verified record. Refresh updates settings without replacing inventory or pending work. | — / Not Run / — |

## 9. API Test Cases

Use only the documented versioned routes and schemas. Compare HTTP status and the JSON success or error envelope, including specific error codes.

| Case ID | Module and objective | Requirements | Responsible team | Preconditions and test data | Steps | Expected result | Actual result / Status / Evidence or notes |
|---|---|---|---|---|---|---|---|
| API-01 | Read resources and lists | FR-003, FR-004, FR-006, FR-013 | Backend | Synchronized fixtures and valid UUID routes. | Call GET /api/v1/inventory, GET /api/v1/inventory/{item_id}, GET /api/v1/categories, and GET /api/v1/stock-movements with supported filters and paging. | 200 responses use success and data, list metadata reflects filtered totals, and records match the selected IDs and filters. | — / Not Run / — |
| API-02 | Create and edit item | FR-003, FR-010 | Backend | Existing active category, valid UUIDs, UTC command timestamps, and new operation IDs. | Use POST /api/v1/inventory then PATCH /api/v1/inventory/{item_id} for an allowed field. Attempt a quantity field in another patch. | 201 creates the item, 200 updates metadata, and 422 VALIDATION_ERROR identifies the forbidden field. History and availability are unaffected by the invalid patch. | — / Not Run / — |
| API-03 | Invalid request and missing item | FR-003, NFR-003 | Backend | Known item ID and a different valid unused UUID. | Submit malformed JSON to POST /api/v1/inventory. Request GET /api/v1/inventory/{item_id} with a malformed ID, then the unused valid UUID. | Malformed JSON and path IDs yield 400 INVALID_REQUEST. The absent valid item yields 404 ITEM_NOT_FOUND. All errors use the safe JSON error envelope. | — / Not Run / — |
| API-04 | Missing fields and duplicate | FR-003, FR-007 | Backend | Active category and an item conflicting under agreed duplicate rules. | Use POST /api/v1/inventory with a valid command envelope but no item name, then with a new ID and duplicate item attributes. | Returns 422 VALIDATION_ERROR for a required field and 409 DUPLICATE_ITEM for the approved uniqueness conflict. Neither request creates a record. | — / Not Run / — |
| API-05 | Movement validation and batch reads | FR-009, FR-010, FR-012, FR-013 | Backend | A known item with stock and controlled batch fixtures. | Use POST /api/v1/stock-movements for a valid receipt and usage, then try invalid quantities, bad allocations, and insufficient stock. Retrieve GET /api/v1/inventory/{item_id}/batches. | New direct movements return 201, batch list returns 200, and rejected moves return 422 with INVALID_QUANTITY, INVALID_BATCH_ALLOCATION, or INSUFFICIENT_STOCK as applicable. | — / Not Run / — |
| API-06 | Reporting contract | FR-001, FR-011, FR-012, FR-014 | Backend | Synchronized catalog and separate dated-batch fixture. | Read GET /api/v1/reports/dashboard, GET /api/v1/reports/low-stock, GET /api/v1/reports/expiring, and GET /api/v1/reports/stock-movements with valid filters. | Each returns 200 and the corresponding contract fields, matching counts, dated batches, and movement totals. | — / Not Run / — |
| API-07 | Unavailable service and protected reads | FR-018, FR-019, NFR-004 | Backend | Test outage path; approved test accounts for protected requests when implemented. | Send POST /api/v1/sync during a controlled temporary outage. After service returns, try GET /api/v1/snapshot without a session and with a role lacking access. | Outage provides 503 SYNC_FAILED when a response is possible. Protected requests yield 401 UNAUTHORIZED or 403 FORBIDDEN and disclose no snapshot data. | — / Not Run / — |

## 10. Offline Test Cases

First installation, shell downloads, and local dataset initialization require connectivity. Once initialized, verify essential inventory actions with Flask unreachable.

| Case ID | Module and objective | Requirements | Responsible team | Preconditions and test data | Steps | Expected result | Actual result / Status / Evidence or notes |
|---|---|---|---|---|---|---|---|
| OFF-01 | Initialized app launch and reads | FR-015, NFR-007 | Frontend | First install and data initialization completed online; cached shell and baseline local records. | Disconnect and close the app, then reopen. Inspect network attempts and navigate to Inventory. | Cached app opens and displays local records. Essential reads do not depend on a successful Flask request. | — / Not Run / — |
| OFF-02 | Offline search, filters, and reports | FR-006, FR-011, FR-012, FR-014, FR-015 | Frontend | Initialized offline app and catalog or dated fixture. | Search, filter by category and stock status, sort, and open local reports. | Records, alert counts, and reports match the fixtures without remote calls. | — / Not Run / — |
| OFF-03 | Supported offline create and edit | FR-003, FR-004, FR-016, FR-017 | Frontend | Initialized app disconnected with an eligible local category. | Create a distinct item and edit its minimum using approved fields. | Both changes commit locally and retain separate pending operations in creation order. | — / Not Run / — |
| OFF-04 | Offline receive and use stock | FR-009, FR-010, FR-016, FR-017 | Frontend | Offline app with baseline I1 100 in B1. | Receive +40 in a new batch and record −30 from B1. Inspect local movement, batch, and queue entries. | Balance is 110, with B1 70 and new batch 40. Both movements, allocations, and queue entries are present and pending. | — / Not Run / — |
| OFF-05 | Local rejection and rollback | FR-010, FR-016, FR-017, NFR-003 | Frontend | Initialized offline app and controlled local transaction abort. | Try an invalid movement. For a valid draft, interrupt its IndexedDB write before commit. | Invalid and aborted operations leave the prior balances, history, batches, and queue unchanged. | — / Not Run / — |
| OFF-06 | Persistence after app and tablet restarts | FR-016, FR-017, NFR-008 | Frontend | Offline tablet with an unsynchronized movement. | Close and reopen the app, then reboot the test tablet while disconnected and reopen. | Balances, history, original operation ID, and pending state persist. No event is marked synchronized. | — / Not Run / — |
| OFF-07 | Reconnection and acknowledgment | FR-002, FR-017, FR-018 | Frontend | Initialized app with pending operation and reachable server after reconnection. | Restore connectivity, delay the reply, and compare status before and after the acknowledgment. | The local record remains usable. Queue status changes to synchronized only when a matching persisted acknowledgment arrives. | — / Not Run / — |

## 11. Synchronization and Idempotency Test Cases

Use one active queue drain and one command per request. Record balances, movement and receipt counts, and local state before and after each interruption or replay.

| Case ID | Module and objective | Requirements | Responsible team | Preconditions and test data | Steps | Expected result | Actual result / Status / Evidence or notes |
|---|---|---|---|---|---|---|---|
| SYN-01 | Single operation and receipt | FR-010, FR-017, FR-018, NFR-003 | Shared | One locally committed movement whose dependencies already exist on the server. | Send POST /api/v1/sync once, inspect the committed outcome and receipt, and refresh the tablet. | 200 accepted correlates to the same ID. Stock and receipt commit together, and tablet status changes only after the matching acknowledgment. | — / Not Run / — |
| SYN-02 | Ordered dependent operations | FR-003, FR-004, FR-009, FR-017, FR-018 | Shared | Queue contains category creation, item creation, and receiving stock in that order. | Reconnect and observe one request at a time through POST /api/v1/sync. | Each request follows the preceding successful acknowledgment. Server foreign keys and the final quantity match the local history. | — / Not Run / — |
| SYN-03 | Interruption before acceptance | FR-017, FR-018 | Shared | One pending operation and controlled interruption before server persistence. | Interrupt delivery, inspect SQLite and IndexedDB, reconnect, and resend the original content. | Server stock does not change before accepted delivery. The already committed local balance remains visible. The operation stays pending after interruption and is accepted once upon retry. | — / Not Run / — |
| SYN-04 | Lost response after commit and replay | FR-010, FR-017, FR-018, NFR-003 | Shared | Receipt and stock commit are observable in isolation. The response can be dropped. | Drop the first reply after commit. Retry with the same operation ID and payload. | Tablet shows pending until 200 already_processed returns the original result. Stock, movement count, and receipt count stay unchanged on replay. | — / Not Run / — |
| SYN-05 | Conflicting operation ID | FR-018, NFR-003 | Shared | An accepted receipt for a stock operation. | Submit the same ID with a modified quantity and matching modified allocations to POST /api/v1/sync. | 409 OPERATION_ID_CONFLICT. No new stock, movement, or receipt is recorded. Rejection context is retained for review. | — / Not Run / — |
| SYN-06 | Rejection during a dependency sequence | FR-017, FR-018, NFR-003 | Shared | First queued operation valid, second violates a server rule, and third depends on it. | Synchronize until the second is rejected. Inspect the server, tablet queue, and user message. | Previously accepted work remains committed, rejection is retained as failed, and the later entry stays pending and visibly blocked. Local data is preserved for reconciliation. | — / Not Run / — |
| SYN-07 | Restart during sync | FR-017, FR-018, NFR-008 | Shared | A request in flight with no confirmed reply on the tablet. | Close and reopen the app or reboot in a controlled run, then resume the queue. | The original request remains recoverable and retry-safe. Matching replies determine whether the server accepts it or returns the existing receipt. | — / Not Run / — |
| SYN-08 | Temporary server unavailability | FR-017, FR-018, NFR-003 | Shared | Server temporarily returns 503 or cannot be reached. | Attempt sync, restore the server, and try the normal or manual retry with the original operation ID. | Pending data and retry details survive the outage. Once available, the request completes without duplicate stock effects or silently discarded work. | — / Not Run / — |
| SYN-09 | Reviewed queue repair and resumption | FR-017, FR-018, NFR-003 | Shared | Rejected movement and a dependent command. Authorized repair fixture and verified server records. | Confirm `failed / needs_review`, review affected records and receipts, approve a corrected command, and revalidate dependents. Resume in revised sequence. | The original ID, payload, error, and history survive as `resolved_replaced` with an audit link. The corrected command has a new ID and commits once. Recheck a reviewed closure using `resolved_closed`. | — / Not Run / — |
| SYN-10 | Exclusive ownership across contexts | FR-017, FR-018, NFR-003, NFR-007 | Shared | Installed app and browser tab on intended test origin with a pending queue. | Start drains from both contexts, close the lock holder during one request, and repeat with the lock unavailable. | Only one owner sends one request at a time. The new owner retries the unacknowledged ID safely. With no reliable lock, uploads pause and local work stays available. | — / Not Run / — |
| SYN-11 | Canonical commands across implementations | FR-007, FR-010, FR-018, NFR-003 | Shared | Fictional shared command fixtures and isolated server with receipts. | Compare validation and normalized inputs in JavaScript and Python. Submit equivalent direct and sync commands, then submit a materially changed command with the same ID. | Equivalent forms use the original receipt, and the changed command gives 409 OPERATION_ID_CONFLICT. Required quantities and matching behavior agree. | — / Not Run / — |

## 12. Backup and Recovery Test Cases

Backups and restore tests use disposable fixtures only. Hosting, retention, and authorization remain pending. Preserve existing local data and never clear real inventory to simulate loss.

| Case ID | Module and objective | Requirements | Responsible team | Preconditions and test data | Steps | Expected result | Actual result / Status / Evidence or notes |
|---|---|---|---|---|---|---|---|
| BAK-01 | Authorized backup and metadata | FR-019, NFR-004, NFR-008 | Backend | Isolated inventory database with accepted receipts and approved test backup role and procedure. | Create a protected backup and check its recorded metadata. Attempt access with a disallowed test role. | Supported inventory and receipts are captured together. Metadata includes schema version, timestamp, integrity verification and last success; unauthorized access is denied. | — / Not Run / — |
| BAK-02 | Verified restore | FR-010, FR-013, FR-019, NFR-008 | Backend | Verified backup and disposable restore target. | Restore, compare item and batch balances, allocations, history, and receipts, then replay an accepted command. | Data matches the verified backup and replay does not change stock. | — / Not Run / — |
| BAK-03 | Invalid backup | FR-019, NFR-008 | Backend | Disposable copy with invalid integrity data or unsupported schema. | Attempt verification and an isolated restore using the approved procedure. | Invalid artifact is rejected, a useful error is recorded, and the target is unaffected. | — / Not Run / — |
| BAK-04 | Local loss and pending-work protection | FR-017, FR-019, NFR-008 | Shared | Dedicated test profile with simulated storage loss, plus a separate profile with pending work and an approved recovery procedure. | Initialize the cleared test profile from GET /api/v1/snapshot. Try recovery on the profile with pending work and compare pre-recovery operations. | A consistent supported dataset restores to the empty profile. Recovery warns and protects or explicitly reconciles pending work before replacement. Unbacked unsynchronized changes are identified as potentially unrecoverable. | — / Not Run / — |
| BAK-05 | Restore from an older server generation | FR-017, FR-018, FR-019, NFR-008 | Shared | Older verified backup, newer acknowledged commands and pending tablet work, and authorized recovery fixture. | Restore and rotate generation. Attempt normal sync, compare individual receipts, verify balances and history, then perform authorized reconciliation and resume. | Normal sync pauses before mutation. Missing accepted operations are flagged individually. Pending work and newer local data are protected, and resumed work follows the reviewed reconciliation. | — / Not Run / — |
| BAK-06 | Failed backup and last-success display | FR-019, NFR-008 | Shared | One verified backup with visible timestamp. Controlled failure during the next attempt. | Trigger the failure and inspect server metadata and the tablet display before and after refresh. | A clear failure is visible. The last successful backup still shows the previous verified time. | — / Not Run / — |

## 13. Android Tablet and PWA Test Cases

A simulated viewport can find layout issues early, but real-device sign-off requires the intended physical tablet. Its model, browser, dimensions, and Android version remain unconfirmed.

| Case ID | Module and objective | Requirements | Responsible team | Preconditions and test data | Steps | Expected result | Actual result / Status / Evidence or notes |
|---|---|---|---|---|---|---|---|
| TAB-01 | Initial load, installation, and launch | FR-015, NFR-007 | Shared | Intended tablet, recorded Android/browser versions, HTTPS test origin, and connectivity. | Open a fresh profile, initialize data, install where supported, and launch from the home screen. | Initial downloads complete while connected. Installed app opens at the expected origin with the initialized records. | — / Not Run / — |
| TAB-02 | Orientation, touch, and keyboard | NFR-001, NFR-007 | Shared | Real tablet and fictional inventory. | Rotate between landscape and portrait, navigate and scroll lists, and enter amounts using the Android keyboard. | Both layouts retain readable content, visible actions, usable controls, and a usable form when the keyboard is shown. | — / Not Run / — |
| TAB-03 | Offline startup and reconnect | FR-015, FR-017, FR-018, NFR-007, NFR-008 | Shared | Installed and initialized test app with a pending operation. | Disable connectivity, restart the app and tablet, confirm local records, then reconnect and inspect sync. | The cached shell and local data survive, queue state persists, and synchronization resumes with one confirmed stock effect. | — / Not Run / — |
| TAB-04 | Safe application update | FR-015, FR-017, NFR-007, NFR-008 | Shared | Two compatible test releases and a queued operation on the older one. | Apply the later release through the normal update path, including a test migration if the schema changes, then reopen and sync. | The app launches with the correct shell. IDs, stock history, and pending payloads survive the update and remain usable. | — / Not Run / — |
| TAB-05 | Replay after an app update | FR-015, FR-017, FR-018, NFR-007, NFR-008 | Shared | An accepted command with lost acknowledgment, open old context, and approved new shell/schema. | Update, close or coordinate the old context, reopen on the new version, and retry the pending command. | Upgrade preserves the original payload and comparison profile. The current owner receives the original receipt. No new stock movement appears. | — / Not Run / — |

## 14. Performance Test Cases

Capture build, device and browser, dataset size and composition, connectivity, measurement method, and repeated timings. Agree on measurable targets during testing with representative workloads.

| Case ID | Module and objective | Requirements | Responsible team | Preconditions and test data | Steps | Expected result | Actual result / Status / Evidence or notes |
|---|---|---|---|---|---|---|---|
| PERF-01 | Startup, search, sorting, and filtering | FR-006, NFR-002, NFR-007 | Shared | Small, medium, and larger fictional datasets and target tablet when available. | Record connected and offline startup, then time name search, sorting, and filtering at each size. Log environment and run conditions. | Results stay correct as size changes. Actual timings, network use, and any responsiveness issues are recorded for agreed target-setting. | — / Not Run / — |
| PERF-02 | Dashboard and local reads and writes | FR-001, FR-010, FR-014, NFR-002 | Shared | Same fictional dataset sizes and known movement histories. | Measure dashboard calculation, IndexedDB reads, and atomic stock writes with developer tooling. | Counts and balances remain correct. Measurements identify expensive steps and show whether essential work runs without network round trips. | — / Not Run / — |
| PERF-03 | Synchronization queue throughput | FR-018, NFR-002 | Shared | Different fictional queue lengths and controlled connectivity. | Measure queue drain time, retries, and tablet responsiveness while processing dependent operations. | One ordered request at a time preserves results and the report records actual measurements and bottlenecks. | — / Not Run / — |

## 15. Security and Privacy Test Cases

Keep tests in controlled environments, using fictional records, approved access rules, and test credentials.

| Case ID | Module and objective | Requirements | Responsible team | Preconditions and test data | Steps | Expected result | Actual result / Status / Evidence or notes |
|---|---|---|---|---|---|---|---|
| SEC-01 | Validation and safe errors | FR-010, NFR-003, NFR-004 | Backend | Isolated API and ordinary test inputs with invalid types, missing values, or out-of-range quantities. | Submit invalid requests and review status, response, and test logs. | Requests are rejected safely. No credentials, raw database errors, or stack traces reach the client. | — / Not Run / — |
| SEC-02 | Administrative and backup restrictions | FR-019, NFR-004 | Backend | Approved test roles, recovery approval, and backup procedures. | Compare allowed and disallowed administrative, export, and recovery actions using test accounts. | Only approved roles can perform protected actions. Unauthorized requests disclose no data. | — / Not Run / — |
| SEC-03 | HTTPS and credential handling | NFR-004, NFR-005 | Backend | Test deployment, fictional secret values, and approved authentication if implemented. | Verify HTTPS for deployed requests. Review configuration, repository, fixtures, snapshots, and logs. Check password handling if relevant. | Sensitive values are excluded from the repository, API errors, and snapshots. Test data is fictional or anonymized, and passwords are not stored in plaintext. | — / Not Run / — |
| SEC-04 | Offline access policy | FR-016, NFR-004 | Backend | Approved offline access policy and isolated authorized and restricted staff scenarios. | Coordinate with frontend to disconnect the tablet and repeat approved ordinary and administrative actions, including the agreed disconnected session behavior. | Allowed local tasks work and restricted actions follow the approved policy. Staff attribution, if implemented, matches the policy. | — / Not Run / — |

## 16. User Acceptance Testing

Observe the owner's or authorized staff member's practical exercise without coaching unless needed. Record navigation ease, clarity of information, ease of recording movements, perceived quantity accuracy, alert usefulness, satisfaction, and suggested improvements. Where practical, measure the same tasks in the manual process and the test application under comparable conditions before reporting any change.

| Case ID | Module and objective | Requirements | Responsible team | Preconditions and test data | Steps | Expected result | Actual result / Status / Evidence or notes |
|---|---|---|---|---|---|---|---|
| UAT-01 | Open, find, and add | FR-003, FR-004, FR-006, NFR-001 | Shared | Authorized café participant, initialized test tablet, and fictional catalog. | Ask the participant to open the app, find an ingredient, and create a distinct item. | Participant can complete each task and locate the created record. Record assistance requested and observed confusion. | — / Not Run / — |
| UAT-02 | Receive and use stock | FR-008, FR-009, FR-010, FR-013, NFR-001 | Shared | Authorized participant and item with known balance. | Ask the participant to receive additional stock for the item, record usage, and review its transaction history. | Balance matches expected quantities and the participant can explain the history and confirmation messages. | — / Not Run / — |
| UAT-03 | Review restocking and expiration | FR-011, FR-012, FR-014, NFR-001 | Shared | Fictional low, out-of-stock, and expiring data, with agreed live alert behavior for final validation. | Ask the participant to identify a restocking need, review an expiration warning, and identify the relevant record. | Participant locates and interprets both alerts using the text and shown data. | — / Not Run / — |
| UAT-04 | Work offline and confirm sync | FR-015, FR-016, FR-017, FR-018, NFR-001 | Shared | Initialized tablet, reachable test server before disconnection, and one valid action. | Ask the participant to perform the action offline, explain its pending state, reconnect, and identify server confirmation. | Local work is usable and preserved, participant can distinguish pending from synchronized, and stock changes once. | — / Not Run / — |
| UAT-05 | Demonstrate the first vertical slice | FR-003, FR-004, FR-009, FR-010, FR-013, FR-016, FR-017, FR-018 | Shared | Fictional 20-piece receipt and 5-piece usage fixture, initialized tablet and test Flask server. | Create a category and item, receive 20, use 5, restart, then sync in order and repeat an accepted operation after a simulated lost acknowledgment. | Derived availability is 15 locally and on the server. History survives restart and a retry has no second stock effect. | — / Not Run / — |

## 17. Bug Reporting Template

| Field | Entry |
|---|---|
| Bug ID | |
| Reporter | |
| Affected module and case ID | |
| Severity | |
| Environment and build | |
| Preconditions | |
| Steps to reproduce | |
| Expected behavior | |
| Actual behavior | |
| Screenshot or other evidence | |
| Assigned team | |
| Resolution status | |
| Retest result | |

| Severity | Definition and release impact |
|---|---|
| Critical | Incorrect inventory balances, lost accepted or queued transactions, duplicate stock deductions, unsafe recovery, or unauthorized disclosure of sensitive records. Blocks release. |
| High | Essential workflow, offline operation, or tablet usability fails without a safe workaround. Blocks the affected release or café evaluation. |
| Medium | A noncritical workflow is impaired and has a safe workaround. Document the impact and get a release decision. |
| Low | Minor visual or wording issue with no material effect on correctness, safety, or task completion. Track for follow-up. |

Report evidence using fictional data and remove any credentials. Critical and high failures require correction and a successful retest before sign-off.

## 18. Testing Responsibilities

| Owner | Responsibilities |
|---|---|
| Frontend | Verify interface, layout, accessibility, JavaScript algorithms, local validation, IndexedDB transactions and queue persistence, offline interaction, and tablet compatibility. Record build results. |
| Backend | Verify Python algorithms, SQLAlchemy and SQLite behavior, API contracts, server validation, operation receipts, retry handling, access control, and backup or recovery. |
| Shared | Maintain shared fixtures, validate equivalent rules, run integration and end-to-end scenarios, and support real Android testing and café acceptance sessions. |
| Project leader | Coordinate testing and café participation, review evidence, track defects and unresolved decisions, and organize final validation and sign-off. |

## 19. Release Acceptance Criteria

### Classroom prototype

A classroom demo can use fictional records to show implemented workflows and explain data structures and algorithms. Report observed results, mock behavior, and gaps, including device or network limitations. Prototype evidence is separate from readiness for café evaluation.

### Ready for café evaluation

- Core inventory workflows work end to end. Duplicate warnings, searches, category and quantity views, and history behave as specified.
- Stock balances reconcile with movements and batch allocations. Invalid actions leave data intact. Low-stock and approved expiration indicators match the records.
- Essential inventory work remains available offline after initialization. Local data and pending operations survive restarts and safe updates.
- Synchronization preserves accepted and rejected operations, confirms persistence before marking completion, and applies each accepted stock movement once even after retry.
- A protected restoration is verified in isolation, including balances, history, and receipts. Pending tablet data is protected during recovery.
- The application is usable on the actual Android tablet in landscape and portrait, with installation checked where supported. The evaluation uses a controlled environment and authorized staff.
- The project leader reviews results and open items. No release-blocking defects or unverified critical workflows remain.

### Ready for production use

Require completed café acceptance, verified HTTPS deployment, approved staff permissions and offline access, confirmed backup ownership, retention and recovery authorization, and verified operational recovery. Agree on representative performance targets and review measured results before production sign-off.

| Pending decision or prerequisite | Acceptance affected |
|---|---|
| Actual categories and representative item records, approved units and precision, price basis, and duplicate or archive policies | Final FR-003 through FR-008 record and workflow checks. Fictional calculations and supported-field checks can proceed. |
| Batch selection, handling of damaged or wasted stock, reason and attribution rules | Final FR-009 and FR-010 movement acceptance. Explicit fictional allocations can be tested independently. |
| Item thresholds, expiration warning period and date boundaries | Final FR-011 and FR-012 alert acceptance and derived FR-001 and FR-014 reports. Boundary fixtures can run under labeled test rules. |
| Staff permissions, authentication, offline access, and recovery authorization | NFR-004 verification for protected operations and approved access under FR-016 and FR-019. |
| Hosting, outage expectations, queue repair, and backup retention and ownership | Final FR-018, FR-019, NFR-004, and NFR-008 operational and recovery sign-off. |
| Actual tablet, browser and Android version, representative workload, and measured performance targets | Final NFR-001, NFR-002, and NFR-007 device and performance acceptance. |

See [Open Decisions](OPEN_DECISIONS.md) for owners and gates. Keep every proposed case **Not Run** until it is performed.

## 20. Requirements Traceability and Test Summary

The matrix shows planned coverage. Shared cases require both teams to verify their parts. Conditional Stage 2 requirements are listed for traceability and have no MVP test cases.

| Requirement | Related cases | Responsible team | Coverage | Execution status |
|---|---|---|---|---|
| FR-001 — Dashboard counts | FE-03, FE-07, ALG-07, API-06, PERF-02 | Frontend, Shared, Backend | Planned MVP | Not Run |
| FR-002 — Recent activity and status | FE-03, FE-08, OFF-07 | Frontend | Planned MVP | Not Run |
| FR-003 — Inventory records | FE-04, FE-05, DB-01, DB-02, API-01, API-02, API-03, API-04, OFF-03, SYN-02, UAT-01, UAT-05 | Frontend, Backend, Shared | Planned MVP | Not Run |
| FR-004 — Categories | FE-04, DB-01, DB-03, API-01, OFF-03, SYN-02, UAT-01, UAT-05 | Frontend, Backend, Shared | Planned MVP | Not Run |
| FR-005 — Item archival | FE-05, DB-07 | Frontend, Backend | Planned MVP | Not Run |
| FR-006 — Search, sorting, and filtering | FE-03, FE-07, ALG-01, ALG-02, ALG-08, API-01, OFF-02, PERF-01, UAT-01 | Frontend, Shared, Backend | Planned MVP | Not Run |
| FR-007 — Duplicate detection | FE-04, DB-03, ALG-03, API-04, SYN-11 | Frontend, Backend, Shared | Planned MVP | Not Run |
| FR-008 — Receiving against an existing item | FE-04, DB-04, ALG-03, UAT-02 | Frontend, Backend, Shared | Planned MVP | Not Run |
| FR-009 — Stock movements | FE-06, DB-02, DB-04, DB-05, DB-06, ALG-04, ALG-08, API-05, OFF-04, SYN-02, UAT-02, UAT-05 | Frontend, Backend, Shared | Planned MVP | Not Run |
| FR-010 — Stock validation and atomicity | FE-05, FE-06, DB-02, DB-04, DB-05, DB-06, DB-08, ALG-04, ALG-08, API-02, API-05, OFF-04, OFF-05, SYN-01, SYN-04, SYN-11, BAK-02, PERF-02, SEC-01, UAT-02, UAT-05 | Frontend, Backend, Shared | Planned MVP | Not Run |
| FR-011 — Low-stock monitoring | FE-03, ALG-02, ALG-05, ALG-07, API-06, OFF-02, UAT-03 | Frontend, Shared, Backend | Planned MVP | Not Run |
| FR-012 — Expiration tracking | FE-03, DB-04, ALG-06, ALG-09, API-05, API-06, OFF-02, UAT-03 | Frontend, Backend, Shared | Planned MVP | Not Run |
| FR-013 — Movement history | FE-06, DB-02, DB-05, DB-07, DB-08, ALG-07, API-01, API-05, BAK-02, UAT-02, UAT-05 | Frontend, Backend, Shared | Planned MVP | Not Run |
| FR-014 — Inventory reports | ALG-07, ALG-09, API-06, OFF-02, PERF-02, UAT-03 | Shared, Backend, Frontend | Planned MVP | Not Run |
| FR-015 — Offline launch and reads | ALG-09, OFF-01, OFF-02, TAB-01, TAB-03, TAB-04, TAB-05, UAT-04 | Shared, Frontend | Planned MVP | Not Run |
| FR-016 — Offline writes | OFF-03, OFF-04, OFF-05, OFF-06, SEC-04, UAT-04, UAT-05 | Frontend, Backend, Shared | Planned MVP | Not Run |
| FR-017 — Persistent queue and visible states | FE-08, OFF-03, OFF-04, OFF-05, OFF-06, OFF-07, SYN-01, SYN-02, SYN-03, SYN-04, SYN-06, SYN-07, SYN-08, SYN-09, SYN-10, BAK-04, BAK-05, TAB-03, TAB-04, TAB-05, UAT-04, UAT-05 | Frontend, Shared | Planned MVP | Not Run |
| FR-018 — Ordered and idempotent synchronization | FE-08, DB-08, API-07, OFF-07, SYN-01, SYN-02, SYN-03, SYN-04, SYN-05, SYN-06, SYN-07, SYN-08, SYN-09, SYN-10, SYN-11, BAK-05, TAB-03, TAB-05, PERF-03, UAT-04, UAT-05 | Frontend, Backend, Shared | Planned MVP | Not Run |
| FR-019 — Backup and restore | API-07, BAK-01, BAK-02, BAK-03, BAK-04, BAK-05, BAK-06, SEC-02 | Backend, Shared | Planned MVP | Not Run |
| FR-020 — Menu management | — | Pending Stage 2 approval | Conditional Stage 2 | — |
| FR-021 — Orders | — | Pending Stage 2 approval | Conditional Stage 2 | — |
| FR-022 — Sales recording | — | Pending Stage 2 approval | Conditional Stage 2 | — |
| FR-023 — Sales reports | — | Pending Stage 2 approval | Conditional Stage 2 | — |
| FR-024 — Top-selling reports | — | Pending Stage 2 approval | Conditional Stage 2 | — |
| FR-025 — Recipe deductions | — | Pending Stage 2 approval | Conditional Stage 2 | — |
| NFR-001 — Usability | FE-01, FE-02, FE-07, FE-09, TAB-02, UAT-01, UAT-02, UAT-03, UAT-04 | Frontend, Shared | Planned MVP | Not Run |
| NFR-002 — Performance | PERF-01, PERF-02, PERF-03 | Shared | Planned MVP | Not Run |
| NFR-003 — Reliability and data integrity | DB-01, DB-03, DB-06, DB-08, ALG-08, API-03, OFF-05, SYN-01, SYN-04, SYN-05, SYN-06, SYN-08, SYN-09, SYN-10, SYN-11, SEC-01 | Backend, Shared, Frontend | Planned MVP | Not Run |
| NFR-004 — Security and privacy | API-07, BAK-01, SEC-01, SEC-02, SEC-03, SEC-04 | Backend | Planned MVP | Not Run |
| NFR-005 — Confidential development data | FE-10, SEC-03 | Frontend, Backend | Planned MVP | Not Run |
| NFR-006 — Maintainability | FE-10 | Frontend | Planned MVP | Not Run |
| NFR-007 — Tablet and PWA compatibility | FE-01, FE-02, FE-09, OFF-01, SYN-10, TAB-01, TAB-02, TAB-03, TAB-04, TAB-05, PERF-01 | Frontend, Shared | Planned MVP | Not Run |
| NFR-008 — Recoverability | DB-08, OFF-06, SYN-07, BAK-01, BAK-02, BAK-03, BAK-04, BAK-05, BAK-06, TAB-03, TAB-04, TAB-05 | Backend, Frontend, Shared | Planned MVP | Not Run |

### Final testing summary template

| Measure | Recorded count |
|---|---|
| Total tests | |
| Passed | |
| Failed | |
| Blocked | |
| Not Run | |
| Not Applicable | |
