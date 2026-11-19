import { demoInventory } from './demo-inventory.js';

export async function readDemoInventory({ scenario = 'default' } = {}) {
  if (scenario === 'error') {
    throw new Error('The fictional inventory could not be read.');
  }

  if (scenario === 'loading') {
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const snapshot = structuredClone(demoInventory);

  if (scenario === 'empty') {
    return {
      categories: [],
      inventory_items: [],
      stock_batches: [],
      stock_movements: [],
      batch_allocations: [],
      settings: snapshot.settings,
    };
  }

  if (scenario === 'unavailable') {
    snapshot.settings.expiration_warning_days = null;
  }

  return snapshot;
}
