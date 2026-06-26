const { test, mock } = require('node:test')
const assert = require('node:assert')
const { createMonitorFocusController } = require('../src/monitorFocusController')

// Integration-ish coverage for the stateful controller (the pure spatial/threshold
// math is covered separately in monitorFocus.test.js). Uses node's mock timers so
// the 2s focus poll and the 16ms transition ramp run deterministically.

// Two side-by-side displays; cursor sits on the left one (D1 → M1).
function makeDeps(overrides = {}) {
  const displays = [
    { id: 'D1', bounds: { x: 0, y: 0, width: 100, height: 100 } },
    { id: 'D2', bounds: { x: 100, y: 0, width: 100, height: 100 } }
  ]
  const monitors = {
    m1: { id: 'M1', key: 'm1', brightness: 100, bounds: { position: { x: 0, y: 0 } } },
    m2: { id: 'M2', key: 'm2', brightness: 100, bounds: { position: { x: 100, y: 0 } } }
  }
  const brightnessCalls = []
  const softwareDimCalls = []
  const idle = { userIdleDimmed: false, isWindowsUserIdle: false }

  const deps = {
    store: { get: (slice) => (slice === 'idle' ? idle : {}) },
    settings: {
      monitorFocusEnabled: true,
      monitorFocusSeconds: 1,            // timeout = 1000ms
      monitorFocusMinutes: 0,
      monitorFocusDimLevel: 20,
      monitorFocusSoftwareDim: 0,
      monitorFocusTransitionDuration: 100,
      adjustmentTimesActive: false
    },
    monitors,
    tempSettings: { pauseTimeAdjustments: false, pauseIdleDetection: false },
    softwareDimLevels: {},
    scheduledBrightness: {},
    screen: {
      getAllDisplays: () => displays,
      getCursorScreenPoint: () => ({ x: 10, y: 10 }) // on M1
    },
    logger: { debug: () => {} },
    updateBrightness: (id, value) => brightnessCalls.push({ id, value }),
    updateSoftwareDim: (id, value) => softwareDimCalls.push({ id, value }),
    touchMonitors: () => {},
    shouldSkipDisplay: () => false,
    enableMouseEvents: () => {},
    pauseMouseEvents: () => {},
    ...overrides
  }
  return { deps, monitors, brightnessCalls, softwareDimCalls, idle }
}

test('inactive monitor dims after the timeout, the active one does not', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const { deps, brightnessCalls } = makeDeps()
    const ctrl = createMonitorFocusController(deps)
    ctrl.start()

    assert.strictEqual(ctrl.isAnyDimmed(), false, 'nothing dimmed at start')

    // Fire the 2s poll once, past the 1s timeout: M2 (inactive) dims, then let the
    // ramp run to completion.
    mock.timers.tick(2000)
    assert.strictEqual(ctrl.isDimmed('M2'), true, 'inactive monitor is marked dimmed')
    assert.strictEqual(ctrl.isDimmed('M1'), false, 'cursor monitor stays lit')
    assert.strictEqual(ctrl.isAnyDimmed(), true)

    mock.timers.tick(200) // finish the 100ms transition
    const m2 = brightnessCalls.filter(c => c.id === 'M2')
    assert.ok(m2.length > 0, 'brightness written for the dimmed monitor')
    assert.strictEqual(m2.at(-1).value, 20, 'lands on the dim level')
    assert.strictEqual(brightnessCalls.some(c => c.id === 'M1'), false, 'active monitor untouched')

    ctrl.stop()
  } finally {
    mock.timers.reset()
  }
})

test('cursor returning to a dimmed monitor restores its pre-dim brightness', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const { deps, brightnessCalls } = makeDeps()
    const ctrl = createMonitorFocusController(deps)
    ctrl.start()
    mock.timers.tick(2000) // dim M2
    mock.timers.tick(200)  // finish ramp
    assert.strictEqual(ctrl.isDimmed('M2'), true)
    brightnessCalls.length = 0

    // Move the cursor onto M2's display (x in [100,200)).
    ctrl.handleMouseMove(150, 10)

    assert.strictEqual(ctrl.isDimmed('M2'), false, 'no longer dimmed after revisit')
    assert.strictEqual(ctrl.isAnyDimmed(), false)
    const restore = brightnessCalls.filter(c => c.id === 'M2')
    assert.ok(restore.length > 0, 'restore wrote brightness')
    assert.strictEqual(restore.at(-1).value, 100, 'restored to the pre-dim brightness')

    ctrl.stop()
  } finally {
    mock.timers.reset()
  }
})

test('reset clears all dim state and restores saved brightness', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const { deps, brightnessCalls } = makeDeps()
    const ctrl = createMonitorFocusController(deps)
    ctrl.start()
    mock.timers.tick(2000)
    mock.timers.tick(200)
    assert.strictEqual(ctrl.isAnyDimmed(), true)
    brightnessCalls.length = 0

    ctrl.reset()

    assert.strictEqual(ctrl.isAnyDimmed(), false, 'reset clears dimmed set')
    assert.strictEqual(brightnessCalls.some(c => c.id === 'M2' && c.value === 100), true, 'reset restores saved brightness')

    ctrl.stop()
  } finally {
    mock.timers.reset()
  }
})
