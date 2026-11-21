import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'

const FFMPEG = ffmpegInstaller.path
const TIMEOUT_MS = 15000
const inFlight = new Map()

export function createThumbService({ uploadDir }) {
  const thumbDir = path.join(uploadDir, '.thumbs')
  try {
    fs.mkdirSync(thumbDir, { recursive: true })
  } catch {}

  function keyOf(name, stats) {
    return crypto.createHash('sha1')
      .update(`${name}|${stats.size}|${Math.round(stats.mtimeMs)}`)
      .digest('hex')
      .slice(0, 24)
  }

  function pathOf(name, stats) {
    return path.join(thumbDir, `${keyOf(name, stats)}.jpg`)
  }

  function ensureThumb(filePath, name, stats) {
    const out = pathOf(name, stats)
    try {
      if (fs.existsSync(out) && fs.statSync(out).size > 0) return Promise.resolve(out)
    } catch {}

    const key = keyOf(name, stats)
    if (inFlight.has(key)) return inFlight.get(key)

    const job = new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), TIMEOUT_MS)

      const run = (offset, retry) => {
        execFile(FFMPEG, [
          '-hide_banner', '-loglevel', 'error',
          '-ss', String(offset),
          '-i', filePath,
          '-frames:v', '1',
          '-vf', 'scale=240:-2',
          '-q:v', '5',
          '-y', out
        ], { timeout: TIMEOUT_MS - 1000 }, () => {
          let ok = false
          try {
            ok = fs.existsSync(out) && fs.statSync(out).size > 0
          } catch {}
          if (ok) finish(out)
          else if (retry) run(0, false)
          else finish(null)
        })
      }
      run(1, true)
    }).finally(() => inFlight.delete(key))

    inFlight.set(key, job)
    return job
  }

  return { ensureThumb, pathOf, thumbDir }
}
