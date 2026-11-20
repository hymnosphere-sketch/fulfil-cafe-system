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

const matchRank = { normalized: 0, compact: 1, spelling: 2 }

function itemNameKeys(normalized) {
  const compact = normalized.replace(/[\s_-]/gu, '')
  return {
    compact,
    // Keep numeric groups separate even across an ignored separator. Keep all
    // other punctuation significant for spelling comparisons.
    numbers: JSON.stringify(normalized.match(/\p{N}+/gu) ?? []),
    punctuation: compact.replace(/[\p{L}\p{M}\p{N}]/gu, ''),
    variant: normalized.match(/(?:^|[\s_-])([a-z]|xs|xl|xxl|xxxl|small|medium|large)$/u)?.[1],
  }
}

function similarSpelling(left, right) {
  const [longer, shorter] = left.length > right.length ? [left, right] : [right, left]
  if (shorter.length < 5) return false
  const limit = shorter.length < 8 ? 1 : Math.min(2, Math.floor(longer.length / 5))
  if (longer.length - shorter.length > limit) return false

  let previous = Array.from({ length: shorter.length + 1 }, (_, index) => index)
  let current = new Array(previous.length)
  for (let row = 1; row <= longer.length; row += 1) {
    current[0] = row
    for (let column = 1; column <= shorter.length; column += 1) {
      const substitution = longer[row - 1] === shorter[column - 1] ? 0 : 1
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + substitution)
    }
    const completed = current
    current = previous
    previous = completed
  }
  return previous[shorter.length] <= limit
}

export function findDemoItemMatches(records, name, { excludeId, idField }) {
  const normalized = normalizeDemoName(name)
  if (!normalized) return []
  const target = itemNameKeys(normalized)
  const targetCharacters = Array.from(target.compact)
  const matches = []
  for (const record of records) {
    if (record[idField] === excludeId) continue
    const other = normalizeDemoName(record.name)
    const keys = itemNameKeys(other)
    let reason
    if (normalized === other) reason = 'normalized'
    else if (target.compact && target.numbers === keys.numbers) {
      if (target.compact === keys.compact) reason = 'compact'
      else if (target.numbers === '[]' && target.variant === keys.variant && target.punctuation === keys.punctuation &&
        similarSpelling(targetCharacters, Array.from(keys.compact))) reason = 'spelling'
    }
    if (reason) matches.push({ record, reason })
  }
  return matches.sort((left, right) => matchRank[left.reason] - matchRank[right.reason] ||
    (left.record[idField] < right.record[idField] ? -1 : Number(left.record[idField] > right.record[idField])))
}
