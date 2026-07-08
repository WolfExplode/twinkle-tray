# Upstream Sync Ledger

Running record of `xanderfrangos/twinkle-tray:master` commits reviewed against
this fork (`WolfExplode/twinkle-tray`, branch `refactor`).

**Purpose:** GitHub's "N commits behind" counts *all* upstream commits, including
ones already reviewed and intentionally skipped. This file tracks how many have
been triaged so that next time you see "N behind" you only review the `N − last
reviewed count` newest commits.

## How to update

```sh
git fetch upstream
git log --oneline $(git merge-base HEAD upstream/master)..upstream/master
```

Compare the top of that list against the **Reviewed through** marker below.
Anything above the marker is new — triage it, add rows, move the marker.

---

## Reviewed through

- **Upstream HEAD merged:** `dfc6da1` (Merge PR #1220)
- **Merge base:** `4fce279`
- **Commits triaged:** 30 / 30 behind (as of 2026-06-26)
- **Status:** ✅ **All 30 merged** into `refactor` (merge commit `b0d6d97`, 2026-06-26).
  One conflict in `Monitors.js` resolved keeping upstream Studio Display
  helpers + refactor's `async function` style. 186/186 tests pass.
- **Next time:** only review commits *above* `dfc6da1` in upstream/master.

---

## Decision legend

- ✅ **Adopt** — bring into fork
- ⏭️ **Skip** — not applicable / superseded by refactor
- 🌐 **i18n** — translation-only, adopt in bulk if/when desired
- 🔀 **Merge** — merge commit, no own content

## Triage table (newest → oldest)

| Commit | Summary | Files | Decision | Notes |
|--------|---------|-------|----------|-------|
| `dfc6da1` | Merge PR #1220 | — | 🔀 | rolls up el.json greek loc |
| `a749bea` | Merge PR #1211 (weblate) | — | 🔀 | rolls up translations |
| `3a22e99` | studio-display-control 0.2.1 (XDR) | `Monitors.js` (+2/-1) | ✅ **Merged** | Apple Studio Display only. Adds `getModelName()` label. Taken for parity. |
| `c53dc0c` | Detect 2026 Studio Display (#1254) | `Monitors.js` (+161), `MonitorFeatures.jsx` | ✅ **Merged** | USB-fallback brightness path. **Conflict** vs refactor — resolved keeping upstream helpers + `async function` style. `require("usb")` no-ops until `usb` dep added. |
| `de96268` | Consistent flyout scroll (#1259) | `Slider.jsx` (1 line) | ✅ **Merged** | `Math.round(deltaY*-0.01*amt)` → `Math.sign(deltaY)*-1*amt`. One-notch-per-event, independent of Windows scroll speed. |
| `8c85a85`..`31de229` | 20× Weblate translations | `localization/*.json` | 🌐 | hr, id, vi, tr, sv, ja, ar, es, ro, bn, th, cs, zh-Hant, fa, ru. Bulk adopt only if you want translations current. |
| `145fae1` | CI / Node 24 fixes | `ci.yml`, `binding.gyp`×2, `.cc`, `package-lock` | ✅ **Merged** | Node 22→24, checkout/setup-node v4→v6, node-gyp ^10→^12, C++ std flag fixes (win32-displayconfig → c++20, drops dead `-std:c++17` on tt-windows-utils), `.cc` extracts callback before `.As<Function>()`. |
| `b5b8b31` | windows-accent-colors 1.0.2 | `package.json`, lock | ✅ **Merged** | Patch dep bump, low risk. |
| `f234af7` | "Major Improvements" | `el.json` (40/40) | 🌐 | Misleading title — Greek localization only. |
| `93cbd44` | Update el.json | `el.json` | 🌐 | Greek loc. |
| `f5ab074` | Update Greek localization | `el.json` | 🌐 | Greek loc. |

## Summary

- **2** merge commits (no own content)
- **23** localization/translation commits (20 weblate + 3 greek)
- **5** code/infra commits — all merged.

### Follow-up TODO

- [ ] Add `usb` to `package.json` dependencies to actually enable the 2026
  Studio Display fallback path (`getFallbackStudioDisplays`). Upstream also
  omits it, so currently a no-op on both. Only relevant if you own that hardware.

## Known upstream bugs (documented, not fixed)

Bugs found in upstream code during a fork bug-hunt (2026-07-08). Confirmed
present on `upstream/master` as of the last fetch, not fork-introduced.
Deliberately left as-is — rationale below. Re-check if a related user report
surfaces.

### `testDDCCIMethods()` feature-mismatch branch never sets `fastIsFine = false`

- **Where:** `src/Monitors.js`, `testDDCCIMethods()` — the loop comparing
  `fastFeatures[id]` vs `accurateFeatures[id]`.
- **Introduced:** `0e2751f` ("Added fast (legacy) DDC scan with a test at
  startup to determine the best option"), 2023-12-12. Present unchanged since
  the feature's introduction — over two years.
- **What it does:** At startup, the app scans DDC/CI capabilities two ways
  ("fast" vs "accurate") and picks "fast" as the default going forward unless
  the two disagree. Three checks feed the verdict: display-count mismatch,
  missing ID, and feature-value mismatch. Only the first two actually flip
  `fastIsFine` to `false` — a feature mismatch sets `failReason` (logged) but
  the flag stays `true`, so "fast" mode is silently kept even when the two
  scans disagreed.
- **Blast radius (traced 2026-07-08):** `isFastFine` feeds only
  `determineDDCCIMethod()`, which is consulted solely during capability
  discovery (startup + full refresh) — not the routine brightness-polling
  loop, which uses a cached `brightnessType` directly. A user's
  `preferredDDCCIMethod` setting overrides this entirely, so it only affects
  users who've never touched that setting. "Accurate" mode's only advantage
  is a capabilities-report pre-filter; without it, `checkVCPIfEnabled`
  already falls through to querying VCP codes directly, so hardware still
  gets read correctly — worst case is extra I2C probing / noisier
  "unsupported" logs on monitors with flaky/inconsistent DDC busses, not
  wrong brightness or broken control.
- **Why not fixed:** The comparison uses live VCP reads (current
  brightness/volume/contrast) taken moments apart in two separate scans —
  a real value change between reads (user touches the OSD, bus jitter) would
  register as a false "mismatch." Blindly setting `fastIsFine = false` there
  risks forcing many users onto the slower "accurate" path for no real gain.
  Can't tell which theory is right without hardware showing the actual
  failure mode, which we don't have access to.
- **Issue-tracker check (2026-07-08):** No open issue traces to this
  mechanism. Closest candidates ruled out: [#1231](https://github.com/xanderfrangos/twinkle-tray/issues/1231)
  ("DDC/CI Volume changes alongside brightness") is a `linked` setting being
  ignored by tray-scroll, unrelated. [#1256](https://github.com/xanderfrangos/twinkle-tray/issues/1256)
  ("Intermittent loss of DDC/CI control") doesn't fit either — the toothless
  test runs once at startup and wouldn't produce hours-to-days-later
  intermittent failures; reads more like a driver/bus-level dropout.

### `console.log("Reason: " + fastIsFine)` should read `failReason`

- **Where:** `src/Monitors.js`, same function, a few lines below the above —
  `if(failReason) console.log("Reason: " + fastIsFine);`
- **Introduced:** `9b8ded4` ("Replaced DDC/CI scan process again for better
  accuracy"), 2026-06-29 — the commit that introduced the `failReason`
  variable in the first place; copy-paste of the adjacent `fastIsFine` log
  line.
- **Impact:** Cosmetic, log-only — prints `Reason: true` instead of the
  actual failure reason. No functional effect.
- **Status:** Fixed locally in this fork (`src/Monitors.js`). Worth
  reporting upstream since it's a one-line, unambiguous fix with no
  tradeoffs — unlike the bug above.

### `checkVCP()` wastes an I2C read and skips caching for code 0x60 (input select)

- **Where:** `src/Monitors.js`, `checkVCP()`.
- **Introduced:** [PR #1114](https://github.com/xanderfrangos/twinkle-tray/pull/1114)
  ("Added the ability to switch the monitor input"), contributor `pie-potato`,
  merged 2025-11-29 (`b6a6d31`) — part of a large (18-file, +1205/-488)
  community-contributed feature. The maintainer's own review noted it needed
  "detailed review" but was approved after a test build + a few weeks of
  community testing with no reported regressions; no review comments touch
  this code path specifically.
- **What it did:** For every other VCP code, `checkVCP()` reads via
  `ddcci._getVCP()`, writes the result to `vcpCache`, then awaits
  `checkVCPWaitMS` before returning — giving every DDC/CI bus command a
  cache fallback and consistent inter-command pacing. Code 96 (0x60) instead
  fetched the value via `_getVCP` (wasted — the result was discarded), then
  returned early via `ddcci.getMonitorInputs()`, bypassing both the cache
  write and the wait.
- **Deeper issue (not fixed, left as-is):** `getMonitorInputs()` itself
  (`src/modules/node-ddcci/index.js`) calls `ddcci.refresh("accurate", true,
  true)` internally before reading — a full capabilities re-scan, hardcoded
  to "accurate" mode regardless of what the outer scan is running (see the
  `fastIsFine` entry above for why "accurate" is the slow path). Since
  `checkMonitorFeatures()` queries `0x60` unconditionally on every DDC
  monitor during every capability discovery pass, this likely adds a real
  cost to "Refresh displays" / startup scanning on any DDC-capable monitor.
  Left alone because fixing it means changing DDC/CI bus sequencing inside
  the native module with no hardware here to validate the change is safe.
- **Fixed locally (2026-07-08):** the wasted `_getVCP` call — code 96 now
  calls `getMonitorInputs()` directly (no discarded read) and falls through
  to the normal cache-write/wait path like every other code. This is a
  strict subset of the full fix: it removes the pointless extra I2C round-trip
  and restores caching/pacing, but does **not** touch the nested
  `refresh("accurate", ...)` call, which is the larger suspected cost.

---

# How this fork differs from upstream

Read this **before** merging upstream. It tells you which upstream changes will
auto-merge and which will conflict, and where the fork moved the logic so you can
re-home an upstream change by hand. See also memory `[[electron-refactor-approach]]`.

## The core architectural shift

Upstream is **monolithic**: `electron.js` is one ~3k-line file holding all main-process
logic; each `*-preload.js` holds its window's bridge logic inline; `SettingsWindow.jsx`
is one giant component; cross-cutting state lives in module-scope globals.

This fork is **modular + dependency-injected**:

1. **`create*(deps)` factories** — main-process subsystems are extracted into their own
   modules that export a `createX(deps)` factory taking injected dependencies (so they're
   unit-testable). `electron.js` wires them together. Current factories:
   `createDisplayColor` ([displayColor.js](src/displayColor.js)),
   `createMonitorFocusController` ([monitorFocusController.js](src/monitorFocusController.js)),
   `createAnalytics` ([analytics.js](src/analytics.js)),
   `createPanelAnimator` ([panelAnimator.js](src/panelAnimator.js)),
   `createSchedule` ([schedule.js](src/schedule.js)),
   `createHotkeyController` ([hotkeys.js](src/hotkeys.js)),
   `createSoftwareDim` ([softwareDim.js](src/softwareDim.js)).
   (`electron.js` keeps its own `createPanel/createTray/createSettings` window builders.)
2. **Central store** — [state/store.js](src/state/store.js) `createStore()` replaces scattered
   globals. Cross-subsystem calls (e.g. displayColor ↔ monitors) route **through the store**,
   not direct calls. Entity slices are formalised; the focus slice was evicted from the store.
3. **Renderer bridge layer** — preload logic was lifted out of the thin `*-preload.js` files
   into [renderer/](src/renderer/) (`panelBridge.js`, `settingsBridge.js`, `introBridge.js`,
   `settingsApi.js`, `useSettingsBridge.js`). The preloads now just expose the bridge.
4. **Settings page split** — `SettingsWindow.jsx` (−945 lines) was broken into per-tab
   components under [components/settings/](src/components/settings/)
   (`GeneralPage`, `TimePage`, `HotkeysPage`, `MonitorsPage`, `FeaturesPage`, `DebugPage`,
   `UpdatesPage`, plus `shared.jsx`).
5. **Tests + extracted pure logic** — `Utils.js` (+347) and new modules
   (`adjustmentTimes.js`, `hotkeyActions.js`, `monitorTransforms.js`, `profiles.js`,
   `updateCheck.js`, `monitorFocus.js`, `logger.js`) hold pure logic with `node --test`
   coverage under [test/](test/). Verification gate: `node --check` changed files + `npm test`.
6. **Native add-on** — fork adds gamma/tone-curve control to `tt-windows-utils`
   (`windows_color_gamma.cc`, `color-temperature.js`, `display-tone-curve.js`).

## Merge-risk map (upstream file → fork treatment)

When upstream touches one of these, expect this outcome:

| Upstream file | Fork change | Merge risk | Strategy |
|---------------|-------------|-----------|----------|
| `src/electron.js` | Gutted into `create*(deps)` modules (~2.4k lines moved) | 🔴 **High** | Upstream edits here rarely apply. Identify which subsystem the change belongs to, hand-port into the matching `create*` module + wire via store. |
| `src/*-preload.js` (panel/settings/intro) | Logic moved to `renderer/*Bridge.js` | 🔴 **High** | Re-home the change into the corresponding `renderer/` bridge, not the preload. |
| `src/components/SettingsWindow.jsx` | Split into `components/settings/*Page.jsx` | 🔴 **High** | Find the tab; apply change in that `*Page.jsx`. |
| `src/Monitors.js` | Store-routed; focus slice evicted | 🟠 **Med** | Conflicted on this merge (Studio Display). Keep upstream logic, adapt to store + `async function` decls. |
| `src/components/BrightnessPanel.jsx` | Heavily reworked (+330) | 🟠 **Med** | Manual review likely. |
| `src/components/Slider.jsx` | Reworked (+113) | 🟠 **Med** | Logic still recognisable; the `de96268` 1-liner merged clean. |
| `src/Utils.js` | +347, helpers extracted & tested | 🟠 **Med** | Check if upstream's change duplicates an already-extracted helper. |
| `src/css/*.scss` | Minor fork tweaks | 🟢 **Low** | Usually auto-merges. |
| `src/localization/*.json` | Untouched by fork | 🟢 **Low** | Always auto-merges — bulk-take upstream. |
| `src/modules/**` native + `binding.gyp` | Fork added gamma module + flags | 🟢/🟠 | Additive mostly; `binding.gyp` may need both sides' flags. |

**Files that exist only in the fork** (33 src + 18 test modules listed above) can never
conflict — upstream doesn't know about them. All conflict risk is concentrated in the ~21
files modified on both sides, and realistically in the four 🔴 monoliths upstream still edits.

## Merge playbook

1. `git fetch upstream && git merge upstream/master` (or triage first via the table at top).
2. Translations + new fork-only files auto-merge — ignore them.
3. For each conflict, consult the risk map: don't fight the textual conflict in
   `electron.js`/preload/`SettingsWindow.jsx` — instead find where the fork **moved** that
   logic and apply the upstream intent there.
4. Run the gate: `node --check` each changed `.js`, then `npm test` (expect 186+ pass).
5. Update the ledger marker + table above.
