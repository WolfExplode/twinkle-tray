// Hotkey subsystem: registers global shortcuts and executes their actions.
//
// Extracted from electron.js. The pure decision logic (VCP code mapping, cycle
// advancement, value computation) lives in hotkeyActions.js; this module owns
// the IO and the per-hotkey runtime state (throttle, cycle position, the
// reentrancy guard) that used to be module globals in electron.js.
//
// Dependencies are injected via createHotkeyController(deps) rather than
// imported, so the subsystem has an explicit, readable contract with the rest
// of the app and can be exercised with stubs. As state migrates into the store,
// several of these (monitors, settings) collapse into `store`.

const HotkeyActions = require("./hotkeyActions")

function createHotkeyController(deps) {
  const {
    monitors,                 // live monitor map (store.get("monitors").all)
    settings,                 // live settings slice (store.get("settings"))
    store,
    logger,
    globalShortcut,
    getLastRefreshMonitors,   // () => timestamp of the last hardware refresh
    refreshMonitors,
    getVCP,
    minMax,
    touchMonitors,
    updateBrightnessThrottle,
    pauseMonitorUpdates,
    writeSettings,
    sleepDisplays,
    setRecentlyInteracted,
    hotkeyOverlayStart,
    sendToAllWindows
  } = deps

  // Per-hotkey runtime state, scoped to this controller.
  const hotkeyThrottle = []
  const hotkeyCycleIndexes = []
  let doingHotkey = false

  async function doHotkey(hotkey) {
    const now = Date.now()
    if (!doingHotkey && (hotkeyThrottle[hotkey.id] === undefined || now > hotkeyThrottle[hotkey.id] + 100)) {

      if (!hotkey.actions?.length) return false;

      hotkeyThrottle[hotkey.id] = now
      let showOverlay = false
      doingHotkey = true
      setRecentlyInteracted(true)

      // First let's figure out where we're at in the cycle, if applicable

      let hasCheckedFirstCycleAction = false

      for (const action of hotkey.actions) {
        try {

          // Wait for refresh if user hasn't done so recently
          if (action.type !== "refresh" && getLastRefreshMonitors() < Date.now() - 10000) {
            await refreshMonitors()
          }

          if (action.type === "off") {
            showOverlay = false
            sleepDisplays(settings.sleepAction, 500)
          } else if (action.type === "refresh") {
            showOverlay = false
            await refreshMonitors(true, true)
          } else if (action.type === "set" || action.type === "offset" || action.type === "cycle") {

            // Build list of all applicable monitors
            const hotkeyMonitors = []

            // Determine applicable monitors and new values
            for (const monitor of Object.values(monitors)) {

              let applicable = false
              if (action.allMonitors || (settings.linkedLevelsActive && !settings.hotkeysBreakLinkedLevels)) {
                // Target all monitors
                applicable = true
              } else if (Object.keys(action.monitors)?.length && action.monitors[monitor.id]) {
                // Target specified monitors
                applicable = true
              }

              if (applicable) {
                // Determine new value
                let newValue = 0

                if (action.type === "offset") {
                  let currentValue = 0
                  if (action.target === "brightness") {
                    currentValue = monitor.brightness
                  } else if (action.target === "sdr") {
                    currentValue = monitor.sdrLevel ?? 0
                  } else {
                    currentValue = await getVCP(monitor, HotkeyActions.vcpCodeForTarget(action.target, "read"))
                  }
                  newValue = HotkeyActions.computeNewValue({ type: "offset", currentValue, value: action.value })
                } else if (action.type === "cycle") {
                  if (!action.values?.length) return -1;

                  // Advance to the next value on the first "cycle" action of this press
                  if (!hasCheckedFirstCycleAction) {
                    hasCheckedFirstCycleAction = true
                    hotkeyCycleIndexes[hotkey.id] = HotkeyActions.advanceCycleIndex(hotkeyCycleIndexes[hotkey.id], action.values.length)
                  } else if (!hotkeyCycleIndexes[hotkey.id]) {
                    hotkeyCycleIndexes[hotkey.id] = 0
                  }

                  newValue = HotkeyActions.computeNewValue({ type: "cycle", values: action.values, cycleIndex: hotkeyCycleIndexes[hotkey.id] })
                } else if (action.type === "set") {
                  newValue = HotkeyActions.computeNewValue({ type: "set", value: action.value })
                }

                hotkeyMonitors.push({
                  monitor,
                  value: newValue
                })
              }

            }

            // Apply change
            if (hotkeyMonitors?.length) {
              for (const hotkeyMonitor of hotkeyMonitors) {
                const { monitor, value } = hotkeyMonitor
                if (action.target === "brightness") {
                  const normalizedAdjust = minMax(value)
                  monitors[monitor.key].brightness = normalizedAdjust
                  touchMonitors();
                  updateBrightnessThrottle(monitor.id, monitors[monitor.key].brightness, true, false)
                  pauseMonitorUpdates() // Stop incoming updates for a moment to prevent judder

                  // Break linked levels
                  if (settings.hotkeysBreakLinkedLevels && settings.linkedLevelsActive) {
                    logger.debug("Breaking linked levels due to hotkey.")
                    writeSettings({ linkedLevelsActive: false })
                  }
                  showOverlay = true
                } else if(action.target === "sdr") {
                  updateBrightnessThrottle(monitor.id, parseInt(value), false, true, "sdr")
                } else {
                  updateBrightnessThrottle(monitor.id, parseInt(value), false, true, HotkeyActions.vcpCodeForTarget(action.target, "write"))
                  touchMonitors();
                }
              }
            }

          }


          // Show brightness overlay, if applicable
          // If panel isn't open, use the overlay
          if (showOverlay && store.get("panel").panelState !== "visible") {
            hotkeyOverlayStart(undefined, true)
          }

        } catch (e) {
          logger.debug("HOTKEY ERROR:", e)
        }
      }

      doingHotkey = false
    }
  }

  function applyHotkeys(monitorList = monitors) {
    try {
      if (settings.hotkeys !== undefined && settings.hotkeys?.length) {
        globalShortcut.unregisterAll()
        for (const hotkey of settings.hotkeys) {
          try {
            // Only apply if found/valid
            if (hotkey.accelerator) {
              hotkey.active = globalShortcut.register(hotkey.accelerator, () => {
                doHotkey(hotkey)
              })
            }
          } catch (e) {
            // Couldn't register hotkey
          }

        }
      }
    } catch(e) {
      logger.debug("Couldn't apply hotkeys:", e)
    }
    sendToAllWindows('settings-updated', settings)
  }

  return { doHotkey, applyHotkeys }
}

module.exports = { createHotkeyController }
