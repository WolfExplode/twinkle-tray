// "Hotkeys" (+ scroll, time-of-day, profiles) settings page.
// Extracted verbatim from SettingsWindow.render(); `self` is the parent instance.
import React from "react"
import { T, uuid, defaultAction, AppProfile, addNewProfile } from "./shared"
import { SettingsOption, SettingsChild } from "../SettingsOption"

export default function HotkeysPage({ self }) {
    return (
        <>
            <div className="pageSection">
                <div className="sectionTitle">{T.t("SETTINGS_HOTKEYS_TITLE")}</div>
                <p>{T.t("SETTINGS_HOTKEYS_DESC")}</p>
                <div className="hotkey-monitors">
                    {self.getHotkeyList()}
                    <p><a className="button" onClick={() => {
                        self.state.hotkeys.push({
                            accelerator: "",
                            actions: [
                                Object.assign({}, defaultAction)
                            ],
                            id: uuid()
                        })
                        window.sendSettings({ hotkeys: self.state.hotkeys.slice() })
                        self.forceUpdate()
                    }}>+ {T.t("SETTINGS_HOTKEYS_ADD")}</a></p>
                </div>

            </div>

            <div className="pageSection">
                <SettingsOption title={T.t("SETTINGS_HOTKEYS_BREAK_TITLE")} description={T.t("SETTINGS_HOTKEYS_BREAK_DESC")} input={self.renderToggle("hotkeysBreakLinkedLevels")} />
            </div>

            <div className="pageSection">
                <div className="sectionTitle">{T.t("SETTINGS_GENERAL_SCROLL_TITLE")}</div>
                <SettingsOption title={T.t("SETTINGS_GENERAL_SCROLL_TITLE")} description={T.t("SETTINGS_GENERAL_SCROLL_DESC")} input={self.renderToggle("scrollShortcut")}>
                    <SettingsChild title={T.t("SETTINGS_HOTKEYS_SCROLL_AMOUNT")} className="win10-stack-input" input={
                        <input type="number" min={1} max={100} step={1}
                        value={self.state.rawSettings.scrollShortcutAmount} onChange={e => {
                            self.state.rawSettings.scrollShortcutAmount = parseInt(e.target.value)
                            window.sendSettings({ scrollShortcutAmount: parseInt(e.target.value) })
                            self.forceUpdate()
                        }} />
                    } />
                    <SettingsChild title={T.t("SETTINGS_HOTKEYS_INVERT_SCROLL_TITLE")} description={T.t("SETTINGS_HOTKEYS_INVERT_SCROLL_DESC")} input={self.renderToggle("invertScroll")} />
                </SettingsOption>
            </div>

            <div className="pageSection">
                <div className="sectionTitle">{T.t("SETTINGS_HOTKEYS_TOD_TITLE")}</div>
                <SettingsOption title={T.t("SETTINGS_HOTKEYS_TOD_TITLE")} description={T.t("SETTINGS_HOTKEYS_TOD_DESC")} input={
                    <select value={self.state.rawSettings.sleepAction} onChange={self.sleepActionChanged}>
                        <option value="none">{T.t("SETTINGS_HOTKEYS_TOD_NONE")}</option>
                        <option value="ps">{T.t("SETTINGS_HOTKEYS_TOD_SOFT")}</option>
                        <option value="ddcci">{T.t("SETTINGS_HOTKEYS_TOD_HARD")}</option>
                        <option value="ps_ddcci">{T.t("SETTINGS_HOTKEYS_TOD_BOTH")}</option>
                    </select>
                }>
                    <SettingsChild description={
                        <div>
                            <i>{T.t("SETTINGS_HOTKEYS_TOD_NOTE")}</i>
                            { (self.state.rawSettings?.sleepAction === "ddcci" || self.state.rawSettings?.sleepAction === "ps_ddcci" ? (<div className="ddc-warning"><br />⚠️ <em>{T.t("GENERIC_DDC_WARNING")}</em></div>) : null) }
                        </div>
                    } />
                </SettingsOption>
                <p></p>


            </div>

            <div className="pageSection">
                <div className="sectionTitle">{T.t("SETTINGS_PROFILES_TITLE")}</div>
                <p>{T.t("SETTINGS_PROFILES_DESC")}</p>
                <div className="hotkey-profiles">
                    {self.state.rawSettings?.profiles?.map((profile, idx) => <AppProfile key={`${idx}__${profile.uuid}`} profile={profile} monitors={self.state.monitors} updateValue={(key, value) => {
                        profile[key] = value
                        window.sendSettings({ profiles: self.state.rawSettings?.profiles })
                        self.forceUpdate()
                    }}
                        onDelete={
                            () => {
                                self.state.rawSettings?.profiles.splice(idx, 1)
                                window.sendSettingsImmediate({ profiles: self.state.rawSettings?.profiles })
                                self.forceUpdate()
                            }
                        } />)}
                    <p><a className="add-new button" onClick={() => addNewProfile(self.state)}>+ {T.t("SETTINGS_PROFILES_ADD")}</a></p>
                </div>

            </div>
        </>
    )
}
