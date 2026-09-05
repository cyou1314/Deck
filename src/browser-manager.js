const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { ensureDir, readJson, writeJsonAtomic } = require('./store')

const DOLA_URL = 'https://www.dola.com/chat/?continue_chat=0'

function firstExisting(candidates) {
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null
}

function detectBrowsers(env = process.env) {
  const local = env.LOCALAPPDATA || ''
  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      executable: firstExisting([
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
      ]),
      supportsProfiles: true
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      executable: firstExisting([
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      ]),
      supportsProfiles: true
    },
    {
      id: 'doubao',
      name: '豆包浏览器',
      executable: firstExisting([
        env.DECK_DOUBAO_PATH,
        path.join(local, 'Doubao', 'Doubao.exe'),
        path.join(local, 'Programs', 'Doubao', 'Doubao.exe'),
        path.join(programFiles, 'Doubao', 'Doubao.exe'),
        path.join(programFilesX86, 'Doubao', 'Doubao.exe')
      ]),
      supportsProfiles: false,
      note: '已检测到豆包桌面端，独立账号目录兼容性待验证'
    }
  ]
}

function configureDownloadPreferences(profilePath, downloadPath, askSaveLocation) {
  const defaultProfile = path.join(profilePath, 'Default')
  const preferencesPath = path.join(defaultProfile, 'Preferences')
  ensureDir(defaultProfile)
  ensureDir(downloadPath)
  const preferences = readJson(preferencesPath, {})
  preferences.download = {
    ...(preferences.download || {}),
    default_directory: downloadPath,
    directory_upgrade: true,
    prompt_for_download: Boolean(askSaveLocation)
  }
  writeJsonAtomic(preferencesPath, preferences)
}

function launchAccount(account, settings, browsers = detectBrowsers()) {
  const browser = browsers.find(item => item.id === account.browserId)
  if (!browser || !browser.executable) throw new Error('未找到所选浏览器，请在设置中更换')
  if (!browser.supportsProfiles) throw new Error('豆包浏览器尚未通过多账号隔离测试，请先使用 Chrome 或 Edge')
  configureDownloadPreferences(account.profilePath, account.downloadPath, settings.askSaveLocation)
  const args = [
    `--user-data-dir=${account.profilePath}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--disable-sync',
    '--new-window',
    DOLA_URL
  ]
  const child = spawn(browser.executable, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return { browserId: browser.id, pid: child.pid, url: DOLA_URL }
}

module.exports = { DOLA_URL, detectBrowsers, configureDownloadPreferences, launchAccount }
