// "Debug" settings page. Extracted verbatim from SettingsWindow.render();
// `self` is the parent instance.
import React from "react"
import { T } from "./shared"
import { SettingsOption, SettingsChild } from "../SettingsOption"

export default function DebugPage({ self }) {
    return (
        <>
            <div className="pageSection debug">
                <SettingsOption title="All Displays" expandable={true} forceExpandable={true} input={<><a className="button" onClick={() => { window.requestMonitors(true) }}>Refresh Monitors</a> <a className="button" onClick={() => window.ipc.send('flush-vcp-cache')}>Clear Cache</a></>}>
                    <SettingsChild description={self.getDebugMonitors()} />
                </SettingsOption>

                <SettingsOption title="Save Report" description={"Save a text file with information about your monitors and settings for debugging."} input={<><a className="button" onClick={() => window.ipc.send('save-report')}>Generate Report</a></>} />

                <SettingsOption title="Settings" description={window.settingsPath} input={<a className="button" onClick={() => window.ipc.send('open-settings-file')}>Open Settings</a>} expandable={true} forceExpandable={true}>
                    <SettingsChild>
                        <p style={{ whiteSpace: "pre-wrap", fontFamily: '"Cascadia Code", "Consolas", sans-serif' }}>{JSON.stringify(self.state.rawSettings, undefined, 2)}</p>
                    </SettingsChild>
                </SettingsOption>

                <SettingsOption title="Raw Monitor Data" expandable={true} forceExpandable={true}>
                    <SettingsChild>
                        <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(window.allMonitors, undefined, 2)}</pre>
                    </SettingsChild>
                </SettingsOption>
            </div>

            <div className="pageSection debug">
                <div className="sectionTitle">Other</div>

                <SettingsOption title="Dev Mode" input={self.renderToggle("isDev")} />
                <SettingsOption title="UDP Server" expandable={true}>
                    <SettingsChild title="Enable UDP server" input={self.renderToggle("udpEnabled")} />
                    <SettingsChild title="Enable UDP commands outside of localhost" input={self.renderToggle("udpRemote")} />
                    <SettingsChild title="Default port for UDP commands" input={<input type="number" min="1" max="65535" value={window.settings.udpPortStart * 1} onChange={(e) => self.setSetting("udpPortStart", e.target.value)} />} />
                    <SettingsChild title={`Active port: ${window.settings.udpPortActive}`} />
                    <SettingsChild title={`UDP key: ${window.settings.udpKey}`} />
                </SettingsOption>

                <SettingsOption title="DDC/CI Scanning Mode" description={`Last test result: ${window.settings?.lastDetectedDDCCIMethod}`} input={
                    <select value={self.state.rawSettings.preferredDDCCIMethod} onChange={e => {
                        window.sendSettings({ preferredDDCCIMethod: e.target.value })
                    }}>
                        <option value="auto">Auto</option>
                        <option value="fast">Fast</option>
                        <option value="accurate">Accurate</option>
                        <option value="no-validation">No validation</option>
                        <option value="legacy">Legacy (v1.15.4 behavior)</option>
                    </select>
                } />

                <SettingsOption title={T.t("SETTINGS_MONITORS_HDR_DISPLAYS_TITLE")} description={T.t("SETTINGS_MONITORS_HDR_DISPLAYS_DESC")} expandable={true}>
                    {self.getHDRMonitors()}
                </SettingsOption>

                <SettingsOption title="Idle restore time" description="How long (in seconds) after going idle to rescan displays and apply last known brightness." input={<input type="number" min="0" max="60" value={self.state.rawSettings.idleRestoreSeconds * 1} onChange={(e) => self.setSetting("idleRestoreSeconds", e.target.value)} /> } />

                <SettingsOption title="Wake restore time" description="How long (in seconds) after waking from sleep to rescan displays and apply last known brightness." input={<input type="number" min="0" max="60" value={self.state.rawSettings.wakeRestoreSeconds * 1} onChange={(e) => self.setSetting("wakeRestoreSeconds", e.target.value)} /> } />

                <SettingsOption title="Hardware change time" description="How long (in seconds) after detecting a hardware change to rescan displays and apply last known brightness." input={<input type="number" min="0" max="60" value={self.state.rawSettings.hardwareRestoreSeconds * 1} onChange={(e) => self.setSetting("hardwareRestoreSeconds", e.target.value)} /> } />

                <SettingsOption title="VCP read delay" description="How long (in miliseconds) to delay returning a VCP code value. This can help some displays not return random errors." input={<input type="number" min="0" max="200" value={self.state.rawSettings.checkVCPWaitMS * 1} onChange={(e) => self.setSetting("checkVCPWaitMS", e.target.value)} /> } />

                <SettingsOption title="Flyout scroll amount" description="How large of steps to take when scrolling over a slider." input={<input type="number" min="1" max="10" value={self.state.rawSettings.scrollFlyoutAmount * 1} onChange={(e) => self.setSetting("scrollFlyoutAmount", e.target.value)} /> } />

                <SettingsOption title="Disable theme update detection" description="Prevent the app from detecting theme/wallpaper changes from Windows. This may help if a 3rd party app is frequently changing the theme, increasing CPU usage." input={self.renderToggle("disableThemeChanges")} />
                <SettingsOption title="Restart app on wake" input={self.renderToggle("restartOnWake")} />
                <SettingsOption title="Disable Auto Refresh" description="Prevent last known brightness from read after certain hardware/user events." input={self.renderToggle("disableAutoRefresh")} />
                <SettingsOption title="Use Win32 hardware events" input={self.renderToggle("useWin32Event")} />
                <SettingsOption title="Use Electron hardware events" input={self.renderToggle("useElectronEvents")} />
                <SettingsOption title="Use WM_DISPLAYCHANGE events" input={self.renderToggle("useWmDisplayChangeEvent")} />
                <SettingsOption title="Use SC_MONITORPOWER events" input={self.renderToggle("useScMonitorPowerEvent")} />
                <SettingsOption title="Use GUID_SESSION_USER_PRESENCE events" input={self.renderToggle("useGuidPresenceEvent")} />
                <SettingsOption title="Use GUID_VIDEO_CURRENT_MONITOR_BRIGHTNESS events" input={self.renderToggle("useGuidBrightnessEvent")} />
                <SettingsOption title="Reload tray icon on hardware events" input={self.renderToggle("reloadTray")} />
                <SettingsOption title="Reload flyout panel on hardware events" input={self.renderToggle("reloadFlyout")} />
                <SettingsOption title="Show console window (requires restart)" input={self.renderToggle("showConsole")} />
                <SettingsOption title="Use Taskbar Registry" input={self.renderToggle("useTaskbarRegistry")} />
                <SettingsOption title="Disable Mouse Events (requires restart)" input={self.renderToggle("disableMouseEvents")} />

            </div>
        </>
    )
}
