const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reactionApp', {
  getDeviceInfo: () => ipcRenderer.invoke('device:get-info'),
  loadResults: () => ipcRenderer.invoke('results:load'),
  saveResult: (result) => ipcRenderer.invoke('results:save', result),
});
