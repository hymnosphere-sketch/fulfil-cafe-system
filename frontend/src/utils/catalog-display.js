import { normalizeDemoName } from './demo-catalog.js'

// Extend matching suffixes until each displayed reference is distinct.
export function shortRecordReferences(ids) {
  const unresolved = new Set(ids)
  const references = new Map()
  for (let length = 6; unresolved.size > 0; length += 2) {
    const suffixCounts = new Map()
    for (const id of unresolved) {
      const suffix = id.slice(-length)
      suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1)
    }
    for (const id of unresolved) {
      const suffix = id.slice(-length)
      if (suffixCounts.get(suffix) !== 1) continue
      references.set(id, suffix)
      unresolved.delete(id)
    }
  }
  return references
}

export function catalogItemLabels(items, { referenceFirst = false } = {}) {
  const labels = new Map()
  const groups = new Map()
  for (const { itemId, name, categoryName, unit, isActive } of items) {
    const label = `${name} · ${categoryName} · ${unit}${isActive ? '' : ' (archived)'}`
    const key = normalizeDemoName(label)
    labels.set(itemId, label)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(itemId)
  }
  const references = shortRecordReferences([...groups.values()].filter((ids) => ids.length > 1).flat())
  for (const [id, reference] of references) {
    const label = labels.get(id)
    labels.set(id, referenceFirst ? `Item ${reference} · ${label}` : `${label} · Item ${reference}`)
  }
  return labels
}
