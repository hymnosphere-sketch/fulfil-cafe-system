# API Contract

## 1. API Overview

This is the proposed inventory API for the Fulfil Cafe Inventory and Operations Management System. Python Flask exposes JSON REST routes under `/api/v1`. SQLAlchemy manages SQLite persistence, and deployment uses HTTPS. The API serves synchronized records, validates inventory operations, processes offline changes without double-counting, provides reports from server records, and supports approved initialization and recovery. Backup administration requires separate approval.

The Android tablet remains the primary operating device. It reads and commits essential inventory work in IndexedDB during daily use, including when connected. The Flask server receives queued changes afterward. Server reports reflect committed server records and can lag behind the tablet. See the [architecture](ARCHITECTURE.md), [database design](DATABASE_DESIGN.md), and [requirements](REQUIREMENTS.md).

## 2. General API Conventions

- Use plural, lowercase resource paths and hyphens in multiword paths. `GET` reads, `POST` creates resources or performs named actions, and `PATCH` changes specified fields. JSON uses `snake_case`.
- Clients send `Accept: application/json` and `Content-Type: application/json` when a JSON body is present. Credentials and session handling depend on the approved authentication design. Place sensitive values in neither URLs nor logs. Examples show the method, URL, and body where applicable. Administrative responses must be protected from shared caching.
- Use UUID strings for resource and operation IDs. Tablet-created entities and operations receive IDs before local commit. Treat IDs as opaque. A malformed path or query UUID is a request error. A well-formed missing resource returns the appropriate not-found error.
- Use ISO 8601 UTC timestamps with a `Z` suffix and seconds, with optional three-digit milliseconds, for example `2026-11-18T02:00:00Z`. Canonical commands include three fractional digits. Reject invalid dates and offsets on event fields. Use `YYYY-MM-DD` for purchase and expiration calendar dates in the agreed business timezone. Movement report filters use UTC timestamps with an inclusive start and exclusive end.
- Use scaled JSON integers with stable unit IDs and immutable scale profiles. For example, the fictional `kg` profile uses scale 3, so `1500` represents 1.500 kg. Parse decimal form text exactly into an integer and reject excessive fractional precision instead of rounding. Require JSON integer tokens, excluding strings, booleans, decimal points, or exponent notation in integer fields. Validate all integer values and intermediate results within ±9,007,199,254,740,991 as well as field-specific signed or nonnegative rules. Group inventory quantities by compatible units before sorting, using stable unit IDs as the initial groups. Confirm actual profiles and conversions with Fulfil Cafe. A profile change cannot reinterpret a pending payload or past movement.
- Monetary amounts use nonnegative integer Philippine centavos within the same safe integer range. For instance, `12550` would represent ₱125.50. The meaning of `purchase_cost` as a unit or batch price remains unresolved.
- For list endpoints, `page` and `page_size` are optional positive integers. Proposed defaults are page 1, size 25, maximum size 100. `meta` includes `page`, `page_size`, and filtered `total`. Stable ordering uses the record ID as a final tie-breaker. A page beyond the end returns an empty list. Invalid filters, sorting, or pagination return `400 INVALID_REQUEST`.
- Reject unknown body fields and invalid field values with a detailed `422` error. Unless a field is explicitly nullable, omit it when optional rather than sending `null`. A patch needs at least one editable field. List, detail, and report reads take no body.

### Server generation and settings headers

On inventory mutations, including synchronization, clients supply `X-Inventory-Generation` with the generation UUID obtained during connected initialization or approved recovery. A missing or malformed value returns `400 INVALID_REQUEST`. A mismatch or active recovery gate returns `409 RECOVERY_REQUIRED` before any normal mutation or receipt acknowledgment. Server responses for authorized inventory clients include the current generation when available, and can announce the approved expiration settings version in `X-Inventory-Settings-Version`. A newer version prompts an authorized snapshot read and validated settings-only local update. The tablet uses the last verified setting offline. Generation, settings metadata, and session context are transport data excluded from the command fingerprint. The examples show JSON bodies and omit common headers. Normal synchronization never installs a server snapshot over local inventory.

## 3. Standard Response Format

Every response has a JSON envelope. All records throughout this document are fictional. Endpoint examples outside the explicitly linked synchronization examples are independent.

**Success**

```json
{
  "success": true,
  "data": {
    "item_id": "00000000-0000-4000-8000-000000000002",
    "name": "Coffee Beans"
  }
}
```

**Error**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The submitted information is invalid.",
    "details": {
      "fields": {
        "name": "Enter an item name."
      }
    }
  }
}
```

| HTTP status | Meaning |
|---|---|
| 200 | Read, update, archival, synchronization acknowledgment, or successful replay. |
| 201 | New resource created by a direct mutation. |
| 400 | Malformed JSON, invalid request structure, or invalid path or query parameter. |
| 401 | Authentication required when implemented. |
| 403 | The requester lacks permission. |
| 404 | An addressed or referenced resource was not found. |
| 409 | Duplicate, conflicting state, or operation ID reused with a different command. |
| 422 | Field or inventory rule validation failed. |
| 500 | Unexpected server error with a safe message. |
| 503 | Temporary service outage. Use `Retry-After` when available. |

Authentication and permission errors apply to protected routes when the access policy is implemented. Responses exclude stack traces, raw database messages, credentials, and confidential details.

### Direct mutation convention

Direct mutation endpoints use a JSON body containing a unique `operation_id` and UTC command `created_at`, plus the fields documented for that route. Map the route and body to the same canonical command used by synchronization, including command type, entity ID, timestamp, and payload. A resource-create response includes the saved resource and uses `201`; a verified replay returns the original result data with `200`. Use the direct mutations for explicitly connected workflows and integration tests. On the tablet’s ordinary local-first path, send queued changes only through `POST /api/v1/sync`.

Resource responses include server-calculated fields where documented. These are outputs. Clients cannot write `normalized_name`, balances, stock status, timestamps other than command `created_at`, or archive flags through ordinary create and patch requests.

## 4. Inventory API

Server reads show synchronized records. The tablet uses IndexedDB for its live inventory and lets authorized staff queue supported item changes locally when offline.

### GET /api/v1/inventory

Lists items for inventory screens and selection controls. Optional `q` matches a normalized name substring or exact UUID. Optional filters are `category_id`, `stock_status=sufficient|low_stock|out_of_stock`, and `record_status=active|archived|all` (default `active`). Sort with `sort=name|available_quantity` and `order=asc|desc`; defaults are name and ascending. Supports shared pagination. Invalid query values return `400`. Offline, apply the same filters to local records.

```http
GET /api/v1/inventory?q=coffee&category_id=00000000-0000-4000-8000-000000000001&sort=name
```

**200**

```json
{
  "success": true,
  "data": [
    {
      "item_id": "00000000-0000-4000-8000-000000000002",
      "category_id": "00000000-0000-4000-8000-000000000001",
      "name": "Coffee Beans",
      "normalized_name": "coffee beans",
      "unit_of_measurement": "kg",
      "minimum_stock_level": 1000,
      "is_active": true,
      "created_at": "2026-11-18T02:00:00Z",
      "updated_at": "2026-11-18T02:00:00Z",
      "available_quantity": 800,
      "stock_status": "low_stock"
    }
  ],
  "meta": {
    "page": 1,
    "page_size": 25,
    "total": 1
  }
}
```

### GET /api/v1/inventory/{item_id}

Retrieves item details, including a derived availability and stock classification. Requires the path UUID; archived items remain readable when authorized. Returns `404 ITEM_NOT_FOUND` for a missing item. Use the local item key for offline detail screens.

```http
GET /api/v1/inventory/00000000-0000-4000-8000-000000000002
```

**200**

```json
{
  "success": true,
  "data": {
    "item_id": "00000000-0000-4000-8000-000000000002",
    "category_id": "00000000-0000-4000-8000-000000000001",
    "name": "Coffee Beans",
    "normalized_name": "coffee beans",
    "unit_of_measurement": "kg",
    "minimum_stock_level": 1000,
    "is_active": true,
    "created_at": "2026-11-18T02:00:00Z",
    "updated_at": "2026-11-18T02:00:00Z",
    "available_quantity": 800,
    "stock_status": "low_stock"
  }
}
```

### POST /api/v1/inventory

Creates an item using the common command fields plus required `item_id`, `category_id`, `name`, `unit_of_measurement`, and `minimum_stock_level`. The server validates an active category, an approved unit, a nonblank normalized name, and a nonnegative minimum. The item starts with zero derived stock. Opening quantity uses a separate `initial_stock` movement. Returns `404 CATEGORY_NOT_FOUND`, `409 DUPLICATE_ITEM` or another ID conflict, or `422 VALIDATION_ERROR`. The form should warn about potential local duplicates and let staff choose stock-in for an existing item. Offline, queue `create_item`.

```http
POST /api/v1/inventory
```

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000011",
  "created_at": "2026-11-18T02:05:00Z",
  "item_id": "00000000-0000-4000-8000-000000000002",
  "category_id": "00000000-0000-4000-8000-000000000001",
  "name": "Coffee Beans",
  "unit_of_measurement": "kg",
  "minimum_stock_level": 1000
}
```

**201**

```json
{
  "success": true,
  "data": {
    "item_id": "00000000-0000-4000-8000-000000000002",
    "category_id": "00000000-0000-4000-8000-000000000001",
    "name": "Coffee Beans",
    "normalized_name": "coffee beans",
    "unit_of_measurement": "kg",
    "minimum_stock_level": 1000,
    "is_active": true,
    "created_at": "2026-11-18T02:05:00Z",
    "updated_at": "2026-11-18T02:05:00Z",
    "available_quantity": 0,
    "stock_status": "out_of_stock"
  }
}
```

### PATCH /api/v1/inventory/{item_id}

Edits an active item’s details. Requires the path UUID and the common command fields. The allowed PATCH fields are `name`, `category_id`, `minimum_stock_level`, and conditionally `unit_of_measurement`. Supply at least one. Allow a unit change only before any batch or movement exists and when no pending command depends on the current unit. A change to an established unit or scale requires separate approved migration, preserving original records and pending command interpretation. Scale is an immutable unit-profile property and is never a PATCH field. Check duplicates after changes and validate category and threshold. Quantity edits and direct status changes return `422`; missing references return `404`; archived state or an agreed uniqueness conflict returns `409`. Offline, queue `update_item` and keep movement history intact.

```http
PATCH /api/v1/inventory/00000000-0000-4000-8000-000000000002
```

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000012",
  "created_at": "2026-11-18T02:05:00Z",
  "minimum_stock_level": 1200
}
```

**200**

```json
{
  "success": true,
  "data": {
    "item_id": "00000000-0000-4000-8000-000000000002",
    "category_id": "00000000-0000-4000-8000-000000000001",
    "name": "Coffee Beans",
    "normalized_name": "coffee beans",
    "unit_of_measurement": "kg",
    "minimum_stock_level": 1200,
    "is_active": true,
    "created_at": "2026-11-18T02:00:00Z",
    "updated_at": "2026-11-18T02:05:00Z",
    "available_quantity": 800,
    "stock_status": "low_stock"
  }
}
```

### POST /api/v1/inventory/{item_id}/archive

Archives the item without deleting its batches or history. Requires the path UUID and common command fields. An already archived item can be acknowledged with its current state. For a transition from active to archived, the proposed safeguard blocks archival while stock remains. Staff use an approved stock movement to account for remaining stock. Returns `404 ITEM_NOT_FOUND` or `409 ITEM_HAS_STOCK`. The offline archive action uses the same checks and queues `archive_item`.

```http
POST /api/v1/inventory/00000000-0000-4000-8000-000000000002/archive
```

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000013",
  "created_at": "2026-11-18T02:05:00Z"
}
```

**200**

```json
{
  "success": true,
  "data": {
    "item_id": "00000000-0000-4000-8000-000000000002",
    "category_id": "00000000-0000-4000-8000-000000000001",
    "name": "Coffee Beans",
    "normalized_name": "coffee beans",
    "unit_of_measurement": "kg",
    "minimum_stock_level": 1000,
    "is_active": false,
    "created_at": "2026-11-18T02:00:00Z",
    "updated_at": "2026-11-18T02:05:00Z",
    "available_quantity": 0,
    "stock_status": "out_of_stock"
  }
}
```

## 5. Category API

Category routes support selectors and category administration. Use the shared name normalization and tie-breakers in the [database algorithms](DATABASE_DESIGN.md#5-data-structures-and-algorithms). Preserve the display name. Enforce uniqueness according to agreed rules, including treatment of archived names. The tablet uses local categories and queues supported changes.

### GET /api/v1/categories

Lists categories for filters and category management. Accepts optional `q` for normalized name search, `record_status=active|archived|all` (default active), and shared pagination. Sorts by normalized name and ID. Invalid parameters return `400`; offline, list matching local categories.

```http
GET /api/v1/categories?record_status=active
```

**200**

```json
{
  "success": true,
  "data": [
    {
      "category_id": "00000000-0000-4000-8000-000000000001",
      "name": "Ingredients",
      "normalized_name": "ingredients",
      "description": null,
      "is_active": true,
      "created_at": "2026-11-18T02:00:00Z",
      "updated_at": "2026-11-18T02:00:00Z"
    }
  ],
  "meta": {
    "page": 1,
    "page_size": 25,
    "total": 1
  }
}
```

### GET /api/v1/categories/{category_id}

Retrieves a category by UUID, including archived records where authorized. Missing categories return `404 CATEGORY_NOT_FOUND`. Offline, retrieve the stored category.

```http
GET /api/v1/categories/00000000-0000-4000-8000-000000000001
```

**200**

```json
{
  "success": true,
  "data": {
    "category_id": "00000000-0000-4000-8000-000000000001",
    "name": "Ingredients",
    "normalized_name": "ingredients",
    "description": null,
    "is_active": true,
    "created_at": "2026-11-18T02:00:00Z",
    "updated_at": "2026-11-18T02:00:00Z"
  }
}
```

### POST /api/v1/categories

Creates a category. Requires common command fields, `category_id`, and a nonblank `name`; nullable `description` is optional. Returns `409 DUPLICATE_CATEGORY` or another ID conflict, or `422 VALIDATION_ERROR`. Offline, validate and queue `create_category`.

```http
POST /api/v1/categories
```

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000014",
  "created_at": "2026-11-18T02:05:00Z",
  "category_id": "00000000-0000-4000-8000-000000000001",
  "name": "Ingredients"
}
```

**201**

```json
{
  "success": true,
  "data": {
    "category_id": "00000000-0000-4000-8000-000000000001",
    "name": "Ingredients",
    "normalized_name": "ingredients",
    "description": null,
    "is_active": true,
    "created_at": "2026-11-18T02:05:00Z",
    "updated_at": "2026-11-18T02:05:00Z"
  }
}
```

### PATCH /api/v1/categories/{category_id}

Updates an active category. Requires path UUID and common command fields. Supply `name`, nullable `description`, or both. Recalculate the normalized name when renamed. Returns `404 CATEGORY_NOT_FOUND`, `409 DUPLICATE_CATEGORY` or a state conflict, or `422 VALIDATION_ERROR`. Offline, queue `update_category`.

```http
PATCH /api/v1/categories/00000000-0000-4000-8000-000000000001
```

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000015",
  "created_at": "2026-11-18T02:05:00Z",
  "name": "Cafe Ingredients"
}
```

**200**

```json
{
  "success": true,
  "data": {
    "category_id": "00000000-0000-4000-8000-000000000001",
    "name": "Cafe Ingredients",
    "normalized_name": "cafe ingredients",
    "description": null,
    "is_active": true,
    "created_at": "2026-11-18T02:00:00Z",
    "updated_at": "2026-11-18T02:05:00Z"
  }
}
```

### POST /api/v1/categories/{category_id}/archive

Archives a category. Requires path UUID and common command fields. Under the proposed rule, any active item blocks archival with `409 CATEGORY_IN_USE`. Reassign or appropriately archive affected items first. Archived items retain their original reference and history. Re-archiving returns the current archived state. A missing category returns `404 CATEGORY_NOT_FOUND`. Offline, apply the same check before queuing `archive_category`.

```http
POST /api/v1/categories/00000000-0000-4000-8000-000000000008/archive
```

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000016",
  "created_at": "2026-11-18T02:05:00Z"
}
```

**200**

```json
{
  "success": true,
  "data": {
    "category_id": "00000000-0000-4000-8000-000000000008",
    "name": "Seasonal",
    "normalized_name": "seasonal",
    "description": null,
    "is_active": false,
    "created_at": "2026-11-18T02:00:00Z",
    "updated_at": "2026-11-18T02:05:00Z"
  }
}
```

## 6. Stock Movement API

Movements form an append-only history. An adjustment is a new movement with a reason when required. The JSON movement enum uses `initial_stock`, `stock_in`, `stock_out`, `wastage`, `positive_adjustment`, and `negative_adjustment`.

### GET /api/v1/stock-movements

Lists movements for history screens. Optional `item_id`, `movement_type`, `from`, and `to` filter records; shared pagination applies. Newest first by `created_at` and ID. Bad filters return `400`; an explicitly supplied unknown item returns `404 ITEM_NOT_FOUND`. Offline, query local movement history.

```http
GET /api/v1/stock-movements?item_id=00000000-0000-4000-8000-000000000002&movement_type=stock_out
```

**200**

```json
{
  "success": true,
  "data": [
    {
      "movement_id": "00000000-0000-4000-8000-000000000006",
      "item_id": "00000000-0000-4000-8000-000000000002",
      "movement_type": "stock_out",
      "quantity_change": -700,
      "reason": "Used during service",
      "recorded_by": null,
      "created_at": "2026-11-18T03:00:00Z",
      "allocations": [
        {
          "allocation_id": "00000000-0000-4000-8000-000000000007",
          "batch_id": "00000000-0000-4000-8000-000000000003",
          "quantity_change": -700
        }
      ]
    }
  ],
  "meta": {
    "page": 1,
    "page_size": 25,
    "total": 1
  }
}
```

### GET /api/v1/stock-movements/{movement_id}

Requires a movement UUID and returns the immutable history entry with allocations. Returns `404 MOVEMENT_NOT_FOUND` if absent. Offline, the same detail is read from local history.

```http
GET /api/v1/stock-movements/00000000-0000-4000-8000-000000000006
```

**200**

```json
{
  "success": true,
  "data": {
    "movement_id": "00000000-0000-4000-8000-000000000006",
    "item_id": "00000000-0000-4000-8000-000000000002",
    "movement_type": "stock_out",
    "quantity_change": -700,
    "reason": "Used during service",
    "recorded_by": null,
    "created_at": "2026-11-18T03:00:00Z",
    "allocations": [
      {
        "allocation_id": "00000000-0000-4000-8000-000000000007",
        "batch_id": "00000000-0000-4000-8000-000000000003",
        "quantity_change": -700
      }
    ]
  }
}
```

### POST /api/v1/stock-movements

Requires common command fields, `movement_id`, `item_id`, `movement_type`, signed `quantity_change`, and a nonempty `allocations` array. Each allocation requires `allocation_id`, `batch_id`, and signed `quantity_change`. The optional `new_batches` array supplies `batch_id` and positive `received_quantity` for newly received or opening stock; `purchase_date`, `purchase_cost`, and `expiration_date` are optional and nullable. Each new batch inherits the movement item and is linked to its originating allocation. Under approved correction rules, a positive adjustment may allocate to an existing or a separately identified batch. `reason` is required where the agreed rules require it, proposed for adjustments and wastage. Nullable `recorded_by` is conditional on approved staff attribution and must match authorized attribution.

Check that the item exists and is active. Validate the movement type, nonzero quantity and sign, allocations for the same item, unique movement/batch pairs, allocation sum, and sufficient item and batch stock. Incoming allocations to new batches match their received quantities. Report `404 ITEM_NOT_FOUND`, `409 RESOURCE_CONFLICT` or `OPERATION_ID_CONFLICT`, or `422 INVALID_QUANTITY`, `INSUFFICIENT_STOCK`, `INVALID_BATCH_ALLOCATION`, or `VALIDATION_ERROR`. Offline, commit the movement, batch changes, allocations, and queue entry together and queue `record_stock_movement`.

For `initial_stock` and `stock_in`, create the appropriate opening or delivery batch and its originating allocation. A `stock_out`, `wastage`, or `negative_adjustment` must allocate to existing batches. Direct submission and synchronization invoke the same validator and apply the same receipt rule. The server commits stock movements, any new delivery records, allocations, derived balance changes if materialized, and the operation receipt together.

```http
POST /api/v1/stock-movements
```

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000017",
  "created_at": "2026-11-18T02:05:00Z",
  "movement_id": "00000000-0000-4000-8000-000000000004",
  "item_id": "00000000-0000-4000-8000-000000000002",
  "movement_type": "stock_in",
  "quantity_change": 1500,
  "reason": "Delivery",
  "recorded_by": null,
  "allocations": [
    {
      "allocation_id": "00000000-0000-4000-8000-000000000005",
      "batch_id": "00000000-0000-4000-8000-000000000003",
      "quantity_change": 1500
    }
  ],
  "new_batches": [
    {
      "batch_id": "00000000-0000-4000-8000-000000000003",
      "received_quantity": 1500,
      "purchase_date": "2026-11-18",
      "purchase_cost": null,
      "expiration_date": "2026-11-21"
    }
  ]
}
```

**201**

```json
{
  "success": true,
  "data": {
    "movement_id": "00000000-0000-4000-8000-000000000004",
    "item_id": "00000000-0000-4000-8000-000000000002",
    "movement_type": "stock_in",
    "quantity_change": 1500,
    "reason": "Delivery",
    "recorded_by": null,
    "created_at": "2026-11-18T02:05:00Z",
    "allocations": [
      {
        "allocation_id": "00000000-0000-4000-8000-000000000005",
        "batch_id": "00000000-0000-4000-8000-000000000003",
        "quantity_change": 1500
      }
    ]
  }
}
```

## 7. Stock Batch API

An inventory item is the master record. Deliveries and opening stock create individual batches through movements. Purchase dates, costs, and expiration dates belong to batches. The sum of a batch’s signed allocations determines `remaining_quantity`. No standalone batch write routes are proposed. Cost interpretation and the rules for allocating outgoing stock across batches are pending.

### GET /api/v1/inventory/{item_id}/batches

Lists item batches. Requires the item UUID. Optional `remaining_only=true|false` defaults to false. Supports pagination, sorted by `created_at` and ID. Returns `404 ITEM_NOT_FOUND` or `400` for invalid parameters. Offline, use local batch and allocation records.

```http
GET /api/v1/inventory/00000000-0000-4000-8000-000000000002/batches?remaining_only=true
```

**200**

```json
{
  "success": true,
  "data": [
    {
      "batch_id": "00000000-0000-4000-8000-000000000003",
      "item_id": "00000000-0000-4000-8000-000000000002",
      "received_quantity": 1500,
      "purchase_date": "2026-11-18",
      "purchase_cost": null,
      "expiration_date": "2026-11-21",
      "created_at": "2026-11-18T02:05:00Z",
      "remaining_quantity": 800
    }
  ],
  "meta": {
    "page": 1,
    "page_size": 25,
    "total": 1
  }
}
```

### GET /api/v1/batches/{batch_id}

Returns an individual batch and its derived remaining quantity. Requires a batch UUID and returns `404 BATCH_NOT_FOUND` when absent. The tablet can inspect the same state locally.

```http
GET /api/v1/batches/00000000-0000-4000-8000-000000000003
```

**200**

```json
{
  "success": true,
  "data": {
    "batch_id": "00000000-0000-4000-8000-000000000003",
    "item_id": "00000000-0000-4000-8000-000000000002",
    "received_quantity": 1500,
    "purchase_date": "2026-11-18",
    "purchase_cost": null,
    "expiration_date": "2026-11-21",
    "created_at": "2026-11-18T02:05:00Z",
    "remaining_quantity": 800
  }
}
```

## 8. Reports API

Reports read committed server records. The tablet computes essential equivalents from IndexedDB and displays those results during daily local-first use. Local pending and failed counts come from the local queue. Sales and top-selling-item reports belong to conditional Stage 2.

### GET /api/v1/reports/dashboard

Accepts optional `category_id` and `recent_limit` (proposed default 5 and maximum 25). An unknown category returns `404 CATEGORY_NOT_FOUND`; invalid filters return `400`. Count active items using canonical balances. Zero is out of stock, a positive quantity at or below the minimum is low stock, and a higher quantity is sufficient. Count **distinct active items** with at least one remaining batch that is expiring soon. Return `null` with an explanatory status if relevant dated batches or the warning period are unavailable. Recent movements come from recorded history within the category filter, newest first. Offline, run the same calculations locally.

```http
GET /api/v1/reports/dashboard?recent_limit=1
```

**200**

```json
{
  "success": true,
  "data": {
    "total_active_items": 1,
    "sufficient_stock_items": 0,
    "low_stock_items": 1,
    "out_of_stock_items": 0,
    "expiring_soon_items": 1,
    "expiration_status": "available",
    "recent_movements": [
      {
        "movement_id": "00000000-0000-4000-8000-000000000006",
        "item_id": "00000000-0000-4000-8000-000000000002",
        "movement_type": "stock_out",
        "quantity_change": -700,
        "reason": "Used during service",
        "recorded_by": null,
        "created_at": "2026-11-18T03:00:00Z",
        "allocations": [
          {
            "allocation_id": "00000000-0000-4000-8000-000000000007",
            "batch_id": "00000000-0000-4000-8000-000000000003",
            "quantity_change": -700
          }
        ]
      }
    ]
  }
}
```

### GET /api/v1/reports/low-stock

Returns active restocking candidates. Accepts optional `category_id`, `include_out_of_stock=true|false` (default true), and pagination. Out-of-stock items precede low-stock items, then sort by normalized name and ID. The result uses the dashboard thresholds. Invalid parameters return `400`; an unknown category returns `404 CATEGORY_NOT_FOUND`. The local inventory can generate the same restocking list.

```http
GET /api/v1/reports/low-stock?include_out_of_stock=false
```

**200**

```json
{
  "success": true,
  "data": [
    {
      "item_id": "00000000-0000-4000-8000-000000000002",
      "category_id": "00000000-0000-4000-8000-000000000001",
      "name": "Coffee Beans",
      "normalized_name": "coffee beans",
      "unit_of_measurement": "kg",
      "minimum_stock_level": 1000,
      "is_active": true,
      "created_at": "2026-11-18T02:00:00Z",
      "updated_at": "2026-11-18T02:00:00Z",
      "available_quantity": 800,
      "stock_status": "low_stock"
    }
  ],
  "meta": {
    "page": 1,
    "page_size": 25,
    "total": 1
  }
}
```

### GET /api/v1/reports/expiring

Lists dated batches with positive remaining quantity in active inventory. Accepts optional `category_id`, `status=expired|expiring_soon|all` (defaults to both alert states), and pagination. Sort by expiration date and ID. The proposed rule treats dates before the current business date as expired, and today through the configured inclusive cutoff as expiring soon. Return `meta.expiration_status` as `available`, `warning_period_not_configured`, or `no_dated_stock`; expired batches remain visible when the warning period is unset. Invalid filters return `400`; an unknown category returns `404 CATEGORY_NOT_FOUND`. Calculate local alerts using the same business date and rules. This fictional example uses business date 2026-11-18 and a four-day warning period.

```http
GET /api/v1/reports/expiring?status=expiring_soon
```

**200**

```json
{
  "success": true,
  "data": [
    {
      "batch_id": "00000000-0000-4000-8000-000000000003",
      "item_id": "00000000-0000-4000-8000-000000000002",
      "received_quantity": 1500,
      "purchase_date": "2026-11-18",
      "purchase_cost": null,
      "expiration_date": "2026-11-21",
      "created_at": "2026-11-18T02:05:00Z",
      "remaining_quantity": 800,
      "item_name": "Coffee Beans",
      "expiration_status": "expiring_soon"
    }
  ],
  "meta": {
    "page": 1,
    "page_size": 25,
    "total": 1,
    "expiration_status": "available"
  }
}
```

### GET /api/v1/reports/stock-movements

Summarizes signed movements by item, unit, and movement type. Optional `item_id`, `movement_type`, `from`, `to`, and pagination apply before grouping and listing groups as appropriate. Reports return `movement_count` and `total_quantity_change`; no totals combine unlike units. Sort groups by item ID and movement type. Invalid filters return `400`; an unknown item returns `404 ITEM_NOT_FOUND`. Use local histories for the offline equivalent.

```http
GET /api/v1/reports/stock-movements?item_id=00000000-0000-4000-8000-000000000002&movement_type=stock_out&from=2026-11-18T00:00:00Z&to=2026-11-19T00:00:00Z
```

**200**

```json
{
  "success": true,
  "data": [
    {
      "item_id": "00000000-0000-4000-8000-000000000002",
      "unit_of_measurement": "kg",
      "movement_type": "stock_out",
      "movement_count": 1,
      "total_quantity_change": -700
    }
  ],
  "meta": {
    "page": 1,
    "page_size": 25,
    "total": 1
  }
}
```

## 9. Offline Synchronization API

### POST /api/v1/sync

Accept one queued operation per request, with all six fields required. Responses apply to that operation only. The tablet persists the queue in IndexedDB. Local status, retry and resolution data, and the retained wire version belong to the local queue. Only the six command fields appear in the request body. The retained wire version determines the route version.

| Field | Meaning |
|---|---|
| `operation_id` | Unique command UUID, stable across retries. |
| `operation_type` | One supported command from the table below. |
| `entity_id` | UUID of the affected category, item, or movement, as appropriate. |
| `payload` | Command fields from the matching mutation route, excluding `operation_id`, `created_at`, and path parameters. Create commands retain their resource ID in the payload and it must match `entity_id`. |
| `created_at` | Original UTC command timestamp, stable across retries. |
| `local_sequence` | Positive safe integer recording the tablet’s persisted order. Use a monotonically increasing value assigned in the same local transaction. |

| Operation type | Entity ID | Payload |
|---|---|---|
| `create_category` | Category UUID | `category_id`, `name`, optional nullable `description`. |
| `update_category` | Category UUID | At least one allowed category detail field. |
| `archive_category` | Category UUID | Empty object. |
| `create_item` | Item UUID | `item_id`, `category_id`, `name`, `unit_of_measurement`, `minimum_stock_level`. |
| `update_item` | Item UUID | At least one allowed inventory detail field. |
| `archive_item` | Item UUID | Empty object. |
| `record_stock_movement` | Movement UUID | Movement fields documented in Section 6, including `movement_id`, `item_id`, and allocations. |

| Server or transport outcome | Response | Local handling |
|---|---|---|
| `accepted` | `200`, success with matching `operation_id`, `processed_at`, and `result`. | Mark synchronized after the matching acknowledgment is persisted locally. |
| `already_processed` | `200`, success with the same operation ID, original receipt timestamp, and original result. | Mark synchronized without reapplying the result to local inventory. |
| `rejected` | `400`, `403`, `404`, `409` or `422`, error with operation context when it can be identified. | Retain as failed and stop later operations for approved review. A malformed envelope may lack an identifiable operation ID. Diagnose the submitted command from local context. |
| `temporarily_unavailable` | `503 SYNC_FAILED` with safe details when available. A timeout, lost connection, or uncertain server error may produce no usable acknowledgment. | Keep pending and retain retry details. Stop this drain. Retry the same content and ID with a bounded delay or manual action. |
| Authentication required | `401 UNAUTHORIZED`, where implemented. | Preserve queued data and pause until the approved connected session is restored. |
| Recovery required | `409 RECOVERY_REQUIRED` for a generation mismatch or active restore. | Keep the operation pending and pause the entire drain for reviewed recovery. |

Use one active queue drain and send requests in increasing `local_sequence`, one at a time. The client uses that sequence for dependency ordering. The server validates the sequence field when supplied via sync and validates the operation against current synchronized records. The server does not infer a missing dependency from a gap in the sequence.

Flask validates the envelope and access, then checks the receipt for the operation ID. The receipt fingerprint covers the canonical type, entity ID, UTC timestamp, and payload. JSON member order and the transport-only local sequence do not affect command identity. Preserve the submitted content on retry. A matching receipt returns the original result without re-running the inventory change. A changed command with the same ID returns `409 OPERATION_ID_CONFLICT`. An unseen ID is validated against current records. A single SQLite transaction applies the accepted change and records the unique receipt. If concurrent delivery races for the same ID, roll back the losing write and check the committed receipt before responding. Acknowledge success only after commit.

If connectivity drops after SQLite commits but before the tablet sees the response, the tablet still shows the operation as pending. Resend the original command. The server returns `already_processed` and stock stays the same. An acknowledgment confirms the queued command. It does not authorize replacing local records with the returned server view.

If a sequence fails partway, prior successful requests remain committed. The failed entry remains pending after a transient failure or failed after a definitive rejection. Later entries remain stored, pending, and visibly blocked behind that operation. Preserve submitted content and local history during reconciliation. Corrected commands require an approved repair procedure that accounts for affected local records and dependencies. Run sync on initialized app open, on connectivity recovery, and on manual request where appropriate. Browser background sync is optional.

### Canonical command profile and equivalence

Normalize both direct routes and sync requests to an object with exactly `command_schema_version`, `operation_type`, `entity_id`, `created_at`, and `payload`. Use comparison profile 1 with /api/v1 for the first slice. The tablet retains the original wire version with queued work. Preserve that version and its comparison profile until queued commands and eligible replays are accounted for. The operation ID is the receipt lookup key, and local sequence is transport ordering metadata.

1. Validate against the command schema. Reject unknown or duplicate JSON keys. Lowercase validated UUID text. Normalize event time to UTC with exactly three fractional digits. Normalize human text to NFC. For display names, trim and collapse the shared Unicode whitespace set while preserving display case. Derive the separate matching value with the pinned Unicode default full case fold. A change to the displayed spelling can be material even when matching values are equal.
2. On creates, omitted nullable descriptive and batch fields default to null, as do optional movement attribution and reason when permitted by policy. On PATCH, omitted fields mean unchanged. Explicit null clears only an explicitly nullable field such as category description. Required and nonnullable fields reject null. On movements an absent `new_batches` is equivalent to an empty array. Preserve materially different text and numeric values.
3. Sort allocation and new-batch arrays by their IDs because their order is immaterial to the accounting. Keep order for lists with ordered semantics. Use JSON Canonicalization Scheme encoding for the normalized object and store its SHA-256 fingerprint in the receipt along with the profile version. Compare retries under the original profile. The fingerprint covers neither transport headers nor sequence numbers. [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)
4. An equivalent command with an existing ID returns its original acceptance result. A materially different canonical command with that ID returns `409 OPERATION_ID_CONFLICT`. Direct requests and sync share the same service and receipt rules. See the [fictional shared fixtures](TESTING_PLAN.md#shared-command-and-recovery-fixtures).

### Resolution and concurrency

Delivery states stay `pending`, `failed`, and `synchronized`. The resolution field starts at `none`. Definitive rejection is `failed / needs_review`; a temporary or uncertain failure remains `pending / none`. Later entries stay pending with a derived blocked indicator. A supervised correction changes the original resolution to `resolved_replaced` and links the new command ID. A reviewed closure without replacement uses `resolved_closed`. Resolved originals and their history remain in the audit and are excluded from active queue counts. Repair coordination is local and supervised under the [architecture procedure](ARCHITECTURE.md#supervised-rejection-repair). No repair mutation endpoint is proposed here.

The tablet sends through one exclusive origin-scoped queue owner with one in-flight request. When ownership is unavailable, preserve pending work and pause uploads. A server generation mismatch pauses the drain for recovery without reclassifying the command as permanently rejected. On the server, validate against current stock and persist the change and receipt in a serialized SQLite transaction. A contention failure without a commit is retryable using the original command.

### A. Create an inventory item offline

The category is synchronized already. The tablet queued item creation at sequence 41. All examples A–F target `POST /api/v1/sync`, use fictional data, and form a sequence unless a replay is indicated.

**Request**

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000031",
  "operation_type": "create_item",
  "entity_id": "00000000-0000-4000-8000-000000000002",
  "payload": {
    "item_id": "00000000-0000-4000-8000-000000000002",
    "category_id": "00000000-0000-4000-8000-000000000001",
    "name": "Coffee Beans",
    "unit_of_measurement": "kg",
    "minimum_stock_level": 1000
  },
  "created_at": "2026-11-18T02:00:00Z",
  "local_sequence": 41
}
```

**200 response**

```json
{
  "success": true,
  "data": {
    "operation_id": "00000000-0000-4000-8000-000000000031",
    "outcome": "accepted",
    "processed_at": "2026-11-18T03:01:00Z",
    "result": {
      "item_id": "00000000-0000-4000-8000-000000000002",
      "category_id": "00000000-0000-4000-8000-000000000001",
      "name": "Coffee Beans",
      "normalized_name": "coffee beans",
      "unit_of_measurement": "kg",
      "minimum_stock_level": 1000,
      "is_active": true,
      "created_at": "2026-11-18T02:00:00Z",
      "updated_at": "2026-11-18T02:00:00Z",
      "available_quantity": 0,
      "stock_status": "out_of_stock"
    }
  }
}
```

### B. Edit an existing item offline

**Request**

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000032",
  "operation_type": "update_item",
  "entity_id": "00000000-0000-4000-8000-000000000002",
  "payload": {
    "minimum_stock_level": 1200
  },
  "created_at": "2026-11-18T02:02:00Z",
  "local_sequence": 42
}
```

**200 response**

```json
{
  "success": true,
  "data": {
    "operation_id": "00000000-0000-4000-8000-000000000032",
    "outcome": "accepted",
    "processed_at": "2026-11-18T03:01:01Z",
    "result": {
      "item_id": "00000000-0000-4000-8000-000000000002",
      "category_id": "00000000-0000-4000-8000-000000000001",
      "name": "Coffee Beans",
      "normalized_name": "coffee beans",
      "unit_of_measurement": "kg",
      "minimum_stock_level": 1200,
      "is_active": true,
      "created_at": "2026-11-18T02:00:00Z",
      "updated_at": "2026-11-18T02:02:00Z",
      "available_quantity": 0,
      "stock_status": "out_of_stock"
    }
  }
}
```

### C. Receive new stock offline

The server creates the new batch, movement, and allocation together with the receipt.

**Request**

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000033",
  "operation_type": "record_stock_movement",
  "entity_id": "00000000-0000-4000-8000-000000000004",
  "payload": {
    "movement_id": "00000000-0000-4000-8000-000000000004",
    "item_id": "00000000-0000-4000-8000-000000000002",
    "movement_type": "stock_in",
    "quantity_change": 1500,
    "reason": "Delivery",
    "recorded_by": null,
    "allocations": [
      {
        "allocation_id": "00000000-0000-4000-8000-000000000005",
        "batch_id": "00000000-0000-4000-8000-000000000003",
        "quantity_change": 1500
      }
    ],
    "new_batches": [
      {
        "batch_id": "00000000-0000-4000-8000-000000000003",
        "received_quantity": 1500,
        "purchase_date": "2026-11-18",
        "purchase_cost": null,
        "expiration_date": "2026-11-21"
      }
    ]
  },
  "created_at": "2026-11-18T02:05:00Z",
  "local_sequence": 43
}
```

**200 response**

```json
{
  "success": true,
  "data": {
    "operation_id": "00000000-0000-4000-8000-000000000033",
    "outcome": "accepted",
    "processed_at": "2026-11-18T03:01:02Z",
    "result": {
      "movement_id": "00000000-0000-4000-8000-000000000004",
      "item_id": "00000000-0000-4000-8000-000000000002",
      "movement_type": "stock_in",
      "quantity_change": 1500,
      "reason": "Delivery",
      "recorded_by": null,
      "created_at": "2026-11-18T02:05:00Z",
      "allocations": [
        {
          "allocation_id": "00000000-0000-4000-8000-000000000005",
          "batch_id": "00000000-0000-4000-8000-000000000003",
          "quantity_change": 1500
        }
      ]
    }
  }
}
```

### D. Record stock usage offline

The batch drops from 1,500 to 800 scaled units.

**Request**

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000034",
  "operation_type": "record_stock_movement",
  "entity_id": "00000000-0000-4000-8000-000000000006",
  "payload": {
    "movement_id": "00000000-0000-4000-8000-000000000006",
    "item_id": "00000000-0000-4000-8000-000000000002",
    "movement_type": "stock_out",
    "quantity_change": -700,
    "reason": "Used during service",
    "recorded_by": null,
    "allocations": [
      {
        "allocation_id": "00000000-0000-4000-8000-000000000007",
        "batch_id": "00000000-0000-4000-8000-000000000003",
        "quantity_change": -700
      }
    ]
  },
  "created_at": "2026-11-18T03:00:00Z",
  "local_sequence": 44
}
```

**200 response**

```json
{
  "success": true,
  "data": {
    "operation_id": "00000000-0000-4000-8000-000000000034",
    "outcome": "accepted",
    "processed_at": "2026-11-18T03:01:03Z",
    "result": {
      "movement_id": "00000000-0000-4000-8000-000000000006",
      "item_id": "00000000-0000-4000-8000-000000000002",
      "movement_type": "stock_out",
      "quantity_change": -700,
      "reason": "Used during service",
      "recorded_by": null,
      "created_at": "2026-11-18T03:00:00Z",
      "allocations": [
        {
          "allocation_id": "00000000-0000-4000-8000-000000000007",
          "batch_id": "00000000-0000-4000-8000-000000000003",
          "quantity_change": -700
        }
      ]
    }
  }
}
```

### E. Retry an accepted operation

If the response for sequence 44 is lost, this identical request returns the original receipt. The balance stays at 800 scaled units.

**Request**

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000034",
  "operation_type": "record_stock_movement",
  "entity_id": "00000000-0000-4000-8000-000000000006",
  "payload": {
    "movement_id": "00000000-0000-4000-8000-000000000006",
    "item_id": "00000000-0000-4000-8000-000000000002",
    "movement_type": "stock_out",
    "quantity_change": -700,
    "reason": "Used during service",
    "recorded_by": null,
    "allocations": [
      {
        "allocation_id": "00000000-0000-4000-8000-000000000007",
        "batch_id": "00000000-0000-4000-8000-000000000003",
        "quantity_change": -700
      }
    ]
  },
  "created_at": "2026-11-18T03:00:00Z",
  "local_sequence": 44
}
```

**200 response**

```json
{
  "success": true,
  "data": {
    "operation_id": "00000000-0000-4000-8000-000000000034",
    "outcome": "already_processed",
    "processed_at": "2026-11-18T03:01:03Z",
    "result": {
      "movement_id": "00000000-0000-4000-8000-000000000006",
      "item_id": "00000000-0000-4000-8000-000000000002",
      "movement_type": "stock_out",
      "quantity_change": -700,
      "reason": "Used during service",
      "recorded_by": null,
      "created_at": "2026-11-18T03:00:00Z",
      "allocations": [
        {
          "allocation_id": "00000000-0000-4000-8000-000000000007",
          "batch_id": "00000000-0000-4000-8000-000000000003",
          "quantity_change": -700
        }
      ]
    }
  }
}
```

### F. Handle a rejected operation

A request attempting to withdraw 1,000 scaled units when only 800 are available fails server revalidation. No movement or receipt is committed for this request.

**Request**

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000035",
  "operation_type": "record_stock_movement",
  "entity_id": "00000000-0000-4000-8000-000000000009",
  "payload": {
    "movement_id": "00000000-0000-4000-8000-000000000009",
    "item_id": "00000000-0000-4000-8000-000000000002",
    "movement_type": "stock_out",
    "quantity_change": -1000,
    "reason": "Used during service",
    "recorded_by": null,
    "allocations": [
      {
        "allocation_id": "00000000-0000-4000-8000-000000000010",
        "batch_id": "00000000-0000-4000-8000-000000000003",
        "quantity_change": -1000
      }
    ]
  },
  "created_at": "2026-11-18T03:05:00Z",
  "local_sequence": 45
}
```

**422 response**

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "The recorded stock is too low for this withdrawal.",
    "details": {
      "operation_id": "00000000-0000-4000-8000-000000000035",
      "outcome": "rejected",
      "available_quantity": 800
    }
  }
}
```

### G. Synchronize multiple dependent operations

This separate fictional scenario starts with an empty server catalog. The tablet sends three individual requests to `POST /api/v1/sync`, advancing only after each acknowledgment. If request 2 is rejected, the created category remains committed and request 3 stays pending and blocked. If its response is lost, retry request 2 with the same ID and send request 3 once the receipt is confirmed.

**1. Create the category**

**Request**

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000040",
  "operation_type": "create_category",
  "entity_id": "00000000-0000-4000-8000-000000000001",
  "payload": {
    "category_id": "00000000-0000-4000-8000-000000000001",
    "name": "Ingredients"
  },
  "created_at": "2026-11-18T02:00:00Z",
  "local_sequence": 1
}
```

**200 response**

```json
{
  "success": true,
  "data": {
    "operation_id": "00000000-0000-4000-8000-000000000040",
    "outcome": "accepted",
    "processed_at": "2026-11-18T03:02:00Z",
    "result": {
      "category_id": "00000000-0000-4000-8000-000000000001",
      "name": "Ingredients",
      "normalized_name": "ingredients",
      "description": null,
      "is_active": true,
      "created_at": "2026-11-18T02:00:00Z",
      "updated_at": "2026-11-18T02:00:00Z"
    }
  }
}
```

**2. Create an item referencing that category**

**Request**

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000041",
  "operation_type": "create_item",
  "entity_id": "00000000-0000-4000-8000-000000000002",
  "payload": {
    "item_id": "00000000-0000-4000-8000-000000000002",
    "category_id": "00000000-0000-4000-8000-000000000001",
    "name": "Coffee Beans",
    "unit_of_measurement": "kg",
    "minimum_stock_level": 1000
  },
  "created_at": "2026-11-18T02:00:00Z",
  "local_sequence": 2
}
```

**200 response**

```json
{
  "success": true,
  "data": {
    "operation_id": "00000000-0000-4000-8000-000000000041",
    "outcome": "accepted",
    "processed_at": "2026-11-18T03:02:01Z",
    "result": {
      "item_id": "00000000-0000-4000-8000-000000000002",
      "category_id": "00000000-0000-4000-8000-000000000001",
      "name": "Coffee Beans",
      "normalized_name": "coffee beans",
      "unit_of_measurement": "kg",
      "minimum_stock_level": 1000,
      "is_active": true,
      "created_at": "2026-11-18T02:00:00Z",
      "updated_at": "2026-11-18T02:00:00Z",
      "available_quantity": 0,
      "stock_status": "out_of_stock"
    }
  }
}
```

**3. Receive stock referencing that item**

**Request**

```json
{
  "operation_id": "00000000-0000-4000-8000-000000000042",
  "operation_type": "record_stock_movement",
  "entity_id": "00000000-0000-4000-8000-000000000004",
  "payload": {
    "movement_id": "00000000-0000-4000-8000-000000000004",
    "item_id": "00000000-0000-4000-8000-000000000002",
    "movement_type": "stock_in",
    "quantity_change": 1500,
    "reason": "Delivery",
    "recorded_by": null,
    "allocations": [
      {
        "allocation_id": "00000000-0000-4000-8000-000000000005",
        "batch_id": "00000000-0000-4000-8000-000000000003",
        "quantity_change": 1500
      }
    ],
    "new_batches": [
      {
        "batch_id": "00000000-0000-4000-8000-000000000003",
        "received_quantity": 1500,
        "purchase_date": "2026-11-18",
        "purchase_cost": null,
        "expiration_date": "2026-11-21"
      }
    ]
  },
  "created_at": "2026-11-18T02:05:00Z",
  "local_sequence": 3
}
```

**200 response**

```json
{
  "success": true,
  "data": {
    "operation_id": "00000000-0000-4000-8000-000000000042",
    "outcome": "accepted",
    "processed_at": "2026-11-18T03:02:02Z",
    "result": {
      "movement_id": "00000000-0000-4000-8000-000000000004",
      "item_id": "00000000-0000-4000-8000-000000000002",
      "movement_type": "stock_in",
      "quantity_change": 1500,
      "reason": "Delivery",
      "recorded_by": null,
      "created_at": "2026-11-18T02:05:00Z",
      "allocations": [
        {
          "allocation_id": "00000000-0000-4000-8000-000000000005",
          "batch_id": "00000000-0000-4000-8000-000000000003",
          "quantity_change": 1500
        }
      ]
    }
  }
}
```

## 10. Initialization and Recovery

### GET /api/v1/snapshot

Returns a consistent inventory snapshot for approved initialization, settings refresh, or recovery. Requires connected access under the future permissions policy. No body is required. In authorized recovery, repeat the optional `receipt_id` query parameter for individual command UUIDs in bounded groups. Return one `receipt_checks` entry per requested ID, with status `accepted` and its original `processed_at`, or `missing` with null `processed_at`. Check them against the same restored generation as the snapshot. Ordinary initialization returns an empty `receipt_checks` list. Read the whole snapshot from one consistent server view, including archived rows needed for history. Returns `401` when applicable, `403` for unapproved access, and `503` if unavailable. The tablet stages and validates the result before using it. Offline, it continues to use existing IndexedDB records.

The proposed schema includes a version and UTC timestamp, Categories, InventoryItems, StockBatches, StockMovements, and BatchAllocations. Snapshot allocations include the movement ID and are stored separately from movement rows. Applicable ApplicationSettings and limited last-success metadata accompany the data. Include a minimal StaffUsers lookup for referenced attribution if approved. Use verified individual receipt checks during recovery. The latest successful sync timestamp is informational. Expiration settings in the example are fictional, and Asia/Manila is the proposed timezone pending confirmation. A null warning period keeps already expired stock visible and disables upcoming warnings. Never expose passwords, receipts with internal fingerprints, retry credentials, or unnecessary staff information.

```http
GET /api/v1/snapshot
```

**200**

```json
{
  "success": true,
  "data": {
    "schema_version": 1,
    "server_generation_id": "00000000-0000-4000-8000-000000000070",
    "receipt_checks": [],
    "snapshot_at": "2026-11-18T03:04:00Z",
    "categories": [
      {
        "category_id": "00000000-0000-4000-8000-000000000001",
        "name": "Ingredients",
        "normalized_name": "ingredients",
        "description": null,
        "is_active": true,
        "created_at": "2026-11-18T02:00:00Z",
        "updated_at": "2026-11-18T02:00:00Z"
      }
    ],
    "inventory_items": [
      {
        "item_id": "00000000-0000-4000-8000-000000000002",
        "category_id": "00000000-0000-4000-8000-000000000001",
        "name": "Coffee Beans",
        "normalized_name": "coffee beans",
        "unit_of_measurement": "kg",
        "minimum_stock_level": 1200,
        "is_active": true,
        "created_at": "2026-11-18T02:00:00Z",
        "updated_at": "2026-11-18T02:02:00Z",
        "available_quantity": 800,
        "stock_status": "low_stock"
      }
    ],
    "stock_batches": [
      {
        "batch_id": "00000000-0000-4000-8000-000000000003",
        "item_id": "00000000-0000-4000-8000-000000000002",
        "received_quantity": 1500,
        "purchase_date": "2026-11-18",
        "purchase_cost": null,
        "expiration_date": "2026-11-21",
        "created_at": "2026-11-18T02:05:00Z",
        "remaining_quantity": 800
      }
    ],
    "stock_movements": [
      {
        "movement_id": "00000000-0000-4000-8000-000000000004",
        "item_id": "00000000-0000-4000-8000-000000000002",
        "movement_type": "stock_in",
        "quantity_change": 1500,
        "reason": "Delivery",
        "recorded_by": null,
        "created_at": "2026-11-18T02:05:00Z"
      },
      {
        "movement_id": "00000000-0000-4000-8000-000000000006",
        "item_id": "00000000-0000-4000-8000-000000000002",
        "movement_type": "stock_out",
        "quantity_change": -700,
        "reason": "Used during service",
        "recorded_by": null,
        "created_at": "2026-11-18T03:00:00Z"
      }
    ],
    "batch_allocations": [
      {
        "allocation_id": "00000000-0000-4000-8000-000000000005",
        "batch_id": "00000000-0000-4000-8000-000000000003",
        "quantity_change": 1500,
        "movement_id": "00000000-0000-4000-8000-000000000004"
      },
      {
        "allocation_id": "00000000-0000-4000-8000-000000000007",
        "batch_id": "00000000-0000-4000-8000-000000000003",
        "quantity_change": -700,
        "movement_id": "00000000-0000-4000-8000-000000000006"
      }
    ],
    "settings": {
      "settings_version": 1,
      "business_timezone": "Asia/Manila",
      "expiration_warning_days": 4
    },
    "sync": {
      "last_committed_operation_id": "00000000-0000-4000-8000-000000000034",
      "last_committed_at": "2026-11-18T03:01:03Z"
    },
    "backup": {
      "last_successful_backup_at": null
    }
  }
}
```

Initial setup on a new or empty authorized device downloads and validates the dataset before committing it locally. Normal synchronization submits queued operations and leaves local records in place. For recovery, compare the snapshot with existing local data and receipts, protect pending work through an approved export or recovery procedure, and obtain approval from the designated administrator before replacement. A server restore rotates the generation before normal mutations resume. Compare individual receipts for pending and recently acknowledged commands. Identify missing accepted work, verify balances and movement history, and have an authorized reviewer approve reconciliation before accepting the new generation. Keep all pending and newer local records during comparison. Take no automatic replay or snapshot replacement action on a generation mismatch. Check snapshot schema compatibility, record references, and balances before importing.

## 11. Backup API

Synchronization moves accepted operations to a server. Backups preserve restorable points in time, including receipts, for recovering from loss or corruption.

| Proposed capability | Safeguards |
|---|---|
| Create a backup | Restrict to approved administrators or an authorized scheduled process. Capture a consistent snapshot of data and receipts. |
| Retrieve backup metadata | Limit access to approved roles. Provide creation time, schema version, verification result, and last successful backup. |
| Export a backup | Require explicit authorization. Verify artifact integrity and protect storage, transfer, and audit records. |
| Restore a backup | Verify integrity, version, relationships, balances, and receipts in an isolated environment. Require explicit authorization and a plan for affected pending or acknowledged tablet operations before production recovery. |

Backup route paths and restore behavior are deferred. Frequency, retention, permissions, storage, and ownership remain pending.

## 12. Authentication and Authorization

Fulfil Cafe requested staff access. Proposed roles distinguish an owner or administrator who approves recovery, manages protected settings, and controls backup access from staff who perform day-to-day inventory actions. Exact permissions, including archival and deletion privileges, need approval. Protect settings, backup export, and recovery with server-side authorization.

Use secure connected authentication over HTTPS, with a session lifetime, expiry, and logout policy appropriate for a shared tablet. If passwords are approved, use secure server-side password hashing and separate credentials from normal inventory and snapshots. Staff attribution references approved staff records and is validated by the server. Offline staff access and attribution need a policy for a disconnected shared tablet, including what happens after session expiry and how staff changes take effect. Endpoints, credential storage policies, and offline sign-in are deferred.

## 13. Error Handling

Use the common error envelope. Provide a stable code, concise message, and safe details such as rejected fields and the queue operation ID when known.

| Code | HTTP | Meaning or client action |
|---|---|---|
| `INVALID_REQUEST` | 400 | Correct malformed JSON, missing envelope structure, or invalid path or query values. |
| `VALIDATION_ERROR` | 422 | Show field guidance or explain the rule that blocked the operation. |
| `ITEM_NOT_FOUND` | 404 | The selected item is absent. Check the item ID or a prerequisite operation. |
| `CATEGORY_NOT_FOUND` | 404 | The category is absent. Check the selection or a prerequisite operation. |
| `MOVEMENT_NOT_FOUND` | 404 | No movement matches the identifier. |
| `BATCH_NOT_FOUND` | 404 | No batch matches the identifier on a batch read. |
| `DUPLICATE_ITEM` | 409 | The draft conflicts with agreed item uniqueness. Show existing candidates where permitted. |
| `DUPLICATE_CATEGORY` | 409 | The normalized category name conflicts with the approved uniqueness rule. |
| `RESOURCE_CONFLICT` | 409 | Identifier or resource-state conflict, such as editing an archived record. |
| `ITEM_HAS_STOCK` | 409 | Stock remains under the proposed archival rule. |
| `CATEGORY_IN_USE` | 409 | Active items still refer to the category. |
| `INSUFFICIENT_STOCK` | 422 | The movement would leave an invalid item or batch balance. |
| `INVALID_BATCH_ALLOCATION` | 422 | Incorrect batch reference, sign, total, or allocation structure. |
| `INVALID_QUANTITY` | 422 | Quantity has an unsupported scale, sign, bound, or zero value for a movement. |
| `OPERATION_ID_CONFLICT` | 409 | This ID already belongs to a different accepted command. Flag it for review. |
| `RECOVERY_REQUIRED` | 409 | Server generation differs or restored data is under review. Keep local work and pause ordinary synchronization. |
| `SYNC_FAILED` | 503 | Synchronization is temporarily unavailable. Keep the original operation pending. |
| `UNAUTHORIZED` | 401 | Connected authentication is required when implemented. |
| `FORBIDDEN` | 403 | The identified requester lacks permission. |
| `SERVER_ERROR` | 500 | An unexpected server problem occurred. Delivery may be uncertain. Keep queued work and retry with the same ID when appropriate. |

Present clear messages such as “This withdrawal exceeds the recorded stock.” Preserve failed operations for review and avoid indefinite automatic retries on validation errors. Connectivity errors should explain that a locally committed operation remains pending, while a failed local validation should make clear that nothing was saved.

## 14. Frontend Integration Guidelines

Keep the API client separate from UI code. It builds requests, validates envelopes and matching operation IDs, distinguishes retryable failures, and supplies loading and error states. Read local data for essential screens, commit changes and queue entries atomically, and show pending, synchronized, and failed statuses. Prevent duplicate taps from creating separate commands for the same user action. Use only the local-first path for daily inventory work, and avoid sending the same action independently to a direct mutation and the queue.

Use clearly identified fictional mock responses that match the contract while server development is underway. Treat server read data as a synchronized view. Normal reads and acknowledgments must never overwrite unsynchronized tablet records.

## 15. Backend Implementation Guidelines

Implement the Flask routes with predictable JSON envelopes, permissions, and typed field and business validation. Use SQLAlchemy transactions, SQLite foreign keys, and approved unique constraints. The same service handles direct and synchronized commands and commits inventory changes plus a processed-operation receipt together. Avoid logging sensitive payloads or returning database internals. The frontend and backend should use the same agreed rules and shared test scenarios, including cases the frontend would ordinarily reject.

## 16. Proposed API Tests

| Area | Proposed check |
|---|---|
| Inventory reads | List and retrieve synchronized items. Verify filters, pagination, sorting, and missing IDs. |
| Item creation and editing | Create a valid item, reject incomplete and duplicate items, and reject a direct quantity patch. |
| Categories and archival | Prevent duplicate categories and reject archiving categories with active items. Confirm historical records remain accessible. |
| Movements and batches | Receive stock, verify its new batch and allocation, record usage, and reject negative resulting stock or mismatched allocations. Confirm rollback leaves no partial writes. |
| Reports | Verify dashboard, low-stock threshold boundaries, expired and expiring batches, and date-filtered movement totals against fictional records. |
| Sync and replay | Submit ordered offline operations, simulate a lost response, retry a receipt, and confirm stock changes once. Replay an equivalent direct command through sync and check that its receipt prevents another write. Reuse an ID with altered content and expect a conflict. |
| Sync failures | Interrupt the server during processing and verify pending data survives reload. Reject a dependency, confirm later commands stay blocked, and preserve prior receipts. |
| Permissions and recovery | After authorization is implemented, test unauthenticated and forbidden requests. Verify snapshot consistency and ensure recovery cannot replace pending work automatically. |
| Backup | After backup policy approval, verify integrity, restricted export, and successful restoration including receipts in an isolated environment. |

## 17. Requirements Traceability

| Requirements | API coverage | Local and shared responsibilities |
|---|---|---|
| FR-001, FR-002 | Dashboard and movement reads. | Frontend computes essential counts and recent history from IndexedDB and reads offline/sync state from the local queue. Shared counting rules. |
| FR-003, FR-004, FR-005 | Inventory and category reads and mutations, plus sync. | Frontend manages local records and archives. Backend revalidates relationships and preserves history. |
| FR-006, FR-007, FR-008 | Filtered inventory, duplicate checks, and stock-in. | Frontend searches and warns locally. Teams agree on identifiers and duplicate rules. |
| FR-009, FR-010 | Movement reads, stock movement submission, and sync. | Both sides apply the same transaction and validation rules. Frontend records local stock effects and history before syncing. |
| FR-011, FR-012 | Low-stock and expiration reports, batch reads. | Frontend calculates equivalent local classifications. Teams share threshold rules and date boundaries. |
| FR-013, FR-014 | Inventory and movement reads and all report routes. | Frontend computes essential offline inventory reports and histories. Backend reports synchronized records. |
| FR-015, FR-016, FR-017 | No remote calls required for ordinary offline operation. | Frontend opens the initialized app, validates and commits local changes, and keeps the queue across restarts. Shared validation fixtures. |
| FR-018 | Sync and idempotent direct mutations. | Frontend preserves order and retry identity. Backend validates and commits exactly one stock effect per accepted command. |
| FR-019 | Snapshot and future protected backup operations. | Both teams protect pending work and verify authorized recovery. |
| FR-020, FR-021, FR-022, FR-023, FR-024, FR-025 | Conditional Stage 2 endpoint groups. | Teams confirm scope, sales data, and recipe rules after the inventory MVP. |
| NFR-001, NFR-002, NFR-007 | API supports tablet workflows without becoming a dependency for essential local requests. | Frontend verifies tablet usability, responsive operation, and PWA compatibility. |
| NFR-003, NFR-004, NFR-005 | Validation, atomic persistence, safe errors, HTTPS, and approved permissions. | Both teams protect data and use fictional or properly anonymized development records. |
| NFR-006, NFR-008 | Shared contracts, snapshots, and proposed backup workflow. | Both teams keep modules and contracts maintainable and verify restart and recovery behavior. |

Entity mappings follow the database design. Categories and InventoryItems support item and category routes. StockMovements, StockBatches, and BatchAllocations provide movement and reporting data. StaffUsers may provide attribution. SynchronizationQueue stays on the tablet, ProcessedOperations stays on the server, and ApplicationSettings supplies approved settings and success metadata.

## 18. Conditional Stage 2 API

Future endpoint groups may cover menu management, orders, sales, sales reports including top sellers, and recipe-based stock deductions. These are outside the immediate inventory MVP. Detailed routes and schemas depend on approval, an agreed sales source, and confirmed order and ingredient-use rules.

## 19. Unresolved API Decisions

See [Open Decisions](OPEN_DECISIONS.md) for approval owners and gates.

| Timing | Decisions |
|---|---|
| Before implementing inventory write validation | Confirm permitted units, exact scale and rounding, the purchase-cost basis before accepting real cost data, duplicate identity rules, archival safeguards, and batch selection and depletion. |
| Before enabling expiration alerts | Confirm the business timezone, expiration boundaries, and warning threshold. |
| Before implementing protected staff workflows or connected deployment | Confirm roles, permissions, attribution, authentication, session handling, offline access, the HTTPS host and server ownership, and the actual tablet/browser. Stub shared contracts with fictional data while decisions are pending. |
| Before deploying synchronization and recovery | Agree on queue repair, compatibility across upgrades, receipt retention, recovery authorization, backup frequency and retention, and responsibility for verification. Protected backup route definitions can follow those decisions. |
| After the inventory MVP is functional and tested | Confirm conditional sales and order requirements, sales data source, and any recipe-based deductions or Loyverse replacement decision. |
