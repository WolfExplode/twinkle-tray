// Consumer-facing settings bridge for renderer components.
//
// settingsBridge.js is the *producer*: it wires IPC and publishes functions and
// state onto `window`. Components historically read those back by reaching into
// `window.*` (and bare globals) directly — 50-plus scattered sites that couple
// every page to the global object and make isolated testing impossible.
//
// This module is the *consumer* seam: one named-export surface over that same
// window bridge. Components import from here instead of touching `window`, so
// the coupling lives in one file and tests stub one place. It deliberately reads
// `window` lazily on each call (never caches) so it sees whatever the producer
// last published.

// --- Actions (fire-and-forget to the main process) ---

export function sendSettings(newSettings = {}) {
  window.sendSettings(newSettings)
}

export function sendSettingsImmediate(newSettings = {}) {
  window.sendSettingsImmediate(newSettings)
}

export function requestSettings() {
  window.requestSettings()
}

export function resetSettings() {
  window.resetSettings()
}

export function requestMonitors(fullRefresh = false) {
  window.requestMonitors(fullRefresh)
}

export function reloadReactMonitors() {
  window.reloadReactMonitors()
}

export function updateBrightness(index, level) {
  window.updateBrightness(index, level)
}

export function checkForUpdates() {
  window.checkForUpdates()
}

export function getUpdate() {
  window.getUpdate()
}

export function openURL(url) {
  window.openURL(url)
}

// --- Reads (snapshot of producer-published state) ---

export function getSettings() {
  return window.settings || {}
}

export function getMonitors() {
  return window.allMonitors || []
}

export function getAccent() {
  return window.accent
}

export function getSunCalcTimes(lat, long) {
  return window.getSunCalcTimes(lat, long)
}

export function getAppInfo() {
  return {
    version: window.version,
    versionTag: window.versionTag,
    versionBuild: window.versionBuild,
    isAppX: window.isAppX,
    settingsPath: window.settingsPath
  }
}

// --- Events (CustomEvents the producer dispatches on `window`) ---
//
// subscribe returns an unsubscribe function — pair it with cleanup so listeners
// don't leak when a page unmounts. Handlers receive the CustomEvent's `detail`.

export function subscribe(eventName, handler) {
  const listener = (e) => handler(e.detail, e)
  window.addEventListener(eventName, listener)
  return () => window.removeEventListener(eventName, listener)
}

// Named subscriptions for the events the settings window cares about. Each is a
// thin wrapper over subscribe() so callers don't pass magic event-name strings.
export const onSettingsUpdated = (handler) => subscribe('settingsUpdated', handler)
export const onMonitorsUpdated = (handler) => subscribe('monitorsUpdated', handler)
export const onLocalizationUpdated = (handler) => subscribe('localizationUpdated', handler)
export const onWindowHistory = (handler) => subscribe('windowHistory', handler)
export const onUpdateUpdated = (handler) => subscribe('updateUpdated', handler)
export const onUpdateProgress = (handler) => subscribe('updateProgress', handler)
