const path = require('path');
const fs = require('fs')

function udpSendCommand(type, data, port = 14715, key) {
    return new Promise((resolve, reject) => {
        const client = require('dgram').createSocket('udp4')
        const udpTimeout = setTimeout(() => {
            clearTimeout(udpTimeout)
            reject("No response")
        }, 1000)

        client.on('message', (message, connection) => {
            resolve(message?.toString())
        })

        client.send(JSON.stringify({ type, data, key }), port, "localhost", err => {
            if (err) {
                reject('Failed to send command')
            }
        })
    })
}

function pipeSendCommand(type, data, port = 14715, key) {
    return new Promise((resolve, reject) => {
        const cmdTimeout = setTimeout(() => {
            clearTimeout(cmdTimeout)
            reject("No response")
        }, 1000)

        const client = require('net').connect('\\\\.\\pipe\\twinkle-tray\\cmds')

        client.on('data', function(message) {
            resolve(message?.toString())
        })

        try {
            client.write(JSON.stringify({ type, data, key }))
        } catch(e) {
            reject('Failed to send command:', e)
        }
    })
}

module.exports = {
    unloadModule: (name) => {
        try {
            if (require.cache[require.resolve(name)]) {
                delete require.cache[require.resolve(name)]
                console.log(`Unloaded module: ${name}`)
            }
        } catch (e) {
            console.log(`Couldn't unload module: ${name}`)
        }
    },
    wait(ms = 2000) {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve(true);
            }, ms);
        });
    },
    processArgs: (commandLine) => {

        let validArgs = {}

        commandLine.forEach(argRaw => {

            const arg = argRaw.toLowerCase();

            // Use UDP
            if (arg.indexOf("--udp") === 0) {
                validArgs.UseUDP = true
            }

            // Get display by index
            if (arg.indexOf("--list") === 0) {
                validArgs.List = true
            }

            // Get display by index
            if (arg.indexOf("--monitornum=") === 0) {
                validArgs.MonitorNum = (arg.substring(13) * 1)
            }

            // Get display by ID (partial or whole)
            if (arg.indexOf("--monitorid=") === 0) {
                validArgs.MonitorID = arg.substring(12)
            }

            // Run on all displays
            if (arg.indexOf("--all") === 0 && arg.length === 5) {
                validArgs.All = true
            }

            // Use absolute brightness
            if (arg.indexOf("--set=") === 0) {
                validArgs.Brightness = (arg.substring(6) * 1)
                validArgs.BrightnessType = "set"
            }

            // Use relative brightness
            if (arg.indexOf("--offset=") === 0) {
                validArgs.Brightness = (arg.substring(9) * 1)
                validArgs.BrightnessType = "offset"
            }

            // Use time adjustments
            if (arg.indexOf("--usetime") === 0) {
                validArgs.UseTime = true
            }

            // DDC/CI command
            if (arg.indexOf("--vcp=") === 0 && arg.includes(":")) {
                validArgs.VCP = true
            }

            // Show overlay
            if (arg.indexOf("--overlay") === 0) {
                validArgs.ShowOverlay = true
            }

            // Show panel
            if (arg.indexOf("--panel") === 0) {
                validArgs.ShowPanel = true
            }

        })

        return validArgs
    },

    async handleProcessedArgs(args = {}, knownDisplaysPath, settingsPath) {

        let failed
        const settings = JSON.parse(fs.readFileSync(settingsPath))

        if (args.ShowPanel) {
            console.log(`Showing panel`)
        } else if (args.List) {
            const useUDP = (args.UseUDP ? true : false)
            const response = await (useUDP ? udpSendCommand : pipeSendCommand)("list", false, settings.udpPortActive, settings.udpKey)
            let displays = {}
            try {
                displays = JSON.parse(response || "")
            } catch(e) {
                console.log("Error parsing response")
            }

            Object.values(displays).forEach(display => {
                console.log(`
\x1b[36mMonitorNum:\x1b[0m ${display.num}
\x1b[36mMonitorID:\x1b[0m ${display.key}
\x1b[36mName:\x1b[0m ${display.name}
\x1b[36mBrightness:\x1b[0m ${display.brightness}
\x1b[36mType:\x1b[0m ${display.type}`)
            })

            failed = false;
            return true;
        } else {
            if (!(args.MonitorID !== undefined || args.MonitorNum !== undefined || args.All || args.UseTime)) {
                console.log("\x1b[41mMissing monitor argument.\x1b[0m")
                failed = true
            }
            if (args.Brightness === undefined && !args.VCP && !args.UseTime) {
                console.log("\x1b[41mMissing brightness argument.\x1b[0m")
                failed = true
            }
        }

        if (failed) {
            console.log(`
Supported args:

\x1b[36m--List\x1b[0m
List all displays.

\x1b[36m--MonitorNum\x1b[0m
Select monitor by number. Starts at 1.
\x1b[2mExample: --MonitorNum=2\x1b[0m

\x1b[36m--MonitorID\x1b[0m
Select monitor by internal ID. Partial or whole matches accepted.
\x1b[2mExample: --MonitorID="UID2353"\x1b[0m

\x1b[36m--All\x1b[0m
Flag to update all monitors.
\x1b[2mExample: --All\x1b[0m

\x1b[36m--Set\x1b[0m
Set brightness percentage.
\x1b[2mExample: --Set=95\x1b[0m

\x1b[36m--Offset\x1b[0m
Adjust brightness percentage.
\x1b[2mExample: --Offset=-20\x1b[0m

\x1b[36m--UseTime\x1b[0m
Adjust brightness using Time of Day Adjustments. 
\x1b[2mExample: --UseTime\x1b[0m

\x1b[36m--VCP\x1b[0m
Send a specific DDC/CI VCP code and value instead of brightness. The first part is the VCP code (decimal or hexadecimal), and the second is the value.
\x1b[2mExample: --VCP="0xD6:5"\x1b[0m

\x1b[36m--Overlay\x1b[0m
Flag to show brightness levels in the overlay
\x1b[2mExample: --Overlay\x1b[0m

\x1b[36m--Panel\x1b[0m
Flag to show brightness levels in the panel
\x1b[2mExample: --Panel\x1b[0m
`)
        } else {
            console.log("OK")
        }
    },
    vcpMap: {
        0x10: "luminance",
        0x13: "brightness",
        0x12: "contrast",
        0xD6: "powerState",
        0x62: "volume"
    },
    upgradeAdjustmentTimes,
    migrateSettings,
    getVersionValue,
    lerp,
    easeOutQuad,
    parseTime,
    getCalibratedValue,
    normalizeBrightness,
    minMax,
    vcpStr,
    determineTheme,
    readInstanceName,
    parseWMIString,
    isInternalURL
}


function upgradeAdjustmentTimes(times = []) {
    const newTimes = []

    times.forEach(time => {
        if (time.time) {
            newTimes.push(time)
            return
        }

        const newTime = {
            brightness: (time.brightness ? time.brightness : 50),
            monitors: (time.monitors ? time.monitors : {}),
            time: "00:00"
        }

        // Convert to 24H
        const hourInt = parseInt(time.hour)
        const fixedHour = hourInt + (hourInt == 12 ? (time.am.toLowerCase() == "pm" ? 0 : -12) : (time.am.toLowerCase() == "pm" ? 12 : 0))
        newTime.time = (fixedHour < 10 ? "0" + fixedHour : fixedHour) + ":" + (time.minute < 10 ? "0" + time.minute : time.minute)

        newTimes.push(newTime)
    })

    return newTimes
}

// Convert version to a numeric value (v1.2.3 = 10020003)
// Apply all version-guarded settings migrations in place, upgrading an
// on-disk settings object to the current schema. Extracted verbatim from
// electron.js readSettings() so the upgrade/downgrade paths can be unit tested.
//
// Mutates `settings` directly (preserving the original behaviour, including key
// deletions). Side effects on other state are returned as flags rather than
// performed here, keeping this a pure transform over `settings`:
//   - resetKnownDisplays: caller should clear the monitors "lastKnownDisplays".
//
// Migrations are idempotent: this stamps settings.settingsVer (when ctx.appVersion
// is given) so a re-run on already-migrated data is a no-op. The returned
// `changed` flag reports whether anything was actually modified, so the caller
// can persist immediately after a boot-time upgrade (and skip a needless rewrite
// otherwise).
//
// ctx:
//   appVersionValue : numeric value of the running app version (getVersionValue)
//   appVersion      : version string to stamp as settingsVer (e.g. "1.17.2")
//   appBuild        : build string to stamp as settingsBuild
//   makeUuid        : () => string, used to mint ids during upgrades
//   log             : (…args) => void, optional debug logger
function migrateSettings(settings, ctx = {}) {
    const { appVersionValue = 0, appVersion, appBuild, makeUuid = () => undefined, log = () => {} } = ctx
    const result = { resetKnownDisplays: false, changed: false }
    const before = JSON.stringify(settings)

    if (settings.updateInterval === 999) settings.updateInterval = 100;

    if (settings.monitorFocusTimeUnit === "seconds") {
        settings.monitorFocusSeconds = settings.monitorFocusMinutes || 0
        settings.monitorFocusMinutes = 0
        delete settings.monitorFocusTimeUnit
    } else if (settings.monitorFocusTimeUnit) {
        delete settings.monitorFocusTimeUnit
    }
    if (settings.monitorFocusSeconds === undefined) settings.monitorFocusSeconds = 0

    // Upgrade settings
    const settingsVersion = getVersionValue(settings.settingsVer)
    if (settingsVersion < getVersionValue("v1.15.0")) {
        // v1.15.0
        try {
            // Upgrade adjustment times
            const upgradedTimes = upgradeAdjustmentTimes(settings.adjustmentTimes)
            settings.adjustmentTimes = upgradedTimes
            log("Upgraded Adjustment Times to v1.15.0 format!")
        } catch (e) {
            log("Couldn't upgrade Adjustment Times", e)
        }
        try {
            // Upgrade idle settings
            if (settings.detectIdleTime) {
                if (settings.detectIdleTime * 1 > 0) {
                    settings.detectIdleTimeEnabled = true
                    settings.detectIdleTimeSeconds = (settings.detectIdleTime * 1) % 60
                    settings.detectIdleTimeMinutes = Math.floor((settings.detectIdleTime * 1) / 60)
                }
                delete settings.detectIdleTime
            }
            log("Upgraded Idle settings to v1.15.0 format!")
        } catch (e) {
            log("Couldn't upgrade Idle settings", e)
        }
    } else if (appVersionValue < getVersionValue("v1.16.0") && settingsVersion >= getVersionValue("v1.16.0")) {
        // Downgrade from v1.16.0+
        if (settings.hotkeysPre1160) {
            settings.hotkeys = settings.hotkeysPre1160
        } else {
            settings.hotkeys = {}
        }
        log("Downgraded settings from v1.16.0+ format!")
    }
    if (settingsVersion < getVersionValue("v1.16.0")) {
        // v1.16.0
        result.resetKnownDisplays = true // Reset lastKnownDisplays due to known bug in earlier versions
        try {
            // Upgrade hotkeys
            if (settings.hotkeys && Object.values(settings.hotkeys)?.length >= 0) {
                settings.hotkeysPre1160 = settings.hotkeys // Save old hotkeys in case of downgrade

                const newHotkeys = []
                for (const hotkey of Object.values(settings.hotkeys)) {
                    const newHotkey = {
                        accelerator: hotkey.accelerator,
                        id: makeUuid(),
                        actions: [
                            {
                                monitors: {},
                                target: "brightness",
                                values: [0],
                                value: 0,
                                allMonitors: false
                            }
                        ]
                    }
                    if (hotkey.monitor === "turn_off_displays") {
                        newHotkey.actions[0].type = "off"
                    } else {
                        newHotkey.monitors = {}
                        if (hotkey.monitor === "all") {
                            newHotkey.actions[0].allMonitors = true
                        } else {
                            newHotkey.actions[0].monitors[hotkey.monitor] = true
                        }
                        newHotkey.actions[0].type = "offset"
                        newHotkey.actions[0].value = settings.hotkeyPercent * hotkey.direction
                    }
                    newHotkeys.push(newHotkey)
                }
                settings.hotkeys = newHotkeys
            }
            log(`Upgraded ${settings.hotkeys.length} hotkeys to v1.16.0 format!`)
        } catch (e) {
            log("Couldn't upgrade hotkeys", e)
        }
        try {
            // Upgrade Adjustment Times for SunCalc
            for (const time of settings.adjustmentTimes) {
                time.useSunCalc = false
                time.sunCalc = "sunrise"
            }
            log("Upgraded Adjustment Times to v1.16.0 format!")
        } catch (e) {
            log("Couldn't upgrade Adjustment Times", e)
        }
        try {
            // Upgrade Monitor Features for v1.16.0
            const newMonitorFeatures = {}
            for (const monitorID in settings.monitorFeatures) {
                newMonitorFeatures[monitorID] = {}
                for (const featureName in settings.monitorFeatures[monitorID]) {
                    if (featureName === "contrast") {
                        newMonitorFeatures[monitorID]["0x12"] = settings.monitorFeatures[monitorID][featureName]
                    } else if (featureName === "volume") {
                        newMonitorFeatures[monitorID]["0x62"] = settings.monitorFeatures[monitorID][featureName]
                    } else if (featureName === "powerState") {
                        newMonitorFeatures[monitorID]["0xD6"] = settings.monitorFeatures[monitorID][featureName]
                    }
                }
            }
            settings.monitorFeatures = newMonitorFeatures
            log("Upgraded Monitor Features to v1.16.0 format!")
        } catch (e) {
            log("Couldn't upgrade Monitor Features", e)
        }
        try {
            // Remove disableOverlay
            if (settings.disableOverlay === true) {
                settings.defaultOverlayType = "disabled"
            }
            if (settings.disableOverlay !== undefined) {
                delete settings.disableOverlay
            }
        } catch (e) {
            log("Couldn't remove disableOverlay")
        }
    }

    if (settingsVersion < getVersionValue("v1.16.1")) {
        // Disable win32display-config events by default as of v1.16.1
        // settings.useWin32Event = false
    }

    // Fix missing UUIDs for app profiles
    if (settings.profiles?.length) {
        for (const profile of settings.profiles) {
            if (!profile.uuid) {
                profile.uuid = makeUuid()
            }
        }
    }

    // Fix rawSettings bug
    if (settings.rawSettings) delete settings.rawSettings;

    // Remove hdrDisplays from v1.17.0-beta1
    if (settings.settingsVer == "v1.17.0-beta1" || settingsVersion < getVersionValue("v1.16.8")) {
        if (settings.hdrDisplays) delete settings.hdrDisplays;
    }

    // Stamp the current version so a future run is a no-op (idempotent).
    if (appVersion !== undefined) settings.settingsVer = "v" + appVersion
    if (appBuild !== undefined) settings.settingsBuild = appBuild

    result.changed = JSON.stringify(settings) !== before
    return result
}

function getVersionValue(version = 'v1.0.0') {
    let out = version.split('-')[0].replace("v", "").split(".")
    out = (out[0] * 10000 * 10000) + (out[1] * 10000) + (out[2] * 1)
    return parseInt(out)
}

function lerp(start, finish, perc) {
    return start * (1 - perc) + finish * perc
}

// Quintic ease-out: maps progress t (0..1) to an eased 0..1 value.
function easeOutQuad(t) {
    return 1 + (--t) * t * t * t * t
}

function parseTime(time) {
    return parseInt((time.split(":")[0] * 60) + (time.split(":")[1] * 1))
}

// Get known displays from file, along with current displays
function getKnownDisplays(knownDisplaysPath) {
    let known
    try {
        // Load known displays DB
        known = fs.readFileSync(knownDisplaysPath)
        known = JSON.parse(known)
    } catch (e) {
        known = {}
    }

    return known
}

/**
 * Maps a value (0–100) using calibration points.
 * By default, maps input to output. Can also reverse map output back to input.
 *
 * @param {number} value - The value to map (expected range: 0–100).
 * @param {Array<{input: number, output: number}>} calibrationPoints - 
 *        An array of calibration points.
 *        Example: [{input: 15, output: 30}, {input: 50, output: 60}]
 * @param {boolean} reverse - If true, maps output to input. Default is false (input to output).
 * @returns {number} - The mapped value.
 */
function getCalibratedValue(value, calibrationPoints = [], reverse = false) {
    // Ensure value is within 0–100
    value = Math.max(0, Math.min(100, value));

    // Add default start and end points if not provided
    const points = calibrationPoints.slice();

    // Handle min/max values if those points haven't been provided
    let hasMin = false;
    let hasMax = false;
    for (const point of points) {
        point.input = Math.max(0, Math.min(100, point.input));
        if (point.input === 0) hasMin = true;
        if (point.input === 100) hasMax = true;
    }

    if (!hasMin) {
        points.unshift({ input: 0, output: 0 });
    }
    if (!hasMax) {
        points.push({ input: 100, output: 100 });
    }

    // Sort points by input value
    points.sort((a, b) => a.input - b.input);

    if (reverse) {
        // Reverse mapping: output -> input
        // Find the two points between which the output falls
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];

            // Check if output falls between these two points
            const minOutput = Math.min(p1.output, p2.output);
            const maxOutput = Math.max(p1.output, p2.output);

            if (value >= minOutput && value <= maxOutput) {
                // Flat segment (equal outputs) can't invert to one input; return the
                // midpoint rather than dividing by zero (NaN). Reachable when the caller
                // supplies explicit endpoints at input 0 and 100 with equal outputs.
                if (p2.output === p1.output) {
                    return (p1.input + p2.input) / 2;
                }
                const ratio = (value - p1.output) / (p2.output - p1.output);
                return p1.input + ratio * (p2.input - p1.input);
            }
        }
        // Fallback
        return value;
    } else {
        // Forward mapping: input -> output
        if (value === 0 && points.length > 0 && points[0].input === 0) {
            return points[0].output;
        }

        // Find the two points between which the input falls
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];

            if (value >= p1.input && value <= p2.input) {
                // Linear interpolation
                const ratio = (value - p1.input) / (p2.input - p1.input);
                return p1.output + ratio * (p2.output - p1.output);
            }
        }
        // Fallback
        return value;
    }
}

// Clamp a value into the [min, max] range (defaults 0–100).
function minMax(value, min = 0, max = 100) {
    let out = value
    if (value < min) out = min;
    if (value > max) out = max;
    return out;
}

// Format a VCP code as an uppercase "0x.." string (e.g. 18 -> "0x12").
function vcpStr(code) {
    return `0x${parseInt(code).toString(16).toUpperCase()}`
}

// True for URLs the app renders itself (local dev server or bundled file://).
// Anything else is treated as external and opened in the user's browser.
function isInternalURL(url) {
    return typeof url === "string" && (url.startsWith("http://localhost:3000") || url.startsWith("file://"))
}

// Split a Windows monitor InstanceName into its backslash-separated hwid parts,
// un-escaping the "&amp;" entities WMI returns. Returns undefined for no input.
function readInstanceName(insName) {
    return (insName ? insName.replace(/&amp;/g, '&').split("\\") : undefined)
}

// Decode the semicolon-separated decimal char codes WMI uses for strings
// (e.g. UserFriendlyName, SerialNumberID) into a plain string. Zero entries are
// remapped to 32 (space) to match the original behaviour. null passes through.
function parseWMIString(str) {
    if (str === null) return str;
    let hexed = str.replace('{', '').replace('}', '').replace(/;0/g, ';32')
    let decoded = '';
    const split = hexed.split(';')
    for (let i = 0; (i < split.length); i++)
        decoded += String.fromCharCode(parseInt(split[i], 10));
    decoded = decoded.trim()
    return decoded;
}

// Resolve a theme setting ("dark"/"light"/anything else) to "dark" or "light".
// An explicit dark/light wins; otherwise fall back to the last known system
// theme (lastTheme.SystemUsesLightTheme), defaulting to dark.
function determineTheme(themeName, lastTheme) {
    const theme = themeName.toLowerCase()
    if (theme === "dark" || theme === "light") return theme;
    if (lastTheme && lastTheme.SystemUsesLightTheme) {
        return "light"
    } else {
        return "dark"
    }
}

// Map a brightness value through min/max caps and any calibration points.
// normalize = true when receiving from Monitors.js, false when sending to it.
function normalizeBrightness(brightness, normalize = false, min = 0, max = 100, calibrationPoints = []) {
    const points = calibrationPoints.slice()
    if (min > 0) points.push({ input: 0, output: min })
    if (max < 100) points.push({ input: 100, output: max })

    return getCalibratedValue(brightness, points, normalize)
}