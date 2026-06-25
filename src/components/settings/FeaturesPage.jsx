// "Features" settings page. Extracted verbatim from SettingsWindow.render();
// `self` is the parent instance.
import React from "react"
import { T } from "./shared"
import { SettingsOption, SettingsChild } from "../SettingsOption"

export default function FeaturesPage({ self }) {
    return (
        <>
            <div className="pageSection">
                <div className="sectionTitle">{T.t("SETTINGS_SIDEBAR_FEATURES")}</div>
                <p>{T.t("SETTINGS_FEATURES_DESCRIPTION")}</p>
                {self.getFeaturesMonitors()}
            </div>
            <div className="pageSection">
                <SettingsOption title={T.t("SETTINGS_FEATURES_CUR_BRIGHTNESS_TITLE")} description={T.t("SETTINGS_FEATURES_CUR_BRIGHTNESS_DESC")} input={self.renderToggle("getDDCBrightnessUpdates")} />
                <SettingsOption title={T.t("SETTINGS_FEATURES_POWER_TITLE")} description={T.t("SETTINGS_FEATURES_POWER_DESC")} input={
                    <select value={self.state.rawSettings.ddcPowerOffValue} onChange={e => {
                        self.setState({ ddcPowerOffValue: parseInt(e.target.value) })
                        window.sendSettings({ ddcPowerOffValue: parseInt(e.target.value) })
                    }}>
                        <option value={4}>{T.t("SETTINGS_FEATURES_POWER_STANDBY")} (4) ⚠️</option>
                        <option value={5}>{T.t("SETTINGS_FEATURES_POWER_OFF")} (5)</option>
                        <option value={6}>{T.t("SETTINGS_FEATURES_POWER_COMPAT")} (4 &amp; 5)</option>
                    </select>
                }>
                    <SettingsChild description={<>⚠️ <em>{T.t("SETTINGS_FEATURES_POWER_WARNING")}</em></>} />
                </SettingsOption>
            </div>
        </>
    )
}
