# ADR 0003 — Unified Animation Engine for Brightness Transitions

**Status:** Accepted  
**Date:** 2026-06-28

## Context

Three separate systems currently drive brightness transitions via independent `setInterval` loops:
- Schedule (`currentTransition`) — fades canonical brightness between time blocks
- Idle dimming — fades dim offset down when system goes idle
- Inactive monitor (`monitorFocusTransitions`) — fades dim offset down when monitor loses focus

Each loop holds a module-level interval handle. Concurrent transitions on the same monitor cause stale intervals to keep running after a new one starts, producing additive or fighting animations. Cancellation is fragile — the handle must be cleared by the right caller, but multiple callers share the same variable.

## Decision

`BrightnessController` owns a single unified animation engine. Each animatable property on each monitor gets an independent **animation track**. One controller tick loop advances all active tracks, recomputes commanded brightness, pushes `monitors-updated`, and dispatches DDC.

### Animatable properties (per monitor)
- `canonical.brightness`
- `canonical.softwareDim`
- `canonical.warmth`
- `canonical.highlightCompression`
- `idleOffset`
- `inactiveOffset`
- *(future per-monitor settings added here)*

### Commanded brightness derivation (computed each tick, never stored directly)
```
commanded.brightness = canonical.brightness - max(idleOffset, inactiveOffset)
```

### API
```js
controller.animateTo(monitorId, property, targetValue, durationMs)
// Starting a new animation on the same (monitorId, property) pair cancels the previous one.
// durationMs = 0 → instant (no tick needed, synchronous update).
```

### Easing
All transitions use **linear** interpolation. Non-linear easing deferred — not enough user-visible benefit to justify complexity now.

## Consequences

- No module-level interval handles outside `BrightnessController`. Schedule, idle system, and focus controller all call `animateTo` and forget.
- Schedule and idle fade-in can run simultaneously on independent tracks with zero interference.
- Cancellation is automatic: new `animateTo` on same track replaces the old one.
- The tick loop starts when any track becomes active and stops itself when all tracks settle — no polling when idle.
- `monitors-updated` is pushed each tick only if commanded state actually changed (avoids no-op re-renders during idle periods).
- Future easing-per-track is additive (just pass an `easing` param to `animateTo`) — no architectural change needed.
