// React hooks over settingsApi, for the function-component settings pages.
//
// The settings pages extracted from SettingsWindow each need two things: to read
// current settings/monitors, and to react to the bridge's CustomEvents without
// hand-wiring addEventListener/removeEventListener (a leak waiting to happen).
// These hooks give them both, built on settingsApi so they never touch `window`.

import { useEffect, useState } from 'react'
import { subscribe, getSettings, getMonitors } from './settingsApi'

// Subscribe to a bridge CustomEvent for the lifetime of the component. The
// handler is re-subscribed when `deps` change; otherwise it's wired once and
// torn down on unmount. Mirrors the unsubscribe contract of settingsApi.subscribe.
export function useSettingsEvent(eventName, handler, deps = []) {
  useEffect(() => {
    const unsubscribe = subscribe(eventName, handler)
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

// Current settings object, kept live: seeds from the bridge and updates whenever
// a `settingsUpdated` event fires.
export function useSettings() {
  const [settings, setSettings] = useState(getSettings)
  useSettingsEvent('settingsUpdated', (detail) => setSettings(detail || getSettings()))
  return settings
}

// Current monitors, kept live off `monitorsUpdated`.
export function useMonitors() {
  const [monitors, setMonitors] = useState(getMonitors)
  useSettingsEvent('monitorsUpdated', (detail) => setMonitors(detail || getMonitors()))
  return monitors
}
