const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitAudit', {
  selectRepository: () => ipcRenderer.invoke('repo:select'),
  inspectRepository: (path) => ipcRenderer.invoke('repo:inspect', path),
  compare: (options) => ipcRenderer.invoke('repo:compare', options),
  getCommitDetails: (repoPath, hash) => ipcRenderer.invoke('repo:commit-details', repoPath, hash),
  startSync: (options) => ipcRenderer.invoke('repo:sync-start', options),
  finalizeSync: (operationId) => ipcRenderer.invoke('repo:sync-finalize', operationId),
  abortSync: (operationId) => ipcRenderer.invoke('repo:sync-abort', operationId),
  reviewCommit: (options) => ipcRenderer.invoke('ai:review-commit', options),
  listModels: (apiKey) => ipcRenderer.invoke('ai:list-models', apiKey),
  loadAiSettings: () => ipcRenderer.invoke('ai:load-settings'),
  saveAiSettings: (settings) => ipcRenderer.invoke('ai:save-settings', settings),
  clearSavedApiKey: () => ipcRenderer.invoke('ai:clear-key'),
  exportReport: (payload) => ipcRenderer.invoke('report:export', payload),
});
