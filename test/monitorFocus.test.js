const { test } = require('node:test')
const assert = require('node:assert')

const {
  buildMonitorMap,
  findDisplayAtPoint,
  monitorIdAtPoint,
  computeTimeoutMs,
  shouldDimMonitor,
  computeTransitionStep,
  getRestoreTarget
} = require('../src/monitorFocus')

// Helpers: Electron-style display (flat bounds) and tray monitor (nested position).
const disp = (id, x, y, width = 100, height = 100) => ({ id, bounds: { x, y, width, height } })
const mon = (id, x, y) => ({ id, bounds: { position: { x, y } } })

test('buildMonitorMap zips displays to monitors in left-to-right order', () => {
  // Displays out of order; should sort by x then y before zipping.
  const displays = [disp('dB', 100, 0), disp('dA', 0, 0), disp('dC', 200, 0)]
  const monitors = [mon('mC', 200, 0), mon('mA', 0, 0), mon('mB', 100, 0)]
  assert.deepStrictEqual(buildMonitorMap(displays, monitors), {
    dA: 'mA', dB: 'mB', dC: 'mC'
  })
})

test('buildMonitorMap ignores monitors without a position and zips by index', () => {
  const displays = [disp('dA', 0, 0), disp('dB', 100, 0)]
  const monitors = [mon('mA', 0, 0), { id: 'noPos' }, mon('mB', 100, 0)]
  assert.deepStrictEqual(buildMonitorMap(displays, monitors), { dA: 'mA', dB: 'mB' })
})

test('buildMonitorMap leaves extra displays unmapped', () => {
  const displays = [disp('dA', 0, 0), disp('dB', 100, 0)]
  const monitors = [mon('mA', 0, 0)]
  assert.deepStrictEqual(buildMonitorMap(displays, monitors), { dA: 'mA' })
})

test('findDisplayAtPoint uses exclusive right/bottom edges', () => {
  const displays = [disp('dA', 0, 0, 100, 100), disp('dB', 100, 0, 100, 100)]
  assert.strictEqual(findDisplayAtPoint(displays, 50, 50).id, 'dA')
  // x=100 is the exclusive edge of dA, inclusive start of dB
  assert.strictEqual(findDisplayAtPoint(displays, 100, 50).id, 'dB')
  assert.strictEqual(findDisplayAtPoint(displays, 999, 999), null)
})

test('monitorIdAtPoint resolves through the map, null when unmapped', () => {
  const displays = [disp('dA', 0, 0), disp('dB', 100, 0)]
  const map = { dA: 'mA' } // dB intentionally unmapped
  assert.strictEqual(monitorIdAtPoint(displays, map, 10, 10), 'mA')
  assert.strictEqual(monitorIdAtPoint(displays, map, 110, 10), null)
  assert.strictEqual(monitorIdAtPoint(displays, map, 9999, 10), null)
})

test('computeTimeoutMs sums seconds and minutes into ms', () => {
  assert.strictEqual(computeTimeoutMs(30, 0), 30000)
  assert.strictEqual(computeTimeoutMs(0, 2), 120000)
  assert.strictEqual(computeTimeoutMs('15', 1), 75000)
  assert.strictEqual(computeTimeoutMs(undefined, undefined), 0)
})

test('shouldDimMonitor: not due until timeout elapses', () => {
  const base = { now: 1000, lastVisited: 0, timeout: 2000, brightness: 80, dimLevel: 20, currentSoftwareDim: 0, softwareDimTarget: 0 }
  assert.strictEqual(shouldDimMonitor(base), false)
  assert.strictEqual(shouldDimMonitor({ ...base, now: 2000 }), true)
})

test('shouldDimMonitor: skips when already at or below the dim target', () => {
  const due = { now: 5000, lastVisited: 0, timeout: 1000, dimLevel: 20, softwareDimTarget: 30 }
  // Brightness at/below dim level AND software dim at/above target -> skip
  assert.strictEqual(shouldDimMonitor({ ...due, brightness: 20, currentSoftwareDim: 30 }), false)
  assert.strictEqual(shouldDimMonitor({ ...due, brightness: 10, currentSoftwareDim: 50 }), false)
  // Brighter than dim level -> still dim
  assert.strictEqual(shouldDimMonitor({ ...due, brightness: 50, currentSoftwareDim: 30 }), true)
  // At brightness target but software dim below target -> still dim
  assert.strictEqual(shouldDimMonitor({ ...due, brightness: 20, currentSoftwareDim: 10 }), true)
})

test('computeTransitionStep interpolates and rounds brightness', () => {
  const args = { startBrightness: 0, targetBrightness: 100, startSoftwareDim: 0, targetSoftwareDim: 50 }
  assert.deepStrictEqual(computeTransitionStep({ ...args, progress: 0 }), { brightness: 0, softwareDim: 0 })
  assert.deepStrictEqual(computeTransitionStep({ ...args, progress: 0.5 }), { brightness: 50, softwareDim: 25 })
  assert.deepStrictEqual(computeTransitionStep({ ...args, progress: 1 }), { brightness: 100, softwareDim: 50 })
  // brightness is rounded
  assert.strictEqual(computeTransitionStep({ ...args, progress: 0.333 }).brightness, 33)
})

test('computeTransitionStep clamps progress to 0..1', () => {
  const args = { startBrightness: 10, targetBrightness: 90, startSoftwareDim: 0, targetSoftwareDim: 0 }
  assert.strictEqual(computeTransitionStep({ ...args, progress: -1 }).brightness, 10)
  assert.strictEqual(computeTransitionStep({ ...args, progress: 5 }).brightness, 90)
})

test('getRestoreTarget prefers the active schedule value', () => {
  assert.deepStrictEqual(getRestoreTarget({
    scheduleActive: true,
    scheduledBrightness: { brightness: 70, softwareDim: 15 },
    preDimBrightness: 40
  }), { brightness: 70, softwareDim: 15 })
})

test('getRestoreTarget falls back to pre-dim brightness when schedule inactive', () => {
  assert.deepStrictEqual(getRestoreTarget({
    scheduleActive: false,
    scheduledBrightness: { brightness: 70, softwareDim: 15 },
    preDimBrightness: 40
  }), { brightness: 40, softwareDim: 0 })
})

test('getRestoreTarget falls back when schedule active but no scheduled value', () => {
  assert.deepStrictEqual(getRestoreTarget({
    scheduleActive: true,
    scheduledBrightness: undefined,
    preDimBrightness: 55
  }), { brightness: 55, softwareDim: 0 })
})
