"use strict"

const { getWhitePointForKelvin } = require("./color-temperature")

// Knee and compression strength are in linear sRGB
const HIGHLIGHT_KNEE = 0.22
const HIGHLIGHT_COMPRESSION_STRENGTH = 4

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

// Windows rejects ramps where any entry deviates more than this from the identity ramp
const WIN_GAMMA_DEVIATION = 32768

function identityRampValue(i) {
  return Math.round(65535 * i / 255)
}

function finalizeGammaRamp(ramp) {
  for (const offset of [0, 256, 512]) {
    for (let i = 0; i < 256; i++) {
      const idx = offset + i
      const identity = identityRampValue(i)
      const min = Math.max(0, identity - WIN_GAMMA_DEVIATION)
      const max = Math.min(65535, identity + WIN_GAMMA_DEVIATION)
      ramp[idx] = Math.max(min, Math.min(max, ramp[idx]))
    }
  }

  for (const offset of [0, 256, 512]) {
    for (let i = 1; i < 256; i++) {
      const cur = offset + i
      const prev = cur - 1
      if (ramp[cur] <= ramp[prev]) ramp[cur] = Math.min(65535, ramp[prev] + 1)
    }
  }
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

  finalizeGammaRamp(ramp)

  return ramp
}

function buildSimpleColorTempRamp(kelvin) {
  const { r, g, b } = getWhitePointForKelvin(kelvin)
  const ramp = new Uint16Array(256 * 3)
  const bScale = Math.max(b, 1 / 65535)

  for (let i = 0; i < 256; i++) {
    const v = identityRampValue(i)
    ramp[i] = Math.min(65535, Math.round(v * r))
    ramp[i + 256] = Math.min(65535, Math.round(v * g))
    ramp[i + 512] = Math.min(65535, Math.round(v * bScale))
  }

  finalizeGammaRamp(ramp)
  return ramp
}

module.exports = { buildGammaRamp, buildSimpleColorTempRamp, highlightCurve }
