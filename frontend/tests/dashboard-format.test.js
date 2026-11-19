import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatExpirationWindowEnd, formatQuantity } from '../src/utils/dashboard-format.js'

test('signed movements use singular unit labels when their absolute quantity is one', () => {
  assert.deepEqual(formatQuantity(1, 'bottles', { signed: true }), { amount: '+1', unit: 'bottle' })
  assert.deepEqual(formatQuantity(-1, 'cartons', { signed: true }), { amount: '−1', unit: 'carton' })
  assert.deepEqual(formatQuantity(1, 'pieces'), { amount: '1', unit: 'piece' })
})

test('zero and other quantities use plural labels for known units', () => {
  assert.deepEqual(formatQuantity(0, 'bottle'), { amount: '0', unit: 'bottles' })
  assert.deepEqual(formatQuantity(3, 'bags'), { amount: '3', unit: 'bags' })
  assert.deepEqual(formatQuantity(-2, 'pack', { signed: true }), { amount: '−2', unit: 'packs' })
  assert.deepEqual(formatQuantity(-0, 'piece', { signed: true }), { amount: '0', unit: 'pieces' })
})

test('keeps unknown unit labels unchanged', () => {
  assert.deepEqual(formatQuantity(1, 'Boxes & <tags>'), { amount: '1', unit: 'Boxes & <tags>' })
  assert.deepEqual(formatQuantity(3, 'kg'), { amount: '3', unit: 'kg' })
})

test('formats the inclusive warning-window end from its configured start and length', () => {
  assert.equal(formatExpirationWindowEnd('2026-11-19', 7), '26 Nov')
  assert.equal(formatExpirationWindowEnd('2026-11-19', 0), '19 Nov')
})

test('formats warning windows across month and year boundaries', () => {
  assert.equal(formatExpirationWindowEnd('2026-11-29', 2), '1 Dec')
  assert.equal(formatExpirationWindowEnd('2026-12-30', 3), '2 Jan 2027')
  assert.equal(formatExpirationWindowEnd('2024-02-28', 1), '29 Feb')
})

test('returns no warning-window date for missing or invalid inputs', () => {
  assert.equal(formatExpirationWindowEnd('2026-11-19', null), null)
  assert.equal(formatExpirationWindowEnd('2026-11-19'), null)
  assert.equal(formatExpirationWindowEnd('2026-02-29', 7), null)
  assert.equal(formatExpirationWindowEnd('2026-11-19', -1), null)
  assert.equal(formatExpirationWindowEnd('2026-11-19', 0.5), null)
})
