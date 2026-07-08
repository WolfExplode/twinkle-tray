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

test('desync: manual brightness change without notifyInteraction leaves monitor stuck in dimmed set — never re-dims', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const { deps, monitors, brightnessController } = makeDeps()
    const ctrl = createMonitorFocusController(deps)
    ctrl.start()
    mock.timers.tick(2000)
    assert.strictEqual(ctrl.isDimmed('M2'), true)

    // electron.js manual path (hotkey/cli/api): controller clears the inactive
    // offset and brightness returns to 100 — but if monitorFocus is not told,
    // its dimmed set still contains M2.
    monitors.m2.brightness = 100
    brightnessController.animCalls.length = 0

    // Monitor stays inactive well past the timeout — but checkMonitorFocus
    // skips anything already in the dimmed set, so it never re-dims.
    mock.timers.tick(10000)
    assert.strictEqual(ctrl.isDimmed('M2'), true, 'still marked dimmed (desynced)')
    assert.strictEqual(
      brightnessController.animCalls.filter(c => c.monitorId === 'M2').length,
      0,
      'no re-dim ever issued while desynced'
    )

    ctrl.stop()
  } finally {
    mock.timers.reset()
  }
})

test('notifyInteraction resyncs: clears dim state and monitor re-dims after a fresh timeout', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const { deps, monitors, brightnessController } = makeDeps()
    const ctrl = createMonitorFocusController(deps)
    ctrl.start()
    mock.timers.tick(2000)
    assert.strictEqual(ctrl.isDimmed('M2'), true)

    // Same manual change, but electron.js notifies the focus controller.
    monitors.m2.brightness = 100
    ctrl.notifyInteraction('M2', 'hotkey')
    assert.strictEqual(ctrl.isDimmed('M2'), false, 'dim state cleared on interaction')

    brightnessController.animCalls.length = 0
    mock.timers.tick(2000) // past the 1s timeout, next poll tick
    assert.strictEqual(ctrl.isDimmed('M2'), true, 're-dims after fresh timeout')
    assert.ok(
      brightnessController.animCalls.some(c => c.monitorId === 'M2' && c.property === 'inactiveOffset'),
      'new dim animation issued'
    )

    ctrl.stop()
  } finally {
    mock.timers.reset()
  }
})

test('fullscreen focus freezes tracking: mousemove ghost cursor does not restore a dimmed monitor', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const fullscreen = { active: false }
    const { deps, brightnessController } = makeDeps({ isFocusedWindowFullscreen: () => fullscreen.active })
    const ctrl = createMonitorFocusController(deps)
    ctrl.start()
    mock.timers.tick(2000)
    assert.strictEqual(ctrl.isDimmed('M2'), true)
    brightnessController.clearCalls.length = 0

    // User focuses a fullscreen game; raw mouse-look input then drifts the
    // ghost cursor onto M2's coordinates — must not read as a real visit.
    fullscreen.active = true
    mock.timers.tick(1100) // clear the 1s fullscreen-check cache
    ctrl.handleMouseMove(150, 10)

    assert.strictEqual(ctrl.isDimmed('M2'), true, 'stays dimmed despite ghost cursor crossing into it')
    assert.strictEqual(brightnessController.clearCalls.length, 0, 'no clearDimOffset issued while fullscreen-focused')

    ctrl.stop()
  } finally {
    mock.timers.reset()
  }
})

test('fullscreen focus freezes tracking: periodic poll does not dim or restore', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const { deps, brightnessController } = makeDeps({ isFocusedWindowFullscreen: () => true })
    const ctrl = createMonitorFocusController(deps)
    ctrl.start()

    mock.timers.tick(10000)

    assert.strictEqual(ctrl.isAnyDimmed(), false, 'nothing dims while fullscreen-focused, even well past timeout')
    assert.strictEqual(brightnessController.animCalls.length, 0)

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
