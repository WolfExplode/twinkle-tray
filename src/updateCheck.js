// Pure release-selection logic for the auto-updater, extracted from
// electron.js. The networking, file download, and process spawn stay in
// electron.js (they own the latestVersion/lastCheck state and touch the app
// lifecycle); only the decision of *which* release to offer lives here, so it
// can be unit-tested.

const Utils = require("./Utils")

// Pick the newest applicable release from the GitHub releases list.
//   - On the "master" branch, prereleases are ignored.
//   - Releases not newer than the current version are skipped.
// Returns a latestVersion descriptor for the first qualifying release, or null
// when none qualify.
function pickLatestRelease(releases, { branch, currentVersion } = {}) {
  const currentValue = Utils.getVersionValue(`v${currentVersion}`)
  for (const release of releases) {
    // Skip prereleases on the stable branch
    if (branch === "master" && release.prerelease === true) continue;
    // Skip anything older than what we're running
    if (Utils.getVersionValue(release.tag_name) < currentValue) continue;
    return {
      releaseURL: release.html_url,
      version: release.tag_name,
      downloadURL: release.assets[0]["browser_download_url"],
      filesize: release.assets[0]["size"],
      changelog: release.body,
      show: false,
      error: false
    }
  }
  return null
}

module.exports = { pickLatestRelease }
