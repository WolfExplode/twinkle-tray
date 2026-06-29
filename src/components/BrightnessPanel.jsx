import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import Slider from "./Slider";
import DDCCISliders from "./DDCCISliders"
import HDRSliders from "./HDRSliders";
import TranslateReact from "../TranslateReact"
import getMonitorName from "../utils/BrightnessPanel/getMonitorName";

const BrightnessPanel = memo(function BrightnessPanel() {

  const [state, setState] = useState({
    monitors: [],
    linkedLevelsActive: false,
    manualTemperatureActive: false,
    manualHighlightActive: false,
    adjustmentTimesActive: true,
    hasTimeAdjustments: false,
    names: {},
    update: false,
    sleeping: false,
    updateProgress: 0,
    isRefreshing: window.isRefreshing
  })
  const [doBackgroundEvent, setDoBackgroundEvent] = useState(false)
  const [levelsChanged, setLevelsChanged] = useState(false)
  const [init, setInit] = useState(false)
  const [lastLevels, setLastLevels] = useState([])
  const [softwareDim, setSoftwareDim] = useState({})
  const [kelvinLevels, setKelvinLevels] = useState({})
  const [highlightLevels, setHighlightLevels] = useState({})
  const [scheduleLocked, setScheduleLocked] = useState({ brightness: false, temperature: false, highlight: false })
  const monitorsRef = useRef({})
  // Timestamps until which incoming warmth/highlight echoes are ignored. While a
  // slider is being dragged, updateWarmth/updateHighlightCompression echo the
  // value straight back via *-levels-updated; lagging echoes would clobber the
  // local value mid-drag and make the slider rubber-band. Brightness avoids this
  // because its echo path (refreshMonitors) is gated by pausedMonitorUpdates.
  const colorEchoSuppress = useRef({ warmth: 0, highlight: 0 })
  const COLOR_ECHO_SUPPRESS_MS = 1000
  const [T] = useState(new TranslateReact({}, {}))

  const numMonitors = useMemo(() => {
    let localNumMonitors = 0
    for (let key in state.monitors) {
      if ((state.monitors[key].type != "none" || state.monitors[key].hdr === "active") && !(window.settings?.hideDisplays?.[key] === true)) localNumMonitors++;
    }
    return localNumMonitors
  }, [state.monitors])

  let updateInterval = null
  let panelHeight = -1

  // Enable/Disable linked levels
  const toggleLinkedLevels = () => {
    const linkedLevelsActive = (state.linkedLevelsActive ? false : true)
    setState(prev => ({ ...prev, linkedLevelsActive }))
    window.sendSettings({
      linkedLevelsActive
    })
  }

  const toggleColorTemperature = () => {
    window.toggleColorTemperature(false)
  }

  const toggleHighlightCompression = () => {
    window.toggleHighlightCompression(false)
  }

  const toggleTimeAdjustments = () => {
    window.toggleTimeAdjustments()
  }

  const getKelvinForMonitor = (monitor) => kelvinLevels[monitor.key] ?? 6500

  const getLinkedKelvin = () => {
    for (const key in state.monitors) {
      const monitor = state.monitors[key]
      if (kelvinLevels[monitor.key] != null) return kelvinLevels[monitor.key]
    }
    return 6500
  }

  const handleKelvinChange = (kelvin, monitor, linked = false) => {
    colorEchoSuppress.current.warmth = Date.now() + COLOR_ECHO_SUPPRESS_MS
    if (linked || state.linkedLevelsActive) {
      const newKelvin = {}
      for (let key in state.monitors) {
        const m = state.monitors[key]
        if ((m.type == "none" && m.hdr !== "active") || window.settings?.hideDisplays?.[m.key] === true) continue
        newKelvin[m.key] = kelvin
        window.updateWarmth(m.id, kelvin)
      }
      setKelvinLevels(newKelvin)
    } else if (monitor) {
      setKelvinLevels(prev => ({ ...prev, [monitor.key]: kelvin }))
      window.updateWarmth(monitor.id, kelvin)
    }
  }

  const renderKelvinSlider = (monitor, options = {}) => {
    if (!state.manualTemperatureActive && !scheduleLocked.temperature) return null
    const { linked = false, extended = false, name } = options
    const level = linked ? getLinkedKelvin() : getKelvinForMonitor(monitor)
    const locked = scheduleLocked.temperature
    const slider = (
      <Slider
        key={(monitor?.key || "linked") + ".kelvin"}
        name={name ?? T.t("PANEL_LABEL_COLOR_TEMPERATURE")}
        id={monitor?.id}
        level={level}
        min={3000}
        max={6500}
        hwid={monitor?.key}
        onChange={(val) => handleKelvinChange(val, linked ? null : monitor, linked)}
        scrollAmount={window.settings?.scrollFlyoutAmount}
        disabled={locked}
        lockedTitle={locked ? "Overridden by schedule" : undefined}
      />
    )
    if (extended) {
      return (
        <div className="feature-row feature-temperature" key={(monitor?.key || "linked") + ".kelvin-row"}>
          <div className="feature-icon"><span className="icon vfix">&#xEA80;</span></div>
          {slider}
        </div>
      )
    }
    return slider
  }

  const getHighlightForMonitor = (monitor) => highlightLevels[monitor.key] ?? 0

  const getLinkedHighlight = () => {
    for (const key in state.monitors) {
      const monitor = state.monitors[key]
      if (highlightLevels[monitor.key] != null) return highlightLevels[monitor.key]
    }
    return 0
  }

  const handleHighlightChange = (weight, monitor, linked = false) => {
    colorEchoSuppress.current.highlight = Date.now() + COLOR_ECHO_SUPPRESS_MS
    if (linked || state.linkedLevelsActive) {
      const newHighlight = {}
      for (let key in state.monitors) {
        const m = state.monitors[key]
        if ((m.type == "none" && m.hdr !== "active") || window.settings?.hideDisplays?.[m.key] === true) continue
        newHighlight[m.key] = weight
        window.updateHighlightCompression(m.id, weight)
      }
      setHighlightLevels(newHighlight)
    } else if (monitor) {
      setHighlightLevels(prev => ({ ...prev, [monitor.key]: weight }))
      window.updateHighlightCompression(monitor.id, weight)
    }
  }

  const renderHighlightSlider = (monitor, options = {}) => {
    if (!state.manualHighlightActive && !scheduleLocked.highlight) return null
    const { linked = false, extended = false, name } = options
    const level = linked ? getLinkedHighlight() : getHighlightForMonitor(monitor)
    const locked = scheduleLocked.highlight
    const slider = (
      <Slider
        key={(monitor?.key || "linked") + ".highlight"}
        name={name ?? T.t("PANEL_LABEL_HIGHLIGHT_COMPRESSION")}
        id={monitor?.id}
        level={level}
        min={0}
        max={100}
        hwid={monitor?.key}
        onChange={(val) => handleHighlightChange(val, linked ? null : monitor, linked)}
        scrollAmount={window.settings?.scrollFlyoutAmount}
        disabled={locked}
        lockedTitle={locked ? "Overridden by schedule" : undefined}
      />
    )
    if (extended) {
      return (
        <div className="feature-row feature-highlight" key={(monitor?.key || "linked") + ".highlight-row"}>
          <div className="feature-icon"><span className="icon vfix">&#xE790;</span></div>
          {slider}
        </div>
      )
    }
    return slider
  }

  // Handle <Slider> changes
  // level can be -100..100: negative values mean software dim, 0-100 is hardware brightness
  const handleChange = (level, slider) => {
    const monitors = { ...state.monitors }
    const sliderMonitor = monitors[slider.props.hwid]
    const hardwareLevel = Math.max(0, level)
    const dimLevel = level < 0 ? Math.min(100, -level) : 0

    if (numMonitors && state.linkedLevelsActive) {
      // Update all monitors atomically via group handler — one monitors-updated
      // push so the renderer never sees partial state mid-drag.
      const newDim = {}
      const monitorIds = []
      for (let key in monitors) {
        monitors[key].brightness = hardwareLevel  // optimistic display only
        newDim[key] = dimLevel
        monitorIds.push(monitors[key].id)
      }
      window.ipc.send('update-settings-group', { monitorIds, brightness: hardwareLevel, softwareDim: dimLevel })
      setSoftwareDim(newDim)
      setState(prev => ({ ...prev, monitors }))
    } else if (numMonitors > 0) {
      // Update single monitor
      if (sliderMonitor) {
        sliderMonitor.brightness = hardwareLevel  // optimistic display only
        setSoftwareDim(prev => ({ ...prev, [slider.props.hwid]: dimLevel }))
        window.ipc.send('update-settings', { monitorId: sliderMonitor.id, brightness: hardwareLevel, softwareDim: dimLevel })
      }
      setState(prev => ({ ...prev, monitors }))
    }
  }

  // Update monitor info
  const recievedMonitors = (e) => {
    let newMonitors = { ...e.detail }
    monitorsRef.current = newMonitors
    setLastLevels([])
    // Reset panel height so it's recalculated
    panelHeight = -1

    // Sync software dim state from monitor data (electron.js is the source of truth)
    setSoftwareDim(prev => {
      const updated = { ...prev }
      let changed = false
      for (const key in newMonitors) {
        const incomingDim = newMonitors[key].softwareDim ?? 0
        if (incomingDim !== (updated[key] ?? 0)) {
          updated[key] = incomingDim
          changed = true
        }
        // If hardware brightness came back above 0, also clear any dim
        if (newMonitors[key].brightness > 0 && updated[key] > 0) {
          updated[key] = 0
          window.updateSoftwareDim(newMonitors[key].id, 0)
          changed = true
        }
      }
      return changed ? updated : prev
    })

    setState(prev => ({
      ...prev,
      monitors: newMonitors
    }))
    if (window.settings?.adjustmentTimeTemperatureEnabled) window.requestWarmthLevels?.()
    // Delay initial adjustments
    if (!init) setTimeout(() => { setInit(true) }, 333)
  }

  const updateMinMax = (inMonitors = false) => {
    if (numMonitors > 0) {
      let newMonitors = Object.assign((inMonitors ? inMonitors : state.monitors), {})
      for (let key in newMonitors) {
        for (let remap in state.remaps) {
          if (newMonitors[key].name == remap) {
            newMonitors[key].min = state.remaps[remap].min
            newMonitors[key].max = state.remaps[remap].max
          }
        }
      }
      setLevelsChanged(true)
      if (inMonitors) {
        return inMonitors
      } else {
        setState(prev => ({
          ...prev,
          monitors: newMonitors
        }))
        setDoBackgroundEvent(true)
      }
    }
  }

  // Update settings
  const recievedSettings = (e) => {
    const settings = e.detail
    const linkedLevelsActive = (settings.linkedLevelsActive ?? false)
    const adjustmentTimesActive = (settings.adjustmentTimesActive !== false)
    const hasTimeAdjustments = (settings.adjustmentTimes?.length > 0)
    const sleepAction = (settings.sleepAction ?? "none")
    const updateInterval = (settings.updateInterval || 500) * 1
    const remaps = (settings.remaps || {})
    const names = (settings.names || {})
    setLevelsChanged(true)
    setState(prev => ({
      ...prev,
      linkedLevelsActive,
      adjustmentTimesActive,
      hasTimeAdjustments,
      remaps,
      names,
      updateInterval,
      sleepAction
    }))
    resetBrightnessInterval()
    updateMinMax()
    setDoBackgroundEvent(true)
  }

  const recievedColorToggleState = (e) => {
    const { manualTemperatureActive, manualHighlightActive } = e.detail
    setState(prev => ({ ...prev, manualTemperatureActive, manualHighlightActive }))
    if (manualTemperatureActive) window.requestWarmthLevels?.()
    if (manualHighlightActive) window.requestHighlightLevels?.()
  }

  const recievedScheduleLockState = (e) => {
    setScheduleLocked(e.detail)
    window.requestWarmthLevels?.()
    window.requestHighlightLevels?.()
  }

  const recievedUpdate = (e) => {
    const update = e.detail
    setState(prev => ({ ...prev, update }))
  }

  const recievedSleep = (e) => {
    setState(prev => ({ ...prev, sleeping: e.detail }))
  }

  const recievedWarmthLevels = (e) => {
    if (Date.now() < colorEchoSuppress.current.warmth) return
    const levels = e.detail
    setKelvinLevels(prev => {
      const updated = { ...prev }
      for (const key in monitorsRef.current) {
        const monitor = monitorsRef.current[key]
        if (levels[monitor.id] != null) updated[monitor.key] = levels[monitor.id]
      }
      return updated
    })
  }

  const recievedHighlightLevels = (e) => {
    if (Date.now() < colorEchoSuppress.current.highlight) return
    const levels = e.detail
    setHighlightLevels(prev => {
      const updated = { ...prev }
      for (const key in monitorsRef.current) {
        const monitor = monitorsRef.current[key]
        if (levels[monitor.id] != null) updated[monitor.key] = levels[monitor.id]
      }
      return updated
    })
  }



  // Brightness is now sent directly in handleChange via update-settings IPC.
  // This stub clears the doBackgroundEvent flag so re-renders don't pile up.
  const syncBrightness = () => {
    if (init && (doBackgroundEvent || levelsChanged) && numMonitors) {
      setDoBackgroundEvent(false)
      setLevelsChanged(false)
    }
  }

  const resetBrightnessInterval = () => {
    if (updateInterval) clearInterval(updateInterval)
    updateInterval = setInterval(() => syncBrightness(), (state.updateInterval || 500))
  }

  const handleIsRefreshingUpdate = (e) => setState(prev => ({ ...prev, isRefreshing: e.detail }))
  const handleUpdateProgress = (e) => setState(prev => ({ ...prev, updateProgress: e.detail.progress }))

  useEffect(() => {
    resetBrightnessInterval()
    return () => {
      clearInterval(updateInterval)
    }
  }, [state.monitors, numMonitors, doBackgroundEvent, levelsChanged, init])


  useEffect(() => {
    window.addEventListener("monitorsUpdated", (e) => recievedMonitors(e))
    window.addEventListener("settingsUpdated", (e) => recievedSettings(e))
    window.addEventListener("localizationUpdated", (e) => T.setLocalizationData(e.detail.desired, e.detail.default))
    window.addEventListener("updateUpdated", (e) => recievedUpdate(e))
    window.addEventListener("sleepUpdated", (e) => recievedSleep(e))
    window.addEventListener("warmthLevelsUpdated", (e) => recievedWarmthLevels(e))
    window.addEventListener("highlightLevelsUpdated", (e) => recievedHighlightLevels(e))
    window.addEventListener("colorToggleStateUpdated", (e) => recievedColorToggleState(e))
    window.addEventListener("scheduleLockStateUpdated", (e) => recievedScheduleLockState(e))
    window.addEventListener("isRefreshing", (e) => handleIsRefreshingUpdate(e))

    if (window.isAppX === false) {
      window.addEventListener("updateProgress", (e) => handleUpdateProgress(e))
    }

    // Update brightness every interval, if changed
    window.requestSettings()
    window.requestMonitors()
    window.requestColorToggleState?.()
    window.requestScheduleLockState?.()
    window.ipc.send('request-localization')
    window.reactReady = true

    return () => {
      window.removeEventListener("monitorsUpdated")
      window.removeEventListener("settingsUpdated")
      window.removeEventListener("localizationUpdated")
      window.removeEventListener("updateUpdated")
      window.removeEventListener("sleepUpdated")
      window.removeEventListener("warmthLevelsUpdated")
      window.removeEventListener("highlightLevelsUpdated")
      window.removeEventListener("colorToggleStateUpdated")
      window.removeEventListener("scheduleLockStateUpdated")
      window.removeEventListener("isRefreshing")
      window.removeEventListener("updateProgress")
    }
  }, [])

  useEffect(() => {
    const height = window.document.getElementById("panel").offsetHeight
    if (panelHeight != height) {
      panelHeight = height
      window.sendHeight(height)
    }
  })

  const getMonitors = () => {
    if (!state.monitors || numMonitors == 0) {
      if (state.isRefreshing) {
        return (<div className="no-displays-message" style={{ textAlign: "center", paddingBottom: "15px" }}>{T.t("GENERIC_DETECTING_DISPLAYS")}</div>)
      }
      return (<div className="no-displays-message">{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}</div>)
    } else {
      if (state.linkedLevelsActive) {
        // Combine all monitors — prefer one that is not inactive-dimmed so the
        // slider shows the intended brightness, not the dim level.
        let lastValidMonitor
        const validMonitors = []
        for(const key in state.monitors) {
          const monitor = state.monitors[key]
          if(monitor.type == "wmi" || monitor.type == "studio-display" || (monitor.type == "ddcci" && monitor.brightnessType) || monitor.hdr === "active") {
            if (window.settings?.hideDisplays?.[monitor.key] !== true) {
              validMonitors.push(monitor)
              if (!lastValidMonitor || !monitor.inactiveDimmed) lastValidMonitor = monitor
            }
          }
        }
        if (validMonitors.length > 0) {
          const softwareDimMin = -(window.settings?.softwareDimMax ?? 100)

          // Compute the effective level (hardware brightness minus software dim overlay)
          // for each monitor so we can group them.
          const monitorLevels = validMonitors.map(m => {
            const mDim = softwareDim[m.key] ?? 0
            const level = (mDim > 0 && m.brightness === 0) ? -mDim : m.brightness
            return { monitor: m, level }
          })

          // Group monitors by level.
          const levelGroups = new Map()
          for (const entry of monitorLevels) {
            if (!levelGroups.has(entry.level)) levelGroups.set(entry.level, [])
            levelGroups.get(entry.level).push(entry)
          }

          // "All Displays" label applies when all monitors agree (any size group),
          // or when the largest group has 2+ members. If every monitor has a unique
          // level there is no "All Displays" row — each monitor is named individually.
          let allDisplaysGroup = null
          if (levelGroups.size === 1) {
            allDisplaysGroup = monitorLevels
          } else {
            for (const group of levelGroups.values()) {
              if (group.length >= 2 && (!allDisplaysGroup || group.length > allDisplaysGroup.length)) {
                allDisplaysGroup = group
              }
            }
          }

          const allDisplaysLevel = allDisplaysGroup?.[0]?.level
          const representativeMonitor = allDisplaysGroup?.[0]?.monitor
          const namedEntries = allDisplaysGroup
            ? monitorLevels.filter(e => !allDisplaysGroup.includes(e))
            : monitorLevels
          const kelvinRef = representativeMonitor ?? validMonitors[0]

          return (
            <>
              {allDisplaysGroup && (
                <Slider name={T.t("GENERIC_ALL_DISPLAYS")} id={representativeMonitor.id} level={allDisplaysLevel} min={softwareDimMin} max={100} num={representativeMonitor.num} monitortype={representativeMonitor.type} hwid={representativeMonitor.key} key={representativeMonitor.key} onChange={handleChange} scrollAmount={window.settings?.scrollFlyoutAmount} disabled={scheduleLocked.brightness} lockedTitle={scheduleLocked.brightness ? "Overridden by schedule" : undefined} ghostLevel={representativeMonitor.preDimBrightness} />
              )}
              {renderKelvinSlider(kelvinRef, { linked: true, name: T.t("PANEL_LABEL_COLOR_TEMPERATURE") })}
              {renderHighlightSlider(kelvinRef, { linked: true, name: T.t("PANEL_LABEL_HIGHLIGHT_COMPRESSION") })}
              {namedEntries.length > 0 && (
                <div className="linked-diverged">
                  {namedEntries.map(({ monitor: m, level: mLevel }) => (
                    <div className="monitor-sliders" key={m.key}>
                      <Slider name={getMonitorName(m, state.names)} id={m.id} level={mLevel} min={softwareDimMin} max={100} num={m.num} monitortype={m.type} hwid={m.key} onChange={handleChange} scrollAmount={window.settings?.scrollFlyoutAmount} disabled={scheduleLocked.brightness} lockedTitle={m.ghostMarkerSource === 'idle' ? "Overridden by idle dim" : m.ghostMarkerSource === 'inactive' ? "Overridden by inactive monitor dim" : scheduleLocked.brightness ? "Overridden by schedule" : undefined} ghostLevel={m.ghostMarkerActive ? m.canonicalBrightness : undefined} />
                    </div>
                  ))}
                </div>
              )}
            </>
          )
        }
        return (<div className="no-displays-message">{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}</div>)
      } else {
        // Show all valid monitors individually
        const sorted = Object.values(state.monitors).slice(0).sort((a, b) => {
          const aSort = (a.order === undefined ? 999 : a.order * 1)
          const bSort = (b.order === undefined ? 999 : b.order * 1)
          return aSort - bSort
        })
        let useFeatures = false
        // Check if we should use the extended DDC/CI layout or simple layout
        for (const { hwid } of sorted) {
          const monitorFeatures = window.settings?.monitorFeatures?.[hwid[1]]
          for (const vcp in monitorFeatures) {
            if (vcp == "0x10" || vcp == "0x13" || vcp == "0xD6") {
              continue; // Skip if brightness or power state
            }
            const feature = monitorFeatures[vcp]
            if (feature) {
              // Feature is active
              // Now we check if there are any settings active for the feature
              const featureSettings = window.settings.monitorFeaturesSettings?.[hwid[1]]
              if (!(featureSettings?.[vcp]?.linked)) {
                // Isn't linked
                useFeatures = true
              }
            }
          }
        }

        return sorted.map((monitor) => {
          if ((monitor.type == "none" && monitor.hdr !== "active") || window.settings?.hideDisplays?.[monitor.key] === true) {
            return (<div key={monitor.key}></div>)
          } else {
            if (monitor.type == "wmi" || monitor.type == "studio-display" || (monitor.type == "ddcci" && monitor.brightnessType) || monitor.hdr === "active") {

              let hasFeatures = true
              let featureCount = 0
              const monitorFeatures = window.settings?.monitorFeatures?.[monitor.hwid[1]]
              const features = ["0x12", "0xD6", "0x62"]
              if (monitor.features) {
                features.forEach(f => {
                  // Check monitor features
                  if (monitor.features[f] && monitor.features[f].length > 1) {
                    // Check that user has enabled feature
                    if (monitorFeatures && monitorFeatures[f]) {
                      // Track feature
                      hasFeatures = true
                      featureCount++
                    }
                  }
                })
              }
              let showHDRSliders = false
              if((monitor.hdr === "active" || window.settings?.hdrDisplays?.[monitor.key]) && !(window.settings?.sdrAsMainSliderDisplays?.[monitor.key])) {
                // Has HDR slider enabled
                hasFeatures = true
                useFeatures = true
                showHDRSliders = true
              }
              const powerOff = () => {
                window.ipc.send("sleep-display", monitor.hwid.join("#"))
                monitor.features["0xD6"][0] = (monitor.features["0xD6"][0] >= 4 ? 1 : settings.ddcPowerOffValue)
              }
              const showPowerButton = () => {
                const customFeatureEnabled = window.settings?.monitorFeaturesSettings?.[monitor?.hwid[1]]?.["0xD6"]
                if (monitorFeatures?.["0xD6"] && (monitor.features?.["0xD6"] || customFeatureEnabled)) {
                  return (<div className="feature-power-icon simple" onClick={powerOff}><span className="icon vfix">&#xE7E8;</span><span>{(monitor.features?.["0xD6"][0] >= 4 ? T.t("PANEL_LABEL_TURN_ON") : T.t("PANEL_LABEL_TURN_OFF"))}</span></div>)
                }
              }

              // Check if it's an HDR display and only supports SDR brightness adjustment.
              const isHDROnlySDR = (monitor.hdr === "active" || monitor.hdr === "supported") && monitor.type === "none";
              
              if (!useFeatures || !hasFeatures) {
                // For HDR displays that only support SDR, the HDR slider is displayed directly instead of the regular brightness slider.
                if (isHDROnlySDR) {
                  return (
                    <div className="monitor-sliders extended" key={monitor.key}>
                      <div className="monitor-item" style={{ height: "auto", paddingBottom: "18px" }}>
                        <div className="name-row">
                          <div className="icon"><span>&#xE7F4;</span></div>
                          <div className="title">{getMonitorName(monitor, state.names)}</div>
                          { showPowerButton() }
                        </div>
                      </div>
                      <HDRSliders monitor={monitor} scrollAmount={window.settings?.scrollFlyoutAmount} />
                      {renderKelvinSlider(monitor, { extended: true })}
                      {renderHighlightSlider(monitor, { extended: true })}
                    </div>
                  )
                }
                const monDim = softwareDim[monitor.key] ?? 0
                const monLevel = (monDim > 0 && monitor.brightness === 0) ? -monDim : monitor.brightness
                const monSoftwareDimMin = -(window.settings?.softwareDimMax ?? 100)
                return (
                  <div className="monitor-sliders" key={monitor.key}>
                    <Slider name={getMonitorName(monitor, state.names)} id={monitor.id} level={monLevel} min={monSoftwareDimMin} max={100} num={monitor.num} monitortype={monitor.type} hwid={monitor.key} key={monitor.key} onChange={handleChange} afterName={showPowerButton()} scrollAmount={window.settings?.scrollFlyoutAmount} disabled={scheduleLocked.brightness} lockedTitle={monitor.ghostMarkerSource === 'idle' ? "Overridden by idle dim" : monitor.ghostMarkerSource === 'inactive' ? "Overridden by inactive monitor dim" : scheduleLocked.brightness ? "Overridden by schedule" : undefined} ghostLevel={monitor.ghostMarkerActive ? monitor.canonicalBrightness : undefined} />
                    {renderKelvinSlider(monitor)}
                    {renderHighlightSlider(monitor)}
                  </div>
                )
              } else {
                return (
                  <div className="monitor-sliders extended" key={monitor.key}>
                    <div className="monitor-item" style={{ height: "auto", paddingBottom: "18px" }}>
                      <div className="name-row">
                        <div className="icon">{(monitor.type == "wmi" ? <span>&#xE770;</span> : <span>&#xE7F4;</span>)}</div>
                        <div className="title">{getMonitorName(monitor, state.names)}</div>
                        {showPowerButton()}
                      </div>
                    </div>
                    {/* For HDR displays that only support SDR, hide the regular brightness slider. */}
                    { !isHDROnlySDR && (() => {
                      const extDim = softwareDim[monitor.key] ?? 0
                      const extLevel = (extDim > 0 && monitor.brightness === 0) ? -extDim : monitor.brightness
                      const extSoftwareDimMin = -(window.settings?.softwareDimMax ?? 100)
                      return (
                        <div className="feature-row feature-brightness">
                          <div className="feature-icon"><span className="icon vfix">&#xE706;</span></div>
                          <Slider id={monitor.id} level={extLevel} min={extSoftwareDimMin} max={100} num={monitor.num} monitortype={monitor.type} hwid={monitor.key} key={monitor.key} onChange={handleChange} scrollAmount={window.settings?.scrollFlyoutAmount} disabled={scheduleLocked.brightness} lockedTitle={monitor.ghostMarkerSource === 'idle' ? "Overridden by idle dim" : monitor.ghostMarkerSource === 'inactive' ? "Overridden by inactive monitor dim" : scheduleLocked.brightness ? "Overridden by schedule" : undefined} ghostLevel={monitor.ghostMarkerActive ? monitor.canonicalBrightness : undefined} />
                        </div>
                      )
                    })()}
                    {renderKelvinSlider(monitor, { extended: true })}
                    {renderHighlightSlider(monitor, { extended: true })}
                    <DDCCISliders monitor={monitor} monitorFeatures={monitorFeatures} scrollAmount={window.settings?.scrollFlyoutAmount} />
                    {showHDRSliders ? <HDRSliders monitor={monitor} scrollAmount={window.settings?.scrollFlyoutAmount} /> : null}
                  </div>
                )
              }
            }
          }
        })
      }
    }
  }

  return (
    <div className="window-base" data-theme={window.settings.theme || "default"} id="panel" data-refreshing={state.isRefreshing}>
      <div className="titlebar">
        <div className="title">{T.t("PANEL_TITLE")}</div>
        <div className="icons">
          {
            numMonitors > 1 &&
            <div
              title={T.t("PANEL_BUTTON_LINK_LEVELS")}
              data-active={state.linkedLevelsActive}
              onClick={toggleLinkedLevels}
              className="link">
              &#xE71B;
            </div>
          }
          <div
            title={T.t("PANEL_LABEL_COLOR_TEMPERATURE")}
            data-active={state.manualTemperatureActive}
            onClick={toggleColorTemperature}
            className="temp">
            &#xEA80;
          </div>
          <div
            title={T.t("PANEL_LABEL_HIGHLIGHT_COMPRESSION")}
            data-active={state.manualHighlightActive}
            onClick={toggleHighlightCompression}
            className="highlight">
            &#xE790;
          </div>
          {
            state.hasTimeAdjustments &&
            <div
              title={T.t("PANEL_BUTTON_TIME_ADJUSTMENTS")}
              data-active={state.adjustmentTimesActive}
              onClick={toggleTimeAdjustments}
              className="schedule">
              &#xE823;
            </div>
          }
          {
            window.settings.sleepAction !== "none" &&
            <div
              title={T.t("PANEL_BUTTON_TURN_OFF_DISPLAYS")}
              className="off"
              onClick={window.turnOffDisplays}>
              &#xF71D;
            </div>
          }
          <div title={T.t("GENERIC_SETTINGS")} className="settings" onClick={window.openSettings}>&#xE713;</div>
        </div>
      </div>
      {state.sleeping ? (<div></div>) : getMonitors()}
      {
        (state.update && state.update.show)
          ?
          <div className="updateBar">
            <div className="left">
              {T.t("PANEL_UPDATE_AVAILABLE")}
              ({state.update.version})
            </div>
            <div className="right">
              <a onClick={window.installUpdate}>
                {T.t("GENERIC_INSTALL")}
              </a>
              <a className="icon" title={T.t("GENERIC_DISMISS")} onClick={window.dismissUpdate}>
                &#xEF2C;
              </a>
            </div>
          </div>
          :
          (state.update && state.update.downloading)
          &&
          <div className="updateBar">
            <div className="left progress">
              <div className="progress-bar">
                <div style={{ width: `${state.updateProgress}%` }}>
                </div>
              </div>
            </div>
            <div className="right">
              {state.updateProgress}%
            </div>
          </div>
      }
      <div id="mica">
        <div className="displays" style={{ visibility: window.micaState.visibility }}>
          <div className="blur">
            <img alt="" src={window.micaState.src} width="2560" height="1440" />
          </div>
        </div>
        <div className="noise"></div>
      </div>
    </div>
  )
})

export default BrightnessPanel
