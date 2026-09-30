'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('事件处理器必须是函数。');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  getSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  refreshModels: () => ipcRenderer.invoke('desktop:refresh-models'),
  saveSettings: (settings) => ipcRenderer.invoke('desktop:save-settings', settings),
  getHistory: () => ipcRenderer.invoke('desktop:get-history'),
  saveHistory: (sessions) => ipcRenderer.invoke('desktop:save-history', sessions),
  exportHistory: (payload) => ipcRenderer.invoke('desktop:export-history', payload),
  onBeforeClose: (callback) => subscribe('desktop:before-close', callback),
  finishClose: () => ipcRenderer.invoke('desktop:finish-close'),
  chooseWorkspace: () => ipcRenderer.invoke('desktop:choose-workspace'),
  chat: (request) => ipcRenderer.invoke('desktop:chat', request),
  cancelChat: (requestId) => ipcRenderer.invoke('desktop:cancel-chat', requestId),
  onChatEvent: (callback) => subscribe('desktop:chat-event', callback),
  windowControl: (action) => ipcRenderer.invoke('desktop:window-control', action),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  setMode: (mode) => ipcRenderer.invoke('desktop:set-mode', mode),
  setHarnessBounds: (bounds) => ipcRenderer.invoke('desktop:set-harness-bounds', bounds),
  setHarnessVisible: (visible) => ipcRenderer.invoke('desktop:set-harness-visible', visible),
  connectHarness: () => ipcRenderer.invoke('desktop:connect-harness'),
  disconnectHarness: () => ipcRenderer.invoke('desktop:disconnect-harness'),
  onHarnessStatus: (callback) => subscribe('desktop:harness-status', callback),
  getHarnessUpdateStatus: () => ipcRenderer.invoke('desktop:harness-update-status'),
  checkHarnessUpdate: () => ipcRenderer.invoke('desktop:harness-check-update'),
  updateHarness: () => ipcRenderer.invoke('desktop:harness-update'),
  cancelHarnessUpdate: () => ipcRenderer.invoke('desktop:harness-cancel-update'),
  onHarnessUpdateStatus: (callback) => subscribe('desktop:harness-update-event', callback),
}));
