# Software Requirements Specification

This specification covers the Fulfil Cafe Inventory and Operations Management System. The [Project Plan](PROJECT_PLAN.md) records the interview findings and confirmed team decisions. The requirements below describe proposed system behavior. Business requests are identified where the supplied interview findings support them. Acceptance criteria describe what to verify during development and café validation.

**Priority** indicates the proposed delivery stage. **MVP** means required for Stage 1 acceptance. **Conditional** means Stage 2, subject to approval after the inventory MVP is functional and tested. Criteria that depend on an unresolved policy use agreed rules or fictional test data during development.

## 1. Target Users

The café owner and staff members who manage ingredients, supplies, and inventory records are the intended users. Fulfil Cafe requested staff access. Administrative permissions, authentication, offline access, and deletion privileges remain open.

## 2. Functional Requirements

### A. Dashboard

| ID | Requirement | Priority | Acceptance criteria | Business justification |
|---|---|---|---|---|
| FR-001 | Show total inventory item count, low-stock and out-of-stock counts, and expiring-soon count where expiration data exists. | MVP | Counts match a known set of inventory records and configured rules. Missing expiration data is distinguishable from a calculated count. | Staff need a quick view of stock and items requiring attention. |
| FR-002 | Show recent inventory movements and, once offline operation and synchronization are implemented, show whether the app is offline and the current synchronization status. | MVP | Recorded movements appear in the recent activity view. Disconnecting, syncing, and encountering a sync failure produce the corresponding status from actual state. | Staff need to see recent changes and know whether local work has synchronized. |

### B. Inventory Management

The café requested item name, category, available quantity, unit of measurement, purchase price, purchase date, expiration date, and minimum stock level. These are information needs. Purchase-related data may be modeled in batches or stock movements, with the final schema defined in the database design. System-generated identifiers and timestamps are proposed technical fields.

| ID | Requirement | Priority | Acceptance criteria | Business justification |
|---|---|---|---|---|
| FR-003 | Allow authorized users to create, view, and edit inventory items. Capture the requested inventory information where applicable, and record quantity changes through stock movements. | MVP | A user with agreed permissions can save a valid record, retrieve it by its unique identifier, see the applicable inventory information, and update editable details. Stock changes appear in movement history. | Digital records help replace missing or outdated paper entries. |
| FR-004 | Allow authorized users to manage categories and organize inventory items by category. | MVP | A user can create or update a category and assign an item to it. The item appears under its assigned category. | The café prefers organizing inventory by category. |
| FR-005 | Allow authorized users to archive inactive items while preserving their history. | MVP | An archived item leaves the active inventory list and its existing movements remain retrievable. | Staff can declutter active inventory and still review past operations. |

### C. Search, Sorting, and Filtering

| ID | Requirement | Priority | Acceptance criteria | Business justification |
|---|---|---|---|---|
| FR-006 | Support searching by item name or identifier, filtering by category or stock status, and sorting by item name or available quantity. | MVP | Searches return the expected matching items. Category and stock-status filters restrict the results correctly, including separate low-stock and out-of-stock views. Name and quantity sorts put test records in the selected order. | Staff need to find ingredients and supplies quickly. |

### D. Duplicate Detection

| ID | Requirement | Priority | Acceptance criteria | Business justification |
|---|---|---|---|---|
| FR-007 | Normalize item names for matching and warn before creating potential duplicates. Apply agreed uniqueness rules and use meaningful item identifiers. Keep potential matches separate unless handled under an approved process. | MVP | Names equivalent under the agreed normalization rules trigger a warning before saving. Similar names alone cause no automatic merge or modification. Existing records remain independently identifiable. | Duplicate entries make available stock harder to track accurately. |
| FR-008 | Distinguish receiving additional stock from creating a new inventory item. | MVP | Staff can record a delivery against an existing item through stock-in, increasing its quantity and preserving its identity without creating a second item. | Repeated purchases of the same ingredient sometimes lead to duplicate records. |

### E. Stock Movements

| ID | Requirement | Priority | Acceptance criteria | Business justification |
|---|---|---|---|---|
| FR-009 | Record stock-in for received supplies, stock-out for used or discarded supplies, and adjustments for inventory corrections. Record the movement type or reason, timestamp, unique transaction identifier, and staff attribution where staff identification is implemented. | MVP | Each supported movement changes stock by the expected amount and records its metadata. A correction creates an adjustment entry. If staff identification is implemented, the record identifies the staff member. | Recorded movements explain why quantities changed and help staff reconcile discrepancies. |
| FR-010 | Validate quantities and prevent negative stock by default. Save each accepted movement and resulting quantity change atomically. | MVP | Invalid input and a deduction that would produce negative stock are rejected under the default rules. An interrupted write leaves either both the stock change and its movement record saved or neither saved. | Accurate balances and a complete history support stock monitoring and prevent unexplained changes. |

### F. Stock Monitoring

| ID | Requirement | Priority | Acceptance criteria | Business justification |
|---|---|---|---|---|
| FR-011 | Allow an item-specific minimum stock level. Warn within the app when stock is at or below the configured threshold, distinguish out-of-stock items, and organize items requiring restocking. | MVP | With fictional quantities above, at, and below a configured threshold, warnings appear at or below the threshold. Zero stock is identified as out of stock. Items requiring restocking can be reviewed together. | The café requested low-stock reporting and currently relies on visual checks. |

### G. Expiration Tracking

| ID | Requirement | Priority | Acceptance criteria | Business justification |
|---|---|---|---|---|
| FR-012 | Support optional expiration dates on applicable inventory batches and a configurable warning period. Identify expired and approaching-expiration stock where dates exist. | MVP | Dated batches are classified using the configured period and agreed date rules. An undated batch remains unclassified for expiration. | Staff can use the requested expiration information to review time-sensitive supplies. |

The default warning period and batch-depletion rules require business agreement.

### H. Inventory History and Reports

| ID | Requirement | Priority | Acceptance criteria | Business justification |
|---|---|---|---|---|
| FR-013 | Show movement history with filters for item, movement type, and date. | MVP | Applying each filter returns only matching movements from a known set of transactions. | Staff need a way to review prior activity and investigate discrepancies. |
| FR-014 | Provide reports on current inventory, low-stock items, expiration records, and stock-in and stock-out summaries. | MVP | Reported quantities, lists, and movement summaries match the underlying test records and configured thresholds or date rules. | Staff need a clear view of current supplies and restocking needs. |

### I. Offline Functionality

| ID | Requirement | Priority | Acceptance criteria | Business justification |
|---|---|---|---|---|
| FR-015 | Open the initialized application offline and retrieve inventory from IndexedDB. | MVP | After initialization, the app opens with the network disabled and displays previously saved inventory records. | Staff need access to inventory during interruptions. |
| FR-016 | Create and update supported inventory records and perform supported stock movements offline with essential local validation. | MVP | With Flask unreachable, valid offline operations are saved, invalid operations are rejected, and accepted records remain available after a normal restart. | Staff need to continue recording inventory while disconnected. |
| FR-017 | Keep a persistent synchronization queue and display pending, synchronized, and failed operations distinctly. | MVP | A queued operation remains after restarting. The interface shows the correct state for a queued operation, a confirmed synchronization, and a failed attempt. | Staff need to know which changes are saved locally and which still need attention. |

### J. Synchronization and Backup

| ID | Requirement | Priority | Acceptance criteria | Business justification |
|---|---|---|---|---|
| FR-018 | Give every synchronizable operation a unique identifier and synchronize pending changes when connectivity is available. Make retries idempotent and mark operations synchronized only after confirmed server persistence. Preserve pending data after failures. | MVP | An interruption or lost response leaves recoverable local data. Retrying the same identifier results in one server-side stock change, and the local operation is marked synchronized after persistence is confirmed. | A retry must not distort balances or erase pending inventory records. |
| FR-019 | Provide protected backups and a documented, verified restoration procedure. Communicate the last successful backup and synchronization status. | MVP | Authorized users can recover expected records and transaction history from a protected backup in a test environment. The interface displays the last successful backup and synchronization information and does not report a failed attempt as successful. | Recovery matters when browser storage is cleared, lost, or inaccessible. |

### K. Conditional Stage 2 Requirements

Stage 2 requires approval after the inventory MVP is functional and tested. Sales reports, including top-selling items, depend on an agreed source of sales records. A separately agreed source may support reporting without changing the inventory MVP scope.

| ID | Requirement | Priority | Acceptance criteria | Business justification |
|---|---|---|---|---|
| FR-020 | Manage menu items. | Conditional | Authorized staff can create, retrieve, and update menu entries using agreed information and rules. | Menu management supports the proposed expansion into café operations. |
| FR-021 | Record customer orders and track order status. | Conditional | A recorded order can be retrieved and updated through the agreed status changes. | The café identified order management as desirable. |
| FR-022 | Record sales. | Conditional | An authorized user can save a valid sale and retrieve it using the agreed sales information and rules. | The café identified sales management as desirable. |
| FR-023 | Produce sales reports from agreed sales records. | Conditional | Report totals match the eligible sales records for a known period. | Reports help staff review sales activity. |
| FR-024 | Produce top-selling-item reports. | Conditional | A known sales dataset produces the expected ranking under the agreed ranking measure and reporting period. | The owner requested top-selling-item reports. |
| FR-025 | Deduct stock based on recipes after ingredient quantities, units, and deduction rules are confirmed. | Conditional | An agreed triggering event for a sample recipe produces the expected stock movements and quantity changes under the approved rules. | Recipe-based deductions could connect sales or orders to ingredient usage once the business rules are known. |

## 3. Nonfunctional Requirements

| ID | Area | Requirement | Priority | Acceptance criteria | Business justification |
|---|---|---|---|---|---|
| NFR-001 | Usability | Provide a responsive tablet-first layout, touch-friendly controls, clear navigation and labels, consistent visual hierarchy, and understandable confirmation and error messages. Minimize unnecessary steps for frequent tasks. | MVP | On the target tablet, café staff can complete agreed inventory tasks by touch and understand resulting confirmations and errors. A walkthrough identifies any unnecessary steps in frequent tasks. | The café prefers an efficient application that is easy to operate on a tablet. |
| NFR-002 | Performance | Retrieve and process local records efficiently, keep routine actions responsive, and avoid unnecessary network requests. Set measurable targets during testing. | MVP | Measure agreed routine tasks on the target tablet using a representative dataset. Check results against targets established during testing and verify that essential local actions require no network round trips. | Staff need to find and update records without slowing routine work. |
| NFR-003 | Reliability and data integrity | Reject invalid inventory quantities, use unique identifiers, preserve movement history, and use atomic local writes where applicable. Handle interrupted synchronization without silent loss or overwrites. | MVP | Validation, interrupted-write, and retry tests confirm consistent quantities and history with each accepted movement recorded once. Equivalent inventory rules apply online and offline. | Inventory decisions depend on accurate and explainable balances. |
| NFR-004 | Security and privacy | Enforce agreed administrative permissions and define the offline access policy before implementing authentication. Protect credentials and confidential records, use HTTPS for deployed communication, and prohibit plaintext password storage. | MVP | Verify the approved offline access policy, test that unauthorized roles cannot perform restricted actions, confirm deployed communications use HTTPS, and inspect credential handling if passwords are used. | Staff need appropriate access while the café’s records and credentials remain protected. |
| NFR-005 | Security and privacy | Keep real business records and credentials out of GitHub. Use fictional or properly anonymized development data. | MVP | Review repository changes, fixtures, and examples for credentials and identifiable business records. | Project collaboration should protect the café’s confidential information. |
| NFR-006 | Maintainability | Use modular code and meaningful names. Separate presentation, business logic, and persistence. Maintain shared API and database documentation, follow the Git workflow, and explain significant technical decisions in beginner-friendly language. | MVP | Review implementation boundaries and names, compare shared documentation with the implementation, and check changes against the repository workflow and explanation requirements. | Both teams need to integrate, maintain, and explain the application during the project defense. |
| NFR-007 | Compatibility | Prioritize the confirmed Android tablet and verify its actual browser and operating system. Support PWA installation where available. Capacitor APK packaging is optional. | MVP | On the target tablet, complete agreed inventory tasks in its browser and verify installation and launch where supported. Verify offline behavior separately with connectivity disabled. | The tablet is the intended operating device. |
| NFR-008 | Recoverability | Preserve accepted transactions across normal restarts and provide backup and restore procedures that account for possible loss of browser storage. Test restoration before production use. | MVP | Restart after recording a transaction and verify it persists. Restore from a protected backup into an environment without local records and compare restored data with the backup. | The café needs to recover records if the tablet’s stored data is lost. |

### Proposed offline support matrix

The tablet is initialized while connected. Normal daily writes commit locally first, regardless of connectivity. The access policy remains pending as tracked in [Open Decisions](OPEN_DECISIONS.md).

| Action or command | Offline behavior | Access or dependency |
|---|---|---|
| View dashboard, inventory, categories, batch details, history, and essential reports | Read local records and calculate local summaries. | Essential after initialization. Apply the approved view policy. |
| `create_item` | Validate and queue the item under an eligible local category. | Essential item workflow. |
| `update_item` | Update permitted metadata and queue the change. | Essential item workflow. Restricted fields remain subject to agreed rules. |
| `create_category` | Validate and queue the category before dependent items. | Supported in the fictional slice. Production offline permission awaits policy. |
| `update_category` | Queue an approved category edit. | Offline permission awaits policy. |
| `archive_item` | Queue archival and retain history once permitted. | Offline permission and archival safeguards await approval. |
| `archive_category` | Queue archival only if the approved reference safeguards pass. | Offline permission and archival safeguards await approval. |
| `record_stock_movement` for stock-in and usage | Save the stock movement, affected batches and allocations, and queue entry atomically. | Essential after initialization. |
| `record_stock_movement` for opening stock, wastage, and corrections | Local transaction support is planned. Preserve the reason and allocation rules. | Final permissions, provenance, and validation policy await approval. |
| Synchronization, initialization, and protected receipt checks | Requires server connectivity. Offline operations remain queued. | Connected sync, setup, and approved recovery actions. |
| Approve queue repair, provision settings, administer access, back up, or restore | Connected administrative workflow with review and protection for pending tablet work. | Exact permissions and authorization await approval. |

## 4. Unresolved Business Requirements

| Area | Pending confirmation |
|---|---|
| Inventory catalog | Exact categories and item types, actual sample records, approximate item count, units of measurement, and quantity precision. |
| Inventory workflow | Frequency of inventory updates, handling of expired, damaged, or wasted stock, and whether purchase prices are per unit or per batch. |
| Stock monitoring and batches | Actual minimum stock thresholds, expiration warning periods, batch-depletion rules, and the uniqueness rules used to confirm duplicate items. |
| Staff access | Exact staff and administrator permissions, authentication requirements, offline access policy, and deletion privileges. |
| Backup and retention | Backup frequency and retention period. The initial interview suggested archiving records after three years. The final retention and archival policy is pending. |
| Deployment and offline operation | Hosting arrangement, server ownership, internet-outage expectations, and actual Android tablet specifications. |
| Conditional operations | Whether the café will eventually replace Loyverse, the agreed sales data source, recipe quantities and units, and automatic stock deduction rules. |
| Schedule | Final implementation deadline. |

## 5. Requirements Traceability

| Confirmed business problem | Functional requirements | Proposed feature | Expected verification method |
|---|---|---|---|
| Missing or outdated inventory records | FR-003, FR-009, FR-013 | Digital item records and stock movement history | Create and update a fictional item, record a stock movement, and confirm the current balance and corresponding history. |
| Duplicate entries | FR-007, FR-008 | Duplicate warnings and stock-in for existing items | Attempt to create a likely duplicate, verify the warning, and record the delivery against the existing item. |
| Unnoticed shortages | FR-001, FR-011, FR-014 | Dashboard counts, in-app warnings, and low-stock reporting | Set a fictional threshold and check test items above it, at it, below it, and at zero. |
| Unnecessary repeated purchases | FR-006, FR-011, FR-014 | Searchable stock balances and restocking views | Ask staff to locate an item and check its recorded quantity and warning status before making an agreed test purchase decision. |
| Paper-based inventory monitoring | FR-003, FR-009, FR-015, FR-016 | Local digital records and offline stock movements | Disconnect the tablet, retrieve an item, record a movement, restart, and verify the updated quantity and history. |

## 6. Source Attribution

- Fulfil Cafe initial business interview, October 31, 2026, as summarized in the supplied project baseline.
- Fulfil Cafe follow-up business interview, November 15, 2026, as summarized in the supplied project baseline.

The business findings are attributed to the supplied summaries of those interviews. The team’s technical direction is documented in the [Project Plan](PROJECT_PLAN.md) and [repository guidance](../AGENTS.md).
