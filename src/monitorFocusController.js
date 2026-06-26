// Monitor Focus controller: the stateful runtime for the "dim inactive monitors"
// feature (dim displays the cursor hasn't visited recently, restore on return).
//
// Pure spatial/threshold math lives in ./monitorFocus.js. This module owns the
// parts that need the Electron runtime and used to be a cluster of electron.js
// module globals: the check/transition intervals, the display-map cache, and the
// brightness/software-dim writes.
//
// Dependencies are injected via createMonitorFocusController(deps) — same pattern
// as createHotkeyController — so the subsystem has an explicit contract and can
// be exercised with stubs. The dim-state itself is owned here and stays local:
// it is never persisted or broadcast, so it has no reason to live in the store.
// External readers (the schedule apply) query it through isAnyDimmed/isDimmed.

const MonitorFocus = require("./monitorFocus")

function createMonitorFocusController(deps) {
  const {
    store,
    settings,                 // live settings slice (store.get("settings"))
    monitors,                 // live monitor map (store.get("monitors").all)
    tempSettings,             // { pauseTimeAdjustments, pauseIdleDetection }
    softwareDimLevels,        // live color-slice map (store.get("color").softwareDimLevels)
    scheduledBrightness,      // live schedule-slice map (store.get("schedule").scheduledBrightness)
    screen,
    logger,
    updateBrightness,
    updateSoftwareDim,
    touchMonitors,
    shouldSkipDisplay,
    enableMouseEvents,
    pauseMouseEvents
  } = deps

  // Inactive-dim runtime state (controller-local — see header). The maps are
  // cleared by deleting keys, not reassigning, so external `for..in` callers
  // never see a stale reference; the Set is cleared via .clear().
  const monitorFocusDimmed = new Set()
  const monitorLastVisited = {}
  const monitorPreDimBrightness = {}

  let monitorFocusInterval = null
  // Per-monitor transition intervals, keyed by monitor id. Keeping them separate
  // means dimming a second monitor doesn't cancel the first monitor's in-flight
  // ramp (which a single shared handle would).
  const monitorFocusTransitions = {}
  let electronToMonitorMap = {}
  let cachedElectronDisplays = null
  let lastMonitorFocusMove = 0

  function clearMonitorFocusMaps() {
    for (const k in monitorLastVisited) delete monitorLastVisited[k]
    for (const k in monitorPreDimBrightness) delete monitorPreDimBrightness[k]
  }

  function invalidateDisplayCache() {
    cachedElectronDisplays = null
    if (settings.monitorFocusEnabled) buildElectronMonitorMap()
  }

  function buildElectronMonitorMap() {
    const displays = (cachedElectronDisplays || (cachedElectronDisplays = screen.getAllDisplays()))
    electronToMonitorMap = MonitorFocus.buildMonitorMap(displays, Object.values(monitors || {}))
    logger.debug(`\x1b[36mBuilt monitor focus map: ${JSON.stringify(electronToMonitorMap)}\x1b[0m`)
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

  function stopMonitorFocusTransition(monitorId) {
    if (monitorFocusTransitions[monitorId]) {
      clearInterval(monitorFocusTransitions[monitorId])
      delete monitorFocusTransitions[monitorId]
    }
  }

  function stopAllMonitorFocusTransitions() {
    for (const id in monitorFocusTransitions) stopMonitorFocusTransition(id)
  }

  function applyMonitorFocusTransition(monitor, targetBrightness, targetSoftwareDim = 0) {
    stopMonitorFocusTransition(monitor.id)

    const TICK_MS = 16
    const DDC_THROTTLE_MS = 50
    const durationMs = Math.max(100, settings.monitorFocusTransitionDuration ?? 1000)
    const startBrightness = monitor.brightness
    const startSoftwareDim = softwareDimLevels[monitor.id] || 0
    const startTime = Date.now()
    let lastSentBrightness = startBrightness
    let lastSentSoftwareDim = startSoftwareDim
    let lastDDCWrite = 0

    monitorFocusTransitions[monitor.id] = setInterval(() => {
      const elapsed = Date.now() - startTime
      const now = startTime + elapsed
      const progress = Math.min(1, elapsed / durationMs)
      const { brightness: currentBrightness, softwareDim: currentSoftwareDim } = MonitorFocus.computeTransitionStep({
        startBrightness, targetBrightness, startSoftwareDim, targetSoftwareDim, progress
      })
      let uiUpdated = false

      if (currentBrightness !== lastSentBrightness && now - lastDDCWrite >= DDC_THROTTLE_MS) {
        updateBrightness(monitor.id, currentBrightness, true, "brightness", false)
        lastSentBrightness = currentBrightness
        lastDDCWrite = now
        uiUpdated = true
      }

      if (startSoftwareDim !== targetSoftwareDim) {
        updateSoftwareDim(monitor.id, progress >= 1 ? targetSoftwareDim : currentSoftwareDim)
        lastSentSoftwareDim = currentSoftwareDim
        uiUpdated = true
      }

      if (progress >= 1) {
        if (lastSentBrightness !== targetBrightness) {
          updateBrightness(monitor.id, targetBrightness, true, "brightness", false)
        }
        updateSoftwareDim(monitor.id, targetSoftwareDim)
        stopMonitorFocusTransition(monitor.id)
        uiUpdated = true
      }

      if (uiUpdated) touchMonitors()
    }, TICK_MS)
  }

  function restoreMonitorFocusBrightness(monitor) {
    if (!monitor || !monitorFocusDimmed.has(monitor.id)) return false

    // Prefer the schedule's current intended value so we land on the right brightness
    // even if the schedule changed while this monitor was inactive-dimmed.
    // Fall back to the brightness saved just before dimming started.
    const scheduleActive = settings.adjustmentTimesActive && !tempSettings.pauseTimeAdjustments
    const { brightness: targetBrightness, softwareDim: targetSoftwareDim } = MonitorFocus.getRestoreTarget({
      scheduleActive,
      scheduledBrightness: scheduledBrightness[monitor.id],
      preDimBrightness: monitorPreDimBrightness[monitor.id]
    })

    stopMonitorFocusTransition(monitor.id)
    if (targetBrightness !== undefined) {
      updateBrightness(monitor.id, targetBrightness, true, "brightness")
      logger.debug(`\x1b[36mRestored monitor focus brightness for ${monitor.id}\x1b[0m`)
    }
    updateSoftwareDim(monitor.id, targetSoftwareDim)
    monitorFocusDimmed.delete(monitor.id)
    delete monitor.inactiveDimmed
    delete monitorPreDimBrightness[monitor.id]
    touchMonitors()
    return true
  }

  function handleMonitorFocusMouseMove(x, y) {
    if (!settings.monitorFocusEnabled || !monitors || store.get("idle").userIdleDimmed || store.get("idle").isWindowsUserIdle) return
    if (tempSettings.pauseIdleDetection) return

    const now = Date.now()

    // Skip lookup entirely if debounce hasn't expired and no monitors need restoring
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
      if (!MonitorFocus.shouldDimMonitor({ now, lastVisited, timeout, brightness: monitor.brightness, dimLevel, currentSoftwareDim, softwareDimTarget })) {
        // Already at or below the dim target — applying it would raise brightness.
        logger.debug(`\x1b[36mSkipping inactive dim for ${monitor.id} — already at or below dim target\x1b[0m`)
        continue
      }
      monitorPreDimBrightness[monitor.id] = monitor.brightness
      monitorFocusDimmed.add(monitor.id)
      monitor.inactiveDimmed = true
      applyMonitorFocusTransition(monitor, dimLevel, softwareDimTarget)
      logger.debug(`\x1b[36mDimming inactive monitor ${monitor.id}\x1b[0m`)
    }
  }

  function startMonitorFocusTracking() {
    stopMonitorFocusTracking()
    const now = Date.now()
    for (const monitor of Object.values(monitors || {})) {
      if (!monitorLastVisited[monitor.id]) {
        monitorLastVisited[monitor.id] = now
      }
    }
    buildElectronMonitorMap()
    enableMouseEvents()
    pauseMouseEvents(false)
    monitorFocusInterval = setInterval(checkMonitorFocus, 2000)
    logger.debug(`\x1b[36mStarted monitor focus tracking.\x1b[0m`)
  }

  function stopMonitorFocusTracking() {
    stopAllMonitorFocusTransitions()
    if (monitorFocusInterval) {
      clearInterval(monitorFocusInterval)
      monitorFocusInterval = null
    }
  }

  function resetMonitorFocusState() {
    stopAllMonitorFocusTransitions()
    for (const monitorId of monitorFocusDimmed) {
      const monitor = Object.values(monitors || {}).find(m => m.id === monitorId)
      const savedLevel = monitorPreDimBrightness[monitorId]
      if (monitor) {
        if (savedLevel !== undefined) updateBrightness(monitorId, savedLevel, true, "brightness")
        delete monitor.inactiveDimmed
      }
      updateSoftwareDim(monitorId, 0)
    }
    clearMonitorFocusMaps()
    monitorFocusDimmed.clear()
    electronToMonitorMap = {}
  }

  // Drop inactive-dim state without restoring brightness — used on idle wake,
  // where the idle-restore path already sets the correct brightness and only the
  // leftover software-dim overlays and the timeout windows need clearing.
  function clearDimmedStateAfterIdle() {
    for (const monitorId of monitorFocusDimmed) {
      updateSoftwareDim(monitorId, 0)
    }
    clearMonitorFocusMaps()
    monitorFocusDimmed.clear()
  }

  return {
    handleMouseMove: handleMonitorFocusMouseMove,
    start: startMonitorFocusTracking,
    stop: stopMonitorFocusTracking,
    reset: resetMonitorFocusState,
    invalidateDisplayCache,
    clearDimmedStateAfterIdle,
    // Inactive-dim queries for external priority logic (schedule apply).
    isAnyDimmed: () => monitorFocusDimmed.size > 0,
    isDimmed: (monitorId) => monitorFocusDimmed.has(monitorId)
  }
}

module.exports = { createMonitorFocusController }
