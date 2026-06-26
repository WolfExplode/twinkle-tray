const { test } = require('node:test')
const assert = require('node:assert')
const {
  vcpCodeForTarget,
  isNonVCPTarget,
  advanceCycleIndex,
  computeNewValue
} = require('../src/hotkeyActions')

test('vcpCodeForTarget maps known aliases per mode', () => {
  assert.strictEqual(vcpCodeForTarget('contrast', 'read'), 0x12)
  assert.strictEqual(vcpCodeForTarget('contrast', 'write'), 0x12)
  assert.strictEqual(vcpCodeForTarget('volume', 'read'), 0x62)
  assert.strictEqual(vcpCodeForTarget('volume', 'write'), 0x62)
})

test('vcpCodeForTarget preserves the powerState read/write asymmetry', () => {
  // Read uses 0xD6 (power mode), write uses 0xD2 — copied verbatim from the
  // original inline code. This test pins the current behaviour; if the
  // asymmetry is ever confirmed a bug, update both the module and this test.
  assert.strictEqual(vcpCodeForTarget('powerState', 'read'), 0xD6)
  assert.strictEqual(vcpCodeForTarget('powerState', 'write'), 0xD2)
})

test('vcpCodeForTarget parses raw numeric codes for unknown targets', () => {
  assert.strictEqual(vcpCodeForTarget('0x10', 'read'), 0x10)
  assert.strictEqual(vcpCodeForTarget('18', 'write'), 18)
  assert.ok(Number.isNaN(vcpCodeForTarget('nonsense', 'read')))
})

test('isNonVCPTarget flags brightness and sdr only', () => {
  assert.strictEqual(isNonVCPTarget('brightness'), true)
  assert.strictEqual(isNonVCPTarget('sdr'), true)
  assert.strictEqual(isNonVCPTarget('contrast'), false)
  assert.strictEqual(isNonVCPTarget('0x10'), false)
})

test('advanceCycleIndex advances and wraps', () => {
  assert.strictEqual(advanceCycleIndex(0, 3), 1)
  assert.strictEqual(advanceCycleIndex(1, 3), 2)
  assert.strictEqual(advanceCycleIndex(2, 3), 0, 'wraps after the last value')
})

test('advanceCycleIndex treats undefined as 0 (first press lands on index 1)', () => {
  assert.strictEqual(advanceCycleIndex(undefined, 3), 1)
})

test('advanceCycleIndex wraps a single-value cycle to 0', () => {
  assert.strictEqual(advanceCycleIndex(0, 1), 0)
  assert.strictEqual(advanceCycleIndex(undefined, 1), 0)
})

test('computeNewValue: set parses the literal value', () => {
  assert.strictEqual(computeNewValue({ type: 'set', value: '40' }), 40)
})

test('computeNewValue: offset adds to the current value', () => {
  assert.strictEqual(computeNewValue({ type: 'offset', currentValue: 50, value: '10' }), 60)
  assert.strictEqual(computeNewValue({ type: 'offset', currentValue: 50, value: '-15' }), 35)
})

test('computeNewValue: offset defaults currentValue to 0', () => {
  assert.strictEqual(computeNewValue({ type: 'offset', value: '5' }), 5)
})

test('computeNewValue: cycle returns the value at the index', () => {
  assert.strictEqual(computeNewValue({ type: 'cycle', values: [0, 50, 100], cycleIndex: 2 }), 100)
})

test('computeNewValue: unknown type returns undefined', () => {
  assert.strictEqual(computeNewValue({ type: 'refresh' }), undefined)
})
