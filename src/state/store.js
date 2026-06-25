// Main-process state store: the single owner of application state.
//
// Built to fix the "state has no home" problem — state lived as ~111 mutable
// module globals in electron.js, mutated from ~150 functions with no ownership
// and synced to renderers via ad-hoc broadcasts. This store gives each slice of
// state one owner: mutation happens only through `update`, which computes a diff
// and emits a change event. Main-process code subscribes instead of polling
// globals; renderers are driven from those subscriptions.
//
// State is organised into named slices (e.g. "settings", "monitors", "panel").
// `update` does a shallow merge and only emits when something actually changed,
// so subscribers (including the disk-persistence and renderer-broadcast bridges)
// never fire on no-op writes. Equality is shallow (===): replacing a nested
// object/array counts as a change; mutating one in place does not — always pass
// a fresh value in the patch.

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

  return { get, update, subscribe }
}

// Default singleton — the application's one state store. Tests use createStore
// for isolated instances.
const store = createStore()

module.exports = { createStore, store }
