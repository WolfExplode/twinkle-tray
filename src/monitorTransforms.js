// Pure transforms over a monitor list.
//
// These were extracted from electron.js, where they read the `settings` and
// `monitors` module globals directly. Here every input is passed explicitly so
// the logic can be unit-tested in isolation. electron.js keeps thin shells that
// inject the relevant settings slice. The functions mutate the monitor objects
// in place (preserving the original behaviour) and also return the list for
// convenience.

// Apply the saved display order to each monitor.
// `order` is an array of { id, order } entries.
function applyOrder(monitorList, order = []) {
  for (const key in monitorList) {
    const monitor = monitorList[key]
    for (const entry of order) {
      if (monitor.id == entry.id) {
        monitor.order = entry.order
      }
    }
  }
  return monitorList
}

// Apply a single remap (min/max/calibration) to one monitor.
// `remaps` is keyed by monitor name or id. An id match wins and stops, so the
// newer id-based scheme overrides a stale name-based entry.
function applyRemap(monitor, remaps = {}) {
  for (const remapName in remaps) {
    if (remapName == monitor.name || remapName == monitor.id) {
      const remap = remaps[remapName]
      monitor.min = remap.min
      monitor.max = remap.max
      monitor.calibration = remap.calibration
      // Stop if using new (id-based) scheme
      if (remapName == monitor.id) return monitor;
    }
  }
  return monitor
}

// Apply remaps across every monitor in the list.
function applyRemaps(monitorList, remaps = {}) {
  for (const key in monitorList) {
    applyRemap(monitorList[key], remaps)
  }
  return monitorList
}

// Decide whether a display should be skipped when re-applying brightness.
// Matches the monitor's hwid[1] (or a raw hwid string) against the built-in
// skip rules plus the user's. `monitorOrHwid` may be a monitor object or a
// hwid string.
function shouldSkipDisplay(monitorOrHwid, skipRules = [], userSkipRules = []) {
  const hwid1 = (typeof monitorOrHwid === "string" ? monitorOrHwid : monitorOrHwid?.hwid?.[1])
  const rules = [].concat(skipRules, userSkipRules)
  return rules.includes(hwid1)
}

module.exports = { applyOrder, applyRemap, applyRemaps, shouldSkipDisplay }
