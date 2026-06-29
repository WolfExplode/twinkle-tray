# ADR 0002 — BrightnessController as Single Synchronous Gatekeeper

**Status:** Accepted  
**Date:** 2026-06-28

## Context

The Electron main process is single-threaded. The race conditions in this codebase are not true thread races — they are event interleaving bugs:

- Multiple IPC handlers (update-brightness, update-software-dim, update-warmth) can fire in sequence and each partially mutate shared `monitors` state before the next one reads it.
- Timer callbacks (16ms transition loops, debounce timeouts) interleave with IPC handlers mid-async-chain.
- DDC commands run in a worker thread and complete out of order relative to the values that were queued.

The previous approach used module-level variables (`updateBrightnessQueue`, `updateBrightnessTimeout`, `ignoreBrightnessEventTimeout`, `currentTransition`) modified from many call sites, creating fragile implicit ordering.

## Decision

Introduce a `BrightnessController` module that is the sole writer of canonical brightness and the sole dispatcher of DDC commands. Key properties:

- **Synchronous canonical writes** — setting canonical settings is a single synchronous operation (leverages JS single-thread guarantee; no interleaving possible within one event loop tick). All axes (DDC brightness, software dim, warmth, highlight compression, future settings) are updated together in one call, eliminating the IPC interleaving race between separate `update-brightness` / `update-software-dim` / `update-warmth` handlers.
- **Per-monitor DDC queue (depth 1)** — each monitor has at most one in-flight DDC command and one pending value. When in-flight completes, pending (if any) is sent. Intermediate values are dropped (last-write-wins).
- **No `ignoreBrightnessEventTimeout`** — WMI events write canonical like any other source; no suppression timer needed.
- **`refreshMonitors` never writes canonical** — it updates hardware metadata (capabilities, connection state) only. Canonical is initialized from persisted settings on startup, reconciled by the first hardware poll, then owned entirely by the controller.

## Consequences

- All existing call sites that write `monitor.brightness` directly must be routed through `BrightnessController`.
- The transition loop (`currentTransition`) and focus controller (`monitorFocusTransitions`) must call `BrightnessController.setDimOffset()` / `clearDimOffset()` rather than calling `updateBrightness()` directly.
- `clearDimOffset(monitorId, type)` is public — the idle system calls it when idle ends, the focus controller calls it when a monitor regains focus. `setCanonical` with source `'manual'` also calls it internally as a side effect, enforcing "manual always resets overlays" in one place.
- The depth-1 DDC queue eliminates the "slider jumps back" bug caused by stale commands landing after newer ones.
- Tests can assert controller state synchronously without timing dependencies.
- Main pushes `monitors-updated` immediately on every canonical state change. DDC dispatch rate is controlled separately by the per-monitor depth-1 queue. The UI (ghost marker, system tray, slider position) stays accurate at all times without a separate UI throttle.
- The renderer (BrightnessPanel, Slider) updates local display state optimistically on user input to avoid visible lag. Without optimistic rendering, sliders would rubber-band or stutter because the round-trip (IPC to main → DDC command → `monitors-updated` IPC back → re-render) takes 66–250ms per interaction. The renderer's optimistic state is always overwritten by the next `monitors-updated` push from main; it is never sent back to main as canonical truth.
