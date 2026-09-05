const state = {
  accounts: [],
  browsers: [],
  library: [],
  settings: null,
  activeAccountId: null,
  activePage: 'workspace',
  studioOpen: false,
  studioState: null,
  studioAssets: [],
  studioMode: 'video',
  studioJobs: [],
  studioPrompt: '',
  studioQuotaByAccount: {},
  currentVideo: null,
  aiPreview: null,
  progressUnsubscribe: null
}

const $ = selector => document.querySelector(selector)
const $$ = selector => [...document.querySelectorAll(selector)]
let toastTimer

function showToast(message, isError = false) {
  const toast = $('#toast')
  toast.textContent = message
  toast.style.background = isError ? '#b6404b' : '#171b27'
  toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600)
}

function showPage(pageName) {
  if (pageName === 'studio') pageName = 'workspace'
  state.activePage = pageName
  $$('.page').forEach(page => page.classList.toggle('active', page.id === `page-${pageName}`))
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === pageName))
  if (pageName === 'workspace') {
    syncStudioBounds()
    window.deck.showStudio().catch(error => showToast(error.message, true))
  } else {
    window.deck.hideStudio().catch(() => {})
  }
}

function formatAge(iso) {
  if (!iso) return '尚未打开'
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  return `${Math.round(hours / 24)}天前`
}

function initials(name) {
  return [...name].slice(0, 1).join('') || 'D'
}

function activeAccount() {
  return state.accounts.find(account => account.id === state.activeAccountId) || null
}

function renderAccounts() {
  const list = $('#account-list')
  list.replaceChildren()
  $('#account-count').textContent = state.accounts.length
  state.accounts.forEach(account => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `account-item${account.id === state.activeAccountId ? ' active' : ''}`
    button.style.setProperty('--account-color', account.color)
    const avatar = document.createElement('span')
    avatar.className = 'account-avatar'
    avatar.textContent = initials(account.name)
    const copy = document.createElement('span')
    copy.className = 'account-copy'
    const strong = document.createElement('strong')
    strong.textContent = account.name
    const small = document.createElement('small')
    small.textContent = account.lastOpenedAt ? `最近打开 ${formatAge(account.lastOpenedAt)}` : '待首次登录'
    copy.append(strong, small)
    button.append(avatar, copy)
    button.addEventListener('click', () => {
      state.activeAccountId = account.id
      renderAccounts()
      renderActiveAccount()
      if (state.activePage === 'workspace') openActiveStudio({ silent: true })
    })
    list.append(button)
  })
  $('#empty-account').hidden = state.accounts.length > 0
  $('#account-stage').hidden = state.accounts.length === 0
}

function renderActiveAccount() {
  const account = activeAccount()
  if (!account) {
    $('#studio-account-name').textContent = '未选择账号'
    $('#quota-account').textContent = '未选择账号'
    renderQuotaCard()
    return
  }
  document.documentElement.style.setProperty('--active', account.color)
  $('#active-name').textContent = account.name
  $('#active-status').textContent = account.lastOpenedAt ? `最近打开 ${formatAge(account.lastOpenedAt)}` : '准备首次登录'
  $('#studio-account-name').textContent = account.name
  $('#studio-account-dot').style.background = account.color
  $('#quota-account').textContent = account.name
  renderQuotaCard()
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '大小未知'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function assetKindLabel(kind) {
  return kind === 'image' ? '图片' : kind === 'audio' ? '音频' : '视频'
}

function normalizeAssetAlias(value, fallback) {
  const clean = String(value || '').trim().replace(/\s+/g, '_')
  if (!clean || clean === '@') return fallback
  return clean.startsWith('@') ? clean : `@${clean}`
}

function assetAliasFromFilename(asset, aliases = new Set()) {
  const fallback = asset.kind === 'image' ? '图' : asset.kind === 'audio' ? '音频' : '视频'
  const filename = String(asset.name || '').trim()
  const stem = filename
    .replace(/\.[^.]+$/u, '')
    .replace(/^@+/u, '')
    .replace(/\s+/gu, '_')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '') || fallback
  let alias = `@${stem}`
  let suffix = 2
  while (aliases.has(alias)) alias = `@${stem}-${suffix++}`
  aliases.add(alias)
  return alias
}

function updatePromptCount() {
  const prompt = $('#studio-prompt')
  if (!prompt) return
  $('#prompt-count').textContent = `${[...prompt.value].length} 字`
}

function renderStudioModels() {
  const select = $('#studio-model')
  if (!select) return
  const previous = select.value
  const options = state.studioMode === 'video'
    ? [
        { value: 'seedance-2.5', label: 'Dreamina Seedance 2.5' },
        { value: 'seedance-2.0-fast', label: 'Dreamina Seedance 2.0 Fast' },
        { value: 'seedance-1.0', label: 'Dreamina Seedance 1.0' }
      ]
    : [
        { value: 'seedream-4.5', label: 'Seedream 4.5' },
        { value: 'seedream-5.0-pro', label: 'Seedream 5.0 Pro（4 倍消耗）' }
      ]
  select.replaceChildren()
  options.forEach(optionData => {
    const option = document.createElement('option')
    option.value = optionData.value
    option.textContent = optionData.label
    select.append(option)
  })
  select.value = options.some(option => option.value === previous) ? previous : options[0].value
}

function renderStudioRatios() {
  const select = $('#studio-ratio')
  if (!select) return
  const previous = select.value
  const options = state.studioMode === 'video'
    ? [
        ['1:1', '1:1'],
        ['3:4', '3:4'],
        ['4:3', '4:3'],
        ['9:16', '9:16'],
        ['16:9', '16:9'],
        ['21:9', '21:9']
      ]
    : [
        ['1:1', '1:1 · 正方形'],
        ['2:3', '2:3 · 社交媒体'],
        ['3:4', '3:4 · 经典比例'],
        ['4:3', '4:3 · 文章配图'],
        ['9:16', '9:16 · 手机壁纸'],
        ['16:9', '16:9 · 桌面壁纸'],
        ['21:9', '21:9 · 超宽目标（待 Dola 原生支持）']
      ]
  select.replaceChildren()
  options.forEach(([value, label]) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    select.append(option)
  })
  select.value = options.some(([value]) => value === previous) ? previous : (state.studioMode === 'video' ? '16:9' : '1:1')
}

function parseQuotaSnapshot(snapshot) {
  const snippets = Array.isArray(snapshot?.snippets) ? snapshot.snippets : []
  const text = snippets.join(' | ')
  const readNumber = patterns => {
    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (match) return Number(match[1])
    }
    return null
  }
  const remaining = readNumber([
    /(?:剩余|可用|余额)\D{0,16}(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s*(?:剩余积分|剩余额度)/i
  ])
  const total = readNumber([/(?:总额|总额度|总积分|上限)\D{0,16}(\d+(?:\.\d+)?)/i])
  const used = readNumber([/(?:已用|已消耗|用量|使用)\D{0,16}(\d+(?:\.\d+)?)/i])
  const status = snapshot?.status === 'ok' && remaining === null && total === null && used === null
    ? 'unparsed'
    : (snapshot?.status || 'unavailable')
  return {
    ...snapshot,
    remaining,
    total,
    used,
    status,
    rawText: snippets.slice(0, 3).join(' · '),
    reason: status === 'unparsed' ? 'Dola 页面暂未找到明确的剩余额度字段' : snapshot?.reason || ''
  }
}

function renderQuotaCard() {
  const account = activeAccount()
  const balance = $('#quota-balance')
  const updated = $('#quota-updated')
  if (!balance || !updated) return
  if (!account) {
    balance.textContent = '连接后读取'
    updated.textContent = '先选择账号；额度按账号独立读取。'
    return
  }
  const snapshot = state.studioQuotaByAccount[account.id]
  if (!snapshot) {
    balance.textContent = '尚未读取'
    updated.textContent = '连接账号后自动读取，生成前会再次刷新。'
    return
  }
  if (snapshot.status === 'loading') {
    balance.textContent = '读取中…'
    updated.textContent = '正在读取当前账号的 Dola 页面额度。'
    return
  }
  if (snapshot.remaining !== null && snapshot.remaining !== undefined) {
    balance.textContent = `${snapshot.remaining} 积分`
  } else if (snapshot.status === 'error') {
    balance.textContent = '读取失败'
  } else if (snapshot.status === 'unparsed') {
    balance.textContent = '页面未识别'
  } else {
    balance.textContent = '暂无数据'
  }
  const time = snapshot.readAt ? `最后读取 ${formatAge(snapshot.readAt)}` : '尚未读取'
  const usage = snapshot.used != null || snapshot.total != null
    ? ` · 已用 ${snapshot.used ?? '—'}${snapshot.total != null ? ` / 总额 ${snapshot.total}` : ''}`
    : ''
  const detail = snapshot.rawText ? ` · ${snapshot.rawText}` : (snapshot.reason ? ` · ${snapshot.reason}` : '')
  updated.textContent = `${time}${usage}${detail}`
}

async function refreshQuota({ silent = false } = {}) {
  const account = activeAccount()
  if (!account) {
    if (!silent) showToast('先选择一个 Dola 账号', true)
    return null
  }
  state.studioQuotaByAccount[account.id] = { status: 'loading', accountId: account.id }
  renderQuotaCard()
  try {
    if (!state.studioOpen || state.studioState?.accountId !== account.id) await openActiveStudio({ silent: true })
    const snapshot = parseQuotaSnapshot(await window.deck.refreshQuota())
    if (snapshot.accountId && snapshot.accountId !== account.id) return null
    state.studioQuotaByAccount[account.id] = snapshot
    renderQuotaCard()
    if (!silent) {
      showToast(snapshot.remaining !== null && snapshot.remaining !== undefined
        ? `额度已刷新：${snapshot.remaining} 积分`
        : '已刷新页面，暂未识别出剩余额度')
    }
    return snapshot
  } catch (error) {
    state.studioQuotaByAccount[account.id] = parseQuotaSnapshot({ accountId: account.id, status: 'error', reason: error.message, snippets: [] })
    renderQuotaCard()
    if (!silent) showToast(`额度读取失败：${error.message}`, true)
    return null
  }
}

function updateQuotaEstimate() {
  const estimate = $('#quota-estimate')
  if (!estimate) return
  if (state.studioMode === 'image') {
    estimate.textContent = '页面读取'
    return
  }
  const duration = Number($('#studio-duration')?.value || 5)
  estimate.textContent = duration === 5 ? '2 积分（估算）' : '4 积分（估算）'
}

function renderStudioAssets() {
  const list = $('#asset-list')
  if (!list) return
  list.replaceChildren()
  $('#asset-count').textContent = `${state.studioAssets.length} 个`
  $('#asset-empty').hidden = state.studioAssets.length > 0
  state.studioAssets.forEach(asset => {
    const card = document.createElement('div')
    card.className = 'asset-card'

    const preview = document.createElement('span')
    preview.className = 'asset-card-preview'
    if (asset.kind === 'image') {
      const image = document.createElement('img')
      image.src = videoFileUrl(asset.path)
      image.alt = asset.name
      preview.append(image)
    } else {
      preview.textContent = asset.kind === 'audio' ? '♫' : '▶'
    }

    const copy = document.createElement('span')
    copy.className = 'asset-card-copy'
    const name = document.createElement('strong')
    name.textContent = asset.name
    const meta = document.createElement('small')
    meta.textContent = `${assetKindLabel(asset.kind)} · ${formatBytes(asset.size)}`
    copy.append(name, meta)

    const controls = document.createElement('span')
    controls.className = 'asset-card-controls'
    const alias = document.createElement('input')
    alias.type = 'text'
    alias.value = asset.alias
    alias.title = '素材引用名'
    alias.setAttribute('aria-label', `${asset.name} 的引用名`)
    alias.addEventListener('change', () => {
      const nextAlias = normalizeAssetAlias(alias.value, asset.alias)
      const duplicate = state.studioAssets.some(item => item.id !== asset.id && item.alias === nextAlias)
      if (duplicate) {
        showToast(`${nextAlias} 已经被其他素材使用`, true)
        alias.value = asset.alias
        return
      }
      const previousAlias = asset.alias
      asset.alias = nextAlias
      alias.value = nextAlias
      if ($('#studio-prompt').value.includes(previousAlias)) {
        $('#studio-prompt').value = $('#studio-prompt').value.split(previousAlias).join(nextAlias)
        state.studioPrompt = $('#studio-prompt').value
        updatePromptCount()
      }
    })
    const insertButton = document.createElement('button')
    insertButton.type = 'button'
    insertButton.textContent = '@'
    insertButton.title = `插入 ${asset.alias}`
    insertButton.addEventListener('click', () => insertMention(asset.alias))
    const removeButton = document.createElement('button')
    removeButton.type = 'button'
    removeButton.textContent = '×'
    removeButton.title = '移除素材'
    removeButton.addEventListener('click', () => {
      state.studioAssets = state.studioAssets.filter(item => item.id !== asset.id)
      renderStudioAssets()
      renderMentionPopover()
    })
    controls.append(alias, insertButton, removeButton)
    card.append(preview, copy, controls)
    list.append(card)
  })
}

function mentionContext() {
  const textarea = $('#studio-prompt')
  if (!textarea) return null
  const before = textarea.value.slice(0, textarea.selectionStart)
  const match = before.match(/(^|\s)(@[^\s@]*)$/u)
  if (!match) return null
  return { token: match[2], start: before.length - match[2].length, end: textarea.selectionStart }
}

function insertMention(alias) {
  const textarea = $('#studio-prompt')
  if (!textarea) return
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const before = textarea.value.slice(0, start)
  const context = before.match(/(^|\s)(@[^\s@]*)$/u)
  const replaceStart = context ? start - context[2].length : start
  const nextValue = `${textarea.value.slice(0, replaceStart)}${alias} ${textarea.value.slice(end)}`
  textarea.value = nextValue
  const caret = replaceStart + alias.length + 1
  textarea.selectionStart = caret
  textarea.selectionEnd = caret
  state.studioPrompt = nextValue
  updatePromptCount()
  renderMentionPopover()
  textarea.focus()
}

function renderMentionPopover() {
  const popover = $('#mention-popover')
  if (!popover) return
  const context = mentionContext()
  if (!context || state.studioAssets.length === 0) {
    popover.hidden = true
    popover.replaceChildren()
    return
  }
  const search = context.token.slice(1).toLowerCase()
  const matches = state.studioAssets.filter(asset => `${asset.alias} ${asset.name}`.toLowerCase().includes(search))
  if (matches.length === 0) {
    popover.hidden = true
    popover.replaceChildren()
    return
  }
  popover.replaceChildren()
  matches.forEach(asset => {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = 'mention-option'
    const icon = document.createElement('span')
    icon.className = 'mention-icon'
    if (asset.kind === 'image') {
      const image = document.createElement('img')
      image.src = videoFileUrl(asset.path)
      image.alt = ''
      icon.append(image)
    } else {
      icon.textContent = asset.kind === 'audio' ? '♫' : '▶'
    }
    const label = document.createElement('span')
    label.textContent = asset.alias
    const type = document.createElement('small')
    type.textContent = assetKindLabel(asset.kind)
    option.append(icon, label, type)
    option.addEventListener('click', () => insertMention(asset.alias))
    popover.append(option)
  })
  popover.hidden = false
}

function fillImageMentionMarkers(aliases) {
  const textarea = $('#studio-prompt')
  if (!textarea || aliases.length === 0) return []
  let inserted = 0
  const markerPattern = /(^|[\s(（\[【"“‘,，。.!！？;；:：])@(?=$|[\s,，。.!！？;；:：)）\]】"”’])/gu
  const nextValue = textarea.value.replace(markerPattern, (match, prefix) => {
    if (inserted >= aliases.length) return match
    return `${prefix}${aliases[inserted++]}`
  })
  if (inserted > 0) {
    textarea.value = nextValue
    state.studioPrompt = nextValue
    updatePromptCount()
  }
  return aliases.slice(0, inserted)
}

async function addStudioAssets() {
  try {
    const picked = await window.deck.chooseAssets()
    if (!picked?.length) return
    const existing = new Set(state.studioAssets.map(asset => asset.path))
    const aliases = new Set(state.studioAssets.map(asset => asset.alias))
    const additions = picked.filter(asset => !existing.has(asset.path)).map(asset => ({
      ...asset,
      id: `asset-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      alias: assetAliasFromFilename(asset, aliases)
    }))
    if (additions.length < picked.length) showToast('已跳过重复素材')
    state.studioAssets.push(...additions)
    const imageAliases = additions
      .filter(asset => asset.kind === 'image')
      .map(asset => asset.alias)
    const insertedAliases = $('#auto-mention-assets')?.checked ? fillImageMentionMarkers(imageAliases) : []
    renderStudioAssets()
    renderMentionPopover()
    if (additions.length > 0) {
      const labels = additions.map(asset => asset.alias).join('、')
      if (insertedAliases.length > 0) {
        showToast(`已添加并填入 ${insertedAliases.join('、')}`)
      } else if (imageAliases.length > 0 && $('#auto-mention-assets')?.checked) {
        showToast(`已添加 ${labels}；提示词中没有空的 @ 占位符，请在需要的位置输入 @`)
      } else {
        showToast(`已添加 ${labels}`)
      }
    }
  } catch (error) {
    showToast(error.message, true)
  }
}

function setGenerationMode(mode) {
  state.studioMode = mode
  $$('.generation-mode-button').forEach(button => {
    const active = button.dataset.generationMode === mode
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', active ? 'true' : 'false')
  })
  $('#duration-field').hidden = mode === 'image'
  $('#style-field').hidden = mode !== 'image'
  renderStudioModels()
  renderStudioRatios()
  updateQuotaEstimate()
}

function mergeStudioJob(job) {
  const index = state.studioJobs.findIndex(item => item.id === job.id)
  if (index >= 0) state.studioJobs[index] = job
  else state.studioJobs.unshift(job)
  state.studioJobs.sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0))
  renderStudioJobs()
}

function jobStatusLabel(job) {
  const labels = {
    preparing: '正在准备',
    ready: '等待确认生成',
    submitting: '正在提交',
    submitted: '已提交',
    generating: '生成中',
    completed: '生成完成',
    failed: '失败',
    unsupported: '暂不支持'
  }
  return job.statusLabel || labels[job.status] || job.status || '等待处理'
}

async function saveStudioResult(job, result, index) {
  try {
    await window.deck.saveGenerationResult(job.id, index)
    showToast(`正在保存${result.type === 'video' ? '视频' : '图片'}；请选择文件位置`)
  } catch (error) {
    showToast(`保存失败：${error.message}`, true)
  }
}

async function submitStudioJob(job) {
  const account = state.accounts.find(item => item.id === job.accountId)
  await refreshQuota({ silent: true })
  const quota = state.studioQuotaByAccount[job.accountId]
  const quotaCopy = quota?.remaining !== null && quota?.remaining !== undefined ? `\n当前读取额度：${quota.remaining} 积分。` : ''
  const spec = job.mode === 'video' ? `${job.duration} 秒 ${job.ratio} 视频` : `${job.ratio} 图片`
  const confirmed = window.confirm(`即将使用账号“${account?.name || '未知账号'}”生成 ${spec}。\n预计消耗：${job.estimate || '以 Dola 页面为准'}。${quotaCopy}\n\n确认后会真正提交并消耗 Dola 额度。`)
  if (!confirmed) return
  mergeStudioJob({ ...job, status: 'submitting', statusLabel: '正在提交到 Dola', updatedAt: new Date().toISOString() })
  try {
    const submitted = await window.deck.submitGeneration(job.id)
    mergeStudioJob(submitted)
    $('#generation-status').textContent = '任务已经提交。可以继续整理下一个提示词，当前任务会在右侧自动更新。'
    showToast('已提交生成，Deck 会自动回收结果')
  } catch (error) {
    mergeStudioJob({ ...job, status: 'failed', statusLabel: '提交失败', error: error.message, updatedAt: new Date().toISOString() })
    showToast(`提交失败：${error.message}`, true)
  }
}

async function retryStudioJob(job) {
  mergeStudioJob({ ...job, status: 'preparing', statusLabel: '正在重新准备', error: null, updatedAt: new Date().toISOString() })
  try {
    const prepared = await window.deck.prepareGeneration(job)
    mergeStudioJob(prepared)
    showToast('任务已重新准备，尚未消耗额度')
  } catch (error) {
    mergeStudioJob({ ...job, status: 'failed', statusLabel: '准备失败', error: error.message, updatedAt: new Date().toISOString() })
    showToast(`准备失败：${error.message}`, true)
  }
}

function renderStudioJobs() {
  const list = $('#studio-job-list')
  if (!list) return
  $('#job-count').textContent = state.studioJobs.length
  list.replaceChildren()
  if (state.studioJobs.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'job-empty'
    empty.textContent = '准备后的任务会显示在这里；只有点击“确认生成”才会消耗额度。'
    list.append(empty)
    return
  }
  state.studioJobs.slice(0, 8).forEach((job, index) => {
    const card = document.createElement('article')
    card.className = `studio-job studio-job-${job.status || 'pending'}`
    const row = document.createElement('div')
    row.className = 'studio-job-row'
    const number = document.createElement('span')
    number.className = 'studio-job-index'
    number.textContent = String(index + 1).padStart(2, '0')
    const copy = document.createElement('span')
    copy.className = 'studio-job-copy'
    const title = document.createElement('strong')
    const mode = job.mode === 'video' ? '视频' : '图片'
    title.textContent = `${mode} · ${job.modelLabel || job.model} · ${job.ratio}${job.duration ? ` · ${job.duration}秒` : ''}`
    const detail = document.createElement('small')
    const account = state.accounts.find(item => item.id === job.accountId)
    detail.textContent = `${account?.name || '未知账号'} · ${job.assetCount} 个素材 · ${job.mentionCount} 个引用 · ${job.estimate}`
    copy.append(title, detail)
    const status = document.createElement('span')
    status.className = 'studio-job-status'
    status.textContent = jobStatusLabel(job)
    row.append(number, copy, status)
    card.append(row)

    if (job.error) {
      const error = document.createElement('p')
      error.className = 'studio-job-error'
      error.textContent = job.error
      card.append(error)
    }

    const actions = document.createElement('div')
    actions.className = 'studio-job-actions'
    if (job.status === 'ready') {
      const submit = document.createElement('button')
      submit.type = 'button'
      submit.className = 'job-primary-action'
      submit.textContent = `确认生成 · ${job.estimate || '页面计费'}`
      submit.addEventListener('click', () => submitStudioJob(job))
      actions.append(submit)
    }
    if (job.status === 'failed') {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'job-secondary-action'
      retry.textContent = '重新准备'
      retry.addEventListener('click', () => retryStudioJob(job))
      actions.append(retry)
    }
    if (actions.childElementCount > 0) card.append(actions)

    if (Array.isArray(job.results) && job.results.length > 0) {
      const resultGrid = document.createElement('div')
      resultGrid.className = 'studio-result-grid'
      job.results.forEach((result, resultIndex) => {
        const resultCard = document.createElement('div')
        resultCard.className = 'studio-result-card'
        if (result.type === 'video') {
          const video = document.createElement('video')
          video.src = result.url
          video.poster = result.poster || ''
          video.controls = true
          video.preload = 'metadata'
          resultCard.append(video)
        } else {
          const image = document.createElement('img')
          image.src = result.url
          image.alt = `${mode}生成结果 ${resultIndex + 1}`
          resultCard.append(image)
        }
        const save = document.createElement('button')
        save.type = 'button'
        save.textContent = '选择位置保存'
        save.addEventListener('click', () => saveStudioResult(job, result, resultIndex))
        resultCard.append(save)
        resultGrid.append(resultCard)
      })
      card.append(resultGrid)
    }
    list.append(card)
  })
}

async function prepareGeneration() {
  const account = activeAccount()
  if (!account) {
    showToast('先添加或选择一个 Dola 账号', true)
    return
  }
  const prompt = $('#studio-prompt').value.trim()
  if (!prompt) {
    showToast('先写一段提示词，再进行预检', true)
    $('#studio-prompt').focus()
    return
  }
  const aliases = new Set(state.studioAssets.map(asset => asset.alias))
  const tokens = [...prompt.matchAll(/@[\p{L}\p{N}_-]+/gu)].map(match => match[0])
  const unknown = [...new Set(tokens.filter(token => !aliases.has(token)))]
  if (unknown.length > 0) {
    showToast(`这些引用还没有对应素材：${unknown.join('、')}`, true)
    return
  }
  const audioAssets = state.studioAssets.filter(asset => asset.kind === 'audio')
  if (audioAssets.length > 0) {
    showToast('当前 Dola 生成页只接受图片附件，先移除音频素材再准备提交', true)
    return
  }
  await refreshQuota({ silent: true })
  const duration = Number($('#studio-duration').value || 5)
  const estimate = state.studioMode === 'video' ? (duration === 5 ? '2 积分（估算）' : '4 积分（估算）') : '页面读取'
  const targetRatio = $('#studio-ratio').value
  const ratioNeedsAdapter = state.studioMode === 'image' && targetRatio === '21:9'
  const job = {
    id: `job-${Date.now()}`,
    createdAt: new Date().toISOString(),
    accountId: account.id,
    mode: state.studioMode,
    prompt,
    assets: state.studioAssets.map(asset => ({ path: asset.path, name: asset.name, alias: asset.alias, kind: asset.kind })),
    assetCount: state.studioAssets.length,
    mentionCount: tokens.length,
    model: $('#studio-model').value,
    modelLabel: $('#studio-model').selectedOptions[0]?.textContent || $('#studio-model').value,
    ratio: targetRatio,
    duration: state.studioMode === 'video' ? duration : null,
    style: state.studioMode === 'image' ? $('#studio-style').value : null,
    estimate,
    status: ratioNeedsAdapter ? 'unsupported' : 'preparing',
    statusLabel: ratioNeedsAdapter ? 'Dola 图片暂不支持 21:9' : '正在准备 Dola',
    results: []
  }
  state.studioPrompt = prompt
  mergeStudioJob(job)
  if (ratioNeedsAdapter) {
    $('#generation-status').textContent = 'Dola 图片页当前没有原生 21:9；该任务没有提交，也没有消耗额度。'
    showToast('图片 21:9 当前无法提交到 Dola', true)
    return
  }
  $('#prepare-generation-button').disabled = true
  $('#generation-status').textContent = `正在后台写入 ${job.assetCount} 个素材和生成参数；此阶段不扣额度。`
  try {
    if (!state.studioOpen || state.studioState?.accountId !== account.id) await openActiveStudio({ silent: true })
    const prepared = await window.deck.prepareGeneration(job)
    mergeStudioJob(prepared)
    $('#generation-status').textContent = '准备完成。请在右侧任务卡核对参数，再点击“确认生成”。'
    showToast('任务已准备好，尚未消耗生成额度')
  } catch (error) {
    mergeStudioJob({ ...job, status: 'failed', statusLabel: '准备失败', error: error.message, updatedAt: new Date().toISOString() })
    $('#generation-status').textContent = `准备失败：${error.message}`
    showToast(`准备失败：${error.message}`, true)
  } finally {
    $('#prepare-generation-button').disabled = false
  }
}

function syncStudioBounds() {
  if (!['workspace', 'studio'].includes(state.activePage)) return
  const slot = $('#studio-slot')
  const rect = slot.getBoundingClientRect()
  window.deck.setStudioBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }).catch(() => {})
}

async function openActiveStudio({ silent = false } = {}) {
  const account = activeAccount()
  if (!account) {
    if (!silent) showToast('先添加或选择一个账号', true)
    return
  }
  try {
    $('#studio-status-copy').textContent = '正在打开 Dola…'
    showPage('workspace')
    syncStudioBounds()
    const updated = await window.deck.openStudio(account.id)
    const index = state.accounts.findIndex(item => item.id === updated.id)
    if (index >= 0) state.accounts[index] = updated
    state.studioOpen = true
    $('#studio-empty').hidden = false
    $('#runtime-copy').textContent = `账号 ${account.name} 的后台会话已准备好。Deck 目前不会显示 Dola 网页，也不会在预检阶段消耗额度。`
    renderAccounts()
    renderActiveAccount()
    if (!silent) showToast(`已在 Deck 中打开 ${account.name}`)
  } catch (error) {
    $('#studio-status-copy').textContent = 'Dola 打开失败'
    showToast(error.message, true)
  }
}

function mountGenerationWorkbench() {
  const workbench = $('.generation-workbench')
  const accountStage = $('#account-stage')
  const recentSection = $('.recent-section')
  if (!workbench || !accountStage || workbench.parentElement === accountStage) return
  accountStage.insertBefore(workbench, recentSection || null)
  const parameterDock = $('#parameter-dock')
  if (parameterDock) {
    ['.parameter-block', '.quota-card', '#prepare-generation-button', '#generation-status'].forEach(selector => {
      const node = $(selector)
      if (node && node.parentElement !== parameterDock) parameterDock.append(node)
    })
  }
}

function videoFileUrl(filePath) {
  return encodeURI(`file:///${filePath.replace(/\\/g, '/')}`).replace(/#/g, '%23')
}

function renderLibrary() {
  const recent = $('#recent-files')
  const fileList = $('#file-list')
  recent.replaceChildren()
  fileList.replaceChildren()
  const items = state.library.slice(0, 50)
  if (items.length === 0) {
    const emptyRecent = document.createElement('div')
    emptyRecent.className = 'empty-list'
    emptyRecent.textContent = '还没有文件，下载后可手动添加到 Deck。'
    recent.append(emptyRecent)
    const emptyFiles = emptyRecent.cloneNode(true)
    fileList.append(emptyFiles)
    return
  }
  items.slice(0, 3).forEach(item => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'film-item'
    const thumb = document.createElement('span')
    thumb.className = 'film-thumb'
    const duration = document.createElement('span')
    duration.textContent = item.metadata?.duration ? `${item.metadata.duration.toFixed(1)}秒` : '本地视频'
    thumb.append(duration)
    const name = document.createElement('strong')
    name.textContent = item.outputPath ? item.outputPath.split(/[\\/]/).pop() : item.sourcePath.split(/[\\/]/).pop()
    const meta = document.createElement('small')
    meta.textContent = item.status === 'processed' ? '处理完成' : '已导入'
    button.append(thumb, name, meta)
    button.addEventListener('click', () => loadLibraryVideo(item))
    recent.append(button)
  })
  items.forEach(item => {
    const row = document.createElement('div')
    row.className = 'file-row'
    const main = document.createElement('div')
    main.className = 'file-main'
    const stripe = document.createElement('span')
    stripe.className = 'file-stripe'
    const names = document.createElement('span')
    const strong = document.createElement('strong')
    const shownPath = item.outputPath || item.sourcePath
    strong.textContent = shownPath.split(/[\\/]/).pop()
    const small = document.createElement('small')
    small.textContent = shownPath
    names.append(strong, small)
    main.append(stripe, names)
    const status = document.createElement('span')
    status.textContent = item.status === 'processed' ? '处理完成' : '本地导入'
    const spec = document.createElement('span')
    spec.textContent = item.metadata ? `${item.metadata.width}×${item.metadata.height} · ${item.metadata.duration.toFixed(1)}秒` : '—'
    const action = document.createElement('button')
    action.className = 'text-action'
    action.type = 'button'
    action.textContent = '去水印'
    action.addEventListener('click', () => loadLibraryVideo(item))
    row.append(main, status, spec, action)
    fileList.append(row)
  })
}

function populateBrowserSelects() {
  const selects = [$('#default-browser'), $('#account-browser')]
  selects.forEach(select => {
    select.replaceChildren()
    state.browsers.forEach(browser => {
      const option = document.createElement('option')
      option.value = browser.id
      option.textContent = browser.name + (browser.executable ? '' : '（未安装）') + (browser.supportsProfiles ? '' : '（待验证）')
      option.disabled = !browser.executable || !browser.supportsProfiles
      select.append(option)
    })
  })
  $('#default-browser').value = state.settings.defaultBrowser
  $('#account-browser').value = state.browsers.some(item => item.id === state.settings.defaultBrowser && item.executable && item.supportsProfiles) ? state.settings.defaultBrowser : 'chrome'
}

function renderSettings() {
  $('#ask-save-location').checked = state.settings.askSaveLocation
  $('#ask-save-label').textContent = state.settings.askSaveLocation ? '已开启' : '已关闭'
  $('#save-rule-copy').textContent = state.settings.askSaveLocation ? '每个文件都会单独打开系统“另存为”窗口。' : '文件直接保存到当前账号的默认下载目录。'
  $('#data-root').textContent = state.settings.dataRoot
  $('#downloads-root').textContent = state.settings.downloadsRoot
  $('#processed-root').textContent = state.settings.processedRoot
}

function openAccountDialog() {
  $('#account-dialog-layer').hidden = false
  $('#account-name').focus()
}

function closeAccountDialog() {
  $('#account-dialog-layer').hidden = true
  $('#account-form').reset()
  $('#account-color').value = '#5269ff'
}

async function createAccount(event) {
  event.preventDefault()
  try {
    const account = await window.deck.addAccount({
      name: $('#account-name').value,
      browserId: $('#account-browser').value,
      color: $('#account-color').value
    })
    state.accounts.push(account)
    state.activeAccountId = account.id
    closeAccountDialog()
    renderAccounts()
    renderActiveAccount()
    await openActiveStudio()
  } catch (error) {
    showToast(error.message, true)
  }
}

async function launchActiveAccount() {
  const account = activeAccount()
  if (!account) return
  try {
    $('#launch-account-button').disabled = true
    const response = await window.deck.launchAccount(account.id)
    const index = state.accounts.findIndex(item => item.id === account.id)
    state.accounts[index] = response.account
    renderAccounts()
    renderActiveAccount()
    showToast(state.settings.askSaveLocation ? `已打开 ${account.name}；下载每个文件前会询问保存位置。` : `已打开 ${account.name}。`)
  } catch (error) {
    showToast(error.message, true)
  } finally {
    $('#launch-account-button').disabled = false
  }
}

async function chooseVideo() {
  try {
    const result = await window.deck.chooseVideo()
    if (!result) return
    state.library.unshift(result.item)
    renderLibrary()
    loadVideo(result.metadata)
  } catch (error) {
    showToast(error.message, true)
  }
}

function loadLibraryVideo(item) {
  const filePath = item.outputPath || item.sourcePath
  const metadata = { ...(item.metadata || {}), path: filePath, name: filePath.split(/[\\/]/).pop() }
  loadVideo(metadata)
}

function loadVideo(metadata) {
  state.currentVideo = metadata
  resetAiPreview()
  $('#cleanup-empty').hidden = true
  $('#cleanup-editor').hidden = false
  $('#video-preview').src = videoFileUrl(metadata.path)
  $('#video-name').textContent = metadata.name
  $('#video-spec').textContent = `${metadata.width}×${metadata.height} · ${metadata.duration.toFixed(1)}秒`
  showPage('cleanup')
  applyRegionInputs()
}

function presetRegion(name) {
  const values = {
    'bottom-right': [75, 80, 20, 12],
    'bottom-left': [5, 80, 20, 12],
    'top-right': [75, 8, 20, 12],
    'top-left': [5, 8, 20, 12]
  }[name]
  if (!values) return
  ;['x', 'y', 'w', 'h'].forEach((key, index) => { $(`#region-${key}`).value = values[index] })
  applyRegionInputs()
}

function currentRegion() {
  return {
    x: Number($('#region-x').value) / 100,
    y: Number($('#region-y').value) / 100,
    w: Number($('#region-w').value) / 100,
    h: Number($('#region-h').value) / 100
  }
}

function applyRegionInputs() {
  const region = currentRegion()
  const box = $('#watermark-box')
  box.style.left = `${region.x * 100}%`
  box.style.top = `${region.y * 100}%`
  box.style.width = `${region.w * 100}%`
  box.style.height = `${region.h * 100}%`
}

function updateInputsFromBox() {
  const box = $('#watermark-box')
  const frame = $('#video-frame')
  $('#region-x').value = Math.round((box.offsetLeft / frame.clientWidth) * 100)
  $('#region-y').value = Math.round((box.offsetTop / frame.clientHeight) * 100)
}

function enableBoxDrag() {
  const box = $('#watermark-box')
  const frame = $('#video-frame')
  let drag = null
  box.addEventListener('pointerdown', event => {
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: box.offsetLeft, top: box.offsetTop }
    box.setPointerCapture(event.pointerId)
  })
  box.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return
    const left = Math.min(frame.clientWidth - box.offsetWidth, Math.max(0, drag.left + event.clientX - drag.startX))
    const top = Math.min(frame.clientHeight - box.offsetHeight, Math.max(0, drag.top + event.clientY - drag.startY))
    box.style.left = `${left}px`
    box.style.top = `${top}px`
    updateInputsFromBox()
  })
  box.addEventListener('pointerup', event => {
    if (drag?.pointerId === event.pointerId) drag = null
  })
}

async function processCurrentVideo() {
  if (!state.currentVideo) return
  const cleanupMode = $('input[name="cleanup-mode"]:checked')?.value || 'fast'
  if (cleanupMode === 'ai') {
    return processCurrentVideoWithAi()
  }
  try {
    const outputPath = await window.deck.chooseOutput(state.currentVideo.path)
    if (!outputPath) return
    $('#process-button').disabled = true
    $('#process-progress-wrap').hidden = false
    $('#process-status').textContent = '准备处理…'
    const result = await window.deck.processVideo({ inputPath: state.currentVideo.path, outputPath, region: currentRegion() })
    state.library.unshift(result.item)
    renderLibrary()
    $('#process-status').textContent = '处理完成并已验证'
    showToast(`处理完成：${result.outputPath}`)
  } catch (error) {
    $('#process-status').textContent = '处理失败'
    showToast(error.message, true)
  } finally {
    $('#process-button').disabled = false
  }
}

function resetAiPreview() {
  state.aiPreview = null
  const image = $('#ai-preview-image')
  if (image) {
    image.hidden = true
    image.removeAttribute('src')
  }
  if ($('#video-preview')) $('#video-preview').hidden = false
  if ($('#ai-review')) $('#ai-review').hidden = true
  if ($('#process-button') && $('input[name="cleanup-mode"]:checked')?.value === 'ai') {
    $('#process-button').textContent = '先检测并预览'
  }
}

async function processCurrentVideoWithAi() {
  const button = $('#process-button')
  try {
    button.disabled = true
    $('#process-progress-wrap').hidden = false
    if (!state.aiPreview) {
      $('#process-status').textContent = '正在检测字幕和文字区域…'
      const preview = await window.deck.previewAiCleanup({
        inputPath: state.currentVideo.path,
        target: $('#ai-content-type').value,
        detectMode: $('#ai-quality').value
      })
      state.aiPreview = preview
      $('#video-preview').hidden = true
      $('#ai-preview-image').src = videoFileUrl(preview.previewPath)
      $('#ai-preview-image').hidden = false
      $('#ai-review').hidden = false
      $('#ai-review-title').textContent = `检测到 ${preview.tracks.length} 条文字轨道`
      $('#ai-review-copy').textContent = `计划清理 ${preview.removeCount} 条。请先检查框选是否误伤，再确认处理。`
      $('#process-status').textContent = '检测完成，等待确认'
      button.textContent = '确认选区并选择保存位置'
      return
    }
    if (state.aiPreview.removeCount === 0) {
      showToast('当前没有检测到需要清理的目标，请重新检测或改用手动区域', true)
      return
    }
    const outputPath = await window.deck.chooseOutput(state.currentVideo.path)
    if (!outputPath) return
    $('#process-status').textContent = '正在进行时序画面修复…'
    const result = await window.deck.runAiCleanup({
      inputPath: state.currentVideo.path,
      outputPath,
      planPath: state.aiPreview.planPath,
      workDir: state.aiPreview.workDir
    })
    state.library.unshift(result.item)
    renderLibrary()
    $('#process-status').textContent = 'AI 清理完成并已验证'
    showToast(`AI 清理完成：${result.output_path}`)
  } catch (error) {
    $('#process-status').textContent = 'AI 清理失败'
    showToast(error.message, true)
  } finally {
    button.disabled = false
  }
}

async function updateSettings(patch) {
  try {
    state.settings = await window.deck.updateSettings(patch)
    renderSettings()
    showToast(Object.hasOwn(patch, 'askSaveLocation')
      ? '设置已保存；下次打开账号环境时生效'
      : '设置已保存')
  } catch (error) {
    showToast(error.message, true)
  }
}

async function changeDirectory(key) {
  const folder = await window.deck.chooseDirectory()
  if (folder) await updateSettings({ [key]: folder })
}

async function bootstrap() {
  try {
    const data = await window.deck.bootstrap()
    Object.assign(state, data)
    state.activeAccountId = state.accounts[0]?.id || null
    $('#tool-status').textContent = data.tools.ffmpeg && data.tools.ffprobe ? 'FFmpeg 可用' : 'FFmpeg 不完整'
    $('#ai-engine-title').textContent = data.tools.aiCleaner?.ready ? data.tools.aiCleaner.name : 'AI 引擎不可用'
    $('#ai-engine-copy').textContent = data.tools.aiCleaner?.ready
      ? '先检测并预览，再确认执行；不会把整段字幕当成一个模糊矩形。'
      : '需要先完成独立 AI 环境配置。'
    mountGenerationWorkbench()
    renderAccounts()
    renderActiveAccount()
    renderLibrary()
    populateBrowserSelects()
    renderSettings()
    setGenerationMode('video')
    renderStudioAssets()
    renderStudioJobs()
    updatePromptCount()
  } catch (error) {
    showToast(`启动失败：${error.message}`, true)
  }
}

$$('[data-page]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)))
$$('[data-open-account-dialog]').forEach(button => button.addEventListener('click', openAccountDialog))
$('#add-account-button').addEventListener('click', openAccountDialog)
$('#cancel-account').addEventListener('click', closeAccountDialog)
$('#account-form').addEventListener('submit', createAccount)
$('#open-studio-button').addEventListener('click', openActiveStudio)
$('#studio-start-button').addEventListener('click', openActiveStudio)
$$('[data-open-studio-from-panel]').forEach(button => button.addEventListener('click', openActiveStudio))
$('#launch-account-button').addEventListener('click', launchActiveAccount)
$('#add-assets-button').addEventListener('click', addStudioAssets)
$$('.generation-mode-button').forEach(button => button.addEventListener('click', () => setGenerationMode(button.dataset.generationMode)))
$('#studio-prompt').addEventListener('input', event => {
  state.studioPrompt = event.target.value
  updatePromptCount()
  renderMentionPopover()
})
$('#studio-prompt').addEventListener('keyup', renderMentionPopover)
$('#studio-prompt').addEventListener('click', renderMentionPopover)
$('#studio-prompt').addEventListener('blur', () => setTimeout(() => { $('#mention-popover').hidden = true }, 120))
$('#clear-prompt').addEventListener('click', () => {
  $('#studio-prompt').value = ''
  state.studioPrompt = ''
  updatePromptCount()
  renderMentionPopover()
  $('#studio-prompt').focus()
})
$('#studio-duration').addEventListener('change', updateQuotaEstimate)
$('#prepare-generation-button').addEventListener('click', prepareGeneration)
$('#refresh-quota-button').addEventListener('click', () => refreshQuota())
$$('[data-studio-nav]').forEach(button => button.addEventListener('click', () => window.deck.studioNav(button.dataset.studioNav)))
$('#open-download-folder').addEventListener('click', () => {
  const account = activeAccount()
  if (account) window.deck.openFolder(account.downloadPath).catch(error => showToast(error.message, true))
})
$('#import-file-button').addEventListener('click', chooseVideo)
$('#choose-video-button').addEventListener('click', chooseVideo)
$$('[data-choose-video]').forEach(button => button.addEventListener('click', chooseVideo))
$('#region-preset').addEventListener('change', event => presetRegion(event.target.value))
$$('.region-grid input').forEach(input => input.addEventListener('input', applyRegionInputs))
$('#process-button').addEventListener('click', processCurrentVideo)
$$('input[name="cleanup-mode"]').forEach(input => input.addEventListener('change', event => {
  $$('.mode-card').forEach(card => card.classList.toggle('active', card.contains(event.target)))
  const ai = event.target.value === 'ai'
  $('#fast-cleanup-settings').hidden = ai
  $('#ai-cleanup-settings').hidden = !ai
  $('#watermark-box').hidden = ai
  $('#process-button').textContent = ai ? '选择保存位置并用 AI 清理' : '选择保存位置并快速处理'
  if (ai && !state.aiPreview) $('#process-button').textContent = '先检测并预览'
}))
$('#reset-ai-preview').addEventListener('click', resetAiPreview)
$('#ask-save-location').addEventListener('change', event => updateSettings({ askSaveLocation: event.target.checked }))
$('#default-browser').addEventListener('change', event => updateSettings({ defaultBrowser: event.target.value }))
$('#change-downloads-root').addEventListener('click', () => changeDirectory('downloadsRoot'))
$('#change-processed-root').addEventListener('click', () => changeDirectory('processedRoot'))
$('#account-dialog-layer').addEventListener('click', event => {
  if (event.target === $('#account-dialog-layer')) closeAccountDialog()
})
state.progressUnsubscribe = window.deck.onProcessProgress(progress => {
  $('#process-progress').style.width = `${progress}%`
  $('#process-status').textContent = `处理中 ${progress}%`
})
state.studioUnsubscribe = window.deck.onStudioState(value => {
  state.studioState = value
  if (value.quota?.accountId) {
    state.studioQuotaByAccount[value.quota.accountId] = parseQuotaSnapshot(value.quota)
    if (value.quota.accountId === state.activeAccountId) renderQuotaCard()
  }
  $('#studio-loading-dot').classList.toggle('loading', Boolean(value.loading))
  $('#studio-status-copy').textContent = value.error
    ? `加载失败：${value.error}`
    : value.loading ? 'Dola 正在加载…' : (value.title || 'Dola 已就绪')
  if (value.download?.status === 'completed') showToast(`下载完成：${value.download.path}`)
  if (value.download?.status === 'interrupted') showToast(`下载中断：${value.download.filename}`, true)
})
state.generationUnsubscribe = window.deck.onGenerationUpdate(job => {
  mergeStudioJob(job)
  if (job.status === 'completed') {
    $('#generation-status').textContent = '生成完成，结果已经回到右侧任务卡；可以直接预览或选择位置保存。'
    showToast('生成完成，结果已返回 Deck')
    refreshQuota({ silent: true })
  } else if (job.status === 'failed') {
    $('#generation-status').textContent = `生成失败：${job.error || job.statusLabel}`
    showToast(`生成失败：${job.error || job.statusLabel}`, true)
  }
})
state.aiProgressUnsubscribe = window.deck.onAiProgress(value => {
  const percent = value.total > 0 ? Math.round((value.completed / value.total) * 100) : 0
  $('#process-progress').style.width = `${percent}%`
  $('#process-status').textContent = value.message || `${value.phase || '处理中'} ${percent}%`
})
window.addEventListener('resize', syncStudioBounds)
new ResizeObserver(syncStudioBounds).observe($('#studio-slot'))
enableBoxDrag()
bootstrap()
