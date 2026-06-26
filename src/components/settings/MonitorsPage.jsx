// "Monitors" settings page. Extracted verbatim from SettingsWindow.render();
// `self` is the parent instance. The drag-to-reorder list is produced by
// self.getReorderMonitors() (DragDropContext still owned by the parent).
import React from "react"
import { T } from "./shared"
import { SettingsOption, SettingsChild } from "../SettingsOption"
import Slider from "../Slider"

export default function MonitorsPage({ self }) {
    return (
        <>
            <div className="pageSection">
                <div className="sectionTitle">{T.t("GENERIC_ALL_DISPLAYS")}</div>
                <div className="monitorItem-list">
                    {self.getInfoMonitors()}
                </div>
            </div>

            <div className="pageSection">
                <SettingsOption title={T.t("SETTINGS_MONITORS_RATE_TITLE")} description={T.t("SETTINGS_MONITORS_RATE_DESC")} input={(
                    <select value={self.state.updateInterval} onChange={self.updateIntervalChanged}>
                        <option value="100">{T.t("SETTINGS_MONITORS_RATE_0")}</option>
                        <option value="250">{T.t("SETTINGS_MONITORS_RATE_1")}</option>
                        <option value="500">{T.t("SETTINGS_MONITORS_RATE_2")}</option>
                        <option value="1000">{T.t("SETTINGS_MONITORS_RATE_3")}</option>
                        <option value="2000">{T.t("SETTINGS_MONITORS_RATE_4")}</option>
                    </select>
                )} />
                <SettingsOption title={T.t("SETTINGS_MONITORS_HIDE_DISPLAYS_TITLE")} description={T.t("SETTINGS_MONITORS_HIDE_DISPLAYS_DESC")} expandable={true}>
                    {self.getHideMonitors()}
                </SettingsOption>
                <SettingsOption title={T.t("SETTINGS_MONITORS_HIDE_INTERNAL_TITLE")} description={T.t("SETTINGS_MONITORS_HIDE_INTERNAL_DESC")} input={self.renderToggle("hideClosedLid")} />
                <SettingsOption title={T.t("SETTINGS_MONITORS_RENAME_TITLE")} description={T.t("SETTINGS_MONITORS_RENAME_DESC")} expandable={true}>
                    {self.getRenameMonitors()}
                </SettingsOption>
                <SettingsOption title={T.t("SETTINGS_MONITORS_REORDER_TITLE")} description={T.t("SETTINGS_MONITORS_REORDER_DESC")} expandable={true}>
                    <SettingsChild content={
                        <div className="reorderList">
                            {self.getReorderMonitors()}
                        </div>
                    } />
                </SettingsOption>
                <SettingsOption title={T.t("SETTINGS_MONITORS_SDR_SLIDER_TITLE")} description={T.t("SETTINGS_MONITORS_SDR_SLIDER_DESCRIPTION")} expandable={true}>
                    {self.getSDRMonitorsSettings()}
                </SettingsOption>
            </div>

            <div className="pageSection">
                <div className="sectionTitle">{T.t("SETTINGS_MONITORS_NORMALIZE_TITLE")}</div>
                <p>{T.t("SETTINGS_MONITORS_NORMALIZE_DESC")}</p>
                <p>{T.t("SETTINGS_MONITORS_CALIBRATION_DESC")}</p>
                {self.getMinMaxMonitors()}
            </div>

            <div className="pageSection">
                <div className="sectionTitle">Software Dim</div>
                <SettingsOption title="Max software dim" description="How far the brightness slider can extend into the software dim zone (0–100%). Software dim works by placing a transparent black overlay on the display.">
                    <SettingsChild content={
                        <Slider min={0} max={100} level={window.settings.softwareDimMax ?? 100} onChange={(value) => self.setSetting("softwareDimMax", value)} scrolling={false} height={"short"} icon={false} />
                    } />
                </SettingsOption>
            </div>
        </>
    )
}
