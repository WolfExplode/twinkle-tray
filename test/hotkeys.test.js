const { test } = require('node:test')
const assert = require('node:assert')
const { createHotkeyController } = require('../src/hotkeys')

// Build a controller with spy/stub dependencies. Returns the controller plus
// the captured call logs so tests can assert on the IO it performed.
function makeController(overrides = {}) {
  const calls = {
    updateBrightnessThrottle: [],
    touchMonitors: 0,
    writeSettings: [],
    sleepDisplays: [],
    refreshMonitors: [],
    hotkeyOverlayStart: 0,
    getVCP: []
  }

  const monitors = overrides.monitors ?? {
    m0: { key: 'm0', id: 'MON_0', brightness: 50, sdrLevel: 20 }
  }
  const settings = overrides.settings ?? { sleepAction: 'ps' }

  const deps = {
    monitors,
    settings,
    store: { get: () => ({ panelState: 'hidden' }) },
    logger: { debug() {} },
    globalShortcut: { unregisterAll() {}, register: () => true },
    getLastRefreshMonitors: () => Date.now(), // fresh -> never triggers a refresh
    refreshMonitors: async (...a) => { calls.refreshMonitors.push(a) },
    getVCP: async (monitor, code) => { calls.getVCP.push(code); return 30 },
    minMax: (v, min = 0, max = 100) => Math.max(min, Math.min(max, v)),
    touchMonitors: () => { calls.touchMonitors++ },
    updateBrightnessThrottle: (...a) => { calls.updateBrightnessThrottle.push(a) },
    writeSettings: (...a) => { calls.writeSettings.push(a) },
    sleepDisplays: (...a) => { calls.sleepDisplays.push(a) },
    setRecentlyInteracted: () => {},
    hotkeyOverlayStart: () => { calls.hotkeyOverlayStart++ },
    sendToAllWindows: () => {}
  }

  return { controller: createHotkeyController(deps), calls, monitors, settings }
}

test('set brightness applies the clamped value and shows the overlay', async () => {
  const { controller, calls, monitors } = makeController()
  await controller.doHotkey({
    id: 'h1',
    actions: [{ type: 'set', target: 'brightness', value: '40', allMonitors: true, monitors: {} }]
  })
  assert.deepStrictEqual(calls.updateBrightnessThrottle[0], ['MON_0', 40, true, false, undefined, undefined, 'hotkey'])
  assert.strictEqual(calls.hotkeyOverlayStart, 1)
})

test('set brightness clamps out-of-range values', async () => {
  const { controller, calls } = makeController()
  await controller.doHotkey({
    id: 'h1',
    actions: [{ type: 'set', target: 'brightness', value: '250', allMonitors: true, monitors: {} }]
  })
  assert.deepStrictEqual(calls.updateBrightnessThrottle[0], ['MON_0', 100, true, false, undefined, undefined, 'hotkey'])
})

test('set contrast writes the VCP code, not brightness', async () => {
  const { controller, calls } = makeController()
  await controller.doHotkey({
    id: 'h1',
    actions: [{ type: 'set', target: 'contrast', value: '70', allMonitors: true, monitors: {} }]
  })
  assert.deepStrictEqual(calls.updateBrightnessThrottle[0], ['MON_0', 70, false, true, 0x12])
})

test('offset brightness reads current monitor value, no VCP read', async () => {
  const { controller, calls } = makeController()
  await controller.doHotkey({
    id: 'h1',
    actions: [{ type: 'offset', target: 'brightness', value: '10', allMonitors: true, monitors: {} }]
  })
  // 50 (current) + 10 = 60
  assert.deepStrictEqual(calls.updateBrightnessThrottle[0], ['MON_0', 60, true, false, undefined, undefined, 'hotkey'])
  assert.strictEqual(calls.getVCP.length, 0, 'brightness offset must not read a VCP code')
})

test('offset contrast reads via the VCP read code', async () => {
  const { controller, calls } = makeController()
  await controller.doHotkey({
    id: 'h1',
    actions: [{ type: 'offset', target: 'contrast', value: '5', allMonitors: true, monitors: {} }]
  })
  assert.deepStrictEqual(calls.getVCP, [0x12])
  // stub getVCP returns 30; 30 + 5 = 35
  assert.deepStrictEqual(calls.updateBrightnessThrottle[0], ['MON_0', 35, false, true, 0x12])
})

test('cycle advances to the next value on a press', async () => {
  const { controller, calls } = makeController()
  await controller.doHotkey({
    id: 'h1',
    actions: [{ type: 'cycle', target: 'brightness', values: [0, 50, 100], allMonitors: true, monitors: {} }]
  })
  // undefined index -> advance -> 1 -> value 50
  assert.strictEqual(calls.updateBrightnessThrottle[0][1], 50)
})

test('cycle action with empty values does not wedge the reentrancy guard', async () => {
  const { controller, calls } = makeController()
  // Misconfigured hotkey: cycle with no values (e.g. user hasn't filled them in yet)
  await controller.doHotkey({
    id: 'h-broken',
    actions: [{ type: 'cycle', target: 'brightness', values: [], allMonitors: true, monitors: {} }]
  })
  assert.strictEqual(calls.updateBrightnessThrottle.length, 0, 'broken hotkey writes nothing')

  // A different, valid hotkey must still work afterwards — an early return that
  // skips the doingHotkey reset would block every hotkey until app restart.
  await controller.doHotkey({
    id: 'h-good',
    actions: [{ type: 'set', target: 'brightness', value: '40', allMonitors: true, monitors: {} }]
  })
  assert.strictEqual(calls.updateBrightnessThrottle.length, 1, 'later hotkeys must not be blocked')
})

test('breaks linked levels when configured', async () => {
  const { controller, calls } = makeController({
    settings: { sleepAction: 'ps', linkedLevelsActive: true, hotkeysBreakLinkedLevels: true }
  })
  await controller.doHotkey({
    id: 'h1',
    actions: [{ type: 'set', target: 'brightness', value: '40', allMonitors: true, monitors: {} }]
  })
  assert.deepStrictEqual(calls.writeSettings[0], [{ linkedLevelsActive: false }])
})

test('reentrancy guard: a rapid repeat of the same hotkey is dropped', async () => {
  const { controller, calls } = makeController()
  const hotkey = {
    id: 'h1',
    actions: [{ type: 'set', target: 'brightness', value: '40', allMonitors: true, monitors: {} }]
  }
  await controller.doHotkey(hotkey)
  await controller.doHotkey(hotkey) // within 100ms throttle window
  assert.strictEqual(calls.updateBrightnessThrottle.length, 1)
})

test('refresh action refreshes hardware and writes no brightness', async () => {
  const { controller, calls } = makeController()
  await controller.doHotkey({ id: 'h1', actions: [{ type: 'refresh' }] })
  assert.deepStrictEqual(calls.refreshMonitors, [[true, true]])
  assert.strictEqual(calls.updateBrightnessThrottle.length, 0)
})

test('off action sleeps displays', async () => {
  const { controller, calls } = makeController()
  await controller.doHotkey({ id: 'h1', actions: [{ type: 'off' }] })
  assert.deepStrictEqual(calls.sleepDisplays[0], ['ps', 500])
})

test('applyHotkeys registers each accelerator, skipping entries without one', () => {
  const registered = []
  const settings = { hotkeys: [
    { id: 'h1', accelerator: 'Ctrl+1' },
    { id: 'h2', accelerator: 'Ctrl+2' },
    { id: 'h3' } // no accelerator -> skipped
  ] }
  const ctrl = createHotkeyController({
    monitors: {}, settings, store: { get: () => ({}) }, logger: { debug() {} },
    globalShortcut: { unregisterAll() {}, register: (acc) => { registered.push(acc); return true } },
    getLastRefreshMonitors: () => Date.now(), refreshMonitors: async () => {}, getVCP: async () => 0,
    minMax: v => v, touchMonitors() {}, updateBrightnessThrottle() {},
    writeSettings() {}, sleepDisplays() {}, setRecentlyInteracted() {}, hotkeyOverlayStart() {}, sendToAllWindows() {}
  })
  ctrl.applyHotkeys()
  assert.deepStrictEqual(registered, ['Ctrl+1', 'Ctrl+2'])
})
