// Thin Node bridge for the brightness panel window.
//
// Runs in the isolated world under contextIsolation. Exposes only the
// Node-privileged capabilities the renderer can't reach on its own (IPC,
// process priority, manual GC, launch args). All DOM/IPC/UI logic lives in
// renderer/panelBridge.js (main world) so window.* globals and CustomEvents
// keep working.
const { contextBridge, ipcRenderer } = require('electron')
const { setPriority } = require('os')
const { priority } = require('os').constants

// Start the panel process below normal priority; raised while the panel is visible.
setPriority(0, priority.PRIORITY_BELOW_NORMAL)

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
    jsVars: decodeJsVars(),
    // Raise/lower this process's priority around panel visibility (Node `os` only).
    setPriority: (level) => setPriority(0, level === 'above' ? priority.PRIORITY_ABOVE_NORMAL : priority.PRIORITY_BELOW_NORMAL),
    // Manual GC hint after the panel hides (the --expose_gc js-flag is set in main).
    gc: () => { try { global.gc?.() } catch (e) { /* gc unavailable */ } }
})
