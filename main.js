const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { app, BrowserWindow, WebContentsView, dialog, ipcMain, shell } = require('electron')
const { DeckStore } = require('./src/store')
const { detectBrowsers, launchAccount } = require('./src/browser-manager')
const { findMediaBinary, probeVideo, processDelogo } = require('./src/media')
const { getAiEngine, previewCleanup, runCleanup } = require('./src/ai-cleaner')
const { TERMINAL_STATUSES, prepareDolaGeneration, submitDolaGeneration, pollDolaGeneration } = require('./src/dola-adapter')

const fallbackRoot = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Roaming'), 'DeckData')
const dataRoot = process.env.DECK_DATA_DIR || (fs.existsSync('D:\\') ? 'D:\\DeckData' : fallbackRoot)
const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : __dirname
app.setPath('userData', path.join(dataRoot, 'app'))

let mainWindow
let store
let studioView = null
let studioAccountId = null
let studioPreparedJobId = null
let studioAttached = false
let studioVisible = false
let studioBounds = { x: 230, y: 122, width: 950, height: 658 }
let studioQuotaTimer = null
const generationPollers = new Map()
const configuredDownloadSessions = new Set()

function sendStudioState(extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const contents = studioView?.webContents
  mainWindow.webContents.send('deck:studio-state', {
    accountId: studioAccountId,
    url: contents?.isDestroyed() ? '' : contents?.getURL() || '',
    title: contents?.isDestroyed() ? '' : contents?.getTitle() || 'Dola',
    loading: contents?.isDestroyed() ? false : contents?.isLoading() || false,
    canGoBack: contents?.isDestroyed() ? false : contents?.navigationHistory.canGoBack() || false,
    canGoForward: contents?.isDestroyed() ? false : contents?.navigationHistory.canGoForward() || false,
    ...extra
  })
}

function sendGenerationUpdate(job) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('deck:generation-update', job)
}

function stopGenerationPoller(jobId) {
  const timer = generationPollers.get(jobId)
  if (timer) clearInterval(timer)
  generationPollers.delete(jobId)
}

function stopAllGenerationPollers() {
  generationPollers.forEach(timer => clearInterval(timer))
  generationPollers.clear()
}

function startGenerationPoller(jobId) {
  stopGenerationPoller(jobId)
  let running = false
  const tick = async () => {
    if (running) return
    const job = store.getJob(jobId)
    if (!job || TERMINAL_STATUSES.has(job.status)) {
      stopGenerationPoller(jobId)
      return
    }
    if (!studioView || studioAccountId !== job.accountId) return
    running = true
    try {
      if (/^https:\/\/www\.dola\.com\/chat\/\d+/i.test(job.conversationUrl || '') && studioView.webContents.getURL() !== job.conversationUrl) {
        await studioView.webContents.loadURL(job.conversationUrl)
      }
      const updated = await pollDolaGeneration(studioView.webContents, job)
      store.upsertJob(updated)
      sendGenerationUpdate(updated)
      if (TERMINAL_STATUSES.has(updated.status)) stopGenerationPoller(jobId)
    } catch (error) {
      const updated = store.upsertJob({ ...job, statusLabel: '等待后台会话恢复', lastPollError: error.message, updatedAt: new Date().toISOString() })
      sendGenerationUpdate(updated)
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, 5000)
  generationPollers.set(jobId, timer)
  tick().catch(() => {})
}

function configureStudioDownloads(ses, account) {
  const key = ses.storagePath || `deck-${account.id}`
  if (configuredDownloadSessions.has(key)) return
  configuredDownloadSessions.add(key)
  ses.setDownloadPath(account.downloadPath)
  ses.on('will-download', (_event, item) => {
    const settings = store.getSettings()
    const currentAccount = store.listAccounts().find(entry => entry.id === account.id) || account
    const defaultPath = path.join(currentAccount.downloadPath, item.getFilename())
    if (settings.askSaveLocation) {
      item.setSaveDialogOptions({ title: '保存 Dola 生成文件', defaultPath })
    } else {
      item.setSavePath(defaultPath)
    }
    item.once('done', (_doneEvent, status) => sendStudioState({ download: { status, path: item.getSavePath(), filename: item.getFilename() } }))
  })
}

function clearStudioQuotaTimer() {
  if (studioQuotaTimer) clearInterval(studioQuotaTimer)
  studioQuotaTimer = null
}

async function readStudioQuota() {
  const view = studioView
  const accountId = studioAccountId
  const contents = view?.webContents
  if (!contents || contents.isDestroyed()) {
    return { accountId, status: 'unavailable', reason: 'Dola 会话尚未连接', readAt: new Date().toISOString(), snippets: [] }
  }
  try {
    const page = await contents.executeJavaScript(`(() => {
      const termPattern = /(积分|额度|剩余|可用|余额|credits?|quota|balance|usage|用量)/i
      const snippets = []
      const add = value => {
        const text = String(value || '').replace(/\\s+/g, ' ').trim()
        if (!text || text.length > 140 || !termPattern.test(text) || snippets.includes(text)) return
        snippets.push(text)
      }
      const visible = element => {
        const style = getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
      }
      document.querySelectorAll('body *').forEach(element => {
        if (!visible(element)) return
        const text = element.textContent || ''
        if (element.children.length === 0 && termPattern.test(text)) add(text)
        const parent = element.closest('button,[role="button"],header,nav')
        if (parent && parent !== element) add(parent.innerText)
      })
      document.querySelectorAll('[aria-label],[title]').forEach(element => {
        if (visible(element)) add(element.getAttribute('aria-label') || element.getAttribute('title'))
      })
      return { title: document.title, url: location.href, snippets: snippets.slice(0, 40) }
    })()`, true)
    if (view !== studioView) return { accountId, status: 'stale', reason: 'Dola 会话已切换', readAt: new Date().toISOString(), snippets: [] }
    return {
      accountId,
      status: 'ok',
      readAt: new Date().toISOString(),
      title: page?.title || contents.getTitle() || 'Dola',
      url: page?.url || contents.getURL(),
      snippets: Array.isArray(page?.snippets) ? page.snippets : []
    }
  } catch (error) {
    return { accountId, status: 'error', reason: error.message, readAt: new Date().toISOString(), snippets: [] }
  }
}

async function refreshStudioQuota() {
  const view = studioView
  const snapshot = await readStudioQuota()
  if (view !== studioView) return snapshot
  sendStudioState({ quota: snapshot })
  return snapshot
}

function startStudioQuotaTimer() {
  clearStudioQuotaTimer()
  studioQuotaTimer = setInterval(() => {
    refreshStudioQuota().catch(() => {})
  }, 60 * 1000)
}

function closeStudioView() {
  stopAllGenerationPollers()
  clearStudioQuotaTimer()
  if (!studioView) return
  if (mainWindow && !mainWindow.isDestroyed() && studioAttached) mainWindow.contentView.removeChildView(studioView)
  studioAttached = false
  studioView.webContents.close()
  studioView = null
  studioAccountId = null
  studioPreparedJobId = null
  studioVisible = false
  sendStudioState({ closed: true })
}

function openStudio(account) {
  if (studioView && studioAccountId === account.id) {
    if (studioVisible && !studioAttached) {
      mainWindow.contentView.addChildView(studioView)
      studioAttached = true
    }
    if (!studioVisible && studioAttached) {
      mainWindow.contentView.removeChildView(studioView)
      studioAttached = false
    }
    studioView.setBounds(studioBounds)
    if (studioVisible) studioView.webContents.focus()
    startStudioQuotaTimer()
    sendStudioState()
    return store.touchAccount(account.id)
  }
  closeStudioView()
  const partition = `persist:deck-dola-${account.id}`
  studioView = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  studioAccountId = account.id
  configureStudioDownloads(studioView.webContents.session, account)
  studioView.setBackgroundColor('#ffffff')
  studioView.setBounds(studioBounds)
  studioVisible = false
  studioAttached = false
  startStudioQuotaTimer()
  const contents = studioView.webContents
  contents.setWindowOpenHandler(details => {
    if (!details.url.startsWith('https://')) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true }
      }
    }
  })
  contents.on('did-start-loading', () => sendStudioState({ loading: true }))
  contents.on('did-stop-loading', () => {
    sendStudioState({ loading: false })
    setTimeout(() => refreshStudioQuota().catch(() => {}), 700)
    store.listJobs()
      .filter(job => job.accountId === account.id && ['submitted', 'generating'].includes(job.status))
      .forEach(job => {
        if (!generationPollers.has(job.id)) startGenerationPoller(job.id)
      })
  })
  contents.on('did-navigate', () => {
    const currentUrl = contents.getURL()
    if (!currentUrl.startsWith('https://www.dola.com/chat/create-image')) studioPreparedJobId = null
    if (/^https:\/\/www\.dola\.com\/chat\/\d+/i.test(currentUrl)) {
      const activeJob = store.listJobs().find(job => job.accountId === account.id && ['submitted', 'generating'].includes(job.status))
      if (activeJob && activeJob.conversationUrl !== currentUrl) {
        const updated = store.upsertJob({ ...activeJob, conversationUrl: currentUrl, updatedAt: new Date().toISOString() })
        sendGenerationUpdate(updated)
      }
    }
    sendStudioState()
  })
  contents.on('did-navigate-in-page', () => sendStudioState())
  contents.on('page-title-updated', () => sendStudioState())
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) sendStudioState({ error: `${description} (${code})`, url })
  })
  contents.loadURL('https://www.dola.com/chat/?continue_chat=0')
  return store.touchAccount(account.id)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#f7f8fb',
    title: 'Deck',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (process.env.DECK_SMOKE_STUDIO === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      const account = store.listAccounts()[0]
      if (!account) {
        console.log('DECK_STUDIO_SMOKE:no-account')
        return
      }
      openStudio(account)
      studioView.webContents.once('did-finish-load', () => {
        console.log(`DECK_STUDIO_SMOKE:loaded:${studioView.webContents.getURL()}:${studioView.webContents.getTitle()}`)
      })
    })
  }
  mainWindow.on('closed', () => {
    stopAllGenerationPollers()
    clearStudioQuotaTimer()
    if (studioView && !studioView.webContents.isDestroyed()) studioView.webContents.close()
    studioView = null
    studioAccountId = null
    studioPreparedJobId = null
    studioAttached = false
    studioVisible = false
  })
}

function validSender(event) {
  const url = event.senderFrame?.url || ''
  if (!url.startsWith('file://')) throw new Error('拒绝未知页面调用')
}

function normalizeGenerationJob(payload) {
  const account = store.listAccounts().find(item => item.id === payload?.accountId)
  if (!account) throw new Error('生成账号不存在')
  const mode = payload?.mode === 'image' ? 'image' : 'video'
  const models = mode === 'video'
    ? new Set(['seedance-2.5', 'seedance-2.0-fast', 'seedance-1.0'])
    : new Set(['seedream-4.5', 'seedream-5.0-pro'])
  if (!models.has(payload?.model)) throw new Error('生成模型无效')
  const ratios = mode === 'video'
    ? new Set(['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'])
    : new Set(['1:1', '2:3', '3:4', '4:3', '9:16', '16:9', '21:9'])
  if (!ratios.has(payload?.ratio)) throw new Error('生成画幅无效')
  const prompt = String(payload?.prompt || '').trim()
  if (!prompt) throw new Error('提示词不能为空')
  if ([...prompt].length > 12000) throw new Error('提示词过长')
  const assets = Array.isArray(payload?.assets) ? payload.assets.map(asset => ({
    path: String(asset.path || ''),
    name: path.basename(String(asset.path || '')),
    alias: String(asset.alias || ''),
    kind: asset.kind === 'image' ? 'image' : asset.kind
  })) : []
  if (assets.some(asset => asset.kind !== 'image')) throw new Error('Dola 当前生成页只支持图片参考素材')
  assets.forEach(asset => {
    if (!path.isAbsolute(asset.path) || !fs.existsSync(asset.path)) throw new Error(`参考图片不存在：${asset.name || asset.path}`)
  })
  return {
    id: typeof payload?.id === 'string' && payload.id.length <= 80 ? payload.id : randomUUID(),
    accountId: account.id,
    mode,
    prompt,
    assets,
    assetCount: assets.length,
    mentionCount: Number(payload?.mentionCount) || 0,
    model: payload.model,
    modelLabel: String(payload.modelLabel || payload.model),
    ratio: payload.ratio,
    duration: mode === 'video' ? (Number(payload.duration) === 10 ? 10 : 5) : null,
    style: mode === 'image' ? String(payload.style || '') : null,
    estimate: String(payload.estimate || ''),
    status: 'preparing',
    statusLabel: '正在准备 Dola',
    createdAt: payload.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    results: [],
    error: null
  }
}

function registerIpc() {
  ipcMain.handle('deck:bootstrap', event => {
    validSender(event)
    return {
      accounts: store.listAccounts(),
      settings: store.getSettings(),
      library: store.listLibrary(),
      studioJobs: store.listJobs(),
      browsers: detectBrowsers(),
      tools: {
        ffmpeg: findMediaBinary('ffmpeg'),
        ffprobe: findMediaBinary('ffprobe'),
        aiCleaner: getAiEngine(dataRoot, runtimeRoot)
      }
    }
  })

  ipcMain.handle('deck:add-account', (event, payload) => {
    validSender(event)
    const browser = detectBrowsers().find(item => item.id === payload.browserId)
    if (!browser?.executable) throw new Error('所选浏览器未安装')
    if (!browser.supportsProfiles) throw new Error('豆包浏览器的多账号隔离尚未验证，请先使用 Chrome 或 Edge')
    return store.addAccount(payload)
  })

  ipcMain.handle('deck:launch-account', (event, id) => {
    validSender(event)
    const account = store.listAccounts().find(item => item.id === id)
    if (!account) throw new Error('账号不存在')
    const result = launchAccount(account, store.getSettings())
    return { account: store.touchAccount(id), result }
  })

  ipcMain.handle('deck:open-studio', (event, id) => {
    validSender(event)
    const account = store.listAccounts().find(item => item.id === id)
    if (!account) throw new Error('账号不存在')
    return openStudio(account)
  })

  ipcMain.handle('deck:refresh-quota', async event => {
    validSender(event)
    return refreshStudioQuota()
  })

  ipcMain.handle('deck:prepare-generation', async (event, payload) => {
    validSender(event)
    const job = normalizeGenerationJob(payload)
    const account = store.listAccounts().find(item => item.id === job.accountId)
    const activeJob = store.listJobs().find(item => item.id !== job.id && item.accountId === job.accountId && ['submitted', 'generating'].includes(item.status))
    if (activeJob) throw new Error('该账号已有任务正在生成，请等待完成或切换其他账号')
    const preparing = store.upsertJob(job)
    sendGenerationUpdate(preparing)
    try {
      if (!studioView || studioAccountId !== account.id) openStudio(account)
      const prepared = await prepareDolaGeneration(studioView.webContents, preparing)
      studioPreparedJobId = prepared.id
      const saved = store.upsertJob(prepared)
      sendGenerationUpdate(saved)
      return saved
    } catch (error) {
      const failed = store.upsertJob({ ...preparing, status: 'failed', statusLabel: '准备失败', error: error.message, updatedAt: new Date().toISOString() })
      sendGenerationUpdate(failed)
      throw error
    }
  })

  ipcMain.handle('deck:submit-generation', async (event, jobId) => {
    validSender(event)
    let job = store.getJob(jobId)
    if (!job) throw new Error('生成任务不存在')
    if (!['ready', 'failed'].includes(job.status)) throw new Error('当前任务还不能提交')
    const account = store.listAccounts().find(item => item.id === job.accountId)
    if (!account) throw new Error('生成账号不存在')
    const activeJob = store.listJobs().find(item => item.id !== job.id && item.accountId === job.accountId && ['submitted', 'generating'].includes(item.status))
    if (activeJob) throw new Error('该账号已有任务正在生成，请等待完成或切换其他账号')
    try {
      if (!studioView || studioAccountId !== account.id) openStudio(account)
      if (studioPreparedJobId !== job.id) {
        job = await prepareDolaGeneration(studioView.webContents, { ...job, status: 'preparing', statusLabel: '重新准备 Dola' })
        store.upsertJob(job)
      }
      const submitted = await submitDolaGeneration(studioView.webContents, job)
      studioPreparedJobId = null
      const saved = store.upsertJob(submitted)
      sendGenerationUpdate(saved)
      startGenerationPoller(saved.id)
      refreshStudioQuota().catch(() => {})
      return saved
    } catch (error) {
      const failed = store.upsertJob({ ...job, status: 'failed', statusLabel: '提交失败', error: error.message, updatedAt: new Date().toISOString() })
      sendGenerationUpdate(failed)
      throw error
    }
  })

  ipcMain.handle('deck:save-generation-result', (event, payload) => {
    validSender(event)
    const job = store.getJob(payload?.jobId)
    if (!job) throw new Error('生成任务不存在')
    const result = Array.isArray(job.results) ? job.results[Number(payload?.index)] : null
    if (!result?.url || !/^https?:\/\//i.test(result.url)) throw new Error('结果下载地址不可用')
    const account = store.listAccounts().find(item => item.id === job.accountId)
    if (!account) throw new Error('生成账号不存在')
    if (!studioView || studioAccountId !== account.id) openStudio(account)
    studioView.webContents.downloadURL(result.url)
    return true
  })

  ipcMain.handle('deck:hide-studio', event => {
    validSender(event)
    studioVisible = false
    if (studioView && studioAttached) {
      mainWindow.contentView.removeChildView(studioView)
      studioAttached = false
    }
    return true
  })

  ipcMain.handle('deck:show-studio', event => {
    validSender(event)
    // The Deck generation console intentionally keeps the Dola page hidden.
    // The session still loads in the background so a future adapter can drive it.
    studioVisible = false
    if (studioView && studioAttached) {
      mainWindow.contentView.removeChildView(studioView)
      studioAttached = false
    }
    return false
  })

  ipcMain.handle('deck:set-studio-bounds', (event, bounds) => {
    validSender(event)
    const content = mainWindow.getContentBounds()
    studioBounds = {
      x: Math.max(0, Math.round(Number(bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(320, Math.min(content.width, Math.round(Number(bounds.width) || 320))),
      height: Math.max(240, Math.min(content.height, Math.round(Number(bounds.height) || 240)))
    }
    if (studioView) studioView.setBounds(studioBounds)
    return studioBounds
  })

  ipcMain.handle('deck:studio-nav', (event, action) => {
    validSender(event)
    const contents = studioView?.webContents
    if (!contents || contents.isDestroyed()) return false
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    if (action === 'reload') contents.reload()
    if (action === 'home') contents.loadURL('https://www.dola.com/chat/?continue_chat=0')
    return true
  })

  ipcMain.handle('deck:choose-assets', async event => {
    validSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '添加参考素材',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片、音频和视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov', 'webm', 'mkv'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: '音频', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg'] },
        { name: '视频', extensions: ['mp4', 'mov', 'webm', 'mkv'] }
      ]
    })
    if (result.canceled) return []
    return result.filePaths.map(filePath => {
      const stat = fs.statSync(filePath)
      const extension = path.extname(filePath).slice(1).toLowerCase()
      const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
      const audioExtensions = new Set(['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg'])
      return {
        path: filePath,
        name: path.basename(filePath),
        extension,
        kind: imageExtensions.has(extension) ? 'image' : audioExtensions.has(extension) ? 'audio' : 'video',
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      }
    })
  })

  ipcMain.handle('deck:update-settings', (event, patch) => {
    validSender(event)
    return store.updateSettings(patch || {})
  })

  ipcMain.handle('deck:choose-directory', async event => {
    validSender(event)
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('deck:open-folder', async (event, folderPath) => {
    validSender(event)
    if (!path.isAbsolute(folderPath)) throw new Error('目录无效')
    fs.mkdirSync(folderPath, { recursive: true })
    const error = await shell.openPath(folderPath)
    if (error) throw new Error(error)
    return true
  })

  ipcMain.handle('deck:choose-video', async event => {
    validSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '添加本地视频',
      properties: ['openFile'],
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] }]
    })
    if (result.canceled) return null
    const metadata = await probeVideo(result.filePaths[0])
    const item = store.addLibraryItem({ sourcePath: metadata.path, status: 'imported', metadata })
    return { item, metadata }
  })

  ipcMain.handle('deck:choose-output', async (event, sourcePath) => {
    validSender(event)
    const settings = store.getSettings()
    const parsed = path.parse(sourcePath)
    const defaultPath = path.join(settings.processedRoot, `${parsed.name}-已清理.mp4`)
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存处理后的视频',
      defaultPath,
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
    })
    return result.canceled ? null : result.filePath
  })

  ipcMain.handle('deck:process-video', async (event, payload) => {
    validSender(event)
    const metadata = await probeVideo(payload.inputPath)
    const result = await processDelogo({
      inputPath: payload.inputPath,
      outputPath: payload.outputPath,
      region: payload.region,
      metadata,
      onProgress: progress => mainWindow?.webContents.send('deck:process-progress', progress)
    })
    const item = store.addLibraryItem({ sourcePath: payload.inputPath, outputPath: result.outputPath, status: 'processed', metadata: result.verified })
    return { ...result, item }
  })

  ipcMain.handle('deck:preview-ai-cleanup', async (event, payload) => {
    validSender(event)
    await probeVideo(payload.inputPath)
    return previewCleanup({
      dataRoot,
      appRoot: runtimeRoot,
      inputPath: payload.inputPath,
      target: payload.target === 'text-watermark' ? 'watermark' : 'subtitle',
      detectMode: payload.detectMode || 'balanced',
      onProgress: progress => mainWindow?.webContents.send('deck:ai-progress', progress)
    })
  })

  ipcMain.handle('deck:run-ai-cleanup', async (event, payload) => {
    validSender(event)
    await probeVideo(payload.inputPath)
    if (!path.isAbsolute(payload.outputPath) || !path.isAbsolute(payload.planPath)) throw new Error('处理路径无效')
    const result = await runCleanup({
      dataRoot,
      appRoot: runtimeRoot,
      inputPath: payload.inputPath,
      outputPath: payload.outputPath,
      planPath: payload.planPath,
      workDir: payload.workDir,
      onProgress: progress => mainWindow?.webContents.send('deck:ai-progress', progress)
    })
    const verified = await probeVideo(result.output_path)
    const item = store.addLibraryItem({ sourcePath: payload.inputPath, outputPath: result.output_path, status: 'processed', metadata: verified })
    return { ...result, verified, item }
  })
}

app.whenReady().then(() => {
  store = new DeckStore(dataRoot)
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
