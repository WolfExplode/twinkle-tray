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
