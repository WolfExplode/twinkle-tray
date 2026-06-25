// Thin Node bridge for the settings window.
//
// Runs in the isolated world under contextIsolation. Exposes only the audited
// IPC surface and the decoded launch args; all DOM/IPC/UI logic lives in
// renderer/settingsBridge.js (main world) so window.* globals and CustomEvents
// keep working.
const { contextBridge, ipcRenderer } = require('electron')

// Launch-time vars are passed as a base64 additionalArgument; process.argv is
// only readable here in the preload, so decode once and hand it to the page.
function decodeJsVars() {
    try {
        const raw = process.argv.find(arg => arg.indexOf("jsVars") === 0)
        return JSON.parse(Buffer.from(raw.substring(6), 'base64').toString())
    } catch (e) {
        return {}
    }
}

contextBridge.exposeInMainWorld('ipc', {
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
    // The real IpcRendererEvent isn't cloneable across contextBridge and
    // existing handlers ignore it, so pass null in its slot to preserve the
    // (event, ...args) argument positions.
    on: (channel, listener) => ipcRenderer.on(channel, (event, ...args) => listener(null, ...args))
})

contextBridge.exposeInMainWorld('ttBridge', {
    jsVars: decodeJsVars()
})
