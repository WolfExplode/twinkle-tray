// Software-dim overlays, extracted from electron.js. Owns the per-monitor
// black always-on-top BrowserWindow overlays that fake a sub-zero brightness
// floor on panels that can't dim further over DDC/CI, plus the per-monitor
// level map that backs them.
//
// Dependencies are injected via createSoftwareDim(deps) (same pattern as the
// other extracted subsystems). The level map lives in the store's "color"
// slice; this module seeds it and hands back a stable alias so electron.js can
// keep passing the same reference to the monitor-focus controller.

function createSoftwareDim(deps) {
  const {
    BrowserWindow,
    screen,
    store,
    monitors,
    MonitorTransforms,
    logger,
  } = deps

  // overlay BrowserWindow handles (mechanism, not state)
  const softwareDimOverlays = {}
  // Software-dim levels per monitor — an entity value on the "color" slice (see
  // state/store.js): a live, mutate-in-place map.
  store.update("color", { softwareDimLevels: {} })
  const softwareDimLevels = store.ref("color", "softwareDimLevels")

  function getSoftwareDimDisplayBounds(monitorId) {
    const pair = MonitorTransforms.pairDisplaysToMonitors(screen.getAllDisplays(), monitors)
      .find(p => p.monitor?.id === monitorId)
    return pair ? pair.display.bounds : null
  }

  function updateSoftwareDim(monitorId, level) {
    level = Math.max(0, Math.min(100, level))
    softwareDimLevels[monitorId] = level
    for (const key in monitors) {
      if (monitors[key].id === monitorId) {
        monitors[key].softwareDim = level
        break
      }
    }

    if (store.get("idle").isWindowsUserIdle) {
      logger?.debug(`[softwareDim][diag] updateSoftwareDim(${monitorId}, ${level}) — skipped: isWindowsUserIdle`)
      return
    }

    if (level === 0) {
      if (softwareDimOverlays[monitorId] && !softwareDimOverlays[monitorId].isDestroyed()) {
        softwareDimOverlays[monitorId].hide()
      }
      return
    }

    const bounds = getSoftwareDimDisplayBounds(monitorId)
    logger?.debug(`[softwareDim][diag] updateSoftwareDim(${monitorId}, ${level}) — bounds=${JSON.stringify(bounds)}`)
    if (!bounds) return

    if (!softwareDimOverlays[monitorId] || softwareDimOverlays[monitorId].isDestroyed()) {
      const win = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        backgroundColor: '#000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focusable: false,
        hasShadow: false,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          devTools: false
        }
      })
      win.setIgnoreMouseEvents(true)
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setOpacity(level / 100)
      win.showInactive()
      win.loadURL('data:text/html,<body style="background:#000;margin:0"></body>')
      softwareDimOverlays[monitorId] = win
    } else {
      softwareDimOverlays[monitorId].setBounds(bounds)
      softwareDimOverlays[monitorId].setOpacity(level / 100)
      if (!softwareDimOverlays[monitorId].isVisible()) {
        softwareDimOverlays[monitorId].showInactive()
      }
    }
  }

  function showSoftwareDimOverlays() {
    for (const id in softwareDimLevels) {
      if (softwareDimLevels[id] > 0) {
        updateSoftwareDim(id, softwareDimLevels[id])
      }
    }
  }

  return {
    softwareDimLevels,
    updateSoftwareDim,
    showSoftwareDimOverlays
  }
}

module.exports = { createSoftwareDim }
