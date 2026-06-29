# Implementation TODO — Race Condition Elimination

Decisions documented in ADR 0001, 0002, 0003 and CONTEXT.md.

---

## 1. BrightnessController module (new file)

- [ ] Implement `BrightnessController` as sole writer of canonical settings per monitor
- [ ] Per-monitor canonical settings bundle: `{ brightness, softwareDim, warmth, highlightCompression }`
- [ ] Per-monitor dim offsets: `{ idle, inactive }`
- [ ] Commanded brightness derivation: `canonical.brightness - max(idleOffset, inactiveOffset)`
- [ ] Public API:
  - `setCanonical(monitorId, settings, source)` — source: `'manual' | 'schedule' | 'wmi'`; `'manual'` auto-clears all dim offsets
  - `setDimOffset(monitorId, type, offset)` — type: `'idle' | 'inactive'`
  - `clearDimOffset(monitorId, type)` — public; called by idle system and focus controller directly
  - `animateTo(monitorId, property, targetValue, durationMs)` — cancels prior animation on same track
- [ ] Unified animation engine: single tick loop, per-(monitor, property) tracks, linear interpolation
- [ ] Tick loop self-starts when tracks become active, self-stops when all tracks settle
- [ ] Push `monitors-updated` each tick only when commanded state actually changed

## 2. DDC depth-1 queue (inside BrightnessController)

- [ ] Per-monitor: at most one in-flight DDC command + one pending value
- [ ] When in-flight completes: send pending if present, else idle
- [ ] Add request IDs to `getVCP()` calls to prevent concurrent-response mismatches (see `electron.js:282`)

## 3. refreshMonitors — stop writing canonical

- [ ] Remove all `monitor.brightness` writes from `refreshMonitors` poll path
- [ ] `refreshMonitors` updates only: connection state, DDC capabilities, hardware metadata
- [ ] Startup reconciliation: load canonical from persisted settings first, then on first successful `refreshMonitors` poll, reconcile if hardware differs

## 4. WMI event handler — simplify

- [ ] Remove `ignoreBrightnessEventTimeout` entirely (root cause: optimistic writes + fragile suppression timer)
- [ ] WMI brightness event → calls `controller.setCanonical(monitorId, { brightness: value }, 'wmi')`
- [ ] No suppression needed once controller owns canonical and DDC queue handles ordering

## 5. IPC handler consolidation

- [ ] Replace separate `update-brightness`, `update-software-dim`, `update-warmth` IPC handlers with single `update-settings` handler
- [ ] Single handler calls `controller.setCanonical(monitorId, partialSettings, 'manual')`
- [ ] Eliminates IPC interleaving race between the three concurrent handlers

## 6. Schedule integration

- [ ] Schedule calls `controller.animateTo(monitorId, 'canonical.brightness', target, durationMs)` per axis
- [ ] Remove `currentTransition` module-level handle from `electron.js`
- [ ] Schedule active → UI locks sliders (existing behavior, unchanged)
- [ ] Schedule disabled → canonical stays at last schedule value (no revert to pre-schedule)

## 7. Idle dimming — offset path

- [ ] Idle fade-in: `controller.animateTo(monitorId, 'idleOffset', target, durationMs)`
- [ ] Idle restore: `controller.clearDimOffset(monitorId, 'idle')` (instant or short animated snap)
- [ ] Currently idle dimming writes canonical directly — this must be refactored to offset path

## 8. Inactive monitor dimming — offset path

- [ ] Already uses offset concept; wire to `controller.animateTo(monitorId, 'inactiveOffset', target, durationMs)`
- [ ] Restore: `controller.clearDimOffset(monitorId, 'inactive')`
- [ ] Remove `monitorFocusTransitions` module-level map from `monitorFocusController.js`

## 9. Renderer (BrightnessPanel, Slider)

- [ ] Remove optimistic writes to `monitors[idx].brightness` as source-of-truth
- [ ] Renderer keeps ephemeral display state for smooth slider feel (optimistic display only)
- [ ] `monitors-updated` from main always wins and overwrites renderer display state
- [ ] IPC sends user intent only: `update-settings` with `{ monitorId, brightness, softwareDim, ... }`

## 10. UI — idle dimming ghost marker

- [ ] Add ghost marker to slider for idle dimming (currently only inactive monitor shows ghost)
- [ ] Label: "overridden by idle" vs "overridden by inactive monitor"
- [ ] Ghost marker visible whenever `commanded < canonical` on any axis

## 11. Tests — race condition coverage

- [ ] Test: manual slider while idle-dimmed → canonical updated, idle offset cleared, commanded = new canonical
- [ ] Test: manual slider while inactive-dimmed → same as above for inactive offset
- [ ] Test: schedule transition mid-flight, new value arrives → only latest value reaches hardware
- [ ] Test: concurrent IPC handlers (brightness + softwareDim) → both applied atomically, no interleave
- [ ] Test: WMI event during DDC in-flight → canonical updated, stale DDC does not overwrite
- [ ] Test: `refreshMonitors` during active transition → canonical not clobbered
- [ ] Test: simultaneous idle + inactive offsets → `max()` applied, not additive
- [ ] Test: schedule disabled → canonical stays at last schedule value

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
