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

// --- entity slices: ref / touch / onTouch ---

test('ref returns the live mutable value; in-place edits are visible through it', () => {
  const store = createStore({ monitors: { all: {} } })
  const all = store.ref('monitors', 'all')
  all['mon1'] = { brightness: 50 }
  assert.strictEqual(store.get('monitors').all, all, 'ref is the same reference the slice holds')
  assert.strictEqual(store.ref('monitors', 'all')['mon1'].brightness, 50)
})

test('in-place mutation is invisible to update/subscribe (the reason touch exists)', () => {
  const store = createStore({ monitors: { all: {} } })
  let fired = false
  store.subscribe('monitors', () => { fired = true })
  const all = store.ref('monitors', 'all')
  all['mon1'] = { brightness: 50 }
  const diff = store.update('monitors', { all }) // same reference
  assert.deepStrictEqual(diff, {}, 'same-reference update is a no-op')
  assert.strictEqual(fired, false, 'subscribe cannot see in-place edits')
})

test('touch emits touch:<slice> with the full slice and always fires', () => {
  const store = createStore({ monitors: { all: { mon1: {} } } })
  const calls = []
  store.onTouch('monitors', (slice) => calls.push(slice))
  store.touch('monitors')
  store.touch('monitors') // no diff suppression — fires every time
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(calls[0], store.get('monitors'), 'receives the full slice')
})

test('touch and change are separate channels; update does not trigger onTouch', () => {
  const store = createStore({ monitors: { all: {}, isRefreshing: false } })
  let touched = 0
  let changed = 0
  store.onTouch('monitors', () => { touched++ })
  store.subscribe('monitors', () => { changed++ })
  store.update('monitors', { isRefreshing: true }) // reactive write
  store.touch('monitors')                          // entity announce
  assert.strictEqual(changed, 1, 'update fired change only')
  assert.strictEqual(touched, 1, 'touch fired touch only')
})

test('onTouch returns an unsubscribe that stops further touch delivery', () => {
  const store = createStore({ monitors: { all: {} } })
  let count = 0
  const off = store.onTouch('monitors', () => { count++ })
  store.touch('monitors')
  off()
  store.touch('monitors')
  assert.strictEqual(count, 1)
})
