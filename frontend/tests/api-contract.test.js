import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  adaptQueueCommand,
  CommandValidationError,
  normalizeWireDisplayText,
  validateWireCommand,
} from '../src/api/commands.js'
import { canonicalFixtureCommand, serializeFixture } from './fixtures/api-v1-canonical.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/api-v1-commands.json', import.meta.url), 'utf8'))
const wireFields = ['operation_id', 'operation_type', 'entity_id', 'payload', 'created_at', 'local_sequence']
const accepted = fixture.cases.filter(({ valid }) => valid)

async function fingerprint(canonical) {
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Buffer.from(digest).toString('hex')
}

for (const sample of fixture.cases) {
  test('shared command fixture ' + sample.name, async () => {
    const { command } = sample
    if (!sample.valid) {
      assert.throws(() => validateWireCommand(command), (error) =>
        error instanceof CommandValidationError && error.code === sample.javascriptError)
      return
    }

    const record = {
      ...command, wire_version: 1, fictional: false, upload_eligible: true,
      status: 'pending', retry_count: 2, synchronized_at: null,
      resolution_audit: { previousStatus: 'pending' }, local_stock_confirmation: { selected: [] },
    }
    const before = structuredClone(record)
    const adapted = adaptQueueCommand(record)
    assert.deepEqual(Object.keys(adapted), wireFields)
    assert.deepEqual(adapted, command)
    assert.notEqual(adapted.payload, record.payload)
    if (command.operation_type === 'record_stock_movement') {
      assert.notEqual(adapted.payload.allocations, record.payload.allocations)
      assert.notEqual(adapted.payload.allocations[0], record.payload.allocations[0])
    }

    const canonical = serializeFixture(canonicalFixtureCommand(adapted))
    assert.equal(canonical, sample.canonical)
    assert.equal(await fingerprint(canonical), sample.fingerprint)
    assert.deepEqual(record, before)
  })
}

for (const [leftName, rightName, equivalent] of fixture.identity) {
  test('shared fingerprint relationship for ' + leftName + ' and ' + rightName, async () => {
    const left = accepted.find(({ name }) => name === leftName)
    const right = accepted.find(({ name }) => name === rightName)
    const leftCanonical = serializeFixture(canonicalFixtureCommand(left.command))
    const rightCanonical = serializeFixture(canonicalFixtureCommand(right.command))
    assert.equal(leftCanonical === rightCanonical, equivalent)
    assert.equal(await fingerprint(leftCanonical) === await fingerprint(rightCanonical), equivalent)
    assert.equal(left.fingerprint === right.fingerprint, equivalent)
  })
}

for (const sample of fixture.normalization) {
  test('shared normalization fixture ' + sample.name, () => {
    const display = normalizeWireDisplayText(sample.input)
    const lowercase = display.toLowerCase().normalize('NFC')
    assert.equal(display, sample.pythonDisplay)
    assert.equal(lowercase, sample.javascriptLowercase)
    if (sample.javascriptLowercase !== sample.pythonNormalized) {
      // Preserve the observed difference. JavaScript lowercasing is not full case folding.
      assert.notEqual(lowercase, sample.pythonNormalized)
    } else {
      assert.equal(lowercase, sample.pythonNormalized)
    }
  })
}

for (const sample of fixture.serialization) {
  test('shared serialization fixture ' + sample.name, async () => {
    const canonical = serializeFixture(sample.value)
    assert.equal(canonical, sample.canonical)
    assert.equal(await fingerprint(canonical), sample.fingerprint)
    if (sample.utf16KeyOrder) {
      // Default JS string order (also used by JCS) differs from the audited Python order.
      const utf16 = serializeFixture(sample.value, (left, right) => left < right ? -1 : Number(left !== right))
      assert.equal(utf16, sample.utf16KeyOrder)
      assert.notEqual(utf16, canonical)
      assert.notEqual(await fingerprint(utf16), sample.fingerprint)
    }
  })
}
