const { test } = require('node:test')
const assert = require('node:assert')

const Utils = require('../src/Utils')

test('parseTime converts HH:MM to minutes since midnight', () => {
  assert.strictEqual(Utils.parseTime("00:00"), 0)
  assert.strictEqual(Utils.parseTime("07:30"), 450)
  assert.strictEqual(Utils.parseTime("23:59"), 1439)
  assert.strictEqual(Utils.parseTime("12:00"), 720)
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
