const { test } = require('node:test')
const assert = require('node:assert')

const {
  toNowValue,
  getCurrentAdjustmentEvent,
  getNextAdjustmentEvent,
  getCurrentAdjustmentEventLERP,
  getSunCalcTime,
  getScheduledColorForMonitor
} = require('../src/adjustmentTimes')

// Helper: build a simple linked-display event.
function ev(time, brightness) {
  return { time, brightness, monitors: {} }
}

// A typical day/night schedule: dim at night (22:00), bright in the morning (07:00),
// brighter midday (12:00). Sorted ascending by time, as electron.js stores them.
const schedule = [
  ev("07:00", 60),
  ev("12:00", 100),
  ev("22:00", 20)
]

const at = (h, m = 0) => (h * 60) + m

test('toNowValue converts a Date to minutes since midnight', () => {
  assert.strictEqual(toNowValue(new Date(2026, 5, 13, 0, 0)), 0)
  assert.strictEqual(toNowValue(new Date(2026, 5, 13, 7, 30)), 450)
  assert.strictEqual(toNowValue(new Date(2026, 5, 13, 23, 59)), 1439)
})

test('current event during the day is the most recent past event', () => {
  assert.strictEqual(getCurrentAdjustmentEvent(schedule, at(8)).value, at(7))
  assert.strictEqual(getCurrentAdjustmentEvent(schedule, at(13)).value, at(12))
  assert.strictEqual(getCurrentAdjustmentEvent(schedule, at(22, 30)).value, at(22))
})

test('exactly at an event time selects that event', () => {
  assert.strictEqual(getCurrentAdjustmentEvent(schedule, at(7)).value, at(7))
  assert.strictEqual(getCurrentAdjustmentEvent(schedule, at(12)).value, at(12))
})

// Regression: the midnight wrap-around bug. Before the fix, any time before the first
// event of the day (e.g. 02:00, earlier than 07:00) returned `false` -> no adjustment
// applied overnight. The active event should wrap to the last event of the prior day.
test('REGRESSION: before the first event, current wraps to last night event', () => {
  assert.strictEqual(getCurrentAdjustmentEvent(schedule, at(2)).value, at(22))
  assert.strictEqual(getCurrentAdjustmentEvent(schedule, at(0)).value, at(22))
  assert.strictEqual(getCurrentAdjustmentEvent(schedule, at(6, 59)).value, at(22))
})

test('current event with empty schedule returns false', () => {
  assert.strictEqual(getCurrentAdjustmentEvent([], at(12)), false)
})

test('next event is the closest upcoming one', () => {
  assert.strictEqual(getNextAdjustmentEvent(schedule, at(8)).value, at(12))
  assert.strictEqual(getNextAdjustmentEvent(schedule, at(13)).value, at(22))
})

test('next event wraps past midnight to the earliest event', () => {
  // After the last event of the day (22:00), the next is tomorrow's earliest (07:00).
  assert.strictEqual(getNextAdjustmentEvent(schedule, at(23)).value, at(7))
  // Overnight (02:00), current wraps to 22:00, so next is the morning event.
  assert.strictEqual(getNextAdjustmentEvent(schedule, at(2)).value, at(7))
})

test('LERP interpolates linearly between two daytime events', () => {
  // Halfway between 07:00 (60) and 12:00 (100) -> 80.
  assert.strictEqual(getCurrentAdjustmentEventLERP(schedule, at(9, 30), false), 80)
  // Quarter way -> 70.
  assert.strictEqual(getCurrentAdjustmentEventLERP(schedule, at(8, 15), false), 70)
})

// Regression: LERP previously returned false overnight because the current event was
// false. Now it interpolates across the midnight boundary from 22:00 -> 07:00.
test('REGRESSION: LERP interpolates across the midnight boundary', () => {
  // 22:00 (20) -> 07:00 next day (60) spans 540 minutes. At 02:00 that's 240 min in.
  // percent = 240/540 ~= 0.444 -> round(20 + 40*0.444) = round(37.78) = 38.
  assert.strictEqual(getCurrentAdjustmentEventLERP(schedule, at(2), false), 38)
  // Right at the start of the overnight span -> the night value.
  assert.strictEqual(getCurrentAdjustmentEventLERP(schedule, at(22), false), 20)
})

test('LERP returns per-monitor object when individual displays enabled', () => {
  const indiv = [
    { time: "07:00", monitors: { A: 40, B: 0 } },
    { time: "19:00", monitors: { A: 80, B: 100 } }
  ]
  // Halfway between 07:00 and 19:00 (at 13:00): A -> 60, B -> 50.
  const result = getCurrentAdjustmentEventLERP(indiv, at(13), true)
  assert.deepStrictEqual(result, { A: 60, B: 50 })
})

test('LERP returns false with fewer than two events', () => {
  assert.strictEqual(getCurrentAdjustmentEventLERP([ev("07:00", 60)], at(8), false), false)
  assert.strictEqual(getCurrentAdjustmentEventLERP([], at(8), false), false)
})

test('events listed out-of-order still find the correct current event', () => {
  const outOfOrder = [ev("22:00", 20), ev("07:00", 60), ev("12:00", 100)]
  assert.strictEqual(getCurrentAdjustmentEvent(outOfOrder, at(8)).value, at(7))
  assert.strictEqual(getCurrentAdjustmentEvent(outOfOrder, at(13)).value, at(12))
  // Midnight wrap still works
  assert.strictEqual(getCurrentAdjustmentEvent(outOfOrder, at(2)).value, at(22))
})

test('single-event schedule: next wraps back to the only event', () => {
  const single = [ev("12:00", 80)]
  assert.strictEqual(getNextAdjustmentEvent(single, at(13)).value, at(12))
  assert.strictEqual(getNextAdjustmentEvent(single, at(12)).value, at(12))
})

test('midnight event (00:00) is treated as the start of the day', () => {
  const withMidnight = [ev("00:00", 10), ev("08:00", 80)]
  // At midnight exactly: the 00:00 event is current.
  assert.strictEqual(getCurrentAdjustmentEvent(withMidnight, at(0)).value, at(0))
  // Just after midnight: still 00:00 event.
  assert.strictEqual(getCurrentAdjustmentEvent(withMidnight, at(1)).value, at(0))
  // At 23:00: last event before now is 08:00.
  assert.strictEqual(getCurrentAdjustmentEvent(withMidnight, at(23)).value, at(8))
})

test('LERP skips per-monitor values that are inactive (-1)', () => {
  const indiv = [
    { time: "08:00", monitors: { A: 40, B: -1 } },
    { time: "20:00", monitors: { A: 80, B: 60 } }
  ]
  // At 14:00 (halfway): A lerps 40→80 = 60; B stays -1 because current.B is not > -1.
  const result = getCurrentAdjustmentEventLERP(indiv, at(14), true)
  assert.strictEqual(result.A, 60)
  assert.strictEqual(result.B, -1)
})

test('LERP at exactly the current event boundary returns that event value', () => {
  // At exactly 07:00: percent = 0, result = current.brightness = 60.
  assert.strictEqual(getCurrentAdjustmentEventLERP(schedule, at(7), false), 60)
  // At exactly 12:00: percent = 0, result = current.brightness = 100.
  assert.strictEqual(getCurrentAdjustmentEventLERP(schedule, at(12), false), 100)
})

test('sun-relative events resolve via the injected getSunCalcTime', () => {
  const sched = [
    { useSunCalc: true, sunCalc: "sunrise", brightness: 50, monitors: {} },
    { useSunCalc: true, sunCalc: "sunset", brightness: 10, monitors: {} }
  ]
  const resolver = (name) => (name === "sunrise" ? "06:00" : "20:00")
  assert.strictEqual(getCurrentAdjustmentEvent(sched, at(12), resolver).value, at(6))
  assert.strictEqual(getCurrentAdjustmentEvent(sched, at(21), resolver).value, at(20))
  // Overnight wrap still works for sun-relative schedules.
  assert.strictEqual(getCurrentAdjustmentEvent(sched, at(3), resolver).value, at(20))
})

test('getSunCalcTime formats injected SunCalc result as zero-padded H:MM', () => {
  const fakeSunCalc = {
    getTimes(date, lat, lon) {
      assert.strictEqual(lat, 51.5)
      assert.strictEqual(lon, -0.12)
      return { solarNoon: new Date(2020, 0, 1, 12, 5) }
    }
  }
  assert.strictEqual(getSunCalcTime(fakeSunCalc, 51.5, -0.12, "solarNoon"), "12:05")
})

test('getSunCalcTime passes the event sunCalc name through', () => {
  const fakeSunCalc = {
    getTimes: () => ({ sunset: new Date(2020, 0, 1, 9, 0), solarNoon: new Date(2020, 0, 1, 12, 0) })
  }
  assert.strictEqual(getSunCalcTime(fakeSunCalc, 0, 0, "sunset"), "9:00")
})

test('getScheduledColorForMonitor returns {} with no event', () => {
  assert.deepStrictEqual(getScheduledColorForMonitor({ id: 'A' }, false, {}), {})
})

test('getScheduledColorForMonitor returns {} when features disabled', () => {
  const event = { kelvin: 4000, highlightWeight: 10 }
  assert.deepStrictEqual(getScheduledColorForMonitor({ id: 'A' }, event, {}), {})
})

test('getScheduledColorForMonitor uses event defaults when enabled', () => {
  const event = {}
  const settings = { adjustmentTimeTemperatureEnabled: true, adjustmentTimeHighlightCompressionEnabled: true }
  assert.deepStrictEqual(getScheduledColorForMonitor({ id: 'A' }, event, settings), { kelvin: 6500, highlightWeight: 0 })
})

test('getScheduledColorForMonitor honours per-display overrides', () => {
  const event = {
    kelvin: 5000,
    highlightWeight: 5,
    monitorsKelvin: { A: 3500 },
    monitorsHighlightWeight: { A: 40 }
  }
  const settings = {
    adjustmentTimeTemperatureEnabled: true,
    adjustmentTimeHighlightCompressionEnabled: true,
    adjustmentTimeIndividualDisplays: true
  }
  assert.deepStrictEqual(getScheduledColorForMonitor({ id: 'A' }, event, settings), { kelvin: 3500, highlightWeight: 40 })
  // A monitor without an override falls back to the event-wide value.
  assert.deepStrictEqual(getScheduledColorForMonitor({ id: 'B' }, event, settings), { kelvin: 5000, highlightWeight: 5 })
})
