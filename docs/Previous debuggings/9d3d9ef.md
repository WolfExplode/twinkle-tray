## Bug Hunt: LERP + Software Dim Flash

### Context

Previous session committed `9d3d9ef`: generalized LERP to animate all schedule settings (not just DDC brightness) — kelvin, highlight, softwareDim. This session's uncommitted changes attempted to fix a regression introduced by that feature.

---

### Issue 1: Color value mismatch (kelvin/highlight wrong after LERP tick)

**Symptom:** Log showed `highlight: 40 → 70` — LERP applied 40, but `applyCurrentDisplayColorEffects` immediately overwrote it with raw event value 70.

**Cause:** `applyCurrentDisplayColorEffects` called `getCurrentAdjustmentEvent()` (raw event, target values) independently of what the LERP tick had just applied.

**Fix applied:** Merge LERP kelvin/highlightWeight into `foundEvent` inside `applyCurrentDisplayColorEffects` when `lerpActive`.

**Status: Valid fix. Keep.**

---

### Issue 2: "New day" reset firing every tick when `animate=false`

**Symptom:** Log showed "New day (or forced)... resetting lastTimeEvent" on every tick even with animate toggled off.

**Cause:** Old reset condition was `settings.adjustmentTimeAnimate || settings.adjustmentTimeSpeed === "linear"`. If animate was turned off but speed was still stored as `"linear"`, the OR still fired.

**Fix applied:** Introduced `lerpActive = adjustmentTimeAnimate !== false && adjustmentTimeSpeed === "linear"`. Reset gated on `lerpActive`.

**Status: Valid fix. Keep.**

---

### Bug 3: Software dim overlay flash — the main bug

**Symptom:** observed by recording screen using OBS at 120 fps, 2 darker frames every ~8 seconds (background update interval) when LERP active + future schedule event has software dim. Flash appeared to show the full scheduled dim value (e.g. 70%), not the LERP interpolated value (e.g. 22%).

**Root cause (confirmed via stack trace):** `BrightnessPanel.jsx` had this guard in the `recievedMonitors` handler:

```js
if (newMonitors[key].brightness > 0 && updated[key] > 0) {
  updated[key] = 0
  window.updateSoftwareDim(newMonitors[key].id, 0)  // ← this was the culprit
}
```

Every `touchMonitors()` call (which happens inside `setCanonical` → every schedule tick) sent `monitors-updated` to the renderer. The renderer saw `brightness=15 > 0` AND `softwareDim=60 > 0` and immediately sent `update-software-dim(id, 0)` to main, resetting the overlay. Main process then hid the overlay. Next tick: overlay `prevLevel=0`, `visible=false` → `showInactive()` fired again → flash.

This guard predates LERP softwareDim. Old code never set softwareDim during LERP (only brightness), so hardware brightness and dim never coexisted, so the guard never fired. Our changes made them coexist intentionally during the 20:00→22:00 transition.

**Failed fix attempts (all red herrings):**

1. **`lastOverlayBounds` caching** — hypothesis: `SetWindowPos` (called by `setBounds`) resets layered window opacity to 100% on Windows. Disproved: `SetWindowPos` doesn't touch `WS_EX_LAYERED` attributes; position/size and opacity are separate window attributes.
2. **DDC dedup in `setCanonical`/`animateTo`** — hypothesis: unnecessary DDC writes causing hardware to re-apply. Irrelevant to software dim overlay.
3. **Gamma ramp dedup in `updateDisplayColor`** — hypothesis: unnecessary gamma writes causing flash. Irrelevant to overlay.

**Actual fix:** Remove lines 240-244 in `BrightnessPanel.jsx`. Trust `incomingDim` from main process (already the declared source of truth). The first sync block (lines 233-238) is sufficient.

**Status: Valid fix (applied). Keep.**

---

### Bug 4: Vertical monitor overlay only half-covered

**Symptom:** After removing renderer guard, vertical monitor (VTK2360, 1080×1920 portrait) overlay doesn't properly cover the screen.

**Suspected cause:** `lastOverlayBounds` caching we added prevented `setBounds` from being called after initial creation. If Electron adjusts the window position/size at creation (e.g. DPI adjustment for negative-X display), the cached bounds match future calls to `getSoftwareDimDisplayBounds` but not the actual window position. Old code always called `setBounds` on every update, which self-corrected any drift.

**Fix applied (round 1):** Reverted `softwareDim.js` to near-original — removed `lastOverlayBounds` entirely. Always call `setBounds`.

**Fix applied (round 2 — the real one):** The `prevLevel === level && win.isVisible()` early-return that was ALSO added to `updateSoftwareDim` was still present and re-introduced the same class of bug: it skips `setBounds`/`setOpacity` whenever the level is unchanged. Any display-arrangement / bounds change that arrives with the same dim level (very common: the schedule/background tick re-applies the same level every interval) then never re-covers the display → "half covered" vertical monitor and stale bounds. That early-return was a *flash-fix attempt*, NOT the actual flash fix (the real fix was the `BrightnessPanel.jsx` guard removal), so it buys nothing. **Removed it — `softwareDim.js` is now behaviourally identical to committed `9d3d9ef` (always `setBounds` + `setOpacity`), only the diagnostic log lines dropped.**

**Status: FIXED. Needs on-hardware verification of the vertical monitor + manual -70 with schedule off.**

---

### Bug 5: Overlay stuck at full scheduled value (70%) when schedule enabled

**Symptom:** Overlay shows at 70% always when schedule is enabled with a -70 event, rather than the interpolated value.

**Hypothesis:** When LERP returns `false` (e.g. only one distinct schedule event — `current === next` → `next.value === current.value` early return in `getCurrentAdjustmentEventLERP`), the LERP block is skipped. `foundEvent.softwareDim` stays as `getCurrentAdjustmentEvent().softwareDim = 70`. `eventSoftwareDim = 70` → overlay = 70% constantly. Whether this is a *bug* or correct single-event semantics depends entirely on the user's actual `adjustmentTimes` list — need ground truth.

Schedule events DO carry a first-class `softwareDim` field: the editor slider runs `softwareDimMin(-100)..100` and splits a negative value into `{brightness:0, softwareDim:70}` (see `SettingsWindow.getAdjustmentValue`). So an event set to `-70` legitimately stores `softwareDim:70`. This is NEW behaviour from `9d3d9ef` (schedule never touched software dim before), which is why it reads as a regression.

**Resolution — NOT A BUG. Correct LERP behaviour, confirmed from disk data.**

Read the user's real config (`%APPDATA%/twinkle-tray/settings-dev.json`) and the live `debug-dev.log` instead of guessing. Ground truth:

- `adjustmentTimeIndividualDisplays = false` → the flat `softwareDim` is what LERP uses (per-monitor maps ignored).
- 4 events, flat dim schedule: `01:55→70, 06:30→20, 07:30→0, 22:00→0`.

The user tested at ~01:51, which is 4 minutes into the tail of the **22:00 (dim 0) → 01:55 (dim 70)** ramp. Log confirms exactly this:

```
05:52:04 [schedule] applying event — value=1320 brightness=1 kelvin=5000 highlightWeight=79 ...
05:52:04 [softwareDim][diag] updateSoftwareDim(...ACR072F..., 69)
```

`value=1320` = the 22:00 event is "current"; `brightness=1`, `dim=69` are the *interpolated* values approaching the 01:55 target (`bri 0 / dim 70`). Not stuck at 70 — a linear ramp near its end. Mapping the whole day:

| interval | dim |
|---|---|
| 01:55→06:30 | 70 → 20 (active, decreasing) |
| 06:30→07:30 | 20 → 0 |
| 07:30→22:00 | **0 (overlay off all day)** |
| 22:00→01:55 | 0 → 70 (active, increasing) |

So dim is fully off only 07:30–22:00 and ramps/holds active all night — which is exactly what the 4 configured events describe, using the same interpolation rule brightness LERP has always used. The "always at 70" perception came from testing minutes before the 70-dim event.

**Diagnostic removed** (`[dim-diag]` log + the `getNextAdjustmentEvent` wrapper addition reverted) since root-cause came from disk, not live logs. `schedule.js` is back to zero diff.

**Status: CLOSED — no code change. "Always at 70" is correct LERP behaviour, not a defect.**

---

### Bug 6: UI slider shows positive brightness while the screen is overlay-dimmed (cross-zero transition) — FOUND, NOT FIXED

**Symptom (user screenshot):** During the 22:00→01:55 transition the **All Displays** slider reads `+1`, but the screen is visibly dark (looks like `-70`). The overlay is active yet nothing negative shows in the UI.

**Root cause:** brightness and softwareDim are the two halves of ONE `-100..100` axis — positive = hardware brightness (overlay off), negative = software-dim overlay (hardware at 0) — and they are **mutually exclusive** in the app's model:
- `BrightnessPanel.jsx:452` derives the slider level as `(mDim > 0 && m.brightness === 0) ? -mDim : m.brightness`. It only shows dim as negative **when `brightness === 0`**.
- `handleChange` splits a slider value into `{brightness = max(0,level), softwareDim = level<0 ? -level : 0}` — one of the two is always 0.

But `getCurrentAdjustmentEventLERP` (adjustmentTimes.js) interpolates brightness and softwareDim as **two independent channels**. A transition that crosses zero (22:00 `bri 100 / dim 0` → 01:55 `bri 0 / dim 70`) ramps `brightness 100→0` AND `dim 0→70` **in parallel**, so mid-transition BOTH are non-zero (e.g. `bri 1 / dim 69`, confirmed in `debug-dev.log`). The overlay dims the screen (`dim 69`) while the panel — seeing `brightness !== 0` — shows `+1` and hides the negative value entirely. Visually about right (hardware ~1 + 69% black overlay ≈ very dark), but the slider is wrong and the two channels double-dim through the middle of the ramp instead of following the single intended axis.

**Fix applied:** in `getCurrentAdjustmentEventLERP` (adjustmentTimes.js), interpolate the COMBINED value `brightness − softwareDim` and split it back, so exactly one of the two is ever non-zero:
```js
const lerpCombined = (curBri, curDim, nextBri, nextDim) => {
  const v = Utils.lerp((curBri ?? 0) - (curDim ?? 0), (nextBri ?? 0) - (nextDim ?? 0), p)
  return { brightness: Math.round(Math.max(0, v)), softwareDim: Math.round(v < 0 ? -v : 0) }
}
```
Same treatment per-monitor, preserving the `-1` "no override" sentinel (unset monitors are skipped and fall back to the combined flat value downstream). The old independent-channel `lerpPerMonitor(...monitorsSoftwareDim...)` call was removed (kelvin/highlight still use it — those ARE independent channels). Safe against existing tests (pure-brightness events have `dim 0` at both ends → identical result).

**Regression test added:** `test/adjustmentTimes.test.js` → "LERP treats brightness/softwareDim as one axis across a zero-crossing (Bug 6)". Asserts the combined values (e.g. 22:00 → `bri 15 / dim 0`; 23:36 → `bri 0 / dim 53`) and the invariant that the two halves are never both non-zero at any point in the ramp.

**Status: FIXED. Tests 220/220. Needs on-hardware confirmation during a real cross-zero transition (e.g. watch the 20:00→00:00 style ramp: slider should slide smoothly through 0 into negative, screen and slider staying in agreement).**

---

### What actually fixed the reported issues (final)

Two changes did the work; everything else is the pre-existing LERP-generalization feature:

1. **Flash (Bug 3) → fixed by removing the `BrightnessPanel.jsx` renderer guard** (`brightness>0 && softwareDim>0 → updateSoftwareDim(0)`). It fought the main process every schedule tick, causing an overlay hide→re-show flash. (Done before the last compaction.)
2. **Vertical monitor half-covered / stale bounds (Bug 4) → fixed by removing the `prevLevel === level && win.isVisible()` early-return** I had added to `updateSoftwareDim`. That early-return skipped `setBounds` whenever the level was unchanged, so after any display/bounds change the overlay never re-covered. Removing it restores the committed always-`setBounds` self-correction. `softwareDim.js` is now behaviourally identical to `9d3d9ef` (only a cosmetic local `win` var differs).

All the flash-hunt "fix attempts" turned out to be red herrings and were reverted: `lastOverlayBounds` caching, and the `prevLevel` early-return. The DDC dedup (`BrightnessController.js`) and gamma-ramp dedup (`displayColor.js`) remain in the diff as optimizations but were **not** the fix — keep an eye on them.

### Summary of the current uncommitted diff

|File|Change|Verdict|
|---|---|---|
|`src/adjustmentTimes.js`|LERP returns full object; brightness/dim interpolated as one combined axis|Feature + **Bug 6 fix**|
|`src/BrightnessController.js`|DDC dedup in setCanonical/setCanonicalGroup/animateTo instant path|Optimization, NOT the fix — suspect, watch|
|`src/displayColor.js`|LERP merge in applyCurrentDisplayColorEffects|Valid — Issue 1|
|`src/displayColor.js`|Gamma ramp dedup (skip when unchanged)|Optimization, NOT the fix — suspect, watch|
|`src/electron.js`|lerpActive var, LERP block reads softwareDim, apply condition|Feature + Issue 2|
|`src/electron.js`|transitionBrightness uses animateTo for warmth/highlight|Feature|
|`src/softwareDim.js`|`prevLevel` early-return REMOVED (back to always-setBounds)|**Bug 4 fix**|
|`src/components/BrightnessPanel.jsx`|Removed `brightness>0` dim-clearing guard|**Bug 3 fix (root cause)**|
|`src/components/settings/TimePage.jsx`|UI changes (speed dropdown gated on animate, etc.)|Feature|
|Localization + tests|Updated|Feature|

Tests: **220/220 passing** (added the Bug 6 cross-zero regression test).

### Still open / next

- **Bug 6 (fixed, needs hardware confirm):** combined-axis LERP applied + regression test added. Confirm on hardware during a real cross-zero transition that slider and screen stay in agreement through 0.
- **Suspect optimizations:** DDC dedup (`BrightnessController.js`) + gamma dedup (`displayColor.js`) are unrelated to any confirmed fix. Consider reverting to shrink the diff and remove masking risk, unless they're wanted as standalone perf wins.