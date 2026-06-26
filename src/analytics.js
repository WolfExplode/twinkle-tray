// Analytics: a self-contained GA4 page-view pinger, extracted from electron.js.
// Owns the ping throttle and the repeating interval that used to be electron.js
// module globals (lastAnalyticsPing, analyticsInterval, analyticsFrequency).
//
// Dependencies are injected via createAnalytics(deps) (same pattern as the other
// extracted subsystems). The ga4-mp client is created per-send and reads the
// current uuid from the live settings slice at call time.

const GA4_API_SECRET = "Y1YTliQdTL-moveI0z1TLA"
const GA4_MEASUREMENT_ID = "G-BQ22ZK4BPY"

// Ping every 29 minutes; skip a ping if one fired under 28 minutes ago so an
// extra start()/ping() can't double-count a session.
const FREQUENCY_MS = 1000 * 60 * 29
const MIN_GAP_MS = 1000 * 60 * 28

function createAnalytics(deps) {
  const {
    settings,        // live settings slice (for settings.uuid)
    logger,
    appName,         // app.name
    appVersion,
    appBuild
  } = deps

  let interval = null
  let lastPing = 0

  function ping() {
    // Skip if too recent
    if (Date.now() < lastPing + MIN_GAP_MS) return false

    const client = require('ga4-mp').createClient(GA4_API_SECRET, GA4_MEASUREMENT_ID, settings.uuid)
    logger.debug("\x1b[34mAnalytics:\x1b[0m sending with UUID " + settings.uuid)

    client.send([{
      name: "page_view",
      params: {
        page_location: appName + "/" + "v" + appVersion + "/" + (appBuild ? appBuild : ""),
        page_title: appName + "/" + "v" + appVersion,
        page_referrer: appName,
        os_version: require("os").release(),
        app_type: appName,
        app_version: appVersion,
        engagement_time_msec: 1
      }
    }])
    lastPing = Date.now()
  }

  // Ping now and keep pinging on the frequency interval. Idempotent — clears any
  // existing interval first.
  function start() {
    ping()
    stop()
    interval = setInterval(ping, FREQUENCY_MS)
  }

  function stop() {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
  }

  return { ping, start, stop }
}

module.exports = { createAnalytics }
