// Smoke tests for SettingsWindow — the 2000-line settings monolith we're about
// to split page-by-page. These don't assert behaviour; they prove every page
// mounts and switches without throwing, so the upcoming extraction has a net.
// Delete/replace these with focused per-page tests once each page is carved out.

require('./helpers/reactEnv')

const { test } = require('node:test')
const assert = require('node:assert')
const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React

global.IS_REACT_ACT_ENVIRONMENT = true

const SettingsWindow = require('../src/components/SettingsWindow').default

// Pages rendered by activePage, matching the SettingsPage ids in render().
const PAGES = ['general', 'time', 'monitors', 'features', 'hotkeys', 'updates', 'debug']

function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const ref = React.createRef()
  let root
  act(() => {
    root = createRoot(container)
    root.render(React.createElement(SettingsWindow, { ref }))
  })
  return { container, ref, cleanup: () => act(() => root.unmount()) }
}

test('SettingsWindow mounts without throwing', () => {
  const { container, cleanup } = mount()
  assert.ok(container.querySelector('.settings-page'), 'a settings page rendered')
  cleanup()
})

for (const page of PAGES) {
  test(`page "${page}" renders when active`, () => {
    const { container, ref, cleanup } = mount()
    act(() => ref.current.setState({ activePage: page }))
    const rendered = container.querySelector('.settings-page')
    assert.ok(rendered, `page "${page}" produced markup`)
    cleanup()
  })
}
