const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const DEFAULT_SETTINGS = {
  defaultBrowser: 'chrome',
  askSaveLocation: true,
  dataRoot: '',
  downloadsRoot: '',
  processedRoot: ''
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return structuredClone(fallback)
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath))
  const tempPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tempPath, filePath)
}

class DeckStore {
  constructor(dataRoot) {
    this.dataRoot = dataRoot
    this.configDir = path.join(dataRoot, 'config')
    this.settingsPath = path.join(this.configDir, 'settings.json')
    this.accountsPath = path.join(this.configDir, 'accounts.json')
    this.libraryPath = path.join(this.configDir, 'library.json')
    this.jobsPath = path.join(this.configDir, 'jobs.json')
    ensureDir(this.configDir)
    ensureDir(path.join(dataRoot, 'profiles'))
    ensureDir(path.join(dataRoot, 'downloads'))
    ensureDir(path.join(dataRoot, 'processed'))
  }

  getSettings() {
    const saved = readJson(this.settingsPath, {})
    return {
      ...DEFAULT_SETTINGS,
      dataRoot: this.dataRoot,
      downloadsRoot: path.join(this.dataRoot, 'downloads'),
      processedRoot: path.join(this.dataRoot, 'processed'),
      ...saved,
      dataRoot: this.dataRoot
    }
  }

  updateSettings(patch) {
    const allowed = {}
    if (typeof patch.defaultBrowser === 'string') allowed.defaultBrowser = patch.defaultBrowser
    if (typeof patch.askSaveLocation === 'boolean') allowed.askSaveLocation = patch.askSaveLocation
    if (typeof patch.downloadsRoot === 'string' && path.isAbsolute(patch.downloadsRoot)) allowed.downloadsRoot = patch.downloadsRoot
    if (typeof patch.processedRoot === 'string' && path.isAbsolute(patch.processedRoot)) allowed.processedRoot = patch.processedRoot
    const next = { ...this.getSettings(), ...allowed, dataRoot: this.dataRoot }
    ensureDir(next.downloadsRoot)
    ensureDir(next.processedRoot)
    writeJsonAtomic(this.settingsPath, next)
    return next
  }

  listAccounts() {
    return readJson(this.accountsPath, [])
  }

  addAccount({ name, color, browserId }) {
    const safeName = String(name || '').trim().slice(0, 30)
    if (!safeName) throw new Error('请输入账号名称')
    const accounts = this.listAccounts()
    const id = randomUUID()
    const settings = this.getSettings()
    const account = {
      id,
      name: safeName,
      color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#5269ff',
      browserId: String(browserId || settings.defaultBrowser),
      profilePath: path.join(this.dataRoot, 'profiles', id),
      downloadPath: path.join(settings.downloadsRoot, safeName),
      createdAt: new Date().toISOString(),
      lastOpenedAt: null
    }
    ensureDir(account.profilePath)
    ensureDir(account.downloadPath)
    accounts.push(account)
    writeJsonAtomic(this.accountsPath, accounts)
    return account
  }

  touchAccount(id) {
    const accounts = this.listAccounts()
    const account = accounts.find(item => item.id === id)
    if (!account) throw new Error('账号不存在')
    account.lastOpenedAt = new Date().toISOString()
    writeJsonAtomic(this.accountsPath, accounts)
    return account
  }

  addLibraryItem(item) {
    const items = readJson(this.libraryPath, [])
    const normalized = {
      id: randomUUID(),
      sourcePath: item.sourcePath,
      outputPath: item.outputPath || null,
      accountId: item.accountId || null,
      status: item.status || 'imported',
      createdAt: new Date().toISOString(),
      metadata: item.metadata || null
    }
    items.unshift(normalized)
    writeJsonAtomic(this.libraryPath, items.slice(0, 200))
    return normalized
  }

  listLibrary() {
    return readJson(this.libraryPath, [])
  }

  listJobs() {
    return readJson(this.jobsPath, [])
  }

  getJob(id) {
    return this.listJobs().find(item => item.id === id) || null
  }

  upsertJob(job) {
    const jobs = this.listJobs()
    const normalized = {
      ...job,
      updatedAt: job.updatedAt || new Date().toISOString()
    }
    const index = jobs.findIndex(item => item.id === normalized.id)
    if (index >= 0) jobs[index] = normalized
    else jobs.unshift(normalized)
    jobs.sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0))
    writeJsonAtomic(this.jobsPath, jobs.slice(0, 100))
    return normalized
  }
}

module.exports = { DeckStore, DEFAULT_SETTINGS, ensureDir, readJson, writeJsonAtomic }
