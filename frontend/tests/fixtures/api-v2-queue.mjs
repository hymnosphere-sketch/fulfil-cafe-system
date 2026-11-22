// Fictional commands shared by the adapter and real Flask/Chrome tests.
export const at = '2026-11-19T02:00:00Z'
export const id = (number) => 'abfe090d-0000-4000-8000-' + String(number).padStart(12, '0')

export function queueCommands() {
  const command = (local_sequence, operation_type, entity_id, payload, created_at = at) =>
    ({ operation_id: id(100 + local_sequence), operation_type, entity_id, payload, created_at, local_sequence })
  const category = command(1, 'create_category', id(1), { category_id: id(1), name: 'Fictional supplies' })
  const item = command(4, 'create_item', id(2), {
    item_id: id(2), category_id: id(1), name: 'Fictional cups',
    unit_of_measurement: 'piece', minimum_stock_level: 5,
  })
  const incoming = command(6, 'record_stock_movement', id(3), {
    movement_id: id(3), item_id: id(2), movement_type: 'stock_in', quantity_change: 20,
    new_batches: [{ batch_id: id(5), received_quantity: 20 }],
    allocations: [{ allocation_id: id(6), batch_id: id(5), quantity_change: 20 }],
  })
  const outgoing = command(7, 'record_stock_movement', id(4), {
    movement_id: id(4), item_id: id(2), movement_type: 'stock_out', quantity_change: -5,
    allocations: [{ allocation_id: id(7), batch_id: id(5), quantity_change: -5 }],
  }, '2026-11-19T01:00:00Z')
  return { category, item, incoming, outgoing, ordered: [category, item, incoming, outgoing] }
}
