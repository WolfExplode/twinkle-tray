# ADR 0004 — Sequential Inactive-Dim Animation to Avoid MPO Flicker

**Status:** Accepted  
**Date:** 2026-06-28

## Context

When inactive-monitor dimming animates DDC brightness (via `inactiveOffset`) and the software-dim overlay (via `inactiveSoftwareDim`) simultaneously, the screen stutters with a random, noise-like flickering pattern. The flickering is not a monotonic staircase — it appears as brightness oscillating unpredictably during the transition.

### Root cause: Multi-Plane Overlay (MPO)

Windows and NVIDIA/AMD drivers use MPO to render multiple display layers on separate GPU planes without first compositing them into a single frame. When a DDC brightness change and a compositor overlay opacity animation happen at the same time, MPO must handle two independent timing domains:

- **Overlay plane**: driven by GPU frame cadence (typically 60 Hz)
- **DDC command**: driven by the monitor's I²C bus, processed by monitor firmware asynchronously

These two domains do not share a clock boundary. MPO cannot synchronize them, so frames are presented where the overlay opacity and the panel brightness are at mismatched intermediate values. The result is the observed non-deterministic stutter.

This was confirmed empirically: running the same transition sequentially (hardware first, software second) eliminated the flickering entirely.

### Why not disable MPO?

MPO is a system-wide GPU driver setting. It would be inappropriate for a brightness utility to modify global display driver behavior on the user's system. The fix must be entirely within the animation strategy.

## Decision

Inactive-monitor dimming runs hardware and software dim **sequentially**, not in parallel:

1. **Phase 1 — hardware**: `inactiveOffset` animates over the first half of `durationMs`. DDC commands are dispatched; no overlay animation occurs.
2. **Phase 2 — software**: `inactiveSoftwareDim` animates over the second half of `durationMs`, starting only after Phase 1 completes.

This is implemented by passing `startDelay: hardwareDuration` to `animateTo` for the `inactiveSoftwareDim` track.

### Timing split: 50/50

The "correct" split would allocate time proportionally to the perceptual contribution of each phase — but there is no reliable way to compute this. Hardware DDC brightness and software overlay opacity operate on different physical mechanisms (backlight dimming vs. GPU compositor alpha). The perceptual relationship between them varies by monitor brand, panel type, and firmware.

A 50/50 split (each phase gets `durationMs / 2`) is chosen as a pragmatic default. The overall transition will not appear perfectly linear — there will be a perceptible "step" where the rate of change shifts between phases — but this is unavoidable without per-monitor calibration data that does not exist.

### When software dim is not configured

If `targetSoftwareDim === 0`, no Phase 2 exists. Hardware animation uses the full `durationMs`. No timing split occurs.

## Consequences

- `BrightnessController.animateTo` gains an optional `startDelay` parameter. The tick loop skips tracks whose `startTime` is in the future. Cancellation via `clearDimOffset` works unchanged — deleting the track from `animTracks` cancels it regardless of whether the delay has elapsed.
- `computeTransitionStep` in `monitorFocus.js` is removed. It modelled a combined-axis proportional split that is invalid for the reasons above.
- The transition will not appear perceptually linear when both phases apply. This is a known, accepted trade-off.
