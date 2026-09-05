const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deck', {
  bootstrap: () => ipcRenderer.invoke('deck:bootstrap'),
  addAccount: payload => ipcRenderer.invoke('deck:add-account', payload),
  launchAccount: id => ipcRenderer.invoke('deck:launch-account', id),
  openStudio: id => ipcRenderer.invoke('deck:open-studio', id),
  refreshQuota: () => ipcRenderer.invoke('deck:refresh-quota'),
  prepareGeneration: payload => ipcRenderer.invoke('deck:prepare-generation', payload),
  submitGeneration: jobId => ipcRenderer.invoke('deck:submit-generation', jobId),
  saveGenerationResult: (jobId, index) => ipcRenderer.invoke('deck:save-generation-result', { jobId, index }),
  hideStudio: () => ipcRenderer.invoke('deck:hide-studio'),
  showStudio: () => ipcRenderer.invoke('deck:show-studio'),
  setStudioBounds: bounds => ipcRenderer.invoke('deck:set-studio-bounds', bounds),
  studioNav: action => ipcRenderer.invoke('deck:studio-nav', action),
  chooseAssets: () => ipcRenderer.invoke('deck:choose-assets'),
  updateSettings: patch => ipcRenderer.invoke('deck:update-settings', patch),
  chooseDirectory: () => ipcRenderer.invoke('deck:choose-directory'),
  openFolder: folderPath => ipcRenderer.invoke('deck:open-folder', folderPath),
  chooseVideo: () => ipcRenderer.invoke('deck:choose-video'),
  chooseOutput: sourcePath => ipcRenderer.invoke('deck:choose-output', sourcePath),
  processVideo: payload => ipcRenderer.invoke('deck:process-video', payload),
  previewAiCleanup: payload => ipcRenderer.invoke('deck:preview-ai-cleanup', payload),
  runAiCleanup: payload => ipcRenderer.invoke('deck:run-ai-cleanup', payload),
  onProcessProgress: callback => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('deck:process-progress', listener)
    return () => ipcRenderer.removeListener('deck:process-progress', listener)
  },
  onStudioState: callback => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('deck:studio-state', listener)
    return () => ipcRenderer.removeListener('deck:studio-state', listener)
  },
  onGenerationUpdate: callback => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('deck:generation-update', listener)
    return () => ipcRenderer.removeListener('deck:generation-update', listener)
  },
  onAiProgress: callback => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('deck:ai-progress', listener)
    return () => ipcRenderer.removeListener('deck:ai-progress', listener)
  }
})
