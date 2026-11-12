// preload.cjs · 只暴露必要的 IPC 白名单，渲染层拿不到 Node
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  services: () => ipcRenderer.invoke('hub:services'),
  start: (id) => ipcRenderer.invoke('hub:start', id),
  stop: (id) => ipcRenderer.invoke('hub:stop', id),
  restart: (id) => ipcRenderer.invoke('hub:restart', id),

  pending: () => ipcRenderer.invoke('hub:pending'),
  answer: (key, text) => ipcRenderer.invoke('hub:answer', { key, text }),
  bridgeStatus: () => ipcRenderer.invoke('hub:bridgeStatus'),

  firstrun: () => ipcRenderer.invoke('hub:firstrun'),
  autostart: (v) => ipcRenderer.invoke('hub:autostart', v),
  logs: (filter) => ipcRenderer.invoke('hub:logs', filter),
  paths: () => ipcRenderer.invoke('hub:paths'),

  openPanel: () => ipcRenderer.invoke('hub:openPanel'),
  openExternal: (url) => ipcRenderer.invoke('hub:openExternal', url),
  reveal: (which) => ipcRenderer.invoke('hub:reveal', which),

  onServices: (cb) => ipcRenderer.on('hub:services', (_e, data) => cb(data)),
  onLog: (cb) => ipcRenderer.on('hub:log', (_e, data) => cb(data))
});
