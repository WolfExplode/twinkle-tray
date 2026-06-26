// Time-of-Day schedule resolver. The pure rule-matching lives in
// ./adjustmentTimes.js; this thin module binds those pure functions to the live
// `settings` object and the `SunCalc` library so callers can ask "what colour /
// brightness does the schedule want right now?" without re-supplying that context.
//
// Created with createSchedule(deps) (same DI pattern as the other subsystems) and
// injected downward into electron.js and displayColor. It owns no state and holds
// no back-edges — its only dependencies are the pure module, the settings object,
// and SunCalc — so both callers share one binding rather than each closing over
// electron.js internals.

function createSchedule(deps) {
  const { AdjustmentTimes, settings, SunCalc } = deps

  // Resolve a sun-relative time (e.g. "sunset") to a "HH:MM" string using the
  // configured latitude/longitude.
  function getSunCalcTime(timeName = "solarNoon") {
    return AdjustmentTimes.getSunCalcTime(SunCalc, settings.adjustmentTimeLatitude, settings.adjustmentTimeLongitude, timeName)
  }

  // The currently-applicable Time of Day adjustment event (or false/none).
  function getCurrentAdjustmentEvent() {
    return AdjustmentTimes.getCurrentAdjustmentEvent(settings.adjustmentTimes, AdjustmentTimes.toNowValue(), getSunCalcTime)
  }

  // Same, but interpolated between the surrounding events for smooth ramps.
  function getCurrentAdjustmentEventLERP() {
    return AdjustmentTimes.getCurrentAdjustmentEventLERP(settings.adjustmentTimes, AdjustmentTimes.toNowValue(), settings.adjustmentTimeIndividualDisplays, getSunCalcTime)
  }

  // The scheduled colour (kelvin / highlightWeight) a given monitor should take
  // for the supplied event.
  function getScheduledColorForMonitor(monitor, foundEvent) {
    return AdjustmentTimes.getScheduledColorForMonitor(monitor, foundEvent, settings)
  }

  return { getSunCalcTime, getCurrentAdjustmentEvent, getCurrentAdjustmentEventLERP, getScheduledColorForMonitor }
}

module.exports = { createSchedule }
