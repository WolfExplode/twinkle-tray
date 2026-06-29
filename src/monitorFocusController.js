// Monitor Focus controller: the stateful runtime for the "dim inactive monitors"
// feature (dim displays the cursor hasn't visited recently, restore on return).
//
// Pure spatial/threshold math lives in ./monitorFocus.js. This module owns the
// parts that need the Electron runtime. Inactive-dim state is controlled via
// brightnessController.animateTo('inactiveOffset', ...) and clearDimOffset —
// no per-monitor setInterval handles here.

const MonitorFocus = require("./monitorFocus")

function createMonitorFocusController(deps) {
  const {
    store,
    settings,
    monitors,
    tempSettings,
    softwareDimLevels,
    brightnessController,
    screen,
    logger,
    updateSoftwareDim,
    touchMonitors,
    shouldSkipDisplay,
    enableMouseEvents,
    pauseMouseEvents
  } = deps

  const monitorFocusDimmed = new Set()
  const monitorLastVisited = {}

  let monitorFocusInterval = null
  let electronToMonitorMap = {}
  let cachedElectronDisplays = null
  let lastMonitorFocusMove = 0

  function invalidateDisplayCache() {
    cachedElectronDisplays = null
    if (settings.monitorFocusEnabled) buildElectronMonitorMap()
  }

  function buildElectronMonitorMap() {
    const displays = (cachedElectronDisplays || (cachedElectronDisplays = screen.getAllDisplays()))
    electronToMonitorMap = MonitorFocus.buildMonitorMap(displays, Object.values(monitors || {}))
    logger.debug(`[monitorFocus] built monitor map: ${JSON.stringify(electronToMonitorMap)}`)
  }

  function getActiveMonitorFromPoint(x, y) {
    const displays = cachedElectronDisplays || (cachedElectronDisplays = screen.getAllDisplays())
    const monitorId = MonitorFocus.monitorIdAtPoint(displays, electronToMonitorMap, x, y)
    if (!monitorId) return null
    return Object.values(monitors).find(m => m.id === monitorId) || null
  }

  function getActiveMonitorFromCursor() {
    const cursorPoint = screen.getCursorScreenPoint()
    return getActiveMonitorFromPoint(cursorPoint.x, cursorPoint.y)
  }

  function applyMonitorFocusTransition(monitor, targetBrightness, targetSoftwareDim = 0) {
    const durationMs = Math.max(100, settings.monitorFocusTransitionDuration ?? 1000)
    const canonicalBrightness = brightnessController.getCanonical(monitor.id).brightness
    const inactiveOffset = Math.max(0, canonicalBrightness - targetBrightness)

    // Split duration 50/50 when both phases apply (see ADR 0004). Hardware runs
    // first so DDC and overlay opacity never animate simultaneously — simultaneous
    // animation triggers MPO flicker on Windows. The split is not perceptually
    // linear (no reliable way to equate DDC units to overlay opacity across
    // monitor brands), so a flat 50/50 is used as a pragmatic default.
    const hardwareDuration = targetSoftwareDim > 0 ? Math.floor(durationMs / 2) : durationMs
    const softwareDuration = durationMs - hardwareDuration

    logger.debug(`[monitorFocus][diag] applyTransition ${logger.shortId(monitor.id)}: canonical=${canonicalBrightness} targetHw=${targetBrightness} targetSwDim=${targetSoftwareDim} offset=${inactiveOffset} hwDur=${hardwareDuration}ms swDur=${softwareDuration}ms`)
    brightnessController.animateTo(monitor.id, 'inactiveOffset', inactiveOffset, hardwareDuration)
    if (targetSoftwareDim > 0) {
      brightnessController.animateTo(monitor.id, 'inactiveSoftwareDim', targetSoftwareDim, softwareDuration, { startDelay: hardwareDuration })
    }
    logger.debug(`[monitorFocus] dimming inactive monitor ${logger.shortId(monitor.id)} — offset=${inactiveOffset} swDim=${targetSoftwareDim} hwDuration=${hardwareDuration}ms swDuration=${softwareDuration}ms`)
  }

  function restoreMonitorFocusBrightness(monitor) {
    if (!monitor || !monitorFocusDimmed.has(monitor.id)) return false

    // Clear the inactive offset — controller snaps commanded back to canonical,
    // which already holds the current schedule/manual value (updated live).
    brightnessController.clearDimOffset(monitor.id, 'inactive')
    // Restore software dim to whatever the controller's canonical holds
    updateSoftwareDim(monitor.id, brightnessController.getCanonical(monitor.id).softwareDim ?? 0)

    monitorFocusDimmed.delete(monitor.id)
    delete monitor.inactiveDimmed
    delete monitor.preDimBrightness
    logger.debug(`[monitorFocus] restored [${logger.shortId(monitor.id)}]`)
    touchMonitors()
    return true
  }

  function handleMonitorFocusMouseMove(x, y) {
    if (!settings.monitorFocusEnabled || !monitors || store.get("idle").userIdleDimmed || store.get("idle").isWindowsUserIdle) return
    if (tempSettings.pauseIdleDetection) return

    const now = Date.now()
    if (monitorFocusDimmed.size === 0 && now - lastMonitorFocusMove < 250) return

    const activeMonitor = getActiveMonitorFromPoint(x, y)
    if (!activeMonitor) return

    if (monitorFocusDimmed.has(activeMonitor.id)) {
      restoreMonitorFocusBrightness(activeMonitor)
      monitorLastVisited[activeMonitor.id] = now
      return
    }

    if (now - lastMonitorFocusMove < 250) return
    lastMonitorFocusMove = now
    monitorLastVisited[activeMonitor.id] = now
  }

  function checkMonitorFocus() {
    if (!monitors || store.get("idle").userIdleDimmed || store.get("idle").isWindowsUserIdle) return
    if (tempSettings.pauseIdleDetection) return

    const activeMonitor = getActiveMonitorFromCursor()
    const now = Date.now()
    const timeout = MonitorFocus.computeTimeoutMs(settings.monitorFocusSeconds, settings.monitorFocusMinutes)

    if (activeMonitor) {
      monitorLastVisited[activeMonitor.id] = now
      restoreMonitorFocusBrightness(activeMonitor)
    }

    for (const monitor of Object.values(monitors)) {
      if (!monitor.id || shouldSkipDisplay(monitor, true)) continue
      if (monitorFocusDimmed.has(monitor.id)) continue
      if (activeMonitor && monitor.id === activeMonitor.id) continue

      const lastVisited = monitorLastVisited[monitor.id] || 0
      if (now - lastVisited < timeout) continue

      const dimLevel = settings.monitorFocusDimLevel ?? 0
      const softwareDimTarget = settings.monitorFocusSoftwareDim ?? 0
      const currentSoftwareDim = softwareDimLevels[monitor.id] || 0
      logger.debug(`[monitorFocus][diag] ${logger.shortId(monitor.id)} — raw settings: monitorFocusDimLevel=${settings.monitorFocusDimLevel} monitorFocusSoftwareDim=${settings.monitorFocusSoftwareDim} → dimLevel=${dimLevel} softwareDimTarget=${softwareDimTarget} currentSwDim=${currentSoftwareDim} monitorBrightness=${monitor.brightness}`)
      if (!MonitorFocus.shouldDimMonitor({ now, lastVisited, timeout, brightness: monitor.brightness, dimLevel, currentSoftwareDim, softwareDimTarget })) {
        logger.debug(`[monitorFocus] skipping dim [${logger.shortId(monitor.id)}] — already at or below dim target`)
        continue
      }
      monitorFocusDimmed.add(monitor.id)
      monitor.inactiveDimmed = true
      applyMonitorFocusTransition(monitor, dimLevel, softwareDimTarget)
    }
  }

  function startMonitorFocusTracking() {
    stopMonitorFocusTracking()
    const now = Date.now()
    for (const monitor of Object.values(monitors || {})) {
      if (!monitorLastVisited[monitor.id]) monitorLastVisited[monitor.id] = now
    }
    buildElectronMonitorMap()
    enableMouseEvents()
    pauseMouseEvents(false)
    monitorFocusInterval = setInterval(checkMonitorFocus, 2000)
    logger.debug(`[monitorFocus] started tracking`)
  }

  function stopMonitorFocusTracking() {
    if (monitorFocusInterval) {
      clearInterval(monitorFocusInterval)
      monitorFocusInterval = null
    }
  }

  function resetMonitorFocusState() {
    for (const monitorId of monitorFocusDimmed) {
      brightnessController.clearDimOffset(monitorId, 'inactive')
      updateSoftwareDim(monitorId, 0)
      const monitor = Object.values(monitors || {}).find(m => m.id === monitorId)
      if (monitor) {
        delete monitor.inactiveDimmed
        delete monitor.preDimBrightness
      }
    }
    for (const k in monitorLastVisited) delete monitorLastVisited[k]
    monitorFocusDimmed.clear()
    electronToMonitorMap = {}
  }

  // Drop inactive-dim state without restoring brightness — used on idle wake.
  // Monitors the cursor is NOT on are still inactive; preserve their dim state
  // to avoid redundant re-animation after every idle wake.
  function clearDimmedStateAfterIdle() {
    const activeMonitor = getActiveMonitorFromCursor()
    const activeId = activeMonitor?.id

    for (const monitorId of [...monitorFocusDimmed]) {
      if (monitorId === activeId) {
        logger.debug(`[monitorFocus] clearDimmedStateAfterIdle — clearing softwareDim for ${logger.shortId(monitorId)} (active)`)
        brightnessController.clearDimOffset(monitorId, 'inactive')
        updateSoftwareDim(monitorId, 0)
        const monitor = Object.values(monitors || {}).find(m => m.id === monitorId)
        if (monitor) { delete monitor.inactiveDimmed; delete monitor.preDimBrightness }
        monitorFocusDimmed.delete(monitorId)
      } else {
        logger.debug(`[monitorFocus] clearDimmedStateAfterIdle — preserving dim for ${logger.shortId(monitorId)} (still inactive)`)
      }
    }

    for (const k in monitorLastVisited) {
      if (!monitorFocusDimmed.has(k)) delete monitorLastVisited[k]
    }
  }

  // Called when the user manually sets brightness on a monitor. Resets the
  // inactive-dim countdown; setCanonical with source 'manual' already cleared
  // the offset via the controller, so no brightness restore is needed here.
  function notifyInteraction(monitorId, source = 'unknown') {
    monitorLastVisited[monitorId] = Date.now()
    if (!monitorFocusDimmed.has(monitorId)) return
    logger.debug(`[monitorFocus] interaction cleared dim [${logger.shortId(monitorId)}] source=${source}`)
    const monitor = Object.values(monitors || {}).find(m => m.id === monitorId)
    if (monitor) {
      delete monitor.inactiveDimmed
      delete monitor.preDimBrightness
    }
    monitorFocusDimmed.delete(monitorId)
    // Software dim was set by inactive dim — clear it on interaction too
    updateSoftwareDim(monitorId, brightnessController.getCanonical(monitorId).softwareDim ?? 0)
    touchMonitors()
  }

  return {
    handleMouseMove: handleMonitorFocusMouseMove,
    start: startMonitorFocusTracking,
    stop: stopMonitorFocusTracking,
    reset: resetMonitorFocusState,
    invalidateDisplayCache,
    clearDimmedStateAfterIdle,
    notifyInteraction,
    isAnyDimmed: () => monitorFocusDimmed.size > 0,
    isDimmed: (monitorId) => monitorFocusDimmed.has(monitorId),
  }
}

module.exports = { createMonitorFocusController }
