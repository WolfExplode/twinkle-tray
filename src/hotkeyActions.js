// Pure decision logic for hotkey actions.
//
// Extracted from doHotkey() in electron.js, which previously inlined the
// target->VCP-code mapping (in two places), the cycle-index advancement, and
// the new-value computation while reaching into module globals. Here every
// input is explicit so the behaviour can be unit-tested. electron.js keeps the
// IO (reading current VCP values, writing brightness) and calls into these.

// Hotkey action targets that map to a VCP feature code. "brightness" and "sdr"
// are handled separately by the caller (they are not plain VCP writes), so they
// are intentionally absent here.
//
// NOTE: powerState reads the power-mode code (0xD6) but writes 0xD2. This
// asymmetry is preserved exactly from the original inline code — it predates the
// extraction and may be a latent bug worth confirming against the VESA MCCS
// spec (0xD6 = power mode), but changing it is a behaviour change, not a
// refactor, so it is left as-is.
const VCP_TARGET_ALIASES = {
  contrast: { read: 0x12, write: 0x12 },
  volume: { read: 0x62, write: 0x62 },
  powerState: { read: 0xD6, write: 0xD2 }
}

// Resolve a hotkey action target to the numeric VCP code to use for the given
// mode ("read" | "write"). Known aliases map per VCP_TARGET_ALIASES; anything
// else is treated as a raw code string (e.g. "0x10") and parsed. Returns a
// number, or NaN if the target is not a recognised alias or numeric code.
function vcpCodeForTarget(target, mode = "read") {
  const alias = VCP_TARGET_ALIASES[target]
  if (alias) return alias[mode]
  return parseInt(target)
}

// True when the caller must read the monitor's own state instead of a VCP code
// (brightness lives on the monitor object, sdr lives on monitor.sdrLevel).
function isNonVCPTarget(target) {
  return target === "brightness" || target === "sdr"
}

// Advance a cycle action's index, wrapping back to 0 after the last value.
// `currentIndex` may be undefined (treated as 0, i.e. the first press lands on
// index 1 — matching the original behaviour where the index advances on the
// first cycle action of a press).
function advanceCycleIndex(currentIndex, valuesLength) {
  const index = currentIndex || 0
  if (index >= valuesLength - 1) return 0
  return index + 1
}

// Compute the new value for a "set", "offset", or "cycle" action.
// - set:    parseInt(value)
// - offset: currentValue + parseInt(value)
// - cycle:  values[cycleIndex]
// currentValue is only consulted for "offset"; cycleIndex/values only for
// "cycle". Returns a number, or undefined for an unknown action type.
function computeNewValue({ type, value, currentValue = 0, values = [], cycleIndex = 0 }) {
  if (type === "set") return parseInt(value)
  if (type === "offset") return currentValue + parseInt(value)
  if (type === "cycle") return values[cycleIndex]
  return undefined
}

module.exports = {
  VCP_TARGET_ALIASES,
  vcpCodeForTarget,
  isNonVCPTarget,
  advanceCycleIndex,
  computeNewValue
}
