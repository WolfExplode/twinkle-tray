const { test } = require('node:test')
const assert = require('node:assert')

const Utils = require('../src/Utils')

test('parseTime converts HH:MM to minutes since midnight', () => {
  assert.strictEqual(Utils.parseTime("00:00"), 0)
  assert.strictEqual(Utils.parseTime("07:30"), 450)
  assert.strictEqual(Utils.parseTime("23:59"), 1439)
  assert.strictEqual(Utils.parseTime("12:00"), 720)
})

test('lerp interpolates between two values', () => {
  assert.strictEqual(Utils.lerp(0, 100, 0), 0)
  assert.strictEqual(Utils.lerp(0, 100, 1), 100)
  assert.strictEqual(Utils.lerp(0, 100, 0.5), 50)
  assert.strictEqual(Utils.lerp(20, 60, 0.25), 30)
})

test('getVersionValue produces comparable numeric versions', () => {
  assert.strictEqual(Utils.getVersionValue("v1.0.0"), 100000000)
  assert.ok(Utils.getVersionValue("v1.17.2") > Utils.getVersionValue("v1.16.9"))
  assert.ok(Utils.getVersionValue("v2.0.0") > Utils.getVersionValue("v1.99.99"))
  // Pre-release suffix is stripped.
  assert.strictEqual(Utils.getVersionValue("v1.2.3-beta"), Utils.getVersionValue("v1.2.3"))
})

test('upgradeAdjustmentTimes leaves already-upgraded entries untouched', () => {
  const times = [{ time: "08:00", brightness: 50, monitors: {} }]
  assert.deepStrictEqual(Utils.upgradeAdjustmentTimes(times), times)
})

test('upgradeAdjustmentTimes converts legacy 12H entries to 24H time strings', () => {
  const legacy = [
    { hour: 8, minute: 30, am: "AM", brightness: 40 },
    { hour: 9, minute: 5, am: "PM", brightness: 70 },
    { hour: 12, minute: 0, am: "AM", brightness: 10 }, // midnight
    { hour: 12, minute: 0, am: "PM", brightness: 90 }  // noon
  ]
  const upgraded = Utils.upgradeAdjustmentTimes(legacy)
  assert.strictEqual(upgraded[0].time, "08:30")
  assert.strictEqual(upgraded[1].time, "21:05")
  assert.strictEqual(upgraded[2].time, "00:00")
  assert.strictEqual(upgraded[3].time, "12:00")
})

test('getCalibratedValue maps values across calibration points', () => {
  const points = [{ input: 0, output: 0 }, { input: 100, output: 100 }]
  assert.strictEqual(Utils.getCalibratedValue(50, points), 50)
})

test('getCalibratedValue with non-identity calibration shifts output', () => {
  // Hardware minimum is 20, maximum is 80: OS 0-100 maps to 20-80
  const points = [{ input: 0, output: 20 }, { input: 100, output: 80 }]
  assert.strictEqual(Utils.getCalibratedValue(0, points), 20)
  assert.strictEqual(Utils.getCalibratedValue(50, points), 50)
  assert.strictEqual(Utils.getCalibratedValue(100, points), 80)
})

test('getCalibratedValue with piecewise calibration points', () => {
  // 0→0, 50→80, 100→100: boosted low-end
  const points = [{ input: 0, output: 0 }, { input: 50, output: 80 }, { input: 100, output: 100 }]
  assert.strictEqual(Utils.getCalibratedValue(25, points), 40)  // halfway 0→80
  assert.strictEqual(Utils.getCalibratedValue(75, points), 90)  // halfway 80→100
})

test('getCalibratedValue clamps out-of-range inputs to 0-100', () => {
  const points = [{ input: 0, output: 0 }, { input: 100, output: 100 }]
  assert.strictEqual(Utils.getCalibratedValue(-10, points), 0)
  assert.strictEqual(Utils.getCalibratedValue(150, points), 100)
})

test('getCalibratedValue reverse maps output back to input', () => {
  const points = [{ input: 0, output: 20 }, { input: 100, output: 80 }]
  assert.strictEqual(Utils.getCalibratedValue(20, points, true), 0)
  assert.strictEqual(Utils.getCalibratedValue(80, points, true), 100)
  assert.strictEqual(Utils.getCalibratedValue(50, points, true), 50)
})

test('upgradeAdjustmentTimes sets monitors to empty object when field is missing', () => {
  // Legacy entries without a monitors field should get monitors: {}, not monitors: 50.
  // The number fallback would crash LERP (Object.keys on a number).
  const legacy = [{ hour: 8, minute: 0, am: "AM", brightness: 50 }]
  const upgraded = Utils.upgradeAdjustmentTimes(legacy)
  assert.deepStrictEqual(upgraded[0].monitors, {})
})
