const { test } = require('node:test')
const assert = require('node:assert')
const { matchWindowToProfile } = require('../src/profiles')

const profiles = [
  { name: 'Games', path: 'game.exe, steam.exe' },
  { name: 'Video', path: 'vlc.exe' },
]

test('matches a window path against a comma-separated profile path', () => {
  const m = matchWindowToProfile('C:\\Games\\steam.exe', profiles)
  assert.strictEqual(m.name, 'Games')
})

test('matching is case-insensitive', () => {
  const m = matchWindowToProfile('C:\\Apps\\VLC.EXE', profiles)
  assert.strictEqual(m.name, 'Video')
})

test('later matching profile wins', () => {
  const overlapping = [
    { name: 'First', path: 'shared.exe' },
    { name: 'Second', path: 'shared.exe' },
  ]
  assert.strictEqual(matchWindowToProfile('x\\shared.exe', overlapping).name, 'Second')
})

test('returns undefined when no profile matches', () => {
  assert.strictEqual(matchWindowToProfile('C:\\other\\thing.exe', profiles), undefined)
})

test('returns undefined for an empty or missing window path', () => {
  assert.strictEqual(matchWindowToProfile('', profiles), undefined)
  assert.strictEqual(matchWindowToProfile(undefined, profiles), undefined)
})

test('no profiles is a no-op (undefined)', () => {
  assert.strictEqual(matchWindowToProfile('x\\game.exe'), undefined)
})

test('ignores profiles with no path set', () => {
  const withEmpty = [{ name: 'Empty', path: '' }, { name: 'Real', path: 'app.exe' }]
  assert.strictEqual(matchWindowToProfile('d\\app.exe', withEmpty).name, 'Real')
})

test('a trailing or double comma in a profile path must not match every window', () => {
  // "chrome.exe," splits into ["chrome.exe", ""] — the empty part trims to ""
  // and indexOf("") is 0 on any string, so it would match everything.
  const withTrailingComma = [{ name: 'Sloppy', path: 'chrome.exe,' }]
  assert.strictEqual(matchWindowToProfile('C:\\other\\thing.exe', withTrailingComma), undefined)
  assert.strictEqual(matchWindowToProfile('C:\\app\\chrome.exe', withTrailingComma).name, 'Sloppy')

  const withDoubleComma = [{ name: 'Doubled', path: 'a.exe,,b.exe' }]
  assert.strictEqual(matchWindowToProfile('C:\\other\\thing.exe', withDoubleComma), undefined)
})
