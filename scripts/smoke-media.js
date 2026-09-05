const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { findMediaBinary, probeVideo, processDelogo } = require('../src/media')

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-media-'))
  const inputPath = path.join(tempRoot, 'input.mp4')
  const outputPath = path.join(tempRoot, 'output.mp4')
  const ffmpegPath = findMediaBinary('ffmpeg')
  const generated = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-vf', 'drawbox=x=500:y=300:w=110:h=38:color=white@0.9:t=fill',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', inputPath
  ], { windowsHide: true, encoding: 'utf8' })
  if (generated.status !== 0) throw new Error(generated.stderr || '无法生成测试视频')
  const metadata = await probeVideo(inputPath)
  const result = await processDelogo({
    inputPath,
    outputPath,
    region: { x: 0.77, y: 0.8, w: 0.18, h: 0.12 },
    metadata,
    ffmpegPath
  })
  if (!fs.existsSync(result.outputPath) || !result.verified.hasAudio) throw new Error('媒体验证失败')
  console.log(JSON.stringify({ duration: result.verified.duration, width: result.verified.width, height: result.verified.height, hasAudio: result.verified.hasAudio }))
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
