# Team Delegation and Collaboration

This plan assigns work to the frontend and backend teams for the Fulfil Cafe Inventory and Operations Management System. It follows the [project plan](PROJECT_PLAN.md), [requirements](REQUIREMENTS.md), [architecture](ARCHITECTURE.md), [database design](DATABASE_DESIGN.md), [API contract](API_CONTRACT.md), and [repository guidance](../AGENTS.md). The project leader will assign individuals and dates once team availability and project dependencies are clear.

## 1. Team Organization

- **Project leader** — Coordinates planning, delegation, progress, integration, and communication with Fulfil Cafe. Name: ____________________
- **Frontend Development Team** — Owns the tablet experience and local application behavior. Members: ____________________
- **Backend Development Team** — Owns server validation, synchronized data, and recovery support. Members: ____________________

## 2. Project Leader Responsibilities

- Keep the inventory MVP within the agreed scope. Assign tasks, monitor dependencies, and track progress.
- Review significant architecture decisions, resolve disagreements, and coordinate changes that affect both teams.
- Communicate with Fulfil Cafe and record confirmations or open questions in the relevant project document.
- Organize integration sessions and coordinate reviews of pull requests and completed deliverables.
- Coordinate testing, the café validation session, and the project defense. Ask each contributor to explain their implementation and show the evidence supporting it.

## 3. Frontend Team Responsibilities

The frontend team owns all FE work packages below. Demo layouts may use labeled fictional data. Completion criteria for functional packages refer to working behavior.

| ID | Work package and scope | Expected deliverable | Prerequisites | Completion criteria | Related requirements |
|---|---|---|---|---|---|
| FE-01 | **UI/UX Design** — Define tablet-first layouts, navigation, information hierarchy, reusable components, and touch behavior. | Wireframes and interface patterns. | MVP workflows and tablet-first scope. | A walkthrough covers key inventory tasks, navigation, and touch controls. Both teams review fields that affect the contract. | NFR-001, NFR-007 |
| FE-02 | **Frontend Foundation** — Maintain Vite, configure locally bundled Bootstrap 5, and organize source, reusable styles, navigation, and page layouts. | Buildable frontend shell and reusable layout. | Existing Vite project. Use FE-01 patterns as they become available. | The shell builds, pages share navigation and styles, and essential assets are available locally. | NFR-001, NFR-006 |
| FE-03 | **Dashboard** — Present inventory summaries, stock and expiration warnings, recent movements, connectivity, and synchronization status. | Dashboard with local summaries and status indicators. | FE-02, FE-07, FE-08. Mock layout can start with FE-01. | Counts and movements match fixtures, and status indicators reflect actual local and synchronization states. | FR-001, FR-002, FR-011, FR-012 |
| FE-04 | **Inventory Management Interface** — Build listings, item detail, add and edit forms, category management, search, sorting, filters, duplicate warnings, and archive confirmation. | Tablet inventory and category workflows. | FE-02, FE-07, FE-08. Confirm duplicate and archival rules for final behavior. | Supported item and category workflows operate against local records, show validation clearly, and preserve archived history. | FR-003, FR-004, FR-005, FR-006, FR-007, FR-008 |
| FE-05 | **Stock Management Interface** — Receive stock, record usage or wastage, perform authorized adjustments, and show confirmations, errors, and transaction history. | Stock forms and movement history views. | FE-02, FE-07, FE-08. Agree on quantity, batch, and authorization rules. | Valid movements update stock and history once, and invalid input leaves stock intact with useful feedback. | FR-009, FR-010, FR-013 |
| FE-06 | **Reports and Monitoring** — Show inventory, low-stock and expiration reports, and movement summaries using suitable tables and indicators. | Local report pages and filters. | FE-02, FE-07, FE-08. Confirm expiration rules for live alerts. | On-screen summaries match shared fixtures and essential reports remain usable offline. | FR-011, FR-012, FR-013, FR-014 |
| FE-07 | **Local Application Logic** — Implement JavaScript validation, searching, sorting, duplicate checks, stock calculations, and classifications. | Testable local inventory rules. | Agreed data model and business rules with BE-05. Either team can start from shared fictional fixtures. | The JavaScript results match the Python results for the same inputs and rejecting cases. | FR-006, FR-007, FR-010, FR-011, FR-012, FR-016, NFR-003 |
| FE-08 | **IndexedDB and Offline Operations** — Store local records, commit stock and history atomically with the queue, retain pending work across restarts, and expose offline and sync states. | Local repositories, transaction workflows, and persistent queue. | Agreed database model and operation schema. FE-07 validation for end-to-end writes. | Offline writes persist across restart. An aborted save leaves no partial stock, history, or queue records. | FR-015, FR-016, FR-017, NFR-003, NFR-008 |
| FE-09 | **API Integration** — Build the API client, handle responses and errors, send one queued operation at a time in sequence, and map accepted, rejected, and pending work to visible states. | Reusable JSON client and ordered sync integration. | Agreed API schema for mocks, FE-08 for queue integration, BE-06 and BE-07 for live integration. | Acknowledgments match the queued ID. Lost replies and failed dependencies preserve local records. Daily actions use the queue to avoid a second submission through direct mutations. | FR-002, FR-017, FR-018 |
| FE-10 | **PWA and Tablet Compatibility** — Provide the manifest, Service Worker, offline app shell, installation, and safe update handling. | Installable web app and target-tablet verification notes. | FE-02, FE-08, actual Android tablet and suitable HTTPS test origin. | Verify installation where supported. Test offline startup and restarts separately, and verify an update preserves data and pending work. | FR-015, NFR-007, NFR-008 |
| FE-11 | **Frontend Testing** — Verify builds, layout, touch, form validation, search, sorting, inventory, and offline workflows. | Frontend test evidence and known limitations. | Shared test scenarios, implemented workflows, and tablet access for device tests. | Record build output and performed checks with results, including offline operation and restart when implemented. | NFR-001, NFR-003, NFR-007, NFR-008 |

## 4. Backend Team Responsibilities

The backend team owns all BE work packages below. Apply server-side validation even when the tablet has already checked an operation.

| ID | Work package and scope | Expected deliverable | Prerequisites | Completion criteria | Related requirements |
|---|---|---|---|---|---|
| BE-01 | **Backend Foundation** — Set up Python and Flask, dependency management, configuration, and source organization. | Runnable backend skeleton and setup instructions. | Confirmed stack and proposed architecture. Can start alongside FE-02. | A contributor can start the server from the instructions using development configuration without committing credentials. | NFR-005, NFR-006 |
| BE-02 | **Database Implementation** — Define SQLAlchemy models, SQLite relationships, constraints, indexes, and migrations. | Relational models and migration procedures. | BE-01 and agreed data design. Confirm field semantics before final constraints. | Schema migration preserves existing records. Tests demonstrate referential integrity and relevant constraints. | FR-003, FR-009, FR-010, NFR-003 |
| BE-03 | **Inventory and Category Services** — Create, read, and edit items and categories with normalization, duplicate checks, and approved archive rules. | Inventory and category service functions. | BE-02, shared uniqueness and archive rules, BE-05 rules where used. | Invalid fields and conflicts are rejected. Supported updates and archival preserve history and references. | FR-003, FR-004, FR-005, FR-007, FR-008 |
| BE-04 | **Stock Management Services** — Process stock-in, stock-out, wastage, and adjustments, including batches, allocations, signed balances, and append-only history. | Transactional movement service. | BE-02, BE-05, agreed units, precision, and allocation rules. | Valid movements reconcile item and batch balances. Invalid or interrupted writes leave no partial effects. | FR-009, FR-010, FR-013, NFR-003 |
| BE-05 | **Inventory Algorithms** — Implement search, sorting, duplicate detection, stock and alert calculations, and report aggregation in Python. | Reusable algorithms with documented inputs, outputs, and complexity where meaningful. | Shared model and rule definitions with FE-07. Can start with fictional fixtures before database integration. | Shared cases match JavaScript results, including boundary values and invalid inputs. | FR-006, FR-007, FR-010, FR-011, FR-012, FR-014 |
| BE-06 | **REST API Development** — Implement Flask routes under the agreed contract with request validation, JSON envelopes, HTTP status codes, and safe errors. | Inventory, batch, movement, report, sync, and snapshot interfaces as their services become ready. | BE-01 and agreed contract. Route scaffolding can start first. Wire handlers as BE-03, BE-04, BE-07, BE-08, and recovery controls become available. | Routes match contract examples and return predictable responses for valid and invalid requests. | FR-003, FR-004, FR-009, FR-013, FR-014, FR-018, FR-019 |
| BE-07 | **Synchronization and Idempotency** — Revalidate tablet commands, process one per request, and store each receipt with accepted changes. | Shared direct and sync command processing and replay handling. | BE-02, BE-03, BE-04, and agreed operation schema. Can test processing before the sync route is wired. | Retry after a lost acknowledgment applies stock once. Changed payloads under an accepted ID are rejected, and earlier commits survive a later failure. | FR-017, FR-018, NFR-003 |
| BE-08 | **Reporting Services** — Generate synchronized inventory summaries, stock and expiration reports, movement history, and aggregations. | Server report queries and read services. | BE-02, BE-05, and representative movement fixtures. Confirm expiration rules before enabling live alerts. | Counts, thresholds, date filters, and totals match shared fixtures. Different units stay distinct. | FR-001, FR-011, FR-012, FR-013, FR-014 |
| BE-09 | **Security and Access Control** — Protect administrative operations, validate approved permissions and requests, secure credentials, and keep sensitive details out of errors. | Approved access controls and protected server configuration. | BE-01, confirmed roles, authentication and offline access policy, and HTTPS deployment decisions. | Permission checks enforce the approved roles. Verification covers safe errors, credential handling, and protected requests. | NFR-004, NFR-005 |
| BE-10 | **Backup and Recovery** — Produce protected backups and metadata, support approved snapshot recovery, and verify restoration. | Documented backup and restore procedure and verification evidence. | BE-02 and BE-07 for records and receipts. BE-09 and approved hosting, retention, and recovery authorization for protected use. | An isolated restore verifies stock, history, and receipts. Recovery procedures protect local pending work before any replacement. | FR-019, NFR-008 |
| BE-11 | **Backend Testing** — Test relationships, validation, calculations, API, retry safety, transaction integrity, and backup and recovery. | Backend test evidence and known limitations. | Shared fixtures and services under test. Use approved recovery conditions for backup checks. | Record actual results for invalid input, failed writes, retries, and restoration as these features become available. | NFR-003, NFR-004, NFR-008 |

## 5. Shared Team Responsibilities

Agree on data models and identifiers, JSON schemas, quantity precision, movement types, duplicate checks, low-stock and expiration rules, batch allocations, error messages and codes, synchronization states, offline access policy, and common test scenarios.

The backend team documents business rules and implements server revalidation. The frontend team applies equivalent rules for essential offline operations. Both teams maintain fictional fixtures with expected results for JavaScript and Python, including zero stock, thresholds, expired batches, rejected allocations, and repeat delivery of an accepted operation. Bring proposed shared schema or algorithm changes to both teams before implementation.

## 6. Responsibility Matrix

**R** means responsible for doing the work. **A** means accountable for the result and its sign-off. **C** means consulted before a decision. **I** means informed of progress or outcomes. **A/R** combines accountability and execution. Where both teams are responsible, each owns its part of the workflow.

| Activity | Project leader | Frontend team | Backend team |
|---|---|---|---|
| Requirements planning | A/R | C | C |
| UI/UX design | C | A/R | C |
| Database design | I | C | A/R |
| API specification | A | R | R |
| Frontend implementation | I | A/R | C |
| Backend implementation | I | C | A/R |
| Local business logic | I | A/R | C |
| IndexedDB | I | A/R | C |
| Synchronization | A | R | R |
| Backup and recovery | A | C | R |
| Testing | A | R | R |
| Deployment | A | R | R |
| Documentation | A | R | R |
| Final project presentation | A/R | R | R |

For synchronization, frontend owns the tablet queue and backend owns processing and receipts. For deployment, frontend verifies the installed web app on the tablet and backend manages approved server deployment. The leader coordinates approval and sign-off.

## 7. Deliverables and Dependencies

The work-package tables identify the expected deliverable, owner, prerequisites, completion criteria, and applicable requirements. [Open Decisions](OPEN_DECISIONS.md) identifies the policy gates. For the slice, deliver only the IndexedDB stores and atomic writes used by its commands and a shared Flask sync handler. FE-09 can connect those commands before the remaining BE-06 routes are available. A fictional initialized snapshot with a generation identifier can support the first slice while protected recovery is developed. Both teams own the tablet/server recovery exercise. The frontend preserves and reconciles local history and queued work, and the backend supplies verified snapshots and receipt results. FE-01 and mock screens can progress independently of BE-01 and BE-02. FE-07 and BE-05 can progress in parallel once the teams agree on rules and fixtures. A live integration needs agreed response schemas, not just reachable routes. Agree on data models before implementing IndexedDB, and on compatible command and receipt formats before connecting the local queue to Flask.

| Pending decision | Work affected |
|---|---|
| Actual categories, units, quantity precision, and purchase cost basis | FE-04, FE-05, FE-07 and BE-02 through BE-05. Use fictional inputs for prototypes and fixtures while waiting. |
| Duplicate identity and archival, thresholds and expiration boundaries, batch depletion and waste handling | FE-03 through FE-07 and BE-03 through BE-05, plus BE-08. Confirm applicable rules before treating results as final. |
| Staff permissions, attribution, authentication, and offline access | FE-04, FE-05, FE-08, FE-09, BE-06, and BE-09. Protect administrative actions under the approved policy before live use. |
| Tablet/browser, hosting, HTTPS, and outage expectations | FE-09 through FE-11 and BE-06, BE-09, BE-10. Final device and deployment verification depends on the actual environment. |
| Queue repair, backup retention, ownership, and recovery authorization | FE-08, FE-09, BE-07, BE-09, and BE-10. Verify failure and recovery workflows before operational use. |

## 8. Development Milestones

| Milestone | Expected outcome |
|---|---|
| 1. Project Foundation | Complete the requirements, architecture, database design, API contract, team delegation, design standards, and testing standards. |
| 2. Parallel Development Setup | Frontend prepares Bootstrap, folders, design system, initial layouts, and mocks. Backend prepares Flask, SQLite, SQLAlchemy models, and initial API structure. |
| 3. Core Inventory Implementation | Start with the first vertical slice in the [Project Plan](PROJECT_PLAN.md). Bring the minimal FE-08 IndexedDB transaction and BE-07 command processor forward with FE-04/05 and BE-03/04. Expand the dashboard, forms, stock services, validation, and reports after the 20 → 15 flow works. |
| 4. Integration | Validate shared formats and inventory workflows against live Flask services in the test environment. Use fixtures and explicitly connected tests for capabilities still in progress. The daily tablet workflow is verified end to end once the offline queue is ready. |
| 5. Offline Functionality | Complete IndexedDB, local transactions, the persistent queue, server-side idempotency, Service Worker, PWA installation, and approved backup and recovery. Design local records and transactions earlier so integration can use the agreed contracts. |
| 6. Android Tablet Testing and Validation | Test the target device, offline operation, restarts, repeated sync, and recovery. Gather café feedback. |
| 7. Final Presentation and Project Defense | Finalize documentation and the demo, explain implemented data structures and algorithms, review each contribution, and present actual results and limitations. |

Stage 2 menu, order, and sales work remains conditional on approval after the inventory MVP is functional and tested.

## 9. Git and GitHub Collaboration

| Branch | Purpose |
|---|---|
| `main` | Stable, reviewed project baseline and eventual integrated application. |
| `frontend-dev` | Frontend team integration branch. |
| `backend-dev` | Backend team integration branch. |
| `docs/project-foundation` | Shared project documentation preparation. |

For substantial work, use a feature branch from the appropriate development branch. Proposed names include `frontend/dashboard`, `frontend/inventory`, `frontend/stock-management`, `backend/database-models`, `backend/inventory-api`, and `backend/synchronization`.

1. Check the active branch and working tree. Preserve teammates' changes and update the relevant development branch.
2. Create a feature branch from the updated development branch, then implement the assigned task.
3. Run relevant checks and review the changed files.
4. With explicit approval, commit using a meaningful message and push the feature branch.
5. Open a pull request targeting the relevant development branch. Include the task ID, summary, evidence, and limitations.
6. Obtain review and address feedback. Merge tested and approved changes only with explicit approval.

After project documentation is reviewed and merged into `main`, both teams update their development branches to include it. Reviewed frontend and backend changes are integrated and tested together before an approved merge into `main`. Preserve teammate changes, avoid force-pushes and branch deletion, and get approval before modifying `main`.

A merge conflict means Git needs help combining changes, often because two people edited the same lines. Compare both changes with the authors, combine the intended behavior, and rerun the affected checks before completing the merge.

## 10. Collaboration and Communication Rules

- Report progress by work package ID. Raise blockers early with the affected task, the needed decision, and who can help resolve it.
- Report bugs with reproduction steps, expected and actual behavior, the environment, and safe fictional evidence where possible.
- Propose shared changes with affected requirement IDs, a before-and-after example, compatibility impact, and affected tests. Review them with both teams and record approved decisions in the relevant project document.
- For integration sessions, agree on the workflows, fixtures, environment, and responsible representatives beforehand. Record results, open issues, and follow-up owners afterward.

### Progress report template

| Field | Update |
|---|---|
| Member name | |
| Assigned task ID | |
| Completed work | |
| Current work | |
| Next task | |
| Problems or blockers | |
| Files changed | |
| Tests performed and results | |

## 11. Integration and Handoff

| From | What the receiving team needs |
|---|---|
| Backend to frontend | Agreed API schemas, working endpoints, fictional example responses, validation rules, error definitions, and development environment setup instructions. |
| Frontend to backend | Required user workflows, form field requirements, expected data presentation, fictional mock requests and responses, offline operation requirements, and feedback from integration. |

For an inventory feature, run a shared scenario through the real tablet workflow and Flask implementation. Compare committed local and server records, balances, and history. Check validation and error messages. For offline-capable tasks, repeat with connectivity disabled, verify after restart, and reconnect to confirm synchronization without a duplicate stock change. A mockup can satisfy a design handoff. Functional completion requires verification of the implemented workflow.

## 12. Definition of Done

- The assigned requirements are satisfied and the implementation follows the agreed architecture.
- Relevant tests have been performed, including checks of affected existing behavior. Offline features include offline and restart testing, plus retry or recovery checks where applicable.
- The code is readable, maintainable, and understood by the contributor.
- Required documentation is updated, actual test results and limitations are recorded, and the changes have been reviewed.

## 13. Individual Assignment Template

| Member name | Team | Work package ID | Assigned responsibility | Deliverable | Dependencies | Target date | Status | Reviewer |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
| | | | | | | | | |
