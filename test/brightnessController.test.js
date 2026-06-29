const { test, mock } = require('node:test')
const assert = require('node:assert')
const { createBrightnessController } = require('../src/BrightnessController')

// Race-condition coverage for the synchronous brightness gatekeeper.
// Uses mock timers so DDC queue timeouts and animation ticks run
// deterministically without real setInterval waits.

const TICK_MS = 16

const Utils = {
  minMax: (v, min = 0, max = 100) => Math.max(min, Math.min(max, v)),
  normalizeBrightness: (b) => b,
}

function makeDeps(overrides = {}) {
  const monitors = {
    m1: { id: 'M1', key: 'm1', type: 'ddcci', brightness: 100 },
  }
  const ddcCalls = []
  const softwareDimCalls = []
  const colorCalls = []
  const touchCalls = []

  const deps = {
    monitors,
    monitorsThread: { send: (msg) => ddcCalls.push(msg) },
    store: {
      get: (slice) => (slice === 'idle' ? { isWindowsUserIdle: false } : {}),
      update: () => {},
    },
    settings: { updateInterval: 50 },
    touchMonitors: () => touchCalls.push(1),
    updateKnownDisplays: () => {},
    setTrayStatus: () => {},
    shouldSkipDisplay: () => false,
    updateSoftwareDim: (id, val) => softwareDimCalls.push({ id, val }),
    updateDisplayColor: (id, opts) => colorCalls.push({ id, ...opts }),
    Utils,
    logger: { debug: () => {}, shortId: (id) => id },
    ...overrides,
  }
  return { deps, monitors, ddcCalls, softwareDimCalls, colorCalls, touchCalls }
}

test('manual write while idle-dimmed clears idle offset, commanded = new canonical', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const { deps, monitors, ddcCalls } = makeDeps()
    const ctrl = createBrightnessController(deps)
    ctrl.initFromMonitor('M1', { brightness: 80, softwareDim: 0 })

    // Simulate idle dim: offset = 60 → commanded = 80 - 60 = 20
    ctrl.setDimOffset('M1', 'idle', 60)
    assert.strictEqual(ctrl.getCommandedBrightness('M1'), 20, 'commanded at dim level')
    ddcCalls.length = 0

    // User drags slider to 70
    ctrl.setCanonical('M1', { brightness: 70 }, 'manual')

    assert.strictEqual(ctrl.getCanonical('M1').brightness, 70, 'canonical updated')
    assert.strictEqual(ctrl.getCommandedBrightness('M1'), 70, 'offset cleared, commanded = canonical')

    // Flush DDC queue (setDimOffset had DDC in-flight; setCanonical queued 70 as pending)
    mock.timers.tick(50)
    assert.ok(ddcCalls.some(c => c.brightness === 70), 'DDC dispatched at new level')
  } finally {
    mock.timers.reset()
  }
})

test('manual write while inactive-dimmed clears inactive offset', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const { deps, ddcCalls } = makeDeps()
    const ctrl = createBrightnessController(deps)
    ctrl.initFromMonitor('M1', { brightness: 90, softwareDim: 0 })

    ctrl.setDimOffset('M1', 'inactive', 70)
    assert.strictEqual(ctrl.getCommandedBrightness('M1'), 20)
    ddcCalls.length = 0

    ctrl.setCanonical('M1', { brightness: 60 }, 'manual')

    assert.strictEqual(ctrl.getCommandedBrightness('M1'), 60, 'inactive offset cleared')

    // Flush DDC queue
    mock.timers.tick(50)
    assert.ok(ddcCalls.some(c => c.brightness === 60), 'DDC at new canonical')
  } finally {
    mock.timers.reset()
  }
})

test('animation mid-flight: new animateTo overwrites track, only latest value reaches hardware', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const { deps, ddcCalls } = makeDeps()
    const ctrl = createBrightnessController(deps)
    ctrl.initFromMonitor('M1', { brightness: 50, softwareDim: 0 })
    ddcCalls.length = 0

    // Start animation from 50 → 100 over 1000ms
    ctrl.animateTo('M1', 'canonical.brightness', 100, 1000)

    // After 200ms, cancel with a new target
    mock.timers.tick(200)
    ctrl.animateTo('M1', 'canonical.brightness', 30, 500)

    // Let the second animation complete
    mock.timers.tick(500 + TICK_MS)

    // Final commanded brightness should be 30, not 100
    assert.strictEqual(ctrl.getCanonical('M1').brightness, 30, 'second animation won')
    const lastDDC = ddcCalls.at(-1)
    assert.ok(lastDDC, 'DDC dispatched')
    assert.strictEqual(lastDDC.brightness, 30, 'last DDC value matches second target')
  } finally {
    mock.timers.reset()
  }
})

test('setCanonical with brightness + softwareDim is atomic — no partial intermediate state', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const { deps, softwareDimCalls, ddcCalls } = makeDeps()
    const ctrl = createBrightnessController(deps)
    ctrl.initFromMonitor('M1', { brightness: 50, softwareDim: 0 })
    softwareDimCalls.length = 0
    ddcCalls.length = 0

    ctrl.setCanonical('M1', { brightness: 75, softwareDim: 30 }, 'schedule')

    const c = ctrl.getCanonical('M1')
    assert.strictEqual(c.brightness, 75, 'canonical.brightness updated')
    assert.strictEqual(c.softwareDim, 30, 'canonical.softwareDim updated')
    assert.ok(ddcCalls.some(m => m.brightness === 75), 'DDC dispatched at 75')
    assert.ok(softwareDimCalls.some(c => c.id === 'M1' && c.val === 30), 'softwareDim pushed')
  } finally {
    mock.timers.reset()
  }
})

test('DDC depth-1 queue: stale in-flight does not overwrite canonical after second setCanonical', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const { deps, ddcCalls } = makeDeps()
    const ctrl = createBrightnessController(deps)
    ctrl.initFromMonitor('M1', { brightness: 50, softwareDim: 0 })
    ddcCalls.length = 0

    // First command — DDC in-flight, queue timer armed
    ctrl.setCanonical('M1', { brightness: 70 }, 'schedule')
    assert.ok(ddcCalls.some(c => c.brightness === 70), 'first DDC sent')

    // Second command while first still in-flight — should queue, not send twice
    ctrl.setCanonical('M1', { brightness: 90 }, 'manual')
    assert.strictEqual(ctrl.getCanonical('M1').brightness, 90, 'canonical is 90')

    // Flush the DDC timer — pending value (90) dispatched
    mock.timers.tick(50)
    assert.ok(ddcCalls.some(c => c.brightness === 90), 'pending 90 dispatched after flush')

    // Canonical never regressed to 70
    assert.strictEqual(ctrl.getCanonical('M1').brightness, 90, 'canonical still 90')
  } finally {
    mock.timers.reset()
  }
})

test('setCanonical from refreshMonitors does not clobber in-flight animation', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const { deps } = makeDeps()
    const ctrl = createBrightnessController(deps)
    ctrl.initFromMonitor('M1', { brightness: 50, softwareDim: 0 })

    // Start animation 50 → 80 over 500ms
    ctrl.animateTo('M1', 'canonical.brightness', 80, 500)
    mock.timers.tick(250) // halfway — canonical ~65

    // refreshMonitors path uses 'wmi' or 'refresh' source (not 'manual'),
    // so animation tracks are NOT cancelled
    ctrl.setCanonical('M1', { brightness: 80 }, 'wmi')

    // Animation track for brightness was cancelled by setCanonical (prop in newSettings)
    // but canonical is at 80 now (the target), so commanded = 80
    assert.strictEqual(ctrl.getCanonical('M1').brightness, 80, 'canonical is 80 after wmi write')
    assert.strictEqual(ctrl.getCommandedBrightness('M1'), 80, 'commanded reflects wmi value')
  } finally {
    mock.timers.reset()
  }
})

test('simultaneous idle + inactive offsets: max() applied, not additive', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const { deps } = makeDeps()
    const ctrl = createBrightnessController(deps)
    ctrl.initFromMonitor('M1', { brightness: 100, softwareDim: 0 })

    ctrl.setDimOffset('M1', 'idle', 40)
    ctrl.setDimOffset('M1', 'inactive', 60)

    // max(40, 60) = 60; commanded = 100 - 60 = 40 (not 100 - 40 - 60 = 0)
    assert.strictEqual(ctrl.getCommandedBrightness('M1'), 40, 'max() applied, not additive')
  } finally {
    mock.timers.reset()
  }
})

test('clearing dim offsets restores commanded to canonical', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const { deps } = makeDeps()
    const ctrl = createBrightnessController(deps)
    ctrl.initFromMonitor('M1', { brightness: 80, softwareDim: 0 })

    ctrl.setDimOffset('M1', 'idle', 50)
    assert.strictEqual(ctrl.getCommandedBrightness('M1'), 30, 'dimmed to 30')

    // Schedule fires while idle: canonical updated, offset keeps commanded low
    ctrl.setCanonical('M1', { brightness: 60 }, 'schedule')
    assert.strictEqual(ctrl.getCanonical('M1').brightness, 60, 'canonical is schedule value')
    assert.strictEqual(ctrl.getCommandedBrightness('M1'), 10, 'still dimmed: 60 - 50 = 10')

    // Idle restore
    ctrl.clearDimOffset('M1', 'idle')
    assert.strictEqual(ctrl.getCommandedBrightness('M1'), 60, 'commanded snaps to canonical after restore')
  } finally {
    mock.timers.reset()
  }
})
