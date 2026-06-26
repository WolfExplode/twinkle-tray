const { app } = require('electron')
const fs = require('fs')

const path = require('path');

let isDev = app.commandLine.hasSwitch("dev")

let package = fs.readFileSync(isDev ? "package.json" : __dirname + '/../package.json')
if(package) package = JSON.parse(package)

const appVersionFull = (package?.versionBuild ?? app.getVersion())
const appVersion = appVersionFull.split('+')[0]
const appVersionTag = appVersion?.split('-')[1]
const appBuild = (isDev ? "dev" : appVersionFull.split('+')[1])
const appBuildShort = (appBuild && appBuild.length > 7 ? appBuild.slice(0, 7) : appBuild)

const isAppX = (app.name == "twinkle-tray-appx" ? true : false)
const isPortable = (app.name == "twinkle-tray-portable" ? true : false)

const Utils = require("./Utils")
const AdjustmentTimes = require("./adjustmentTimes")
const MonitorFocus = require("./monitorFocus")
const MonitorTransforms = require("./monitorTransforms")
const Profiles = require("./profiles")
const UpdateCheck = require("./updateCheck")
const { createHotkeyController } = require("./hotkeys")
const { store } = require("./state/store") // single owner of application state; slices migrate here one at a time
const logger = require('./logger') // init()'d in the Logging block below once logPath is known

const configFilesDir = (isPortable ? path.join(__dirname, "../../config/") : app.getPath("userData"))
const settingsPath = path.join(configFilesDir, `\\settings${(isDev ? "-dev" : "")}.json`)
const knownDisplaysPath = path.join(configFilesDir, `\\known-displays${(isDev ? "-dev" : "")}.json`)

// Handle multiple instances before continuing
const singleInstanceLock = app.requestSingleInstanceLock(process.argv)
if (!singleInstanceLock) {
  try { Utils.handleProcessedArgs(Utils.processArgs(process.argv, app), knownDisplaysPath, settingsPath).then(() => app.exit()) } catch (e) { app.exit() }
  return false
} else {
  logger.debug("Starting Twinkle Tray...")
  app.on('second-instance', handleCommandLine)
}

function reopenAppWithConsole() {
  const args = [__filename, "--console"]
  require('child_process').spawn('conhost.exe', ['cmd.exe', '/c', app.getPath("exe"), ...args], { detached: true, stdio: 'ignore' }).unref()
  app.exit()
  return false
}

// Handle --show-console switch
if(app.commandLine.hasSwitch("show-console")) {
  reopenAppWithConsole()
}

const { Readable } = require("node:stream")
const { BrowserWindow, nativeTheme, systemPreferences, Menu, ipcMain, screen, globalShortcut, powerMonitor } = require('electron')
const uuid = require('crypto').randomUUID

// Expose GC
app.commandLine.appendSwitch('js-flags', '--expose_gc --max-old-space-size=128')
app.commandLine.appendSwitch('disable-http-cache')
require("v8").setFlagsFromString('--expose_gc'); global.gc = require("vm").runInNewContext('gc');

// Remove window animations
app.commandLine.appendSwitch('wm-window-animations-disabled');

let updateKnownDisplaysTimeout

const monitorRules = require('./monitor-rules.json')
const knownDDCBrightnessVCPs = monitorRules?.ddcBrightnessCodes

const { fork, exec } = require('child_process');
const { VerticalRefreshRateContext, addDisplayChangeListener } = require("win32-displayconfig");
const refreshCtx = new VerticalRefreshRateContext();

const {WindowUtils, MediaStatus, PowerEvents, AppStartup, ColorGamma} = require("tt-windows-utils")
const setWindowPos = () => { }
const AccentColors = require("windows-accent-colors")
const Acrylic = require("acrylic")

const ActiveWindow = require('@paymoapp/active-window').default;
ActiveWindow.initialize()

const reg = require('native-reg');
const Color = require('color')
const Translate = require('./Translate');
const { EventEmitter } = require("events");

const isReallyWin11 = (require("os").release()?.split(".")[2] * 1) >= 22000

// lastKnownDisplays lives in the "monitors" store slice (seeded at the monitors decl)

const SunCalc = require('suncalc')

app.allowRendererProcessReuse = true

// Logging
const logPath = path.join(configFilesDir, `\\debug${(isDev ? "-dev" : "")}.log`)
const updatePath = path.join(configFilesDir, `\\update.exe`)

const consoleEnabled = isDev || app.commandLine.hasSwitch("console")
logger.init({
  logPath,
  consoleEnabled,
  // In dev or with --console, capture everything; otherwise persist info and up.
  threshold: consoleEnabled ? 0 : 1
})

// Back-compat alias: existing `debug.log`/`debug.error` calls are the ones meant
// to persist in production, so they map to info/error.
const debug = {
  log: (...args) => logger.info(...args),
  error: (...args) => logger.error(...args)
}


const windowMenu = Menu.buildFromTemplate([{
  label: "Dev Tools",
  role: "toggleDevTools",
  accelerator: "Ctrl+I"
}, {
  label: "Dev Tools 2",
  role: "toggleDevTools",
  accelerator: "Ctrl+Shift+I"
}])

// Monitors thread
// Handles WMI + DDC/CI activity

let monitorsThread = {
  send: async function (data) {
    try {
      if (!(monitorsThreadReal?.connected && monitorsThreadReal?.exitCode === null)) {
        startMonitorThread()
        // Wait for "ready", but bail if the start aborted (idle/early-return left
        // us "idle") or the thread "failed" — otherwise this loops forever.
        const waitStart = Date.now()
        while(monitorsThreadStatus !== "ready") {
          if(monitorsThreadStatus === "idle" || monitorsThreadStatus === "failed") throw("Monitor thread didn't start.");
          if(Date.now() - waitStart > MONITORS_THREAD_READY_TIMEOUT) throw("Timed out waiting for monitor thread.");
          await Utils.wait(50)
        }
      }
      if(monitorsThreadStatus !== "ready") throw("Thread not ready!");
      if(!(monitorsThreadReal?.connected && monitorsThreadReal?.exitCode === null)) throw("Thread not available!");
      if((data.type == "vcp" || data.type == "brightness" || data.type == "getVCP") && store.get("monitors").isRefreshing) while(store.get("monitors").isRefreshing) {
        await Utils.wait(50)
      }
      monitorsThreadReal.send(data)
    } catch (e) {
      logger.debug("Couldn't communicate with Monitor thread.", e)
    }
  },
  once: function (message, callback) {
    try {
      if (monitorsThreadReal && !monitorsThreadReal.connected) {
        startMonitorThread()
      }
      monitorsEventEmitter.once(message, callback)
    } catch (e) {
      logger.debug("Couldn't listen to Monitor thread.", e)
    }
  }
}
let monitorsThreadReal
let monitorsEventEmitter = new EventEmitter()
// Monitor worker lifecycle as one state, not four booleans. Legal states:
// "idle" (no thread) | "starting" (forked, awaiting ready) | "ready" | "failed".
// `monitorsThreadReal` is the fork handle, orthogonal to this.
let monitorsThreadStatus = "idle"
const MONITORS_THREAD_READY_TIMEOUT = 10000
function startMonitorThread() {
  if((monitorsThreadReal?.connected && monitorsThreadReal?.exitCode === null) || monitorsThreadStatus === "starting" || store.get("idle").isWindowsUserIdle) return false;
  monitorsThreadStatus = "starting"
  logger.debug("Starting monitor thread")
  const skipTest = (settings.preferredDDCCIMethod == "auto" ? false : true)
  monitorsThreadReal = fork(path.join(__dirname, 'Monitors.js'), ["--isdev=" + isDev, "--apppath=" + app.getAppPath(), "--skiptest=" + skipTest], { silent: false })
  monitorsThreadReal.on("message", (data) => {
    if (data?.type) {
      if (data.type === "log") {
        const lvl = (data.level && logger[data.level]) ? data.level : "debug"
        logger[lvl]("[MON]", data.message)
        return
      }
      if (data.type === "ready") {
        monitorsThreadStatus = "ready"
        store.update("monitors", { isRefreshing: false })
        monitorsThreadReal.send({
          type: "settings",
          settings
        })
        monitorsThreadReal.send({
          type: "ddcBrightnessVCPs",
          ddcBrightnessVCPs: getDDCBrightnessVCPs()
        })
        monitorsThread.send({
          type: "wmi-bridge-ok",
          value: wmiBridgeOK
        })
        getLocalization()
      }
      if (data.type === "ddcciModeTestResult") {
        store.update("settings", { lastDetectedDDCCIMethod: (data.value ? "fast" : "accurate") })
      }
      monitorsEventEmitter.emit(data.type, data)
    }
  })
  monitorsThreadReal.on("error", err => {
    logger.error(err)

    if(monitorsThreadStatus === "failed") return false;
    if(err.code === 'EPIPE') return false;
    monitorsThreadStatus = "failed"

    const options = {
    title: 'Monitors thread failed',
    message: 'The monitors thread failed with the following message:',
    detail: err.message || err.toString(),
  };

  require('electron').dialog.showMessageBox(null, options, (response, checkboxChecked) => { });

    stopMonitorThread()
    setTimeout(() => {
      if(!monitorsThreadReal?.connected && monitorsThreadStatus !== "starting") {
        startMonitorThread()
      }
    }, 1000)
  })
}

function stopMonitorThread() {
  logger.debug("Killing monitor thread")
  // Don't clobber "failed" — the error handler relies on it persisting to
  // dedupe repeated error events until startMonitorThread() resets to "starting".
  if(monitorsThreadStatus !== "failed") monitorsThreadStatus = "idle"
  setIsRefreshing(false)
  if(monitorsThreadReal?.connected) {
    monitorsThreadReal.kill()
  }
}

function getVCP(monitor, code) {
  return new Promise((resolve, reject) => {
    if (!monitor || !code) resolve(-1);
    const vcpParsed = parseInt(`0x${parseInt(code).toString(16).toUpperCase()}`)
    const hwid = (typeof monitor === "object" ? monitor.hwid.join("#") : monitor)
    const timeout = setTimeout(() => {
      resolve(-1) // Timed out
    }, 3000)
    monitorsThread.once(`getVCP::${hwid}::${vcpParsed}`, data => {
      clearTimeout(timeout)
      // Write VCP values to monitor object
      if(data?.value?.[0] != undefined) {
        try {
          monitors[hwid?.split("#")[2]].features[Utils.vcpStr(vcpParsed)] = data.value?.[0]
        } catch(e) {
          logger.debug(e)
        }
      }
      resolve(data?.value?.[0])
    })
    monitorsThread.send({
      type: "getVCP",
      code: vcpParsed,
      monitor: hwid
    })
  })
}



// Test if wmi-bridge works properly on user's system
let monitorsThreadTest
let wmiBridgeOK = false
async function doWMIBridgeTest() {
  return new Promise((resolve, reject) => {
    monitorsThreadTest = fork(path.join(__dirname, 'wmi-bridge-test.js'), ["--isdev=" + isDev, "--apppath=" + app.getAppPath()], { silent: false })
    monitorsThreadTest.on("message", (data) => {
      if (data?.type === "ready") {
        logger.debug("WMI-BRIDGE TEST: READY")
      }
      if (data?.type === "ok") {
        logger.debug("WMI-BRIDGE TEST: OK")
        wmiBridgeOK = true
        monitorsThreadTest.kill()
        resolve(true)
      }
      if(data?.type === "failed") {
        logger.debug("WMI-BRIDGE TEST: FAILED")
        monitorsThreadTest.kill()
        resolve(false)
      }
    })
    // Close after timeout
    setTimeout(() => {
      try {
        if (monitorsThreadTest.connected) {
          logger.debug("WMI-BRIDGE TEST: Killing thread")
          monitorsThreadTest.kill()
        }
        resolve(false)
      } catch (e) { logger.debug(e) }
    }, 2000)
  })
}


// Mouse wheel scrolling
let mouseEventsActive = false
let mouseEvents
let bounds

function enableMouseEvents() {
  if (mouseEventsActive || settings.disableMouseEvents) return false;
  mouseEventsActive = true;

  try {
    mouseEvents = require("global-mouse-events");
    mouseEvents.on('mousewheel', event => {
      if (!settings.scrollShortcut) return false;
      try {
        if (!bounds) return false;
        if (event.x >= bounds.x && event.x <= bounds.x + bounds.width && event.y >= bounds.y && event.y <= bounds.y + bounds.height) {
          const delta = settings.invertScroll ? -Math.round(event.delta) : Math.round(event.delta);
          const amount = delta * settings.scrollShortcutAmount;

          setRecentlyInteracted(true)
          updateAllBrightness(amount)

          // If panel isn't open, use the overlay
          if (store.get("panel").panelState !== "visible") {
            hotkeyOverlayStart(undefined, true)
          }

          pauseMonitorUpdates() // Pause monitor updates to prevent judder
          willPauseMouseEvents() // Delay pausing mouse events

        }
      } catch (e) {
        logger.error(e)
      }
    });


    mouseEvents.on("mousemove", (e) => {
      handleMonitorFocusMouseMove(e.x, e.y)
    })

    // Handle edge cases where "blur" event doesn't properly fire
    mouseEvents.on("mousedown", (e) => {
      if (panelSize.visible || !canReposition) {

        // Check if clicking outside of panel/overlay
        const pBounds = screen.dipToScreenRect(mainWindow, mainWindow.getBounds())
        if (e.x < pBounds.x || e.x > pBounds.x + pBounds.width || e.y < pBounds.y || e.y > pBounds.y + pBounds.height) {
          if (!canReposition) {
            // Overlay is displayed
            hotkeyOverlayHide(true)
          } else {
            // Panel is displayed
            if (!mainWindow.webContents.isDevToolsOpened()) {
              sendToAllWindows("panelBlur")
              showPanel(false)
            }
          }
        }

      }
    })

  } catch (e) {
    logger.error(e)
  }

}

function pauseMouseEvents(paused) {

  // Clear timeout if set
  if (willPauseMouseEventsTimeout) clearTimeout(willPauseMouseEventsTimeout);

  if (paused && settings.monitorFocusEnabled) return false;

  if (paused) {
    if (mouseEvents && !mouseEvents.getPaused()) {
      logger.debug("Pausing mouse events...")
      mouseEvents.pauseMouseEvents()
    }
  } else {
    if (mouseEvents && mouseEvents.getPaused()) {
      logger.debug("Resuming mouse events...")
      mouseEvents.resumeMouseEvents()
    }
  }
}

let willPauseMouseEventsTimeout
function willPauseMouseEvents(time = 10000) {
  if (willPauseMouseEventsTimeout) clearTimeout(willPauseMouseEventsTimeout);
  willPauseMouseEventsTimeout = setTimeout(() => {
    pauseMouseEvents(true)
    willPauseMouseEventsTimeout = null
  }, time)
}




// Analytics
let analyticsInterval = false
let analyticsFrequency = 1000 * 60 * 29 // 29 minutes
let lastAnalyticsPing = 0

function pingAnalytics() {
  // Skip if too recent
  if (Date.now() < lastAnalyticsPing + (1000 * 60 * 28)) return false;

  const analytics = require('ga4-mp').createClient("Y1YTliQdTL-moveI0z1TLA", "G-BQ22ZK4BPY", settings.uuid)
  logger.debug("\x1b[34mAnalytics:\x1b[0m sending with UUID " + settings.uuid)

  let events = []
  events.push({
    name: "page_view",
    params: {
      page_location: app.name + "/" + "v" + appVersion + "/" + (appBuild ? appBuild : ""),
      page_title: app.name + "/" + "v" + appVersion,
      page_referrer: app.name,
      os_version: require("os").release(),
      app_type: app.name,
      app_version: appVersion,
      engagement_time_msec: 1
    }
  })
  analytics.send(events)
  lastAnalyticsPing = Date.now()
}

// monitors slice (store-owned). `monitors` aliases the slice's stable map of
// monitor objects (mutated in place; the one wholesale refresh replaces its
// contents in place). lastKnownDisplays is a reassigned value read/written
// through the store.
store.update("monitors", { all: {}, lastKnownDisplays: undefined })
const monitors = store.get("monitors").all
let mainWindow;
let tray = null
// theme slice (store-owned): lastTheme holds the Windows theme registry values
// (light/dark, transparency, accent) broadcast to renderers as 'theme-settings'.
// Reassigned via the store; readers take a local snapshot at the top of their
// function. Starts false until the first registry read.
store.update("theme", { lastTheme: false })

const panelSize = {
  width: 356,
  height: 500,
  base: 0,
  visible: false,
  taskbar: {}
}

//
//
//    Settings init
//
//

if (!fs.existsSync(configFilesDir)) {
  try {
    fs.mkdirSync(configFilesDir, { recursive: true })
  } catch (e) {
    debug.error(e)
  }
}

const defaultSettings = {
  isDev,
  settingsVer: "v" + appVersion,
  settingsBuild: appBuild,
  userClosedIntro: false,
  theme: "default",
  icon: "icon",
  updateInterval: 500,
  openAtLogin: true,
  brightnessAtStartup: true,
  killWhenIdle: false,
  remaps: {},
  hotkeys: [],
  hotkeyPercent: 10,
  adjustmentTimes: [],
  adjustmentTimesActive: true,
  adjustmentTimeIndividualDisplays: false,
  adjustmentTimeSpeed: "normal",
  adjustmentTimeAnimate: false,
  adjustmentTimeTemperatureEnabled: false,
  adjustmentTimeHighlightCompressionEnabled: false,
  adjustmentTimeLongitude: 0,
  adjustmentTimeLatitude: 0,
  checkTimeAtStartup: true,
  backgroundUpdateInterval: 60,
  order: [],
  monitorFeatures: {},
  monitorFeaturesSettings: {},
  hideDisplays: {},
  hdrDisplays: {},
  sdrAsMainSliderDisplays: {},
  sdrAsMainSlider: false,
  checkForUpdates: !isDev,
  dismissedUpdate: '',
  language: "system",
  names: {},
  analytics: !isDev,
  scrollShortcut: true,
  scrollShortcutAmount: 2,
  scrollFlyoutAmount: 2,
  invertScroll: false,
  useAcrylic: false,
  useNativeAnimation: false,
  sleepAction: "ps",
  hotkeysBreakLinkedLevels: true,
  enableSunValley: true,
  isWin11: isReallyWin11,
  windowsStyle: "system",
  hideClosedLid: false,
  getDDCBrightnessUpdates: false,
  detectIdleTimeEnabled: false,
  detectIdleTimeSeconds: 0,
  detectIdleTimeMinutes: 5,
  detectIdleCheckFullscreen: false,
  detectIdleMedia: false,
  detectIdleBrightness: 0,
  detectIdleSoftwareDim: 0,
  monitorFocusEnabled: false,
  monitorFocusMinutes: 10,
  monitorFocusSeconds: 0,
  monitorFocusDimLevel: 0,
  monitorFocusSoftwareDim: 0,
  monitorFocusTransitionDuration: 1000,
  softwareDimMax: 100,
  idleRestoreSeconds: 0,
  wakeRestoreSeconds: 0,
  hardwareRestoreSeconds: 0,
  restartOnWake: false,
  checkVCPWaitMS: 20,
  overrideTaskbarPosition: false,
  overrideTaskbarGap: false,
  disableAppleStudio: false,
  disableHighLevel: false,
  disableWMIC: false,
  disableWMI: false,
  disableWin32: false,
  disableHDR: false,
  autoDisabledWMI: false,
  useWin32Event: true,
  useElectronEvents: true,
  useWmDisplayChangeEvent: true,
  useScMonitorPowerEvent: true,
  useGuidPresenceEvent: true,
  useGuidBrightnessEvent: true,
  recreateTray: false,
  recreateFlyout: false,
  defaultOverlayType: "safe",
  disableMouseEvents: false,
  disableThrottling: false,
  userDDCBrightnessVCPs: {},
  userSkipReapply: [],
  preferredDDCCIMethod: "accurate",
  lastDetectedDDCCIMethod: "none",
  forceLowPowerGPU: false,
  ddcPowerOffValue: 5,
  disableAutoRefresh: false,
  disableAutoApply: false,
  disableOnLockScreen: false,
  udpEnabled: false,
  udpRemote: false,
  udpPortStart: 14715,
  udpPortActive: 14715,
  udpKey: uuid(),
  showConsole: false,
  profiles: [],
  uuid: uuid(),
  branch: (appVersionTag?.indexOf?.("beta") === 0 ? "beta" : "master")
}

const tempSettings = {
  pauseTimeAdjustments: false,
  pauseIdleDetection: false
}

// The store owns the settings value. `settings` is a stable alias to the slice
// object (the store never replaces the reference — update() merges in place), so
// the ~150 existing `settings.foo` reads keep working unchanged. The whole-object
// mutation paths (readSettings load, writeSettings, reset) route through
// store.update so the store stays the single source of truth.
store.update("settings", Object.assign({}, defaultSettings))
const settings = store.get("settings")

function readSettings(doProcessSettings = true) {
  try {
    if (fs.existsSync(settingsPath)) {
      store.update("settings", JSON.parse(fs.readFileSync(settingsPath)))
    } else {
      fs.writeFileSync(settingsPath, JSON.stringify({}))
    }
    //debug.log('Settings loaded:', settings)
  } catch (e) {
    debug.error("Couldn't load settings", e)
  }

  // Overrides
  updateSettings({ isDev, killWhenIdle: false })
  if (settings.adjustmentTimesActive === undefined) updateSettings({ adjustmentTimesActive: true })
  tempSettings.pauseTimeAdjustments = !settings.adjustmentTimesActive

  if(!isDev && settings.showConsole && !app.commandLine.hasSwitch("console")) {
    reopenAppWithConsole()
  }

  // Apply all version-guarded schema migrations (see Utils.migrateSettings).
  const { resetKnownDisplays, changed } = Utils.migrateSettings(settings, {
    appVersionValue: Utils.getVersionValue(`v${app.getVersion()}`),
    appVersion,
    appBuild,
    makeUuid: uuid,
    log: logger.debug
  })
  if (resetKnownDisplays) store.update("monitors", { lastKnownDisplays: {} })

  // The persist subscription isn't registered until just after boot-load, so an
  // upgrade applied here would otherwise only reach disk on the next settings
  // write (lost if the app exits first). Flush it now when something changed.
  if (changed) persistSettings()

  if (doProcessSettings) processSettings({ isReadSettings: true });
}

readSettings(false)
// Persist on every settings change from here on. Registered after the boot-load
// above so startup doesn't needlessly rewrite settings.json.
store.subscribe("settings", persistSettings)
if (settings.disableThrottling) {
  // Prevent background throttling
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

if (settings.forceLowPowerGPU) {
  app.commandLine.appendSwitch('force_low_power_gpu')
}

function writeSettings(newSettings = {}, processAfter = true, sendUpdate = true) {
  store.update("settings", newSettings)
  if (processAfter) processSettings(newSettings, sendUpdate);
}

// Debounced disk persistence, subscribed to the settings slice (see init below).
// Any store.update("settings", ...) — from writeSettings, reset, anywhere —
// schedules a save; this is the only place that writes settings to disk.
let writeSettingsTimeout = false
function persistSettings() {
  if (writeSettingsTimeout) return
  writeSettingsTimeout = setTimeout(() => {
    try {
      fs.writeFile(settingsPath, JSON.stringify(settings, null, '\t'), (e) => { if (e) debug.error(e) })
    } catch (e) {
      debug.error("Couldn't save settings.", settingsPath, e)
    }
    writeSettingsTimeout = false
  }, 333)
}

// Mutate the settings slice through the store. Prefer this over assigning to
// `settings.x` directly: an in-place assignment bypasses the store's change
// event, so it is neither broadcast nor persisted (it would only reach disk on
// the next unrelated settings write). Unlike writeSettings, this does not
// re-run processSettings, so it is safe to call from within it.
function updateSettings(patch) {
  return store.update("settings", patch)
}


function processSettings(newSettings = {}, sendUpdate = true) {

  let doRestartPanel = false
  let rebuildTray = false
  let shouldRefreshMonitors = false

  try {

    // settingsVer/settingsBuild are stamped at boot by Utils.migrateSettings.

    if (settings.theme) {
      nativeTheme.themeSource = Utils.determineTheme(settings.theme, store.get("theme").lastTheme)
      broadcastThemeSettings()
    }

    handleAccentChange()

    updateStartupOption((settings.openAtLogin || false))
    applyOrder()
    applyRemaps()

    if (settings.killWhenIdle && mainWindow && mainWindow.isAlwaysOnTop() === false) {
      mainWindow.close()
    }

    if (newSettings.adjustmentTimes !== undefined) {
      store.update("schedule", { lastTimeEvent: false })
      restartBackgroundUpdate()
      rebuildTray = true
      sendScheduleLockState()
      if (settings.adjustmentTimesActive) {
        applyCurrentAdjustmentEvent(true, true)
        applyCurrentDisplayColorEffects(false)
      }
    }

    if (newSettings.adjustmentTimesActive !== undefined) {
      tempSettings.pauseTimeAdjustments = !settings.adjustmentTimesActive
      if (settings.adjustmentTimesActive) {
        store.update("schedule", { lastTimeEvent: false })
        applyCurrentAdjustmentEvent(true, true)
        // Overwrite saved manual brightness with the schedule values so toggling
        // the schedule back off leaves brightness unchanged.
        updateKnownDisplays(true, true)
        applyCurrentDisplayColorEffects(false)
      } else {
        // Schedule turned off: brightness stays at schedule values (already saved above)
        for (const key in monitors) {
          const id = monitors[key].id
          const kelvin = store.get("color").manualTemperatureActive ? (manualWarmthLevels[id] ?? 6500) : 6500
          const highlightWeight = store.get("color").manualHighlightActive ? (manualHighlightLevels[id] ?? 0) : 0
          updateDisplayColor(id, { kelvin, highlightWeight })
        }
      }
      setTrayMenu()
      sendScheduleLockState()
    }

    if (newSettings.adjustmentTimeTemperatureEnabled !== undefined) {
      if (settings.adjustmentTimeTemperatureEnabled && settings.adjustmentTimesActive) {
        applyCurrentDisplayColorEffects(false)
      } else {
        // Scheduling disabled: restore manual values or reset to neutral
        for (const key in monitors) {
          const id = monitors[key].id
          const kelvin = store.get("color").manualTemperatureActive ? (manualWarmthLevels[id] ?? 6500) : 6500
          updateDisplayColor(id, { kelvin })
        }
      }
      setTrayStatus()
      setTrayMenu()
      sendScheduleLockState()
    }

    if (newSettings.adjustmentTimeHighlightCompressionEnabled !== undefined) {
      if (settings.adjustmentTimeHighlightCompressionEnabled && settings.adjustmentTimesActive) {
        applyCurrentDisplayColorEffects(false)
      } else {
        // Scheduling disabled: restore manual values or reset to neutral
        for (const key in monitors) {
          const id = monitors[key].id
          const weight = store.get("color").manualHighlightActive ? (manualHighlightLevels[id] ?? 0) : 0
          updateDisplayColor(id, { highlightWeight: weight })
        }
      }
      setTrayStatus()
      setTrayMenu()
      sendScheduleLockState()
    }

    if (newSettings.backgroundUpdateInterval !== undefined) {
      restartBackgroundUpdate()
    }

    if (newSettings.hotkeys !== undefined) {
      applyHotkeys()
    }

    if (newSettings.language !== undefined) {
      getLocalization()
      rebuildTray = true
    }

    if (newSettings.monitorFeatures !== undefined) {
      shouldRefreshMonitors = true
      try {
        for(const monitorID in newSettings.monitorFeatures) {
          for(const vcp in newSettings.monitorFeatures[monitorID]) {
            // Add settings for VCP code if it doesn't exist
            if(!newSettings.monitorFeaturesSettings?.[monitorID]?.[vcp] && !settings.monitorFeaturesSettings?.[monitorID]?.[vcp]) {
              if(!settings.monitorFeaturesSettings[monitorID]) {
                settings.monitorFeaturesSettings[monitorID] = {}
              }
              settings.monitorFeaturesSettings[monitorID][vcp] = {
                icon: "e897",
                iconType: "windows",
                iconText: "",
                iconPath: "",
                min: 0,
                max: 100,
                maxVisual: 100,
                linked: false
              }
            }
          }
        }
      } catch(e) {
        logger.debug("Couldn't read monitorFeatures", e)
      }
    }

    if (app.isReady() && newSettings.preferredDDCCIMethod) {
      monitorsThread.send({
        type: "flushvcp"
      })
      setTimeout(() => {
        refreshMonitors(true)
      }, 500)
    }

    if (settings.udpEnabled === true) {
      if (!udp.server) udp.start(settings.udpPort);
    } else if (settings.udpEnabled === false) {
      if (udp.server) udp.stop();
    }

    if (newSettings.order !== undefined) {
      doRestartPanel = true
    }

    if (newSettings.detectIdleTimeEnabled === true || newSettings.detectIdleTimeEnabled === false) {
      rebuildTray = true
    }

    if (newSettings.monitorFocusEnabled !== undefined) {
      if (settings.monitorFocusEnabled) {
        startMonitorFocusTracking()
      } else {
        stopMonitorFocusTracking()
        resetMonitorFocusState()
      }
    }

    if (newSettings.windowsStyle !== undefined) {
      if (newSettings.windowsStyle === "win11") {
        updateSettings({ isWin11: true })
      } else if (newSettings.windowsStyle === "win10") {
        updateSettings({ isWin11: false })
      } else {
        updateSettings({ isWin11: isReallyWin11 })
      }
      newSettings.useAcrylic = settings.useAcrylic
      broadcastThemeSettings()
      doRestartPanel = true
    }

    if (newSettings.useAcrylic !== undefined) {
      store.get("theme").lastTheme["UseAcrylic"] = newSettings.useAcrylic
      broadcastThemeSettings()
      if(newSettings.useAcrylic) {
        store.update("mica", { currentWallpaperTime: false })
        sendMicaWallpaper()
      }
      doRestartPanel = true
    }

    if (newSettings.icon !== undefined) {
      if (tray) {
        tray.setImage(getTrayIconPath())
      }
    }

    if (newSettings.checkForUpdates !== undefined) {
      if (newSettings.checkForUpdates === false) {
        store.update("updates", { latestVersion: false })
        broadcastLatestVersion();
      } else {
        store.update("updates", { lastCheck: false })
      }
    }

    if (newSettings.isDev === true || newSettings.isDev === false) {
      rebuildTray = true
    }

    if (settings.profiles) {
      rebuildTray = true
      if(settings.profiles?.length > 0) {
        if(!focusTrackingID) startFocusTracking();
      } else if(focusTrackingID) {
        stopFocusTracking()
      }
    }

    if (newSettings.branch) {
      store.update("updates", { lastCheck: false })
      store.update("settings", { dismissedUpdate: false })
      checkForUpdates()
    }

    if (settings.analytics) {
      pingAnalytics()
      if (analyticsInterval) {
        clearInterval(analyticsInterval)
      }
      analyticsInterval = setInterval(pingAnalytics, analyticsFrequency)
    } else {
      analytics = false
      if (analyticsInterval) {
        clearInterval(analyticsInterval)
      }
    }

    if (rebuildTray) {
      setTrayMenu()
    }

    if (mainWindow && doRestartPanel) {
      restartPanel()
    }

  } catch (e) {
    logger.debug("Couldn't process settings!", e)
  }

  if(monitorsThreadStatus === "ready") {
    monitorsThread.send({
      type: "settings",
      settings: settings
    })
    monitorsThread.send({
      type: "ddcBrightnessVCPs",
      ddcBrightnessVCPs: getDDCBrightnessVCPs()
    })
  }

  if (sendUpdate) sendToAllWindows('settings-updated', settings);
  if (shouldRefreshMonitors) {
    refreshMonitors(true, true)
  }
}

// Check if given display should be skipped during brightness update
const displaysMayBeIdleBlocks = []

function blockBadDisplays(tag = "") {
  const blockUUID = uuid()
  displaysMayBeIdleBlocks.push(blockUUID)
  const release = () => {
    const found = displaysMayBeIdleBlocks.indexOf(blockUUID)
    if(found >= 0) {
      displaysMayBeIdleBlocks.splice(found, 1)
      logger.debug(`\x1b[36mReleased block: ${blockUUID} ${tag} [${displaysMayBeIdleBlocks.length} left]\x1b[0m`)
      return true
    }
    logger.debug(`\x1b[36mFailed to release block: ${blockUUID} ${tag}\x1b[0m`)
    return false
  }
  logger.debug(`\x1b[36mStarted block: ${blockUUID} ${tag}\x1b[0m`)
  return {
    uuid: blockUUID,
    release: async () => {
      await Utils.wait(800)
      return release()
    }
  }
}

function shouldSkipDisplay(monitorOrHwid1, skipEventCheck = false) {
  if(!displaysMayBeIdleBlocks.length && !skipEventCheck) return false;
  return MonitorTransforms.shouldSkipDisplay(monitorOrHwid1, monitorRules.skipReapply, settings.userSkipReapply)
}

// Save all known displays to disk for future use
async function updateKnownDisplays(force = false, immediate = false) {

  // Skip when idle
  if (!force && store.get("idle").isUserIdle) return false;

  const doFunc = () => {
    try {
      // Get from file
      let known = getKnownDisplays(true)

      // Save to memory
      store.update("monitors", { lastKnownDisplays: known })

      // Write back to file
      fs.writeFileSync(knownDisplaysPath, JSON.stringify(known))
      logger.debug(`\x1b[36mSaved known displays!\x1b[0m`)
    } catch (e) {
      logger.error("Couldn't update known displays file.")
    }
  }

  // Reset timeout
  if (updateKnownDisplaysTimeout) clearTimeout(updateKnownDisplaysTimeout);

  if (immediate) {
    doFunc()
  } else {
    // Wait a moment
    updateKnownDisplaysTimeout = setTimeout(doFunc, 3000)
  }

}

// Get known displays from file, along with current displays
function getKnownDisplays(useCurrentMonitors) {
  let known
  if (!store.get("monitors").lastKnownDisplays) {
    try {
      // Load known displays DB
      known = fs.readFileSync(knownDisplaysPath)
      known = JSON.parse(known)
      store.update("monitors", { lastKnownDisplays: known })
    } catch (e) {
      known = {}
    }
  } else {
    known = store.get("monitors").lastKnownDisplays
  }

  // Merge with existing displays
  if (useCurrentMonitors) {
    known = Object.assign(known, JSON.parse(JSON.stringify(monitors)))
  }

  return known
}

// Look up all known displays and re-apply last brightness
function setKnownBrightness(useCurrentMonitors = false, useTransition = false, transitionSpeed = 1) {

  logger.debug(`\x1b[36mSetting brightness for known displays\x1b[0m`, useCurrentMonitors, useTransition, transitionSpeed)

  const known = getKnownDisplays(useCurrentMonitors)
  applyProfile(known, useTransition, transitionSpeed)
}

function applyProfile(profile = {}, useTransition = false, transitionSpeed = 1, skipBadDisplays = false) {

  applyOrder(profile)
  applyRemaps(profile)

  if (useTransition) {
    // If using smooth transition
    let transitionMonitors = []
    for (const hwid in profile) {
      try {
        const monitor = profile[hwid]
        if(shouldSkipDisplay(monitor)) continue;
        transitionMonitors[monitor.id] = monitor.brightness
      } catch (e) { logger.debug("Couldn't set brightness for known display!") }
    }
    transitionBrightness(50, transitionMonitors, transitionSpeed)
  } else {
    // If not using a transition
    for (const hwid in profile) {
      try {
        const monitor = profile[hwid]
        if(shouldSkipDisplay(monitor)) continue;

        // Apply brightness to valid display types
        if (monitor.type == "wmi" || monitor.type == "studio-display" || (monitor.type == "ddcci" && monitor.brightnessType)) {
          // Replace DDC/CI brightness with SDR
          if(settings.sdrAsMainSliderDisplays?.[monitor.key] && monitor.hdr === "active") {
            monitor.brightness = monitor.sdrLevel
          }
          updateBrightness(monitor.id, monitor.brightness)
        }
      } catch (e) { logger.debug("Couldn't set brightness for known display!") }
    }
  }
  
  touchMonitors();
}


// Hotkey subsystem lives in hotkeys.js. Its dependencies are injected here so
// the contract is explicit; as state migrates into the store, several of these
// (monitors, settings) collapse into `store`.
const hotkeyController = createHotkeyController({
  monitors,
  settings,
  store,
  logger,
  globalShortcut,
  getLastRefreshMonitors: () => lastRefreshMonitors,
  refreshMonitors,
  getVCP,
  minMax: Utils.minMax,
  touchMonitors,
  updateBrightnessThrottle,
  pauseMonitorUpdates,
  writeSettings,
  sleepDisplays,
  setRecentlyInteracted,
  hotkeyOverlayStart,
  sendToAllWindows
})
const applyHotkeys = (monitorList) => hotkeyController.applyHotkeys(monitorList)

let hotkeyOverlayTimeout

function hotkeyOverlayStart(timeout = 3000, force = true) {
  if (currentOverlayType() === "disabled") return false;
  if (canReposition) {
    hotkeyOverlayShow()
  }
  // Resume mouse events if disabled
  pauseMouseEvents(false)

  if (hotkeyOverlayTimeout) clearTimeout(hotkeyOverlayTimeout);
  hotkeyOverlayTimeout = setTimeout(() => hotkeyOverlayHide(force), timeout)
}

async function hotkeyOverlayShow() {
  if (currentOverlayType() === "disabled") return false;
  if (!mainWindow) return false;
  if (startHideTimeout) clearTimeout(startHideTimeout);
  startHideTimeout = null;

  mainWindow.showInactive()

  setAlwaysOnTop(true)
  sendToAllWindows("display-mode", "overlay")
  store.update("panel", { panelState: "overlay" })
  let monitorCount = 0
  Object.values(monitors).forEach((monitor) => {
    if ((monitor.type === "ddcci" || monitor.type === "studio-display" || monitor.type === "wmi") && (settings?.hideDisplays?.[monitor.key] !== true)) monitorCount++;
  })

  if (monitorCount && settings.linkedLevelsActive) {
    monitorCount = 1
  }

  canReposition = false
  if (settings.useAcrylic) {
    tryVibrancy(mainWindow, { theme: "#26262601", effect: "blur" })
  }
  await toggleTray(true, true)

  if (settings?.isWin11) {
    const panelHeight = 14 + 36 + (28 * monitorCount)
    const panelWidth = 216
    const primaryDisplay = screen.getPrimaryDisplay()

    // Only add gap if the taskbar is actually hidden (not taking up space).
    // This handles per-monitor auto-hide mods (e.g., Windhawk) where the global
    // auto-hide registry setting doesn't reflect the actual state on each monitor.
    const taskbarActuallyHidden = primaryDisplay.bounds.height === primaryDisplay.workArea.height

    let gap = 0
    if(taskbarActuallyHidden && detectedTaskbarHide) {
      gap = detectedTaskbarHeight
    }
    if (typeof settings.overrideTaskbarGap === "number") {
      gap = settings.overrideTaskbarGap
    }

    const bounds = {
      width: panelWidth,
      height: panelHeight,
      x: parseInt((primaryDisplay.workArea.width - panelWidth) / 2),
      y: parseInt(primaryDisplay.workArea.height - panelHeight - gap)
    }
    mainWindow.setBounds(bounds)
  } else {
    // Win10 style
    const panelOffset = 40
    mainWindow.setBounds({
      width: 26 + (40 * monitorCount),
      height: 138,
      x: panelOffset + 10 + (panelSize.taskbar.position === "LEFT" ? panelSize.taskbar.gap : 0),
      y: panelOffset + 20
    })
  }

  // Dumb stuff to prevent UI flicker
  setTimeout(() => {
    sendToAllWindows("display-mode", "overlay")
    setTimeout(() => {
      mainWindow.setOpacity(1)
    }, 33)
  }, 66)
}

function hotkeyOverlayHide(force = true) {
  if (!mainWindow) {
    hotkeyOverlayStart(333)
    return false
  }

  if (!force && mainWindow && mainWindow.isFocused()) {
    hotkeyOverlayStart(333)
    return false;
  }

  clearTimeout(hotkeyOverlayTimeout)
  setAlwaysOnTop(false)
  canReposition = true
  if (!mainWindow.webContents.isDevToolsOpened()) {
    sendToAllWindows("panelBlur")
    showPanel(false)
    sendToAllWindows("display-mode", "normal")
  }
  hotkeyOverlayTimeout = false

  // Pause mouse events if scroll shortcut is not enabled
  pauseMouseEvents(true)

  mainWindow.setSize(0, 0)

  if (!settings.useAcrylic || !settings.useNativeAnimation) {
    tryVibrancy(mainWindow, false)
  }
}

function applyOrder(monitorList = monitors) {
  return MonitorTransforms.applyOrder(monitorList, settings.order)
}

function applyRemaps(monitorList = monitors) {
  return MonitorTransforms.applyRemaps(monitorList, settings.remaps)
}

function enableStartup(appName, appPath) {
    const runKey = reg.openKey(reg.HKCU, 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', reg.Access.ALL_ACCESS);
    reg.setValueSZ(runKey, appName, `"${appPath}"`);
}

function disableStartup(appName) {
    const runKey = reg.openKey(reg.HKCU, 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', reg.Access.ALL_ACCESS);
    reg.deleteValue(runKey, appName);
    
    const approvedKey = reg.openKey(reg.HKCU, 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run', reg.Access.ALL_ACCESS);
    reg.deleteValue(approvedKey, appName);
}


async function updateStartupOption(openAtLogin) {
  if (!isDev && !isAppX) {
    if(openAtLogin) {
      enableStartup('electron.app.Twinkle Tray', app.getPath('exe'))
    } else {
      disableStartup('electron.app.Twinkle Tray')
    }
  }

  // Set autolaunch for AppX
  try {
    if (isAppX) {
      if (openAtLogin) {
        AppStartup.enable()
      } else {
        AppStartup.disable()
      }
    }
  } catch (e) {
    debug.error(e)
  }
}



//
//
//    Localization
//
//



const localization = {
  detected: "en",
  default: {},
  desired: {},
  all: [],
  languages: []
}
let T = new Translate(localization.desired, localization.default)
function getLocalization() {
  // Detect language
  let detected = app.getLocale()

  if (detected === "zh-CN") {
    detected = "zh_Hans"
  } else if (detected === "zh-TW" || detected === "zh-HK" || detected === "zh-MO") {
    detected = "zh-Hant"
  } else if (detected?.split("-")[0] === "pt") {
    detected = app.getLocale()
  } else {
    detected = detected?.split("-")[0]
  }

  // Use detected if user has not selected one
  localization.detected = (settings.language == "system" ? detected : settings.language)

  // Get default localization file
  try {
    const defaultFile = fs.readFileSync(path.join(__dirname, `/localization/en.json`))
    localization.default = JSON.parse(defaultFile)
  } catch (e) {
    logger.error("Couldn't read default langauge file!")
  }

  // Get user's local localization file, if available
  localization.desired = {}
  const langPath = path.join(__dirname, `/localization/${localization.detected}.json`)
  if (fs.existsSync(langPath)) {
    try {
      const desiredFile = fs.readFileSync(langPath)
      localization.desired = JSON.parse(desiredFile)
    } catch (e) {
      logger.error(`Couldn't read language file: ${localization.detected}.json`)
    }
  }

  T = new Translate(localization.desired, localization.default)
  sendToAllWindows("localization-updated", localization)

  if(monitorsThreadStatus === "ready") {
    monitorsThread.send({
      type: "localization",
      localization: {
        GENERIC_DISPLAY_SINGLE: T.getString("GENERIC_DISPLAY_SINGLE")
      }
    })
  }

}

async function getAllLanguages() {
  return new Promise((resolve, reject) => {
    fs.readdir(path.join(__dirname, `/localization/`), (err, files) => {
      if (!err) {
        let languages = []
        for (let file of files) {
          try {
            const langText = fs.readFileSync(path.join(__dirname, `/localization/`, file))
            const langName = JSON.parse(langText)["LANGUAGE"]

            if (!langName || langName.length === 0) {
              throw ("Invalid language.")
            }

            languages.push({
              id: file.split(".")[0],
              name: langName
            })
          } catch (e) {
            logger.error(`Error reading language from ${file}`)
          }
        }
        localization.languages = languages
        sendToAllWindows("localization-updated", localization)
        resolve(languages)
      } else {
        reject()
      }
    })
  })
}

ipcMain.on('request-localization', () => { sendToAllWindows("localization-updated", localization) })

function getSettings() {
  processSettings({})
  sendToAllWindows('settings-updated', settings)
}

function getDDCBrightnessVCPs() {
  try {
    // Create a new object to avoid mutating knownDDCBrightnessVCPs
    let ids = Object.assign({}, knownDDCBrightnessVCPs, settings.userDDCBrightnessVCPs)
    for (let mon in ids) {
      ids[mon] = parseInt(ids[mon])
    }
    return ids
  } catch (e) {
    logger.debug("Couldn't generate DDC Brightness IDs!", e)
    return {}
  }
}

function sendToAllWindows(eventName, data) {
  if (mainWindow) {
    mainWindow.webContents.send(eventName, data)
  }
  if (settingsWindow) {
    settingsWindow.webContents.send(eventName, data)
  }
  if (introWindow) {
    introWindow.webContents.send(eventName, data)
  }
}

// Renderer sync for the monitors model. The map (`monitors`) is mutated in
// place on hot paths (brightness/transition loops), so the store can't detect
// those edits by value. Code that changes the map calls touchMonitors(), which
// bumps a revision counter on the slice; the single subscriber below is the one
// place that broadcasts the map to renderers. Other monitors-slice writes
// (isRefreshing, lastKnownDisplays, …) carry no `rev`, so they don't trigger a
// renderer broadcast.
function touchMonitors() {
  store.update("monitors", { rev: (store.get("monitors").rev ?? 0) + 1 })
}
store.subscribe("monitors", (diff) => {
  if ("rev" in diff) sendToAllWindows("monitors-updated", monitors)
})

//
// Window navigation security
//
// Renderer windows run with contextIsolation on and nodeIntegration off, but
// in-window navigation to untrusted content is still an attack surface, so only
// internal pages (the dev server or packaged files) may navigate in-window;
// every other URL is blocked and handed to the OS browser instead. New-window
// requests are always denied, with external URLs likewise routed to the OS browser.

function isInternalURL(url) {
  return typeof url === "string" && (url.startsWith("http://localhost:3000") || url.startsWith("file://"))
}

function applyNavigationGuards(win) {
  const { shell } = require('electron')
  win.webContents.on('will-navigate', (e, url) => {
    if (isInternalURL(url)) return;
    e.preventDefault()
    shell.openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternalURL(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

//
// Software Dim Overlays
//

const softwareDimOverlays = {} // overlay BrowserWindow handles (mechanism, not state)
// Software-dim levels per monitor — stable map aliased from the "color" slice.
store.update("color", { softwareDimLevels: {} })
const softwareDimLevels = store.get("color").softwareDimLevels

function getSoftwareDimDisplayBounds(monitorId) {
  const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
  const trayMonitors = Object.values(monitors || {})
    .filter(m => m.bounds?.position !== undefined)
    .sort((a, b) => a.bounds.position.x - b.bounds.position.x || a.bounds.position.y - b.bounds.position.y)
  for (let i = 0; i < displays.length; i++) {
    if (trayMonitors[i] && trayMonitors[i].id === monitorId) {
      return displays[i].bounds
    }
  }
  return null
}

function updateSoftwareDim(monitorId, level) {
  level = Math.max(0, Math.min(100, level))
  softwareDimLevels[monitorId] = level
  for (const key in monitors) {
    if (monitors[key].id === monitorId) {
      monitors[key].softwareDim = level
      break
    }
  }

  if (store.get("idle").isWindowsUserIdle) return

  if (level === 0) {
    if (softwareDimOverlays[monitorId] && !softwareDimOverlays[monitorId].isDestroyed()) {
      softwareDimOverlays[monitorId].hide()
    }
    return
  }

  const bounds = getSoftwareDimDisplayBounds(monitorId)
  if (!bounds) return

  if (!softwareDimOverlays[monitorId] || softwareDimOverlays[monitorId].isDestroyed()) {
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      backgroundColor: '#000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        devTools: false
      }
    })
    win.setIgnoreMouseEvents(true)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setOpacity(level / 100)
    win.showInactive()
    win.loadURL('data:text/html,<body style="background:#000;margin:0"></body>')
    softwareDimOverlays[monitorId] = win
  } else {
    softwareDimOverlays[monitorId].setBounds(bounds)
    softwareDimOverlays[monitorId].setOpacity(level / 100)
    if (!softwareDimOverlays[monitorId].isVisible()) {
      softwareDimOverlays[monitorId].showInactive()
    }
  }
}

function hideSoftwareDimOverlays() {
  for (const id in softwareDimOverlays) {
    if (!softwareDimOverlays[id].isDestroyed()) {
      softwareDimOverlays[id].hide()
    }
  }
}

function showSoftwareDimOverlays() {
  for (const id in softwareDimLevels) {
    if (softwareDimLevels[id] > 0) {
      updateSoftwareDim(id, softwareDimLevels[id])
    }
  }
}

// color slice (store-owned). The level maps (effective warmth/highlight applied
// per monitor, plus the user's manual levels) are stable references aliased from
// the slice and mutated in place; the active flags are reassigned values read and
// written through the store.
store.update("color", {
  warmthLevels: {},
  highlightLevels: {},
  manualWarmthLevels: {},
  manualHighlightLevels: {},
  manualTemperatureActive: false,
  manualHighlightActive: false
})
const warmthLevels = store.get("color").warmthLevels
const highlightLevels = store.get("color").highlightLevels
const manualWarmthLevels = store.get("color").manualWarmthLevels
const manualHighlightLevels = store.get("color").manualHighlightLevels

function getMonitorDisplayIndex(monitorId) {
  const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
  const trayMonitors = Object.values(monitors || {})
    .filter(m => m.bounds?.position !== undefined)
    .sort((a, b) => a.bounds.position.x - b.bounds.position.x || a.bounds.position.y - b.bounds.position.y)
  for (let i = 0; i < displays.length; i++) {
    if (trayMonitors[i] && trayMonitors[i].id === monitorId) {
      return i
    }
  }
  return null
}

function updateDisplayColor(monitorId, { kelvin, highlightWeight } = {}) {
  if (kelvin !== undefined) warmthLevels[monitorId] = Math.max(3000, Math.min(6500, kelvin))
  if (highlightWeight !== undefined) highlightLevels[monitorId] = highlightWeight

  if (store.get("idle").isWindowsUserIdle) return

  ColorGamma.getDisplayCount()

  const displayIndex = getMonitorDisplayIndex(monitorId)
  if (displayIndex == null) return

  const effectiveKelvin = warmthLevels[monitorId] ?? 6500
  const effectiveHighlight = highlightLevels[monitorId] ?? 0
  const tempActive = effectiveKelvin < 6500
  const highlightActive = effectiveHighlight > 0

  if (!tempActive && !highlightActive) {
    ColorGamma.resetGammaRamp(displayIndex)
  } else {
    ColorGamma.applyDisplayTransform(displayIndex, {
      kelvin: tempActive ? effectiveKelvin : 6500,
      highlightWeight: highlightActive ? effectiveHighlight / 100 : 0
    })
  }

  sendDisplayColorLevels()
  setTrayStatus()
}

function updateWarmth(monitorId, kelvin = 6500) {
  kelvin = Math.max(3000, Math.min(6500, kelvin))
  manualWarmthLevels[monitorId] = kelvin
  if (store.get("color").manualTemperatureActive) {
    updateDisplayColor(monitorId, { kelvin })
  }
}

function updateHighlightCompression(monitorId, weight = 0) {
  manualHighlightLevels[monitorId] = weight
  if (store.get("color").manualHighlightActive) {
    updateDisplayColor(monitorId, { highlightWeight: weight })
  }
}

function sendDisplayColorLevels() {
  sendToAllWindows('warmth-levels-updated', warmthLevels)
  sendToAllWindows('highlight-levels-updated', highlightLevels)
}

function hideDisplayColorEffects() {
  ColorGamma.resetAllGammaRamps()
}

function showDisplayColorEffects() {
  const ids = new Set([...Object.keys(warmthLevels), ...Object.keys(highlightLevels)])
  for (const id of ids) {
    updateDisplayColor(id)
  }
}

function getScheduledColorForMonitor(monitor, foundEvent) {
  const updates = {}
  if (!foundEvent) return updates

  if (settings.adjustmentTimeTemperatureEnabled) {
    let kelvin = foundEvent.kelvin ?? 6500
    if (settings.adjustmentTimeIndividualDisplays && foundEvent.monitorsKelvin?.[monitor.id] != null) {
      kelvin = foundEvent.monitorsKelvin[monitor.id]
    }
    updates.kelvin = kelvin
  }

  if (settings.adjustmentTimeHighlightCompressionEnabled) {
    let highlight = foundEvent.highlightWeight ?? 0
    if (settings.adjustmentTimeIndividualDisplays && foundEvent.monitorsHighlightWeight?.[monitor.id] != null) {
      highlight = foundEvent.monitorsHighlightWeight[monitor.id]
    }
    updates.highlightWeight = highlight
  }

  return updates
}

function applyCurrentDisplayColorEffects(overrideManual = true) {
  const foundEvent = getCurrentAdjustmentEvent()
  if (!foundEvent) return

  for (let key in monitors) {
    const monitor = monitors[key]
    const updates = getScheduledColorForMonitor(monitor, foundEvent)
    if (!overrideManual) {
      const color = store.get("color")
      if (color.manualTemperatureActive) delete updates.kelvin
      if (color.manualHighlightActive) delete updates.highlightWeight
    }
    if (Object.keys(updates).length) {
      updateDisplayColor(monitor.id, updates)
    }
  }
}

ipcMain.on('send-settings', (event, data) => {
  logger.debug("Recieved new settings", data.newSettings)
  writeSettings(data.newSettings, true, data.sendUpdate)
})

ipcMain.on('request-settings', (event) => {
  getSettings()
  getThemeRegistry() // Technically, it doesn't belong here, but it's a good place to piggy-back off of
})

ipcMain.on('reset-settings', () => {
  // Full reset: clear the slice in place (update() only merges, can't remove
  // stale keys), then reseed defaults through the store.
  for (const key of Object.keys(settings)) delete settings[key]
  store.update("settings", Object.assign({}, defaultSettings))
  logger.debug("Resetting settings")
  store.update("monitors", { lastKnownDisplays: {} })
  fs.writeFileSync(knownDisplaysPath, JSON.stringify(store.get("monitors").lastKnownDisplays))
  writeSettings({ userClosedIntro: true })
})

ipcMain.on('open-settings-file', () => {
  logger.debug("Opening settings file in default editor")
  exec(`notepad.exe "${settingsPath}"`)
})

// Get the user's Windows Personalization settings
function broadcastThemeSettings() {
  const lastTheme = store.get("theme").lastTheme
  if (lastTheme) sendToAllWindows('theme-settings', lastTheme)
}

async function getThemeRegistry() {
  logger.debug("Function: getThemeRegistry");

  broadcastThemeSettings()

  const themeSettings = {};
  try {
    const key = reg.openKey(reg.HKCU, 'Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', reg.Access.ALL_ACCESS);

    themeSettings.AppsUseLightTheme = reg.getValue(key, null, 'AppsUseLightTheme');
    themeSettings.EnableTransparency = reg.getValue(key, null, 'EnableTransparency');
    themeSettings.SystemUsesLightTheme = reg.getValue(key, null, 'SystemUsesLightTheme');
    themeSettings.ColorPrevalence = reg.getValue(key, null, 'ColorPrevalence');
  } catch (e) {
    logger.debug("Couldn't access theme registry", e)
  }

  themeSettings.UseAcrylic = settings.useAcrylic
  if (themeSettings.ColorPrevalence) {
    if (settings.theme == "dark" || settings.theme == "light") {
      themeSettings.ColorPrevalence = false
    }
  }

  // Send it off!
  sendToAllWindows('theme-settings', themeSettings)
  store.update("theme", { lastTheme: themeSettings })
  if (tray) {
    tray.setImage(getTrayIconPath())
  }

  // Taskbar position
  // For use only if auto-hide is on
  try {
    const key = reg.openKey(reg.HKCU, 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StuckRects3', reg.Access.ALL_ACCESS);

    const Settings = reg.getValue(key, null, 'Settings');
    const taskbarPos = Settings[12] * 1
    detectedTaskbarHeight = Settings[20] * 1
    detectedTaskbarHide = (parseInt(Settings[8]) & 1  ? true : false) // 3 = auto-hide

    if (taskbarPos !== null || settings.useTaskbarRegistry) {
      switch (taskbarPos) {
        case 0: detectedTaskbarPos = "LEFT"; break;
        case 1: detectedTaskbarPos = "TOP"; break;
        case 2: detectedTaskbarPos = "RIGHT"; break;
        case 3: detectedTaskbarPos = "BOTTOM"; break;
      }
    }
  } catch (e) {
    logger.debug("Couldn't access taskbar registry", e)
  }

  return true
}

function getTrayIconPath() {
  const lastTheme = store.get("theme").lastTheme
  const themeDir = (lastTheme && lastTheme.SystemUsesLightTheme ? 'light' : 'dark')
  let icon = "icon";
  if (settings.icon === "mdl2" || settings.icon === "fluent") {
    icon = settings.icon
  }
  return path.join(__dirname, `assets/tray-icons/${themeDir}/${icon}.ico`)
}

function getAccentColors() {
  let detectedAccent = "0078d7"
  const colors = AccentColors.getAccentColors()
  try {
    if (systemPreferences.getAccentColor().length == 8)
      detectedAccent = systemPreferences.getAccentColor().substr(0, 6)
  } catch (e) { logger.debug("Couldn't get accent color from registry!") }
  const accent = Color("#" + detectedAccent, "hex")
  const matchLumi = (color, level) => {
    let adjusted = color.hsl()
    adjusted.color[2] = (level * 100)
    return adjusted
  }
  let adjustedAccent = accent
  if (accent.hsl().color[2] > 60) adjustedAccent = matchLumi(accent, 0.6);
  if (accent.hsl().color[2] < 40) adjustedAccent = matchLumi(accent, 0.4);

  // Start w/ old format
  let outColors = {
    accent: adjustedAccent.hex(),
    lighter: matchLumi(accent, 0.85).hex(),
    light: matchLumi(accent, 0.52).hex(),
    medium: matchLumi(accent, 0.48).hex(),
    mediumDark: matchLumi(accent, 0.33).desaturate(0.1).hex(),
    dark: matchLumi(accent, 0.275).desaturate(0.1).hex(),
    transparent: matchLumi(accent, 0.275).desaturate(0.1).rgb().string(),
  }

  // Merge in new format
  outColors = Object.assign(outColors, colors)

  return outColors
}

function tryVibrancy(window, value = null) {
  if (!window) return false;
  try {
    if (!settings.useAcrylic || settings.isWin11 || value === false) {
      window.setBackgroundColor("#00000000")
      Acrylic.disableAcrylic(window.getNativeWindowHandle().readInt32LE(0))
      return false
    }
    const color = Color((typeof value === "string" ? value : value.theme))
    Acrylic.setAcrylic(window.getNativeWindowHandle().readInt32LE(0), 1, color.red(), color.green(), color.blue(), parseInt(color.alpha() * 255))
  }
  catch (e) {
    logger.debug("Couldn't set vibrancy", e)
  }
}


//
//
//    Monitor updates
//
//

// isRefreshing (monitor-refresh-in-progress flag, also broadcast to renderers)
// lives in the "monitors" store slice as a reassigned value.
store.update("monitors", { isRefreshing: true })
// panel slice (store-owned). Both panelState and shouldShowPanel are reassigned
// values, so they're read/written through the store rather than aliased.
store.update("panel", { shouldShowPanel: false })
const setIsRefreshing = newValue => {
  store.update("monitors", { isRefreshing: (newValue ? true : false) })
  sendToAllWindows("isRefreshing", store.get("monitors").isRefreshing)
}


const refreshMonitorsJob = async (fullRefresh = false) => {
  return await new Promise((resolve, reject) => {
    try {
      monitorsThread.send({
        type: "refreshMonitors",
        fullRefresh
      })

      let timeout = setTimeout(() => {
        reject("Monitor thread timed out.")

        // Attempt to fix common issue with wmi-bridge by relying only on Win32
        // However, if user re-enables WMI, don't disable it again
        if (!settings.autoDisabledWMI && !store.get("power").recentlyWokeUp) {
          store.update("settings", { autoDisabledWMI: true, disableWMI: true })
        }
      }, 60000)

      function listen(resolve) {
        monitorsThread.once("refreshMonitors", data => {
          clearTimeout(timeout)
          resolve(data.monitors)
        })
      }
      listen(resolve)
    } catch (e) {
      reject("Monitor thread failed to send.")
    }
  })
}

let lastRefreshMonitors = 0

async function refreshMonitors(fullRefresh = false, bypassRateLimit = false) {

  if (store.get("idle").isWindowsUserIdle) {
    logger.debug("Displays are off, no updates.")
    return monitors
  }

  if (monitorsThreadStatus !== "ready" || pausedMonitorUpdates) {
    logger.debug("Sorry, no updates right now!")
    return monitors
  }

  // Don't do 2+ refreshes at once
  if (store.get("monitors").isRefreshing) {
    logger.debug(`Already refreshing. Aborting.`)
    return monitors;
  }

  lastRefreshMonitors = Date.now()

  logger.debug(" ")
  logger.debug("\x1b[34m-------------- Refresh Monitors -------------- \x1b[0m")

  // Don't check too often for no reason
  const now = Date.now()
  if (!fullRefresh && !bypassRateLimit && now < lastEagerUpdate + 5000) {
    logger.debug(`Requesting update too soon. ${5000 - (now - lastEagerUpdate)}ms left.`)
    logger.debug("\x1b[34m---------------------------------------------- \x1b[0m")
    return monitors;
  }
  setIsRefreshing(true)

  // Reset all known displays
  if (fullRefresh) {
    logger.debug("Doing full refresh.")
  }

  // Save old monitors for comparison
  let oldMonitors = Object.assign({}, monitors)
  let newMonitors

  let failed = false
  try {
    newMonitors = await refreshMonitorsJob(fullRefresh)
    if (!newMonitors) {
      failed = true;
      throw "No monitors recieved!";
    }
    lastEagerUpdate = Date.now()
  } catch (e) {
    logger.debug('Couldn\'t refresh monitors', e)
  }

  if (!failed) {
    applyOrder(newMonitors)
    applyRemaps(newMonitors)
    applyHotkeys(newMonitors)

    // Normalize values
    for (let id in newMonitors) {
      const monitor = newMonitors[id]
      // Brightness
      monitor.brightness = Utils.normalizeBrightness(monitor.brightness, true, monitor.min, monitor.max, monitor.calibration)


      // Replace DDC/CI brightness with SDR
      if(settings.sdrAsMainSliderDisplays?.[monitor.key] && monitor.hdr === "active") {
        monitor.brightness = monitor.sdrLevel
      }

      // Other DDC/CI normalizations
      const featuresSettings = settings.monitorFeaturesSettings?.[monitor.hwid[1]]
      if(featuresSettings) {
        // For each feature, check for matching normalization data
        for(const vcp in monitor.features) {
          if(featuresSettings[vcp] && featuresSettings[vcp].min >= 0 && featuresSettings[vcp].max <= 100) {
            monitor.features[vcp][0] = Utils.normalizeBrightness(monitor.features[vcp][0], true, featuresSettings[vcp].min, featuresSettings[vcp].max)
          }
        }
      }

    }

    // Replace contents in place so the store-owned `monitors` reference stays stable.
    for (const k in monitors) delete monitors[k]
    Object.assign(monitors, newMonitors)

    // Only send update if something changed
    if (JSON.stringify(newMonitors) !== JSON.stringify(oldMonitors)) {
      setTrayStatus()
      touchMonitors()
    } else {
      logger.debug("===--- NO CHANGE ---===")
    }
  }

  if (store.get("panel").shouldShowPanel) {
    store.update("panel", { shouldShowPanel: false })
    setTimeout(() => toggleTray(true), 333)
  }

  logger.debug("\x1b[34m---------------------------------------------- \x1b[0m")
  setIsRefreshing(false)
  return monitors;
}


let pausedMonitorUpdates = false
function pauseMonitorUpdates() {
  if (pausedMonitorUpdates) clearTimeout(pausedMonitorUpdates);
  pausedMonitorUpdates = setTimeout(() => pausedMonitorUpdates = false, settings.updateInterval * 2)
}




//
//
//    Brightness (and VCP) updates
//
//


let updateBrightnessTimeout = false
let updateBrightnessQueue = []
let lastBrightnessTimes = []
function updateBrightnessThrottle(id, level, useCap = true, sendUpdate = true, vcp = "brightness", clearTransition = true) {
  let idx = updateBrightnessQueue.length
  const found = updateBrightnessQueue.findIndex(item => item.id === id)
  updateBrightnessQueue[(found > -1 ? found : idx)] = {
    id,
    level,
    useCap,
    vcp,
    clearTransition
  }
  const now = Date.now()
  if (lastBrightnessTimes[id] === undefined || now >= lastBrightnessTimes[id] + settings.updateInterval) {
    lastBrightnessTimes[id] = now
    updateBrightness(id, level, useCap, vcp, clearTransition)
    if (sendUpdate) touchMonitors();
    return true
  } else if (!updateBrightnessTimeout) {
    lastBrightnessTimes[id] = now
    updateBrightnessTimeout = setTimeout(() => {
      const updateBrightnessQueueCopy = updateBrightnessQueue.splice(0)
      for (let bUpdate of updateBrightnessQueueCopy) {
        if (bUpdate) {
          try {
            updateBrightness(bUpdate.id, bUpdate.level, bUpdate.useCap, bUpdate.vcp, bUpdate.clearTransition)
          } catch (e) {
            logger.error(e)
          }
        }
      }
      updateBrightnessTimeout = false
      if (sendUpdate) touchMonitors();
    }, settings.updateInterval)
  }
  return false
}



// ignoreBrightnessEvent (suppress Windows brightness events during our own WMI
// writes) lives in the "monitors" slice as a reassigned value. Its companion
// timeout handle below stays a local — it's a setTimeout handle, not state.
store.update("monitors", { ignoreBrightnessEvent: false })
let ignoreBrightnessEventTimeout = false
function updateBrightness(index, newLevel, useCap = true, vcpValue = "brightness", clearTransition = true) {
  if(store.get("idle").isWindowsUserIdle) return false; // Skip if displays are off
  try {
    let level = newLevel
    let vcp = "brightness"
    switch(vcpValue) {
      case "brightness": vcp = "brightness"; break;
      case "sdr": vcp = "sdr"; break;
      default: vcp = `0x${parseInt(vcpValue).toString(16)}`;
    }

    let monitor = false
    if (typeof index == "string" && index * 1 != index) {
      monitor = Object.values(monitors).find((display) => {
        return display?.id?.indexOf(index) === 0
      })
    } else {
      if (index >= Object.keys(monitors).length) {
        logger.debug("updateBrightness: Invalid monitor")
        return false;
      }
      monitor = monitors[index]
    }

    if (!monitor) {
      logger.debug(`Monitor does not exist: ${index}`)
      return false
    }

    if (settings.hideDisplays?.[monitor.key] === true) {
      return false
    }
    

    if(vcp == "brightness" && monitor.hdr === "active" && settings.sdrAsMainSliderDisplays?.[monitor.key]) {
      vcp = "sdr"
      useCap = false
    }

    if (clearTransition && currentTransition) {
      clearInterval(currentTransition)
      currentTransition = null
    }

    if(shouldSkipDisplay(monitor)) {
      logger.debug(`\x1b[31mSkipping monitor ${monitor.id} due to rules list\x1b[0m`)
      return false
    }

    const normalized = Utils.normalizeBrightness(level, false, (useCap ? monitor.min : 0), (useCap ? monitor.max : 100), (useCap ? monitor.calibration : []))

    if (vcp === "sdr") {
      monitorsThread.send({
        type: "sdr",
        brightness: level,
        id: monitor.id
      })
      monitor.sdrLevel = level
      if(settings.sdrAsMainSliderDisplays?.[monitor.key]) {
        monitor.brightness = level
        monitor.brightnessRaw = normalized
      }
    } else if (monitor.type == "ddcci") {
      if (vcp === "brightness") {
        monitor.brightness = level
        monitor.brightnessRaw = normalized
        monitorsThread.send({
          type: "brightness",
          brightness: normalized * ((monitor.brightnessMax || 100) / 100),
          id: monitor.id
        })

        // Replace DDC/CI brightness with SDR
        if(settings.sdrAsMainSliderDisplays?.[monitor.key] && monitor.hdr === "active") {
          monitor.brightness = monitor.sdrLevel
        }

        // Apply linked DDC/CI features
        const featuresSettings = settings.monitorFeaturesSettings?.[monitor.hwid[1]]
        if(featuresSettings) {
          // For each feature, check for linked value
          for(const vcp in monitor.features) {
            if(featuresSettings[vcp]?.linked && settings.monitorFeatures?.[monitor.hwid[1]]?.[vcp]) {

              const maxBrightness = (featuresSettings[vcp].maxVisual ?? 100)
              let processedLevel = newLevel
              if(processedLevel > maxBrightness) {
                processedLevel = maxBrightness
              }

              const capped = parseInt(Utils.normalizeBrightness(processedLevel, true, 0, maxBrightness))
              updateBrightnessThrottle(index, capped, useCap, false, vcp, clearTransition)
            }
          }
        }
      } else {
        const vcpString = Utils.vcpStr(vcp)
        try {
          
          // Normalize VCP value, if applicable
          const featuresSettings = settings.monitorFeaturesSettings?.[monitor.hwid[1]]
          if(featuresSettings?.[vcp] && featuresSettings[vcp].min >= 0 && featuresSettings[vcp].max <= 100) {
            level = Utils.normalizeBrightness(level, false, featuresSettings[vcp].min, featuresSettings[vcp].max)
          }
          
          if(monitor.features?.[vcpString]) {
            monitor.features[vcpString][0] = parseInt(level)
          }
          
          
          monitorsThread.send({
            type: "vcp",
            monitor: monitor.hwid.join("#"),
            code: parseInt(vcp),
            value: parseInt(level)
          })
          logger.debug('monitors-updated', monitor.features?.[vcpString])
          
        } catch(e) {
          logger.debug(`Couldn't set VCP code ${vcpString} for monitor ${monitor.id}`, e)
        }
      }
    } else if (monitor.type === "studio-display") {
      monitor.brightness = level
      monitor.brightnessRaw = normalized
      monitorsThread.send({
        type: "brightness",
        brightness: normalized * ((monitor.brightnessMax || 100) / 100),
        id: monitor.id
      })
    } else if (monitor.type == "wmi") {
      store.update("monitors", { ignoreBrightnessEvent: true }) // Don't listen for Windows brightness events
      monitor.brightness = level
      monitor.brightnessRaw = normalized
      monitorsThread.send({
        type: "brightness",
        brightness: normalized
      })
      if(ignoreBrightnessEventTimeout) clearTimeout(ignoreBrightnessEventTimeout);
      ignoreBrightnessEventTimeout = setTimeout(() => {
        store.update("monitors", { ignoreBrightnessEvent: false })
        ignoreBrightnessEventTimeout = false
      }, 500)
    }

    setTrayStatus()
    updateKnownDisplays()
  } catch (e) {
    debug.error("Could not update brightness", e)
  }
}


function updateAllBrightness(brightness, mode = "offset") {

  let linkedLevelVal

  // Update internal brightness values
  for (let key in monitors) {
    const monitor = monitors[key]
    if (monitor.type !== "none") {

      // Replace DDC/CI brightness with SDR
      if(settings.sdrAsMainSliderDisplays?.[monitor.key] && monitor.hdr === "active") {
        monitor.brightness = monitor.sdrLevel
      }

      let normalizedAdjust = Utils.minMax(mode == "set" ? brightness : brightness + monitor.brightness)

      // Use linked levels, if applicable
      if (settings.linkedLevelsActive) {
        // Set shared brightness value if not set
        if (linkedLevelVal) {
          normalizedAdjust = linkedLevelVal
        } else {
          linkedLevelVal = normalizedAdjust
        }
      }

      monitors[key].brightness = normalizedAdjust
      if(settings.sdrAsMainSliderDisplays?.[monitor.key]) monitors[key].sdrLevel = normalizedAdjust;
    }
  }

  // Update UI
  touchMonitors();

  // Send brightness updates
  for (let key in monitors) {
    updateBrightnessThrottle(monitors[key].id, monitors[key].brightness, true, false)
  }
}


let currentTransition = null
function transitionBrightness(level, eventMonitors = [], stepSpeed = 1, softwareDimLevel = 0, eventMonitorsSoftwareDim = {}, warmthKelvin = 6500, eventMonitorsKelvin = {}, highlightWeight = 0, eventMonitorsHighlightWeight = {}, onlyMonitorIds = null) {
  if (currentTransition !== null) clearInterval(currentTransition);

  // Slow down transition
  let transitionIntervalMult = 1
  switch (settings.adjustmentTimeSpeed) {
    case "slow": transitionIntervalMult = 4; break;
    case "slowest": transitionIntervalMult = 10; break;
    default: transitionIntervalMult = 1; break;
  }

  // Speed up transition
  let stepSpeedMult = 1
  switch (settings.adjustmentTimeSpeed) {
    case "faster": stepSpeedMult = 3; break;
    case "fastest": stepSpeedMult = 6; break;
    default: stepSpeedMult = 1; break;
  }

  const step = (stepSpeed * stepSpeedMult)
  const usePerMonitorTargets = settings.adjustmentTimeIndividualDisplays || onlyMonitorIds
  const targetMonitorCount = onlyMonitorIds
    ? onlyMonitorIds.length
    : Object.keys(monitors).length

  currentTransition = setInterval(() => {
    if (store.get("power").recentlyWokeUp || store.get("idle").isWindowsUserIdle) clearInterval(currentTransition);
    let numDone = 0
    for (let key in monitors) {
      const monitor = monitors[key]
      if (onlyMonitorIds && !onlyMonitorIds.includes(monitor.id)) continue

      let normalized = level * 1
      if (usePerMonitorTargets) {
        normalized = (eventMonitors[monitor.id] >= 0 ? eventMonitors[monitor.id] : level)
      }

      if (settings.remaps) {
        for (let remapName in settings.remaps) {
          if (remapName == monitor.name) {
            normalized = normalized
          }
        }
      }
      if (monitor.brightness < normalized + (step + 1) && monitor.brightness > normalized - (step + 1)) {
        updateBrightness(monitor.id, normalized, undefined, undefined, false)
        numDone++
      } else {
        updateBrightness(monitor.id, (monitor.brightness < normalized ? monitor.brightness + step : monitor.brightness - step), undefined, undefined, false)
      }
      touchMonitors()
      if (numDone === targetMonitorCount) {
        clearInterval(currentTransition);
        currentTransition = null
        // Apply software dim and display color once transition reaches the target
        for (let k in monitors) {
          if (onlyMonitorIds && !onlyMonitorIds.includes(monitors[k].id)) continue
          let dimLevel = softwareDimLevel
          if (usePerMonitorTargets) {
            dimLevel = (eventMonitorsSoftwareDim[monitors[k].id] >= 0 ? eventMonitorsSoftwareDim[monitors[k].id] : softwareDimLevel)
          }
          updateSoftwareDim(monitors[k].id, dimLevel)
          let kelvin = warmthKelvin
          if (usePerMonitorTargets && eventMonitorsKelvin[monitors[k].id] != null) {
            kelvin = eventMonitorsKelvin[monitors[k].id]
          }
          let highlight = highlightWeight
          if (usePerMonitorTargets && eventMonitorsHighlightWeight[monitors[k].id] != null) {
            highlight = eventMonitorsHighlightWeight[monitors[k].id]
          }
          const colorUpdates = {}
          if (settings.adjustmentTimeTemperatureEnabled) colorUpdates.kelvin = kelvin
          if (settings.adjustmentTimeHighlightCompressionEnabled) colorUpdates.highlightWeight = highlight
          if (Object.keys(colorUpdates).length) updateDisplayColor(monitors[k].id, colorUpdates)
        }
      }
    }
  }, settings.updateInterval * transitionIntervalMult)
}

function transitionlessBrightness(level, eventMonitors = {}, softwareDimLevel = 0, eventMonitorsSoftwareDim = {}, warmthKelvin = 6500, eventMonitorsKelvin = {}, highlightWeight = 0, eventMonitorsHighlightWeight = {}, onlyMonitorIds = null) {
  for (let key in monitors) {
    const monitor = monitors[key]
    if (onlyMonitorIds && !onlyMonitorIds.includes(monitor.id)) continue
    let normalized = level
    let dimLevel = softwareDimLevel
    let kelvin = warmthKelvin
    let highlight = highlightWeight
    if (settings.adjustmentTimeIndividualDisplays || onlyMonitorIds) {
      normalized = (eventMonitors[monitor.id] >= 0 ? eventMonitors[monitor.id] : level)
      dimLevel = (eventMonitorsSoftwareDim[monitor.id] >= 0 ? eventMonitorsSoftwareDim[monitor.id] : softwareDimLevel)
      if (eventMonitorsKelvin[monitor.id] != null) {
        kelvin = eventMonitorsKelvin[monitor.id]
      }
      if (eventMonitorsHighlightWeight[monitor.id] != null) {
        highlight = eventMonitorsHighlightWeight[monitor.id]
      }
    }
    // When updating only a subset of monitors (onlyMonitorIds is set), don't clear
    // currentTransition — an inactive-dim animation may be running on other monitors.
    updateBrightness(monitor.id, normalized, undefined, undefined, !onlyMonitorIds)
    updateSoftwareDim(monitor.id, dimLevel)
    const colorUpdates = {}
    if (settings.adjustmentTimeTemperatureEnabled) colorUpdates.kelvin = kelvin
    if (settings.adjustmentTimeHighlightCompressionEnabled) colorUpdates.highlightWeight = highlight
    if (Object.keys(colorUpdates).length) updateDisplayColor(monitor.id, colorUpdates)
    touchMonitors()
  }
}

// Flag recent user activity to skip certain events
let hasRecentlyInteracted = false
function setRecentlyInteracted(hasInteracted) {
  if(hasRecentlyInteracted) clearTimeout(hasRecentlyInteracted);
  if(!hasInteracted) {
    hasRecentlyInteracted = false
  } else {
    hasRecentlyInteracted = setTimeout(() => {
      hasRecentlyInteracted = false
    }, 5000)
  }

}

let sleepTimeout
function sleepDisplays(mode = "ps", delayMS = 333) {
  try {
    if(sleepTimeout) clearTimeout(sleepTimeout);
    sleepTimeout = setTimeout(async () => {
      if (mode === "ddcci" || mode === "ps_ddcci") {
        for (let monitorID in monitors) {
          const monitor = monitors[monitorID]
          await turnOffDisplayDDC(monitor.hwid.join("#"))
        }
      }

      if (mode === "ps" || mode === "ps_ddcci") {
        exec(`powershell.exe -NoProfile (Add-Type '[DllImport(\\"user32.dll\\")]^public static extern int PostMessage(int hWnd, int hMsg, int wParam, int lParam);' -Name a -Pas)::PostMessage(0xFFFF,0x0112,0xF170,0x0002)`)
      }
      sleepTimeout = false
    }, delayMS)

  } catch (e) {
    logger.debug(e)
  }
}

async function turnOffDisplayDDC(hwid, toggle = false) {
  try {
    const offVal = parseInt(settings.ddcPowerOffValue)
    if (toggle) {
      const currentValue = await getVCP(hwid, 0xD6)
      if (currentValue > 1) {
        monitorsThread.send({
          type: "vcp",
          monitor: hwid,
          code: 0xD6,
          value: 1
        })
        return true
      }
    }
    if (offVal === 4 || offVal === 6) {
      monitorsThread.send({
        type: "vcp",
        monitor: hwid,
        code: 0xD6,
        value: 4
      })
    }
    if (offVal === 5 || offVal === 6) {
      monitorsThread.send({
        type: "vcp",
        monitor: hwid,
        code: 0xD6,
        value: 5
      })
    }
  } catch (e) {
    logger.debug("turnOffDisplayDDC failed", e)
  }
}




//
//
//    IPC Events
//
//

ipcMain.on('request-colors', () => {
  sendToAllWindows('update-colors', getAccentColors())
  getThemeRegistry()
})

ipcMain.on('update-brightness', function (event, data) {
  setRecentlyInteracted(true)
  updateBrightness(data.index, data.level)

  // If overlay is visible, keep it open
  if (hotkeyOverlayTimeout) {
    hotkeyOverlayStart()
  }
})

ipcMain.on('update-software-dim', (event, { monitorId, level }) => {
  updateSoftwareDim(monitorId, level)
})

ipcMain.on('update-warmth', (event, { monitorId, kelvin }) => {
  updateWarmth(monitorId, kelvin)
})

ipcMain.on('update-highlight-compression', (event, { monitorId, weight }) => {
  updateHighlightCompression(monitorId, weight)
})

ipcMain.on('request-warmth-levels', () => {
  sendDisplayColorLevels()
})

ipcMain.on('request-highlight-levels', () => {
  sendDisplayColorLevels()
})

ipcMain.on('toggle-color-temperature', (event, openPanel = false) => {
  toggleColorTemperature(openPanel)
})

ipcMain.on('toggle-highlight-compression', (event, openPanel = false) => {
  toggleHighlightCompression(openPanel)
})

ipcMain.on('toggle-time-adjustments', () => {
  toggleTimeAdjustments()
})

ipcMain.on('request-color-toggle-state', () => {
  sendColorToggleState()
})

ipcMain.on('request-schedule-lock-state', () => {
  sendScheduleLockState()
})

ipcMain.on('request-monitors', function (event, arg) {
  touchMonitors()
})

ipcMain.on('full-refresh', function (event, forceUpdate = false) {
  refreshMonitors(true).then(() => {
    if (forceUpdate) {
      touchMonitors()
    }
  })
})

ipcMain.on('flush-vcp-cache', function (event) {
  monitorsThread.send({
    type: "flushvcp"
  })
})

ipcMain.on('get-refreshing', () => {
  sendToAllWindows('isRefreshing', store.get("monitors").isRefreshing)
})

ipcMain.on('open-settings', createSettings)

ipcMain.on('log', (e, msg) => logger.fromRemote('UI', msg))

ipcMain.on('pause-updates', pauseMonitorUpdates)

ipcMain.on('open-url', (event, url) => {
  if (url === "ms-store") {
    require("electron").shell.openExternal("ms-windows-store://pdp/?productid=9PLJWWSV01LK")
  } else if (url === "privacy-policy") {
    require("electron").shell.openExternal("https://twinkletray.com/privacy-policy.html")
  } else if (url === "troubleshooting-features") {
    require("electron").shell.openExternal("https://github.com/xanderfrangos/twinkle-tray/wiki/Display-Detection-&-Support-Issues#disabling-monitor-detection-methods-available-in-v1140")
  }
})

ipcMain.on('get-update', (event, version) => {
  store.get("updates").latestVersion.error = false
  getLatestUpdate(version)
})

ipcMain.on('panel-height', (event, height) => {
  if (store.get("panel").panelState === "overlay") return;
  panelSize.height = height + (settings?.isWin11 ? 24 : 0)
  panelSize.width = 392 + (settings?.isWin11 ? 24 : 0)
  if (panelSize.visible && !isAnimatingPanel) {
    repositionPanel()
  }
})

ipcMain.on('panel-hidden', () => {
  sendToAllWindows("display-mode", "normal")
  store.update("panel", { panelState: "hidden" })
  if (settings.killWhenIdle) mainWindow.close()
})

ipcMain.on('blur-panel', () => {
  if (mainWindow) mainWindow.blur();
})

ipcMain.on('show-acrylic', () => {
  const lastTheme = store.get("theme").lastTheme
  if (settings.useAcrylic && !settings.useNativeAnimation) {
    if (lastTheme && lastTheme.ColorPrevalence) {
      tryVibrancy(mainWindow, { theme: getAccentColors().dark + (settings.useAcrylic ? "D0" : "70"), effect: (settings.useAcrylic ? "acrylic" : "blur") })
    } else {
      tryVibrancy(mainWindow, { theme: (lastTheme && nativeTheme.themeSource === "light" ? (settings.useAcrylic ? "#DBDBDBDD" : "#DBDBDB70") : (settings.useAcrylic ? "#292929DD" : "#29292970")), effect: (settings.useAcrylic ? "acrylic" : "blur") })
    }
  } else {
    tryVibrancy(mainWindow, false)
    mainWindow.setBackgroundColor("#00000000")
  }
  sendToAllWindows("set-acrylic-show")
})

ipcMain.on('apply-last-known-monitors', () => { setKnownBrightness() })

ipcMain.on('sleep-displays', () => sleepDisplays(settings.sleepAction, 1000))
ipcMain.on('sleep-display', (e, hwid) => turnOffDisplayDDC(hwid, true))
ipcMain.on('set-vcp', (e, values) => {
  setRecentlyInteracted(true)
  updateBrightnessThrottle(values.monitor, values.value, false, true, values.code)
})
ipcMain.on('set-sdr-brightness', (e, values) => {
  setRecentlyInteracted(true)
  updateBrightnessThrottle(values.monitor, values.value, false, true, "sdr")
})

ipcMain.on('get-window-history', () => sendToAllWindows('window-history', windowHistory))

ipcMain.on('save-report', async () => {
  try {
    monitorsThread.send({
      type: "getReport"
    })

    monitorsThread.once("getReport", data => {
      require('electron').dialog.showSaveDialog({
        title: "Save report",
        buttonLabel: 'Save file',
        defaultPath: app.getPath("desktop") + `\\tt-report-${Date.now()}.txt`,
        filters: [{
          name: ".txt",
          extensions: ["txt"]
        }]
    }).then(result => {
      if(result?.filePath) {
        fs.writeFileSync(result.filePath, JSON.stringify(data, null, '\t'))
      }
    })
    })
  } catch (e) {
    reject("getReport failed to send.")
  }
})


//
//
//    Initialize Panel
//
//

store.update("panel", { panelState: "hidden" })

function createPanel(toggleOnLoad = false, isRefreshing = false, showOnLoad = true) {

  logger.debug("Creating panel...")

  mainWindow = new BrowserWindow({
    width: panelSize.width,
    height: panelSize.height,
    x: 0,
    y: 0,
    minHeight: 0,
    minWidth: 0,
    backgroundColor: "#00000000",
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    resizable: false,
    type: "toolbar",
    title: "Twinkle Tray Flyout",
    maximizable: false,
    minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'panel-preload.js'),
      devTools: settings.isDev,
      nodeIntegration: false,
      contextIsolation: true,
      // Preload needs Node (os priority, gc, launch args); contextIsolation
      // keeps the renderer itself isolated and Node-free.
      sandbox: false,
      plugins: false,
      backgroundThrottling: (settings.disableThrottling ? false : true),
      spellcheck: false,
      webgl: false,
      enableWebSQL: false,
      v8CacheOptions: "none",
      zoomFactor: 1.0,
      additionalArguments: ["jsVars" + Buffer.from(JSON.stringify({
        appName: app.name,
        appVersion: appVersion,
        appVersionTag: appVersionTag,
        appBuild: appBuildShort,
        isRefreshing: isRefreshing
      })).toString('base64')]
    }
  });

  mainWindow.loadURL(
    isDev
      ? "http://localhost:3000/index.html"
      : `file://${path.join(__dirname, "../build/index.html")}`
  );

  applyNavigationGuards(mainWindow)

  mainWindow.on("closed", () => { logger.debug("~~~~~ MAIN WINDOW CLOSED ~~~~~~"); mainWindow = null });
  mainWindow.on("minimize", () => { logger.debug("~~~~~ MAIN WINDOW MINIMIZED ~~~~~~") });
  mainWindow.on("restore", () => { logger.debug("~~~~~ MAIN WINDOW RESTORED ~~~~~~") });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.setMenu(windowMenu)

      logger.debug("Panel ready!")
      createTray()

      if(showOnLoad) showPanel(false);

      setTimeout(() => {
        if(!mainWindow) return false;
        if (!settings.useAcrylic || settings.isWin11) {
          tryVibrancy(mainWindow, false)
          mainWindow.setBackgroundColor("#00000000")
        }
      }, 100)

      if (toggleOnLoad) setTimeout(() => { toggleTray(false) }, 33);
    }
  })

  mainWindow.on("blur", () => {
    // Only run when not in an overlay
    if (canReposition) {
      if (!mainWindow.webContents.isDevToolsOpened()) {
        sendToAllWindows("panelBlur")
        showPanel(false)
      }
    }
  })

  mainWindow.on('move', (e) => {
    try {
      e.preventDefault()
      sendToAllWindows('panel-position', mainWindow.getPosition())
    } catch (e) { }
  })

  mainWindow.on('resize', (e) => {
    try {
      e.preventDefault()
      sendToAllWindows('panel-position', mainWindow.getPosition())
    } catch (e) { }
  })

  mainWindow.webContents.once('dom-ready', () => {
    try {
      touchMonitors()
      // Do full refreshes shortly after startup in case Windows isn't ready.

      setTimeout(sendMicaWallpaper, 1000)
      sendToAllWindows('panel-position', mainWindow.getPosition())
    } catch (e) { logger.error("dom-ready startup handler failed", e) }
  })

  mainWindow.hookWindowMessage(126, (wParam, lParam) => {
    if(settings.useWmDisplayChangeEvent && !settings.disablePowerNotifications) handleMetricsChange("wm_displaychange")
  })

  // WM_POWERBROADCAST
  mainWindow.hookWindowMessage(0x218, (wParam, lParam) => {
    if(settings.disablePowerNotifications) return false;
    if(wParam.readUInt32LE() !== 32787) return false;
    // PBT_POWERSETTINGCHANGE

    const setting = PowerEvents.getPowerSetting(lParam.readBigInt64LE(0))
    if(setting.name !== "" || setting.guid) {
      logger.debug(`Event: ${setting.name || setting.guid} (${setting.data})`)
    }

    if(setting.name === "GUID_SESSION_USER_PRESENCE") {
      if(!settings.useGuidPresenceEvent) return false;
      if(setting.data === 2) {
        // Idle
        if(!store.get("idle").isWindowsUserIdle) {
          logger.debug("Displays have gone to sleep.")
          hideSoftwareDimOverlays()
          hideDisplayColorEffects()

          // If we were about to do a hardware event, stop.
          if (handleChangeTimeout1) clearTimeout(handleChangeTimeout1);
          if (handleChangeTimeout2) clearTimeout(handleChangeTimeout2);
        }
        store.update("idle", { isWindowsUserIdle: true })
      } else if(setting.data === 0) {
        // Active
        if(store.get("idle").isWindowsUserIdle) {
          store.update("idle", { isWindowsUserIdle: false })
          logger.debug("Displays have woken up.")
          store.update("power", { recentlyWokeUp: true })
          handleMetricsChange("GUID_SESSION_USER_PRESENCE")
          setTimeout(showSoftwareDimOverlays, 500)
          setTimeout(showDisplayColorEffects, 500)
          setTimeout(() => {
            store.update("power", { recentlyWokeUp: false })
          },
            15000
          )
        }
      }
    } else if(setting.name === "GUID_VIDEO_POWERDOWN_TIMEOUT") {
      // "Turn off my screen after"
    } else if(setting.name === "GUID_STANDBY_TIMEOUT") {
      // "Make my device sleep after"
    } else if(setting.name === "GUID_VIDEO_CURRENT_MONITOR_BRIGHTNESS") {
      // Internal display brightness change
      if(!settings.useGuidBrightnessEvent) return false;
      if(!store.get("monitors").ignoreBrightnessEvent) {
        for(const hwid2 in monitors) {
          const monitor = monitors[hwid2]
          if(monitor.type === "wmi") {
            const normalized = Utils.normalizeBrightness(setting.data, true, monitor.min, monitor.max, monitor.calibration)
            monitor.brightness = normalized
            monitor.brightnessRaw = setting.data
          }
          touchMonitors()
        }
      }
    }
  })

  // WM_SYSCOMMAND
  mainWindow.hookWindowMessage(0x0112, (wParam, lParam) => {
    if(!settings.useScMonitorPowerEvent || settings.disablePowerNotifications) return false;
    if(wParam.readUInt32LE() === 61808) {
      // SC_MONITORPOWER
      if(lParam.readUInt32LE() === 2) {
        // 2 = Display is being shut off
        logger.debug("Event: SC_MONITORPOWER")
      }
    }
  })

  if(!settings.disablePowerNotifications) PowerEvents.registerPowerSettingNotifications(getMainWindowHandle())

}

function currentOverlayType() {
  let overlayType = store.get("profile").currentProfile?.overlayType
  if(!overlayType || overlayType == "normal") {
    overlayType = settings.defaultOverlayType
  }
  logger.debug(`overlayType: ${overlayType}`)
  return overlayType
}

function setAlwaysOnTop(onTop = true) {
  if (!mainWindow) return false;
  if (onTop) {
    if(currentOverlayType() === "aggressive") {
      mainWindow.setAlwaysOnTop(true, 'screen-saver')
      if(settingsWindow?.isMinimized() === false) {
        settingsWindow?.minimize() // Workaround for weird bug when settings window is open
      }
    } else {
      mainWindow.setAlwaysOnTop(true, 'modal-panel')
    }
  } else {
    mainWindow.setAlwaysOnTop(false)
  }
  return true
}

function destroyPanel() {
  if (mainWindow) {
    mainWindow.destroy()
    mainWindow = null
  }
}

let restartingPanel = false
function restartPanel(show = false) {
  logger.debug("Function: restartPanel");
  if(restartingPanel) {
    logger.debug("Function: restartPanel: already restarting")
    return false
  }
  restartingPanel = true
  if (mainWindow) {
    mainWindow.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    mainWindow.setOpacity(1)
    //mainWindow.restore()
    mainWindow.showInactive()
  }
  destroyPanel()
  createPanel(show, false, false)
  restartingPanel = false
}

function getPrimaryDisplay() {
  let displays = screen.getAllDisplays()
  // Use coordinate (0,0) to choose the primary display.
  let primaryDisplay = displays.find((display) => {
    return display.bounds.x == 0 && display.bounds.y == 0
  })

  // Fall back on previous logic if none is found.
  if (!primaryDisplay) primaryDisplay = displays.find((display) => {
    return display.bounds.x == 0 || display.bounds.y == 0
  })

  if (tray) {
    try {
      let trayBounds = tray.getBounds()
      let foundDisplay = displays.find(d => {
        return (trayBounds.x >= d.bounds.x && trayBounds.x <= d.bounds.x + d.bounds.width && trayBounds.y >= d.bounds.y && trayBounds.y <= d.bounds.y + d.bounds.height)
      })
      if (foundDisplay) primaryDisplay = foundDisplay;
    } catch (e) { }
  }
  return primaryDisplay
}



let detectedTaskbarPos = false
let detectedTaskbarHeight = false
let detectedTaskbarHide = false
let canReposition = true
function repositionPanel() {
  try {

    if (!canReposition) {
      mainWindow.setBounds({
        width: panelSize.width,
        height: panelSize.height
      })
      return false
    }
    let primaryDisplay = getPrimaryDisplay()

    const taskbarPosition = () => {
      let primaryDisplay = getPrimaryDisplay()

      const bounds = primaryDisplay.bounds
      const workArea = primaryDisplay.workArea
      let gap = 0
      let position = "BOTTOM"
      if (bounds.x < workArea.x) {
        position = "LEFT"
        gap = bounds.width - workArea.width
      } else if (bounds.y < workArea.y) {
        position = "TOP"
        gap = bounds.height - workArea.height
      } else if (bounds.width > workArea.width) {
        position = "RIGHT"
        gap = bounds.width - workArea.width
      } else {
        position = "BOTTOM"
        gap = bounds.height - workArea.height
      }

      // Use taskbar position from registry if auto-hide is on
      if (detectedTaskbarHide) {
        position = detectedTaskbarPos
        if (position === "TOP" || position === "BOTTOM") {
          gap = detectedTaskbarHeight
        }
      }

      if (typeof settings.overrideTaskbarPosition === "string") {
        const pos = settings.overrideTaskbarPosition.toUpperCase()
        if (pos === "BOTTOM" || pos === "TOP" || pos === "LEFT" || pos === "RIGHT") {
          position = pos
        }
      }

      if (typeof settings.overrideTaskbarGap === "number") {
        gap = settings.overrideTaskbarGap
        logger.debug(gap)
      }

      return { position, gap }
    }

    const taskbar = taskbarPosition()
    panelSize.taskbar = taskbar
    sendToAllWindows('taskbar', taskbar)

    if (mainWindow && !isAnimatingPanel) {
      // Check if taskbar is actually taking up space on the primary display.
      // This handles per-monitor auto-hide mods (e.g., Windhawk) where the global
      // auto-hide registry setting doesn't reflect the actual state on each monitor.
      const taskbarActuallyHidden = (taskbar.position === "BOTTOM" || taskbar.position === "TOP")
        ? primaryDisplay.bounds.height === primaryDisplay.workArea.height
        : primaryDisplay.bounds.width === primaryDisplay.workArea.width

      if (taskbar.position == "LEFT") {
        mainWindow.setBounds({
          width: panelSize.width,
          height: panelSize.height,
          x: primaryDisplay.bounds.x + taskbar.gap,
          y: primaryDisplay.bounds.y + primaryDisplay.workArea.height - panelSize.height
        })
      } else if (taskbar.position == "TOP") {
        mainWindow.setBounds({
          width: panelSize.width,
          height: panelSize.height,
          x: primaryDisplay.bounds.x + primaryDisplay.workArea.width - panelSize.width,
          y: primaryDisplay.bounds.y + taskbar.gap
        })
      } else if (taskbarActuallyHidden && taskbar.position == "BOTTOM") {
        // Edge case for auto-hide taskbar (taskbar is truly hidden, not taking up space)
        mainWindow.setBounds({
          width: panelSize.width,
          height: panelSize.height,
          x: primaryDisplay.bounds.x + primaryDisplay.workArea.width - panelSize.width,
          y: primaryDisplay.bounds.y + primaryDisplay.workArea.height - panelSize.height - taskbar.gap
        })
      } else {
        mainWindow.setBounds({
          width: panelSize.width,
          height: panelSize.height,
          x: primaryDisplay.bounds.x + primaryDisplay.workArea.width - panelSize.width,
          y: primaryDisplay.bounds.y + primaryDisplay.bounds.height - panelSize.height - taskbar.gap
        })
      }
      panelSize.base = mainWindow.getBounds().y
    }

    sendToAllWindows('panel-position', mainWindow.getPosition())
  } catch (e) {
    logger.debug("Couldn't reposition panel", e)
  }
}



let forcedFocusID = 0
// profile slice (store-owned): the window-focus profile feature's state.
// currentProfile is the profile matched to the current foreground window (or
// undefined); preProfileBrightness snapshots brightness before a profile is
// applied so the previous levels can be restored. Both are reassigned values,
// read and written through the store.
store.update("profile", { currentProfile: undefined, preProfileBrightness: {} })
const ignoreAppList = [
  "twinkletray.exe",
  "explorer.exe",
  "electron.exe"
]
const windowHistory = []
let focusTrackingID = 0
function startFocusTracking() {
  if(focusTrackingID) return false; // Already tracking

  focusTrackingID = ActiveWindow.subscribe(async window => {
    if (!window) return false;
    if (settings.profiles?.length == 0) return false;

    const hwnd = WindowUtils.getForegroundWindow()
    const profile = windowMatchesProfile(window)

    if (ignoreAppList.includes(path.basename(window.path)) === false) {
      // Remove from history if exists
      const isInHistory = windowHistory.find((w, idx) => {
        if (w.path === window.path) {
          windowHistory.splice(idx, 1)
          return true
        }
        return false
      })

      // Add current window
      windowHistory.unshift({
        app: window.application,
        path: window.path
      })

      // Limit history
      while (windowHistory.length > 8) windowHistory.pop();
      sendToAllWindows('window-history', windowHistory)
    }

    if (forcedFocusID > 0 && forcedFocusID !== hwnd && hwnd != getMainWindowHandle()) {
      // This is the overlay
      // We're going to force focus back to the previous window
      trySetForegroundWindow(hwnd)
    } else if (profile?.setBrightness) {
      // Set brightness, if available

      // First, save current brightness for later
      await updateKnownDisplays(true, true)
      store.update("profile", { preProfileBrightness: Object.assign({}, store.get("monitors").lastKnownDisplays) })

      // Then apply user profile brightness
      applyProfileBrightness(profile)
    } else if (store.get("profile").currentProfile?.setBrightness) {
      // Last profile had brightness settings
      // So we should restore the last known brightness
      applyProfile(store.get("profile").preProfileBrightness, false)
    }
    store.update("profile", { currentProfile: profile })
  })

  logger.debug(`Starting focus tracking... (#${focusTrackingID})`)
}

function stopFocusTracking() {
  if (focusTrackingID) {
    logger.debug("Stopping focus tracking...")
    ActiveWindow.unsubscribe(focusTrackingID)
    focusTrackingID = 0
  }
}

function windowMatchesProfile(window) {
  if (!window) return false;
  const foundProfile = Profiles.matchWindowToProfile(window.path, settings.profiles)
  if(foundProfile) logger.debug(`Matched window to profile ${foundProfile.name}`);
  return foundProfile
}

function applyProfileBrightness(profile) {
  try {
    Object.values(monitors)?.forEach(monitor => {
      updateBrightness(monitor.id, profile.monitors[monitor.id], true, "brightness")
    })
    touchMonitors()
  } catch (e) {
    logger.debug("Error applying profile brightness", e)
  }
}

function getMainWindowHandle() {
  try {
    return mainWindow.getNativeWindowHandle().readInt32LE()
  } catch (e) {
    return 0
  }
}







/*


    Brightness panel animations


*/



let panelAnimationInterval = false
let shouldAnimatePanel = false
let isAnimatingPanel = false
let panelHeight = 0
let panelMaxHeight = 80
let panelTransitionTime = 0.35
let currentPanelTime = 0
let startPanelTime = process.hrtime.bigint()
let lastPanelTime = process.hrtime.bigint()
let primaryRefreshRate = 59.97
let primaryDPI = 1
let mainWindowHandle

// Set brightness panel state (visible or not)
function showPanel(show = true, height = 300) {
  const lastTheme = store.get("theme").lastTheme

  if (show) {
    // Show panel
    if (startHideTimeout) clearTimeout(startHideTimeout); // Reset "hide" timeout
    startHideTimeout = null
    mainWindow.restore()
    mainWindowHandle = mainWindow.getNativeWindowHandle().readInt32LE(0)
    repositionPanel()
    panelHeight = height
    panelSize.visible = true

    panelSize.bounds = screen.dipToScreenRect(mainWindow, mainWindow.getBounds())
    panelSize.bounds = mainWindow.getBounds()
    primaryDPI = screen.getPrimaryDisplay().scaleFactor
    panelHeight = panelHeight * primaryDPI

    if (settings.useNativeAnimation && settings.useAcrylic && lastTheme.EnableTransparency) {
      // Acrylic + Native Animation
      if (lastTheme && lastTheme.ColorPrevalence) {
        tryVibrancy(mainWindow, { theme: getAccentColors().dark + (settings.useAcrylic ? "D0" : "70"), effect: (settings.useAcrylic ? "acrylic" : "blur") })
      } else {
        tryVibrancy(mainWindow, { theme: (lastTheme && lastTheme.SystemUsesLightTheme ? (settings.useAcrylic ? "#DBDBDBDD" : "#DBDBDB70") : (settings.useAcrylic ? "#292929DD" : "#29292970")), effect: (settings.useAcrylic ? "acrylic" : "blur") })
      }
      startPanelAnimation()
    } else {
      // No blur, or CSS Animation
      if (settings.useAcrylic) {
        // Apply acrylic immediately so the window already has blur when it appears.
        if (lastTheme && lastTheme.ColorPrevalence) {
          tryVibrancy(mainWindow, { theme: getAccentColors().dark + "D0", effect: "acrylic" })
        } else {
          tryVibrancy(mainWindow, { theme: (lastTheme && lastTheme.SystemUsesLightTheme ? "#DBDBDBDD" : "#292929DD"), effect: "acrylic" })
        }
      } else {
        tryVibrancy(mainWindow, false)
        mainWindow.setBackgroundColor("#00000000")
      }
      if (panelSize.taskbar.position === "TOP") {
        // Top
        setWindowPos(mainWindowHandle, -2, panelSize.bounds.x * primaryDPI, ((panelSize.base) * primaryDPI), panelSize.bounds.width * primaryDPI, panelHeight, 0x0400)
      } else {
        // Bottom, left, right
        mainWindow.show()
        mainWindow.setBounds(panelSize.bounds)
      }
    }

    setAlwaysOnTop(true)
    mainWindow.focus()

    // Resume mouse events if disabled
    pauseMouseEvents(false)
    mainWindow.setOpacity(1)
    mainWindow.show()
    sendToAllWindows('panel-position', mainWindow.getPosition())
    sendToAllWindows("playPanelAnimation")

  } else {
    // Hide panel
    setAlwaysOnTop(false)
    panelSize.visible = false
    clearInterval(panelAnimationInterval)
    panelAnimationInterval = false
    shouldAnimatePanel = false
    isAnimatingPanel = false
    sendToAllWindows("display-mode", "normal")
    store.update("panel", { panelState: "hidden" })
    sendToAllWindows("closePanelAnimation")
    if (!settings.useAcrylic || !settings.useNativeAnimation) {
      tryVibrancy(mainWindow, false)
    }
    // Pause mouse events
    pauseMouseEvents(true)
    if(mainWindow.isVisible) startHidePanel();
  }
}

function trySetForegroundWindow(hwnd) {
  if (!hwnd) return false;
  try {
    logger.debug("trySetForegroundWindow: " + hwnd)
    WindowUtils.setForegroundWindow(hwnd)
  } catch (e) {
    logger.debug("Couldn't focus window", e)
  }
}

let startHideTimeout
function startHidePanel() {
  if (!startHideTimeout) {
    startHideTimeout = setTimeout(() => {
      if (mainWindow) {
        mainWindow.minimize();
      }
      startHideTimeout = null
    }, 100)

    if (mainWindow) mainWindow.setOpacity(0);
  }
}

// Begins panel opening animation
async function startPanelAnimation() {
  if (!shouldAnimatePanel) {

    // Set to animating
    shouldAnimatePanel = true
    isAnimatingPanel = true

    // Reset timing variables
    startPanelTime = process.hrtime.bigint()
    currentPanelTime = -1

    // Get refresh rate of primary display
    // This allows the animation to play no more than the refresh rate
    primaryRefreshRate = await refreshCtx.findVerticalRefreshRateForDisplayPoint(0, 0)

    // Start animation interval after a short delay
    // This avoids jank from React updating the DOM
    if (!panelAnimationInterval)
      setTimeout(() => {
        if (!panelAnimationInterval)
          panelAnimationInterval = setTimeout(doAnimationStep, 1000 / 600)
      }, 100)
  }
}

// Borrowed some of this animation logic from @djsweet
function hrtimeDeltaForFrequency(freq) {
  return BigInt(Math.ceil(1000000000 / freq));
}
let busy = false
function doAnimationStep() {

  // If animation has been requested to stop, kill it
  if (!isAnimatingPanel) {
    clearInterval(panelAnimationInterval)
    panelAnimationInterval = false
    shouldAnimatePanel = false
    return false
  }

  if (currentPanelTime === -1) {
    startPanelTime = process.hrtime.bigint()
    currentPanelTime = 0
  }
  // Limit updates to specific interval

  const now = process.hrtime.bigint()
  if (!busy && now > lastPanelTime + hrtimeDeltaForFrequency(primaryRefreshRate * (settings.useAcrylic ? 1 : 2) || 59.97)) {

    lastPanelTime = now
    currentPanelTime = Number(Number(now - startPanelTime) / 1000000000)

    // Check if at end of animation
    if (currentPanelTime >= panelTransitionTime) {
      // Stop animation
      isAnimatingPanel = false
      shouldAnimatePanel = false
      // Stop at 100%
      currentPanelTime = panelTransitionTime
      clearInterval(panelAnimationInterval)
      panelAnimationInterval = false
    }

    // LERP height and opacity
    let calculatedHeight = panelHeight - (panelMaxHeight * primaryDPI) + Math.round(Utils.easeOutQuad(currentPanelTime / panelTransitionTime) * (panelMaxHeight * primaryDPI))
    let calculatedOpacity = (Math.round(Math.min(1, currentPanelTime / (panelTransitionTime / 6)) * 100) / 100)

    // Apply panel size

    busy = true
    if (panelSize.taskbar.position === "TOP") {
      // Top
      setWindowPos(mainWindowHandle, -2, panelSize.bounds.x * primaryDPI, ((panelSize.base) * primaryDPI), panelSize.bounds.width * primaryDPI, calculatedHeight, 0x0400)
    } else {
      // Bottom, left, right
      setWindowPos(mainWindowHandle, -2, panelSize.bounds.x * primaryDPI, ((panelSize.base) * primaryDPI) + (panelHeight - calculatedHeight), panelSize.bounds.width * primaryDPI, calculatedHeight + (6 * primaryDPI * (settings.useAcrylic ? 0 : 1)), 0x0400)
    }

    // Stop opacity updates if at 1 already
    if (mainWindow.getOpacity() < 1)
      mainWindow.setOpacity(calculatedOpacity)
    busy = false
  }

  if (isAnimatingPanel) {
    panelAnimationInterval = setTimeout(doAnimationStep, 1000 / (primaryRefreshRate * (settings.useAcrylic ? 1 : 2) || 59.97))
  } else {
    repositionPanel()
  }
}








// Local Parcel server
if(isDev) {
  logger.debug("Starting Parcel bundler server...")
  require("./parcelAPI")("dev", 1)
}

app.on("ready", async () => {
  screen.on("display-added", invalidateDisplayCache)
  screen.on("display-removed", invalidateDisplayCache)
  screen.on("display-metrics-changed", invalidateDisplayCache)

  await getAllLanguages()
  await getThemeRegistry()
  getLocalization()
  showIntro()
  createPanel(false, true)

  await doWMIBridgeTest()
  startMonitorThread()
  monitorsThread.once("ready", async () => {

    monitorsThread.send({
      type: "localization",
      localization: {
        GENERIC_DISPLAY_SINGLE: T.getString("GENERIC_DISPLAY_SINGLE")
      }
    })

    store.update("monitors", { isRefreshing: false })
    await refreshMonitors(true, true)

    if (settings.brightnessAtStartup) setKnownBrightness();
    if (settings.checkTimeAtStartup) {
      store.update("schedule", { lastTimeEvent: false });
      setTimeout(() => handleBackgroundUpdate(true), 3500)
    }
    restartBackgroundUpdate()
  
    // Set startup grace period to prevent delayed handlers from overwriting current brightness
    isStartupGracePeriod = true
    setTimeout(() => {
      isStartupGracePeriod = false
      logger.debug("Startup grace period ended")
    }, 30000) // 30 seconds grace period
  
    setTimeout(addEventListeners, 5000)
    setTimeout(() => {
      if (settings.monitorFocusEnabled) startMonitorFocusTracking()
    }, 6000)
  })

})

// Empty handler: overrides Electron's default of quitting when all windows
// close, so the app keeps running in the tray.
app.on("window-all-closed", () => {});

app.on('quit', () => {
  try {
    ColorGamma.resetAllGammaRamps()
  } catch (e) { logger.error("Failed to reset gamma ramps on quit", e) }
  try {
    tray.destroy()
  } catch (e) {

  }
})



//
//
//    Tray
//
//

function createTray() {
  if (tray != null) return false;

  const { Tray } = require('electron')
  tray = new Tray(getTrayIconPath())
  tray.setToolTip('Twinkle Tray' + (isDev ? " (Dev)" : ""))
  setTrayMenu()
  tray.on("click", async () => toggleTray(true))

  let lastMouseMove = Date.now()
  tray.on('mouse-move', async () => {
    const now = Date.now()
    if (lastMouseMove + 500 > now) return false;
    lastMouseMove = now
    bounds = tray.getBounds()
    bounds = screen.dipToScreenRect(null, bounds)
    tryEagerUpdate(false)
    sendToAllWindows('panel-unsleep')

    if (settings.scrollShortcut) {
      // Start tracking cursor to determine when it leaves the tray
      if (mouseEvents && mouseEvents.getPaused()) {
        pauseMouseEvents(false)
      }
      willPauseMouseEvents()
    }
  })

  setTrayStatus()
}

let recreatingTray = false
async function recreateTray() {
  if(recreatingTray) return;
  recreatingTray = true
  tray?.destroy?.()
  tray = null
  createTray()
  recreatingTray = false
}

function setTrayMenu() {
  if (tray === null) return false;

  const contextMenu = Menu.buildFromTemplate([
    getTimeAdjustmentsMenuItem(),
    getTemperatureMenuItem(),
    getHighlightCompressionMenuItem(),
    getDetectIdleMenuItem(),
    getProfilesMenuItem(),
    getPausableSeparatorMenuItem(),
    { label: T.t("GENERIC_REFRESH_DISPLAYS"), type: 'normal', click: () => refreshMonitors(true, true) },
    { label: T.t("GENERIC_SETTINGS"), type: 'normal', click: createSettings },
    { type: 'separator' },
    getDebugTrayMenuItems(),
    { label: T.t("GENERIC_QUIT"), type: 'normal', click: quitApp }
  ])
  tray.setContextMenu(contextMenu)
}

function getPausableSeparatorMenuItem() {
  if (settings.detectIdleTimeEnabled || settings.adjustmentTimes.length > 0) {
    return { type: 'separator' }
  }
  return { label: "", visible: false }
}

function getTimeAdjustmentsMenuItem() {
  if (settings.adjustmentTimes?.length) {
    return {
      label: T.t("GENERIC_PAUSE_TOD"),
      type: 'checkbox',
      checked: !settings.adjustmentTimesActive,
      click: (e) => writeSettings({ adjustmentTimesActive: !e.checked }, true, true)
    }
  }
  return { label: "", visible: false }
}

function getDetectIdleMenuItem() {
  if (settings.detectIdleTimeEnabled) {
    return { label: T.t("GENERIC_PAUSE_IDLE"), type: 'checkbox', click: (e) => tempSettings.pauseIdleDetection = e.checked }
  }
  return { label: "", visible: false }
}

function getProfilesMenuItem() {
  try {
    if(settings.profiles?.length) {
      const profiles = []
      for(const profile of settings.profiles) {
        if(profile.showInMenu && profile.setBrightness) {
          profiles.push({ label: profile.name, type: 'normal', click: (e) => applyProfileBrightness(profile) })
        }
      }
      if(profiles.length) {
        const submenu = Menu.buildFromTemplate(profiles)
        return { label: T.t("SETTINGS_PROFILES_TITLE"), submenu: submenu }
      }
    }
  } catch(e) { }
  return { label: "", visible: false }
}

function getDebugTrayMenuItems() {
  return {
    label: "DEBUG", visible: (settings.isDev ? true : false), submenu: [
      { label: "RESTART PANEL", type: 'normal', click: () => restartPanel() },
      { label: "RECREATE TRAY", type: 'normal', click: () => recreateTray() },
      { label: "MINIMIZE PANEL", type: 'normal', click: () => mainWindow?.minimize() },
      { label: "HIDE PANEL", type: 'normal', click: () => showPanel(false) },
      { label: "OPACITY 0", type: 'normal', click: () => mainWindow?.setOpacity(0) },
      { label: "OPACITY 1", type: 'normal', click: () => mainWindow?.setOpacity(1) },
      { label: "DO CURRENT TOD", type: 'normal', click: () => applyCurrentAdjustmentEvent(true) },
      { label: "REMOVE ACRYLIC", type: 'normal', click: () => tryVibrancy(mainWindow, false) },
      { label: "PAUSE MOUSE", type: 'normal', click: () => pauseMouseEvents(true) },
      { label: "LAST ACTIVE WIN", type: 'normal', click: () => trySetForegroundWindow(forcedFocusID) }
    ]
  }
}

function getTemperatureMenuItem() {
  return {
    label: T.t("PANEL_LABEL_COLOR_TEMPERATURE"),
    type: 'checkbox',
    checked: store.get("color").manualTemperatureActive,
    click: () => {
      toggleColorTemperature()
    }
  }
}

function getHighlightCompressionMenuItem() {
  return {
    label: T.t("PANEL_LABEL_HIGHLIGHT_COMPRESSION"),
    type: 'checkbox',
    checked: store.get("color").manualHighlightActive,
    click: () => {
      toggleHighlightCompression()
    }
  }
}

function getCurrentKelvin() {
  try {
    if (!store.get("color").manualTemperatureActive && !settings.adjustmentTimeTemperatureEnabled) return 6500
    const activeLevels = Object.values(warmthLevels).filter(k => k > 0 && k < 6500)
    if (activeLevels.length) {
      return Math.round(activeLevels.reduce((a, b) => a + b, 0) / activeLevels.length)
    }
    const event = getCurrentAdjustmentEvent()
    if (event?.kelvin != null) return event.kelvin
  } catch (e) { }
  return 6500
}

function sendColorToggleState() {
  const color = store.get("color")
  sendToAllWindows('color-toggle-state', { manualTemperatureActive: color.manualTemperatureActive, manualHighlightActive: color.manualHighlightActive })
}

function sendScheduleLockState() {
  sendToAllWindows('schedule-lock-state', {
    brightness: settings.adjustmentTimesActive && settings.adjustmentTimes.length > 0,
    temperature: settings.adjustmentTimesActive && settings.adjustmentTimeTemperatureEnabled,
    highlight: settings.adjustmentTimesActive && settings.adjustmentTimeHighlightCompressionEnabled,
  })
}

function toggleTimeAdjustments() {
  writeSettings({ adjustmentTimesActive: !settings.adjustmentTimesActive }, true, true)
}

function toggleColorEffect(type, openPanel = false) {
  const isTemp = type === 'temperature'
  const effectiveLevels = isTemp ? warmthLevels : highlightLevels
  const manualLevels = isTemp ? manualWarmthLevels : manualHighlightLevels
  const scheduleKey = isTemp ? 'adjustmentTimeTemperatureEnabled' : 'adjustmentTimeHighlightCompressionEnabled'
  const scheduledProp = isTemp ? 'kelvin' : 'highlightWeight'
  const defaultValue = isTemp ? 6500 : 0
  const shouldPreserve = isTemp ? (v) => v != null && v < 6500 : (v) => v != null && v > 0
  const applyManual = isTemp
    ? (id, v) => updateWarmth(id, v)
    : (id, v) => updateHighlightCompression(id, v)
  const applyDisplay = isTemp
    ? (id, v) => updateDisplayColor(id, { kelvin: v })
    : (id, v) => updateDisplayColor(id, { highlightWeight: v })

  const activeKey = isTemp ? 'manualTemperatureActive' : 'manualHighlightActive'
  const wasActive = store.get("color")[activeKey]
  if (wasActive) {
    // Preserve current effective value before turning off
    for (const key in monitors) {
      const id = monitors[key].id
      const val = effectiveLevels[id] ?? manualLevels[id]
      if (shouldPreserve(val)) manualLevels[id] = val
    }
  }

  const nowActive = !wasActive
  store.update("color", { [activeKey]: nowActive })

  if (nowActive) {
    for (const key in monitors) {
      const id = monitors[key].id
      applyManual(id, manualLevels[id] ?? effectiveLevels[id] ?? defaultValue)
    }
  } else {
    const foundEvent = settings[scheduleKey] ? getCurrentAdjustmentEvent() : null
    for (const key in monitors) {
      const monitor = monitors[key]
      const updates = foundEvent ? getScheduledColorForMonitor(monitor, foundEvent) : {}
      applyDisplay(monitor.id, updates[scheduledProp] ?? defaultValue)
    }
  }
  setTrayMenu()
  setTrayStatus()
  sendColorToggleState()
  if (openPanel && nowActive) {
    setTimeout(() => toggleTray(true), 100)
  }
}

function toggleColorTemperature(openPanel = false) {
  toggleColorEffect('temperature', openPanel)
}

function toggleHighlightCompression(openPanel = false) {
  toggleColorEffect('highlight', openPanel)
}

function setTrayStatus() {
  try {
    if (tray) {
      let averagePerc = 0
      let i = 0
      for (let key in monitors) {
        if (monitors[key].type === "ddcci" || monitors[key].type === "wmi") {
          i++
          const dim = monitors[key].softwareDim ?? 0
          averagePerc += (dim > 0 && monitors[key].brightness === 0) ? -dim : monitors[key].brightness
        }
      }
      let tooltip = 'Twinkle Tray' + (isDev ? " (Dev)" : "")
      const kelvin = getCurrentKelvin()
      const showKelvin = (store.get("color").manualTemperatureActive || settings.adjustmentTimeTemperatureEnabled) && kelvin < 6500
      if (i > 0) {
        averagePerc = Math.floor(averagePerc / i)
        tooltip += ' (' + averagePerc + '%' + (showKelvin ? ', ' + kelvin + 'K' : '') + ')'
      } else if (showKelvin) {
        tooltip += ' (' + kelvin + 'K)'
      }
      tray.setToolTip(tooltip)
    }
  } catch (e) {
    logger.debug(e)
  }
}

let lastEagerUpdate = 0
function tryEagerUpdate(forceRefresh = true) {
  const now = Date.now()
  if (now > lastEagerUpdate + 5000) {
    lastEagerUpdate = now
    refreshMonitors(forceRefresh, true)
  }
}

function quitApp() {
  app.quit()
}

const toggleTray = async (doRefresh = true, isOverlay = false) => {

  if (mainWindow == null) {
    createPanel(true)
    return false
  }

  if (doRefresh && !isOverlay) {
    tryEagerUpdate(false)
    getThemeRegistry()
    getSettings()

    // Send accent
    sendToAllWindows('update-colors', getAccentColors())
    if (store.get("updates").latestVersion) broadcastLatestVersion();
  }

  if (mainWindow) {
    mainWindow.setBackgroundColor("#00000000")
    if (!isOverlay) {

      // Check if overlay is currently open and deal with that
      if (!canReposition) {
        showPanel(false)
        hotkeyOverlayHide()
        setTimeout(() => {
          sendToAllWindows("display-mode", "normal")
        }, 300)
        return false
      }
      sendMicaWallpaper()
      sendToAllWindows("display-mode", "normal")
      showPanel(true, panelSize.height)
      store.update("panel", { panelState: "visible" })
      mainWindow.focus()
    } else {
      sendToAllWindows("display-mode", "overlay")
      store.update("panel", { panelState: "overlay" })
    }
    sendToAllWindows('request-height')
    mainWindow.webContents.send("tray-clicked")
    mainWindow.setSkipTaskbar(false)
    mainWindow.setSkipTaskbar(true)
  }
}





//
//
//    Intro Window
//
//

let introWindow
function showIntro() {

  // Check if user has already seen the intro
  if (settings.userClosedIntro) {
    return false;
  }

  if (introWindow != null) {
    // Don't make window if already open
    introWindow.focus()
    return false;
  }

  introWindow = new BrowserWindow({
    width: 500,
    height: 650,
    show: false,
    maximizable: false,
    resizable: false,
    minimizable: false,
    frame: false,
    transparent: true,
    icon: './src/assets/logo.ico',
    title: "Twinkle Tray",
    webPreferences: {
      preload: path.join(__dirname, 'intro-preload.js'),
      devTools: settings.isDev,
      nodeIntegration: false,
      zoomFactor: 1.0,
      contextIsolation: true
    }
  });

  introWindow.loadURL(
    isDev
      ? "http://localhost:3000/intro.html"
      : `file://${path.join(__dirname, "../build/intro.html")}`
  );

  applyNavigationGuards(introWindow)

  introWindow.on("closed", () => (introWindow = null));

  introWindow.once('ready-to-show', () => {
    introWindow.setMenu(windowMenu)
    introWindow.show()
    broadcastThemeSettings()
  })

}

ipcMain.on('close-intro', (event, newSettings) => {
  if (introWindow) {
    introWindow.close()
    writeSettings({ userClosedIntro: true })
  }
})






//
//
//    Settings Window
//
//

let settingsWindow
function createSettings() {
  const lastTheme = store.get("theme").lastTheme

  if (settingsWindow != null) {
    // Don't make window if already open
    settingsWindow.focus()
    return false;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  settingsWindow = new BrowserWindow({
    width: (width >= 1200 ? 1024 : 600),
    height: (height >= 768 ? 720 : 500),
    minHeight: 450,
    minWidth: 600,
    show: false,
    maximizable: true,
    resizable: true,
    minimizable: true,
    backgroundColor: "#00000000",
    frame: false,
    icon: './src/assets/logo.ico',
    title: "Twinkle Tray Settings",
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      devTools: settings.isDev,
      nodeIntegration: false,
      contextIsolation: true,
      // Preload needs Node (decodes launch args); contextIsolation keeps the
      // renderer itself isolated and Node-free.
      sandbox: false,
      zoomFactor: 1.0,
      additionalArguments: ["jsVars" + Buffer.from(JSON.stringify({
        appName: app.name,
        appVersion: appVersion,
        appVersionTag: appVersionTag,
        appBuild: appBuildShort,
        settings,
        lastTheme,
        settingsPath
      })).toString('base64')]
    }
  });

  settingsWindow.loadURL(
    isDev
      ? "http://localhost:3000/settings.html"
      : `file://${path.join(__dirname, "../build/settings.html")}`
  );

  settingsWindow.on("closed", () => (settingsWindow = null));

  settingsWindow.on("move", sendSettingsBounds)
  settingsWindow.on("resize", sendSettingsBounds)
  settingsWindow.on("maximize", sendSettingsBounds)
  settingsWindow.on("unmaximize", sendSettingsBounds)
  settingsWindow.on("restore", sendSettingsBounds)

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.setMenu(windowMenu)

    // Show after a very short delay to avoid visual bugs
    setTimeout(() => {
      sendMicaWallpaper()
      settingsWindow.show()
    }, 100)

    // Prevent links from opening in Electron
    applyNavigationGuards(settingsWindow)
  })

  // Sort Time of Day Adjustments
  // We're doing it here as it's least obtrusive to the UI. Refreshing when re-opening the window.
  if (settings.adjustmentTimes?.length) {
    settings.adjustmentTimes.sort((a, b) => {
      const aVal = Utils.parseTime(a.time)
      const bVal = Utils.parseTime(b.time)
      return aVal - bVal
    })
  }

}

function sendSettingsBounds() {
  const newBounds = settingsWindow.getBounds()
  settingsWindow.webContents.send("settingsWindowMove", [newBounds.x, newBounds.y])
}

ipcMain.on("sendSettingsWindowPos", sendSettingsBounds)
ipcMain.on("windowMinimize", e => {
  BrowserWindow.fromWebContents(e.sender).minimize()
})

ipcMain.on("windowToggleMaximize", e => {
  const window = BrowserWindow.fromWebContents(e.sender);
  if(window.isMaximized()) {
    window.unmaximize()
  } else {
    window.maximize()
  }
})

ipcMain.on("windowClose", e => {
  BrowserWindow.fromWebContents(e.sender).close()
})

//
//
//    App Updates
//
//



// updates slice (store-owned): latestVersion is the newest release found (or
// false), broadcast to renderers as 'latest-version'; lastCheck is the
// day-of-month of the last automatic check (throttles auto-checks to once/day).
// Both reassigned through the store; latestVersion's flags (show/downloading/
// error) are mutated in place on the slice's object.
store.update("updates", { latestVersion: false, lastCheck: false })

function broadcastLatestVersion() {
  sendToAllWindows('latest-version', store.get("updates").latestVersion)
}

const checkForUpdates = async (force = false) => {
  if (!force) {
    if (!settings.checkForUpdates) return false;
    const lastCheck = store.get("updates").lastCheck
    if (lastCheck && lastCheck == new Date().getDate()) return false;
  }
  if (isPortable || isAppX) return false;
  // lastCheck stores the day-of-month of the last check, so an automatic
  // (non-forced) check runs at most once per calendar day.
  store.update("updates", { lastCheck: new Date().getDate() })
  try {
    logger.debug("Checking for updates...")
    const response = await fetch("https://api.github.com/repos/xanderfrangos/twinkle-tray/releases")
    const releases = await response.json()
    const found = UpdateCheck.pickLatestRelease(releases, { branch: settings.branch, currentVersion: app.getVersion() })

    if (found) {
      store.update("updates", { latestVersion: found })
      const latestVersion = found
      logger.debug("Found version: " + latestVersion.version)
      if ("v" + appVersion != latestVersion.version && (settings.dismissedUpdate != latestVersion.version || force)) {
        if (!force) latestVersion.show = true
        logger.debug("Sending new version to windows.")
        broadcastLatestVersion()
      }
    }
  } catch (e) {
    logger.debug(e)
  }
}


const getLatestUpdate = async (version) => {
  const latestVersion = store.get("updates").latestVersion
  try {
    logger.debug("Downloading update from: " + version.downloadURL)
    const fs = require('fs');

    latestVersion.downloading = true
    broadcastLatestVersion()

    // Remove old update
    if (fs.existsSync(updatePath)) {
      try {
        fs.unlinkSync(updatePath)
      } catch (e) {
        logger.debug("Couldn't delete old update file")
      }
    }

    const update = await fetch(version.downloadURL)
    await new Promise((resolve, reject) => {
      logger.debug("Downloading...!")
      const readableNodeStream = Readable.fromWeb(update.body)
      const dest = fs.createWriteStream(updatePath)
      //update.body.pipe(dest);
      readableNodeStream.on('error', (err) => {
        reject(err)
      })

      dest.on('close', () => {
        setTimeout(() => {
          runUpdate(version.filesize)
        }, 1250)
        resolve(true)
      })
      readableNodeStream.on('finish', function () {
        logger.debug("Saved! Running...")
      });

      let size = 0
      let lastSizeUpdate = 0
      readableNodeStream.on('data', (chunk) => {
        size += chunk.length
        // Close the file once we've written the expected number of bytes;
        // the 'close' handler above then launches the installer.
        dest.write(chunk, (err) => {
          if (size >= version.filesize) {
            dest.close()
          }
        })
        if (size >= lastSizeUpdate + (version.filesize * 0.01) || lastSizeUpdate === 0 || size === version.filesize) {
          lastSizeUpdate = size
          sendToAllWindows('updateProgress', Math.floor((size / version.filesize) * 100))
          logger.debug(`Downloaded ${size / 1000}KB. [${Math.floor((size / version.filesize) * 100)}%]`)
        }
      })

    })

  } catch (e) {
    logger.debug("Couldn't download update!", e)
    latestVersion.show = true
    latestVersion.downloading = false
    broadcastLatestVersion()
  }
}

function runUpdate(expectedSize = false) {
  try {

    if (!fs.existsSync(updatePath)) {
      throw ("Update file doesn't exist!")
    }
    logger.debug("Expected size: " + expectedSize)
    const fileSize = fs.statSync(updatePath).size
    if (expectedSize && fileSize != expectedSize) {
      try {
        // Wrong file size, will try to delete
        fs.unlinkSync(updatePath)
      } catch (e) {
        throw ("Couldn't delete update file. " + e)
      }
      logger.debug("Attempted to delete update file")
      throw (`Update is wrong file size! Expected: ${expectedSize}. Got: ${fileSize}`)
    }

    const { spawn } = require('child_process');
    let process = spawn(updatePath, {
      detached: true,
      stdio: 'ignore'
    });

    // IDK, try again?
    process.once("error", () => {
      setTimeout(() => {
        process = spawn(updatePath, {
          detached: true,
          stdio: 'ignore'
        });
      }, 1000)
    })

    process.unref()
    app.quit()
  } catch (e) {
    logger.debug(e)
    const latestVersion = store.get("updates").latestVersion
    latestVersion.show = true
    latestVersion.error = true
    broadcastLatestVersion()
  }

}

ipcMain.on('check-for-updates', () => {
  store.get("updates").latestVersion.error = false
  broadcastLatestVersion()
  checkForUpdates(true)
})

ipcMain.on('ignore-update', (event, dismissedUpdate) => {
  writeSettings({ dismissedUpdate })
  store.get("updates").latestVersion.show = false
  broadcastLatestVersion()
})

ipcMain.on('clear-update', (event, dismissedUpdate) => {
  store.get("updates").latestVersion.show = false
  broadcastLatestVersion()
})



//
//
//    System event listeners
//
//

let backgroundInterval = null
function addEventListeners() {
  systemPreferences.on('accent-color-changed', () => { if(!settings.disableThemeChanges) handleAccentChange(); })
  systemPreferences.on('color-changed', () => { if(!settings.disableThemeChanges) handleAccentChange(); })
  nativeTheme.on('updated', () => { if(!settings.disableThemeChanges) handleAccentChange(); })

  addDisplayChangeListener(() => { if(settings.useWin32Event) handleMonitorChange("win32") })
  screen.addListener("display-added", () => { if(settings.useElectronEvents) handleMonitorChange("display-added") })
  screen.addListener("display-removed", () => { if(settings.useElectronEvents) handleMonitorChange("display-removed") })
  screen.addListener("display-metrics-changed", () => { if(settings.useElectronEvents) handleMetricsChange("display-metrics-changed") })

  enableMouseEvents()

  // Disable mouse events at startup
  pauseMouseEvents(true)
}

let handleAccentChangeTimeout = false
function handleAccentChange() {
  if (handleAccentChangeTimeout) clearTimeout(handleAccentChangeTimeout);
  handleAccentChangeTimeout = setTimeout(async () => {
    logger.debug("Event: handleAccentChange");
    sendToAllWindows('update-colors', getAccentColors())
    await getThemeRegistry()
    setTimeout(sendMicaWallpaper, 100)
    try {
      tray.setImage(getTrayIconPath())
    } catch (e) {
      debug.log("Couldn't update tray icon!", e)
    }
    handleAccentChangeTimeout = false
  }, 2000)
}

let skipFirstMonChange = false
let isStartupGracePeriod = false
let handleChangeTimeout0
let handleChangeTimeout1
let handleChangeTimeout2
function handleMonitorChange(t, e, d) {
  logger.debug(`Event: handleMonitorChange (${t})`);

  // Skip event that happens at startup
  if (!skipFirstMonChange) {
    skipFirstMonChange = true
    return false
  }

  logger.debug("Hardware change detected.")

  const block = blockBadDisplays("handleMonitorChange")

  // Defer actions for a moment just in case of repeat events
  if (handleChangeTimeout2) {
    clearTimeout(handleChangeTimeout2)
  }
  handleChangeTimeout2 = setTimeout(async () => {
    if(settings.recreateTray) recreateTray();

    // Reset all known displays
    await refreshMonitors(true)

    // During startup grace period, use current monitor brightness instead of saved profile
    // This prevents overwriting brightness that was manually set before shutdown
    if (!settings.disableAutoApply) {
      if (isStartupGracePeriod) {
        setKnownBrightness(true); // useCurrentMonitors = true to preserve current brightness
      } else {
        setKnownBrightness();
      }
    }
    handleBackgroundUpdate(true) // Apply Time Of Day Adjustments

    if (settings.monitorFocusEnabled) {
      resetMonitorFocusState()
      startMonitorFocusTracking()
    }

    // If displays not shown, refresh mainWindow
    if(settings.reloadFlyout && !panelSize.visible) {
      restartPanel(false)
    }

    handleChangeTimeout2 = false
  }, parseInt(settings.hardwareRestoreSeconds || 5) * 1000)

  setTimeout(() => {
    block.release()
  }, parseInt(settings.hardwareRestoreSeconds || 5) * 1000)

}

// power slice (store-owned): recentlyWokeUp gates brightness ops for a short
// window after resume/suspend/lock so we don't trip the WMI auto-disabler or
// fight the display while it is still coming back. Read across refresh,
// transitions and the power events; reassigned through the store.
store.update("power", { recentlyWokeUp: false })

// Handle resume from sleep/hibernation
powerMonitor.on("resume", () => {
  logger.debug("Resuming......")
  stopMonitorThread()
  const block = blockBadDisplays("powerMonitor:resume")
  setRecentlyInteracted(false)
  store.update("power", { recentlyWokeUp: true })
  setTimeout(() => { store.update("power", { recentlyWokeUp: false }) }, 15000)

  if(settings.restartOnWake) {
  // Screw it, just restart the whole app.
    tray.destroy()
    app.relaunch()
    app.exit()
  }

  setTimeout(
    () => {
      startMonitorThread()
      setTimeout(
        () => {
          block.release()

          // Always apply schedule on wake regardless of disableAutoRefresh
          applyCurrentAdjustmentEvent(true, false)

          if (!settings.disableAutoRefresh) refreshMonitors(true).then(() => {
            if (!settings.disableAutoApply && !hasRecentlyInteracted) setKnownBrightness();
            if(settings.recreateTray) recreateTray();
            if(settings.recreateFlyout && !panelSize.visible) restartPanel();

            // Re-apply after refresh in case monitors weren't enumerated at first apply
            applyCurrentAdjustmentEvent(true, false)
          })
        },
        parseInt(settings.wakeRestoreSeconds || 8) * 1000 // Give Windows a few seconds to... you know... wake up.
      )
  }, 100)
})

function handleMetricsChange(type) {
  logger.debug(`Event: handleMetricsChange (${type})`);

  const block = blockBadDisplays("handleMetricsChange")

  // Defer actions for a moment just in case of repeat events
  if (handleChangeTimeout1) {
    clearTimeout(handleChangeTimeout1)
  }
  handleChangeTimeout1 = setTimeout(async () => {

    // if handleMonitorChange is going to run, we don't need to do anything
    if(handleChangeTimeout2) return false;

    // Do a quick check to ensure handles are all good
    await refreshMonitors(true)

    // During startup grace period, use current monitor brightness instead of saved profile
    // This prevents overwriting brightness that was manually set before shutdown
    if (!settings.disableAutoApply && !hasRecentlyInteracted) {
      if (isStartupGracePeriod) {
        setKnownBrightness(true); // useCurrentMonitors = true to preserve current brightness
      } else {
        setKnownBrightness();
      }
    }
    handleBackgroundUpdate(true) // Apply Time Of Day Adjustments

    handleChangeTimeout1 = false
  }, parseInt(settings.idleRestoreSeconds || 7) * 1000)

  setTimeout(() => {
    block.release()
  }, parseInt(settings.idleRestoreSeconds || 3) * 1000)
}


powerMonitor.on("suspend", () => { logger.debug("Event: suspend"); store.update("power", { recentlyWokeUp: true }); stopMonitorThread() })
powerMonitor.on("lock-screen", () => {
  logger.debug("Event: lock-screen");
  if (settings.disableOnLockScreen) store.update("power", { recentlyWokeUp: true })
})
powerMonitor.on("unlock-screen", () => {
  logger.debug("Event: unlock-screen");
  if (store.get("power").recentlyWokeUp) {
    if (!settings.disableAutoRefresh) handleMetricsChange("unlock-screen");
    setTimeout(() => {
      store.update("power", { recentlyWokeUp: false })
    },
      15000
    )
  }
})
// recentlyWokeUp tracking and schedule updates on resume are handled by the main resume handler above


let restartBackgroundUpdateThrottle = false
function restartBackgroundUpdate() {
  if (!restartBackgroundUpdateThrottle) {
    restartBackgroundUpdateThrottle = setTimeout(() => {
      restartBackgroundUpdateThrottle = false
      clearInterval(backgroundInterval)
      backgroundInterval = setInterval(() => handleBackgroundUpdate(), isDev ? 8000 : (settings.backgroundUpdateInterval ?? 60) * 1000)
      handleBackgroundUpdate()
    }, 3000)
  } else {
    clearTimeout(restartBackgroundUpdateThrottle)
    restartBackgroundUpdateThrottle = false
    restartBackgroundUpdate()
  }
}


// Idle detection
// idle slice (store-owned): idle-detection flags/timer, all reassigned values
// read and written through the store. isUserIdle is Twinkle Tray's own idle
// definition; isWindowsUserIdle mirrors the OS idle state.
store.update("idle", { isUserIdle: false, userIdleDimmed: false, isWindowsUserIdle: false, lastIdleTime: 0 })
let idleMonitorBlock

let idleMonitor = setInterval(idleCheckLong, 5000)
let notIdleMonitor
// lastIdleTime now lives in the "idle" store slice (seeded above)

function getIdleSettingValue() {
  const detectIdleTime = (parseInt(settings.detectIdleTimeSeconds) + (settings.detectIdleTimeMinutes * 60))
  return detectIdleTime
}

function idleCheckLong() {
  if (tempSettings.pauseIdleDetection) return false;
  const idleTime = powerMonitor.getSystemIdleTime()
  store.update("idle", { lastIdleTime: idleTime })
  if (idleTime >= (settings.detectIdleTimeEnabled ? getIdleSettingValue() : 180) && !notIdleMonitor) {
    startIdleCheckShort()
  }
}

async function startIdleCheckShort() {
  store.update("idle", { isUserIdle: true })
  await updateKnownDisplays(true, true)
  logger.debug(`\x1b[36mStarted short idle monitor.\x1b[0m`)
  if (notIdleMonitor) clearInterval(notIdleMonitor);
  notIdleMonitor = setInterval(idleCheckShort, 1000)
}

function isFocusedWindowFullscreen() {
  try {
    if(!settings.detectIdleCheckFullscreen) return false;
    const focusedHwnd = WindowUtils.getForegroundWindow()
    const isFullscreen = WindowUtils.getWindowFullscreen(focusedHwnd)
    return isFullscreen
  } catch(e) {
    logger.debug(e)
    return false
  }
}

function isMediaPlaying() {
  try {
    if(!settings.detectIdleMedia) return false;
    const mediaPlaying = MediaStatus.getPlaybackStatus()
    return (mediaPlaying === "playing" ? true : false)
  } catch(e) {
    logger.debug(e)
    return false
  }
}

function idleCheckShort() {
  try {
    const idleTime = powerMonitor.getSystemIdleTime()

    if (!store.get("idle").userIdleDimmed && settings.detectIdleTimeEnabled && !settings.disableAutoApply && idleTime >= getIdleSettingValue() && !isFocusedWindowFullscreen() && !isMediaPlaying()) {
      logger.debug(`\x1b[36mUser idle. Dimming displays.\x1b[0m`)
      store.update("idle", { userIdleDimmed: true })
      idleMonitorBlock?.release?.()
      idleMonitorBlock = blockBadDisplays("idle:start")
      try {
        const idleBrightness = settings.detectIdleBrightness ?? 0
        const idleSoftwareDim = settings.detectIdleSoftwareDim ?? 0
        const transitionMonitors = {}
        Object.values(monitors)?.forEach((monitor) => {
          if(!shouldSkipDisplay(monitor, true)) {
            if(settings.idleTransitionSpeed) {
              transitionMonitors[monitor.id] = idleBrightness
            } else {
              updateBrightness(monitor.id, idleBrightness, true, "brightness")
            }
          }
        })
        if(Object.keys(transitionMonitors).length) {
          transitionBrightness(idleBrightness, transitionMonitors, settings.idleTransitionSpeed)
        }
        if (idleSoftwareDim > 0) {
          Object.values(monitors).forEach((monitor) => {
            if (!shouldSkipDisplay(monitor, true)) {
              updateSoftwareDim(monitor.id, idleSoftwareDim)
            }
          })
        }
      } catch (e) {
        logger.debug(`Error dimming displays`, e)
      }
    }

    const lastIdleTime = store.get("idle").lastIdleTime
    if (store.get("idle").isUserIdle && (idleTime < lastIdleTime || idleTime < getIdleSettingValue())) {
      // Wake up
      logger.debug(`\x1b[36mUser no longer idle after ${lastIdleTime} seconds.\x1b[0m`)
      clearInterval(notIdleMonitor)
      notIdleMonitor = false

      // Clear idle software dim
      if (settings.detectIdleSoftwareDim > 0) {
        Object.values(monitors).forEach((monitor) => updateSoftwareDim(monitor.id, 0))
      }

      // Different behavior depending on if idle dimming is on
      if (settings.detectIdleTimeEnabled) {
        // Always restore when dimmed
        const block = blockBadDisplays("idle:restore")
        setKnownBrightness(false)
        block.release()
      } else {
        // Not dimmed, try checking ToD first. sKB as backup.
        const foundEvent = applyCurrentAdjustmentEvent(true, true)
        if (!foundEvent && !settings.disableAutoApply) setKnownBrightness(false);
      }

      idleMonitorBlock?.release?.()

      // Wait a little longer, re-apply known brightness in case monitors take a moment, and finish up
      setTimeout(() => {
        store.update("idle", { isUserIdle: false, userIdleDimmed: false, lastIdleTime: 1 })

        const block = blockBadDisplays("idle:end")

        // Similar logic to above
        if (settings.detectIdleTimeEnabled) {
          // Always restore when dimmed, then check ToD
          setKnownBrightness(false)
          applyCurrentAdjustmentEvent(true, false)
        } else {
          // Not dimmed, try checking ToD first. sKB as backup.
          const foundEvent = applyCurrentAdjustmentEvent(true, true)
          if (!foundEvent && !settings.disableAutoApply) setKnownBrightness(false)
        }

        // Clear inactive dim state so all monitors get a fresh timeout window after
        // returning from idle. Also clear any software dim overlays that were active
        // from inactive dimming before idle kicked in.
        if (settings.monitorFocusEnabled) {
          for (const monitorId of monitorFocusDimmed) {
            updateSoftwareDim(monitorId, 0)
          }
          clearMonitorFocusMaps()
          monitorFocusDimmed.clear()
        }

        block.release()

      }, parseInt(settings.idleRestoreSeconds || 4) * 1000)

    }
    store.update("idle", { lastIdleTime: idleTime })
  } catch (e) {
    logger.debug('Error in idleCheckShort', e)
  }
}


// Per-monitor inactive dimming
let monitorFocusInterval = null
// focus slice (store-owned): monitor-focus (inactive-dim) state. All three are
// stable references aliased below and mutated in place — the Set via .clear(),
// the maps via per-key writes/deletes (cleared by deleting keys, not reassigning,
// so the aliases stay valid).
store.update("focus", { monitorFocusDimmed: new Set(), monitorLastVisited: {}, monitorPreDimBrightness: {} })
const monitorFocusDimmed = store.get("focus").monitorFocusDimmed
const monitorLastVisited = store.get("focus").monitorLastVisited
const monitorPreDimBrightness = store.get("focus").monitorPreDimBrightness

function clearMonitorFocusMaps() {
  for (const k in monitorLastVisited) delete monitorLastVisited[k]
  for (const k in monitorPreDimBrightness) delete monitorPreDimBrightness[k]
}
let electronToMonitorMap = {}
let cachedElectronDisplays = null

function invalidateDisplayCache() {
  cachedElectronDisplays = null
  if (settings.monitorFocusEnabled) buildElectronMonitorMap()
}

// Priority brightness system:
// Windows asleep > Idle dim > Inactive monitor dim > Schedule > Manual
// scheduledBrightness tracks what the schedule intends for each monitor,
// including monitors that are currently inactive-dimmed, so restoration
// always reflects the current schedule rather than a stale saved value.
// schedule slice (store-owned). scheduledBrightness is a stable map reference
// mutated in place; lastTimeEvent (seeded further below) is a reassigned value
// read and written through the store.
store.update("schedule", { scheduledBrightness: {} })
const scheduledBrightness = store.get("schedule").scheduledBrightness // { [monitorId]: { brightness, softwareDim } }

function buildElectronMonitorMap() {
  const displays = (cachedElectronDisplays || (cachedElectronDisplays = screen.getAllDisplays()))
  electronToMonitorMap = MonitorFocus.buildMonitorMap(displays, Object.values(monitors || {}))
  logger.debug(`\x1b[36mBuilt monitor focus map: ${JSON.stringify(electronToMonitorMap)}\x1b[0m`)
}

function getActiveMonitorFromPoint(x, y) {
  const displays = cachedElectronDisplays || (cachedElectronDisplays = screen.getAllDisplays())
  const monitorId = MonitorFocus.monitorIdAtPoint(displays, electronToMonitorMap, x, y)
  if (!monitorId) return null
  return Object.values(monitors).find(m => m.id === monitorId) || null
}

function getActiveMonitorFromCursor() {
  const cursorPoint = screen.getCursorScreenPoint()
  return getActiveMonitorFromPoint(cursorPoint.x, cursorPoint.y)
}

let monitorFocusTransition = null
function stopMonitorFocusTransition() {
  if (monitorFocusTransition) {
    clearInterval(monitorFocusTransition)
    monitorFocusTransition = null
  }
}


function applyMonitorFocusTransition(monitor, targetBrightness, targetSoftwareDim = 0) {
  stopMonitorFocusTransition()

  const TICK_MS = 16
  const DDC_THROTTLE_MS = 50
  const durationMs = Math.max(100, settings.monitorFocusTransitionDuration ?? 1000)
  const startBrightness = monitor.brightness
  const startSoftwareDim = softwareDimLevels[monitor.id] || 0
  const startTime = Date.now()
  let lastSentBrightness = startBrightness
  let lastSentSoftwareDim = startSoftwareDim
  let lastDDCWrite = 0

  monitorFocusTransition = setInterval(() => {
    const elapsed = Date.now() - startTime
    const now = startTime + elapsed
    const progress = Math.min(1, elapsed / durationMs)
    const { brightness: currentBrightness, softwareDim: currentSoftwareDim } = MonitorFocus.computeTransitionStep({
      startBrightness, targetBrightness, startSoftwareDim, targetSoftwareDim, progress
    })
    let uiUpdated = false

    if (currentBrightness !== lastSentBrightness && now - lastDDCWrite >= DDC_THROTTLE_MS) {
      updateBrightness(monitor.id, currentBrightness, true, "brightness", false)
      lastSentBrightness = currentBrightness
      lastDDCWrite = now
      uiUpdated = true
    }

    if (startSoftwareDim !== targetSoftwareDim) {
      updateSoftwareDim(monitor.id, progress >= 1 ? targetSoftwareDim : currentSoftwareDim)
      lastSentSoftwareDim = currentSoftwareDim
      uiUpdated = true
    }

    if (progress >= 1) {
      if (lastSentBrightness !== targetBrightness) {
        updateBrightness(monitor.id, targetBrightness, true, "brightness", false)
      }
      updateSoftwareDim(monitor.id, targetSoftwareDim)
      stopMonitorFocusTransition()
      uiUpdated = true
    }

    if (uiUpdated) touchMonitors()
  }, TICK_MS)
}

function restoreMonitorFocusBrightness(monitor) {
  if (!monitor || !monitorFocusDimmed.has(monitor.id)) return false

  // Prefer the schedule's current intended value so we land on the right brightness
  // even if the schedule changed while this monitor was inactive-dimmed.
  // Fall back to the brightness saved just before dimming started.
  const scheduleActive = settings.adjustmentTimesActive && !tempSettings.pauseTimeAdjustments
  const { brightness: targetBrightness, softwareDim: targetSoftwareDim } = MonitorFocus.getRestoreTarget({
    scheduleActive,
    scheduledBrightness: scheduledBrightness[monitor.id],
    preDimBrightness: monitorPreDimBrightness[monitor.id]
  })

  stopMonitorFocusTransition()
  if (targetBrightness !== undefined) {
    updateBrightness(monitor.id, targetBrightness, true, "brightness")
    logger.debug(`\x1b[36mRestored monitor focus brightness for ${monitor.id}\x1b[0m`)
  }
  updateSoftwareDim(monitor.id, targetSoftwareDim)
  monitorFocusDimmed.delete(monitor.id)
  delete monitor.inactiveDimmed
  delete monitorPreDimBrightness[monitor.id]
  touchMonitors()
  return true
}

let lastMonitorFocusMove = 0
function handleMonitorFocusMouseMove(x, y) {
  if (!settings.monitorFocusEnabled || !monitors || store.get("idle").userIdleDimmed || store.get("idle").isWindowsUserIdle) return
  if (tempSettings.pauseIdleDetection) return

  const now = Date.now()

  // Skip lookup entirely if debounce hasn't expired and no monitors need restoring
  if (monitorFocusDimmed.size === 0 && now - lastMonitorFocusMove < 250) return

  const activeMonitor = getActiveMonitorFromPoint(x, y)
  if (!activeMonitor) return

  if (monitorFocusDimmed.has(activeMonitor.id)) {
    restoreMonitorFocusBrightness(activeMonitor)
    monitorLastVisited[activeMonitor.id] = now
    return
  }

  if (now - lastMonitorFocusMove < 250) return
  lastMonitorFocusMove = now
  monitorLastVisited[activeMonitor.id] = now
}

function checkMonitorFocus() {
  if (!monitors || store.get("idle").userIdleDimmed || store.get("idle").isWindowsUserIdle) return
  if (tempSettings.pauseIdleDetection) return

  const activeMonitor = getActiveMonitorFromCursor()
  const now = Date.now()
  const timeout = MonitorFocus.computeTimeoutMs(settings.monitorFocusSeconds, settings.monitorFocusMinutes)

  if (activeMonitor) {
    monitorLastVisited[activeMonitor.id] = now
    restoreMonitorFocusBrightness(activeMonitor)
  }

  for (const monitor of Object.values(monitors)) {
    if (!monitor.id || shouldSkipDisplay(monitor, true)) continue
    if (monitorFocusDimmed.has(monitor.id)) continue
    if (activeMonitor && monitor.id === activeMonitor.id) continue

    const lastVisited = monitorLastVisited[monitor.id] || 0
    if (now - lastVisited < timeout) continue

    const dimLevel = settings.monitorFocusDimLevel ?? 0
    const softwareDimTarget = settings.monitorFocusSoftwareDim ?? 0
    const currentSoftwareDim = softwareDimLevels[monitor.id] || 0
    if (!MonitorFocus.shouldDimMonitor({ now, lastVisited, timeout, brightness: monitor.brightness, dimLevel, currentSoftwareDim, softwareDimTarget })) {
      // Already at or below the dim target — applying it would raise brightness.
      logger.debug(`\x1b[36mSkipping inactive dim for ${monitor.id} — already at or below dim target\x1b[0m`)
      continue
    }
    monitorPreDimBrightness[monitor.id] = monitor.brightness
    monitorFocusDimmed.add(monitor.id)
    monitor.inactiveDimmed = true
    applyMonitorFocusTransition(monitor, dimLevel, softwareDimTarget)
    logger.debug(`\x1b[36mDimming inactive monitor ${monitor.id}\x1b[0m`)
  }
}

function startMonitorFocusTracking() {
  stopMonitorFocusTracking()
  const now = Date.now()
  for (const monitor of Object.values(monitors || {})) {
    if (!monitorLastVisited[monitor.id]) {
      monitorLastVisited[monitor.id] = now
    }
  }
  buildElectronMonitorMap()
  enableMouseEvents()
  pauseMouseEvents(false)
  monitorFocusInterval = setInterval(checkMonitorFocus, 2000)
  logger.debug(`\x1b[36mStarted monitor focus tracking.\x1b[0m`)
}

function stopMonitorFocusTracking() {
  stopMonitorFocusTransition()
  if (monitorFocusInterval) {
    clearInterval(monitorFocusInterval)
    monitorFocusInterval = null
  }
}

function resetMonitorFocusState() {
  stopMonitorFocusTransition()
  for (const monitorId of monitorFocusDimmed) {
    const monitor = Object.values(monitors || {}).find(m => m.id === monitorId)
    const savedLevel = monitorPreDimBrightness[monitorId]
    if (monitor) {
      if (savedLevel !== undefined) updateBrightness(monitorId, savedLevel, true, "brightness")
      delete monitor.inactiveDimmed
    }
    updateSoftwareDim(monitorId, 0)
  }
  clearMonitorFocusMaps()
  monitorFocusDimmed.clear()
  electronToMonitorMap = {}
}


// Get the currently applicable Time of Day Adjustment.
// Pure logic lives in ./adjustmentTimes.js; this wrapper supplies the live settings,
// the current minute-of-day, and the sun-relative time resolver.
function getCurrentAdjustmentEvent() {
  return AdjustmentTimes.getCurrentAdjustmentEvent(settings.adjustmentTimes, AdjustmentTimes.toNowValue(), getSunCalcTime)
}

function getCurrentAdjustmentEventLERP() {
  return AdjustmentTimes.getCurrentAdjustmentEventLERP(settings.adjustmentTimes, AdjustmentTimes.toNowValue(), settings.adjustmentTimeIndividualDisplays, getSunCalcTime)
}

function getSunCalcTime(timeName = "solarNoon") {
  const localTimes = SunCalc.getTimes(new Date(), settings.adjustmentTimeLatitude, settings.adjustmentTimeLongitude)
  const time = new Date(localTimes[timeName])
  return `${time.getHours()}:${time.getMinutes().toString().padStart(2, '0')}`
}

// If applicable, apply the current Time of Day Adjustment
function applyCurrentAdjustmentEvent(force = false, instant = true) {
  try {
    if (tempSettings.pauseTimeAdjustments || !settings.adjustmentTimesActive || store.get("profile").currentProfile?.setBrightness) return false;
    if (settings.adjustmentTimes.length === 0 || store.get("idle").userIdleDimmed) return false;

    const date = new Date()

    // Local snapshot of the store-owned schedule state; writes go back through
    // the store so it stays the source of truth.
    let lastTimeEvent = store.get("schedule").lastTimeEvent

    // Reset on new day
    if (force || settings.adjustmentTimeAnimate || (lastTimeEvent && lastTimeEvent.day != date.getDate())) {
      logger.debug("New day (or forced)... resetting lastTimeEvent")
      lastTimeEvent = false
      store.update("schedule", { lastTimeEvent: false })
    }

    // Find most recent event
    const foundEvent = getCurrentAdjustmentEvent()
    if (foundEvent) {
      // Use !== (not <) so transitions that decrease in value (e.g. crossing
      // midnight from a 22:00 event to a 07:00 event) still apply.
      if (lastTimeEvent == false || lastTimeEvent.value !== foundEvent.value) {

        if (settings.adjustmentTimeAnimate) {
          // If LERPing, override foundEvent with interpolated value
          const lerp = getCurrentAdjustmentEventLERP()
          if (typeof lerp === "number") {
            foundEvent.brightness = lerp
          } else if (typeof lerp === "object") {
            foundEvent.monitors = lerp
          }
        }

        logger.debug("Adjusting brightness automatically", foundEvent)
        lastTimeEvent = Object.assign({}, foundEvent)
        lastTimeEvent.day = new Date().getDate()
        store.update("schedule", { lastTimeEvent })

        const applyFoundEvent = () => {
          const eventSoftwareDim = foundEvent.softwareDim ?? 0
          const eventMonitorsSoftwareDim = foundEvent.monitorsSoftwareDim ?? {}
          const eventKelvin = foundEvent.kelvin ?? 6500
          const eventMonitorsKelvin = foundEvent.monitorsKelvin ?? {}
          const eventHighlightWeight = foundEvent.highlightWeight ?? 0
          const eventMonitorsHighlightWeight = foundEvent.monitorsHighlightWeight ?? {}
          const eventMonitors = foundEvent.monitors ?? {}

          // Track schedule's intended brightness for every monitor, including inactive-dimmed ones,
          // so restoring an inactive-dimmed monitor always lands on the current schedule value.
          for (const monitor of Object.values(monitors)) {
            const brightness = (settings.adjustmentTimeIndividualDisplays && eventMonitors[monitor.id] >= 0)
              ? eventMonitors[monitor.id]
              : (foundEvent.brightness ?? 50)
            const softwareDim = (settings.adjustmentTimeIndividualDisplays && eventMonitorsSoftwareDim[monitor.id] >= 0)
              ? eventMonitorsSoftwareDim[monitor.id]
              : eventSoftwareDim
            scheduledBrightness[monitor.id] = { brightness, softwareDim }
          }

          // Skip monitors that are currently inactive-dimmed — they will pick up the new
          // schedule value when the user moves their cursor back to them.
          const onlyMonitorIds = monitorFocusDimmed.size > 0
            ? Object.values(monitors).map(m => m.id).filter(id => !monitorFocusDimmed.has(id))
            : null

          // When some monitors are being skipped (inactive-dimmed), always apply instantly
          // to avoid clearing the dim animation that's running on currentTransition.
          if (instant || settings.adjustmentTimeSpeed === "instant" || onlyMonitorIds) {
            transitionlessBrightness(foundEvent.brightness, eventMonitors, eventSoftwareDim, eventMonitorsSoftwareDim, eventKelvin, eventMonitorsKelvin, eventHighlightWeight, eventMonitorsHighlightWeight, onlyMonitorIds)
          } else {
            transitionBrightness(foundEvent.brightness, eventMonitors, 1, eventSoftwareDim, eventMonitorsSoftwareDim, eventKelvin, eventMonitorsKelvin, eventHighlightWeight, eventMonitorsHighlightWeight, onlyMonitorIds)
          }
        }

        // If monitors are already known, apply immediately (same as color effects).
        // Only fall back to a hardware refresh on first run when monitors aren't populated yet.
        if (Object.keys(monitors).length > 0) {
          applyFoundEvent()
        } else {
          refreshMonitors().then(applyFoundEvent)
        }
        setTrayStatus()
        return foundEvent
      }
    }
  } catch (e) {
    logger.debug("Error applying current Time of Day Adjustment", e)
  }

}


store.update("schedule", {
  lastTimeEvent: {
    hour: new Date().getHours(),
    minute: new Date().getMinutes(),
    day: new Date().getDate()
  }
})
function handleBackgroundUpdate(force = false) {
  logger.debug("Event: handleBackgroundUpdate");

  try {
    // Wallpaper updates
    sendMicaWallpaper()

    // Time of Day Adjustments
    if (settings.adjustmentTimesActive && settings.adjustmentTimes.length > 0 && !store.get("idle").userIdleDimmed) {
      applyCurrentAdjustmentEvent(force, false)
    }

    // Sync scheduled color from current time event (respects manual tray toggles)
    if (!store.get("idle").isWindowsUserIdle && settings.adjustmentTimesActive && (settings.adjustmentTimeTemperatureEnabled || settings.adjustmentTimeHighlightCompressionEnabled)) {
      applyCurrentDisplayColorEffects(false)
    }

    // Re-apply display color transforms (gamma ramps can be overwritten by the OS)
    if (!store.get("idle").isWindowsUserIdle && (store.get("color").manualTemperatureActive || store.get("color").manualHighlightActive || settings.adjustmentTimeTemperatureEnabled || settings.adjustmentTimeHighlightCompressionEnabled)) {
      showDisplayColorEffects()
    }
  } catch (e) {
    logger.error(e)
  }

  if (!force) checkForUpdates(); // Ignore when forced update, since it should just be about fixing brightness.

  // GC
  setTimeout(() => {
    try { global.gc() } catch (e) { }
  }, 1000)
}

let lastCoordCheck = { value: { lat: 0, long: 0}, ts: 0 }
async function getUserCoordinates() {
  if(Date.now() - 10000 < lastCoordCheck.ts) return lastCoordCheck.value;
  try {
    if (isAppX === false) {
      logger.debug("Getting geolocation...")
      const response = await fetch("https://geo.twinkletray.com/")
      if(response.status === 200) {
        const coordinates = {
          lat: response.headers.get("X-Geo-Lat"),
          long: response.headers.get("X-Geo-Long")
        }
        if(typeof coordinates.lat === "string" && typeof coordinates.long === "string") {
          logger.debug("Coordinates: ", coordinates)
          lastCoordCheck.value = coordinates
          lastCoordCheck.ts = Date.now()
          return coordinates
        }
        throw("Couldn't get coordinates. Returned: " + JSON.stringify(coordinates))
      }
    }
  } catch (e) {
    logger.debug(e)
  }
}

async function getAndApplyUserCoordinates() {
  try {
    const coordinates = await getUserCoordinates()
    writeSettings({adjustmentTimeLongitude: coordinates.long, adjustmentTimeLatitude: coordinates.lat}, true, true)
  } catch(e) {
    logger.debug(e)
  }
}

ipcMain.on('get-coordinates', getAndApplyUserCoordinates)

/*

Handle input from second process command line. One monitor argument and one brightness argument is required. Multiple arguments will override each other.
Full example: TwinkleTray.exe --MonitorNum=1 --Offset=-30

Supported args:

--MonitorNum
Select monitor by number. Starts at 1.
Example: --MonitorNum=2

--MonitorID
Select monitor by internal ID. Partial or whole matches accepted.
Example: --MonitorID="UID2353"

--All
Flag to update all monitors.
Example: --All

--Set
Set brightness percentage.
Example: --Set=95

--Offset
Adjust brightness percentage.
Example: --Offset=-20

--VCP
Send a specific DDC/CI VCP code and value instead of brightness. The first part is the VCP code (decimal or hexadecimal), and the second is the value.
Example: --VCP="0xD6:5"

--Overlay
Flag to show brightness levels in the overlay
Example: --Overlay

--Panel
Flag to show brightness levels in the panel
Example: --Panel

*/
function handleCommandLine(event, argv, directory, additionalData) {

  let display
  let type
  let brightness
  let usetime
  let ddcciVCP
  let commandLine = []

  try {
    // Extract flags
    additionalData.forEach((flag) => {
      if (flag.indexOf('--') == 0) {
        commandLine.push(flag.toLowerCase())
      }
    })

    if (commandLine.length > 0) {

      commandLine.forEach(arg => {

        // List all displays
        if (arg.indexOf("--list=") === 0) {

        }

        // Get display by index
        if (arg.indexOf("--monitornum=") === 0) {
          display = Object.values(monitors)[(arg.substring(13) * 1) - 1]
        }

        // Get display by ID (partial or whole)
        if (arg.indexOf("--monitorid=") === 0) {
          const monID = Object.keys(monitors).find(id => {
            return id.toLowerCase().indexOf(arg.substring(12)) >= 0
          })
          display = monitors[monID]
        }

        // Run on all displays
        if (arg.indexOf("--all") === 0 && arg.length === 5) {
          display = "all"
        }

        // Use absolute brightness
        if (arg.indexOf("--set=") === 0) {
          brightness = (arg.substring(6) * 1)
          type = "set"
        }

        // Use relative brightness
        if (arg.indexOf("--offset=") === 0) {
          brightness = (arg.substring(9) * 1)
          type = "offset"
        }

        // Use time adjustments
        if (arg.indexOf("--usetime") === 0) {
          usetime = true
        }

        // DDC/CI command
        if (arg.indexOf("--vcp=") === 0 && arg.indexOf(":")) {
          try {
            const values = arg.substring(6).replace('"').replace('"').split(":")
            ddcciVCP = {
              code: parseInt(values[0]),
              value: parseInt(values[1])
            }
          } catch (e) {
            logger.debug("Couldn't parse VCP code!")
          }

        }

        // Show overlay
        if (arg.indexOf("--overlay") === 0 && store.get("panel").panelState !== "visible") {
          hotkeyOverlayStart()
        }

        // Show panel
        if (arg.indexOf("--panel") === 0 && store.get("panel").panelState !== "visible") {
          toggleTray(true)
        }

      })

      // If value input, update brightness
      if (display && type && brightness !== undefined) {

        if (display === "all") {
          logger.debug(`Setting brightness via command line: All @ ${brightness}%`);
          updateAllBrightness(brightness, type)
        } else {
          const newBrightness = Utils.minMax(type === "set" ? brightness : display.brightness + brightness)
          logger.debug(`Setting brightness via command line: Display #${display.num} (${display.name}) @ ${newBrightness}%`);
          updateBrightnessThrottle(display.id, newBrightness, true)
        }

      }

      if (display && ddcciVCP) {
        if (display === "all") {
          Object.values(monitors).forEach(monitor => {
            monitorsThread.send({
              type: "vcp",
              code: ddcciVCP.code,
              value: ddcciVCP.value,
              monitor: monitor.hwid.join("#")
            })
          })
        } else {
          monitorsThread.send({
            type: "vcp",
            code: ddcciVCP.code,
            value: ddcciVCP.value,
            monitor: display.hwid.join("#")
          })
        }
      }

      if (usetime) {
        applyCurrentAdjustmentEvent(true, false)
      }

    }

  } catch (e) {
    logger.debug(e)
  }

}




// Mica features
// mica slice (store-owned): the wallpaper image + screen size broadcast to the
// panel renderer. currentWallpaper is the Mica'd image URL; currentWallpaperTime
// / currentWallpaperFileSize track the source wallpaper's mtime/size for change
// detection; currentScreenSize is the primary display work area + scale. All
// reassigned through the store. micaBusy (re-entrancy lock) and lastMicaTime
// (cache-bust stamp used only to build the wallpaper URL) stay local — mechanics.
store.update("mica", {
  currentWallpaper: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs%3D",
  currentWallpaperTime: false,
  currentWallpaperFileSize: 0,
  currentScreenSize: { width: 1280, height: 720, scale: 1 }
})
let micaBusy = false
let lastMicaTime = Date.now()
const homeDir = require("os").homedir()
const micaWallpaperPath = path.join(configFilesDir, `\\mica${(isDev ? "-dev" : "")}.jpg`)
const windowWallpaperPath = path.join(homeDir, "AppData", "Roaming", "Microsoft", "Windows", "Themes", "TranscodedWallpaper");

function broadcastMicaWallpaper() {
  const mica = store.get("mica")
  sendToAllWindows("mica-wallpaper", { path: mica.currentWallpaper, size: mica.currentScreenSize })
}

function checkMicaWallpaper() {
  if (micaBusy) {
    broadcastMicaWallpaper()
    return false
  }
  try {
    const file = fs.statSync(windowWallpaperPath)
    const newTime = file.mtime.getTime()
    const newSize = file.size

    const screenSize = screen.getPrimaryDisplay().workAreaSize
    screenSize.scale = screen.getPrimaryDisplay().scaleFactor
    store.update("mica", { currentScreenSize: screenSize })

    const mica = store.get("mica")
    if (file?.mtime && (newTime !== mica.currentWallpaperTime || newSize !== mica.currentWallpaperFileSize)) {
      micaBusy = true
      store.update("mica", { currentWallpaperTime: newTime, currentWallpaperFileSize: newSize })

      // Send off wallpaper to be Mica'd in "panel" renderer
      sendToAllWindows("mica-wallpaper-create", { path: "file://" + windowWallpaperPath + "?" + newTime, size: screenSize })
    }
    broadcastMicaWallpaper()

  } catch(e) {
    micaBusy = false
    broadcastMicaWallpaper()
  }
}

ipcMain.on('mica-wallpaper-data', (event, data) => {
  try {
    logger.debug("Created Mica wallpaper:", micaWallpaperPath)
    fs.writeFileSync(micaWallpaperPath, Buffer.from(data.split(',')[1], 'base64'))
    lastMicaTime = Date.now()
    store.update("mica", { currentWallpaper: "file://" + micaWallpaperPath + "?" + lastMicaTime })
    broadcastMicaWallpaper()
  } catch(e) {
    logger.debug(e)
  }
  micaBusy = false
})

ipcMain.on('mica-wallpaper-same', (event, data) => {
  broadcastMicaWallpaper()
})

async function sendMicaWallpaper() {
  if (!mainWindow) return false;
  checkMicaWallpaper()
}

ipcMain.on('get-mica-wallpaper', sendMicaWallpaper)





//
//
//  Server common
//
//


const handleClientMessage = async (message, remote) => {
  const type = (remote ? `UDP` : `PIPE`)

  try {
    if(remote) {
      logger.debug(`[${type}] Got: ${message} from ${remote.address}:${remote.port}`)
    } else {
      logger.debug(`[${type}] Got: ${message}`)
    }
    
    const data = JSON.parse(message)
    if (typeof data !== "object" || !data?.type) {
      throw(`[${type}] Invalid command`)
    }

    if (remote && data.key !== settings.udpKey) {
      throw("[UDP] Missing or invalid key")
    }

    const findMonitor = monitor => {
      try {
        const searchID = monitor.toLowerCase()
        const monID = Object.keys(monitors).find(id => {
          return id.toLowerCase().indexOf(searchID) >= 0
        })
        return monitors[monID]
      } catch (e) { return false }
    }

    const determineVCP = vcp => {
      switch (vcp) {
        case "brightness": return 0x10;
        case "contrast": return 0x12;
        case "power": return 0xD6;
        case "volume": return 0x62;
        default: return parseInt(vcp);
      }
    }


    // Run recieved command

    if (data.type === "list") {
      // data.type === "list"
      // List all current monitors
      return JSON.stringify(monitors)
    } else if (data.type === "get") {
      // data.type === "get"
      // Get property of specific monitor

      if (!(data.monitor && data.property)) throw("Missing parameter!");

      const monitor = findMonitor(data.monitor)
      if (!monitor) throw("Couldn't find monitor!")

      const getMonitorProperty = (monitor, property) => {
        try {
          const { features } = monitor
          switch (property) {
            case "brightness": return monitor.brightness;
            case "maxbrightness": return monitor.brightnessMax;
            case "rawbrightness": return monitor.brightnessRaw;
            case "brightnesstype": return monitor.brightnessType;
            case "id": return monitor.id;
            case "key": return monitor.key;
            case "name": return monitor.name;
            case "hwid": return monitor.hwid.join("#");
            case "name": return monitor.name;
            case "type": return monitor.type;
            case "connector": return monitor.connector;
            case "serial": return monitor.serial;
            case "order": return monitor.order;
            case "contrast": return (features.contrast ? features.contrast[0] : -1);
            case "maxcontrast": return (features.contrast ? features.contrast[1] : -1);
            case "powerstate": return (features.powerState ? features.powerState[0] : -1);
            case "maxpowerstate": return (features.powerState ? features.powerState[1] : -1);
            case "volume": return (features.volume ? features.volume[0] : -1);
            case "maxvolume": return (features.volume ? features.volume[1] : -1);
            default: throw("Invalid property!");
          }
        } catch (e) {
          throw(`[${type}]  Error getting monitor property`, e)
        }
      }

      if (data.property === "vcp") {
        return await getVCP(monitor, data.code)
      } else {
        return getMonitorProperty(monitor, data.property)
      }

    } else if (data.type === "set" || data.type === "setvcp") {
      // data.type === "set"
      // Set property of specific monitor

      if (!(data.monitor && data.vcp)) throw("Missing parameters!");

      const value = parseInt(data.value)

      if (data.monitor === "all") {
        updateAllBrightness(value, (data.mode ?? "set"))
        return true
      }

      const monitor = findMonitor(data.monitor)
      if (!monitor) throw("Couldn't find monitor!");

      if (data.vcp === "brightness") {
        const newBrightness = Utils.minMax(data.mode !== "offset" ? value : monitor.brightness + value)
        updateBrightnessThrottle(monitor.id, newBrightness, true)
      } else {
        monitorsThread.send({
          type: "vcp",
          code: determineVCP(data.vcp),
          value: value,
          monitor: monitor.hwid.join("#")
        })
      }

    } else if (data.type === "checktime") {
      // data.type === "checktime"
      // Use time adjustments
      applyCurrentAdjustmentEvent(true, false)
    } else if (data.type === "refresh") {
      // data.type === "refresh"
      // Force refresh monitors
      refreshMonitors(true, true)
    }

  } catch (e) {
    logger.debug(`[${type}] Error:`, e)
  }
}




//
//
//  UDP Server
//
//

const udp = {
  server: false,
  start: function (port = 14715) {
    if (udp.server) return false;

    logger.debug("[UDP] Starting local UDP Server...")
    const dgram = require('dgram')
    const server = dgram.createSocket('udp4')
    udp.server = server

    server.on('error', error => {
      logger.debug(`[UDP] UDP server error:\n${error.stack}`)
      server.close()
    });

    server.on('message', async (message, remote) => {
      const sendResponse = response => server.send(`${response}`, remote.port, remote.address)
      try {
        const response = await handleClientMessage(message, remote)
        sendResponse(response)
      } catch(e) {
        logger.debug(e)
      }
    });

    server.on('listening', () => {
      const connection = server.address();
      writeSettings({ udpPortActive: connection.port })
      logger.debug(`[UDP] UDP server listening at ${connection.address}:${connection.port}`);
    });

    // Bind to default port, or another if it fails
    const address = (!settings.udpRemote ? 'localhost' : undefined)
    try {
      server.bind({ address, port })
    } catch (e) {
      try {
        // Let's try another
        server.bind({ address, port: (port + 13137) })
      } catch (e2) {
        try {
          // Okay, one more?
          server.bind({ address, port: (port + 1603) })
        } catch (e3) {
          logger.debug(e3)
        }
      }
    }

  },
  stop: function () {
    try {
      if (udp.server) {
        logger.debug("[UDP] Stopping local UDP Server.")
        udp.server.close()
        udp.server = false
      }
    } catch (e) {
      logger.debug("[UDP] Couldn't close UDP server.")
    }
  }
}

//
//
//  Named Pipe Server
//
//

const pipe = {
  server: false,
  start: function () {
    if (pipe.server) return false;

    logger.debug("[PIPE] Starting named pipe...")

    const server = require('net').createServer(function(stream) {
      stream.on('data', async function(message) {

        logger.debug('server data:', message.toString());
        const sendResponse = response => stream.write(`${response}`)
        try {
          const response = await handleClientMessage(message)
          sendResponse(response)
        } catch(e) {
          logger.debug(e)
        }

      });
    });

    pipe.server = server

    server.on('error', error => {
      logger.debug(`[PIPE] Server error:\n${error.stack}`)
      server.close()
    });

    server.on('listening', () => {
      const connection = server.address();
      logger.debug(`[PIPE] Server listening at ${connection.toString()}`);
    });

    // Bind to default port, or another if it fails
    try {
      server.listen('\\\\.\\pipe\\twinkle-tray\\cmds');
    } catch (e) {
      logger.debug(e)
    }

  },
  stop: function () {
    try {
      if (pipe.server) pipe.server.close();
    } catch (e) {
      logger.debug("[PIPE] Couldn't close server.")
    }
  }
}

pipe.start()
