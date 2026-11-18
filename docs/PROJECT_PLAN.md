# Project Plan

This plan distinguishes findings reported by Fulfil Cafe, confirmed team decisions about how to build the application, and proposed project boundaries and success criteria. The [Software Requirements Specification](REQUIREMENTS.md) records the requirements and decisions still awaiting confirmation.

## 1. Project Information

- **Project name** — Fulfil Cafe Inventory and Operations Management System
- **Course** — Data Logic and Algorithm
- **Section** — BSCpE 2B
- **Project type** — Finals software development project
- **Business partner** — Fulfil Cafe

## 2. Business Background

### Initial business interview on October 31, 2026

- Fulfil Cafe offers food and drinks. It had been operating for approximately five months at the time of the interview.
- The business reported two workers, with the owner responsible for managing records.
- The café used Loyverse and tracked sales and payments digitally. It identified inventory as the most difficult area to manage.
- The owner requested low-stock and top-selling-item reports. The business preferred category-based organization and identified duplicate entries as a data-quality problem.
- The business had a tablet and laptop available and reported reliable internet.
- The business wanted an efficient, user-friendly application that would be easy to operate.

### Follow-up business interview on November 15, 2026

- The café monitors ingredients and supplies manually using notebooks and paper lists. Records are sometimes missing, outdated, or duplicated.
- The same ingredient may be entered again when new supplies are purchased.
- The café sometimes discovers a shortage after an ingredient has already run out. Existing stock can also be overlooked, leading to repeated purchases.
- Restocking decisions are based primarily on visually noticing low quantities.
- The café primarily uses Loyverse for customer checkout and sales recording and has yet to fully explore its inventory features.
- The business identified inventory, sales, and order management as desirable functions. It requested staff access and preferred a tablet-based application.
- The café may consider replacing Loyverse if the proposed application performs better and meets its needs. Its decision about a replacement remains open.

## 3. Problem Statement

Paper-based inventory records make it difficult to keep ingredient and supply information accurate and current. Missing or duplicated entries and overlooked quantities contribute to unexpected shortages and repeated purchases. Fulfil Cafe uses Loyverse for checkout and sales, while day-to-day inventory monitoring remains largely paper-based. The proposed application would organize inventory records digitally so staff can find supplies, check quantities, and make informed restocking decisions.

## 4. General Objective

Develop a user-friendly, tablet-first inventory and operations management application that supports offline inventory work and uses suitable data structures and algorithms to address Fulfil Cafe’s data-management problems.

## 5. Specific Objectives

- Digitize ingredient and supply records and organize them by category with unique item identifiers.
- Prevent unintended duplicate inventory records.
- Improve searching, sorting, and filtering.
- Track quantities through recorded stock movements and preserve transaction history.
- Identify low-stock items and supplies that may expire soon.
- Provide accessible inventory summaries and reports.
- Support essential inventory work without internet access.
- Provide reliable synchronization, backup, and recovery.
- Evaluate usability and effectiveness through testing and feedback from the café.

## 6. Confirmed Technical Direction

- Use one Android tablet as the operating device, with a tablet-first, touch-friendly interface.
- Build a web application first and work toward an installable Progressive Web Application (PWA). Capacitor-based Android packaging is optional.
- Use a local-first design. Validate and save essential inventory operations on the tablet, including when it is offline. Store local operational records in IndexedDB.
- Use Flask, SQLAlchemy, and SQLite for server-side validation, synchronization, server-side records, and backup support.
- Scope initial operation to a single device. Implement and test offline behavior separately from PWA installation.

## 7. Project Scope

### Stage 1 — Inventory minimum viable product

- Dashboard and inventory item management
- Category organization, search, sorting, filtering, and duplicate detection
- Stock-in, stock-out, and adjustments
- Low-stock monitoring and expiration tracking
- Transaction history and inventory reports
- Offline data access and modification, synchronization, backup, and restoration

### Stage 2 — Conditional expansion

- Menu management
- Customer order recording
- Basic sales recording
- Sales reports and top-selling-item analysis, subject to an agreed sales data source
- Recipe-based stock deductions after ingredient quantities, units, and deduction rules are confirmed

Stage 2 requires approval and must wait until the inventory MVP is functional and tested.

## 8. Proposed Scope Limitations

The following are proposed project boundaries for the initial MVP.

- Simultaneous use on multiple devices and management of multiple business branches
- Customer-facing online ordering, delivery management, and online payment processing
- Advanced accounting, payroll, and customer loyalty programs
- Direct Loyverse integration or mandatory replacement of Loyverse
- Automatic recipe-based deductions before ingredient-usage data is confirmed
- Mandatory development of a native Android APK

## 9. Development Approach

1. Confirm requirements and plan the project. Track remaining approvals in [Open Decisions](OPEN_DECISIONS.md).
2. Design the architecture, database, API, and interface. Define local data storage and transaction contracts early.
3. Develop the frontend and backend in parallel.
4. Integrate the inventory MVP.
5. Implement offline operation, synchronization, and PWA installation.
6. Test on the intended Android tablet.
7. Validate the application with Fulfil Cafe and prepare the final project presentation.

### First functional vertical slice

Create one fictional category and one fictional item measured in demonstration pieces (scale 0). Receive one explicitly identified batch of 20 pieces and record usage of 5 from that batch. Derive the remaining 15 pieces from the two movements and show their history. The example uses no actual café quantities or price. If a mock price is shown, label it as a fictional batch price in centavos.

Save each command, its associated records, and its queue entry together in IndexedDB. Close and reopen the application to verify persistence. Use one Flask command handler and the ordered sync path to send the prerequisite category and item commands and the stock commands. Simulate losing an acknowledgment and retry the same accepted command. The server balance must remain 15 with one receipt per accepted command and one occurrence of each movement.

Bring a small IndexedDB implementation and the first server handler forward alongside frontend foundation. Dedicated server reports, optional detail routes, direct mutation wrappers, and comprehensive reports can follow the first working flow. Start with balances derived from movements. Consider caching after measured need and a defined atomic consistency check. This milestone leads into the complete inventory MVP.

## 10. Proposed Success Criteria

Evaluate the application against these criteria during testing and café validation.

- Inventory records and stock calculations are accurate, and duplicate detection flags likely duplicate entries.
- Low-stock and expiration indicators reflect recorded quantities, dates, and agreed thresholds.
- Staff can find records easily, complete agreed inventory tasks, and review the corresponding transaction history.
- Essential inventory operations work during internet interruptions, and accepted records survive normal restarts.
- Synchronization retries apply each transaction once, and a verified backup can be restored.
- Comparisons with the manual process show measurable improvement where baseline measurements are available.

## Sources

- Fulfil Cafe initial business interview, October 31, 2026, as summarized in the supplied project baseline.
- Fulfil Cafe follow-up business interview, November 15, 2026, as summarized in the supplied project baseline.
