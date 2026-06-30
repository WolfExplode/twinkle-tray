// Display colour effects (gamma warmth + highlight compression), extracted from
// electron.js. Owns the per-monitor effective/manual level maps and all of the
// ColorGamma application logic — schedule-driven and manual.
//
// Dependencies are injected via createDisplayColor(deps) (same pattern as the
// other extracted subsystems). The level maps live in the store's "color" slice;
// this module seeds them and returns stable aliases so the tray-menu builders and
// settings handlers in electron.js keep reading the same references.
//
// All dependencies flow downward — this module holds no back-edge callbacks into
// electron.js. Schedule queries go through the injected `schedule` instance, and
// cross-subsystem signals (refresh the tray, open the panel) are announced on the
// store via store.touch; electron.js subscribes with store.onTouch.

function createDisplayColor(deps) {
  const {
    ColorGamma,
    store,
    screen,
    monitors,
    MonitorTransforms,
    schedule,
    settings,
    sendToAllWindows,
    logger
  } = deps

  // color slice (store-owned). The level maps (effective warmth/highlight applied
  // per monitor, plus the user's manual levels) are stable references aliased from
  // the slice and mutated in place; the active flags are reassigned values read and
  // written through the store.
  store.update("color", {
    warmthLevels: {},
    highlightLevels: {},
    manualWarmthLevels: {},
    manualHighlightLevels: {},
    manualTemperatureActive: false,
    manualHighlightActive: false
  })
  const warmthLevels = store.get("color").warmthLevels
  const highlightLevels = store.get("color").highlightLevels
  const manualWarmthLevels = store.get("color").manualWarmthLevels
  const manualHighlightLevels = store.get("color").manualHighlightLevels

  function getMonitorDisplayIndex(monitorId) {
    const index = MonitorTransforms.pairDisplaysToMonitors(screen.getAllDisplays(), monitors)
      .findIndex(p => p.monitor?.id === monitorId)
    return index === -1 ? null : index
  }

  function updateDisplayColor(monitorId, { kelvin, highlightWeight } = {}, source = 'unknown') {
    const prevKelvin = warmthLevels[monitorId]
    const prevHighlight = highlightLevels[monitorId]
    if (kelvin !== undefined) warmthLevels[monitorId] = Math.max(3000, Math.min(6500, kelvin))
    if (highlightWeight !== undefined) highlightLevels[monitorId] = highlightWeight

    if (logger && (kelvin !== undefined || highlightWeight !== undefined)) {
      const kStr = kelvin !== undefined ? `kelvin: ${prevKelvin ?? 'none'} → ${warmthLevels[monitorId]}` : ''
      const hStr = highlightWeight !== undefined ? `highlight: ${prevHighlight ?? 'none'} → ${highlightLevels[monitorId]}` : ''
      logger.debug(`[color] updateDisplayColor [${source}] monitor=${monitorId} ${[kStr, hStr].filter(Boolean).join(', ')}`)
    }

    if (store.get("idle").isWindowsUserIdle) return

    ColorGamma.getDisplayCount()

    const displayIndex = getMonitorDisplayIndex(monitorId)
    if (displayIndex == null) return

    const effectiveKelvin = warmthLevels[monitorId] ?? 6500
    const effectiveHighlight = highlightLevels[monitorId] ?? 0
    const tempActive = effectiveKelvin < 6500
    const highlightActive = effectiveHighlight > 0

    if (!tempActive && !highlightActive) {
      ColorGamma.resetGammaRamp(displayIndex)
    } else {
      ColorGamma.applyDisplayTransform(displayIndex, {
        kelvin: tempActive ? effectiveKelvin : 6500,
        highlightWeight: highlightActive ? effectiveHighlight / 100 : 0
      })
    }

    sendDisplayColorLevels()
    store.touch("trayStatus")
  }

  function updateWarmth(monitorId, kelvin = 6500) {
    kelvin = Math.max(3000, Math.min(6500, kelvin))
    manualWarmthLevels[monitorId] = kelvin
    if (store.get("color").manualTemperatureActive) {
      updateDisplayColor(monitorId, { kelvin }, 'manual-warmth')
    }
  }

  function updateHighlightCompression(monitorId, weight = 0) {
    manualHighlightLevels[monitorId] = weight
    if (store.get("color").manualHighlightActive) {
      updateDisplayColor(monitorId, { highlightWeight: weight }, 'manual-highlight')
    }
  }

  function sendDisplayColorLevels() {
    sendToAllWindows('warmth-levels-updated', warmthLevels)
    sendToAllWindows('highlight-levels-updated', highlightLevels)
  }

  function showDisplayColorEffects() {
    const ids = new Set([...Object.keys(warmthLevels), ...Object.keys(highlightLevels)])
    for (const id of ids) {
      updateDisplayColor(id)
    }
  }

  function getScheduledColorForMonitor(monitor, foundEvent) {
    return schedule.getScheduledColorForMonitor(monitor, foundEvent)
  }

  function applyCurrentDisplayColorEffects(overrideManual = true) {
    const foundEvent = schedule.getCurrentAdjustmentEvent()
    if (!foundEvent) return

    if (logger) logger.debug(`[color] applyCurrentDisplayColorEffects overrideManual=${overrideManual} event.kelvin=${foundEvent.kelvin ?? 'none'} event.highlightWeight=${foundEvent.highlightWeight ?? 'none'}`)

    for (let key in monitors) {
      const monitor = monitors[key]
      const updates = getScheduledColorForMonitor(monitor, foundEvent)
      if (!overrideManual) {
        const color = store.get("color")
        if (color.manualTemperatureActive) delete updates.kelvin
        if (color.manualHighlightActive) delete updates.highlightWeight
      }
      if (Object.keys(updates).length) {
        updateDisplayColor(monitor.id, updates, 'schedule-color-effects')
      }
    }
  }

  // The currently-shown average colour temperature, used for the tray tooltip.
  function getCurrentKelvin() {
    try {
      if (!store.get("color").manualTemperatureActive && !settings.adjustmentTimeTemperatureEnabled) return 6500
      const activeLevels = Object.values(warmthLevels).filter(k => k > 0 && k < 6500)
      if (activeLevels.length) {
        return Math.round(activeLevels.reduce((a, b) => a + b, 0) / activeLevels.length)
      }
      const event = schedule.getCurrentAdjustmentEvent()
      if (event?.kelvin != null) return event.kelvin
    } catch (e) { }
    return 6500
  }

  function sendColorToggleState() {
    const color = store.get("color")
    sendToAllWindows('color-toggle-state', { manualTemperatureActive: color.manualTemperatureActive, manualHighlightActive: color.manualHighlightActive })
  }

  // Toggle the manual (non-scheduled) temperature or highlight effect on/off.
  // Turning off restores the value the schedule would set (or a neutral
  // default); turning on re-applies the user's last manual value.
  function toggleColorEffect(type, openPanel = false) {
    const isTemp = type === 'temperature'
    const effectiveLevels = isTemp ? warmthLevels : highlightLevels
    const manualLevels = isTemp ? manualWarmthLevels : manualHighlightLevels
    const scheduleKey = isTemp ? 'adjustmentTimeTemperatureEnabled' : 'adjustmentTimeHighlightCompressionEnabled'
    const scheduledProp = isTemp ? 'kelvin' : 'highlightWeight'
    const defaultValue = isTemp ? 6500 : 0
    const shouldPreserve = isTemp ? (v) => v != null && v < 6500 : (v) => v != null && v > 0
    const applyManual = isTemp
      ? (id, v) => updateWarmth(id, v)
      : (id, v) => updateHighlightCompression(id, v)
    const applyDisplay = isTemp
      ? (id, v) => updateDisplayColor(id, { kelvin: v }, 'toggle-off')
      : (id, v) => updateDisplayColor(id, { highlightWeight: v }, 'toggle-off')

    const activeKey = isTemp ? 'manualTemperatureActive' : 'manualHighlightActive'
    const wasActive = store.get("color")[activeKey]
    if (wasActive) {
      // Preserve current effective value before turning off
      for (const key in monitors) {
        const id = monitors[key].id
        const val = effectiveLevels[id] ?? manualLevels[id]
        if (shouldPreserve(val)) manualLevels[id] = val
      }
    }

    const nowActive = !wasActive
    store.update("color", { [activeKey]: nowActive })

    if (logger) logger.debug(`[color] toggleColorEffect(${type}) wasActive=${wasActive} → nowActive=${nowActive}`)
    if (nowActive) {
      for (const key in monitors) {
        const id = monitors[key].id
        applyManual(id, manualLevels[id] ?? effectiveLevels[id] ?? defaultValue)
      }
    } else {
      const foundEvent = (settings[scheduleKey] && settings.adjustmentTimesActive) ? schedule.getCurrentAdjustmentEvent() : null
      if (logger) logger.debug(`[color] toggleColorEffect(${type}) OFF: scheduleEnabled=${settings[scheduleKey]} foundEvent.${scheduledProp}=${foundEvent?.[scheduledProp] ?? 'none'} → fallback=${defaultValue}`)
      for (const key in monitors) {
        const monitor = monitors[key]
        const updates = foundEvent ? getScheduledColorForMonitor(monitor, foundEvent) : {}
        applyDisplay(monitor.id, updates[scheduledProp] ?? defaultValue)
      }
    }
    store.touch("trayMenu")
    store.touch("trayStatus")
    sendColorToggleState()
    if (openPanel && nowActive) {
      store.touch("requestPanelOpen")
    }
  }

  function toggleColorTemperature(openPanel = false) {
    toggleColorEffect('temperature', openPanel)
  }

  function toggleHighlightCompression(openPanel = false) {
    toggleColorEffect('highlight', openPanel)
  }

  return {
    warmthLevels,
    highlightLevels,
    manualWarmthLevels,
    manualHighlightLevels,
    updateDisplayColor,
    updateWarmth,
    updateHighlightCompression,
    sendDisplayColorLevels,
    showDisplayColorEffects,
    getScheduledColorForMonitor,
    applyCurrentDisplayColorEffects,
    getCurrentKelvin,
    sendColorToggleState,
    toggleColorEffect,
    toggleColorTemperature,
    toggleHighlightCompression
  }
}

module.exports = { createDisplayColor }
