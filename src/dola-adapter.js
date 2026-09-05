const path = require('node:path')

const DOLA_CREATE_URL = 'https://www.dola.com/chat/create-image'

const MODEL_TARGETS = {
  'seedance-2.5': { menu: 'Dreamina Seedance 2.5', selected: '2.5' },
  'seedance-2.0-fast': { menu: 'Dreamina Seedance 2.0 Fast', selected: '2.0 Fast' },
  'seedance-1.0': { menu: 'Dreamina Seedance 1.0', selected: '1.0' },
  'seedream-4.5': { menu: 'Seedream 4.5', selected: '4.5' },
  'seedream-5.0-pro': { menu: 'Seedream 5.0 Pro', selected: '5.0 Pro' }
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function ensureDolaContents(contents) {
  if (!contents || contents.isDestroyed()) throw new Error('Dola 后台会话不可用')
}

async function waitFor(contents, expression, label, timeoutMs = 20000, intervalMs = 250) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    ensureDolaContents(contents)
    try {
      if (await contents.executeJavaScript(`Boolean(${expression})`, true)) return true
    } catch {
      // The page can briefly replace its execution context while navigating.
    }
    await sleep(intervalMs)
  }
  throw new Error(`等待 Dola ${label}超时`)
}

function clickExpression(elementExpression) {
  return `(() => {
    const element = ${elementExpression}
    if (!element) return false
    const pointer = (type, buttons) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons })
    const mouse = (type, buttons) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons })
    element.dispatchEvent(pointer('pointerdown', 1))
    element.dispatchEvent(mouse('mousedown', 1))
    element.dispatchEvent(pointer('pointerup', 0))
    element.dispatchEvent(mouse('mouseup', 0))
    element.dispatchEvent(mouse('click', 0))
    return true
  })()`
}

async function clickElement(contents, elementExpression, label) {
  const clicked = await contents.executeJavaScript(clickExpression(elementExpression), true)
  if (!clicked) throw new Error(`Dola 页面未找到${label}`)
}

async function ensureCreatePage(contents) {
  ensureDolaContents(contents)
  const currentUrl = contents.getURL()
  if (!currentUrl.startsWith(DOLA_CREATE_URL)) {
    try {
      await contents.loadURL(DOLA_CREATE_URL)
    } catch (error) {
      if (!String(error?.message || '').includes('ERR_ABORTED')) throw error
    }
  }
  await waitFor(contents, "location.href.startsWith('https://www.dola.com/chat/create-image') && document.querySelector('button[role=tab]') && document.querySelector('.ProseMirror')", '创作页面')
}

async function selectMode(contents, mode) {
  const label = mode === 'video' ? '视频' : '图像'
  const labelJson = JSON.stringify(label)
  const tabExpression = `[...document.querySelectorAll('button[role="tab"]')].find(button => button.textContent.trim() === ${labelJson})`
  const selected = await contents.executeJavaScript(`Boolean((${tabExpression})?.getAttribute('aria-selected') === 'true')`, true)
  if (!selected) await clickElement(contents, tabExpression, `${label}模式`)
  await waitFor(contents, `(${tabExpression})?.getAttribute('aria-selected') === 'true'`, `${label}模式切换`)
  const expectedControl = mode === 'video' ? 'video-model' : 'model'
  await waitFor(contents, `document.querySelector('[data-input-engine-actionbar-control-key="${expectedControl}"]')`, '生成参数')
}

async function selectMenuValue(contents, controlKey, desiredText, selectedText = desiredText) {
  const keyJson = JSON.stringify(controlKey)
  const desiredJson = JSON.stringify(desiredText)
  const selectedJson = JSON.stringify(selectedText)
  const triggerExpression = `document.querySelector('[data-input-engine-actionbar-control-key="' + ${keyJson} + '"]')`
  const alreadySelected = await contents.executeJavaScript(`String((${triggerExpression})?.textContent || '').includes(${selectedJson})`, true)
  if (alreadySelected) return
  await clickElement(contents, triggerExpression, `${controlKey}选择器`)
  const itemExpression = `[...document.querySelectorAll('[role="menuitem"],[role="option"]')].find(item => String(item.textContent || '').trim().includes(${desiredJson}))`
  await waitFor(contents, itemExpression, `${desiredText}选项`)
  await clickElement(contents, itemExpression, `${desiredText}选项`)
  await waitFor(contents, `String((${triggerExpression})?.textContent || '').includes(${selectedJson})`, `${desiredText}生效`)
}

async function setGenerationParameters(contents, job) {
  const model = MODEL_TARGETS[job.model]
  if (!model) throw new Error(`暂不支持模型 ${job.model}`)
  if (job.mode === 'video') {
    await selectMenuValue(contents, 'video-model', model.menu, model.selected)
    await selectMenuValue(contents, 'video-duration', `${Number(job.duration) || 5}s`)
    await selectMenuValue(contents, 'video-ratio', job.ratio)
    return
  }
  if (job.ratio === '21:9') throw new Error('Dola 图片页当前没有原生 21:9，暂不能自动提交该画幅')
  await selectMenuValue(contents, 'model', model.menu, model.selected)
  await selectMenuValue(contents, 'image_creation_ratio', job.ratio)
  if (job.style) await selectMenuValue(contents, 'style', job.style)
}

async function setPrompt(contents, prompt) {
  const normalizedPrompt = String(prompt || '').replace(/\r\n?/g, '\n')
  const promptJson = JSON.stringify(normalizedPrompt)
  const result = await contents.executeJavaScript(`(() => {
    const editorElement = document.querySelector('.ProseMirror')
    const editor = editorElement?.editor
    if (!editor?.commands?.setContent) return { ok: false }
    const text = ${promptJson}
    const content = text.split('\\n').map(line => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : []
    }))
    editor.commands.setContent({ type: 'doc', content })
    return { ok: true, text: editor.getText({ blockSeparator: '\\n' }) }
  })()`, true)
  if (!result?.ok) throw new Error('Dola 提示词编辑器尚未就绪')
  await waitFor(contents, `document.querySelector('.ProseMirror')?.editor?.getText({ blockSeparator: '\\n' }) === ${promptJson}`, '提示词写入')
}

async function setFileInput(contents, filePaths) {
  if (!filePaths.length) return 0
  filePaths.forEach(filePath => {
    if (!path.isAbsolute(filePath)) throw new Error('参考图片路径无效')
  })
  const debuggerApi = contents.debugger
  let attachedHere = false
  try {
    if (!debuggerApi.isAttached()) {
      debuggerApi.attach('1.3')
      attachedHere = true
    }
    const evaluated = await debuggerApi.sendCommand('Runtime.evaluate', {
      expression: "document.querySelector('input[type=file]')",
      returnByValue: false
    })
    const objectId = evaluated?.result?.objectId
    if (!objectId) throw new Error('Dola 页面未找到图片上传控件')
    const described = await debuggerApi.sendCommand('DOM.describeNode', { objectId })
    const backendNodeId = described?.node?.backendNodeId
    if (!backendNodeId) throw new Error('无法定位 Dola 图片上传控件')
    await debuggerApi.sendCommand('DOM.setFileInputFiles', { files: filePaths, backendNodeId })
    await sleep(1200)
    return filePaths.length
  } finally {
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach()
  }
}

async function captureGenerationSnapshot(contents) {
  ensureDolaContents(contents)
  return contents.executeJavaScript(`(() => {
    const media = []
    const add = (type, url, poster = '') => {
      if (!url || (!url.startsWith('https://') && !url.startsWith('http://'))) return
      if (url.startsWith('http://')) url = 'https://' + url.slice('http://'.length)
      if (media.some(item => item.url === url)) return
      media.push({ type, url, poster })
    }
    const findReactVideoUrl = element => {
      const fiberKey = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactFiber'))
      let fiber = fiberKey ? element[fiberKey] : null
      const seen = new WeakSet()
      let found = ''
      const visit = (value, depth = 0) => {
        if (found || value == null || depth > 8) return
        if (typeof value === 'string') {
          const match = value.match(/https?:[^\\s\\"']+?download=true/)
          if (match && /mime_type=video_mp4|\\/video\\//i.test(match[0])) found = match[0].replace(/\\u0026/g, '&')
          return
        }
        if ((typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return
        seen.add(value)
        if (Array.isArray(value)) {
          value.slice(0, 30).forEach(item => visit(item, depth + 1))
          return
        }
        Object.keys(value).slice(0, 80).forEach(key => {
          if (!['children', 'return', 'child', 'sibling', 'stateNode', '_owner'].includes(key)) {
            try { visit(value[key], depth + 1) } catch {}
          }
        })
      }
      for (let level = 0; fiber && level < 8 && !found; level += 1, fiber = fiber.return) {
        visit(fiber.memoizedProps)
        visit(fiber.memoizedState)
      }
      return found
    }
    document.querySelectorAll('video').forEach(video => {
      add('video', video.currentSrc || video.src || video.querySelector('source')?.src || '', video.poster || '')
    })
    document.querySelectorAll('[class*="block-video"]').forEach(block => {
      const poster = block.querySelector('img')?.currentSrc || block.querySelector('img')?.src || ''
      add('video', findReactVideoUrl(block), poster)
    })
    document.querySelectorAll('img').forEach(image => {
      if (image.closest('[class*="block-video"]')) return
      const container = image.closest('[class*="image-box-grid-item"],[class*="image-item-img-container"],[class*="generation"],[class*="result"]')
      if (container && (image.naturalWidth >= 160 || image.getBoundingClientRect().width >= 160)) add('image', image.currentSrc || image.src || '')
    })
    performance.getEntriesByType('resource').forEach(entry => {
      if (/\\.(mp4|webm)(?:\\?|$)/i.test(entry.name)) add('video', entry.name)
    })
    const leafTexts = [...document.querySelectorAll('body *')]
      .filter(element => element.tagName !== 'SCRIPT' && element.children.length === 0)
      .map(element => String(element.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter(text => text && text.length <= 180)
    const statusText = leafTexts.filter(text => /(生成中|正在生成|排队|处理中|失败|错误|额度不足|已完成|生成完成)/.test(text)).slice(-20)
    return { url: location.href, media, statusText, capturedAt: new Date().toISOString() }
  })()`, true)
}

async function prepareDolaGeneration(contents, job) {
  ensureDolaContents(contents)
  await ensureCreatePage(contents)
  await selectMode(contents, job.mode)
  await setGenerationParameters(contents, job)
  const imagePaths = (job.assets || []).filter(asset => asset.kind === 'image').map(asset => asset.path)
  await setFileInput(contents, imagePaths)
  await setPrompt(contents, job.prompt)
  await waitFor(contents, "document.querySelector('#flow-end-msg-send') && !document.querySelector('#flow-end-msg-send').disabled", '提交按钮可用')
  const baseline = await captureGenerationSnapshot(contents)
  return {
    ...job,
    status: 'ready',
    statusLabel: '等待确认生成',
    preparedAt: new Date().toISOString(),
    pageUrl: contents.getURL(),
    baselineUrls: baseline.media.map(item => item.url),
    baselineStatusTexts: baseline.statusText,
    resultUrls: [],
    error: null,
    updatedAt: new Date().toISOString()
  }
}

async function submitDolaGeneration(contents, job) {
  await waitFor(contents, "document.querySelector('#flow-end-msg-send') && !document.querySelector('#flow-end-msg-send').disabled", '生成按钮可用')
  await clickElement(contents, "document.querySelector('#flow-end-msg-send')", '生成按钮')
  await sleep(600)
  return {
    ...job,
    status: 'submitted',
    statusLabel: '已提交，等待 Dola',
    submittedAt: new Date().toISOString(),
    conversationUrl: contents.getURL(),
    updatedAt: new Date().toISOString()
  }
}

function classifyGenerationSnapshot(job, snapshot) {
  const baseline = new Set(job.baselineUrls || [])
  const results = (snapshot.media || []).filter(item => !baseline.has(item.url))
  const baselineStatuses = new Set(job.baselineStatusTexts || [])
  const currentStatuses = (snapshot.statusText || []).filter(text => !baselineStatuses.has(text))
  const combinedStatus = currentStatuses.join(' | ')
  const failure = /(生成失败|失败|错误|额度不足|次数不足|无法生成)/.test(combinedStatus)
  const working = /(生成中|正在生成|排队|处理中)/.test(combinedStatus)
  if (failure) {
    return { status: 'failed', statusLabel: '生成失败', error: combinedStatus || 'Dola 返回生成失败', results: [] }
  }
  if (results.length > 0 && !working) {
    return { status: 'completed', statusLabel: '生成完成', error: null, results }
  }
  return {
    status: 'generating',
    statusLabel: working ? (currentStatuses.at(-1) || 'Dola 正在生成') : '等待生成结果',
    error: null,
    results
  }
}

async function pollDolaGeneration(contents, job) {
  const snapshot = await captureGenerationSnapshot(contents)
  let classified = classifyGenerationSnapshot(job, snapshot)
  if (classified.status === 'completed') {
    const sameResults = Array.isArray(job.results) && job.results.length === classified.results.length && classified.results.length > 0 &&
      job.results.every((result, index) => result.url === classified.results[index]?.url)
    const stableAt = sameResults && job.resultStableAt ? job.resultStableAt : new Date().toISOString()
    const stableFor = Date.now() - new Date(stableAt).getTime()
    if (!sameResults || stableFor < 4500) {
      classified = { ...classified, status: 'generating', statusLabel: '结果正在回收', resultStableAt: stableAt }
    }
  }
  return {
    ...job,
    ...classified,
    conversationUrl: snapshot.url || job.conversationUrl,
    updatedAt: new Date().toISOString()
  }
}

module.exports = {
  DOLA_CREATE_URL,
  TERMINAL_STATUSES,
  prepareDolaGeneration,
  submitDolaGeneration,
  pollDolaGeneration,
  captureGenerationSnapshot,
  classifyGenerationSnapshot
}
