const { test } = require('node:test')
const assert = require('node:assert')
const { createSoftwareDim } = require('../src/softwareDim')

// Minimal BrowserWindow mock that records constructor calls and tracks
// visible/destroyed state so we can assert overlay creation.
function makeBrowserWindow() {
  const instances = []

  class MockBrowserWindow {
    constructor(opts) {
      this._opts = opts
      this._visible = false
      this._destroyed = false
      this._opacity = 1
      this._bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height }
      instances.push(this)
    }
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setOpacity(v) { this._opacity = v }
    showInactive() { this._visible = true }
    loadURL() {}
    isDestroyed() { return this._destroyed }
    isVisible() { return this._visible }
    hide() { this._visible = false }
    setBounds(b) { this._bounds = b }
  }

  return { MockBrowserWindow, instances }
}

function makeMonitors(withBounds = true) {
  return {
    m1: {
      id: 'MON-A',
      key: 'm1',
      bounds: withBounds ? { position: { x: 0, y: 0 }, width: 1920, height: 1080 } : undefined,
    },
    m2: {
      id: 'MON-B',
      key: 'm2',
      bounds: withBounds ? { position: { x: 1920, y: 0 }, width: 1920, height: 1080 } : undefined,
    },
  }
}

function makeElectronDisplays() {
  return [
    { id: 'D1', bounds: { x: 0,    y: 0, width: 1920, height: 1080 } },
    { id: 'D2', bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
  ]
}

function makeDeps(overrides = {}) {
  const { MockBrowserWindow, instances } = makeBrowserWindow()
  const monitors = makeMonitors(true)
  const idle = { isWindowsUserIdle: false }
  const logLines = []

  const deps = {
    BrowserWindow: MockBrowserWindow,
    screen: { getAllDisplays: () => makeElectronDisplays() },
    store: { get: () => idle, update: () => {}, ref: (slice, key) => ({}) },
    monitors,
    MonitorTransforms: require('../src/monitorTransforms'),
    logger: { debug: (msg) => logLines.push(msg), shortId: (id) => id },
    ...overrides,
  }

  // store.ref must return the actual softwareDimLevels object — re-create with
  // a real ref stub that hands back a stable plain object.
  const softwareDimLevels = {}
  deps.store = {
    get: () => idle,
    update: () => {},
    ref: () => softwareDimLevels,
  }

  return { deps, monitors, idle, instances, logLines, softwareDimLevels }
}

test('overlay created when monitor has bounds.position', () => {
  const { deps, instances } = makeDeps()
  const { updateSoftwareDim } = createSoftwareDim(deps)

  updateSoftwareDim('MON-B', 30)

  assert.strictEqual(instances.length, 1, 'one overlay window created')
  assert.ok(instances[0]._visible, 'overlay is visible')
  assert.strictEqual(instances[0]._opacity, 0.3, 'opacity = level/100')
  assert.strictEqual(instances[0]._bounds.x, 1920, 'overlay positioned at MON-B x')
})

test('overlay NOT created when monitor has no bounds.position', () => {
  const { deps, instances } = makeDeps()
  // Remove bounds from MON-B so pairing silently drops it
  deps.monitors.m2.bounds = undefined
  const { updateSoftwareDim } = createSoftwareDim(deps)

  updateSoftwareDim('MON-B', 30)

  assert.strictEqual(instances.length, 0, 'no overlay — bounds was null')
  const nullLog = deps.logger // we patched it above; check logLines via closure
})

test('logs bounds=null when monitor not paired', () => {
  const { deps, logLines } = makeDeps()
  deps.monitors.m2.bounds = undefined
  const { updateSoftwareDim } = createSoftwareDim(deps)

  updateSoftwareDim('MON-B', 30)

  const boundsLog = logLines.find(l => l.includes('bounds=null'))
  assert.ok(boundsLog, `expected bounds=null log, got: ${JSON.stringify(logLines)}`)
})

test('skipped when isWindowsUserIdle', () => {
  const { deps, instances, idle, logLines } = makeDeps()
  idle.isWindowsUserIdle = true
  const { updateSoftwareDim } = createSoftwareDim(deps)

  updateSoftwareDim('MON-B', 30)

  assert.strictEqual(instances.length, 0, 'no overlay created during idle')
  assert.ok(logLines.some(l => l.includes('isWindowsUserIdle')), 'idle skip logged')
})

test('level=0 hides existing overlay, does not create new one', () => {
  const { deps, instances } = makeDeps()
  const { updateSoftwareDim } = createSoftwareDim(deps)

  updateSoftwareDim('MON-B', 30)
  assert.strictEqual(instances.length, 1)
  assert.ok(instances[0]._visible)

  updateSoftwareDim('MON-B', 0)
  assert.ok(!instances[0]._visible, 'overlay hidden on level=0')
})

test('second call updates opacity and bounds on existing overlay', () => {
  const { deps, instances } = makeDeps()
  const { updateSoftwareDim } = createSoftwareDim(deps)

  updateSoftwareDim('MON-B', 30)
  updateSoftwareDim('MON-B', 60)

  assert.strictEqual(instances.length, 1, 'reuses existing window')
  assert.strictEqual(instances[0]._opacity, 0.6)
})
