# settings/ — Settings window pages

`SettingsWindow.jsx` was a 2000-line class with one ~590-line `render()`. It's
now a thin shell: it owns state + handlers and routes to the active page.

## Layout

- `SettingsWindow.jsx` (parent) — holds `state`, the ~50 handler methods, the
  sidebar, the add-feature overlay, and a router `render()` that mounts one page.
- `shared.jsx` — module helpers and sub-components shared across pages: the `T`
  translation singleton, `ActionItem`, `AppProfile`, `SettingsPage`, drag
  helpers, `uuid`/`vcpStr`/`defaultAction`.
- `GeneralPage` / `TimePage` / `MonitorsPage` / `FeaturesPage` / `HotkeysPage` /
  `UpdatesPage` / `DebugPage` — one file per sidebar page.

## Why pages take `self` instead of owning state

Each page is `function XPage({ self })`, where `self` is the parent
`SettingsWindow` instance, and reads `self.state` / calls `self.renderToggle()`
etc. This is **intentional, not a missing refactor.**

The settings live as one shared object (`rawSettings`, mirrored from the main
process via `window.settings`). Every page reads across that whole blob — it
does not partition into per-page slices. Giving each page its own `useState`
would mean 7 copies of the same main-process sync logic against the same blob,
for no real gain. So state ownership stays on the parent; pages are
presentational.

Consequence: don't wrap pages in `React.memo`. `self` is a stable reference, so
a shallow-prop memo would skip renders that should happen. Re-render cost is
already low — `SettingsPage` returns `null` for inactive pages, so only the
visible page renders on a state change.

## Tests

`test/settingsWindow.smoke.test.js` mounts every page (via `test/helpers/
reactEnv.js`) and asserts it renders without throwing. These cover render-time
references, not interactive handler behaviour — exercise pages in the running
app when changing handler logic.
