# BE-09B backend integrity remediation

The remediation starts from PR #21 at 10225691159f05d854adeebcde942822335649a7. It preserves the published, disconnected FE-09B adapter and adds an explicit v2 candidate for joint protocol review.

## Historical corrections retained

- V1 keeps the original four-field acknowledgment and schema-1 snapshot. V2 owns commitment and replay metadata. V1 snapshot display order supplies no stock replay order.
- Receipt identity uses a canonical operation UUID, the separate canonical entity UUID, and fingerprint profile 1:/api/v1. V1, v2, and the direct mutation routes share the same command and idempotency rules.
- SQLite migrations add independent receipt columns in one transaction. Original receipts and stock rows stay intact. The migration preserves native PR #18 positions and distinguishes historical timestamp estimates.
- Item and batch totals use checked Python integers. Write validation checks the affected batch balances and resulting item balance before commit. A historical report aggregate outside the wire-safe range returns 422 even if every present-day balance is safe.

## Independent R3 findings and C3 corrections

| Fixture and observed failure | Correction and regression |
| --- | --- |
| A withdrawal, its allocation, and its saved result were changed from −5 to −6. The unchanged request fingerprint still accompanied an authoritative snapshot. | Persist the canonical command and a checksum that binds the command, original result, identity, time, and sequence. Verify the saved command against its original fingerprint and the committed stock effects. The coordinated-damage regression requires a recovery response on snapshot and retry. |
| Deleting the final catalog receipt made the last sequence fall and let a new command reuse it. | Maintain a separate committed ledger head. Check continuity through that head before mutation. Tail tests cover both catalog and movement receipts across restart, including attempts to write after the loss. |
| A stored catalog result containing only its entity UUID was acknowledged successfully. | Validate exact result fields, types, canonical IDs, timestamps, safe quantities, and relationships to the submitted or saved command. The tests cover missing, extra, wrongly typed, and contradictory fields for all seven command types. |
| Swapping a withdrawal and its supplying receipt blocked the snapshot but still produced a verified retry. | Snapshot and delivery use one integrity gate. Chronological verification checks every item and batch prefix and explicit batch introduction. The order test updates checksums after tampering with positions so the chronological check is exercised independently. |
| Two different batches in one command used the same allocation ID and returned 500. | Reject duplicate canonical allocation IDs before insertion with 409 RESOURCE_CONFLICT. Regressions cover identical and case-equivalent input, an existing allocation collision, and a valid multi-batch command. |
| Superscript digits and a 5,000-digit dashboard limit returned 500. | Bound the input before integer conversion. The default is 5, the range is 1–25, and the route accepts at most two ASCII digits. Repeated and invalid limits return 400 INVALID_REQUEST. |
| A missing batch or allocation returned 422 when reading a snapshot. | Structural stock and relationship failures return 409 RECOVERY_REQUIRED in both snapshot versions. Regressions cover missing rows, dangling relationships, inconsistent quantities, and valid empty and populated snapshots. |

## Shared stock integrity boundary

Item, inventory and batch reads, dashboards, low-stock and expiration reports,
movement listings, movement detail, movement totals, and both snapshot versions
verify the same ledger before building their responses. The verifier reads a
single SQLite transaction and uses exact Python integers. It reconciles every
movement with its full allocation set, including allocations to sibling batches,
then checks the relationships, quantities, receipt links, and batch introductions.
Filtering, report aggregation, and pagination operate on that same database
snapshot. Missing allocation evidence requires reconciliation. The backend does
not estimate a balance from surviving data. Catalog-only category endpoints and
health do not report stock quantities.

This verification scans the retained ledger for each request and reads no cached
proof. Its work and memory grow with the number of records and allocations.
Receipt positions are sorted for chronological verification. This approach is
intended for the current single-tablet dataset.

## Chronological acceptance and the ledger head

A new operation stores the canonical command, its original fingerprint, the
original result, and a SHA-256 checksum binding those fields to the receipt
identity, processed time, and position. Stock receipts match their canonical
allocations, retained movement and allocation rows, and any batches introduced
by that command. The batch check includes the received amount, item, time,
purchase details, and expiration date.

A fresh ledger replays all seven command types in commit order, starting from
empty state. Each item needs an active category, each stock movement needs an
active item, and each allocation needs an introduced batch. An update or archive
needs previously created catalog state. The replay checks the existing duplicate,
unit change, and archive rules. It matches a catalog result against the fields
and stock balance at that position, including fields the command did not change.
An idempotent archive preserves the prior archived result. The final catalog and
balances must reconcile with current records. Equal or backward event timestamps
are valid because the sequence tracks commit order.

SQLite uses `BEGIN IMMEDIATE` for writes. The inventory mutation, processed
receipt, and committed ledger-head update share one transaction. A failed flush
or commit advances nothing. Each writer allocates the next position only after
checking continuity through the retained head. A missing head, missing or
duplicate position, invalid receipt, or proven contradiction requires recovery.
An already upgraded database cannot rebuild a missing head at startup.

## Provisional migration history

A pre-C3 upgrade preserves old receipt bytes and inventory rows. Its highest
surviving position provides the starting watermark. Historical timestamps and
native positions, including those from PR #18, cannot establish completeness or
prove the order of the older business events. Historical receipts omit the
canonical command and can lack purchase and expiration details for introduced
batches. The verifier establishes boundary stock from the surviving legacy
movements and corroborated allocations. It uses retained creation, update, and
archive results to constrain the possible catalog state at that boundary.

Operations accepted after migration have canonical commands and a fixed order.
The same verifier checks every deterministic dependency in that suffix, starting
from the legacy boundary facts. Later operations can rule out incompatible
boundary facts. A withdrawal before its recorded batch introduction, an item
before its new category, or a movement before its new item requires recovery.
Reads and exact retries are available on a coherent provisional ledger. New
writes remain subject to the ordinary business rules and the shared integrity
check. The complete replay stays provisional, and the API withholds sequence
numbers and blocks v2 installation. An older missing receipt that leaves no
detectable gap or contradictory state can still escape detection.

## Wire compatibility and recovery

The approved shared API contract specifies v1. The following v2 semantics are
the backend proposal for joint protocol review. V1 successful response fields
remain unchanged.

| Route or state | Response |
| --- | --- |
| Stock-dependent operational reads | HTTP 200 with the existing v1 shapes on verified or coherent provisional history. Proven persisted corruption returns `409 RECOVERY_REQUIRED`. |
| V1 sync | Six-field command and a successful acknowledgment with exactly `operation_id`, `outcome`, `processed_at`, and `result`. |
| V1 snapshot | HTTP 200 with schema 1 and its original display order on verified or coherent provisional history. That order does not certify replay. |
| V2 sync | The same command and operation namespace. A verified acknowledgment adds its `commit_seq` and `replay_status: "verified"`. A coherent provisional acknowledgment reports `commit_seq: null` and `replay_status: "provisional"`. |
| V2 verified snapshot | HTTP 200 with schema 2, `replay.status: "authoritative"`, `replay.order: "commit_seq"`, and `installation_blocked: false`. An empty verified ledger has no last commit. |
| V2 coherent provisional snapshot | HTTP 200 with schema 2, `replay.status: "provisional"`, `replay.order: null`, and `installation_blocked: true`. Last-commit markers and per-operation sequences are null. |
| Proven corruption on either snapshot or sync version | HTTP 409 with `success: false` and `error: {code: "RECOVERY_REQUIRED", message: "Inventory history requires reconciliation.", details: {}}`. The response contains no snapshot, receipt result, or rejected outcome. |
| Malformed snapshot query | `400 INVALID_REQUEST`. Parse up to 100 UUIDs before inspecting stock history. |
| Temporary SQLite unavailability | `503 SYNC_FAILED` with `Retry-After`. |

Omitting `receipt_id`, requesting valid IDs, or requesting valid but absent IDs
uses the same global integrity decision. On a successful snapshot, a receipt
check describes the requested ID as accepted with its original processed time,
or missing with nulls. A generation mismatch pauses delivery under the v1
contract. A new command rejected for invalid input or an unsafe resulting
quantity leaves all rows and the head unchanged. A historical report aggregate
outside the wire-safe range still returns `422 VALIDATION_ERROR` even when the
underlying ledger and current balances are sound.

## Protected recovery evidence

Checksums and the ledger head can detect inconsistent changes in the retained
database. A coordinated rewrite of all evidence, or restoration of an older
complete database, can evade database-internal verification. Recovery requires
an independently protected backup or audit checkpoint and authorized generation
rotation after restoration. Ownership and storage protection remain open.

The v2 metadata describes backend evidence. Connected initialization, automatic
sync, and snapshot installation remain disabled. A future authorized workflow
must reconcile pending operation IDs and validate the snapshot before it
installs data into a separate dataset.
