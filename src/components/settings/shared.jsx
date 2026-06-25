// Shared helpers for the settings pages.
//
// These were module-scope helpers and sub-components inside the old 2000-line
// SettingsWindow.jsx. They're pulled out here so the per-page components (and
// the parent shell) can each import exactly what they use. `T` is the single
// shared TranslateReact instance — created once, mutated in place by the parent
// when localization data arrives, so every page sees the same translations.

import React from "react"
import TranslateReact from "../../TranslateReact"
import Slider from "../Slider"
import { SettingsOption, SettingsChild } from "../SettingsOption"
import SafeRender from "../SafeRender"

// The one shared translation instance. Never reassign — mutate via its methods.
export const T = new TranslateReact({}, {})

export const uuid = () => crypto.randomUUID()

export function vcpStr(code) {
    return `0x${parseInt(code).toString(16).toUpperCase()}`
}

export const reorder = (list, startIndex, endIndex) => {
    const result = Array.from(list);
    const [removed] = result.splice(startIndex, 1);
    result.splice(endIndex, 0, removed);
    return result;
};

export const getItemStyle = (isDragging, draggableStyle) => ({
    userSelect: "none",
    background: isDragging ? "rgba(122, 122, 122, 0.2)" : "none",
    ...draggableStyle
});

export const monitorSort = (a, b) => {
    const aSort = (a.order === undefined ? 999 : a.order * 1)
    const bSort = (b.order === undefined ? 999 : b.order * 1)
    return aSort - bSort
}

export const deleteIcon = (<span className="icon" dangerouslySetInnerHTML={{ __html: "&#xE74D;" }}></span>)

export const cleanUpKeyboardKeys = (inKey, inCode = false) => {
    let key = inKey
    let code = inCode

    if (key.length == 1) {
        key = key.toUpperCase()
    }

    switch (key) {
        case "Meta":
            key = "Super";
            break;
        case " ":
            key = "Space";
            break;
        case "ArrowUp":
            key = "Up";
            break;
        case "ArrowDown":
            key = "Down";
            break;
        case "ArrowLeft":
            key = "Left";
            break;
        case "ArrowRight":
            key = "Right";
            break;
        case "+":
            key = "Plus";
            break;
        case "-":
            key = "Minus";
            break;
    }

    if (code >= 96 && code <= 105) key = "num" + (code - 96);

    switch (code) {
        case 106: key = "nummult"; break;
        case 107: key = "numadd"; break;
        case 109: key = "numsub"; break;
        case 110: key = "numdec"; break;
        case 111: key = "numdiv"; break;
    }

    return key;
}

export const defaultAction = {
    type: "set",
    target: "brightness",
    monitors: {},
    allMonitors: false,
    value: 0,
    values: [0],
    id: uuid()
}

export function addNewProfile(state) {
    if (!state.rawSettings?.profiles) return false;
    const id = uuid()
    const profile = {
        id,
        uuid: uuid(),
        name: "",
        overlayType: "normal",
        setBrightness: false,
        monitors: {},
        showInMenu: false
    }
    state.rawSettings.profiles.push(profile)
    window.sendSettings({ profiles: state.rawSettings.profiles })
}

export function getProfileMonitors(monitors, profile, onChange) {
    return Object.values(monitors).map((monitor, idx) => {
        if (monitor.type == "none") {
            return (null)
        } else {
            let level = (profile.monitors?.[monitor.id] ?? 50)
            return (<Slider key={monitor.id + ".brightness"} min={0} max={100} name={monitor.name} height="short" onChange={level => {
                profile.monitors[monitor.id] = level
                onChange(profile, monitor.id, level)
            }} level={level} scrolling={false} />)
        }
    })
}

export function getMonitorName(monitor, renames) {
    if (Object.keys(renames).indexOf(monitor.id) >= 0 && renames[monitor.id] != "") {
        return renames[monitor.id] + ` (${monitor.name})`
    } else {
        return monitor.name
    }
}

export function AppProfile(props) {
    const { profile, updateValue, onDelete, monitors } = props
    if (!profile.monitors) profile.monitors = {};

    return (
        <SettingsOption title={<input type="text" placeholder={T.t("SETTINGS_PROFILES_NAME")} value={profile.name} onChange={e => updateValue("name", e.target.value)} style={{width:"100%"}}></input>} expandable={true} input={<a className="add-new button button-primary block" onClick={onDelete}>{ deleteIcon } <span>{T.t("GENERIC_DELETE")}</span></a>} className="appProfileItem win10-has-background" key={profile.id}>
            <SettingsChild content={
                <>
                    <div className="feature-toggle-row">
                        <input onChange={(e) => { updateValue("setBrightness", e.target.checked) }} checked={profile.setBrightness} data-checked={profile.setBrightness} type="checkbox" />
                        <div className="feature-toggle-label"><span>{T.t("SETTINGS_PROFILES_BRIGHTNESS_TOGGLE")}</span></div>
                    </div>

                    <div className="profile-monitors">
                        {(profile.setBrightness ? getProfileMonitors(monitors, profile, profile => updateValue("monitors", profile.monitors)) : null)}
                    </div>

                    {(profile.setBrightness ? (
                        <div className="feature-toggle-row">
                            <input onChange={(e) => { updateValue("showInMenu", e.target.checked) }} checked={profile.showInMenu} data-checked={profile.showInMenu} type="checkbox" />
                            <div className="feature-toggle-label"><span>{T.t("SETTINGS_PROFILES_SHOW_MENU")}</span></div>
                        </div>
                    ) : null)}
                </>
            } />
            <SettingsChild content={
                <>
                    <div className="option-title">{T.t("SETTINGS_PROFILES_TRIGGER_TITLE")} ({T.t("GENERIC_OPTIONAL")})</div>
                    <br />

                    <label>{T.t("SETTINGS_PROFILES_APP_PATH")}</label>
                    <p>{T.t("SETTINGS_PROFILES_APP_DESC")}</p>
                    <input type="text" placeholder={T.t("SETTINGS_PROFILES_APP_PATH")} value={profile.path} onChange={e => updateValue("path", e.target.value)} style={{width:"100%"}}></input>
                    <label>{T.t("SETTINGS_PROFILES_OVERLAY_TITLE")}</label>
                    <p>{T.t("SETTINGS_PROFILES_OVERLAY_DESC")}</p>
                    <select value={profile.overlayType} onChange={e => updateValue("overlayType", e.target.value)}>
                        <option value="normal">{T.t("GENERIC_DEFAULT")}</option>
                        <option value="safe">{T.t("SETTINGS_GENERAL_DIS_OVERLAY_TITLE")}</option>
                        <option value="disabled">{T.t("SETTINGS_GENERAL_ON_OVERLAY_TITLE")}</option>
                        <option value="aggressive">{T.t("SETTINGS_GENERAL_FORCE_OVERLAY_TITLE")}</option>
                    </select>
                </>
            } />
        </SettingsOption>
    )
}

export function SettingsPage(props) {
    if (props.current === props.id) {
        return (
            <SafeRender><div className="settings-page">{props.children}</div></SafeRender>
        )
    }
    return null
}

export function ActionItem(props) {
    const { action, monitors, monitorNames } = props
    const showDisplaysList = (action.type != "off" && action.type != "refresh")

    const getHotkeyMonitors = () => {
        try {
            if(action.allMonitors) return (null)
            if (monitors == undefined || Object.keys(monitors).length == 0) {
                return (<div className="no-displays-message option-description" style={{lineHeight:1.35}}>{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}</div>)
            } else {
                return Object.values(monitors).map((monitor, index) => {
                    if(monitor.type === "none") return null;
                    return (
                        <div key={monitor.key} className="feature-toggle-row">
                            <input onChange={e => {
                                if (!action.monitors) action.monitors = {};
                                action.monitors[monitor.id] = e.target.checked
                                props.onChange?.(action)
                            }} checked={(action.monitors?.[monitor.id] ? true : false)} data-checked={(action.monitors?.[monitor.id] ? true : false)} type="checkbox" />
                            <div className="feature-toggle-label" style={{ display: "flex", alignItems: "center", gap: "8px" }}>{getMonitorName(monitor, monitorNames)}</div>
                        </div>
                    )

                })
            }
        } catch (e) {
            console.log(e)
        }
    }

    const getHotkeyInput = () => {
        if (action.type === "off") {
            return (<div className="input-row"><p style={{lineHeight: 1.2}}>{T.t("SETTINGS_HOTKEY_OFF_WARN")}</p></div>)
        } else if (action.type === "refresh") {
            return null
        } else {
            let selectBoxValue = action.target
            if (!(selectBoxValue === "brightness" || selectBoxValue === "sdr" || selectBoxValue === "contrast" || selectBoxValue === "volume" || selectBoxValue === "powerState")) {
                selectBoxValue = "vcp"
            }
            const selectBox = (
                <div className="field">
                    <label>{T.t("SETTINGS_HOTKEY_TARGET")}</label>
                    <select value={selectBoxValue} onChange={e => {
                        const value = e.target.value
                        if (value === "vcp") {
                            action.target = ""
                        } else {
                            action.target = value
                        }
                        props.onChange?.(action)
                    }}>
                        <option value="brightness">{T.t("PANEL_LABEL_BRIGHTNESS")}</option>
                        <option value="contrast">{T.t("PANEL_LABEL_CONTRAST")}</option>
                        <option value="volume">{T.t("PANEL_LABEL_VOLUME")}</option>
                        <option value="vcp">{T.t("SETTINGS_FEATURES_ADD_VCP")}</option>
                        <option value="sdr">{T.t("SETTINGS_FEATURES_SDR_BRIGHTNESS")}</option>
                    </select>
                </div>
            )

            const singleValue = () => (
                <div className="input-row hotkey-action-value">
                    <div className="hotkey-value field">
                        <label>{T.t("SETTINGS_HOTKEY_VALUE")}</label>
                        <input type="number" min="-65535" max="65535" value={action.value ?? 0} placeholder={T.t("SETTINGS_HOTKEY_VALUE_PLACEHOLDER")} onChange={e => {
                            const value = e.target.value
                            action.value = value ?? 0
                            props.onChange?.(action)
                        }} />
                    </div>
                </div>
            )

            const listOfValues = () => (
                <div className="input-row hotkey-action-values">
                    <div className="hotkey-values-list">
                        <label>{T.t("SETTINGS_HOTKEY_VALUES")}</label>
                        {action.values?.map((value, idx2) => {
                            return (
                                <div className="hotkey-value" key={idx2}>
                                    <input type="number" min="-65535" max="65535" value={value ?? 0} placeholder={T.t("SETTINGS_HOTKEY_VALUE_PLACEHOLDER")}
                                        onChange={e => {
                                            const value = e.target.value
                                            action.values[idx2] = value ?? 0
                                            props.onChange?.(action)
                                        }} />
                                    {idx2 ? (
                                        <input type="button" className="button" onClick={() => {
                                            action.values.splice(idx2, 1)
                                            props.onChange?.(action)
                                        }} value={T.t("GENERIC_DELETE")} />
                                    ) : null}
                                </div>
                            )
                        })}
                        <p><a className="button button-primary" onClick={() => {
                            action.values.push([0])
                            props.onChange?.(action)
                        }}>+ {T.t("SETTINGS_HOTKEY_ADD_VALUE")}</a></p>
                    </div>
                </div>
            )

            return (
                <>
                    <div className="input-row hotkey-action-type">
                        {selectBox}
                    </div>
                    <div className="input-row hotkey-action-code" style={{ display: (selectBoxValue === "vcp" ? "block" : "none") }}>
                        <div className="field">
                            <label>{T.t("SETTINGS_FEATURES_ADD_VCP")}</label>
                            <input value={action.target} type="text" placeholder={T.t("SETTINGS_FEATURES_ADD_PLACEHOLDER")} onChange={e => {
                                action.target = e.target.value
                                props.onChange?.(action)
                            }} />
                        </div>
                    </div>
                    {action.type === "cycle" ? listOfValues() : singleValue()}
                </>
            )
        }
    }

    return (
        <div className="action-item-base">
            { props.onDelete ?
                <div className=""><a className="button button-primary" onClick={() => props.onDelete?.(action)}>{deleteIcon} <span>{props.title ?? T.t("SETTINGS_HOTKEY_ACTION")}</span></a><br /><br /></div>
            : <div className="option-title">{props.title ?? T.t("SETTINGS_HOTKEY_ACTION")}</div> }

            <div className="input-row">
                <div className="hotkey-monitors-list" style={{ display: (showDisplaysList ? "block" : "none") }}>
                    <div className="input-row">
                        <div className="field">
                            <div className="feature-toggle-row">
                                <input onChange={e => {
                                    action.allMonitors = e.target.checked
                                    props.onChange?.(action)
                                }} checked={action.allMonitors} data-checked={action.allMonitors} type="checkbox" />
                                <div className="feature-toggle-label">{T.t("GENERIC_ALL_DISPLAYS")}</div>
                            </div>
                            {getHotkeyMonitors()}
                        </div>
                    </div>
                </div>
                <div className="hotkey-action-fields">
                    <div className="input-row">
                        <div className="field">
                            <label>{T.t("SETTINGS_HOTKEY_ACTION")}</label>
                            <select value={action.type} onChange={e => {
                                action.type = e.target.value
                                props.onChange?.(action)
                            }}>
                                <option value="set">{T.t("SETTINGS_HOTKEY_ACTION_SET")}</option>
                                <option value="offset">{T.t("SETTINGS_HOTKEY_ACTION_OFFSET")}</option>
                                <option value="cycle">{T.t("SETTINGS_HOTKEY_ACTION_CYCLE")}</option>
                                <option value="off">{T.t("PANEL_BUTTON_TURN_OFF_DISPLAYS")}</option>
                                <option value="refresh">{T.t("GENERIC_REFRESH_DISPLAYS")}</option>
                            </select>
                        </div>
                    </div>
                    {getHotkeyInput()}
                </div>
            </div>
        </div>
    )
}
