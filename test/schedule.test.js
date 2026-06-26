const { test } = require('node:test')
const assert = require('node:assert')
const { createSchedule } = require('../src/schedule')

// A fake AdjustmentTimes that records the arguments each pure call receives, so
// we can assert createSchedule binds the live settings + SunCalc correctly.
function fakeAdjustmentTimes() {
  const calls = {}
  return {
    calls,
    toNowValue: () => 555,
    getSunCalcTime: (...args) => { calls.getSunCalcTime = args; return '07:30' },
    getCurrentAdjustmentEvent: (...args) => { calls.getCurrentAdjustmentEvent = args; return { value: 1 } },
    getCurrentAdjustmentEventLERP: (...args) => { calls.getCurrentAdjustmentEventLERP = args; return 42 },
    getScheduledColorForMonitor: (...args) => { calls.getScheduledColorForMonitor = args; return { kelvin: 4000 } },
  }
}

test('getSunCalcTime binds SunCalc and the configured lat/long', () => {
  const AdjustmentTimes = fakeAdjustmentTimes()
  const SunCalc = { tag: 'suncalc' }
  const settings = { adjustmentTimeLatitude: 51, adjustmentTimeLongitude: -1 }
  const schedule = createSchedule({ AdjustmentTimes, settings, SunCalc })

  assert.strictEqual(schedule.getSunCalcTime('sunset'), '07:30')
  assert.deepStrictEqual(AdjustmentTimes.calls.getSunCalcTime, [SunCalc, 51, -1, 'sunset'])
})

test('getCurrentAdjustmentEvent passes live settings + nowValue + the bound resolver', () => {
  const AdjustmentTimes = fakeAdjustmentTimes()
  const settings = { adjustmentTimes: [{ value: 1 }] }
  const schedule = createSchedule({ AdjustmentTimes, settings, SunCalc: {} })

  assert.deepStrictEqual(schedule.getCurrentAdjustmentEvent(), { value: 1 })
  const [times, nowValue, resolver] = AdjustmentTimes.calls.getCurrentAdjustmentEvent
  assert.strictEqual(times, settings.adjustmentTimes)
  assert.strictEqual(nowValue, 555)
  assert.strictEqual(typeof resolver, 'function')
})

test('reads settings live — mutating the injected object is visible to later calls', () => {
  const AdjustmentTimes = fakeAdjustmentTimes()
  const settings = { adjustmentTimes: [] }
  const schedule = createSchedule({ AdjustmentTimes, settings, SunCalc: {} })

  schedule.getCurrentAdjustmentEvent()
  const first = AdjustmentTimes.calls.getCurrentAdjustmentEvent[0]
  settings.adjustmentTimes = [{ value: 9 }]
  schedule.getCurrentAdjustmentEvent()
  const second = AdjustmentTimes.calls.getCurrentAdjustmentEvent[0]

  assert.notStrictEqual(first, second)
  assert.deepStrictEqual(second, [{ value: 9 }])
})

test('getCurrentAdjustmentEventLERP forwards the individual-displays flag', () => {
  const AdjustmentTimes = fakeAdjustmentTimes()
  const settings = { adjustmentTimes: [], adjustmentTimeIndividualDisplays: true }
  const schedule = createSchedule({ AdjustmentTimes, settings, SunCalc: {} })

  assert.strictEqual(schedule.getCurrentAdjustmentEventLERP(), 42)
  const [, , individual] = AdjustmentTimes.calls.getCurrentAdjustmentEventLERP
  assert.strictEqual(individual, true)
})

test('getScheduledColorForMonitor binds settings', () => {
  const AdjustmentTimes = fakeAdjustmentTimes()
  const settings = { some: 'config' }
  const schedule = createSchedule({ AdjustmentTimes, settings, SunCalc: {} })
  const monitor = { id: 'mon-1' }
  const event = { value: 1 }

  assert.deepStrictEqual(schedule.getScheduledColorForMonitor(monitor, event), { kelvin: 4000 })
  assert.deepStrictEqual(AdjustmentTimes.calls.getScheduledColorForMonitor, [monitor, event, settings])
})
