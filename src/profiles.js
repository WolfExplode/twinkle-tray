// Pure profile-matching logic, extracted from electron.js.
//
// electron.js keeps a thin shell (windowMatchesProfile) that injects
// settings.profiles, guards against a null window, and logs matches.

// Match a foreground window path against the user's profiles.
//
// `profiles` is an array of { name, path, ... } entries, where `path` is a
// comma-separated list of substrings to test against the window path
// (case-insensitive). Returns the last matching profile (later entries win,
// preserving the original behaviour) or undefined when nothing matches.
function matchWindowToProfile(windowPath, profiles = []) {
  if (!windowPath?.length) return undefined
  let foundProfile
  for (const profile of profiles) {
    if (profile.path?.length) {
      for (const part of profile.path.split(',')) {
        if (windowPath.toLowerCase().indexOf(part.trim().toLowerCase()) > -1) {
          foundProfile = profile
        }
      }
    }
  }
  return foundProfile
}

module.exports = { matchWindowToProfile }
