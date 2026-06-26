// Main-process state store: the single owner of application state.
//
// State is organised into named slices (e.g. "settings", "monitors", "panel").
// A slice has one of two shapes — know which before you touch it:
//
//   1. Reactive slice (the default). Holds scalar / replaceable values. Mutate
//      through `update`, which shallow-merges the patch, computes a `===` diff
//      and emits `change:<slice>` only when something actually changed. Equality
//      is shallow: replacing a nested object/array counts; mutating one in place
//      does NOT — always pass a fresh value. Subscribe with `subscribe`.
//
//   2. Entity slice. Holds one long-lived collection (object / Set / Map) that is
//      mutated in place on hot paths — replacing it per write would churn a tight
//      loop (e.g. the monitors model on every brightness tick). The reference
//      never changes, so `update`'s `===` diff is blind to those edits by design.
//      Grab the live ref once with `ref(slice, key)`, mutate it directly, then
//      call `touch(slice)` to announce the change. Subscribe with `onTouch`.
//      `touch`/`onTouch` ride a separate `touch:<slice>` event, so an entity
//      slice can also carry reactive scalar keys (updated via `update`) without
//      the two signals colliding.
//
// One rule spans both: a value is either reactive-and-replaced or
// entity-and-touched. Don't mutate a reactive value in place (silent), and don't
// route entity mutations through `update` (it can't see them).

const { EventEmitter } = require('events')

function shallowDiff(current, patch) {
  const diff = {}
  for (const key in patch) {
    if (current[key] !== patch[key]) {
      diff[key] = patch[key]
    }
  }
  return diff
}

function createStore(initialState = {}) {
  const state = {}
  for (const slice in initialState) {
    state[slice] = Object.assign({}, initialState[slice])
  }

  const emitter = new EventEmitter()
  // Many slices with several main-process subscribers each; the default limit
  // of 10 listeners per event is too low and would log spurious warnings.
  emitter.setMaxListeners(0)

  // Read a slice (mutable reference — treat as read-only). With no argument,
  // returns a shallow snapshot of every slice.
  function get(slice) {
    if (slice === undefined) {
      return Object.assign({}, state)
    }
    if (state[slice] === undefined) state[slice] = {}
    return state[slice]
  }

  // Shallow-merge `patch` into a slice. Emits "change:<slice>" with
  // (diff, fullSlice) only when the merge actually changed something. Returns
  // the diff (empty object means no-op, no event).
  function update(slice, patch = {}) {
    if (state[slice] === undefined) state[slice] = {}
    const diff = shallowDiff(state[slice], patch)
    if (Object.keys(diff).length === 0) return diff
    Object.assign(state[slice], diff)
    emitter.emit(`change:${slice}`, diff, state[slice])
    return diff
  }

  // Subscribe to changes for a slice. `fn` receives (diff, fullSlice).
  // Returns an unsubscribe function.
  function subscribe(slice, fn) {
    const event = `change:${slice}`
    emitter.on(event, fn)
    return () => emitter.off(event, fn)
  }

  // Entity-slice access. Return the live, mutable value at state[slice][key]
  // (creating the slice if absent). Callers mutate it in place and announce the
  // change with `touch(slice)`. Declaring access through `ref` — rather than
  // `get(slice).key` — marks the value as mutate-in-place at the call site.
  function ref(slice, key) {
    if (state[slice] === undefined) state[slice] = {}
    return state[slice][key]
  }

  // Announce that an entity slice was mutated in place. Always emits
  // `touch:<slice>` with the full slice; unlike `update` there is no diff and no
  // no-op suppression — the caller asked to broadcast, so it broadcasts.
  function touch(slice) {
    if (state[slice] === undefined) state[slice] = {}
    emitter.emit(`touch:${slice}`, state[slice])
  }

  // Subscribe to `touch` announcements for an entity slice. `fn` receives the
  // full slice. Returns an unsubscribe function.
  function onTouch(slice, fn) {
    const event = `touch:${slice}`
    emitter.on(event, fn)
    return () => emitter.off(event, fn)
  }

  return { get, update, subscribe, ref, touch, onTouch }
}

// Default singleton — the application's one state store. Tests use createStore
// for isolated instances.
const store = createStore()

module.exports = { createStore, store }
