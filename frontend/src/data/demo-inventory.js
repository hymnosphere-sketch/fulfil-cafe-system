// Fictional data for development. Units use scale 0 and all policy settings are examples.
export const demoBusinessDate = '2026-11-19';

const catalogCreatedAt = '2026-11-01T01:00:00Z';

function demoId(number) {
  return '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
}

function category(number, name) {
  return {
    category_id: demoId(number),
    name,
    normalized_name: name.toLowerCase(),
    description: null,
    is_active: true,
    created_at: catalogCreatedAt,
    updated_at: catalogCreatedAt,
  };
}

function item(number, categoryNumber, name, unit, minimum, archivedAt = null) {
  return {
    item_id: demoId(number),
    category_id: demoId(categoryNumber),
    name,
    normalized_name: name.toLowerCase(),
    unit_of_measurement: unit,
    minimum_stock_level: minimum,
    is_active: archivedAt === null,
    created_at: catalogCreatedAt,
    updated_at: archivedAt ?? catalogCreatedAt,
  };
}

function movement(number, itemNumber, type, createdAt, batchChanges, reason = null) {
  const movementId = demoId(number);
  const allocations = batchChanges.map(([batchNumber, quantityChange], index) => ({
    allocation_id: demoId(number * 10 + index),
    movement_id: movementId,
    batch_id: demoId(batchNumber),
    quantity_change: quantityChange,
  }));

  return {
    movement: {
      movement_id: movementId,
      item_id: demoId(itemNumber),
      movement_type: type,
      quantity_change: allocations.reduce((total, allocation) => total + allocation.quantity_change, 0),
      reason,
      recorded_by: null,
      created_at: createdAt,
    },
    allocations,
  };
}

function batchWithReceipt(number, itemNumber, quantity, date, expiration = null, type = 'initial_stock') {
  const createdAt = date + 'T01:00:00Z';

  return {
    batch: {
      batch_id: demoId(number),
      item_id: demoId(itemNumber),
      received_quantity: quantity,
      purchase_date: type === 'stock_in' ? date : null,
      purchase_cost: null,
      expiration_date: expiration,
      created_at: createdAt,
    },
    ...movement(number + 100, itemNumber, type, createdAt, [[number, quantity]]),
  };
}

const categories = [
  category(1, 'Coffee'),
  category(2, 'Dairy and alternatives'),
  category(3, 'Beverage ingredients'),
  category(4, 'Packaging'),
  category(5, 'Cleaning supplies'),
];

const items = [
  item(101, 1, 'Single origin beans', 'bags', 8),
  item(102, 1, 'Espresso blend', 'bags', 8),
  item(103, 1, 'House decaf', 'bags', 4),
  item(104, 2, 'Whole milk', 'cartons', 8),
  item(105, 2, 'Oat milk', 'cartons', 6),
  item(106, 3, 'Cocoa mix', 'packs', 6),
  item(107, 3, 'Vanilla syrup', 'bottles', 4),
  item(108, 3, 'Caramel syrup', 'bottles', 4),
  item(109, 4, 'Iced cups', 'pieces', 15),
  item(110, 4, 'Paper lids', 'pieces', 10),
  item(111, 4, 'Napkins', 'packs', 12),
  item(112, 5, 'Cleaning cloths', 'pieces', 5),
  item(113, 3, 'Seasonal drink mix', 'packs', 6, '2026-11-18T10:00:00Z'),
];

const receivedBatches = [
  // Both of these batches have stock left and fall on inclusive warning-window boundaries.
  batchWithReceipt(201, 101, 5, '2026-11-10', '2026-11-19'),
  batchWithReceipt(202, 101, 7, '2026-11-16', '2026-11-26', 'stock_in'),
  batchWithReceipt(203, 102, 20, '2026-11-10'),
  // The decaf batch is depleted even though its date falls inside the warning window.
  batchWithReceipt(204, 103, 6, '2026-11-11', '2026-11-22'),
  batchWithReceipt(205, 104, 16, '2026-11-18', '2026-11-21', 'stock_in'),
  batchWithReceipt(206, 105, 12, '2026-11-13', '2026-11-18'),
  batchWithReceipt(207, 106, 16, '2026-11-12'),
  batchWithReceipt(208, 107, 6, '2026-11-12', '2026-12-05'),
  batchWithReceipt(209, 108, 10, '2026-11-17', '2026-11-26', 'stock_in'),
  batchWithReceipt(210, 109, 40, '2026-11-10'),
  batchWithReceipt(211, 110, 5, '2026-11-10'),
  batchWithReceipt(212, 111, 32, '2026-11-10'),
  batchWithReceipt(213, 112, 14, '2026-11-16', null, 'stock_in'),
  batchWithReceipt(214, 113, 6, '2026-11-09', '2026-11-28'),
];

const history = [
  movement(351, 110, 'stock_out', '2026-11-15T06:00:00Z', [[211, -5]]),
  movement(352, 102, 'stock_out', '2026-11-16T03:00:00Z', [[203, -5]]),
  movement(353, 103, 'stock_out', '2026-11-17T02:00:00Z', [[204, -6]]),
  movement(354, 107, 'negative_adjustment', '2026-11-18T06:00:00Z', [[208, -3]], 'Count correction'),
  movement(355, 113, 'wastage', '2026-11-18T09:00:00Z', [[214, -6]], 'Damaged packaging'),
  movement(356, 101, 'stock_out', '2026-11-19T04:00:00Z', [[201, -3], [202, -3]]),
  movement(357, 108, 'positive_adjustment', '2026-11-19T04:00:00Z', [[209, 1]], 'Count correction'),
  movement(358, 104, 'stock_out', '2026-11-19T05:00:00Z', [[205, -8]]),
];

const stockEvents = [...receivedBatches, ...history];

export const demoInventory = {
  categories,
  inventory_items: items,
  stock_batches: receivedBatches.map(({ batch }) => batch),
  stock_movements: stockEvents.map((event) => event.movement),
  batch_allocations: stockEvents.flatMap((event) => event.allocations),
  settings: {
    settings_version: 1,
    business_timezone: 'Asia/Manila',
    expiration_warning_days: 7,
  },
};
