// Shared test environment for React component smoke tests.
//
// The renderer components are JSX with ESM `import` syntax and pull in PNG
// assets — none of which `node --test` can load directly. This helper installs
// a require hook (via @babel/core, already a dev dep — no @babel/register
// needed) that transpiles src JS/JSX on the fly and stubs asset imports, then
// stands up a minimal jsdom window with the `window.*` bridge the components
// expect. require() this once at the top of a component test.

const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

const srcDir = path.resolve(__dirname, '..', '..', 'src')

// Asset imports (import Logo from "...png") resolve to their basename string.
for (const ext of ['.png', '.svg', '.jpg', '.jpeg', '.gif', '.ico', '.scss', '.css']) {
  require.extensions[ext] = (module, filename) => {
    module.exports = path.basename(filename)
  }
}

function babelCompile(module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const { code } = babel.transformSync(source, {
    filename,
    presets: [
      ['@babel/preset-env', { targets: { node: 'current' } }],
      '@babel/preset-react'
    ],
    plugins: ['@babel/plugin-proposal-class-properties']
  })
  module._compile(code, filename)
}

// Transpile JSX, and src .js too (components mix `import` with `module.exports`).
require.extensions['.jsx'] = babelCompile
const defaultJs = require.extensions['.js']
require.extensions['.js'] = (module, filename) => {
  // Only our own src needs the transform; leave deps and test files to Node.
  if (filename.startsWith(srcDir) && !filename.includes('node_modules')) {
    return babelCompile(module, filename)
  }
  return defaultJs(module, filename)
}

// Minimal DOM. react-dom needs a document; the components read window globals.
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })

global.window = dom.window
global.document = dom.window.document
global.navigator = dom.window.navigator

// Expose the DOM constructors libraries (e.g. react-beautiful-dnd) reach for on
// the global scope. Copy anything jsdom defines that we don't already have.
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (global[key] === undefined && !key.startsWith('_')) {
    try { global[key] = dom.window[key] } catch { /* read-only window prop */ }
  }
}
if (!global.crypto || !global.crypto.randomUUID) {
  global.crypto = require('crypto').webcrypto
}
// jsdom's window has no crypto.randomUUID in older versions; components call it.
if (!dom.window.crypto || !dom.window.crypto.randomUUID) {
  dom.window.crypto = global.crypto
}

// The bridge the renderer talks to the main process through. In the real app
// the preload exposes these on `window`, and since `window === global` in the
// renderer the components reference them bare (`settings`, not `window.settings`).
// jsdom keeps window and global separate, so define the stubs on both.
const noop = () => {}
const bridge = {
  settings: { updateInterval: 500 },
  monitors: {},
  allMonitors: {},
  accent: {},
  app: { version: '0.0.0-test' },
  version: '0.0.0-test',
  versionBuild: '0.0.0-test',
  versionTag: '',
  settingsPath: '',
  currentSettingsPage: 'general',
  isAppX: false,
  isPortable: false,
  reactReady: false,
  ipc: { send: noop, on: noop },
  sendSettings: noop,
  getSettings: () => ({}),
  resetSettings: noop,
  requestMonitors: noop,
  reloadReactMonitors: noop,
  checkForUpdates: noop,
  getUpdate: noop,
  startUpdate: noop,
  getSunCalcTimes: () => ({}),
  openURL: noop
}
Object.assign(dom.window, bridge)
Object.assign(global, bridge)

module.exports = { dom, bridge }
