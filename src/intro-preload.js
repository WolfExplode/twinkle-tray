// Thin Node bridge for the intro window.
//
// Runs in the isolated world under contextIsolation. Its only job is to hand
// the page a minimal, audited IPC surface via contextBridge. All DOM/event/UI
// logic now lives in the renderer (renderer/introBridge.js) because, with
// isolation on, the page cannot see anything we set on this preload's `window`.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ipc', {
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  // The page's callback receives (event, ...args). The real IpcRendererEvent
  // isn't cloneable across contextBridge, and existing handlers ignore it, so
  // pass null in its slot to preserve the (event, ...args) argument positions.
  on: (channel, listener) => ipcRenderer.on(channel, (event, ...args) => listener(null, ...args))
})
