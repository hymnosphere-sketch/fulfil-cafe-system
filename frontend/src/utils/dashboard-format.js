const unitLabels = [
  ['bag', 'bags'],
  ['bottle', 'bottles'],
  ['carton', 'cartons'],
  ['pack', 'packs'],
  ['piece', 'pieces'],
]
const labelsByUnit = new Map(
  unitLabels.flatMap(([singular, plural]) => [
    [singular, { singular, plural }],
    [plural, { singular, plural }],
  ]),
)

const numberFormat = new Intl.NumberFormat('en-PH')
const signedNumberFormat = new Intl.NumberFormat('en-PH', { signDisplay: 'exceptZero' })
const shortDateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})
const dateWithYearFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

export function formatQuantity(quantity, unit, { signed = false } = {}) {
  const formatter = signed ? signedNumberFormat : numberFormat
  const amount = formatter.format(quantity === 0 ? 0 : quantity).replace(/^-/, '−')
  const labels = labelsByUnit.get(unit)
  const form = Math.abs(quantity) === 1 ? 'singular' : 'plural'
  return { amount, unit: labels?.[form] ?? unit }
}

export function formatExpirationWindowEnd(businessDate, warningDays) {
  if (typeof businessDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate) ||
    !Number.isSafeInteger(warningDays) || warningDays < 0) {
    return null
  }

  // Use UTC calendar fields so local timezone changes cannot shift the date.
  const start = new Date(`${businessDate}T00:00:00Z`)
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== businessDate) {
    return null
  }

  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + warningDays)
  if (!Number.isFinite(end.getTime())) {
    return null
  }

  const formatter = start.getUTCFullYear() === end.getUTCFullYear()
    ? shortDateFormat
    : dateWithYearFormat
  return formatter.format(end)
}

export const movementLabels = new Map([
  ['initial_stock', 'Opening stock'],
  ['stock_in', 'Stock received'],
  ['stock_out', 'Usage recorded'],
  ['wastage', 'Waste recorded'],
  ['positive_adjustment', 'Positive adjustment'],
  ['negative_adjustment', 'Negative adjustment'],
])
