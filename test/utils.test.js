const { test } = require('node:test')
const assert = require('node:assert')

const Utils = require('../src/Utils')

test('parseTime converts HH:MM to minutes since midnight', () => {
  assert.strictEqual(Utils.parseTime("00:00"), 0)
  assert.strictEqual(Utils.parseTime("07:30"), 450)
  assert.strictEqual(Utils.parseTime("23:59"), 1439)
  assert.strictEqual(Utils.parseTime("12:00"), 720)
})

// --- migrateSettings -------------------------------------------------------
// A high app version so the downgrade branch never triggers in these tests.
const NEWER_APP = Utils.getVersionValue("v9.0.0")
// uuid stub that yields deterministic ids
const seqUuid = () => { seqUuid.n = (seqUuid.n || 0) + 1; return `uuid-${seqUuid.n}` }

test('migrateSettings converts monitorFocusTimeUnit "seconds" to seconds', () => {
  const s = { settingsVer: "v9.0.0", monitorFocusTimeUnit: "seconds", monitorFocusMinutes: 3 }
  Utils.migrateSettings(s, { appVersionValue: NEWER_APP })
  assert.strictEqual(s.monitorFocusSeconds, 3)
  assert.strictEqual(s.monitorFocusMinutes, 0)
  assert.ok(!("monitorFocusTimeUnit" in s))
})

test('migrateSettings normalizes updateInterval 999 -> 100', () => {
  const s = { settingsVer: "v9.0.0", updateInterval: 999 }
  Utils.migrateSettings(s, { appVersionValue: NEWER_APP })
  assert.strictEqual(s.updateInterval, 100)
})

test('migrateSettings (v1.15) upgrades legacy detectIdleTime into enabled/min/sec', () => {
  const s = { /* no settingsVer -> oldest */ detectIdleTime: "125", adjustmentTimes: [], hotkeys: {}, monitorFeatures: {} }
  Utils.migrateSettings(s, { appVersionValue: NEWER_APP, makeUuid: seqUuid })
  assert.strictEqual(s.detectIdleTimeEnabled, true)
  assert.strictEqual(s.detectIdleTimeSeconds, 5)
  assert.strictEqual(s.detectIdleTimeMinutes, 2)
  assert.ok(!("detectIdleTime" in s))
})

test('migrateSettings (v1.16) converts legacy hotkeys object to the action array form', () => {
  const s = {
    settingsVer: "v1.15.0",
    adjustmentTimes: [],
    monitorFeatures: {},
    hotkeyPercent: 10,
    hotkeys: { "0": { accelerator: "Ctrl+Up", monitor: "all", direction: 1 } }
  }
  const { resetKnownDisplays } = Utils.migrateSettings(s, { appVersionValue: NEWER_APP, makeUuid: seqUuid })
  assert.ok(Array.isArray(s.hotkeys))
  assert.strictEqual(s.hotkeys.length, 1)
  const action = s.hotkeys[0].actions[0]
  assert.strictEqual(action.type, "offset")
  assert.strictEqual(action.allMonitors, true)
  assert.strictEqual(action.value, 10) // hotkeyPercent * direction
  assert.ok(s.hotkeysPre1160, "keeps the pre-1.16 hotkeys for downgrade")
  assert.strictEqual(resetKnownDisplays, true)
})

test('migrateSettings (v1.16) remaps named monitorFeatures to VCP codes', () => {
  const s = {
    settingsVer: "v1.15.0",
    adjustmentTimes: [],
    hotkeys: {},
    monitorFeatures: { MON_A: { contrast: [50], volume: [30], powerState: [1] } }
  }
  Utils.migrateSettings(s, { appVersionValue: NEWER_APP, makeUuid: seqUuid })
  assert.deepStrictEqual(s.monitorFeatures.MON_A, { "0x12": [50], "0x62": [30], "0xD6": [1] })
})

test('migrateSettings (v1.16) turns disableOverlay into defaultOverlayType and drops it', () => {
  const s = { settingsVer: "v1.15.0", adjustmentTimes: [], hotkeys: {}, monitorFeatures: {}, disableOverlay: true }
  Utils.migrateSettings(s, { appVersionValue: NEWER_APP, makeUuid: seqUuid })
  assert.strictEqual(s.defaultOverlayType, "disabled")
  assert.ok(!("disableOverlay" in s))
})

test('migrateSettings backfills missing profile uuids and strips rawSettings/hdrDisplays', () => {
  // hdrDisplays removal is gated to pre-v1.16.8 settings.
  const s = {
    settingsVer: "v1.16.0",
    adjustmentTimes: [],
    hotkeys: {},
    monitorFeatures: {},
    profiles: [{ name: "a" }, { name: "b", uuid: "keep" }],
    rawSettings: { junk: true },
    hdrDisplays: { x: 1 }
  }
  Utils.migrateSettings(s, { appVersionValue: NEWER_APP, makeUuid: () => "GEN" })
  assert.strictEqual(s.profiles[0].uuid, "GEN")
  assert.strictEqual(s.profiles[1].uuid, "keep")
  assert.ok(!("rawSettings" in s))
  assert.ok(!("hdrDisplays" in s))
})

test('migrateSettings on a current-version settings does not reset known displays', () => {
  const s = { settingsVer: "v9.0.0", hotkeys: [{ id: "x" }] }
  const { resetKnownDisplays } = Utils.migrateSettings(s, { appVersionValue: NEWER_APP })
  assert.strictEqual(resetKnownDisplays, false)
  assert.deepStrictEqual(s.hotkeys, [{ id: "x" }], "leaves modern hotkeys untouched")
})

test('migrateSettings stamps settingsVer/Build when given an appVersion', () => {
  const s = { settingsVer: "v9.0.0" }
  const { changed } = Utils.migrateSettings(s, { appVersionValue: NEWER_APP, appVersion: "9.0.0", appBuild: "abc" })
  assert.strictEqual(s.settingsVer, "v9.0.0")
  assert.strictEqual(s.settingsBuild, "abc")
  // monitorFocusSeconds defaulting still counts as a change
  assert.strictEqual(changed, true)
})

test('migrateSettings reports changed=false for an already-current settings', () => {
  const s = { settingsVer: "v9.0.0", monitorFocusSeconds: 0 }
  const { changed } = Utils.migrateSettings(s, { appVersionValue: NEWER_APP, appVersion: "9.0.0" })
  assert.strictEqual(changed, false)
})

test('migrateSettings is idempotent: a second run on its own output is a no-op', () => {
  const s = {
    /* oldest version -> triggers everything */
    adjustmentTimes: [],
    monitorFeatures: { MON_A: { contrast: [50] } },
    hotkeyPercent: 10,
    hotkeys: { "0": { accelerator: "Ctrl+Up", monitor: "all", direction: 1 } },
    profiles: [{ name: "a" }]
  }
  const ctx = { appVersionValue: NEWER_APP, appVersion: "9.0.0", makeUuid: seqUuid }
  const first = Utils.migrateSettings(s, ctx)
  assert.strictEqual(first.changed, true)
  const second = Utils.migrateSettings(s, ctx)
  assert.strictEqual(second.changed, false, 'second run must not modify already-migrated settings')
})

test('minMax clamps to the given range, default 0-100', () => {
  assert.strictEqual(Utils.minMax(50), 50)
  assert.strictEqual(Utils.minMax(-5), 0)
  assert.strictEqual(Utils.minMax(150), 100)
  assert.strictEqual(Utils.minMax(5, 10, 20), 10)
  assert.strictEqual(Utils.minMax(25, 10, 20), 20)
})

test('easeOutQuad maps endpoints 0->0 and 1->1', () => {
  assert.strictEqual(Utils.easeOutQuad(0), 0)
  assert.strictEqual(Utils.easeOutQuad(1), 1)
  // eased value is ahead of linear in the first half
  assert.ok(Utils.easeOutQuad(0.5) > 0.5)
})

test('determineTheme honors an explicit dark/light, else falls back to system', () => {
  assert.strictEqual(Utils.determineTheme("dark"), "dark")
  assert.strictEqual(Utils.determineTheme("LIGHT"), "light")
  assert.strictEqual(Utils.determineTheme("default", { SystemUsesLightTheme: true }), "light")
  assert.strictEqual(Utils.determineTheme("default", { SystemUsesLightTheme: false }), "dark")
  assert.strictEqual(Utils.determineTheme("default", null), "dark")
})

test('normalizeBrightness passes through when no caps or calibration', () => {
  assert.strictEqual(Utils.normalizeBrightness(50, false, 0, 100, []), 50)
})

test('normalizeBrightness maps to the min/max cap range when sending', () => {
  // sending to Monitors.js (normalize=false): input 0..100 -> output min..max
  assert.strictEqual(Utils.normalizeBrightness(0, false, 20, 80), 20)
  assert.strictEqual(Utils.normalizeBrightness(100, false, 20, 80), 80)
  assert.strictEqual(Utils.normalizeBrightness(50, false, 20, 80), 50)
})

test('readInstanceName splits an InstanceName into hwid parts and unescapes &amp;', () => {
  assert.deepStrictEqual(
    Utils.readInstanceName("DISPLAY\\DELA1AB\\7&1234&0&UID4352"),
    ["DISPLAY", "DELA1AB", "7&1234&0&UID4352"]
  )
  assert.deepStrictEqual(Utils.readInstanceName("A&amp;B\\C"), ["A&B", "C"])
  assert.strictEqual(Utils.readInstanceName(undefined), undefined)
  assert.strictEqual(Utils.readInstanceName(""), undefined)
})

test('parseWMIString decodes semicolon-separated char codes', () => {
  assert.strictEqual(Utils.parseWMIString("72;101;108;108;111"), "Hello")
  assert.strictEqual(Utils.parseWMIString("{72;105}"), "Hi") // strips braces
  assert.strictEqual(Utils.parseWMIString(null), null)
})

test('vcpStr formats a code as an uppercase 0x hex string', () => {
  assert.strictEqual(Utils.vcpStr(18), "0x12")
  assert.strictEqual(Utils.vcpStr(0x62), "0x62")
  assert.strictEqual(Utils.vcpStr("16"), "0x10")
})

test('lerp interpolates between two values', () => {
  assert.strictEqual(Utils.lerp(0, 100, 0), 0)
  assert.strictEqual(Utils.lerp(0, 100, 1), 100)
  assert.strictEqual(Utils.lerp(0, 100, 0.5), 50)
  assert.strictEqual(Utils.lerp(20, 60, 0.25), 30)
})

test('getVersionValue produces comparable numeric versions', () => {
  assert.strictEqual(Utils.getVersionValue("v1.0.0"), 100000000)
  assert.ok(Utils.getVersionValue("v1.17.2") > Utils.getVersionValue("v1.16.9"))
  assert.ok(Utils.getVersionValue("v2.0.0") > Utils.getVersionValue("v1.99.99"))
  // Pre-release suffix is stripped.
  assert.strictEqual(Utils.getVersionValue("v1.2.3-beta"), Utils.getVersionValue("v1.2.3"))
})

test('upgradeAdjustmentTimes leaves already-upgraded entries untouched', () => {
  const times = [{ time: "08:00", brightness: 50, monitors: {} }]
  assert.deepStrictEqual(Utils.upgradeAdjustmentTimes(times), times)
})

test('upgradeAdjustmentTimes converts legacy 12H entries to 24H time strings', () => {
  const legacy = [
    { hour: 8, minute: 30, am: "AM", brightness: 40 },
    { hour: 9, minute: 5, am: "PM", brightness: 70 },
    { hour: 12, minute: 0, am: "AM", brightness: 10 }, // midnight
    { hour: 12, minute: 0, am: "PM", brightness: 90 }  // noon
  ]
  const upgraded = Utils.upgradeAdjustmentTimes(legacy)
  assert.strictEqual(upgraded[0].time, "08:30")
  assert.strictEqual(upgraded[1].time, "21:05")
  assert.strictEqual(upgraded[2].time, "00:00")
  assert.strictEqual(upgraded[3].time, "12:00")
})

test('getCalibratedValue maps values across calibration points', () => {
  const points = [{ input: 0, output: 0 }, { input: 100, output: 100 }]
  assert.strictEqual(Utils.getCalibratedValue(50, points), 50)
})

test('getCalibratedValue with non-identity calibration shifts output', () => {
  // Hardware minimum is 20, maximum is 80: OS 0-100 maps to 20-80
  const points = [{ input: 0, output: 20 }, { input: 100, output: 80 }]
  assert.strictEqual(Utils.getCalibratedValue(0, points), 20)
  assert.strictEqual(Utils.getCalibratedValue(50, points), 50)
  assert.strictEqual(Utils.getCalibratedValue(100, points), 80)
})

test('getCalibratedValue with piecewise calibration points', () => {
  // 0→0, 50→80, 100→100: boosted low-end
  const points = [{ input: 0, output: 0 }, { input: 50, output: 80 }, { input: 100, output: 100 }]
  assert.strictEqual(Utils.getCalibratedValue(25, points), 40)  // halfway 0→80
  assert.strictEqual(Utils.getCalibratedValue(75, points), 90)  // halfway 80→100
})

test('getCalibratedValue clamps out-of-range inputs to 0-100', () => {
  const points = [{ input: 0, output: 0 }, { input: 100, output: 100 }]
  assert.strictEqual(Utils.getCalibratedValue(-10, points), 0)
  assert.strictEqual(Utils.getCalibratedValue(150, points), 100)
})

test('getCalibratedValue reverse maps output back to input', () => {
  const points = [{ input: 0, output: 20 }, { input: 100, output: 80 }]
  assert.strictEqual(Utils.getCalibratedValue(20, points, true), 0)
  assert.strictEqual(Utils.getCalibratedValue(80, points, true), 100)
  assert.strictEqual(Utils.getCalibratedValue(50, points, true), 50)
})

test('upgradeAdjustmentTimes sets monitors to empty object when field is missing', () => {
  // Legacy entries without a monitors field should get monitors: {}, not monitors: 50.
  // The number fallback would crash LERP (Object.keys on a number).
  const legacy = [{ hour: 8, minute: 0, am: "AM", brightness: 50 }]
  const upgraded = Utils.upgradeAdjustmentTimes(legacy)
  assert.deepStrictEqual(upgraded[0].monitors, {})
})

// --- getCalibratedValue: reverse and piecewise edge cases ---

test('getCalibratedValue reverse map with piecewise points', () => {
  // forward 0→0, 50→80, 100→100; reverse output 40 sits halfway up the 0→80 leg => input 25
  const points = [{ input: 0, output: 0 }, { input: 50, output: 80 }, { input: 100, output: 100 }]
  assert.strictEqual(Utils.getCalibratedValue(40, points, true), 25)
  assert.strictEqual(Utils.getCalibratedValue(90, points, true), 75)
})

test('getCalibratedValue reverse maps a fully flat curve to the midpoint instead of NaN', () => {
  // A monitor pinned to one output across the whole range: explicit endpoints at
  // input 0 and 100 share output 50, so no implicit endpoints are injected and the
  // flat segment is the first match. Must return a finite midpoint, not 0/0.
  const points = [{ input: 0, output: 50 }, { input: 100, output: 50 }]
  assert.strictEqual(Utils.getCalibratedValue(50, points, true), 50)
})

test('getCalibratedValue injects implicit 0 and 100 endpoints', () => {
  // Only a single midpoint supplied; the function adds {0,0} and {100,100} so the
  // ends still map. Below the supplied point we interpolate against the implicit {0,0}.
  const points = [{ input: 50, output: 80 }]
  assert.strictEqual(Utils.getCalibratedValue(0, points), 0)
  assert.strictEqual(Utils.getCalibratedValue(25, points), 40)
  assert.strictEqual(Utils.getCalibratedValue(50, points), 80)
})

// --- processArgs: command-line flag parsing ---

test('processArgs parses standalone flags', () => {
  assert.deepStrictEqual(
    Utils.processArgs(["--udp", "--list", "--usetime", "--overlay", "--panel"]),
    { UseUDP: true, List: true, UseTime: true, ShowOverlay: true, ShowPanel: true }
  )
})

test('processArgs reads monitor number and id as separate fields', () => {
  const args = Utils.processArgs(["--monitornum=2", "--monitorid=UID2353"])
  assert.strictEqual(args.MonitorNum, 2)
  // IDs are lower-cased because every arg is lower-cased before matching.
  assert.strictEqual(args.MonitorID, "uid2353")
})

test('processArgs distinguishes absolute set from relative offset', () => {
  assert.deepStrictEqual(Utils.processArgs(["--set=95"]), { Brightness: 95, BrightnessType: "set" })
  assert.deepStrictEqual(Utils.processArgs(["--offset=-20"]), { Brightness: -20, BrightnessType: "offset" })
})

test('processArgs --all only matches the exact flag, not a prefix', () => {
  assert.strictEqual(Utils.processArgs(["--all"]).All, true)
  // "--allow" is longer than 5 chars, so the exact-length guard rejects it.
  assert.strictEqual(Utils.processArgs(["--allow"]).All, undefined)
})

test('processArgs ignores unrecognised arguments', () => {
  assert.deepStrictEqual(Utils.processArgs(["--nonsense", "C:\\path\\twinkle.exe"]), {})
})

test('processArgs is case-insensitive for flag names', () => {
  assert.strictEqual(Utils.processArgs(["--UseTime"]).UseTime, true)
  assert.strictEqual(Utils.processArgs(["--Set=80"]).Brightness, 80)
})

test('processArgs --vcp requires a code:value colon', () => {
  // With a colon it is a valid VCP command.
  assert.strictEqual(Utils.processArgs(["--vcp=0xD6:5"]).VCP, true)
  // Without a colon it is malformed and must NOT be treated as a VCP command.
  // (Regression: indexOf(":") returns -1 here, which is truthy, so the old guard
  // wrongly accepted it.)
  assert.strictEqual(Utils.processArgs(["--vcp=0xD6"]).VCP, undefined)
})

test('isInternalURL accepts localhost dev server and file:// URLs', () => {
  assert.strictEqual(Utils.isInternalURL("http://localhost:3000/index.html"), true)
  assert.strictEqual(Utils.isInternalURL("file:///C:/app/index.html"), true)
})

test('isInternalURL rejects external URLs and non-strings', () => {
  assert.strictEqual(Utils.isInternalURL("https://twinkletray.com"), false)
  assert.strictEqual(Utils.isInternalURL("http://localhost:9999"), false)
  assert.strictEqual(Utils.isInternalURL(undefined), false)
  assert.strictEqual(Utils.isInternalURL(null), false)
})

test('parseTaskbarRegistry maps the edge byte to a position', () => {
  const make = (edge) => { const b = []; b[8] = 0; b[12] = edge; b[20] = 40; return b }
  assert.strictEqual(Utils.parseTaskbarRegistry(make(0)).position, "LEFT")
  assert.strictEqual(Utils.parseTaskbarRegistry(make(1)).position, "TOP")
  assert.strictEqual(Utils.parseTaskbarRegistry(make(2)).position, "RIGHT")
  assert.strictEqual(Utils.parseTaskbarRegistry(make(3)).position, "BOTTOM")
})

test('parseTaskbarRegistry returns null position for an unknown edge byte', () => {
  const b = []; b[8] = 0; b[12] = 7; b[20] = 40
  assert.strictEqual(Utils.parseTaskbarRegistry(b).position, null)
})

test('parseTaskbarRegistry reads height from byte 20', () => {
  const b = []; b[8] = 0; b[12] = 3; b[20] = 48
  assert.strictEqual(Utils.parseTaskbarRegistry(b).height, 48)
})

test('parseTaskbarRegistry reads auto-hide from the low bit of byte 8', () => {
  const b = []; b[12] = 3; b[20] = 40
  b[8] = 3; assert.strictEqual(Utils.parseTaskbarRegistry(b).autoHide, true)   // low bit set
  b[8] = 2; assert.strictEqual(Utils.parseTaskbarRegistry(b).autoHide, false)  // low bit clear
  b[8] = 0; assert.strictEqual(Utils.parseTaskbarRegistry(b).autoHide, false)
})

const Color = require('color')

test('buildAccentPalette clamps a near-white accent into the usable band', () => {
  const palette = Utils.buildAccentPalette(Color, "ffffff")
  // White has lightness 100% (>60), so the primary swatch is pulled to 60%.
  assert.strictEqual(Color(palette.accent).hsl().color[2].toFixed(0), "60")
})

test('buildAccentPalette clamps a near-black accent up to 40%', () => {
  const palette = Utils.buildAccentPalette(Color, "000000")
  assert.strictEqual(Color(palette.accent).hsl().color[2].toFixed(0), "40")
})

test('buildAccentPalette leaves a mid-lightness accent unclamped and returns all swatches', () => {
  const palette = Utils.buildAccentPalette(Color, "0078d7")
  for (const key of ['accent', 'lighter', 'light', 'medium', 'mediumDark', 'dark', 'transparent']) {
    assert.ok(palette[key], `missing swatch ${key}`)
  }
  assert.match(palette.transparent, /^rgb/)
})

test('buildTrayTooltip shows the floored average brightness of ddcci/wmi displays', () => {
  const monitors = {
    a: { type: 'ddcci', brightness: 50 },
    b: { type: 'wmi', brightness: 75 },
    c: { type: 'none', brightness: 0 } // ignored
  }
  assert.strictEqual(Utils.buildTrayTooltip(monitors, {}), 'Twinkle Tray (62%)') // floor(125/2)
})

test('buildTrayTooltip counts a 0-brightness software-dimmed display as negative', () => {
  const monitors = { a: { type: 'ddcci', brightness: 0, softwareDim: 30 } }
  assert.strictEqual(Utils.buildTrayTooltip(monitors, {}), 'Twinkle Tray (-30%)')
})

test('buildTrayTooltip appends kelvin when showKelvin and has no displays', () => {
  assert.strictEqual(Utils.buildTrayTooltip({}, { showKelvin: true, kelvin: 4000 }), 'Twinkle Tray (4000K)')
  assert.strictEqual(Utils.buildTrayTooltip({}, { showKelvin: false, kelvin: 4000 }), 'Twinkle Tray')
})

test('buildTrayTooltip combines brightness and kelvin, and honours the dev suffix', () => {
  const monitors = { a: { type: 'ddcci', brightness: 80 } }
  assert.strictEqual(
    Utils.buildTrayTooltip(monitors, { isDev: true, showKelvin: true, kelvin: 3500 }),
    'Twinkle Tray (Dev) (80%, 3500K)'
  )
})
