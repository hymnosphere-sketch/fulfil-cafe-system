import assert from 'node:assert/strict'
import test from 'node:test'
import { findDemoItemMatches, findDemoNameMatches } from '../src/utils/demo-catalog.js'

const reason = (name, candidate = 'Chocolate Syrup') =>
  findDemoItemMatches([{ id: 'original', name: candidate }], name, { idField: 'id' })[0]?.reason

test('item warnings cover every Chocolate Syrup example with the strongest reason', () => {
  for (const name of ['Chocolate Syrup', 'chocolate syrup', 'CHOCOLATE SYRUP', '  Chocolate   Syrup ']) {
    assert.equal(reason(name), 'normalized', name)
  }
  for (const name of ['Chocolatesyrup', 'Chocolate-Syrup', 'Chocolate_Syrup']) {
    assert.equal(reason(name), 'compact', name)
  }
  for (const name of ['Choclate Syrup', 'Chocolat Syrup', 'Chocolate Syrups']) {
    assert.equal(reason(name), 'spelling', name)
  }
  assert.deepEqual(findDemoNameMatches([{ id: 'original', name: 'Chocolate Syrup' }], 'Chocolatesyrup', { idField: 'id' }), [])
})

test('fuzzy warnings respect shared words, package specifications, variants, and significant punctuation', () => {
  for (const name of ['Vanilla Syrup', 'Dark Chocolate Syrup', 'White Chocolate Syrup', 'Chocolate Powder', 'Chocolate/Syrup']) {
    assert.equal(reason(name), undefined, name)
  }
  for (const [left, right] of [
    ['Chocolate Syrup 500ml', 'Chocolate Syrup 750ml'], ['Chocolate Syrup 12oz', 'Chocolate Syrup 12ml'],
    ['Chocolate Syrup 12', 'Chocolate Syrup 1-2'], ['Serving apron S', 'Serving apron M'],
  ]) assert.equal(reason(left, right), undefined, left)
  assert.equal(reason('Syrup-500ml', 'Syrup 500ml'), 'compact')
})

test('edit distances follow the conservative short-name and code-point thresholds', () => {
  assert.equal(reason('Tea', 'Sea'), undefined)
  assert.equal(reason('Tea', 'T-ea'), 'compact')
  assert.equal(reason('Syrup', 'Srupp'), undefined)
  assert.equal(reason('Syrup', 'Syrupp'), 'spelling')
  assert.equal(reason('abcdefgh', 'abcdefij'), undefined)
  assert.equal(reason('abcdefghij', 'abcdefghkl'), 'spelling')
  assert.equal(reason('cafe\u0301 syrup', 'CAFÉ Syrup'), 'normalized')
  assert.equal(reason('抹茶シロプ', '抹茶シロップ'), 'spelling')
  assert.equal(reason('フルーツ＋', 'フルーツ'), undefined)
})

test('one result per record is ordered by strength and stable ID, even for an archived item in another unit', () => {
  const items = [
    { id: 'a', name: 'Choclate Syrup' }, { id: 'c', name: 'Chocolate Syrup' },
    { id: 'b', name: 'Chocolate Syrup', is_active: false, unit_of_measurement: 'litres' },
    { id: 'z', name: 'Chocolate_Syrup' }, { id: 'd', name: 'Chocolate Syrup' },
  ]
  const options = { idField: 'id', excludeId: 'd' }
  const matches = findDemoItemMatches(items, 'Chocolate Syrup', options)
  assert.deepEqual(matches.map(({ record, reason }) => [record.id, reason]), [
    ['b', 'normalized'], ['c', 'normalized'], ['z', 'compact'], ['a', 'spelling'],
  ])
  assert.equal(matches[0].record.is_active, false)
  assert.deepEqual(findDemoItemMatches(items.toReversed(), 'Chocolate Syrup', options), matches)
})
