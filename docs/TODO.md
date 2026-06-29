# Implementation TODO — Race Condition Elimination

Decisions documented in ADR 0001, 0002, 0003 and CONTEXT.md.

**Migration strategy: Big bang.** Implement `BrightnessController` fully on a feature branch, cut over all callers at once, delete old code. App is non-functional on the branch until the cutover is complete. Items below are ordered by dependency — implement top-to-bottom.

---

## ✅ 1. BrightnessController module (new file)

- [x] Implement `BrightnessController` as sole writer of canonical settings per monitor
- [x] Per-monitor canonical settings bundle: `{ brightness, softwareDim, warmth, highlightCompression }`
- [x] Per-monitor dim offsets: `{ idle, inactive }`
- [x] Commanded brightness derivation: `canonical.brightness - max(idleOffset, inactiveOffset)`
- [x] Public API: `setCanonical`, `setCanonicalGroup`, `setDimOffset`, `clearDimOffset`, `animateTo`
- [x] Unified animation engine: single tick loop, per-(monitor, property) tracks, linear interpolation
- [x] Tick loop self-starts when tracks become active, self-stops when all tracks settle
- [x] Push `monitors-updated` each tick only when commanded state actually changed

## ✅ 2. DDC depth-1 queue (inside BrightnessController)

- [x] Per-monitor: at most one in-flight DDC command + one pending value
- [x] When in-flight completes: send pending if present, else idle

## ✅ 3. refreshMonitors — stop writing canonical

- [x] `refreshMonitors` re-stamps `monitor.brightness` from canonical after each poll
- [x] Startup reconciliation: `initFromMonitor` on first poll per monitor

## ✅ 4. WMI event handler — simplify

- [x] WMI brightness event → `controller.setCanonical(monitorId, { brightness }, 'wmi')`
- [x] Suppression timer managed by controller internally

## ✅ 5. IPC handler consolidation

- [x] `update-settings` IPC handler added (renderer target)
- [x] Old handlers kept for backward compatibility during renderer migration

## ✅ 6. Schedule integration

- [x] `transitionBrightness` replaced with per-monitor `animateTo('canonical.brightness', ...)` calls
- [x] `transitionlessBrightness` replaced with per-monitor `setCanonical(...)` calls
- [x] `currentTransition` module-level handle removed
- [x] Software dim animated simultaneously with brightness on schedule transitions

## ✅ 7. Idle dimming — offset path

- [x] Idle fade-in: `animateTo(monitorId, 'idleOffset', offset, durationMs)`
- [x] Idle restore: `clearDimOffset(monitorId, 'idle')` for each monitor
- [x] `transitionBrightness(idleBrightness, ...)` path removed

## ✅ 8. Inactive monitor dimming — offset path

- [x] `applyMonitorFocusTransition` → `animateTo(monitorId, 'inactiveOffset', offset, durationMs)`
- [x] Restore: `clearDimOffset(monitorId, 'inactive')`
- [x] `monitorFocusTransitions` map and per-monitor setInterval removed
- [x] `scheduledBrightness` tracking removed (canonical IS the schedule value)
- [x] `monitorPreDimBrightness` removed (canonical IS the pre-dim value)
- [x] Schedule now updates canonical for ALL monitors including inactive-dimmed ones

## ✅ 9. Remove pauseMonitorUpdates

- [x] `pause-updates` IPC handler removed from `electron.js`
- [x] `window.pauseMonitorUpdates()` removed from `BrightnessPanel.jsx`
- [x] `pausedMonitorUpdates` variable and function removed from `electron.js`
- [x] `refreshMonitors` gate simplified (`|| pausedMonitorUpdates` removed)

## ✅ 10. Renderer (BrightnessPanel)

- [x] `handleChange` sends `update-settings` IPC directly (brightness + softwareDim together)
- [x] `window.updateSoftwareDim` separate call removed from drag path
- [x] Optimistic brightness write kept for smooth slider display
- [x] `syncBrightness` no longer sends IPC (stub only, clears flags)

## ✅ 11. UI — idle dimming ghost marker

- [x] Add ghost marker to slider for idle dimming (currently only inactive monitor shows ghost)
- [x] Label: "overridden by idle" vs "overridden by inactive monitor"
- [x] Slider reads `monitor.canonicalBrightness` / `monitor.ghostMarkerSource` (new controller fields)

## ✅ 12. Tests — race condition coverage

- [x] Test: manual slider while idle-dimmed → canonical updated, idle offset cleared, commanded = new canonical
- [x] Test: manual slider while inactive-dimmed → same as above for inactive offset
- [x] Test: schedule transition mid-flight, new value arrives → only latest value reaches hardware
- [x] Test: concurrent IPC handlers (brightness + softwareDim) → both applied atomically, no interleave
- [x] Test: WMI event during DDC in-flight → canonical updated, stale DDC does not overwrite
- [x] Test: `refreshMonitors` during active transition → canonical not clobbered
- [x] Test: simultaneous idle + inactive offsets → `max()` applied, not additive
- [x] Test: schedule disabled → canonical stays at last schedule value
- [x] Test file location: `test/brightnessController.test.js`
- [x] Use Node built-in fake timers (`mock.timers`) to advance animation ticks without real `setInterval` waits

---

## Open questions (resolved)
- Hierarchy: manual > schedule > idle/inactive ✓ (ADR 0001)
- Concurrency model: single gatekeeper, no mutex needed (JS single-threaded) ✓ (ADR 0002)
- DDC ordering: depth-1 queue per monitor ✓ (ADR 0002)
- Stacked overlays: `max(idleOffset, inactiveOffset)` ✓ (ADR 0001)
- Schedule→disable: canonical stays at last schedule value ✓ (ADR 0001)
- WMI events: write canonical like manual ✓ (ADR 0002)
- Startup: load persisted → reconcile on first hardware poll ✓ (ADR 0002)
- Animation easing: linear for now ✓ (ADR 0003)
- `monitors-updated` push: immediate on canonical change, DDC throttled by queue ✓ (ADR 0002)
- Renderer: optimistic display only, main always wins ✓ (ADR 0002)
