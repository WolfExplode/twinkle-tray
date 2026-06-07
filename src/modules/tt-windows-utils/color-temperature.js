"use strict"

// Normalized white-point ratios from Redshift (Ingo Thies), 500K steps, 6500K = daylight
const whitepoints = [
  { r: 1.0, g: 0.18172716, b: 0.0 },
  { r: 1.0, g: 0.42322816, b: 0.0 },
  { r: 1.0, g: 0.54360078, b: 0.08679949 },
  { r: 1.0, g: 0.64373109, b: 0.28819679 },
  { r: 1.0, g: 0.71976951, b: 0.42860152 },
  { r: 1.0, g: 0.77987699, b: 0.54642268 },
  { r: 1.0, g: 0.82854786, b: 0.64816570 },
  { r: 1.0, g: 0.86860704, b: 0.73688797 },
  { r: 1.0, g: 0.90198230, b: 0.81465502 },
  { r: 1.0, g: 0.93853986, b: 0.88130458 },
  { r: 1.0, g: 0.97107439, b: 0.94305985 },
  { r: 1.0, g: 1.0, b: 1.0 },
]

function getWhitePointForKelvin(temp) {
  temp = Math.max(3000, Math.min(6500, temp))
  const t = (temp - 1000) / 500
  const i = Math.floor(t)
  const ratio = t - i
  const p0 = whitepoints[i]
  const p1 = whitepoints[Math.min(i + 1, whitepoints.length - 1)]
  return {
    r: p0.r * (1 - ratio) + p1.r * ratio,
    g: p0.g * (1 - ratio) + p1.g * ratio,
    b: p0.b * (1 - ratio) + p1.b * ratio,
  }
}

module.exports = { getWhitePointForKelvin }
