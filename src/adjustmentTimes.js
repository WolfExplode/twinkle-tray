// Pure logic for "Time of Day Adjustments" (scheduled brightness/color events).
//
// Extracted from electron.js so it can be unit tested without the Electron runtime.
// Every function is pure: it takes the event list and the current time-of-day (in
// minutes since midnight) as input and returns a result. No module globals, no Date,
// no side effects. The Electron side passes `settings.adjustmentTimes`, the current
// minute-of-day, and a `getSunCalcTime` resolver for sun-relative events.

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
// the interval. Returns a brightness number, or a per-monitor object when displays
// are individually controlled, or false when interpolation isn't possible.
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

    // Generate result depending on if displays are linked
    if (individualDisplays) {
      const keys = Object.keys(next.monitors)
      const monitors = Object.assign({}, current.monitors)
      keys.forEach(key => {
        if (monitors[key] > -1) {
          monitors[key] = Math.round(Utils.lerp(current.monitors[key], next.monitors[key], lerpValues.percent))
        }
      })
      return monitors
    } else {
      return Math.round(Utils.lerp(current.brightness, next.brightness, lerpValues.percent))
    }
  } catch (e) {
    console.log("Error generating Adjustment Time LERP", e)
    return false
  }
}

module.exports = {
  toNowValue,
  getCurrentAdjustmentEvent,
  getNextAdjustmentEvent,
  getCurrentAdjustmentEventLERP
}
