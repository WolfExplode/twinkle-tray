const { test } = require('node:test')
const assert = require('node:assert')
const {
  getCurrentAdjustmentEvent,
  getCurrentAdjustmentEventLERP,
} = require('../src/adjustmentTimes')

// ---------------------------------------------------------------------------
// Model of applyCurrentAdjustmentEvent (electron.js:4117) with injectable deps.
//
// Mirrors the guard conditions and lastTimeEvent deduplication exactly so
// the state machine can be exercised without the Electron runtime. Mutates
// `scheduleState.lastTimeEvent` in-place — just like the real function does
// via store.update.
// ---------------------------------------------------------------------------
function applySchedule({
  schedule,
  scheduleState,
  idleState,
  settings,
  tempSettings = {},
  force = false,
  today = 1,
}) {
  // Guards (electron.js:4119-4120)
  if (tempSettings.pauseTimeAdjustments) return false
  if (!settings.adjustmentTimesActive) return false
  if (!settings.adjustmentTimes || settings.adjustmentTimes.length === 0) return false
  if (idleState.userIdleDimmed) return false

  let lastTimeEvent = scheduleState.lastTimeEvent

  const lerpActive = settings.adjustmentTimeAnimate !== false && settings.adjustmentTimeSpeed === "linear"

  // Reset on new day, force, or linear mode (electron.js:4129-4133)
  if (
    force ||
    lerpActive ||
    (lastTimeEvent && lastTimeEvent.day !== today)
  ) {
    lastTimeEvent = false
    scheduleState.lastTimeEvent = false
  }

  const foundEvent = schedule.getCurrentAdjustmentEvent()
  if (!foundEvent) return false

  // Only apply when the event changed (electron.js:4140)
  if (lastTimeEvent === false || lastTimeEvent.value !== foundEvent.value) {
    if (lerpActive) {
      const lerp = schedule.getCurrentAdjustmentEventLERP()
      if (lerp) {
        foundEvent.brightness = lerp.brightness
        if (lerp.monitors) foundEvent.monitors = lerp.monitors
        if (lerp.kelvin !== undefined) foundEvent.kelvin = lerp.kelvin
        if (lerp.highlightWeight !== undefined) foundEvent.highlightWeight = lerp.highlightWeight
        if (lerp.softwareDim !== undefined) foundEvent.softwareDim = lerp.softwareDim
        if (lerp.monitorsSoftwareDim) foundEvent.monitorsSoftwareDim = lerp.monitorsSoftwareDim
        if (lerp.monitorsKelvin) foundEvent.monitorsKelvin = lerp.monitorsKelvin
        if (lerp.monitorsHighlightWeight) foundEvent.monitorsHighlightWeight = lerp.monitorsHighlightWeight
      }
    }
    scheduleState.lastTimeEvent = Object.assign({}, foundEvent, { day: today })
    return foundEvent
  }

  return false
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const at = (h, m = 0) => h * 60 + m

// Schedule object backed by the real adjustmentTimes functions, but with a
// fixed `nowValue` so tests don't depend on the wall clock.
function makeSchedule(adjustmentTimes, nowValue) {
  return {
    getCurrentAdjustmentEvent: () => getCurrentAdjustmentEvent(adjustmentTimes, nowValue),
    getCurrentAdjustmentEventLERP: () => getCurrentAdjustmentEventLERP(adjustmentTimes, nowValue),
  }
}

// Minimal settings with sensible defaults.
function makeSettings(overrides = {}) {
  return {
    adjustmentTimesActive: true,
    adjustmentTimes: [
      { time: '07:00', brightness: 60, monitors: {} },
      { time: '12:00', brightness: 100, monitors: {} },
      { time: '22:00', brightness: 20, monitors: {} },
    ],
    adjustmentTimeAnimate: false,
    adjustmentTimeIndividualDisplays: false,
    ...overrides,
  }
}

function makeIdleState(overrides = {}) {
  return { userIdleDimmed: false, isUserIdle: false, lastIdleTime: 0, ...overrides }
}

function makeScheduleState(overrides = {}) {
  return { lastTimeEvent: false, ...overrides }
}

// ---------------------------------------------------------------------------
// Tests: normal schedule operation
// ---------------------------------------------------------------------------

test('applies the current event and records it in lastTimeEvent', () => {
  const scheduleState = makeScheduleState()
  const idleState = makeIdleState()
  const settings = makeSettings()

  const result = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(8)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })

  assert.ok(result, 'should return the found event')
  assert.strictEqual(result.brightness, 60, '07:00 event brightness')
  assert.strictEqual(scheduleState.lastTimeEvent.value, at(7), 'lastTimeEvent recorded')
  assert.strictEqual(scheduleState.lastTimeEvent.day, 1)
})

test('same event not applied twice — deduplication via lastTimeEvent.value', () => {
  const settings = makeSettings()
  const scheduleState = makeScheduleState()
  const idleState = makeIdleState()

  const schedule = makeSchedule(settings.adjustmentTimes, at(8))

  // First call applies event.
  const first = applySchedule({ schedule, scheduleState, idleState, settings, today: 1 })
  assert.ok(first)

  // Second call at same position in the schedule — no new event.
  const second = applySchedule({ schedule, scheduleState, idleState, settings, today: 1 })
  assert.strictEqual(second, false, 'same event must not re-fire')
})

test('new event at a different time applies after the previous one was recorded', () => {
  const settings = makeSettings()
  const scheduleState = makeScheduleState()
  const idleState = makeIdleState()

  // Simulate 08:00 — 07:00 event fires.
  applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(8)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })
  assert.strictEqual(scheduleState.lastTimeEvent.value, at(7))

  // Simulate 13:00 — 12:00 event should now fire.
  const result = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(13)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })
  assert.ok(result)
  assert.strictEqual(result.brightness, 100, '12:00 event brightness')
  assert.strictEqual(scheduleState.lastTimeEvent.value, at(12))
})

// ---------------------------------------------------------------------------
// Tests: idle blocks schedule
// ---------------------------------------------------------------------------

test('userIdleDimmed=true blocks schedule from applying', () => {
  const settings = makeSettings()
  const scheduleState = makeScheduleState()
  const idleState = makeIdleState({ userIdleDimmed: true })

  const result = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(13)),
    scheduleState,
    idleState,
    settings,
  })

  assert.strictEqual(result, false, 'must not apply while dimmed')
  assert.strictEqual(scheduleState.lastTimeEvent, false, 'lastTimeEvent must remain untouched')
})

test('schedule event that fires during idle is not recorded — stale lastTimeEvent remains', () => {
  const settings = makeSettings()
  const scheduleState = makeScheduleState()
  const idleState = makeIdleState()

  // 08:00 — 07:00 event applies.
  applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(8)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })
  const savedAfterEarlyEvent = scheduleState.lastTimeEvent.value
  assert.strictEqual(savedAfterEarlyEvent, at(7))

  // User goes idle.
  idleState.userIdleDimmed = true

  // 13:00 tick — 12:00 event would fire but idle blocks it.
  applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(13)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })

  assert.strictEqual(
    scheduleState.lastTimeEvent.value,
    at(7),
    'lastTimeEvent must still be the 07:00 event — 12:00 was blocked'
  )
})

// ---------------------------------------------------------------------------
// Tests: wake from idle — force=true re-applies
// ---------------------------------------------------------------------------

test('force=true resets lastTimeEvent so current event is re-applied', () => {
  const settings = makeSettings()
  const scheduleState = makeScheduleState()
  const idleState = makeIdleState()

  // Apply event normally.
  applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(8)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })
  assert.strictEqual(scheduleState.lastTimeEvent.value, at(7))

  // Force re-apply at the same time.
  const result = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(8)),
    scheduleState,
    idleState,
    settings,
    force: true,
    today: 1,
  })

  assert.ok(result, 'force must trigger re-apply')
  assert.strictEqual(result.brightness, 60)
})

test('wake sequence: event missed during idle is picked up via force=true on wake', () => {
  const settings = makeSettings()
  const scheduleState = makeScheduleState()
  const idleState = makeIdleState()

  // 08:00 — 07:00 event fires.
  applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(8)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })

  // User goes idle.
  idleState.userIdleDimmed = true

  // 13:00 tick — 12:00 event missed.
  applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(13)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })
  assert.strictEqual(scheduleState.lastTimeEvent.value, at(7), '12:00 event still blocked')

  // User wakes at 13:30. Idle state cleared (mirrors electron.js:4047 setTimeout).
  idleState.userIdleDimmed = false

  // applyCurrentAdjustmentEvent(force=true) called on wake (electron.js:4055).
  const wakeResult = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(13, 30)),
    scheduleState,
    idleState,
    settings,
    force: true,
    today: 1,
  })

  assert.ok(wakeResult, 'wake must apply the missed event')
  assert.strictEqual(wakeResult.brightness, 100, '12:00 event brightness applied after wake')
  assert.strictEqual(scheduleState.lastTimeEvent.value, at(12))
})

test('wake after overnight idle picks up the event that should be active', () => {
  // User went idle at 21:30 (22:00 event not yet fired), returns at 02:00.
  // Active event at 02:00 is the 22:00 event (midnight wrap).
  const settings = makeSettings()
  const scheduleState = makeScheduleState()
  const idleState = makeIdleState()

  // 21:30 — 12:00 event is still current.
  applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(21, 30)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })
  assert.strictEqual(scheduleState.lastTimeEvent.value, at(12))

  // User goes idle before 22:00.
  idleState.userIdleDimmed = true

  // User returns at 02:00 the next day. Day incremented → today=2.
  idleState.userIdleDimmed = false
  const wakeResult = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(2)),
    scheduleState,
    idleState,
    settings,
    force: true,
    today: 2,
  })

  assert.ok(wakeResult, 'should apply on wake')
  // The active event at 02:00 is the 22:00 one (overnight wrap).
  assert.strictEqual(wakeResult.value, at(22), '22:00 event is current at 02:00')
  assert.strictEqual(wakeResult.brightness, 20)
})

// ---------------------------------------------------------------------------
// Tests: linear / LERP mode
// ---------------------------------------------------------------------------

test('speed=linear always resets lastTimeEvent so LERP can advance', () => {
  const settings = makeSettings({ adjustmentTimeAnimate: true, adjustmentTimeSpeed: "linear" })
  const scheduleState = makeScheduleState()
  const idleState = makeIdleState()

  // First tick at 08:00.
  const r1 = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(8)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })
  assert.ok(r1, 'first apply')

  // Second tick at 08:01 — linear mode resets lastTimeEvent, re-applies.
  const r2 = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(8, 1)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })
  assert.ok(r2, 'linear mode must re-apply even for the same event')
})

test('LERP overrides foundEvent.brightness with interpolated value', () => {
  const settings = makeSettings({ adjustmentTimeAnimate: true, adjustmentTimeSpeed: "linear" })
  const scheduleState = makeScheduleState()
  const idleState = makeIdleState()

  // Halfway between 07:00 (60) and 12:00 (100): 09:30 → brightness=80.
  const result = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(9, 30)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })

  assert.ok(result)
  assert.strictEqual(result.brightness, 80, 'LERP at 50% → midpoint brightness')
})

test('LERP blocked during idle, resumes correct value on wake', () => {
  const settings = makeSettings({ adjustmentTimeAnimate: true, adjustmentTimeSpeed: "linear" })
  const scheduleState = makeScheduleState()
  const idleState = makeIdleState()

  // Apply at 09:00 (LERP).
  applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(9)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })

  // User goes idle.
  idleState.userIdleDimmed = true

  // Tick at 11:00 — LERP blocked.
  const blockedResult = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(11)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })
  assert.strictEqual(blockedResult, false)

  // Wake at 11:00 with force=true.
  idleState.userIdleDimmed = false
  const wakeResult = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(11)),
    scheduleState,
    idleState,
    settings,
    force: true,
    today: 1,
  })
  // 11:00 is 4/5 of the way through 07:00→12:00 (240/300 min → 80%).
  // lerp(60, 100, 0.8) = 92.
  assert.ok(wakeResult)
  assert.strictEqual(wakeResult.brightness, 92, 'LERP resumes at correct position after idle')
})

// ---------------------------------------------------------------------------
// Tests: guard conditions
// ---------------------------------------------------------------------------

test('pauseTimeAdjustments=true blocks schedule', () => {
  const settings = makeSettings()
  const result = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(9)),
    scheduleState: makeScheduleState(),
    idleState: makeIdleState(),
    settings,
    tempSettings: { pauseTimeAdjustments: true },
  })
  assert.strictEqual(result, false)
})

test('adjustmentTimesActive=false blocks schedule', () => {
  const settings = makeSettings({ adjustmentTimesActive: false })
  const result = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(9)),
    scheduleState: makeScheduleState(),
    idleState: makeIdleState(),
    settings,
  })
  assert.strictEqual(result, false)
})

test('empty adjustmentTimes array blocks schedule', () => {
  const settings = makeSettings({ adjustmentTimes: [] })
  const result = applySchedule({
    schedule: makeSchedule([], at(9)),
    scheduleState: makeScheduleState(),
    idleState: makeIdleState(),
    settings,
  })
  assert.strictEqual(result, false)
})

// ---------------------------------------------------------------------------
// Tests: new-day reset
// ---------------------------------------------------------------------------

test('lastTimeEvent from yesterday triggers a reset on the next day', () => {
  const settings = makeSettings()
  const scheduleState = makeScheduleState()
  const idleState = makeIdleState()

  // Day 1 — apply event.
  applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(8)),
    scheduleState,
    idleState,
    settings,
    today: 1,
  })
  assert.strictEqual(scheduleState.lastTimeEvent.day, 1)

  // Day 2 — same time, same event value, but new day resets lastTimeEvent → re-applies.
  const result = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(8)),
    scheduleState,
    idleState,
    settings,
    today: 2,
  })
  assert.ok(result, 'new day must trigger re-apply')
  assert.strictEqual(scheduleState.lastTimeEvent.day, 2)
})

// ---------------------------------------------------------------------------
// Tests: LERP edge cases that could affect idle-wake correctness
// ---------------------------------------------------------------------------

test('LERP at exactly the event boundary returns that event brightness', () => {
  // At exactly 07:00 the 07:00 event is current and next is 12:00.
  // percent = 0 → lerp(60, 100, 0) = 60.
  const settings = makeSettings({ adjustmentTimeAnimate: true, adjustmentTimeSpeed: "linear" })
  const result = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(7)),
    scheduleState: makeScheduleState(),
    idleState: makeIdleState(),
    settings,
    today: 1,
  })
  assert.strictEqual(result.brightness, 60)
})

test('LERP across midnight boundary after long idle produces correct value', () => {
  // User went idle at 21:00, wakes at 02:00 next day.
  // 22:00 (20) → 07:00 (60) span = 540 min. At 02:00 = 240 min in.
  // percent = 240/540 ≈ 0.444 → round(20 + 40*0.444) = 38.
  const settings = makeSettings({ adjustmentTimeAnimate: true, adjustmentTimeSpeed: "linear" })
  const result = applySchedule({
    schedule: makeSchedule(settings.adjustmentTimes, at(2)),
    scheduleState: makeScheduleState(),
    idleState: makeIdleState(),
    settings,
    force: true,
    today: 2,
  })
  assert.ok(result)
  assert.strictEqual(result.brightness, 38, 'LERP overnight on wake')
})

test('single-event schedule never returns a LERP value (avoids divide-by-zero)', () => {
  const singleEventTimes = [{ time: '12:00', brightness: 75, monitors: {} }]
  const settings = makeSettings({
    adjustmentTimes: singleEventTimes,
    adjustmentTimeAnimate: true,
    adjustmentTimeSpeed: "linear",
  })

  const result = applySchedule({
    schedule: makeSchedule(singleEventTimes, at(13)),
    scheduleState: makeScheduleState(),
    idleState: makeIdleState(),
    settings,
    today: 1,
  })

  // LERP returns false for single-event schedules; foundEvent.brightness must
  // stay at the event's static value (not overwritten with false).
  assert.ok(result)
  assert.strictEqual(result.brightness, 75, 'static brightness preserved when LERP is unavailable')
})
