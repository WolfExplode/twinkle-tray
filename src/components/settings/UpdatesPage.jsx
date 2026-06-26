// "Updates" settings page. Extracted verbatim from SettingsWindow.render();
// `self` is the parent instance.
import React from "react"
import { T } from "./shared"
import { SettingsOption } from "../SettingsOption"

export default function UpdatesPage({ self }) {
    return (
        <>
            <div className="pageSection">
                <div className="sectionTitle">{T.t("SETTINGS_UPDATES_TITLE")}</div>
                <p>{T.h("SETTINGS_UPDATES_VERSION", '<b>' + (window.version ? `${window.version}${window.versionTag && window.versionBuild ? ` (${window.versionBuild})` : ""}` : "not available") + '</b>')}</p>
                {self.getUpdate()}
            </div>
            <div className="pageSection" style={{ display: (window.isAppX ? "none" : (self.isSection("updates") ? "block" : "none")) }}>
                <SettingsOption title={T.t("SETTINGS_UPDATES_AUTOMATIC_TITLE")} description={T.t("SETTINGS_UPDATES_AUTOMATIC_DESC")} input={self.renderToggle("checkForUpdates")} />
                <SettingsOption title={T.t("SETTINGS_UPDATES_CHANNEL")} input={
                    <select value={self.state.rawSettings.branch} onChange={(e) => { window.sendSettings({ branch: e.target.value }) }}>
                        <option value="master">{T.t("SETTINGS_UPDATES_BRANCH_STABLE")}</option>
                        <option value="beta">{T.t("SETTINGS_UPDATES_BRANCH_BETA")}</option>
                    </select>
                } />
            </div>
        </>
    )
}
