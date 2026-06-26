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
