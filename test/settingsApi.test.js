// Tests for the consumer settings bridge (src/renderer/settingsApi.js).
// Verifies actions forward to the window bridge, reads snapshot published state,
// and subscribe() honours its addEventListener/removeEventListener contract.

require('./helpers/reactEnv')

const { test } = require('node:test')
const assert = require('node:assert')
const api = require('../src/renderer/settingsApi')

test('actions forward their arguments to the window bridge', () => {
  const calls = []
  window.sendSettings = (v) => calls.push(['sendSettings', v])
  window.requestMonitors = (v) => calls.push(['requestMonitors', v])
  window.openURL = (v) => calls.push(['openURL', v])

  api.sendSettings({ theme: 'dark' })
  api.requestMonitors(true)
  api.openURL('https://example.com')

  assert.deepStrictEqual(calls, [
    ['sendSettings', { theme: 'dark' }],
    ['requestMonitors', true],
    ['openURL', 'https://example.com']
  ])
})

test('reads snapshot the latest producer-published state', () => {
  window.settings = { theme: 'light', scale: 2 }
  window.allMonitors = [{ id: 'a' }]
  assert.deepStrictEqual(api.getSettings(), { theme: 'light', scale: 2 })
  assert.deepStrictEqual(api.getMonitors(), [{ id: 'a' }])
})

test('getSettings/getMonitors return safe defaults when unset', () => {
  window.settings = undefined
  window.allMonitors = undefined
  assert.deepStrictEqual(api.getSettings(), {})
  assert.deepStrictEqual(api.getMonitors(), [])
})

test('subscribe delivers the event detail and unsubscribes cleanly', () => {
  const received = []
  const unsubscribe = api.subscribe('settingsUpdated', (detail) => received.push(detail))

  window.dispatchEvent(new window.CustomEvent('settingsUpdated', { detail: { a: 1 } }))
  assert.deepStrictEqual(received, [{ a: 1 }])

  unsubscribe()
  window.dispatchEvent(new window.CustomEvent('settingsUpdated', { detail: { a: 2 } }))
  assert.deepStrictEqual(received, [{ a: 1 }], 'no delivery after unsubscribe')
})

test('named subscriptions wrap the right event name', () => {
  const received = []
  const unsubscribe = api.onMonitorsUpdated((detail) => received.push(detail))
  window.dispatchEvent(new window.CustomEvent('monitorsUpdated', { detail: ['m'] }))
  unsubscribe()
  assert.deepStrictEqual(received, [['m']])
})
