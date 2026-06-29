const { test, mock } = require('node:test')
const assert = require('node:assert')
const { createMonitorFocusController } = require('../src/monitorFocusController')

// Integration coverage for the stateful focus controller.
// Spatial/threshold math is in monitorFocus.test.js.
// Uses mock timers so the 2s poll and transition durations run deterministically.

function makeBrightnessController(initialBrightness = 100) {
  const animCalls = []
  const clearCalls = []
  return {
    animCalls,
    clearCalls,
    getCanonical: (monitorId) => ({ brightness: initialBrightness, softwareDim: 0 }),
    animateTo: (monitorId, property, value, durationMs) => animCalls.push({ monitorId, property, value, durationMs }),
    clearDimOffset: (monitorId, type) => clearCalls.push({ monitorId, type }),
    setDimOffset: () => {},
  }
}

function makeDeps(overrides = {}) {
  const displays = [
    { id: 'D1', bounds: { x: 0,   y: 0, width: 100, height: 100 } },
    { id: 'D2', bounds: { x: 100, y: 0, width: 100, height: 100 } },
  ]
  const monitors = {
    m1: { id: 'M1', key: 'm1', brightness: 100, bounds: { position: { x: 0,   y: 0 } } },
    m2: { id: 'M2', key: 'm2', brightness: 100, bounds: { position: { x: 100, y: 0 } } },
  }
  const idle = { userIdleDimmed: false, isWindowsUserIdle: false }
  const softwareDimCalls = []
  const brightnessController = makeBrightnessController()

  const deps = {
    store: { get: (slice) => (slice === 'idle' ? idle : {}) },
    settings: {
      monitorFocusEnabled: true,
      monitorFocusSeconds: 1,
      monitorFocusMinutes: 0,
      monitorFocusDimLevel: 20,
      monitorFocusSoftwareDim: 0,
      monitorFocusTransitionDuration: 100,
    },
    monitors,
    tempSettings: { pauseIdleDetection: false },
    softwareDimLevels: {},
    brightnessController,
    screen: {
      getAllDisplays: () => displays,
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    },
    logger: { debug: () => {}, shortId: (id) => id },
    updateSoftwareDim: (id, value) => softwareDimCalls.push({ id, value }),
    touchMonitors: () => {},
    shouldSkipDisplay: () => false,
    enableMouseEvents: () => {},
    pauseMouseEvents: () => {},
    ...overrides,
  }
  return { deps, monitors, idle, softwareDimCalls, brightnessController }
}

test('inactive monitor dims after timeout, active one does not', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const { deps, brightnessController } = makeDeps()
    const ctrl = createMonitorFocusController(deps)
    ctrl.start()

    assert.strictEqual(ctrl.isAnyDimmed(), false)

    mock.timers.tick(2000)

    assert.strictEqual(ctrl.isDimmed('M2'), true, 'inactive monitor marked dimmed')
    assert.strictEqual(ctrl.isDimmed('M1'), false, 'cursor monitor stays lit')

    const m2Anim = brightnessController.animCalls.filter(c => c.monitorId === 'M2' && c.property === 'inactiveOffset')
    assert.ok(m2Anim.length > 0, 'animateTo inactiveOffset called for M2')
    assert.strictEqual(m2Anim.at(-1).value, 80, 'offset = 100 - 20 = 80')
    assert.ok(brightnessController.animCalls.every(c => c.monitorId !== 'M1'), 'M1 not touched')

    ctrl.stop()
  } finally {
    mock.timers.reset()
  }
})

test('cursor returning to dimmed monitor clears inactive offset', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const { deps, brightnessController } = makeDeps()
    const ctrl = createMonitorFocusController(deps)
    ctrl.start()
    mock.timers.tick(2000)
    assert.strictEqual(ctrl.isDimmed('M2'), true)
    brightnessController.clearCalls.length = 0

    ctrl.handleMouseMove(150, 10)

    assert.strictEqual(ctrl.isDimmed('M2'), false, 'no longer dimmed after revisit')
    assert.ok(
      brightnessController.clearCalls.some(c => c.monitorId === 'M2' && c.type === 'inactive'),
      'clearDimOffset(inactive) called for M2'
    )

    ctrl.stop()
  } finally {
    mock.timers.reset()
  }
})

test('mousemove restores inactive-dimmed monitor even while idle flags are set', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const { deps, brightnessController, idle } = makeDeps()
    const ctrl = createMonitorFocusController(deps)
    ctrl.start()
    mock.timers.tick(2000)
    assert.strictEqual(ctrl.isDimmed('M2'), true)
    brightnessController.clearCalls.length = 0

    // Simulate: idle dim applied, then user wakes (both flags briefly still set)
    idle.userIdleDimmed = true
    idle.isWindowsUserIdle = true

    ctrl.handleMouseMove(150, 10)

    assert.strictEqual(ctrl.isDimmed('M2'), false, 'inactive dim cleared despite idle flags')
    assert.ok(
      brightnessController.clearCalls.some(c => c.monitorId === 'M2' && c.type === 'inactive'),
      'clearDimOffset(inactive) called for M2'
    )

    ctrl.stop()
  } finally {
    mock.timers.reset()
  }
})

test('reset clears all dim state via controller', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const { deps, brightnessController } = makeDeps()
    const ctrl = createMonitorFocusController(deps)
    ctrl.start()
    mock.timers.tick(2000)
    assert.strictEqual(ctrl.isAnyDimmed(), true)
    brightnessController.clearCalls.length = 0

    ctrl.reset()

    assert.strictEqual(ctrl.isAnyDimmed(), false, 'reset clears dimmed set')
    assert.ok(
      brightnessController.clearCalls.some(c => c.monitorId === 'M2' && c.type === 'inactive'),
      'clearDimOffset(inactive) called on reset'
    )

    ctrl.stop()
  } finally {
    mock.timers.reset()
  }
})
