const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

function getAiEngine(dataRoot, appRoot) {
  const pythonPath = path.join(dataRoot, 'engines', 'videowipe-env', 'Scripts', 'python.exe')
  const wrapperPath = path.join(appRoot, 'scripts', 'deck_videowipe.py')
  const weightsPath = path.join(dataRoot, 'engines', 'videowipe-weights')
  return {
    ready: fs.existsSync(pythonPath) && fs.existsSync(wrapperPath),
    pythonPath,
    wrapperPath,
    weightsPath,
    name: 'VideoWipe · OCR + STTN · DirectML'
  }
}

function runEngine({ engine, args, onProgress }) {
  return new Promise((resolve, reject) => {
    const child = spawn(engine.pythonPath, [engine.wrapperPath, ...args], {
      windowsHide: true,
      env: { ...process.env, VIDEOWIPE_WEIGHTS_DIR: engine.weightsPath, PYTHONUTF8: '1' }
    })
    let stdout = ''
    let stderr = ''
    let result = null
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      const lines = stdout.split(/\r?\n/)
      stdout = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('DECK_EVENT:')) continue
        try {
          const event = JSON.parse(line.slice('DECK_EVENT:'.length))
          if (event.kind === 'progress') onProgress?.(event)
          if (event.kind === 'result') result = event
        } catch {}
      }
    })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0 && result) resolve(result)
      else reject(new Error(stderr.trim().split(/\r?\n/).slice(-5).join(' ') || `AI 引擎退出，代码 ${code}`))
    })
  })
}

async function previewCleanup({ dataRoot, appRoot, inputPath, target, detectMode, onProgress }) {
  const engine = getAiEngine(dataRoot, appRoot)
  if (!engine.ready) throw new Error('AI 清理引擎尚未安装')
  const workDir = path.join(dataRoot, 'previews', crypto.randomUUID())
  fs.mkdirSync(workDir, { recursive: true })
  const result = await runEngine({
    engine,
    args: ['preview', '--input', inputPath, '--work-dir', workDir, '--target', target, '--detect-mode', detectMode],
    onProgress
  })
  return { ...result, workDir }
}

async function runCleanup({ dataRoot, appRoot, inputPath, outputPath, planPath, workDir, onProgress }) {
  const engine = getAiEngine(dataRoot, appRoot)
  if (!engine.ready) throw new Error('AI 清理引擎尚未安装')
  return runEngine({ engine, args: ['run', '--input', inputPath, '--plan', planPath, '--work-dir', workDir, '--output', outputPath], onProgress })
}

module.exports = { getAiEngine, previewCleanup, runCleanup }
