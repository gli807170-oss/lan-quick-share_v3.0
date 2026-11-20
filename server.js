import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import crypto, { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildAccessUrls, isLocalAddress, pickBestLanUrl } from './ip-view.mjs'
import { attachV3, moveToTrash, noteDownload, logAction } from './v3.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(__dirname, 'config.json')
const UPLOAD_DIR = path.join(__dirname, 'uploads')
const PUBLIC_DIR = path.join(__dirname, 'public')
const SHARED_TEXT_FILE = path.join(UPLOAD_DIR, '.shared-text.txt')
const HISTORY_FILE = path.join(__dirname, 'shared-text-history.json')
const MAX_HISTORY = 100

// ---------- 配置 ----------
// 访问密码不在前端出现：服务端只保存 SHA-256 摘要，校验时再做一次摘要比对
const DEFAULT_CONFIG = {
  port: 9988,
  host: '0.0.0.0',
  maxFileSizeGB: 20,
  sessionTtlHours: 12,
  passwordSha256: 'e4339e761261c995b73b91d0d00cc8137d80a226c730fc72e19a35547a4b91f3'
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return { ...DEFAULT_CONFIG, ...raw }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[config] 读取 config.json 失败，改用默认配置：', error.message)
    return { ...DEFAULT_CONFIG }
  }
}

const config = loadConfig()
const PORT = Number(process.env.PORT || config.port || 9988)
const HOST = process.env.HOST || config.host || '0.0.0.0'
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || Math.round((Number(config.maxFileSizeGB) || 20) * 1024 ** 3))
const SESSION_TTL_MS = Math.max(1, Number(config.sessionTtlHours) || 12) * 60 * 60 * 1000
const PASSWORD_HASH = String(config.passwordSha256 || '').toLowerCase()

// ---------- 中继媒体类型 ----------
// 可内联播放的媒体类型：视频/音频走浏览器原生播放器，其余仍按附件下载
const VIDEO_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo'
}
const AUDIO_TYPES = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  oga: 'audio/ogg',
  opus: 'audio/ogg'
}
const IMAGE_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

function extOf(name) {
  return path.extname(name).slice(1).toLowerCase()
}

function mediaTypeOf(name) {
  const ext = extOf(name)
  if (VIDEO_TYPES[ext]) return 'video'
  if (AUDIO_TYPES[ext]) return 'audio'
  if (IMAGE_TYPES[ext]) return 'image'
  return 'file'
}

function mimeOf(name) {
  const ext = extOf(name)
  return VIDEO_TYPES[ext] || AUDIO_TYPES[ext] || IMAGE_TYPES[ext] || null
}

function displayNameOf(name) {
  // 支持文件夹上传后的子目录路径：只对最后一段做时间戳前缀剥离
  const value = String(name || '')
  const index = value.lastIndexOf('/')
  const dir = index >= 0 ? value.slice(0, index + 1) : ''
  const base = index >= 0 ? value.slice(index + 1) : value
  return dir + base.replace(/^\d{4}-\d{2}-\d{2}T[\w-]+-[\w-]+-/, '')
}

function formatLimit(bytes) {
  const gb = bytes / 1024 ** 3
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)}GB`
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true })

function safeName(name) {
  return path.basename(name || 'file')
    .replace(/[\/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 160) || 'file'
}

// ---------- 访问门禁 ----------
const sessions = new Map() // token -> { expiresAt }
const loginAttempts = new Map() // ip -> { fails, lockUntil }
const LOGIN_FAIL_LIMIT = 5
const LOGIN_LOCK_MS = 60 * 1000
const AUTH_COOKIE = 'lan_auth'

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest()
}

function verifyPassword(input) {
  if (!PASSWORD_HASH || !input) return false
  let expected
  try {
    expected = Buffer.from(PASSWORD_HASH, 'hex')
  } catch {
    return false
  }
  const actual = sha256Buffer(input)
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

function parseCookies(header) {
  const result = {}
  String(header || '').split(';').forEach(part => {
    const index = part.indexOf('=')
    if (index < 0) return
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  })
  return result
}

function sessionOf(req) {
  const token = parseCookies(req.headers.cookie)[AUTH_COOKIE]
  if (!token) return null
  const record = sessions.get(token)
  if (!record) return null
  if (record.expiresAt <= Date.now()) {
    sessions.delete(token)
    return null
  }
  return { token, ...record }
}

function authCookie(token, maxAgeSeconds) {
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

function requireAuth(req, res, next) {
  if (sessionOf(req)) return next()
  res.status(401).json({ code: 'UNAUTHORIZED', message: '需要先验证访问密码' })
}

// 定期清理过期会话，避免内存长期增长
const sessionTimer = setInterval(() => {
  const now = Date.now()
  for (const [token, record] of sessions) {
    if (record.expiresAt <= now) sessions.delete(token)
  }
  for (const [ip, record] of loginAttempts) {
    if (record.lockUntil && record.lockUntil <= now && !record.fails) loginAttempts.delete(ip)
  }
}, 10 * 60 * 1000)
sessionTimer.unref?.()

// ---------- 上传 ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const name = safeName(file.originalname)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    cb(null, `${stamp}-${randomUUID().slice(0, 8)}-${name}`)
  }
})

const upload = multer({
  storage,
  // 20GB 单文件：multer 采用流式落盘，不会把文件读进内存
  limits: { fileSize: MAX_FILE_SIZE, files: 20, fields: 20 }
})

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))
app.use(express.static(PUBLIC_DIR))

function fileInfo(name, stats) {
  const mediaType = mediaTypeOf(name)
  return {
    name,
    size: stats.size,
    updatedAt: stats.mtimeMs,
    ext: extOf(name),
    mediaType,
    mime: mimeOf(name),
    url: `/files/${encodeURIComponent(name)}`,
    streamUrl: mediaType === 'file' ? null : `/media/${encodeURIComponent(name)}`
  }
}

function listFiles() {
  // 支持文件夹上传：递归遍历上传目录，跳过 . 开头的内部目录/文件与共享文本文件
  const results = []
  const sharedBase = path.basename(SHARED_TEXT_FILE)

  const walk = (dir, relPrefix, depth) => {
    if (depth > 8) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = entry.name
      if (!name || name.startsWith('.')) continue
      const rel = relPrefix ? `${relPrefix}/${name}` : name
      if (!relPrefix && name === sharedBase) continue
      const abs = path.join(dir, name)
      if (entry.isDirectory()) {
        walk(abs, rel, depth + 1)
        continue
      }
      try {
        results.push(fileInfo(rel, fs.statSync(abs)))
      } catch {}
    }
  }

  walk(UPLOAD_DIR, '', 0)
  return results
}

// 把前端传入的相对路径解析为上传目录内的绝对路径，越界一律返回 null
function resolveUploadFile(name) {
  const raw = String(name || '').replace(/\\/g, '/')
  const parts = raw.split('/').filter(part => part && part !== '.')
  if (!parts.length) return null
  for (const part of parts) {
    if (part === '..' || part.startsWith('.')) return null
  }
  const abs = path.resolve(UPLOAD_DIR, parts.join('/'))
  if (abs === UPLOAD_DIR || !abs.startsWith(UPLOAD_DIR + path.sep)) return null
  return abs
}

function readSharedText() {
  try {
    return fs.readFileSync(SHARED_TEXT_FILE, 'utf8')
  } catch {
    return ''
  }
}

function writeSharedText(text) {
  fs.writeFileSync(SHARED_TEXT_FILE, text, 'utf8')
}

function readHistory() {
  try {
    const result = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
    return Array.isArray(result) ? result : []
  } catch {
    return []
  }
}

function writeHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8')
}

function addHistory(text, createdAt = Date.now()) {
  const history = readHistory()
  history.unshift({
    id: `${createdAt}-${randomUUID().slice(0, 8)}`,
    text,
    createdAt
  })
  writeHistory(history.slice(0, MAX_HISTORY))
}

function lanUrls() {
  return buildAccessUrls({ port: PORT, local: true })
}

// ---------- 门禁接口 ----------
app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const attempt = loginAttempts.get(ip) || { fails: 0, lockUntil: 0 }

  if (attempt.lockUntil > now) {
    const wait = Math.ceil((attempt.lockUntil - now) / 1000)
    return res.status(429).json({ message: `尝试次数过多，请 ${wait} 秒后再试` })
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  if (!password) return res.status(400).json({ message: '请输入访问密码' })

  if (!verifyPassword(password)) {
    const local = isLocalAddress(req.socket?.remoteAddress)
    attempt.fails += 1
    // V3.0：本机（回环/本机网卡）访问永不锁定，避免把自己锁在门外
    if (!local && attempt.fails >= LOGIN_FAIL_LIMIT) {
      attempt.fails = 0
      attempt.locks = Number(attempt.locks || 0) + 1
      attempt.lockUntil = now + Math.min(30 * 60 * 1000, LOGIN_LOCK_MS * 2 ** (attempt.locks - 1))
    }
    loginAttempts.set(ip, attempt)
    const left = Math.max(0, LOGIN_FAIL_LIMIT - attempt.fails)
    if (attempt.lockUntil > now) {
      const wait = Math.ceil((attempt.lockUntil - now) / 1000)
      return res.status(401).json({ message: `密码错误次数过多，已锁定 ${wait} 秒`, locked: true, wait })
    }
    return res.status(401).json({
      message: local ? `密码不正确（本机访问不受锁定限制），还可尝试 ${left} 次` : `密码不正确，还可尝试 ${left} 次`
    })
  }

  loginAttempts.delete(ip)
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = now + SESSION_TTL_MS
  sessions.set(token, { expiresAt })
  res.setHeader('Set-Cookie', authCookie(token, Math.floor(SESSION_TTL_MS / 1000)))
  res.json({ ok: true, expiresAt })
})

app.get('/api/auth/status', (req, res) => {
  const session = sessionOf(req)
  res.json({ authed: Boolean(session), expiresAt: session?.expiresAt || null })
})

app.post('/api/auth/logout', (req, res) => {
  const session = sessionOf(req)
  if (session) sessions.delete(session.token)
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  res.json({ ok: true })
})

// 除门禁接口与首页静态资源外，其余接口与文件通道全部需要已验证会话
// ---------- V3.0 免密直链签名 ----------
// 电视/播放器等设备无法携带登录 Cookie，这里用 HMAC 签名做长期有效的免密直链，
// 密钥取配置中的口令摘要，服务重启后已发出的直链依然可用。
const DIRECT_KEY = String(config.passwordSha256 || 'lan-file-share-v3')

function directSign(name) {
  return crypto
    .createHmac('sha256', DIRECT_KEY)
    .update(String(name || '').replace(/\\/g, '/'))
    .digest('hex')
    .slice(0, 24)
}

function directNameOf(req) {
  const raw = String(req.path || '').replace(/^\/(files|media)\//, '')
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    decoded = raw
  }
  return decoded.replace(/\\/g, '/')
}

function hasValidDirectSign(req) {
  const sign = String((req.query && req.query.sign) || '')
  if (!sign) return false
  const name = directNameOf(req)
  if (!name) return false
  const expect = directSign(name)
  if (expect.length !== sign.length) return false
  return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sign))
}

app.use(['/api/files', '/api/shared-text', '/api/upload', '/media'], requireAuth)

// /files 与 /media：带合法签名时放行，否则走密码校验
app.use(['/files', '/media'], (req, res, next) => {
  if (hasValidDirectSign(req)) return next()
  return requireAuth(req, res, next)
})

app.get('/api/info', (req, res) => {
  // 只以服务端 socket 的真实对端地址判断是否本机访问，忽略 X-Forwarded-For 等可伪造请求头
  const local = isLocalAddress(req.socket?.remoteAddress)
  res.json({
    port: PORT,
    maxFileSize: MAX_FILE_SIZE,
    sessionTtlHours: Math.round(SESSION_TTL_MS / 3600000),
    local,
    urls: buildAccessUrls({ port: PORT, local })
  })
})

app.get('/api/files', (req, res) => {
  const sort = String(req.query.sort || 'time')
  const order = String(req.query.order || 'desc') === 'asc' ? 1 : -1
  const dirName = name => displayNameOf(name).toLowerCase()
  const comparators = {
    time: (a, b) => a.updatedAt - b.updatedAt,
    size: (a, b) => a.size - b.size,
    name: (a, b) => dirName(a.name).localeCompare(dirName(b.name), 'zh-CN', { numeric: true }),
    type: (a, b) => a.ext.localeCompare(b.ext) || dirName(a.name).localeCompare(dirName(b.name), 'zh-CN', { numeric: true })
  }
  const files = listFiles().sort((a, b) => (comparators[sort] || comparators.time)(a, b) * order)
  res.json({ files, sort, order: order === 1 ? 'asc' : 'desc' })
})

app.get('/api/shared-text', (_req, res) => {
  res.json({ text: readSharedText() })
})

app.get('/api/shared-text/history', (_req, res) => {
  let history = readHistory()
  // 仅首次运行（历史文件尚不存在）时用当前文字做种子，避免用户清空历史后又被自动重建
  if (!history.length && !fs.existsSync(HISTORY_FILE)) {
    const current = readSharedText()
    if (current) {
      const createdAt = fs.existsSync(SHARED_TEXT_FILE)
        ? fs.statSync(SHARED_TEXT_FILE).mtimeMs
        : Date.now()
      history = [{ id: `seed-${createdAt}`, text: current, createdAt }]
      writeHistory(history)
    }
  }
  res.json({ history })
})

app.put('/api/shared-text', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : ''
  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) {
    return res.status(413).json({ message: '文字内容不能超过 2MB' })
  }
  if (!text.trim()) {
    return res.status(400).json({ message: '文字内容为空，未保存' })
  }
  const changed = readSharedText() !== text
  writeSharedText(text)
  if (changed) addHistory(text)
  res.json({ ok: true, updatedAt: Date.now() })
})

app.delete('/api/shared-text', (_req, res) => {
  writeSharedText('')
  res.json({ ok: true })
})

app.delete('/api/shared-text/history', (_req, res) => {
  writeHistory([])
  res.json({ ok: true, cleared: true })
})

app.delete('/api/shared-text/history/:id', (req, res) => {
  const targetId = String(req.params.id || '')
  const history = readHistory()
  const nextHistory = history.filter(item => String(item?.id || '') !== targetId)
  if (nextHistory.length === history.length) {
    return res.status(404).json({ message: '记录不存在或已被删除' })
  }
  writeHistory(nextHistory)
  res.json({ ok: true, removed: targetId, remaining: nextHistory.length })
})

app.post('/api/upload', (req, res) => {
  // 大文件上传期间不设读写超时，避免 20GB 传输被中途掐断
  req.setTimeout(0)
  res.setTimeout(0)

  upload.single('file')(req, res, err => {
    if (err) {
      if (req.file?.path) {
        fs.promises.unlink(req.file.path).catch(() => {})
      }
      if (res.headersSent) return
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: `单个文件不能超过 ${formatLimit(MAX_FILE_SIZE)}` })
      }
      return res.status(400).json({ message: err.message || '上传失败' })
    }
    if (!req.file) {
      return res.status(400).json({ message: '没有选择文件' })
    }
    logAction(req, 'upload', { name: req.file.filename, size: req.file.size, mode: 'direct' })
    res.json({ file: fileInfo(req.file.filename, fs.statSync(req.file.path)) })
  })
})

app.get('/files/:name', (req, res) => {
  const name = String(req.params.name || '').replace(/\\/g, '/')
  const filePath = resolveUploadFile(name)
  if (!filePath) {
    return res.status(400).send('非法文件名')
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).send('文件不存在')
  }
  noteDownload(req, name)
  res.setTimeout(0)
  res.download(filePath, displayNameOf(name))
})

// 内联播放通道：Content-Disposition 为 inline，配合 send 模块的 Range 支持实现拖动进度
app.get('/media/:name', (req, res) => {
  const name = String(req.params.name || '').replace(/\\/g, '/')
  const filePath = resolveUploadFile(name)
  if (!filePath) {
    return res.status(400).send('非法文件名')
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).send('文件不存在')
  }
  noteDownload(req, name)

  const mime = mimeOf(name)
  const showName = displayNameOf(name).replace(/"/g, "'")
  const headers = {
    'Content-Disposition': `inline; filename="${showName}"; filename*=UTF-8''${encodeURIComponent(showName)}`,
    'Cache-Control': 'public, max-age=3600',
    'Accept-Ranges': 'bytes'
  }
  if (mime) headers['Content-Type'] = mime

  res.setTimeout(0)
  res.sendFile(filePath, { headers, acceptRanges: true }, err => {
    if (!err) return
    if (err.code === 'ECONNABORTED' || res.headersSent) return
    if (!res.headersSent) res.status(err.status || 404).end()
  })
})

app.delete('/api/files/:name', (req, res) => {
  const name = String(req.params.name || '').replace(/\\/g, '/')
  const filePath = resolveUploadFile(name)
  if (!filePath) {
    return res.status(400).json({ message: '非法文件名' })
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: '文件不存在' })
  }
  // V3.0：删除改为移入回收站，可随时恢复
  const result = moveToTrash(req, name, 'manual')
  if (!result.ok) {
    return res.status(500).json({ message: result.error || '移入回收站失败' })
  }
  logAction(req, 'delete', { name, trashId: result.item?.id })
  res.json({ ok: true, trashId: result.item?.id })
})

// ---------- V3.0 扩展能力挂载 ----------
attachV3(app, {
  rootDir: __dirname,
  uploadDir: UPLOAD_DIR,
  requireAuth,
  isLocalAddress,
  safeName,
  displayNameOf,
  mediaTypeOf,
  mimeOf,
  listFiles,
  buildAccessUrls,
  pickBestLanUrl,
  port: PORT,
  maxFileSize: MAX_FILE_SIZE,
  formatLimit,
  directSign
})

app.use((err, _req, res, _next) => {
  console.error(err)
  if (res.headersSent) return
  res.status(500).json({ message: '服务器内部错误' })
})

const server = app.listen(PORT, HOST, () => {
  console.log(`LAN File Share V3.0 running:`)
  lanUrls().forEach(url => console.log(`  ${url}`))
  console.log(`Upload dir: ${UPLOAD_DIR}`)
  console.log(`Max file size: ${formatLimit(MAX_FILE_SIZE)}`)
  console.log(`Access gate: password required for /api/files, /api/upload, /api/shared-text, /files, /media`)
})

// Node 18+ 默认 requestTimeout 为 5 分钟，20GB 上传/大文件下载必须放开
server.requestTimeout = 0
server.headersTimeout = 120 * 1000
server.keepAliveTimeout = 130 * 1000
server.timeout = 0
