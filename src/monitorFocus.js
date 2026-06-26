// Pure decision logic for the "Monitor Focus" feature (dim monitors the cursor
// hasn't visited recently, restore them on return).
//
// Extracted from electron.js so the spatial/threshold math can be unit tested
// without the Electron runtime. Every function here is pure: it takes plain
// data (display bounds, monitor records, timestamps, settings values) and
// returns a result. The stateful orchestration — intervals, brightness writes,
// mouse hooks — stays in electron.js and calls into these helpers.

// Map each Electron display id to a tray monitor id by spatial order.
// Both lists are sorted left-to-right, top-to-bottom, then zipped by index, so
// display N from the left controls tray monitor N from the left.
function buildMonitorMap(electronDisplays = [], trayMonitors = []) {
  const displays = electronDisplays
    .slice()
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)

  const sortedMonitors = trayMonitors
    .filter(m => m.bounds?.position !== undefined)
    .sort((a, b) => a.bounds.position.x - b.bounds.position.x || a.bounds.position.y - b.bounds.position.y)

  const map = {}
  displays.forEach((d, i) => {
    if (sortedMonitors[i]) map[d.id] = sortedMonitors[i].id
  })
  return map
}

// Find the display whose bounds contain the point. Right/bottom edges are
// exclusive so adjacent displays don't both claim a shared border pixel.
function findDisplayAtPoint(electronDisplays = [], x, y) {
  return electronDisplays.find(d =>
    x >= d.bounds.x && x < d.bounds.x + d.bounds.width &&
    y >= d.bounds.y && y < d.bounds.y + d.bounds.height
  ) || null
}

// Resolve the tray monitor id under a point, or null if none maps there.
function monitorIdAtPoint(electronDisplays = [], monitorMap = {}, x, y) {
  const display = findDisplayAtPoint(electronDisplays, x, y)
  if (!display) return null
  return monitorMap[display.id] || null
}

// Inactivity timeout in milliseconds from the user's seconds/minutes settings.
function computeTimeoutMs(seconds, minutes) {
  return (parseInt(seconds || 0) + (minutes || 0) * 60) * 1000
}

// Whether an inactive monitor should be dimmed now. It's due once the timeout
// has elapsed, but we skip it if it's already at or below the dim target —
// applying the dim would otherwise *raise* brightness.
function shouldDimMonitor({ now, lastVisited, timeout, brightness, dimLevel, currentSoftwareDim, softwareDimTarget }) {
  if (now - (lastVisited || 0) < timeout) return false
  if (brightness <= dimLevel && currentSoftwareDim >= softwareDimTarget) return false
  return true
}

// One interpolation step of a focus transition, modelled as a single signed
// "combined" axis: positive = DDC brightness (0..100), negative = software dim
// (0..softwareDimMax), matching the slider semantics used everywhere else
// (splitAdjustmentLevel / getAdjustmentLevel). Collapsing both dim methods onto
// one line means the ramp crosses zero exactly once, so the DDC portion finishes
// (reaches 0) before the software overlay starts — the two never move at the same
// time, which is what caused the dim/real-dim fight and flicker. Brightness is
// rounded (it drives a DDC write); software dim stays fractional for a smooth fade.
function computeTransitionStep({ startBrightness, targetBrightness, startSoftwareDim = 0, targetSoftwareDim = 0, progress }) {
  const p = Math.min(1, Math.max(0, progress))
  const startCombined = startBrightness - startSoftwareDim
  const targetCombined = targetBrightness - targetSoftwareDim
  const combined = startCombined + (targetCombined - startCombined) * p
  return {
    brightness: Math.round(Math.max(0, combined)),
    softwareDim: Math.max(0, -combined)
  }
}

// Where to restore a monitor when the cursor returns. Prefer the schedule's
// current intended value (so we land correctly even if the schedule changed
// while the monitor was dimmed); otherwise fall back to the pre-dim brightness.
function getRestoreTarget({ scheduleActive, scheduledBrightness, preDimBrightness }) {
  const useSchedule = scheduleActive && scheduledBrightness
  return {
    brightness: useSchedule ? scheduledBrightness.brightness : preDimBrightness,
    softwareDim: useSchedule ? scheduledBrightness.softwareDim : 0
  }
}

module.exports = {
  buildMonitorMap,
  findDisplayAtPoint,
  monitorIdAtPoint,
  computeTimeoutMs,
  shouldDimMonitor,
  computeTransitionStep,
  getRestoreTarget
}
