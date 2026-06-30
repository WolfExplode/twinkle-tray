// "Time" (adjustments / idle / monitor focus) settings page.
// Extracted verbatim from SettingsWindow.render(); `self` is the parent instance.
import React from "react"
import { T } from "./shared"
import { SettingsOption, SettingsChild } from "../SettingsOption"
import Slider from "../Slider"

export default function TimePage({ self }) {
    return (
        <>
            <div className="pageSection">
                <div className="sectionTitle">{T.t("SETTINGS_TIME_TITLE")}</div>
                <p>{T.t("SETTINGS_TIME_DESC")}</p>
                <SettingsOption title="Color Temperature" description="When enabled, each time adjustment can set a warm tint on your displays (6500K = daylight, 3000K = warm)." input={self.renderToggle("adjustmentTimeTemperatureEnabled")} />
                <SettingsOption title={T.t("PANEL_LABEL_HIGHLIGHT_COMPRESSION")} description="When enabled, roll off bright highlights to reduce perceived dynamic range. Works best on SDR displays." input={self.renderToggle("adjustmentTimeHighlightCompressionEnabled")} />
                <SettingsOption title={T.t("SETTINGS_TIME_INDIVIDUAL_TITLE")} description={T.t("SETTINGS_TIME_INDIVIDUAL_DESC")} input={self.renderToggle("adjustmentTimeIndividualDisplays")} />
                <div className="adjustmentTimes">
                    {self.getAdjustmentTimes()}
                </div>
                <p><a className="button" onClick={self.addAdjustmentTime}>+ {T.t("SETTINGS_TIME_ADD")}</a></p>
            </div>
            <div className="pageSection">
                <SettingsOption title={T.t("SETTINGS_TIME_SUN_TITLE")} description={T.t("SETTINGS_TIME_SUN_DESC")} expandable={true}>
                    <SettingsChild>
                        <div style={{ "display": "flex" }}>
                            <div style={{ marginRight: "6px", flex: 1 }}>
                                <label style={{ "textTransform": "capitalize" }}>{T.t("SETTINGS_TIME_LAT")}</label>
                                <input type="number" min="-90" max="90" value={window.settings.adjustmentTimeLatitude * 1} onChange={(e) => self.setSetting("adjustmentTimeLatitude", e.target.value)} style={{width: "100%", boxSizing: "border-box"}} />
                            </div>
                            <div style={{flex: 1}}>
                                <label style={{ "textTransform": "capitalize" }}>{T.t("SETTINGS_TIME_LONG")}</label>
                                <input type="number" min="-180" max="180" value={window.settings.adjustmentTimeLongitude * 1} onChange={(e) => self.setSetting("adjustmentTimeLongitude", e.target.value)} style={{width: "100%", boxSizing: "border-box"}} />
                            </div>
                            {/* I'll write better CSS later, I promise. */}
                            <div><label style={{opacity:0}}>Get {T.t("SETTINGS_TIME_SUN_GET")}</label><input type="button" className="button" onClick={() => window.ipc.send("get-coordinates")} value={T.t("SETTINGS_TIME_SUN_GET")} style={{lineHeight:"1.3",padding:(document.body.dataset.isWin11 === 'true' ? "9px" : "8px"),marginLeft:"6px"}} /></div>
                        </div>
                    </SettingsChild>
                </SettingsOption>
                <SettingsOption title={T.t("SETTINGS_TIME_ANIMATE_TITLE")} description={T.t("SETTINGS_TIME_ANIMATE_DESC")} input={self.renderToggle("adjustmentTimeAnimate")} />
                <SettingsOption title={T.t("SETTINGS_TIME_TRANSITON_TITLE")} description={T.t("SETTINGS_TIME_TRANSITON_DESC")} input={
                    <select value={window.settings.adjustmentTimeSpeed} onChange={(e) => self.setSetting("adjustmentTimeSpeed", e.target.value)}>
                        <option value="slowest">{T.t("GENERIC_SPEED_VERY_SLOW")}</option>
                        <option value="slow">{T.t("GENERIC_SPEED_SLOW")}</option>
                        <option value="normal">{T.t("GENERIC_SPEED_NORMAL")}</option>
                        <option value="faster">{T.t("GENERIC_SPEED_FAST")}</option>
                        <option value="fastest">{T.t("GENERIC_SPEED_VERY_FAST")}</option>
                        <option value="instant">{T.t("GENERIC_SPEED_INSTANT")}</option>
                        <option value="linear">{T.t("GENERIC_SPEED_LINEAR")}</option>
                    </select>
                } />
                <SettingsOption title={T.t("SETTINGS_TIME_STARTUP_TITLE")} description={T.t("SETTINGS_TIME_STARTUP_DESC")} input={self.renderToggle("checkTimeAtStartup")} />
                <SettingsOption title="Schedule refresh interval" description="How often (in seconds) the schedule is re-checked and applied. Lower = more responsive transitions; higher = less background work." input={
                    <input type="number" min="10" max="3600" step="10" value={window.settings.backgroundUpdateInterval ?? 60} onChange={(e) => self.setSetting("backgroundUpdateInterval", Math.max(10, Math.min(3600, e.target.value * 1)))} style={{ width: "70px" }} />
                } />
            </div>
            <div className="pageSection">
                <div className="sectionTitle">{T.t("SETTINGS_TIME_IDLE_TITLE")}</div>
                <SettingsOption title={T.t("SETTINGS_TIME_IDLE_TITLE")} description={T.t("SETTINGS_TIME_IDLE_DESC")} input={self.renderToggle("detectIdleTimeEnabled")}>
                    <SettingsChild content={
                            <div style={{ "display": "flex" }}>
                                <div style={{ "marginRight": "6px" }}>
                                    <label style={{ "textTransform": "capitalize" }}>{T.t("GENERIC_MINUTES")}</label>
                                    <input type="number" min="0" max="600" value={window.settings.detectIdleTimeMinutes * 1} onChange={(e) => self.setSetting("detectIdleTimeMinutes", e.target.value)} />
                                </div>
                                <div>
                                    <label style={{ "textTransform": "capitalize" }}>{T.t("GENERIC_SECONDS")}</label>
                                    <input type="number" min="0" max="600" value={window.settings.detectIdleTimeSeconds * 1} onChange={(e) => self.setSetting("detectIdleTimeSeconds", e.target.value)} />
                                </div>
                            </div>
                        } />
                </SettingsOption>
                <SettingsOption title="Idle dim" description="Brightness when idle. Drag left of 0 for software dim.">
                    <SettingsChild content={
                        <Slider
                            name="Idle dim"
                            min={self.getSoftwareDimMin()}
                            max={100}
                            level={self.getAdjustmentLevel(self.state.rawSettings.detectIdleBrightness ?? 0, self.state.rawSettings.detectIdleSoftwareDim)}
                            onChange={(value) => {
                                const split = self.splitAdjustmentLevel(value)
                                const newSettings = {
                                    detectIdleBrightness: split.brightness,
                                    detectIdleSoftwareDim: split.softwareDim
                                }
                                self.setState({ rawSettings: { ...self.state.rawSettings, ...newSettings } })
                                window.sendSettings(newSettings)
                            }}
                            scrolling={false}
                            height={"short"}
                            icon={false}
                        />
                    } />
                </SettingsOption>
                <SettingsOption title={T.t("SETTINGS_TIME_IDLE_FS_TITLE")} description={T.t("SETTINGS_TIME_IDLE_FS_DESC")} input={self.renderToggle("detectIdleCheckFullscreen")} />
                <SettingsOption title={T.t("SETTINGS_TIME_IDLE_MEDIA_TITLE")} description={T.t("SETTINGS_TIME_IDLE_MEDIA_DESC")} input={self.renderToggle("detectIdleMedia")} />
            </div>
            <div className="pageSection">
                <div className="sectionTitle">{T.t("SETTINGS_TIME_MONITOR_FOCUS_TITLE")}</div>
                <SettingsOption title={T.t("SETTINGS_TIME_MONITOR_FOCUS_TITLE")} description={T.t("SETTINGS_TIME_MONITOR_FOCUS_DESC")} input={self.renderToggle("monitorFocusEnabled")}>
                    <SettingsChild content={
                        <div style={{ "display": "flex" }}>
                            <div style={{ "marginRight": "6px" }}>
                                <label style={{ "textTransform": "capitalize" }}>{T.t("GENERIC_MINUTES")}</label>
                                <input type="number" min="0" max="600" value={window.settings.monitorFocusMinutes * 1} onChange={(e) => self.setSetting("monitorFocusMinutes", e.target.value)} />
                            </div>
                            <div>
                                <label style={{ "textTransform": "capitalize" }}>{T.t("GENERIC_SECONDS")}</label>
                                <input type="number" min="0" max="600" value={window.settings.monitorFocusSeconds * 1} onChange={(e) => self.setSetting("monitorFocusSeconds", e.target.value)} />
                            </div>
                        </div>
                    } />
                </SettingsOption>
                <SettingsOption title="Inactive monitor dim" description="Brightness for monitors you're not using. Drag left of 0 for software dim.">
                    <SettingsChild content={
                        <Slider
                            name="Inactive monitor dim"
                            min={self.getSoftwareDimMin()}
                            max={100}
                            level={self.getAdjustmentLevel(self.state.rawSettings.monitorFocusDimLevel ?? 0, self.state.rawSettings.monitorFocusSoftwareDim)}
                            onChange={(value) => {
                                const split = self.splitAdjustmentLevel(value)
                                const newSettings = {
                                    monitorFocusDimLevel: split.brightness,
                                    monitorFocusSoftwareDim: split.softwareDim
                                }
                                self.setState({ rawSettings: { ...self.state.rawSettings, ...newSettings } })
                                window.sendSettings(newSettings)
                            }}
                            scrolling={false}
                            height={"short"}
                            icon={false}
                        />
                    } />
                </SettingsOption>
                <SettingsOption title="Animate brightness changes" description="When off, brightness changes instantly instead of fading. Disable if your monitor flickers during DDC updates." input={self.renderToggle("brightnessAnimationEnabled")} />
                {window.settings.brightnessAnimationEnabled !== false && <SettingsOption title="Dim transition speed" description="How fast the dim animation runs (brightness units per second). Higher = faster.">
                    <SettingsChild content={
                        <div>
                            <label style={{ "textTransform": "capitalize" }}>units/s</label>
                            <input type="number" min="1" max="100" step="1" value={window.settings.monitorFocusTransitionRate ?? 20} onChange={(e) => self.setSetting("monitorFocusTransitionRate", Math.max(1, parseInt(e.target.value) || 1))} />
                        </div>
                    } />
                </SettingsOption>}
            </div>
        </>
    )
}
