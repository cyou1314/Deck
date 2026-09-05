const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi'])

function findMediaBinary(name, env = process.env) {
  const exe = `${name}.exe`
  const candidates = [
    env.DECK_FFMPEG_DIR ? path.join(env.DECK_FFMPEG_DIR, exe) : null,
    ...String(env.PATH || '').split(path.delimiter).map(dir => path.join(dir, exe))
  ]
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null
}

function runCapture(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim() || `进程退出码 ${code}`)))
  })
}

async function probeVideo(filePath, ffprobePath = findMediaBinary('ffprobe')) {
  if (!ffprobePath) throw new Error('未找到 FFprobe')
  if (!fs.existsSync(filePath)) throw new Error('视频文件不存在')
  if (!VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error('不支持这个视频格式')
  const { stdout } = await runCapture(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate',
    '-of', 'json',
    filePath
  ])
  const data = JSON.parse(stdout)
  const video = data.streams?.find(stream => stream.codec_type === 'video')
  if (!video?.width || !video?.height) throw new Error('文件中没有可用的视频流')
  return {
    path: filePath,
    name: path.basename(filePath),
    width: Number(video.width),
    height: Number(video.height),
    duration: Number(data.format?.duration || 0),
    size: Number(data.format?.size || fs.statSync(filePath).size),
    videoCodec: video.codec_name || '',
    hasAudio: Boolean(data.streams?.some(stream => stream.codec_type === 'audio'))
  }
}

function normalizedRegionToPixels(region, width, height) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
  const x = Math.round(clamp(Number(region.x), 0, 0.98) * width)
  const y = Math.round(clamp(Number(region.y), 0, 0.98) * height)
  const w = Math.round(clamp(Number(region.w), 0.02, 1) * width)
  const h = Math.round(clamp(Number(region.h), 0.02, 1) * height)
  return {
    x: Math.min(x, width - 2),
    y: Math.min(y, height - 2),
    w: Math.max(2, Math.min(w, width - x)),
    h: Math.max(2, Math.min(h, height - y))
  }
}

async function processDelogo({ inputPath, outputPath, region, metadata, ffmpegPath = findMediaBinary('ffmpeg'), onProgress }) {
  if (!ffmpegPath) throw new Error('未找到 FFmpeg')
  if (!fs.existsSync(inputPath)) throw new Error('原视频不存在')
  if (path.resolve(inputPath).toLowerCase() === path.resolve(outputPath).toLowerCase()) throw new Error('输出文件不能覆盖原视频')
  if (fs.existsSync(outputPath)) throw new Error('输出文件已存在，请换一个文件名')
  const pixel = normalizedRegionToPixels(region, metadata.width, metadata.height)
  const filter = `delogo=x=${pixel.x}:y=${pixel.y}:w=${pixel.w}:h=${pixel.h}:show=0`
  await new Promise((resolve, reject) => {
    const args = ['-n', '-i', inputPath, '-map', '0:v:0', '-map', '0:a?', '-vf', filter, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath]
    const child = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', chunk => {
      const text = chunk.toString()
      stderr += text
      const match = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
      if (match && metadata.duration > 0 && onProgress) {
        const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
        onProgress(Math.min(99, Math.round((seconds / metadata.duration) * 100)))
      }
    })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.slice(-1200) || `FFmpeg 退出码 ${code}`)))
  })
  const verified = await probeVideo(outputPath)
  if (onProgress) onProgress(100)
  return { outputPath, region: pixel, verified }
}

module.exports = { VIDEO_EXTENSIONS, findMediaBinary, probeVideo, normalizedRegionToPixels, processDelogo }
