const { test } = require('node:test')
const assert = require('node:assert')
const { applyOrder, applyRemap, applyRemaps, shouldSkipDisplay } = require('../src/monitorTransforms')

test('applyOrder sets monitor.order from matching id entries', () => {
  const monitors = {
    a: { id: 'MON_A', order: 0 },
    b: { id: 'MON_B', order: 0 },
  }
  const result = applyOrder(monitors, [
    { id: 'MON_A', order: 2 },
    { id: 'MON_B', order: 1 },
  ])
  assert.strictEqual(monitors.a.order, 2)
  assert.strictEqual(monitors.b.order, 1)
  assert.strictEqual(result, monitors, 'returns the same list it mutated')
})

test('applyOrder leaves monitors without a matching entry untouched', () => {
  const monitors = { a: { id: 'MON_A', order: 5 } }
  applyOrder(monitors, [{ id: 'OTHER', order: 9 }])
  assert.strictEqual(monitors.a.order, 5)
})

test('applyOrder with no order array is a no-op', () => {
  const monitors = { a: { id: 'MON_A', order: 3 } }
  applyOrder(monitors)
  assert.strictEqual(monitors.a.order, 3)
})

test('applyRemap applies min/max/calibration on a name match', () => {
  const monitor = { id: 'MON_A', name: 'Dell' }
  applyRemap(monitor, { Dell: { min: 10, max: 90, calibration: 50 } })
  assert.strictEqual(monitor.min, 10)
  assert.strictEqual(monitor.max, 90)
  assert.strictEqual(monitor.calibration, 50)
})

test('applyRemap id match wins over a stale name match and stops', () => {
  const monitor = { id: 'MON_A', name: 'Dell' }
  // name entry first, id entry second; id should be the final applied value
  const remaps = {
    Dell: { min: 1, max: 99, calibration: 0 },
    MON_A: { min: 20, max: 80, calibration: 40 },
  }
  applyRemap(monitor, remaps)
  assert.strictEqual(monitor.min, 20)
  assert.strictEqual(monitor.max, 80)
  assert.strictEqual(monitor.calibration, 40)
})

test('applyRemap with no remaps is a no-op', () => {
  const monitor = { id: 'MON_A', name: 'Dell', min: 5 }
  applyRemap(monitor)
  assert.strictEqual(monitor.min, 5)
})

test('applyRemaps applies across every monitor in the list', () => {
  const monitors = {
    a: { id: 'MON_A', name: 'Dell' },
    b: { id: 'MON_B', name: 'LG' },
  }
  applyRemaps(monitors, {
    Dell: { min: 10, max: 90, calibration: 50 },
    LG: { min: 0, max: 100, calibration: 25 },
  })
  assert.strictEqual(monitors.a.min, 10)
  assert.strictEqual(monitors.b.calibration, 25)
})

test('shouldSkipDisplay matches a monitor hwid[1] against built-in rules', () => {
  const monitor = { hwid: ['root', 'DEL41D9', 'x'] }
  assert.strictEqual(shouldSkipDisplay(monitor, ['DEL41D9'], []), true)
})

test('shouldSkipDisplay matches against user rules too', () => {
  const monitor = { hwid: ['root', 'MYMON', 'x'] }
  assert.strictEqual(shouldSkipDisplay(monitor, ['DEL41D9'], ['MYMON']), true)
})

test('shouldSkipDisplay accepts a raw hwid string', () => {
  assert.strictEqual(shouldSkipDisplay('DEL41D9', ['DEL41D9']), true)
})

test('shouldSkipDisplay returns false when hwid is not in any rule list', () => {
  const monitor = { hwid: ['root', 'OTHER', 'x'] }
  assert.strictEqual(shouldSkipDisplay(monitor, ['DEL41D9'], ['MYMON']), false)
})

test('shouldSkipDisplay returns false for a monitor with no hwid', () => {
  assert.strictEqual(shouldSkipDisplay({ id: 'x' }, ['DEL41D9'], []), false)
})
