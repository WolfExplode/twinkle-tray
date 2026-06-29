# ADR 0001 — Brightness Control Hierarchy and Canonical State

**Status:** Accepted  
**Date:** 2026-06-28

## Context

Multiple subsystems write monitor brightness independently: the manual tray slider, time-based schedules, idle dimming, and inactive-monitor dimming. Without a defined hierarchy, concurrent writes produce race conditions — the last writer wins, which is not always the intended writer.

## Decision

There is one canonical brightness per monitor. The hierarchy of who may write it:

1. **Schedule** (when active) — sole writer; UI locks out manual changes by design.
2. **Manual slider** — writes canonical brightness when no schedule is active; also cancels idle and inactive-monitor dimming.
3. **Idle dimming** and **Inactive monitor dimming** — never write canonical brightness; they apply a transient dim offset on top of it and restore to it when cleared.

Manual slider interaction always resets idle/inactive dimming, even if those modes are enabled. The canonical value is always what gets persisted and restored.

## Consequences

- A `BrightnessController` (or equivalent) must gate all writes and enforce this hierarchy.
- `refreshMonitors` (hardware poll) must not overwrite canonical brightness while an in-flight update exists.
- Idle/inactive dimming must store a `dimOffset`, not a replacement brightness, so they never corrupt canonical state.
- When both idle and inactive-monitor dimming are active simultaneously: `commanded = canonical − max(idleOffset, inactiveOffset)`. Offsets are not stacked additively.
- Ghost marker must appear for both idle and inactive-monitor dimming (idle ghost marker is currently unimplemented).
- Tests must verify that manual slider input while idle-dimmed produces: canonical updated + dim offset cleared.
