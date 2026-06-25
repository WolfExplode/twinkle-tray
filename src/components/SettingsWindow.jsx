/*

Hi,
If you're reading this, you probably want to know how this component works.
This component is not good. Mistakes were made.
It's a horrible bowl of spaghetti.
Run while you still can.

*/

import React, { PureComponent } from "react";
import Titlebar from './Titlebar'
import Slider from "./Slider";
import { DragDropContext, Droppable, Draggable } from "react-beautiful-dnd";
import Markdown from 'markdown-to-jsx';
import MonitorInfo from "./MonitorInfo"
import MonitorFeatures from "./MonitorFeatures"
import { SettingsOption, SettingsChild } from "./SettingsOption";
import SafeRender from "./SafeRender";

// Shared helpers and sub-components, plus the per-page components. The page
// render blocks that used to live inline in render() now live in ./settings/*;
// this shell owns state + handlers and routes to the active page (see render()).
import { T, vcpStr, defaultAction, deleteIcon, monitorSort, cleanUpKeyboardKeys, reorder, getItemStyle, getMonitorName, ActionItem, SettingsPage } from "./settings/shared"
import GeneralPage from "./settings/GeneralPage"
import TimePage from "./settings/TimePage"
import MonitorsPage from "./settings/MonitorsPage"
import FeaturesPage from "./settings/FeaturesPage"
import HotkeysPage from "./settings/HotkeysPage"
import UpdatesPage from "./settings/UpdatesPage"
import DebugPage from "./settings/DebugPage"

export default class SettingsWindow extends PureComponent {

    constructor(props) {
        super(props)
        this.state = {
            rawSettings: {},
            activePage: "general",
            theme: 'default',
            openAtLogin: false,
            brightnessAtStartup: true,
            monitors: [],
            remaps: [],
            names: [],
            hotkeys: [],
            adjustmentTimes: [],
            linkedLevelsActive: false,
            updateInterval: (window.settings.updateInterval || 500),
            downloadingUpdate: false,
            checkForUpdates: false,
            adjustmentTimeIndividualDisplays: false,
            languages: [],
            analytics: false,
            useAcrylic: true,
            scrollShortcut: true,
            updateProgress: 0,
            extendedDDCCI: {
                contrast: 50,
                volume: 50,
                powerState: 0
            },
            windowHistory: [],
            showAddFeatureOverlay: false,
            addFeatureMonitor: "",
            addFeatureValue: "",
            addFeatureError: false
        }
        this.numMonitors = 0
        this.downKeys = {}
        this.lastLevels = []
        this.onDragEnd = this.onDragEnd.bind(this);
        this.sendSettingsTimeout = false
        this.sendSettingsValues = {}
        this.settingsPageRef = React.createRef()
        this.addFeatureInputRef = React.createRef()
        this.addFeatureOKRef = React.createRef()
        this.addFeatureCancelRef = React.createRef()
    }

    sendSettingsThrottle = (newSetting = {}) => {
        this.sendSettingsValues = Object.assign(this.sendSettingsValues, newSetting)
        if (this.sendSettingsTimeout) {
            clearTimeout(this.sendSettingsTimeout)
        }
        this.sendSettingsTimeout = setTimeout(() => {
            window.sendSettings(Object.assign({}, this.sendSettingsValues))
            this.sendSettingsValues = {}
        }, 2000)
    }

    componentDidMount() {
        window.addEventListener("monitorsUpdated", this.recievedMonitors)
        window.addEventListener("settingsUpdated", this.recievedSettings)
        window.addEventListener("localizationUpdated", (e) => { this.setState({ languages: e.detail.languages });  T.setLocalizationData(e.detail.desired, e.detail.default)}); 
        window.addEventListener("windowHistory", e => this.setState({ windowHistory: e.detail }))

        if (window.isAppX === false) {
            window.addEventListener("updateUpdated", (e) => {
                const version = e.detail
                this.setState({
                    releaseURL: (window.isAppX ? "ms-windows-store://pdp/?productid=9PLJWWSV01LK" : version.releaseURL),
                    latest: version.version,
                    downloadURL: version.downloadURL,
                    changelog: version.changelog,
                    error: (version.error != undefined ? version.error : false)
                })
                if (e.detail.error == true) {
                    this.setState({
                        downloadingUpdate: false
                    })
                }
            })
            window.addEventListener("updateProgress", (e) => {
                this.setState({
                    updateProgress: e.detail.progress
                })
            })
            window.checkForUpdates()
        }
        window.ipc.send('get-window-history')
        window.ipc.send("sendSettingsWindowPos")
        window.ipc.send('request-localization')
        window.reactReady = true
    }



    onDragEnd(result) {
        // dropped outside the list
        if (!result.destination) {
            return;
        }
        const sorted = Object.values(this.state.monitors).slice(0).sort(monitorSort)
        const items = reorder(
            sorted,
            result.source.index,
            result.destination.index
        );

        let order = []
        let idx = 0
        for (let monitor of items) {
            this.state.monitors[monitor.key].order = idx
            order.push({
                id: monitor.id,
                order: idx
            })
            idx++
        }

        this.setState({
            order
        });

        window.sendSettings({ order })
    }



    getRemap = (name) => {
        if (this.state.remaps[name] === undefined) {
            return {
                isFallback: true,
                min: 0,
                max: 100,
                calibration: []
            }
        }
        return this.state.remaps[name]
    }


    minMaxChanged = (value, slider) => {

        const name = slider.props.monitorID
        let remaps = Object.assign({}, this.state.remaps)

        if (remaps[name] === undefined) {
            remaps[name] = {
                min: 0,
                max: 100,
                calibration: []
            }
        }

        if (slider.props.type == "min") {
            remaps[name].min = value

            // Keep within 10%, cap

            if (remaps[name].min > remaps[name].max - 10) {
                remaps[name].max = remaps[name].min + 10
            }

            if (remaps[name].max > 100) {
                remaps[name].max = 100
            }

            if (remaps[name].min > remaps[name].max - 10) {
                remaps[name].min = remaps[name].max - 10
            }

        } else if (slider.props.type == "max") {
            remaps[name].max = value

            // Keep within 10%, cap

            if (remaps[name].min > remaps[name].max - 10) {
                remaps[name].min = remaps[name].max - 10
            }

            if (remaps[name].min < 0) {
                remaps[name].min = 0
            }

            if (remaps[name].min > remaps[name].max - 10) {
                remaps[name].max = remaps[name].min + 10
            }
        }

        this.setState({ remaps })
        window.sendSettings({ remaps })
    }

    themeChanged = (event) => {
        this.setState({ theme: event.target.value })
        window.sendSettings({ theme: event.target.value })
    }

    updateIntervalChanged = (event) => {
        this.setState({ updateInterval: event.target.value * 1 })
        window.sendSettings({ updateInterval: event.target.value * 1 })
    }

    sleepActionChanged = (event) => {
        window.sendSettings({ sleepAction: event.target.value })
    }

    monitorNameChange = (e, f) => {
        const idx = e.currentTarget.dataset.key
        this.state.names[window.allMonitors[idx].id] = e.currentTarget.value
        this.forceUpdate()
        window.sendSettings({ names: this.state.names })
    }

    getMonitorName = (monitor, renames) => {
        if (Object.keys(renames).indexOf(monitor.id) >= 0 && renames[monitor.id] != "") {
            return renames[monitor.id] + ` (${monitor.name})`
        } else {
            return monitor.name
        }
    }

    getSidebar = () => {
        const items = [
            {
                id: "general",
                label: T.t("SETTINGS_SIDEBAR_GENERAL"),
                icon: "&#xE713;"
            },
            {
                id: "monitors",
                label: T.t("SETTINGS_SIDEBAR_MONITORS"),
                icon: "&#xE7F4;"
            },
            {
                id: "features",
                label: T.t("SETTINGS_SIDEBAR_FEATURES"),
                icon: "&#xE9E9;"
            },
            {
                id: "time",
                label: T.t("SETTINGS_SIDEBAR_TIME"),
                icon: "&#xE823;"
            },
            {
                id: "hotkeys",
                label: T.t("SETTINGS_SIDEBAR_HOTKEYS"),
                icon: "&#xF210;"
            },
            {
                id: "updates",
                label: T.t("SETTINGS_SIDEBAR_UPDATES"),
                icon: "&#xE895;"
            },
            {
                id: "debug",
                label: "Debug",
                icon: "&#xEBE8;",
                type: "debug"
            }
        ]
        return items.map((item, index) => {
            return (<div key={item.id} className="item" data-active={this.isSection(item.id)} data-type={item.type || "none"} onClick={() => { this.setState({ activePage: item.id }); window.currentSettingsPage = item.id; this.scrollToTop(); window.reloadReactMonitors(); window.requestMonitors(); }}>
                <div className="icon" dangerouslySetInnerHTML={{ __html: (item.icon || "&#xE770;") }}></div><div className="label">{item.label || `Item ${index}`}</div>
            </div>)
        })
    }


    getLanguages = () => {
        if (this.state.languages && this.state.languages.length > 0) {
            return this.state.languages.map((value, index) => {
                return (<option key={value.id} value={value.id}>{value.name}</option>)
            })
        }
    }

    scrollToTop = () => {
        try {
            this.settingsPageRef.current.scrollTop = 0
        } catch(e) { }
    }


    getUpdate = () => {
        if (window.isAppX) {
            return (
                <p><a onClick={() => { window.openURL("ms-store") }}>{T.t("SETTINGS_UPDATES_MS_STORE")}</a></p>
            )
        } else {
            if (this.state.latest && this.state.latest != window.version) {
                return (
                    <div>
                        <p><b style={{ color: window.accent }}>{T.t("SETTINGS_UPDATES_AVAILABLE") + ` (${this.state.latest})`}</b></p>
                        <div className="changelog">
                            <h3>{this.state.latest}</h3>
                            <Markdown options={{ forceBlock: true }}>{this.state.changelog}</Markdown>
                        </div>
                        <br />
                        {this.getUpdateButton()}
                    </div>
                )
            } else if (this.state.latest) {
                return (
                    <div>
                        <p>{T.t("SETTINGS_UPDATES_NONE_AVAILABLE")}</p>
                        <div className="changelog"><Markdown options={{ forceBlock: true }}>{this.state.changelog}</Markdown></div>
                    </div>
                )
            }
        }
    }

    getUpdateButton = () => {
        if (this.state.downloadingUpdate) {
            return (<div><p><b>{T.t("SETTINGS_UPDATES_DOWNLOADING")}</b></p><div className="progress-bar"><div style={{ width: `${this.state.updateProgress}%` }}></div></div></div>)
        } else {
            return (<a className="button" onClick={() => { window.getUpdate(); this.setState({ downloadingUpdate: true }) }}><span className="icon red vfix" style={{ paddingRight: "6px", display: (this.state.error ? "inline" : "none") }}>&#xE783;</span>{T.t("SETTINGS_UPDATES_DOWNLOAD", this.state.latest)}</a>)
        }
    }

    getMinMaxMonitors = () => {
        if (this.state.monitors == undefined || Object.keys(this.state.monitors).length == 0) {
            return (<div className="no-displays-message">{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}<br /><br /></div>)
        } else {
            return Object.values(this.state.monitors).map((monitor, index) => {
                if (monitor.type == "none") {
                    return (<div key={monitor.name}></div>)
                } else {
                    // New method, by ID
                    let remap = this.getRemap(monitor.id)
                    // Old method, by name
                    if (remap.isFallback) {
                        remap = this.getRemap(monitor.name)
                    }
                    return (
                        <SettingsOption key={monitor.id} icon="E7F4" title={getMonitorName(monitor, this.state.names)}>
                            <SettingsChild content={
                                <div className="input-row">
                                    <div className="monitor-item">
                                        <label>{T.t("GENERIC_MINIMUM")}</label>
                                        <Slider key={monitor.id + ".min"} type="min" monitorID={monitor.id} level={remap.min} monitorName={monitor.name} monitortype={monitor.type} onChange={this.minMaxChanged} scrolling={false} height={"short"} />
                                    </div>
                                    <div className="monitor-item">
                                        <label>{T.t("GENERIC_MAXIMUM")}</label>
                                        <Slider key={monitor.id + ".max"} type="max" monitorID={monitor.id} level={remap.max} monitorName={monitor.name} monitortype={monitor.type} onChange={this.minMaxChanged} scrolling={false} height={"short"} />
                                    </div>
                                </div>
                            } />
                            <SettingsChild content={
                                <div className="calibration-points-menu">
                                    { this.getMonitorCalibration(monitor.id) }
                                    <div className="input-row">
                                        <div className="button" onClick={() => this.addCalibrationPoint(monitor.id)}>+ {T.t("GENERIC_CALIBRATION_POINT")}</div>
                                    </div>
                                </div>
                            } />
                        </SettingsOption>

                    )
                }
            })
        }
    }

    getMonitorCalibration = (monitorID) => {
        const pointsElems = []

        const remap = this.getRemap(monitorID)

        if(remap) for(const pointIdx in remap.calibration) {
            const point = remap.calibration[pointIdx]

            pointsElems.push(
                <div className="input-row" key={pointIdx}>
                    <div className="monitor-item">
                        <label>Input</label>
                        <Slider level={point.input} onChange={(value) => this.updateCalibrationPoint(monitorID, pointIdx, "input", value)} scrolling={false} height={"short"} />
                    </div>
                    <div className="monitor-item">
                        <label>Output</label>
                        <Slider level={point.output} onChange={(value) => this.updateCalibrationPoint(monitorID, pointIdx, "output", value)} scrolling={false} height={"short"} />
                    </div>
                    <div style={{ display: "flex", alignItems: "flex-end" }}>
                        <a className="add-new button button-primary block" onClick={() => this.deleteCalibrationPoint(monitorID, pointIdx)}>{ deleteIcon } <span>{T.t("GENERIC_DELETE")}</span></a>
                    </div>
                </div>
            )
        }
        return pointsElems
    }

    addCalibrationPoint = (monitorID) => {
        if (this.state.remaps[monitorID] === undefined) {
            this.state.remaps[monitorID] = {
                min: 0,
                max: 100,
                calibration: []
            }
        }

        const remap = this.getRemap(monitorID)
        if(remap) {
            if(!remap.calibration) remap.calibration = [];
            remap.calibration.push({ input: 0, output: 100 })
            this.setState({ remaps: { ...this.state.remaps } })
            window.sendSettings({ remaps: this.state.remaps })
        }
    }

    updateCalibrationPoint = (monitorID, pointIdx, field, value) => {
        const remap = this.getRemap(monitorID)
        if(remap && remap.calibration[pointIdx]) {
            remap.calibration[pointIdx][field] = value
            this.setState({ remaps: { ...this.state.remaps } })
            window.sendSettings({ remaps: this.state.remaps })
        }
    }

    deleteCalibrationPoint = (monitorID, pointIdx) => {
        const remap = this.getRemap(monitorID)
        if(remap && remap.calibration[pointIdx]) {
            remap.calibration.splice(pointIdx, 1)
            this.setState({ remaps: { ...this.state.remaps } })
            window.sendSettings({ remaps: this.state.remaps })
        }
    }

    getRenameMonitors = () => {
        if (this.state.monitors == undefined || Object.keys(this.state.monitors).length == 0) {
            return (<SettingsChild content={<div className="no-displays-message">{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}<br /><br /></div>} />)
        } else {
            return Object.values(this.state.monitors).map((monitor, index) => {
                if (monitor.type == "none") {
                    return null
                } else {
                    return (
                        <SettingsChild key={monitor.id} icon="E7F4" title={monitor.name} input={(
                            <input type="text" placeholder={T.t("SETTINGS_MONITORS_ENTER_NAME")} data-key={monitor.key} onChange={this.monitorNameChange} value={(this.state.names[monitor.id] ? this.state.names[monitor.id] : "")}></input>
                        )} />
                    )
                }
            })
        }
    }


    getReorderMonitors = () => {
        if (this.state.monitors == undefined || this.numMonitors == 0) {
            return (<div className="no-displays-message">{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}<br /><br /></div>)
        } else {
            const sorted = Object.values(this.state.monitors).slice(0).sort(monitorSort)
            return (
                <DragDropContext onDragEnd={this.onDragEnd}>
                    <Droppable droppableId="droppable">
                        {(provided, snapshot) => (
                            <div
                                {...provided.droppableProps}
                                ref={provided.innerRef}
                            >
                                {sorted.map((monitor, index) => {
                                    if (monitor.type == "none") {
                                        return (<div key={monitor.id}></div>)
                                    } else {
                                        return (
                                            <Draggable key={monitor.id} draggableId={monitor.id} index={index}>
                                                {(provided, snapshot) => (
                                                    <div
                                                        ref={provided.innerRef}
                                                        {...provided.draggableProps}
                                                        {...provided.dragHandleProps}
                                                        style={getItemStyle(
                                                            snapshot.isDragging,
                                                            provided.draggableProps.style
                                                        )}
                                                    >
                                                        <div className="sectionSubtitle"><div className="icon">&#xE7F4;</div><div>{getMonitorName(monitor, this.state.names)}</div></div>
                                                    </div>
                                                )}
                                            </Draggable>
                                        )
                                    }
                                })}
                                {provided.placeholder}
                            </div>
                        )}
                    </Droppable>
                </DragDropContext>
            )

        }
    }

    updateAdjustmentTime(time, idx) {
        this.state.adjustmentTimes[idx] = Object.assign({}, time)
        window.sendSettings({ adjustmentTimes: this.state.adjustmentTimes.slice() })
        this.forceUpdate()
    }

    getAdjustmentTimes = () => {
        if (this.state.adjustmentTimes == undefined || this.state.adjustmentTimes.length == 0) {
            return (<div></div>)
        } else {
            const times = window.getSunCalcTimes(window.settings.adjustmentTimeLatitude, window.settings.adjustmentTimeLongitude)
            const lat = parseFloat(window.settings.adjustmentTimeLatitude) ?? 0
            const long = parseFloat(window.settings.adjustmentTimeLongitude) ?? 0
            const canShowSunCalc = ((lat > 0 || lat < 0) && (long > 0 || long < 0))

            return this.state.adjustmentTimes.map((time, index) => {
                let timeElem = (
                    <input type="time" min="00:00" max="23:59" onChange={(e) => {
                        this.setAdjustmentTimeValue(index, e.target.value)
                    }} value={time.time}></input>
                )
                if (time.useSunCalc) {
                    timeElem = (
                        <select value={time.sunCalc ?? "solarNoon"} onChange={e => {
                            time.sunCalc = e.target.value
                            this.updateAdjustmentTime(time, index)
                        }}>
                            <option value="dawn">Dawn ({times.dawn})</option>
                            <option value="sunrise">Sunrise ({times.sunrise})</option>
                            <option value="solarNoon">Solar Noon ({times.solarNoon})</option>
                            <option value="goldenHour">Golden Hour ({times.goldenHour})</option>
                            <option value="sunsetStart">Sunset Start ({times.sunsetStart})</option>
                            <option value="sunset">Sunset ({times.sunset})</option>
                            <option value="dusk">Dusk ({times.dusk})</option>
                            <option value="night">Night ({times.night})</option>
                        </select>
                    )
                }
                return (
                    <SettingsOption className="win10-has-background" key={index + "_" + time.time} content={
                        <div className="input-row">
                            {timeElem}
                            <input type="button" className="button button-primary" value={T.t("SETTINGS_TIME_REMOVE")} onClick={() => {
                                this.state.adjustmentTimes.splice(index, 1)
                                this.forceUpdate()
                                this.adjustmentTimesUpdated()
                            }} />
                        </div>
                    } input={
                        <div className="inputToggle-generic" style={{display: (canShowSunCalc ? "flex" : "none")}}>
                            <input onChange={e => {
                                time.useSunCalc = e.target.checked
                                this.updateAdjustmentTime(time, index)
                            }} checked={time.useSunCalc ?? false} data-checked={time.useSunCalc ?? false} type="checkbox" />
                            <div className="text">{T.t("SETTINGS_TIME_USE_SUN_POSITION")}</div>
                        </div>
                    }>
                        <SettingsChild>
                            {this.getAdjustmentTimesMonitors(time, index)}
                        </SettingsChild>
                    </SettingsOption>
                )
            })
        }

    }

    getSoftwareDimMin = () => -(window.settings?.softwareDimMax ?? 100)

    getAdjustmentLevel = (brightness, softwareDim) => {
        const dim = softwareDim ?? 0
        if (dim > 0 && brightness === 0) return -dim
        return brightness ?? 0
    }

    splitAdjustmentLevel = (level) => ({
        brightness: Math.max(0, level),
        softwareDim: level < 0 ? Math.min(100, -level) : 0
    })

    getAdjustmentTimesMonitors = (time, index) => {
        const softwareDimMin = this.getSoftwareDimMin()
        const tempEnabled = this.state.rawSettings?.adjustmentTimeTemperatureEnabled
        const highlightEnabled = this.state.rawSettings?.adjustmentTimeHighlightCompressionEnabled

        const kelvinSlider = tempEnabled ? (
            <Slider key={index + ".kelvin"} name="Color Temperature (K)" min={3000} max={6500} level={this.state.adjustmentTimes[index].kelvin ?? 6500} onChange={(value) => {
                this.state.adjustmentTimes[index].kelvin = value
                this.forceUpdate()
                this.adjustmentTimesUpdated()
            }} scrolling={false} />
        ) : null

        const highlightSlider = highlightEnabled ? (
            <Slider key={index + ".highlight"} name={T.t("PANEL_LABEL_HIGHLIGHT_COMPRESSION")} min={0} max={100} level={this.state.adjustmentTimes[index].highlightWeight ?? 0} onChange={(value) => {
                this.state.adjustmentTimes[index].highlightWeight = value
                this.forceUpdate()
                this.adjustmentTimesUpdated()
            }} scrolling={false} />
        ) : null

        if (this.state.rawSettings?.adjustmentTimeIndividualDisplays) {
            const monitorSliders = Object.values(this.state.monitors).map((monitor, idx) => {
                if (monitor.type == "none") {
                    return (<div key={monitor.id + ".brightness"}></div>)
                } else {
                    let brightness = time.brightness
                    let softwareDim = 0
                    if (this.state.adjustmentTimes[index]?.monitors && this.state.adjustmentTimes[index].monitors[monitor.id] >= 0) {
                        brightness = this.state.adjustmentTimes[index].monitors[monitor.id]
                    } else {
                        this.state.adjustmentTimes[index].monitors[monitor.id] = brightness
                        this.adjustmentTimesUpdated()
                    }
                    if (this.state.adjustmentTimes[index]?.monitorsSoftwareDim && this.state.adjustmentTimes[index].monitorsSoftwareDim[monitor.id] >= 0) {
                        softwareDim = this.state.adjustmentTimes[index].monitorsSoftwareDim[monitor.id]
                    }
                    const level = this.getAdjustmentLevel(brightness, softwareDim)

                    let kelvin = time.kelvin ?? 6500
                    if (this.state.adjustmentTimes[index]?.monitorsKelvin && this.state.adjustmentTimes[index].monitorsKelvin[monitor.id] != null) {
                        kelvin = this.state.adjustmentTimes[index].monitorsKelvin[monitor.id]
                    } else {
                        if (this.state.adjustmentTimes[index].monitorsKelvin === undefined) {
                            this.state.adjustmentTimes[index].monitorsKelvin = {}
                        }
                        this.state.adjustmentTimes[index].monitorsKelvin[monitor.id] = kelvin
                        this.adjustmentTimesUpdated()
                    }

                    let highlightWeight = time.highlightWeight ?? 0
                    if (this.state.adjustmentTimes[index]?.monitorsHighlightWeight && this.state.adjustmentTimes[index].monitorsHighlightWeight[monitor.id] != null) {
                        highlightWeight = this.state.adjustmentTimes[index].monitorsHighlightWeight[monitor.id]
                    } else {
                        if (this.state.adjustmentTimes[index].monitorsHighlightWeight === undefined) {
                            this.state.adjustmentTimes[index].monitorsHighlightWeight = {}
                        }
                        this.state.adjustmentTimes[index].monitorsHighlightWeight[monitor.id] = highlightWeight
                        this.adjustmentTimesUpdated()
                    }

                    return (
                        <React.Fragment key={monitor.id}>
                            <Slider key={monitor.id + ".brightness"} min={softwareDimMin} max={100} name={getMonitorName(monitor, this.state.names)} onChange={(value) => { this.getAdjustmentTimesMonitorsChanged(index, monitor, value) }} level={level} scrolling={false} />
                            {tempEnabled ? (
                                <Slider key={monitor.id + ".kelvin"} name={`${getMonitorName(monitor, this.state.names)} (K)`} min={3000} max={6500} level={kelvin} onChange={(value) => { this.getAdjustmentTimesKelvinChanged(index, monitor, value) }} scrolling={false} />
                            ) : null}
                            {highlightEnabled ? (
                                <Slider key={monitor.id + ".highlight"} name={`${getMonitorName(monitor, this.state.names)} (${T.t("PANEL_LABEL_HIGHLIGHT_COMPRESSION")})`} min={0} max={100} level={highlightWeight} onChange={(value) => { this.getAdjustmentTimesHighlightChanged(index, monitor, value) }} scrolling={false} />
                            ) : null}
                        </React.Fragment>
                    )
                }
            })
            return (
                <>
                    {monitorSliders}
                </>
            )
        } else {
            const level = this.getAdjustmentLevel(time.brightness, time.softwareDim)
            return (
                <>
                    <Slider key={index + ".brightness"} name={T.t("GENERIC_ALL_DISPLAYS")} min={softwareDimMin} max={100} level={level} onChange={(value) => {
                        const split = this.splitAdjustmentLevel(value)
                        this.state.adjustmentTimes[index].brightness = split.brightness
                        this.state.adjustmentTimes[index].softwareDim = split.softwareDim
                        this.forceUpdate()
                        this.adjustmentTimesUpdated()
                    }} scrolling={false} />
                    {kelvinSlider}
                    {highlightSlider}
                </>
            )
        }
    }

    getAdjustmentTimesMonitorsChanged = (index, monitor, level) => {
        const split = this.splitAdjustmentLevel(level)
        if (this.state.adjustmentTimes[index].monitors === undefined) {
            this.state.adjustmentTimes[index].monitors = {}
        }
        if (this.state.adjustmentTimes[index].monitorsSoftwareDim === undefined) {
            this.state.adjustmentTimes[index].monitorsSoftwareDim = {}
        }
        this.state.adjustmentTimes[index].monitors[monitor.id] = split.brightness
        this.state.adjustmentTimes[index].monitorsSoftwareDim[monitor.id] = split.softwareDim
        this.forceUpdate();
        this.adjustmentTimesUpdated()
    }

    getAdjustmentTimesKelvinChanged = (index, monitor, kelvin) => {
        if (this.state.adjustmentTimes[index].monitorsKelvin === undefined) {
            this.state.adjustmentTimes[index].monitorsKelvin = {}
        }
        this.state.adjustmentTimes[index].monitorsKelvin[monitor.id] = kelvin
        this.forceUpdate()
        this.adjustmentTimesUpdated()
    }

    getAdjustmentTimesHighlightChanged = (index, monitor, highlightWeight) => {
        if (this.state.adjustmentTimes[index].monitorsHighlightWeight === undefined) {
            this.state.adjustmentTimes[index].monitorsHighlightWeight = {}
        }
        this.state.adjustmentTimes[index].monitorsHighlightWeight[monitor.id] = highlightWeight
        this.forceUpdate()
        this.adjustmentTimesUpdated()
    }


    setAdjustmentTimeValue = (index, arr) => {
        for (let i in arr) {
            if (i < 2 && isNaN(arr[i])) return false;
        }
        this.state.adjustmentTimes[index].time = arr

        this.adjustmentTimesUpdated()
    }

    getHotkeyList = () => {

        const deleteHotkeyAction = (idx, actionIdx) => {
            try {
                this.state.hotkeys[idx].actions.splice(actionIdx, 1)
                window.sendSettings({ hotkeys: this.state.hotkeys.slice() })
                this.forceUpdate()
            } catch(e) {
                console.log(e)
            }
        }

        return this.state.hotkeys?.map?.((hotkey, idx) => {
            return (
                <SettingsOption className="win10-has-background" key={hotkey.id} content={
                    <div className="row hotkey-combo-input">
                        <input placeholder={T.t("SETTINGS_HOTKEYS_PRESS_KEYS_HINT")} value={hotkey.accelerator} type="text" readOnly={true} onKeyDown={
                            (e) => {
                                e.preventDefault()
                                let key = cleanUpKeyboardKeys(e.key, e.keyCode)
                                if (this.downKeys[key] === undefined) {
                                    this.downKeys[key] = true;
                                    hotkey.accelerator = Object.keys(this.downKeys).join('+')
                                    this.updateHotkey(hotkey, idx);
                                }
                                return false
                            }
                        } onKeyUp={(e) => { delete this.downKeys[cleanUpKeyboardKeys(e.key, e.keyCode)] }} />
                        <input type="button" value={T.t("GENERIC_CLEAR")} onClick={() => {
                            this.downKeys = {}
                            hotkey.accelerator = ""
                            this.updateHotkey(hotkey, idx);
                        }} />
                        {this.getHotkeyStatusIcon(hotkey)}
                    </div>
                } expandable={true} input={
                    <a className="button button-primary" onClick={() => this.deleteHotkey(idx)}>{ deleteIcon } <span>{T.t("GENERIC_DELETE")}</span></a>
                }>
                    { hotkey.actions?.map((action, actionIdx) => {
                        return (
                            <SettingsChild key={`${idx}-${actionIdx}`}>
                                <ActionItem key={`${idx}-${actionIdx}`} title={`${T.t("SETTINGS_HOTKEY_ACTION")} #${actionIdx + 1}`} action={action} onChange={updatedAction => this.updateHotkeyAction(updatedAction, idx, actionIdx)} onDelete={() => { deleteHotkeyAction(idx, actionIdx) }} monitors={this.state.monitors} monitorNames={this.state.names} />
                            </SettingsChild>
                        )
                    }) }
                    <SettingsChild>
                        <a className="button full-width" onClick={() => {
                            if(!hotkey.actions?.length) {
                                hotkey.actions = []
                            }
                            hotkey.actions.push(Object.assign({}, defaultAction))
                            this.updateHotkey(hotkey, idx)
                        }}>+ {T.t("SETTINGS_HOTKEY_ADD_ACTION")}</a>
                    </SettingsChild>
                </SettingsOption>
            )
        })
    }

    getHotkeyStatusIcon = hotkey => {
        if (hotkey?.active) {
            return (<div className="status icon active">&#xE73E;</div>)
        } else {
            return (<div className="status icon inactive"></div>)
        }
    }

    updateHotkey(hotkey, idx) {
        this.state.hotkeys[idx] = Object.assign({}, hotkey)
        window.sendSettings({ hotkeys: this.state.hotkeys.slice() })
        this.forceUpdate()
    }

    updateHotkeyAction(action, idx, actionIdx) {
        this.state.hotkeys[idx].actions[actionIdx] = Object.assign({}, action)
        window.sendSettings({ hotkeys: this.state.hotkeys.slice() })
        this.forceUpdate()
    }

    deleteHotkey(idx) {
        this.state.hotkeys.splice(idx, 1)
        window.sendSettings({ hotkeys: this.state.hotkeys.slice() })
        this.forceUpdate()
    }


    getInfoMonitors = () => {
        if (this.state.monitors == undefined || Object.keys(this.state.monitors).length == 0) {
            return (<div className="no-displays-message">{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}<br /><br /></div>)
        } else {
            return Object.values(this.state.monitors).map((monitor, index) => {

                let brightness = monitor.brightness
                let brightnessMax = monitor.brightnessMax

                if (monitor.type == "ddcci" && !monitor.brightnessType) {
                    brightness = "???"
                    brightnessMax = "???"
                }

                return (
                    <div key={monitor.key} className="monitorItem">
                        <br />
                        <div className="sectionSubtitle"><div className="icon">&#xE7F4;</div><div>{monitor.name}</div></div>
                        <p>{T.t("SETTINGS_MONITORS_DETAILS_NAME")}: <b>{getMonitorName(monitor, this.state.names)}</b>
                            <br />{T.t("SETTINGS_MONITORS_DETAILS_INTERNAL_NAME")}: <b>{monitor.hwid[1]}</b>
                            <br />{T.t("SETTINGS_MONITORS_DETAILS_COMMUNICATION")}: {this.getDebugMonitorType((monitor.type === "ddcci" && monitor.highLevelSupported?.brightness ? "ddcci-hl" : monitor.type))}
                            <br />{T.t("SETTINGS_MONITORS_DETAILS_BRIGHTNESS")}: <b>{(monitor.type == "none" ? T.t("GENERIC_NOT_SUPPORTED") : brightness)}</b>
                            <br />{T.t("SETTINGS_MONITORS_DETAILS_MAX_BRIGHTNESS")}: <b>{(monitor.type !== "ddcci" ? T.t("GENERIC_NOT_SUPPORTED") : brightnessMax)}</b>
                            <br />{T.t("SETTINGS_MONITORS_DETAILS_BRIGHTNESS_NORMALIZATION")}: <b>{(monitor.type == "none" ? T.t("GENERIC_NOT_SUPPORTED") : monitor.min + " - " + monitor.max)}</b>
                            <br />{T.t("SETTINGS_MONITORS_DETAILS_HDR")}: <b>{(monitor.hdr == "active" ? T.t("GENERIC_ACTIVE") : monitor.hdr == "supported" ? T.t("GENERIC_SUPPORTED") : T.t("GENERIC_UNSUPPORTED"))}</b>
                        </p>
                    </div>
                )
            })
        }
    }


    getDebugMonitors = () => {
        if (this.state.monitors == undefined || Object.keys(this.state.monitors).length == 0) {
            return (<div className="no-displays-message">{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}<br /><br /></div>)
        } else {
            return Object.values(this.state.monitors).map((monitor, index) => {

                return (
                    <MonitorInfo key={monitor.key} name={getMonitorName(monitor, this.state.names)} monitor={monitor} debug={true} />
                )

            })
        }
    }

    getFeaturesMonitors = () => {
        try {
            const onChange = () => {
                window.sendSettings({ monitorFeaturesSettings: JSON.parse(JSON.stringify(window.settings.monitorFeaturesSettings)) })
            }
            if (this.state.monitors == undefined || Object.keys(this.state.monitors).length == 0) {
                return (<div className="no-displays-message">{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}<br /><br /></div>)
            } else {
                return Object.values(this.state.monitors).map((monitor, index) => {
                    const features = this.state?.rawSettings.monitorFeatures[monitor.hwid[1]]
                    return (
                        <MonitorFeatures key={monitor.key} name={getMonitorName(monitor, this.state.names)} monitor={monitor} monitorFeatures={features} toggleFeature={this.toggleFeature} T={T} onChange={onChange} onAddFeature={() => {
                            this.setState({
                                showAddFeatureOverlay: true,
                                addFeatureMonitor: monitor.hwid[1],
                                addFeatureValue: "",
                                addFeatureError: false
                            }, () => {
                                this.addFeatureInputRef.current.focus()
                            })
                        }} />
                    )

                })
            }
        } catch (e) {

        }
    }

    getHDRMonitors = () => {
        try {
            if (this.state.monitors == undefined || Object.keys(this.state.monitors).length == 0) {
                return (<SettingsChild title={T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")} />)
            } else {
                return Object.values(this.state.monitors).map((monitor, index) => {

                    return (
                        <SettingsChild key={monitor.key} icon="E7F4" title={getMonitorName(monitor, this.state.names)} input={
                            <div className="inputToggle-generic">
                                <input onChange={(e) => { this.setHDRMonitor(e.target.checked, monitor) }} checked={(this.state.rawSettings?.hdrDisplays?.[monitor.key] ? true : false)} data-checked={(this.state.rawSettings?.hdrDisplays?.[monitor.key] ? true : false)} type="checkbox" />
                            </div>
                        } />
                    )

                })
            }
        } catch (e) {
            console.log(e)
        }
    }

    getSDRMonitorsSettings = () => {
                try {
            if (this.state.monitors == undefined || Object.keys(this.state.monitors).length == 0) {
                return (<SettingsChild title={T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")} />)
            } else {
                return Object.values(this.state.monitors).map((monitor, index) => {

                    return (
                        <SettingsChild key={monitor.key} icon="E7F4" title={getMonitorName(monitor, this.state.names)} input={
                            <div className="inputToggle-generic">
                                <input onChange={(e) => { this.setSDRMonitor(e.target.checked, monitor) }} checked={(this.state.rawSettings?.sdrAsMainSliderDisplays?.[monitor.key] ? true : false)} data-checked={(this.state.rawSettings?.sdrAsMainSliderDisplays?.[monitor.key] ? true : false)} type="checkbox" />
                            </div>
                        } />
                    )

                })
            }
        } catch (e) {
            console.log(e)
        }
    }

    setHDRMonitor = (value, monitor) => {
        const hdrDisplays = Object.assign({}, this.state.rawSettings?.hdrDisplays)
        hdrDisplays[monitor.key] = value
        this.setSetting("hdrDisplays", hdrDisplays)
    }

    setSDRMonitor = (value, monitor) => {
        const sdrDisplays = Object.assign({}, this.state.rawSettings?.sdrAsMainSliderDisplays)
        sdrDisplays[monitor.key] = value
        this.setSetting("sdrAsMainSliderDisplays", sdrDisplays)
    }

    getHideMonitors = () => {
        try {
            if (this.state.monitors == undefined || Object.keys(this.state.monitors).length == 0) {
                return (<SettingsChild title={T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")} />)
            } else {
                return Object.values(this.state.monitors).map((monitor, index) => {

                    return (
                        <SettingsChild key={monitor.key} icon="E7F4" title={getMonitorName(monitor, this.state.names)} input={
                            <div className="inputToggle-generic">
                                <input onChange={(e) => { this.setHideMonitor(e.target.checked, monitor) }} checked={(this.state.rawSettings?.hideDisplays?.[monitor.key] ? true : false)} data-checked={(this.state.rawSettings?.hideDisplays?.[monitor.key] ? true : false)} type="checkbox" />
                            </div>
                        } />
                    )

                })
            }
        } catch (e) {
            console.log(e)
        }
    }

    setHideMonitor = (value, monitor) => {
        const hideDisplays = Object.assign({}, this.state.rawSettings?.hideDisplays)
        hideDisplays[monitor.key] = value
        this.setSetting("hideDisplays", hideDisplays)
    }

    toggleFeature = (monitor, featureRaw) => {
        const feature = `0x${parseInt(featureRaw).toString(16).toUpperCase()}`

        if (feature === "0x10" || feature === "0x13") return false; // Skip brightness
        if (feature === "0x" || feature === "0xNaN") return false; // Skip invalid

        const newFeatures = Object.assign({}, this.state.rawSettings.monitorFeatures)
        if (!newFeatures[monitor]) newFeatures[monitor] = {};
        newFeatures[monitor][feature] = (newFeatures[monitor][feature] ? false : true);

        window.sendSettings({ monitorFeatures: newFeatures })
    }

    getDebugMonitorType = (type) => {
        if (type == "none") {
            return (<><b>None</b> <span className="icon red vfix">&#xEB90;</span></>)
        } else if (type == "ddcci") {
            return (<><b>DDC/CI</b> <span className="icon green vfix">&#xE73D;</span></>)
        } else if (type == "ddcci-hl") {
            return (<><b>DDC/CI (HL)</b> <span className="icon green vfix">&#xE73D;</span></>)
        } else if (type == "wmi") {
            return (<><b>WMI</b> <span className="icon green vfix">&#xE73D;</span></>)
        } else if (type == "studio-display") {
            return (<><b>Studio Display</b> <span className="icon green vfix">&#xE73D;</span></>)
        } else {
            return (<><b>Unknown ({type})</b> <span className="icon red vfix">&#xEB90;</span></>)
        }
    }

    getSkipRestoreMonitors = () => {
        try {
            if (this.state.monitors == undefined || Object.keys(this.state.monitors).length == 0) {
                return (<SettingsChild title={T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")} />)
            } else {
                return Object.values(this.state.monitors).map((monitor, index) => {

                    return (
                        <SettingsChild key={monitor.key} icon="E7F4" title={getMonitorName(monitor, this.state.names)} input={
                            <div className="inputToggle-generic">
                                <input onChange={(e) => { this.setSkipRestoreMonitor(e.target.checked, monitor) }} checked={(this.state.rawSettings?.userSkipReapply?.indexOf(monitor.hwid[1]) >= 0 ? true : false)} data-checked={(this.state.rawSettings?.userSkipReapply?.indexOf(monitor.hwid[1]) >= 0 ? true : false)} type="checkbox" />
                            </div>
                        } />
                    )

                })
            }
        } catch (e) {
            console.log(e)
        }
    }

    setSkipRestoreMonitor = (value, monitor) => {
        const userSkipReapply = this.state.rawSettings?.userSkipReapply
        const index = this.state.rawSettings?.userSkipReapply?.indexOf(monitor.hwid[1])
        if(index >= 0 && !value) {
            userSkipReapply.splice(index, 1)
        } else if(index === -1 && value) {
            userSkipReapply.push(monitor.hwid[1])
        }
        this.setSetting("userSkipReapply", userSkipReapply)
    }






    // Update monitor info
    recievedMonitors = (e) => {
        let newMonitors = Object.assign(e.detail, {})
        this.lastLevels = []
        let numMonitors = 0
        for (let key in newMonitors) {
            if (newMonitors[key].type != "none") numMonitors++;
        }
        this.numMonitors = numMonitors
        this.setState({
            monitors: newMonitors
        })
    }

    // Update settings
    recievedSettings = (e) => {
        const settings = e.detail
        const openAtLogin = settings.openAtLogin
        const brightnessAtStartup = settings.brightnessAtStartup
        const linkedLevelsActive = (settings.linkedLevelsActive || false)
        const updateInterval = (settings.updateInterval || 500) * 1
        const remaps = (settings.remaps || {})
        const names = (settings.names || {})
        const adjustmentTimes = (settings.adjustmentTimes || {})
        const killWhenIdle = (settings.killWhenIdle || false)
        const order = (settings.order || [])
        const checkTimeAtStartup = (settings.checkTimeAtStartup || false)
        const checkForUpdates = (settings.checkForUpdates || false)
        const adjustmentTimeIndividualDisplays = (settings.adjustmentTimeIndividualDisplays || false)
        const language = (settings.language || "system")
        const hotkeys = (settings.hotkeys || [])
        const hotkeyPercent = (settings.hotkeyPercent || 10)
        const analytics = settings.analytics
        const useAcrylic = settings.useAcrylic
        const scrollShortcut = settings.scrollShortcut
        this.setState({
            rawSettings: (Object.keys(settings).length > 0 ? settings : this.state.rawSettings),
            openAtLogin,
            brightnessAtStartup,
            linkedLevelsActive,
            remaps,
            updateInterval,
            names,
            adjustmentTimes,
            killWhenIdle,
            order,
            checkTimeAtStartup,
            checkForUpdates,
            adjustmentTimeIndividualDisplays,
            language,
            hotkeys,
            hotkeyPercent,
            analytics,
            useAcrylic,
            scrollShortcut
        }, () => {
            this.forceUpdate()
        })
    }


    isSection = (name) => {
        if (this.state.activePage == name) {
            return true
        } else {
            return false
        }
    }

    isIcon = (icon) => (this.state.rawSettings.icon === icon ? true : false)

    addAdjustmentTime = () => {
        this.state.adjustmentTimes.push({
            brightness: 50,
            softwareDim: 0,
            kelvin: 6500,
            highlightWeight: 0,
            time: "12:30",
            monitors: {},
            monitorsSoftwareDim: {},
            monitorsKelvin: {},
            monitorsHighlightWeight: {},
            useSunCalc: false,
            sunCalc: "sunrise"
        })
        this.forceUpdate()
        this.adjustmentTimesUpdated()
    }

    adjustmentTimesUpdated = () => {
        this.setState({ adjustmentTimes: this.state.adjustmentTimes.slice(0) })
        this.sendSettingsThrottle({ adjustmentTimes: this.state.adjustmentTimes.slice(0) })
        window.sendSettings({ adjustmentTimes: this.state.adjustmentTimes })
    }

    setSetting = (setting, sentVal) => {
        let value = sentVal;
        if (sentVal === "on") value = true;
        if (sentVal === "off") value = false;

        const newState = {}
        newState[setting] = value
        this.setState({...newState, ...{rawSettings: {...this.state.rawSettings, ...{[setting]: value} } } })
        window.sendSettings(newState)
    }

    renderToggle = (setting, showText = true, textSide = "right", inverse = false) => {
        const isActive = (this.state.rawSettings?.[setting] ? true : false)
        const isVisiblyActive = (inverse ? !isActive : isActive)
        return (<div className="inputToggle-generic" data-textside={textSide}>
            <input onChange={(e) => { this.setSetting(setting, e.target.checked) }} checked={isActive} data-checked={isVisiblyActive} type="checkbox" />
            <div className="text">{(isVisiblyActive ? T.t("GENERIC_ON") : T.t("GENERIC_OFF"))}</div>
        </div>)
    }

    render() {
        return (
            <SafeRender>
                <div className="window-base" data-theme={window.settings.theme || "default"}>
                    <Titlebar title={T.t("SETTINGS_TITLE")} />
                    <div className="window-base-inner">
                        <div id="sidebar">
                            {this.getSidebar()}
                        </div>
                        <div id="page" ref={this.settingsPageRef}>

                            <SettingsPage current={this.state.activePage} id="general"><GeneralPage self={this} /></SettingsPage>

                            <SettingsPage current={this.state.activePage} id="time"><TimePage self={this} /></SettingsPage>

                            <SettingsPage current={this.state.activePage} id="monitors"><MonitorsPage self={this} /></SettingsPage>

                            <SettingsPage current={this.state.activePage} id="features"><FeaturesPage self={this} /></SettingsPage>

                            <SettingsPage current={this.state.activePage} id="hotkeys"><HotkeysPage self={this} /></SettingsPage>

                            <SettingsPage current={this.state.activePage} id="updates"><UpdatesPage self={this} /></SettingsPage>

                            <SettingsPage current={this.state.activePage} id="debug"><DebugPage self={this} /></SettingsPage>




                        </div>
                    </div>

                    <div className="add-feature-overlay" data-show={this.state.showAddFeatureOverlay}>
                        <div className="inner">
                            <div className="input-row">
                                <div className="field">
                                    <p>{T.t("SETTINGS_FEATURES_ADD_DESC")}</p>
                                    <label>{T.t("SETTINGS_FEATURES_ADD_VCP")}</label>
                                    <input type="text" placeholder={T.t("SETTINGS_FEATURES_ADD_PLACEHOLDER")} ref={this.addFeatureInputRef} value={this.state.addFeatureValue} onChange={e => this.setState({ addFeatureValue: e.target.value })} onKeyUp={e => {
                                        if (e.which === 13 && this.state.addFeatureValue) {
                                            // Enter
                                            this.addFeatureOKRef.current.click()
                                        } else if (e.which === 27) {
                                            // Escape
                                            this.addFeatureCancelRef.current.click()
                                        }
                                    }} />
                                </div>
                            </div>
                            <div className="input-row" style={{ display: (this.state.addFeatureError ? "block" : "none") }}>
                                <p><b>{T.t("SETTINGS_FEATURES_ADD_EXISTS")}</b></p>
                            </div>
                            <div className="input-row flex-end">
                                <input type="button" ref={this.addFeatureCancelRef} value={"Cancel"} className="button" onClick={() => this.setState({ showAddFeatureOverlay: false })} />
                                <input type="button" ref={this.addFeatureOKRef} value={"OK"} className="button" onClick={() => {
                                    let isActive = false
                                    const vcp = vcpStr(this.state.addFeatureValue)
                                    try {
                                        isActive = this.state.rawSettings.monitorFeatures[this.state.addFeatureMonitor][vcp];
                                    } catch (e) { }
                                    if (isActive) {
                                        this.setState({ addFeatureError: true })
                                    } else {
                                        this.setState({ showAddFeatureOverlay: false })
                                        this.toggleFeature(this.state.addFeatureMonitor, vcp)
                                    }

                                }} />
                            </div>
                        </div>
                    </div>

                </div>
            </SafeRender>
        );
    }
}
