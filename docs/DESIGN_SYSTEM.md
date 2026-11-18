# UI/UX Design System

## 1. Design Philosophy

The project leader approved **Option A — Modern Café** as the application's visual direction, including the core palette, Inter typography, Lucide iconography, Bootstrap 5, and a landscape-first tablet layout with portrait support. This identity belongs to the inventory application. Fulfil Cafe's official logo and existing branding are pending confirmation.

This internal tool uses warm neutrals, deep forest-green accents, clear headings, and consistent actions. Put the current task and the information staff need to complete it ahead of decoration. Keep inventory quantities, units, alerts, and save outcomes easy to scan.

## 2. Target Device

Design for one Android tablet with a landscape-first layout. Make every essential workflow usable in portrait without locking orientation. Use available width and content fit to choose layouts instead of assuming a specific resolution. Keep touch controls large, text legible, and important actions visible without hover. Preserve form input, filters, and position as much as practical when the tablet rotates.

The actual model, usable viewport dimensions, resolution, browser, and staff's preferred operational orientation await confirmation. Verify behavior on the real device, including browser zoom, text enlargement, and the on-screen keyboard.

## 3. Color System

### Approved core palette

| CSS custom property | Color | Use |
|---|---|---|
| `--color-primary` | `#254A3B` | Forest green for primary actions, emphasis, and key navigation accents. |
| `--color-background` | `#F7F5F0` | Warm ivory behind page content. |
| `--color-surface` | `#FFFFFF` | White cards, tables, inputs, and dialogs. |
| `--color-text` | `#252B28` | Charcoal for headings and primary text. |
| `--color-text-muted` | `#525B55` | Secondary text for supporting information and metadata. |
| `--color-accent` | `#B99A76` | Coffee beige for decorative accents. Use stronger contrast for text and controls. |
| `--color-border` | `#DCE1DB` | Subtle separators and nonessential outlines. |
| `--color-nav-selected` | `#E5EEE8` | Background for the active navigation item, paired with forest-green text and a marked active state. |

### Proposed semantic tokens

| Use | Foreground or outline | Background |
|---|---|---|
| Success | `--color-success-text` `#18563D` | `--color-success-bg` `#E8F4EC` |
| Warning | `--color-warning-text` `#6B4600` | `--color-warning-bg` `#FFF3D2` |
| Error | `--color-error-text` `#8A2229` | `--color-error-bg` `#FBE9EA` |
| Information | `--color-info-text` `#174564` | `--color-info-bg` `#E7F1F8` |
| Disabled | `--color-disabled-text` `#525B55` | `--color-disabled-bg` `#E8EAE6` |
| Focus | `--color-focus` `#145A73` | Use `--color-focus-gap` `#FFFFFF` between the ring and a dark control. |
| Essential control boundary | `--color-control-border` `#758078` | White or warm ivory. |

Use white labels on forest-green primary buttons. Use the stronger control border when users need an outline to identify a field. Pair each status with explicit text such as **Low stock**, **Out of stock**, or **Sync failed**, plus a Lucide icon where it aids recognition. Keep warning text and inline errors readable on their intended backgrounds. Verify final rendered combinations and focus treatments during implementation.

## 4. Typography

Use Inter with a fallback of system UI, Segoe UI, Roboto, and sans-serif. Bundle the font files used by the application locally and retain the system fallback during loading. Allow text to resize and wrap.

| Role | Starting size / line height | Weight and usage |
|---|---|---|
| Page heading | 28 / 36 px | 650–700, one main heading per screen. |
| Section heading | 20 / 28 px | 600–650, e.g. Recent movements. |
| Body | 16 / 24 px | 400, page content and descriptions. |
| Table | 15 / 22 px | 400 for values, 600 for headers. Right-align numeric values and keep units nearby. |
| Form label | 16 / 24 px | 600, visible above the control. |
| Button label | 16 / 24 px | 600, use an action verb such as Save item. |
| Supporting text | 14 / 20 px | 400, units, help, and timestamps. Keep critical instructions at body size where needed. |
| Dashboard value | 32 / 40 px | 700, use tabular figures for aligned quantities and counts. |

Sizes are design references. Use scalable units in implementation and verify text zoom and wrapping on the target tablet.

## 5. Spacing and Layout

| Element | Proposed spacing |
|---|---|
| Scale | `--space-1` through `--space-6` correspond to 4, 8, 12, 16, 24, and 32 px. |
| Page margins | 24 px on wider layouts and 16 px when space is limited. |
| Grid and cards | 16 px grid gaps, 16–24 px card padding, and 24 px between sections. |
| Forms | 16 px between fields, 8 px between a field and related guidance, and 24 px between groups. |
| Tables | Start with 12 px cell padding. Keep action hit areas large and rows readable without adding decorative padding. |
| Corner radius | 8 px for controls and 12 px for cards and dialogs. |
| Elevation | Use a light border for most surfaces. Use a subtle shadow for overlays where separation helps. |

Target at least **48 × 48 CSS pixels** for primary touch controls, including icon buttons and menu toggles. Keep enough separation to prevent accidental taps. At wider widths, use columns for summaries, forms, and related details when reading order stays clear. At narrow widths, stack sections and use labeled lists or scrollable table regions where needed. Keep the useful inventory information visible and leave room for labels, validation, and the on-screen keyboard.

## 6. Iconography

Use Lucide with a consistent line weight and size. Use icons alongside labels on navigation, stock actions, warnings, and recovery controls. Decorative icons should be skipped by assistive technology. Give any icon-only control a descriptive accessible name and a full-sized touch area. Bundle essential icons locally so offline actions retain their labels and visuals.

## 7. Application Navigation

The wide layout uses a collapsible sidebar with these MVP destinations.

- Dashboard
- Inventory
- Stock Management
- Categories
- Transaction History
- Reports
- Settings

The top bar shows the application's name, the current page where useful, connectivity, and synchronization status. Show staff identity only if attribution or account identification is implemented and approved. Use a text application name until an official logo is supplied for approved use.

At narrower widths, replace the persistent sidebar with an off-canvas menu opened by a labeled button. Keep primary task actions in the content area, maintain the active-page label, and restore focus to the opener when the menu closes. Show only available MVP destinations.

## 8. Dashboard Design

- Place summary cards for total active items, low stock, out of stock, and expiring soon below the page heading. Follow with items requiring attention, recent stock movements, and clearly labeled stock-in and stock-out actions.
- Calculate counts from stored inventory and movement records. The expiration item count is the number of distinct active items with an eligible expiring-soon batch that still has stock. When relevant expiration records or the warning period are unavailable, explain that state instead of showing a misleading zero.
- In landscape, place attention items and recent movements side by side if space permits. In portrait, stack them below the cards and quick actions.
- While local records load, show a short loading state without numeric placeholders that could be mistaken for results. Show a useful first-use empty state, explain local read errors, and preserve readable local data during offline use. If previous data is shown after an error, identify its state or last refresh.

## 9. Inventory Page Design

Place **Inventory** and **Add item** first, then search by item name or ID, category and stock-status filters, and sorting by name or available quantity. Make active and archived views clearly distinguishable when authorized. Use a table on wide layouts with item name, category, available quantity and unit, minimum stock level, stock status, and actions. Give each row a clear detail action and make permitted Edit and Archive actions available by touch and keyboard.

On narrow screens use a labeled record list, prioritizing item, quantity with unit, and status. Keep category, minimum stock, and actions visible on expansion or in details. Distinguish no inventory yet from no results for the current filters. Use item master data for description and classification, and show deliveries, purchase information, and expiration by batch in item details. Changes to availability go through stock movements.

## 10. Inventory Forms

Use visible labels, required-field indicators with a text explanation, inline validation, and clear **Save item** and **Cancel** actions. Keep input when validation fails. On submit, focus the first invalid field or a linked error summary. Confirm successful local saves and show server status separately.

| Field | Proposed form behavior |
|---|---|
| Item name | Required text input. Show likely matches before save using agreed duplicate rules. Offer a way to view an existing item and receive stock against it. |
| Category | Required selection from eligible categories. Display the selected category by name. |
| Unit of measurement | Required selection from approved units. Restrict editing after stock history exists under the proposed API safeguard. |
| Minimum stock level | Required nonnegative quantity in the selected unit. Use a suitable numeric keyboard and validate the agreed precision. |

The client supplies the item identifier as specified by the contract. The item form displays available quantity as read-only information where appropriate. Purchase date, purchase cost, expiration date, and received quantity belong to batch or stock movement workflows. Use stock-in or an initial stock movement for entering quantities. For item archival, explain the effect on active views and retained history. Apply the proposed stock-balance guard only as agreed.

## 11. Stock Management Design

| Workflow | Interaction |
|---|---|
| Receive stock | Select the item, enter the quantity received, and enter applicable batch details. Show the existing and resulting balances. Save the stock-in movement and its batch through the approved transaction flow. |
| Record usage | Select the item, enter a positive amount used, and show the signed deduction and resulting balance. Request batch allocations where the agreed policy calls for them. |
| Record wastage | Use a distinct wastage action so it appears accurately in history. Collect the applicable reason and batch information, and show the deduction. |
| Stock adjustment | Show only to authorized staff under the agreed permissions. Let staff choose increase or decrease, enter the amount and required reason, and review its effect before recording a corrective movement. |

Show units consistently and keep an invalid or insufficient-quantity message near the input. Preserve the draft until corrected. For a multi-batch deduction, show allocated and remaining quantities if relevant and verify the allocation total. Exact precision, purchase cost basis, eligible batches, and automatic versus manual depletion remain pending. Use agreed validation rules for final behavior. Prevent repeated taps while the local write is in progress.

## 12. Categories, History, and Reports

| Screen | Layout and behavior |
|---|---|
| Categories | Reuse the inventory list, text fields, search, and confirmation dialog for listing, creating, editing, and archiving. Show duplicate-name guidance. Under the proposed safeguard, categories with active items must be cleared by reassignment or approved item archival before category archival. Keep historical references. |
| Transaction History | Show item, movement type, signed quantity with unit, timestamp, and reason, plus staff attribution where implemented. Provide item, movement-type, and date filters. In portrait, show a labeled list with details. Use a new adjustment to correct recorded stock. |
| Reports | Present inventory summaries, low-stock and out-of-stock records, expiration details, and stock movement summaries. Reuse filter, table, list, and status components. Calculate essential reports from local records. Keep totals for different units separate. Show an empty or unavailable result with an explanation. |

Top-selling-item reports and sales screens remain conditional on Stage 2 approval and an agreed sales data source.

## 13. Offline User Experience

Connectivity and synchronization are separate indicators. Show **Online** when the device reports an available network. Show **Synchronized** only after the server confirms persistence. A locally committed transaction updates tablet inventory and may still need to reach the server.

| State | Display and behavior |
|---|---|
| Online | Show the connection label. Keep sync state separate and handle a server outage without implying that records were transferred. |
| Offline | Show **Offline** and explain that essential inventory work can continue if the app was initialized. Keep actions usable where local validation applies. |
| Pending synchronization | Confirm **Saved on this tablet** and show the pending count or operation state. Retain it across normal restarts. |
| Synchronizing | Show a progress indicator with text. Avoid parallel submissions and keep local inventory available. |
| Fully synchronized | Show when there are no outstanding operations and successful persistence is confirmed for submitted operations. Show the last confirmed sync if available. |
| Synchronization failed | Keep the saved record and queue entry. Show a clear reason when known. On a temporary outage, show pending work and a manual retry where appropriate. For a rejected operation, show that review is needed and later queued work is blocked. |
| Recovery required | Show a persistent notice and direct authorized staff to the approved recovery procedure. Protect pending local records and require review before replacing existing data. |

Use clear messages such as “Stock recorded on this tablet. Sync pending.” and “Server unavailable. Your changes are saved on this tablet.” Retry an eligible operation with its original ID. Avoid automatic retry loops for rejected operations and keep important status visible outside toasts.

## 14. Reusable Components

Use Bootstrap 5 layout and component patterns with application tokens for the Modern Café treatment. Normal and interaction states below describe the expected rendered behavior. Where a state does not apply, keep the component readable and place the feedback on the relevant control or region.

| Component | Normal | Focused | Disabled or unavailable | Loading | Error |
|---|---|---|---|---|---|
| Sidebar navigation | Forest-green active text on selected tint, labeled icons, and current-page marker. | Ring on links and toggle. | Omit unavailable destinations. | Retain navigation while destination content loads. | Place a route error and recovery action in the content area. |
| Top bar | Name, page context, and separate labeled status indicators. | Ring on interactive controls. | Hide staff controls if unsupported. | Show status as checking when appropriate. | Show connectivity or sync issue in its indicator. |
| Statistic cards | White surface, short label, prominent value. | Ring only when the card links to details. | Explain unavailable values using text. | Indicate that counts are loading. | Explain which value failed to load and show a retry if useful. |
| Buttons | Forest-green primary, outlined secondary, and clearly labeled high-impact actions. | Visible ring with a gap when needed. | Muted appearance and a reason nearby when useful. | Keep the label or use clear progress text, and prevent a duplicate action. | Keep the action available for a safe retry and show a nearby message. |
| Text inputs | White field, control border, and persistent label. | High-contrast ring. | Keep value and reason readable. | Keep entered data visible during save. | Mark the field and show actionable text linked to it. |
| Select controls | Labeled control with visible selected value and disclosure icon. | Ring and keyboard-operable choices. | Explain when choices are unavailable. | Show that choices are loading. | Preserve the prior selection and offer recovery where supported. |
| Search fields | Labeled text field with optional clear action. | Ring on input and clear action. | Explain unavailable search only if applicable. | Indicate search progress without erasing previous terms. | Distinguish an error from an empty result. |
| Tables and lists | Labeled columns or labeled values, readable row actions, and aligned quantities. | Ring on actions or focusable scroll regions. | Expose unavailable actions with a reason where helpful. | Keep headers visible and mark the region busy. | Show an inline retrieval error and retain trustworthy records if available. |
| Status badges | Semantic tint, text label, and icon when useful. | Static badges stay out of the tab order. | Use an explicit unavailable label where applicable. | Use a separate checking or pending label. | Use specific text such as Out of stock or Sync failed. |
| Dialogs | Clear title and effect, with confirm and cancel actions. | Start at a logical element, contain modal focus, and restore it on close. | Explain when confirmation is unavailable. | Mark an in-progress submission and prevent repeat confirmation. | Keep the dialog open for fixable errors and link guidance to the affected field. |
| Confirmation messages | Persistent acknowledgment where users need to revisit the outcome. | Manage focus only when navigation or a modal changes context. | Omit unavailable follow-up actions. | Show saving state before claiming success. | Replace the success message with the actual failure or unresolved state. |
| Toast notifications | Brief, secondary feedback that does not interrupt work. | Keep focus on the current activity. | Omit unavailable toast actions. | Use persistent indicators for ongoing work. | Pair critical errors with visible inline or persistent feedback. |
| Inline validation errors | Hidden until relevant. Display text next to the affected field. | Focus linked invalid input or a linked error summary on submit. | Keep any remaining correction guidance readable. | Avoid clearing entered values while validating. | Identify the field, problem, and how to correct it. |
| Empty states | Explain the empty list or filtered result and show a relevant action if available. | Ring on the action. | Explain any unavailable action. | Show loading separately from an empty result. | Show an error state with a safe retry rather than an empty-state message. |
| Loading indicators | Hidden when idle. | Static indicators stay out of the tab order. | Avoid disabling unrelated controls. | Use progress text and expose the busy region to assistive technology. | End loading and show the reason and next action. |
| Offline indicators | Display Online or Offline as a visible label. | Ring on an associated details control if provided. | Keep essential local actions available. | Use Checking connection when appropriate. | Distinguish a server connectivity problem from a local save failure. |
| Sync status indicators | Show pending, synchronized, failed, or recovery status and count where useful. | Ring on details and retry controls. | Explain when retry is unavailable or requires review. | Show Synchronizing while waiting for server confirmation. | Show the reason, preserve pending data, and provide the approved next action. |

## 15. Accessibility and Usability

Target applicable WCAG 2.2 AA criteria and test the implemented interface before making a compliance claim. The project’s 48 × 48 CSS pixel primary target size is a tablet design goal. [W3C Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22/)

- Check text contrast of at least 4.5:1 for ordinary text and 3:1 for large text where applicable. Check required visual boundaries and indicators for 3:1 non-text contrast where applicable. Verify real states after Bootstrap styling is applied.
- Verify visible keyboard focus, logical order, and that sticky bars, dialogs, and drawers do not hide focused controls. Check that all workflows can be completed by keyboard and touch.
- Use semantic headings, landmarks, real buttons, meaningful table headers, and visible labels. Verify accessible names and status announcements with a screen reader such as Android TalkBack. Explain errors in text and announce status changes without continually interrupting work.
- Verify zoom, text resizing, wrapping, portrait reflow, tablet rotation, and touch actions with the on-screen keyboard open. Keep status readable without color or icons alone.
- Respect reduced-motion preferences. Avoid motion as the only indicator of progress, and use text to show ongoing work and outcomes.

## 16. Conceptual Wireframes

These text wireframes illustrate placement and reading order. Labels and values are illustrative. The layouts adapt to available space, and production values come from records.

### Dashboard

~~~text
Landscape
[Sidebar] [Dashboard                  Online | Sync pending]
          [Active] [Low stock] [Out of stock] [Expiring soon]
          [Items requiring attention] [Recent stock movements]
          [Receive stock] [Record usage]

Portrait
[Menu] [Dashboard] [Connection and sync]
[Active] [Low stock]
[Out of stock] [Expiring soon]
[Receive stock] [Record usage]
[Items requiring attention]
[Recent stock movements]
~~~

### Inventory

~~~text
Landscape
[Sidebar] [Inventory                               Add item]
          [Search] [Category] [Stock status] [Sort]
          [Item | Category | Available + unit | Minimum | Status | Actions]

Portrait
[Menu] [Inventory] [Add item]
[Search]
[Filters] [Sort]
[Item name | Available + unit | Status]
[Category and minimum in details] [View actions]
~~~

### Add or Edit Item

~~~text
Landscape
[Item details]
[Item name] [Category]
[Unit]      [Minimum stock level]
[Duplicate guidance if applicable]
[Cancel] [Save item]

Portrait
[Item details] → [Name] → [Category] → [Unit] → [Minimum]
[Validation or duplicate guidance]
[Cancel] [Save item]
~~~

### Stock-in

~~~text
Landscape
[Receive stock]
[Item | Quantity and unit] [Current stock → Expected stock]
[Batch details if applicable] [Cancel] [Record receipt]

Portrait
[Receive stock] → [Item] → [Quantity and unit]
[Batch details if applicable]
[Current stock → Expected stock]
[Cancel] [Record receipt]
~~~

### Stock-out

~~~text
Landscape
[Record usage]
[Item | Amount used] [Current stock → Expected stock]
[Batch allocations if required] [Cancel] [Record usage]

Portrait
[Record usage] → [Item] → [Amount used]
[Batch allocations if required]
[Current stock → Expected stock] [Validation if needed]
[Cancel] [Record usage]
~~~

### Transaction History

~~~text
Landscape
[Transaction history] [Item] [Movement type] [Date]
[Item | Type | Signed quantity + unit | Time | Reason | Staff if available]

Portrait
[Transaction history] [Filters]
[Item + type + signed quantity]
[Time and expandable movement details]
~~~

### Reports

~~~text
Landscape
[Reports] [Inventory] [Low stock] [Expiration] [Movements]
[Report filters] [Summary]
[Results table]

Portrait
[Reports] [Report selector]
[Filters] [Summary]
[Labeled results list]
~~~

### Settings

~~~text
Landscape
[Settings]
[Connection and sync details] [Last confirmed sync | Retry if eligible]
[Approved backup and recovery information, where available]

Portrait
[Settings] → [Connection] → [Sync status and eligible retry]
[Approved backup and recovery information, where available]
~~~

### Item and batch details

| Landscape | Portrait |
|---|---|
| Show item name, available quantity and unit, stock status, and available actions above side-by-side batch and movement lists. Selecting a batch reveals received and remaining quantities, dates, and linked movements. | Put item summary above a labeled batch list. Expand a batch in place or open a detail page with Back to item. Wrap dates and keep quantity next to its unit. |

### Multi-batch withdrawal and invalid selection

| Landscape | Portrait |
|---|---|
| Show requested quantity alongside a batch allocation table with available and assigned quantities. Keep the allocation total and expected balance visible before confirmation. | Stack requested quantity above labeled batch cards, allocation total, and expected balance. Keep confirmation reachable with the Android keyboard open. |
| Mark an ineligible batch or excessive allocation in its row and show an error summary. Keep the draft and focus the first invalid allocation. | Place the error under the affected batch, keep other entries, and provide a link from the summary to the invalid field. Prevent confirmation until the quantities reconcile. |

Use explicit batch selection in the fictional demonstration. Production selection and eligibility are pending. Sort inventory quantities within compatible unit groups and keep each unit in the label.

### Failed sync and recovery

| Landscape | Portrait |
|---|---|
| Open sync details beside the queue. Show the saved operation, reason, and affected later entries. Offer eligible retry for a temporary outage. Permanent rejection or a restored server opens the reviewed recovery path. | Use a stacked status page with a persistent banner and expandable operation details. Make retry or review actions explicit and keep pending data visible. |
| In reviewed recovery, compare tablet and verified server records, identify affected commands, and show the recorded resolution before sync resumes. | Present the same comparison as stacked, labeled sections. Show the impact on inventory and pending work before any approved action. |

The tablet keeps an approved version of expiration settings for offline alerts. When a warning period is unset, show already expired stock where applicable and explain that upcoming alerts are unavailable. Administrative controls depend on the policies in [Open Decisions](OPEN_DECISIONS.md).

## 17. Frontend Implementation Standards

- Apply the design tokens as CSS custom properties and map Bootstrap variants to those tokens. Use consistent, descriptive component names and reuse buttons, forms, lists, tables, badges, and alerts across views.
- Preserve the Vite and vanilla JavaScript architecture. Keep rendering, inventory rules, IndexedDB access, and API requests in separate modules. Use shared rules and fixtures to keep local and server calculations equivalent.
- Bundle Bootstrap, essential icons, fonts, and other assets locally for the initialized app. Keep the app usable with a system font fallback and preserve independent synchronization and offline indicators.
- Use tablet-responsive layouts, visible interaction states, and fictional development data. Map forms and reports to the agreed database and API fields, including quantities, identifiers, movement history, and error handling. Treat local commit and server acknowledgment as separate events.
- Verify FE-01 through FE-11 deliverables using the agreed requirements and testing workflow. This document specifies intended behavior for implementation and review.

## 18. Pending Design Decisions

| Decision | Status |
|---|---|
| Official Fulfil Cafe logo and existing brand identity | Pending. Use the application name as text until an official asset and its use are confirmed. The approved Modern Café visual identity is for the application. |
| Actual Android tablet dimensions, model, resolution, and browser | Pending device details and testing. |
| Staff's preferred operational orientation | Pending café feedback. Landscape-first design and usable portrait are approved. |
| Staff account interface, identification, and permissions | Pending connected and offline access policy. |
| Batch selection, quantity precision, purchase cost basis, and expiration settings | Pending agreed business rules. Final field behavior must follow those decisions. |
| Semantic state treatments and responsive breakpoints | Proposed starting values. Verify in the implemented application on the actual tablet. |
| Dark mode | Possible future enhancement. |
| Stage 2 screens | Conditional on inventory MVP completion, project approval, and relevant business decisions. |
