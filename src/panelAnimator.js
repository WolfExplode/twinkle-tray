// Brightness-panel open animation, extracted from electron.js. Owns the timed
// opacity LERP loop and all of the per-animation runtime state that used to be
// electron.js module globals (the interval handle, the should/is animating
// flags, the hrtime bookkeeping).
//
// The window used to also resize during the open animation, but that path went
// through a native setWindowPos binding that has since been stubbed out, so only
// the opacity fade has any effect. The dead height-LERP geometry was removed.
//
// Dependencies are injected via createPanelAnimator(deps) (same pattern as the
// other extracted subsystems). The panel lifecycle — showing/hiding the window,
// vibrancy, positioning — stays in electron.js; it calls start() when the panel
// opens and stop() when the panel hides.
//
// Animation logic borrowed in part from @djsweet.

function createPanelAnimator(deps) {
  const {
    getMainWindow,
    settings,
    refreshCtx,
    repositionPanel
  } = deps

  const PANEL_TRANSITION_TIME = 0.35

  let panelAnimationInterval = false
  let shouldAnimatePanel = false
  let isAnimatingPanel = false
  let currentPanelTime = 0
  let startPanelTime = process.hrtime.bigint()
  let lastPanelTime = process.hrtime.bigint()
  let primaryRefreshRate = 59.97

  function hrtimeDeltaForFrequency(freq) {
    return BigInt(Math.ceil(1000000000 / freq))
  }

  function doAnimationStep() {
    // If animation has been requested to stop, kill it
    if (!isAnimatingPanel) {
      clearInterval(panelAnimationInterval)
      panelAnimationInterval = false
      shouldAnimatePanel = false
      return false
    }

    if (currentPanelTime === -1) {
      startPanelTime = process.hrtime.bigint()
      currentPanelTime = 0
    }

    // Limit updates to specific interval
    const now = process.hrtime.bigint()
    if (now > lastPanelTime + hrtimeDeltaForFrequency(primaryRefreshRate * (settings.useAcrylic ? 1 : 2) || 59.97)) {

      lastPanelTime = now
      currentPanelTime = Number(Number(now - startPanelTime) / 1000000000)

      // Check if at end of animation
      if (currentPanelTime >= PANEL_TRANSITION_TIME) {
        // Stop animation
        isAnimatingPanel = false
        shouldAnimatePanel = false
        // Stop at 100%
        currentPanelTime = PANEL_TRANSITION_TIME
        clearInterval(panelAnimationInterval)
        panelAnimationInterval = false
      }

      // LERP opacity
      const calculatedOpacity = (Math.round(Math.min(1, currentPanelTime / (PANEL_TRANSITION_TIME / 6)) * 100) / 100)

      // Stop opacity updates if at 1 already
      const mainWindow = getMainWindow()
      if (mainWindow.getOpacity() < 1)
        mainWindow.setOpacity(calculatedOpacity)
    }

    if (isAnimatingPanel) {
      panelAnimationInterval = setTimeout(doAnimationStep, 1000 / (primaryRefreshRate * (settings.useAcrylic ? 1 : 2) || 59.97))
    } else {
      repositionPanel()
    }
  }

  // Begin the panel opening (opacity fade) animation.
  async function start() {
    if (!shouldAnimatePanel) {
      // Set to animating
      shouldAnimatePanel = true
      isAnimatingPanel = true

      // Reset timing variables
      startPanelTime = process.hrtime.bigint()
      currentPanelTime = -1

      // Get refresh rate of primary display
      // This allows the animation to play no more than the refresh rate
      primaryRefreshRate = await refreshCtx.findVerticalRefreshRateForDisplayPoint(0, 0)

      // Start animation interval after a short delay
      // This avoids jank from React updating the DOM
      if (!panelAnimationInterval)
        setTimeout(() => {
          if (!panelAnimationInterval)
            panelAnimationInterval = setTimeout(doAnimationStep, 1000 / 600)
        }, 100)
    }
  }

  // Halt any running animation and clear its state (used when the panel hides).
  function stop() {
    clearInterval(panelAnimationInterval)
    panelAnimationInterval = false
    shouldAnimatePanel = false
    isAnimatingPanel = false
  }

  function isAnimating() {
    return isAnimatingPanel
  }

  return { start, stop, isAnimating }
}

module.exports = { createPanelAnimator }
