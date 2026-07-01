// Pure logic for "Time of Day Adjustments" (scheduled brightness/color events).
//
// Extracted from electron.js so it can be unit tested without the Electron runtime.
// Every function is dependency-free: it takes the event list and the current
// time-of-day (in minutes since midnight) as input and returns a result. No module
// globals, no side effects. Anything ambient (SunCalc, the current Date) is injected
// as a parameter so it stays testable. The Electron side passes
// `settings.adjustmentTimes`, the current minute-of-day, and a `getSunCalcTime`
// resolver for sun-relative events.

const Utils = require('./Utils')

// Minutes since midnight for a Date (0-1439).
function toNowValue(date = new Date()) {
  return (date.getHours() * 60) + (date.getMinutes() * 1)
}

// Resolve an event's scheduled time string ("HH:MM").
function getEventTime(event, getSunCalcTime) {
  return event.useSunCalc ? getSunCalcTime(event.sunCalc) : event.time
}

function cloneEvent(event, value) {
  const e = Object.assign({}, event)
  e.monitors = Object.assign({}, event.monitors)
  e.monitorsSoftwareDim = Object.assign({}, event.monitorsSoftwareDim)
  e.monitorsKelvin = Object.assign({}, event.monitorsKelvin)
  e.monitorsHighlightWeight = Object.assign({}, event.monitorsHighlightWeight)
  e.value = value
  return e
}

// Get the currently applicable Time of Day Adjustment for `nowValue`.
// If no event has occurred yet today (now is before the first event), the active
// event is the last one from yesterday, which is still in effect overnight.
function getCurrentAdjustmentEvent(adjustmentTimes = [], nowValue = 0, getSunCalcTime = () => "12:00") {
  let foundEvent = false
  let latestEvent = false // Last event of the day, used to wrap around midnight

  try {
    for (let event of adjustmentTimes) {
      const eventValue = Utils.parseTime(getEventTime(event, getSunCalcTime))

      // Most recent event that is not later than now.
      if (eventValue <= nowValue) {
        if (foundEvent === false || foundEvent.value <= eventValue) {
          foundEvent = cloneEvent(event, eventValue)
        }
      }

      // Track the latest event of the day for the midnight wrap-around fallback.
      if (latestEvent === false || latestEvent.value <= eventValue) {
        latestEvent = cloneEvent(event, eventValue)
      }
    }
  } catch (e) {
    console.log("Error getting adjustment times!", e)
  }

  if (foundEvent === false) return latestEvent
  return foundEvent
}

// Get the next upcoming event after the current one. Wraps around midnight by
// falling back to the earliest event of the day.
function getNextAdjustmentEvent(adjustmentTimes = [], nowValue = 0, getSunCalcTime = () => "12:00") {
  const currentEvent = getCurrentAdjustmentEvent(adjustmentTimes, nowValue, getSunCalcTime)
  if (!currentEvent) return false

  let earliestEvent = false
  let closestEvent = false

  try {
    for (let event of adjustmentTimes) {
      const eventValue = Utils.parseTime(getEventTime(event, getSunCalcTime))

      // Closest event later than the current one.
      if (eventValue > currentEvent.value && (!closestEvent || eventValue < closestEvent.value)) {
        closestEvent = cloneEvent(event, eventValue)
      }

      // Earliest event overall.
      if (!earliestEvent || eventValue < earliestEvent.value) {
        earliestEvent = cloneEvent(event, eventValue)
      }
    }
  } catch (e) {
    console.log("Error getting adjustment times!", e)
  }

  return (closestEvent ? closestEvent : earliestEvent)
}

// Interpolate (LERP) between the current and next event based on progress through
// the interval. Returns an object with brightness, softwareDim, kelvin, highlightWeight
// (and per-monitor variants when individualDisplays is true), or false when interpolation
// isn't possible.
function getCurrentAdjustmentEventLERP(adjustmentTimes = [], nowValue = 0, individualDisplays = false, getSunCalcTime = () => "12:00") {
  try {
    const current = getCurrentAdjustmentEvent(adjustmentTimes, nowValue, getSunCalcTime)
    const next = getNextAdjustmentEvent(adjustmentTimes, nowValue, getSunCalcTime)

    if (!current || !next) return false

    let now = nowValue

    if (current.value > next.value) {
      next.value += 1440 // Add 24hr if next event is tomorrow
      if (now < current.value) now += 1440 // Also adjust now if we've crossed midnight
    }

    // No interval to interpolate over (e.g. a single event resolves current === next).
    // Bail out so we don't divide by zero and return NaN.
    if (next.value === current.value) return false

    // Calculate 0-1 percentage of progress
    const lerpValues = {
      next: next.value - current.value,
      current: current.value - current.value,
      now: now - current.value
    }
    lerpValues.progress = lerpValues.next - lerpValues.now
    lerpValues.end = lerpValues.next
    lerpValues.percent = 1 - (lerpValues.progress / lerpValues.end)

    const p = lerpValues.percent

    // Brightness and software dim are two halves of ONE -100..100 axis: positive = hardware
    // brightness (overlay off), negative = software dim overlay (hardware at 0). They're
    // mutually exclusive in the UI/apply model. Interpolate the COMBINED value (brightness -
    // softwareDim) and split it back, so a transition that crosses zero (e.g. brightness 100
    // -> dim 70) never applies hardware brightness and overlay dim at the same time — which
    // would dim the screen while the panel still shows a positive value.
    const lerpCombined = (curBri, curDim, nextBri, nextDim) => {
      const v = Utils.lerp((curBri ?? 0) - (curDim ?? 0), (nextBri ?? 0) - (nextDim ?? 0), p)
      return { brightness: Math.round(Math.max(0, v)), softwareDim: Math.round(v < 0 ? -v : 0) }
    }

    const combined = lerpCombined(current.brightness, current.softwareDim, next.brightness, next.softwareDim)

    const result = {
      brightness: combined.brightness,
      softwareDim: combined.softwareDim,
      kelvin: Math.round(Utils.lerp(current.kelvin ?? 6500, next.kelvin ?? 6500, p)),
      highlightWeight: Math.round(Utils.lerp(current.highlightWeight ?? 0, next.highlightWeight ?? 0, p)),
    }

    if (individualDisplays) {
      // Combine each monitor's brightness/dim on the same single axis as the flat value.
      // Monitors whose current brightness override is unset (< 0, the -1 sentinel) are left
      // untouched so they fall back to the (already-combined) flat value downstream.
      const monitors = Object.assign({}, current.monitors)
      const monitorsSoftwareDimCombined = {}
      const combineKeys = new Set([
        ...Object.keys(current.monitors ?? {}),
        ...Object.keys(next.monitors ?? {}),
        ...Object.keys(current.monitorsSoftwareDim ?? {}),
        ...Object.keys(next.monitorsSoftwareDim ?? {}),
      ])
      combineKeys.forEach(key => {
        const curBri = (current.monitors ?? {})[key]
        if (!(curBri > -1)) return // unset -> keep sentinel / absent, falls back to flat
        const nextBriRaw = (next.monitors ?? {})[key]
        const nextBri = (nextBriRaw > -1) ? nextBriRaw : curBri
        const curDim = (current.monitorsSoftwareDim ?? {})[key] ?? current.softwareDim ?? 0
        const nextDim = (next.monitorsSoftwareDim ?? {})[key] ?? next.softwareDim ?? 0
        const c = lerpCombined(curBri, curDim, nextBri, nextDim)
        monitors[key] = c.brightness
        monitorsSoftwareDimCombined[key] = c.softwareDim
      })
      result.monitors = monitors
      if (Object.keys(monitorsSoftwareDimCombined).length) result.monitorsSoftwareDim = monitorsSoftwareDimCombined

      const lerpPerMonitor = (currentMap, nextMap, fallbackCurrent, fallbackNext) => {
        const keys = new Set([...Object.keys(currentMap ?? {}), ...Object.keys(nextMap ?? {})])
        if (!keys.size) return undefined
        const out = {}
        keys.forEach(key => {
          const c = (currentMap ?? {})[key] ?? fallbackCurrent
          const n = (nextMap ?? {})[key] ?? fallbackNext
          out[key] = Math.round(Utils.lerp(c, n, p))
        })
        return out
      }

      const monitorsKelvin = lerpPerMonitor(current.monitorsKelvin, next.monitorsKelvin, current.kelvin ?? 6500, next.kelvin ?? 6500)
      if (monitorsKelvin) result.monitorsKelvin = monitorsKelvin

      const monitorsHighlightWeight = lerpPerMonitor(current.monitorsHighlightWeight, next.monitorsHighlightWeight, current.highlightWeight ?? 0, next.highlightWeight ?? 0)
      if (monitorsHighlightWeight) result.monitorsHighlightWeight = monitorsHighlightWeight
    }

    return result
  } catch (e) {
    console.log("Error generating Adjustment Time LERP", e)
    return false
  }
}

// Resolve a sun-relative time ("HH:MM") for an event's `sunCalc` name. SunCalc
// and the date are injected so this stays testable; the Electron side passes the
// real `suncalc` module plus the user's latitude/longitude.
function getSunCalcTime(SunCalc, latitude, longitude, timeName = "solarNoon", date = new Date()) {
  const localTimes = SunCalc.getTimes(date, latitude, longitude)
  const time = new Date(localTimes[timeName])
  return `${time.getHours()}:${time.getMinutes().toString().padStart(2, '0')}`
}

// Build the per-monitor color updates a scheduled event implies, honouring the
// temperature/highlight enable flags and per-display overrides in `settings`.
// Returns an object with `kelvin` and/or `highlightWeight`, or {} when the
// feature is off or there is no event.
function getScheduledColorForMonitor(monitor, foundEvent, settings = {}) {
  const updates = {}
  if (!foundEvent) return updates

  if (settings.adjustmentTimeTemperatureEnabled) {
    let kelvin = foundEvent.kelvin ?? 6500
    if (settings.adjustmentTimeIndividualDisplays && foundEvent.monitorsKelvin?.[monitor.id] != null) {
      kelvin = foundEvent.monitorsKelvin[monitor.id]
    }
    updates.kelvin = kelvin
  }

  if (settings.adjustmentTimeHighlightCompressionEnabled) {
    let highlight = foundEvent.highlightWeight ?? 0
    if (settings.adjustmentTimeIndividualDisplays && foundEvent.monitorsHighlightWeight?.[monitor.id] != null) {
      highlight = foundEvent.monitorsHighlightWeight[monitor.id]
    }
    updates.highlightWeight = highlight
  }

  return updates
}

module.exports = {
  toNowValue,
  getCurrentAdjustmentEvent,
  getNextAdjustmentEvent,
  getCurrentAdjustmentEventLERP,
  getSunCalcTime,
  getScheduledColorForMonitor
}
