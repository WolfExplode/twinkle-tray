"use strict"
// Single synchronous gatekeeper for all canonical brightness state and DDC
// dispatch. See docs/adr/0002-brightness-controller-concurrency.md and
// docs/adr/0003-unified-animation-engine.md.

const TICK_MS = 16

function createBrightnessController(deps) {
  const {
    monitors,            // live monitor map (mutated in place, reference stable)
    monitorsThread,      // child process: send({ type, ... }) for DDC dispatch
    store,
    settings,            // live settings slice reference
    touchMonitors,       // push monitors-updated to renderer
    updateKnownDisplays, // persist canonical to known-displays
    setTrayStatus,
    shouldSkipDisplay,
    updateSoftwareDim,   // createSoftwareDim().updateSoftwareDim
    updateDisplayColor,  // createDisplayColor().updateDisplayColor
    Utils,
    logger,
  } = deps

  // ---------------------------------------------------------------------------
  // Canonical state (per monitor)
  // ---------------------------------------------------------------------------
  // monitorId -> { brightness, softwareDim, warmth, highlightCompression }
  const canonical = {}

  function getCanonical(monitorId) {
    return canonical[monitorId] || { brightness: 100, softwareDim: 0, warmth: 6500, highlightCompression: 0 }
  }

  // ---------------------------------------------------------------------------
  // Dim offsets (per monitor)
  // ---------------------------------------------------------------------------
  // monitorId -> { idle: number, inactive: number }
  const offsets = {}

  function getOffsets(monitorId) {
    return offsets[monitorId] || { idle: 0, inactive: 0 }
  }

  // commanded brightness = canonical.brightness - max(idleOffset, inactiveOffset)
  function computeCommandedBrightness(monitorId) {
    const c = getCanonical(monitorId)
    const o = getOffsets(monitorId)
    return Utils.minMax(c.brightness - Math.max(o.idle, o.inactive))
  }

  function activeGhostSource(monitorId) {
    const o = getOffsets(monitorId)
    if (o.idle === 0 && o.inactive === 0) return null
    return (o.idle >= o.inactive) ? 'idle' : 'inactive'
  }

  // ---------------------------------------------------------------------------
  // Monitor object sync (keeps renderer state accurate via monitors-updated)
  // ---------------------------------------------------------------------------
  function syncMonitorObject(monitorId) {
    const monitor = findMonitor(monitorId)
    if (!monitor) return
    const c = getCanonical(monitorId)
    const commanded = computeCommandedBrightness(monitorId)
    const ghost = activeGhostSource(monitorId)

    monitor.brightness = commanded
    monitor.canonicalBrightness = c.brightness
    monitor.ghostMarkerActive = ghost !== null
    monitor.ghostMarkerSource = ghost  // 'idle' | 'inactive' | null

    if (ghost === 'inactive') {
      monitor.inactiveDimmed = true
      monitor.preDimBrightness = c.brightness
    }
  }

  // ---------------------------------------------------------------------------
  // DDC dispatch (depth-1 queue per monitor, timer-based)
  // ---------------------------------------------------------------------------
  // monitorId -> { inFlight: bool, pendingValue: number|null, timer: any }
  const ddcQueues = {}

  function getDDCQueue(monitorId) {
    if (!ddcQueues[monitorId]) ddcQueues[monitorId] = { inFlight: false, pendingValue: null, timer: null }
    return ddcQueues[monitorId]
  }

  function sendDDCCommand(monitor, level) {
    if (settings.hideDisplays?.[monitor.key] === true) return
    if (shouldSkipDisplay(monitor)) return

    const useCap = true
    const sdrMode = monitor.hdr === 'active' && settings.sdrAsMainSliderDisplays?.[monitor.key]

    if (sdrMode) {
      monitor.sdrLevel = level
      monitor.brightness = level
      monitorsThread.send({ type: 'sdr', brightness: level, id: monitor.id })
      return
    }

    const normalized = Utils.normalizeBrightness(level, false, monitor.min ?? 0, monitor.max ?? 100, monitor.calibration ?? [])
    monitor.brightnessRaw = normalized

    if (monitor.type === 'ddcci' || monitor.type === 'studio-display') {
      monitorsThread.send({
        type: 'brightness',
        brightness: normalized * ((monitor.brightnessMax || 100) / 100),
        id: monitor.id
      })
      logger.debug(`[brightnessCtrl] DDC [${logger.shortId(monitor.id)}] → ${level}%`)

      // Dispatch linked VCP features that follow brightness
      const featuresSettings = settings.monitorFeaturesSettings?.[monitor.hwid?.[1]]
      if (featuresSettings) {
        for (const vcp in monitor.features) {
          if (!featuresSettings[vcp]?.linked) continue
          if (!settings.monitorFeatures?.[monitor.hwid[1]]?.[vcp]) continue
          const maxVisual = featuresSettings[vcp].maxVisual ?? 100
          const clampedLevel = Math.min(level, maxVisual)
          const vcpNorm = parseInt(Utils.normalizeBrightness(clampedLevel, true, 0, maxVisual))
          monitorsThread.send({ type: 'vcp', monitor: monitor.hwid.join('#'), code: parseInt(vcp), value: vcpNorm })
        }
      }
    } else if (monitor.type === 'wmi') {
      // Suppress incoming WMI brightness events while we're writing so we don't
      // echo our own command back as an external change.
      store.update('monitors', { ignoreBrightnessEvent: true })
      monitorsThread.send({ type: 'brightness', brightness: normalized })
      setTimeout(() => store.update('monitors', { ignoreBrightnessEvent: false }), 500)
      logger.debug(`[brightnessCtrl] WMI → ${level}%`)
    }
  }

  function flushPending(monitorId) {
    const q = getDDCQueue(monitorId)
    q.inFlight = false
    q.timer = null
    if (q.pendingValue === null) return
    const level = q.pendingValue
    q.pendingValue = null
    const monitor = findMonitor(monitorId)
    if (monitor) {
      q.inFlight = true
      sendDDCCommand(monitor, level)
      q.timer = setTimeout(() => flushPending(monitorId), settings.updateInterval || 50)
    }
  }

  function enqueueDDC(monitorId, level) {
    if (store.get('idle').isWindowsUserIdle) return
    const monitor = findMonitor(monitorId)
    if (!monitor || monitor.type === 'none') return

    const q = getDDCQueue(monitorId)
    if (q.inFlight) {
      q.pendingValue = level  // last-write-wins; stale intermediate values dropped
      return
    }
    q.inFlight = true
    sendDDCCommand(monitor, level)
    q.timer = setTimeout(() => flushPending(monitorId), settings.updateInterval || 50)
  }

  // ---------------------------------------------------------------------------
  // Animation engine (single tick loop, per-(monitor, property) tracks)
  // ---------------------------------------------------------------------------
  // key: `${monitorId}:${property}` -> track object
  const animTracks = {}
  let tickHandle = null
  // Per-monitor last commanded brightness (to skip no-op pushes)
  const lastCommandedBrightness = {}

  function startTick() {
    if (!tickHandle) tickHandle = setInterval(tick, TICK_MS)
  }

  function stopTick() {
    if (tickHandle) { clearInterval(tickHandle); tickHandle = null }
  }

  function tick() {
    const now = Date.now()
    let anyActive = false
    let anyChanged = false
    const changedMonitors = new Set()

    for (const key in animTracks) {
      const track = animTracks[key]
      const elapsed = now - track.startTime
      const progress = track.durationMs > 0 ? Math.min(1, elapsed / track.durationMs) : 1
      const value = track.startValue + (track.targetValue - track.startValue) * progress

      applyTrackValue(track.monitorId, track.property, value)
      changedMonitors.add(track.monitorId)

      if (progress >= 1) {
        delete animTracks[key]
      } else {
        anyActive = true
      }
    }

    for (const monitorId of changedMonitors) {
      const commanded = computeCommandedBrightness(monitorId)
      if (lastCommandedBrightness[monitorId] !== commanded) {
        lastCommandedBrightness[monitorId] = commanded
        syncMonitorObject(monitorId)
        enqueueDDC(monitorId, commanded)
        anyChanged = true
      } else {
        // Non-brightness property animated (softwareDim/warmth/highlight) — still
        // need to push monitors-updated so renderer reflects the change.
        anyChanged = true
      }
    }

    if (anyChanged) {
      touchMonitors()
      setTrayStatus()
    }

    if (!anyActive) {
      stopTick()
      if (anyChanged) updateKnownDisplays()
    }
  }

  function applyTrackValue(monitorId, property, value) {
    switch (property) {
      case 'canonical.brightness':
        canonical[monitorId] = { ...getCanonical(monitorId), brightness: value }
        break
      case 'canonical.softwareDim':
        canonical[monitorId] = { ...getCanonical(monitorId), softwareDim: value }
        updateSoftwareDim(monitorId, value)
        break
      case 'canonical.warmth':
        canonical[monitorId] = { ...getCanonical(monitorId), warmth: value }
        updateDisplayColor(monitorId, { kelvin: value })
        break
      case 'canonical.highlightCompression':
        canonical[monitorId] = { ...getCanonical(monitorId), highlightCompression: value }
        updateDisplayColor(monitorId, { highlightWeight: value })
        break
      case 'idleOffset':
        offsets[monitorId] = { ...getOffsets(monitorId), idle: Math.max(0, value) }
        break
      case 'inactiveOffset':
        offsets[monitorId] = { ...getOffsets(monitorId), inactive: Math.max(0, value) }
        break
      default:
        logger.debug(`[brightnessCtrl] unknown animatable property: ${property}`)
    }
  }

  function currentTrackValue(monitorId, property) {
    switch (property) {
      case 'canonical.brightness':        return getCanonical(monitorId).brightness
      case 'canonical.softwareDim':       return getCanonical(monitorId).softwareDim
      case 'canonical.warmth':            return getCanonical(monitorId).warmth
      case 'canonical.highlightCompression': return getCanonical(monitorId).highlightCompression
      case 'idleOffset':                  return getOffsets(monitorId).idle
      case 'inactiveOffset':              return getOffsets(monitorId).inactive
      default: return 0
    }
  }

  // ---------------------------------------------------------------------------
  // Helper
  // ---------------------------------------------------------------------------
  function findMonitor(monitorId) {
    const vals = Object.values(monitors)
    for (let i = 0; i < vals.length; i++) {
      if (vals[i].id === monitorId) return vals[i]
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function setCanonical(monitorId, newSettings, source) {
    // Cancel in-flight animations for any property being explicitly set.
    for (const prop of Object.keys(newSettings)) {
      delete animTracks[`${monitorId}:canonical.${prop}`]
    }
    if (source === 'manual') {
      delete animTracks[`${monitorId}:idleOffset`]
      delete animTracks[`${monitorId}:inactiveOffset`]
    }

    canonical[monitorId] = { ...getCanonical(monitorId), ...newSettings }

    if (source === 'manual') {
      offsets[monitorId] = { idle: 0, inactive: 0 }
    }

    const commanded = computeCommandedBrightness(monitorId)
    syncMonitorObject(monitorId)
    lastCommandedBrightness[monitorId] = commanded
    enqueueDDC(monitorId, commanded)

    if (newSettings.softwareDim !== undefined)        updateSoftwareDim(monitorId, newSettings.softwareDim)
    if (newSettings.warmth !== undefined)             updateDisplayColor(monitorId, { kelvin: newSettings.warmth })
    if (newSettings.highlightCompression !== undefined) updateDisplayColor(monitorId, { highlightWeight: newSettings.highlightCompression })

    touchMonitors()
    setTrayStatus()
    updateKnownDisplays()
  }

  // Atomic group update — one monitors-updated push covers all monitors, DDC
  // dispatched per-monitor via depth-1 queue.
  function setCanonicalGroup(monitorIds, newSettings, source) {
    for (const monitorId of monitorIds) {
      canonical[monitorId] = { ...getCanonical(monitorId), ...newSettings }

      if (source === 'manual') {
        offsets[monitorId] = { idle: 0, inactive: 0 }
      }

      const commanded = computeCommandedBrightness(monitorId)
      syncMonitorObject(monitorId)
      lastCommandedBrightness[monitorId] = commanded
      enqueueDDC(monitorId, commanded)

      if (newSettings.softwareDim !== undefined)        updateSoftwareDim(monitorId, newSettings.softwareDim)
      if (newSettings.warmth !== undefined)             updateDisplayColor(monitorId, { kelvin: newSettings.warmth })
      if (newSettings.highlightCompression !== undefined) updateDisplayColor(monitorId, { highlightWeight: newSettings.highlightCompression })
    }
    touchMonitors()
    setTrayStatus()
    updateKnownDisplays()
  }

  function setDimOffset(monitorId, type, value) {
    delete animTracks[`${monitorId}:${type}Offset`]
    offsets[monitorId] = { ...getOffsets(monitorId), [type]: Math.max(0, value) }
    const commanded = computeCommandedBrightness(monitorId)
    syncMonitorObject(monitorId)
    lastCommandedBrightness[monitorId] = commanded
    enqueueDDC(monitorId, commanded)
    touchMonitors()
  }

  function clearDimOffset(monitorId, type) {
    setDimOffset(monitorId, type, 0)
  }

  function animateTo(monitorId, property, targetValue, durationMs) {
    if (!canonical[monitorId]) {
      logger.debug(`[brightnessCtrl] animateTo skipped — no canonical for ${logger.shortId(monitorId)}`)
      return
    }

    const key = `${monitorId}:${property}`

    if (durationMs <= 0) {
      applyTrackValue(monitorId, property, targetValue)
      const commanded = computeCommandedBrightness(monitorId)
      syncMonitorObject(monitorId)
      lastCommandedBrightness[monitorId] = commanded
      enqueueDDC(monitorId, commanded)
      touchMonitors()
      setTrayStatus()
      updateKnownDisplays()
      return
    }

    // Cancel any prior animation on this track by overwriting it.
    animTracks[key] = {
      monitorId,
      property,
      startValue: currentTrackValue(monitorId, property),
      targetValue,
      startTime: Date.now(),
      durationMs,
    }

    startTick()
  }

  // Seed canonical from persisted/discovered monitor data (called at startup and
  // on first refreshMonitors reconciliation). Does not dispatch DDC or push
  // monitors-updated — caller handles that after all monitors are seeded.
  function initFromMonitor(monitorId, values) {
    canonical[monitorId] = {
      brightness:            values.brightness            ?? 100,
      softwareDim:           values.softwareDim           ?? 0,
      warmth:                values.warmth                ?? 6500,
      highlightCompression:  values.highlightCompression  ?? 0,
    }
    offsets[monitorId] = { idle: 0, inactive: 0 }
    lastCommandedBrightness[monitorId] = canonical[monitorId].brightness
  }

  return {
    setCanonical,
    setCanonicalGroup,
    setDimOffset,
    clearDimOffset,
    animateTo,
    initFromMonitor,
    // Read-only access for callers that need to query state
    getCanonical,
    getCommandedBrightness: computeCommandedBrightness,
    hasCanonical: (monitorId) => canonical[monitorId] !== undefined,
    isDimmed: (monitorId) => {
      const o = getOffsets(monitorId)
      return o.idle > 0 || o.inactive > 0
    },
    getGhostSource: activeGhostSource,
  }
}

module.exports = { createBrightnessController }
