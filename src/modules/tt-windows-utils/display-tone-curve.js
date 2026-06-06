"use strict"

const { getWhitePointForKelvin } = require("./color-temperature")

// Knee and compression strength are in linear sRGB
const HIGHLIGHT_KNEE = 0.25
const HIGHLIGHT_COMPRESSION_STRENGTH = 1.5

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearToSrgb(c) {
  c = Math.max(0, Math.min(1, c))
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

function highlightCurve(x, knee = HIGHLIGHT_KNEE, compressionStrength = HIGHLIGHT_COMPRESSION_STRENGTH) {
  if (x <= knee) return x
  const t = (x - knee) / (1 - knee)
  return knee + (1 - knee) * (t / (1 + compressionStrength * t))
}

function buildGammaRamp({ kelvin = 6500, highlightWeight = 0 } = {}) {
  const { r, g, b } = getWhitePointForKelvin(kelvin)
  const weight = Math.max(0, Math.min(1, highlightWeight))
  const ramp = new Uint16Array(256 * 3)

  for (let i = 0; i < 256; i++) {
    const encoded = i / 255
    const linear = srgbToLinear(encoded)
    const compressedLinear = highlightCurve(linear)
    const blendedLinear = linear * (1 - weight) + compressedLinear * weight
    const outEncoded = linearToSrgb(blendedLinear)
    const v = Math.min(65535, Math.round(outEncoded * 65535))
    ramp[i] = Math.min(65535, Math.round(v * r))
    ramp[i + 256] = Math.min(65535, Math.round(v * g))
    ramp[i + 512] = Math.min(65535, Math.round(v * b))
  }

  return ramp
}

module.exports = { buildGammaRamp, highlightCurve }
