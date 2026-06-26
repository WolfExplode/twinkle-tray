const { test } = require('node:test')
const assert = require('node:assert')
const { pickLatestRelease } = require('../src/updateCheck')

function release(tag, { prerelease = false } = {}) {
  return {
    tag_name: tag,
    prerelease,
    html_url: `https://example/${tag}`,
    body: `notes ${tag}`,
    assets: [{ browser_download_url: `https://example/${tag}.exe`, size: 123 }],
  }
}

test('picks a newer release than the current version', () => {
  const found = pickLatestRelease(
    [release('v1.18.0'), release('v1.17.0')],
    { branch: 'master', currentVersion: '1.17.2' }
  )
  assert.strictEqual(found.version, 'v1.18.0')
  assert.strictEqual(found.downloadURL, 'https://example/v1.18.0.exe')
  assert.strictEqual(found.filesize, 123)
  assert.strictEqual(found.show, false)
})

test('skips releases older than current', () => {
  const found = pickLatestRelease(
    [release('v1.16.0'), release('v1.15.0')],
    { branch: 'master', currentVersion: '1.17.2' }
  )
  assert.strictEqual(found, null)
})

test('ignores prereleases on the master branch', () => {
  const found = pickLatestRelease(
    [release('v1.19.0', { prerelease: true }), release('v1.18.0')],
    { branch: 'master', currentVersion: '1.17.2' }
  )
  assert.strictEqual(found.version, 'v1.18.0')
})

test('accepts prereleases on a non-master branch', () => {
  const found = pickLatestRelease(
    [release('v1.19.0', { prerelease: true })],
    { branch: 'beta', currentVersion: '1.17.2' }
  )
  assert.strictEqual(found.version, 'v1.19.0')
})

test('returns the first qualifying release (list order)', () => {
  const found = pickLatestRelease(
    [release('v1.18.0'), release('v1.19.0')],
    { branch: 'master', currentVersion: '1.17.2' }
  )
  assert.strictEqual(found.version, 'v1.18.0')
})

test('returns null for an empty release list', () => {
  assert.strictEqual(pickLatestRelease([], { branch: 'master', currentVersion: '1.17.2' }), null)
})
