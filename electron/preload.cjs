// Narrow bridge from the sandboxed renderer to the main process.
const { contextBridge, ipcRenderer } = require('electron');

const call = name => (...args) => ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld('api', {
  openProject: call('openProject'),
  saveProject: call('saveProject'),
  openImages: call('openImages'),
  pickExportPath: call('pickExportPath'),
  writeFile: call('writeFile'),
  videoStart: call('videoStart'),
  videoFrame: call('videoFrame'),
  videoEnd: call('videoEnd'),
  videoAbort: call('videoAbort'),
  setDirty: d => ipcRenderer.send('setDirty', d),
  toggleDevTools: () => ipcRenderer.send('toggleDevTools'),
});
