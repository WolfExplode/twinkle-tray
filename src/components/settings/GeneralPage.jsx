// "General" settings page. Extracted verbatim from SettingsWindow.render().
// Receives the parent SettingsWindow instance as `self` for state + handlers;
// state ownership stays on the parent for now (see settings/README intent).
import React from "react"
import { T } from "./shared"
import { SettingsOption, SettingsChild } from "../SettingsOption"
import DefaultIcon from "../../assets/tray-icons/dark/icon@4x.png"
import MDL2Icon from "../../assets/tray-icons/dark/mdl2@4x.png"
import FluentIcon from "../../assets/tray-icons/dark/fluent@4x.png"

export default function GeneralPage({ self }) {
    return (
        <>
            <div className="pageSection">

                <div className="sectionTitle">{T.t("SETTINGS_GENERAL_TITLE")}</div>

                <SettingsOption title={T.t("SETTINGS_GENERAL_STARTUP")} input={self.renderToggle("openAtLogin")} />

                <SettingsOption title={T.t("SETTINGS_GENERAL_BRIGHTNESS_STARTUP_TITLE")} description={T.t("SETTINGS_GENERAL_BRIGHTNESS_STARTUP_DESC")} input={self.renderToggle("brightnessAtStartup")} />

                <SettingsOption title={T.t("SETTINGS_GENERAL_DISABLE_ON_LOCK_SCREEN_TITLE")} description={T.t("SETTINGS_GENERAL_DISABLE_ON_LOCK_SCREEN_DESC")} input={self.renderToggle("disableOnLockScreen")} />

                <SettingsOption title={T.t("SETTINGS_GENERAL_LANGUAGE_TITLE")} input={(
                    <select value={window.settings.language} onChange={(e) => {
                        self.setState({ language: e.target.value })
                        window.sendSettings({ language: e.target.value })
                    }}>
                        <option value="system">{T.t("SETTINGS_GENERAL_LANGUAGE_SYSTEM")}</option>
                        {self.getLanguages()}
                    </select>
                )} />

                <SettingsOption title={T.t("SETTINGS_GENERAL_THEME_TITLE")} input={(
                    <select value={window.settings.theme} onChange={self.themeChanged}>
                        <option value="default">{T.t("SETTINGS_GENERAL_THEME_SYSTEM")}</option>
                        <option value="dark">{T.t("SETTINGS_GENERAL_THEME_DARK")}</option>
                        <option value="light">{T.t("SETTINGS_GENERAL_THEME_LIGHT")}</option>
                    </select>
                )} />

                <SettingsOption title={T.t("SETTINGS_GENERAL_WINDOWS_UI_STYLE_TITLE")} input={(
                    <select value={window.settings.windowsStyle} onChange={(e) => self.setSetting("windowsStyle", e.target.value)}>
                        <option value="system">{T.t("SETTINGS_GENERAL_THEME_SYSTEM")}</option>
                        <option value="win10">Windows 10</option>
                        <option value="win11">Windows 11</option>
                    </select>
                )} />

                <div className="win10only">
                    <SettingsOption title={T.t("SETTINGS_GENERAL_ACRYLIC_TITLE")} description={T.t("SETTINGS_GENERAL_ACRYLIC_DESC")} input={self.renderToggle("useAcrylic")} />
                </div>

                <div className="win11only">
                    <SettingsOption title={T.t("SETTINGS_GENERAL_MICA_TITLE")} description={T.t("SETTINGS_GENERAL_MICA_DESC")} input={self.renderToggle("useAcrylic")} />
                </div>

                <SettingsOption title={T.t("SETTINGS_GENERAL_TRAY_ICON_TITLE")} input={(
                    <div className="icons-row">
                        <div className="icon-option" data-active={self.isIcon("icon")} onClick={() => window.sendSettings({ icon: "icon" })}>
                            <img src={DefaultIcon} />
                        </div>
                        <div className="icon-option" data-active={self.isIcon("mdl2")} onClick={() => window.sendSettings({ icon: "mdl2" })}>
                            <img src={MDL2Icon} />
                        </div>
                        <div className="icon-option" data-active={self.isIcon("fluent")} onClick={() => window.sendSettings({ icon: "fluent" })}>
                            <img src={FluentIcon} />
                        </div>
                    </div>
                )} />

                <SettingsOption title={T.t("SETTINGS_GENERAL_ANALYTICS_TITLE")} description={T.h("SETTINGS_GENERAL_ANALYTICS_DESC", '<a href="javascript:window.openURL(\'privacy-policy\')">' + T.t("SETTINGS_GENERAL_ANALYTICS_LINK") + '</a>')} input={self.renderToggle("analytics")} />

            </div>

            <div className="pageSection">
                <div className="sectionTitle">{T.t("SETTINGS_GENERAL_TROUBLESHOOTING")}</div>

                <SettingsOption title={T.t("SETTINGS_GENERAL_DIS_MONITOR_FEATURES_TITLE")} description={T.h("SETTINGS_GENERAL_DIS_MONITOR_FEATURES_DESC", '<a href="javascript:window.openURL(\'troubleshooting-features\')">' + T.t("SETTINGS_GENERAL_ANALYTICS_LINK") + '</a>')} expandable={true}>
                    <SettingsChild title={"Apple Studio Displays"} input={self.renderToggle("disableAppleStudio", true, "right", true)} />
                    <SettingsChild title={"DDC/CI HL"} input={self.renderToggle("disableHighLevel", true, "right", true)} />
                    <SettingsChild title={"HDR"} input={self.renderToggle("disableHDR", true, "right", true)} />
                    <SettingsChild title={"WMIC"} input={self.renderToggle("disableWMIC", true, "right", true)} />
                    <SettingsChild title={"WMI-Bridge"} input={self.renderToggle("disableWMI", true, "right", true)} />
                    <SettingsChild title={"Win32-DisplayConfig"} input={self.renderToggle("disableWin32", true, "right", true)} />
                </SettingsOption>

               <SettingsOption title={T.t("SETTINGS_GENERAL_LEGACY_DDC_TITLE")} description={T.t("SETTINGS_GENERAL_LEGACY_DDC_DESC")} input={
                    <div className="inputToggle-generic" data-textside={"right"}>
                        <input onChange={(e) => { self.setSetting("preferredDDCCIMethod", (e.target.checked ? "legacy" : "accurate")) }} checked={(self.state.rawSettings.preferredDDCCIMethod == "legacy")} data-checked={(self.state.rawSettings.preferredDDCCIMethod == "legacy")} type="checkbox" />
                        <div className="text">{((self.state.rawSettings.preferredDDCCIMethod == "legacy") ? T.t("GENERIC_ON") : T.t("GENERIC_OFF"))}</div>
                    </div>
                } />

                <SettingsOption title={T.t("SETTINGS_GENERAL_OVERLAY_TITLE")} description={T.t("SETTINGS_GENERAL_OVERLAY_DESC")} input={
                <select value={window.settings.defaultOverlayType} onChange={(e) => self.setSetting("defaultOverlayType", e.target.value)}>
                    <option value="disabled">{T.t("SETTINGS_GENERAL_DIS_OVERLAY_TITLE")}</option>
                    <option value="safe">{T.t("SETTINGS_GENERAL_ON_OVERLAY_TITLE")}</option>
                    <option value="aggressive">{T.t("SETTINGS_GENERAL_FORCE_OVERLAY_TITLE")}</option>
                </select>
                } expandable={true}>
                    <SettingsChild>
                        <p><i>
                            <b>{T.t("SETTINGS_GENERAL_DIS_OVERLAY_TITLE")}:</b> {T.t("SETTINGS_GENERAL_DIS_OVERLAY_DESC")}<br />
                            <b>{T.t("SETTINGS_GENERAL_ON_OVERLAY_TITLE")}:</b> {T.t("SETTINGS_GENERAL_ON_OVERLAY_DESC")}<br />
                            <b>{T.t("SETTINGS_GENERAL_FORCE_OVERLAY_TITLE")}:</b> {T.t("SETTINGS_GENERAL_FORCE_OVERLAY_DESC")}
                        </i></p>
                    </SettingsChild>
                </SettingsOption>

                <SettingsOption title={T.t("SETTINGS_GENERAL_AUTOBRIGHT_TITLE")} description={T.t("SETTINGS_GENERAL_AUTOBRIGHT_DESC")} input={self.renderToggle("disableAutoApply", undefined, undefined, true)} />

                <SettingsOption title={T.t("SETTINGS_GENERAL_SKIP_APPLY_TITLE")} description={T.t("SETTINGS_GENERAL_SKIP_APPLY_DESC")} expandable={true}>
                    {self.getSkipRestoreMonitors()}
                </SettingsOption>

                <SettingsOption title={T.t("SETTINGS_GENERAL_SKIP_THEME_CHANGES_TITLE")} description={T.t("SETTINGS_GENERAL_SKIP_THEME_CHANGES_DESC")} input={self.renderToggle("disableThemeChanges", undefined, undefined, true)} />

                <SettingsOption title={T.t("SETTINGS_GENERAL_SKIP_POWER_EVENTS_TITLE")} description={T.t("SETTINGS_GENERAL_SKIP_POWER_EVENTS_DESC")} input={self.renderToggle("disablePowerNotifications", undefined, undefined, true)} />

                <SettingsOption title={T.t("SETTINGS_GENERAL_REPORT_TITLE")} description={T.t("SETTINGS_GENERAL_REPORT_DESC")} input={<><a className="button" onClick={() => window.ipc.send('save-report')}>{T.t("SETTINGS_GENERAL_REPORT_TITLE")}</a></>} />

                <SettingsOption title={T.t("SETTINGS_GENERAL_RESET_TITLE")} description={T.t("SETTINGS_GENERAL_RESET_DESC")} input={<a className="button" onClick={window.resetSettings}>{T.t("SETTINGS_GENERAL_RESET_BUTTON")}</a>} />

            </div>
        </>
    )
}
