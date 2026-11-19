export function cleanDemoName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').normalize('NFC') : ''
}

// The demo uses JavaScript whitespace and lowercase rules. The shared production case fold is pending.
export function normalizeDemoName(value) {
  return cleanDemoName(value).toLowerCase().normalize('NFC')
}

export function parseDemoMinimumStockLevel(value) {
  const quantity = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value
  return Number.isSafeInteger(quantity) && quantity >= 0 ? quantity : null
}

export function findDemoNameMatches(records, name, { excludeId, idField } = {}) {
  const normalizedName = normalizeDemoName(name)
  if (!normalizedName) return []

  return records.filter((record) =>
    (excludeId === undefined || record[idField] !== excludeId) &&
    normalizeDemoName(record.name) === normalizedName,
  )
}
