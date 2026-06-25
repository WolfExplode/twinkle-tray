const { test } = require('node:test')
const assert = require('node:assert')
const { createStore } = require('../src/state/store')

test('get returns an empty object for an unseen slice', () => {
  const store = createStore()
  assert.deepStrictEqual(store.get('settings'), {})
})

test('get returns seeded initial state (copied, not the same reference)', () => {
  const initial = { settings: { theme: 'dark' } }
  const store = createStore(initial)
  assert.deepStrictEqual(store.get('settings'), { theme: 'dark' })
  assert.notStrictEqual(store.get('settings'), initial.settings, 'slice is copied from initial state')
})

test('get with no argument returns a snapshot of all slices', () => {
  const store = createStore({ settings: { a: 1 }, panel: { open: false } })
  assert.deepStrictEqual(store.get(), { settings: { a: 1 }, panel: { open: false } })
})

test('update shallow-merges a patch into the slice', () => {
  const store = createStore({ settings: { theme: 'dark', scale: 1 } })
  store.update('settings', { scale: 2 })
  assert.deepStrictEqual(store.get('settings'), { theme: 'dark', scale: 2 })
})

test('update returns the diff of what actually changed', () => {
  const store = createStore({ settings: { theme: 'dark', scale: 1 } })
  const diff = store.update('settings', { theme: 'dark', scale: 2 })
  assert.deepStrictEqual(diff, { scale: 2 }, 'unchanged keys are excluded from the diff')
})

test('subscribe fires with (diff, fullSlice) on a real change', () => {
  const store = createStore({ settings: { theme: 'dark' } })
  const calls = []
  store.subscribe('settings', (diff, slice) => calls.push([diff, slice]))
  store.update('settings', { theme: 'light' })
  assert.strictEqual(calls.length, 1)
  assert.deepStrictEqual(calls[0][0], { theme: 'light' })
  assert.deepStrictEqual(calls[0][1], { theme: 'light' })
})

test('update with an empty diff does not emit and returns {}', () => {
  const store = createStore({ settings: { theme: 'dark' } })
  let fired = false
  store.subscribe('settings', () => { fired = true })
  const diff = store.update('settings', { theme: 'dark' })
  assert.deepStrictEqual(diff, {})
  assert.strictEqual(fired, false, 'no-op write must not emit')
})

test('replacing a nested object counts as a change; equal primitive does not', () => {
  const arr = [1, 2]
  const store = createStore({ monitors: { list: arr } })
  const noop = store.update('monitors', { list: arr })
  assert.deepStrictEqual(noop, {}, 'same array reference is not a change')
  const diff = store.update('monitors', { list: [1, 2] })
  assert.deepStrictEqual(diff, { list: [1, 2] }, 'new array reference is a change')
})
