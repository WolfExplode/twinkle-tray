"use strict"

const { getWhitePointForKelvin } = require("./color-temperature")

const HIGHLIGHT_KNEE = 0.6
const HIGHLIGHT_STRENGTH = 1.0

function highlightCurve(x, knee = HIGHLIGHT_KNEE, strength = HIGHLIGHT_STRENGTH) {
  if (x <= knee) return x
  const t = (x - knee) / (1 - knee)
  const compressed = knee + (1 - knee) * (t / (1 + strength * t))
  return compressed
}

function buildGammaRamp({ kelvin = 6500, highlightWeight = 0 } = {}) {
  const { r, g, b } = getWhitePointForKelvin(kelvin)
  const weight = Math.max(0, Math.min(1, highlightWeight))
  const ramp = new Uint16Array(256 * 3)

  for (let i = 0; i < 256; i++) {
    const x = i / 255
    const compressed = highlightCurve(x)
    const y = x * (1 - weight) + compressed * weight
    const v = Math.min(65535, Math.round(y * 65535))
    ramp[i] = Math.min(65535, Math.round(v * r))
    ramp[i + 256] = Math.min(65535, Math.round(v * g))
    ramp[i + 512] = Math.min(65535, Math.round(v * b))
  }

  return ramp
}

module.exports = { buildGammaRamp, highlightCurve }
