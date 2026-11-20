import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import express from 'express'
import QRCode from 'qrcode'

// ============================================================
// V3.0 扩展能力：打包下载 / 分享直链 / 分片续传 / 文件夹上传 /
// 回收站 / 操作日志 / 磁盘监控 / 二维码 / 定时清理
// ============================================================

let CTX = null
let accessMap = null
let accessDirty = false
let accessTimer = null
let cleanupTimer = null

const CHUNK_SIZE = 8 * 1024 * 1024
const MAX_ZIP_FILES = 300
const LOG_ROTATE_BYTES = 5 * 1024 * 1024
const CHUNK_STALE_MS = 7 * 24 * 60 * 60 * 1000

function ctx() {
  if (!CTX) throw new Error('V3 模块尚未初始化')
  return CTX
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const value = JSON.parse(raw)
    return value ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  try {
    ensureDir(path.dirname(file))
    // 临时文件名带进程号+随机串：并发写入同一文件时不再共用同一 tmp，避免互相覆盖后 rename 失败
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    console.warn('[v3] 写入失败：', file, error.message)
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

// ---------- 路径安全 ----------
function normalizeRel(input) {
  const raw = String(input || '').replace(/\\/g, '/')
  const parts = raw.split('/').filter(part => part && part !== '.')
  if (!parts.length) return null
  for (const part of parts) {
    if (part === '..') return null
    if (part.startsWith('.')) return null
  }
  return parts.join('/')
}

function normalizeDir(input) {
  const rel = normalizeRel(input)
  if (!rel) return ''
  const parts = rel.split('/').map(part => ctx().safeName(part)).filter(Boolean)
  return parts.join('/')
}

function resolveInUpload(relInput) {
  const rel = normalizeRel(relInput)
  if (!rel) return null
  const uploadDir = ctx().uploadDir
  const abs = path.resolve(uploadDir, rel)
  if (abs === uploadDir) return null
  if (!abs.startsWith(uploadDir + path.sep)) return null
  return abs
}

function sizeOf(target) {
  try {
    const stat = fs.statSync(target)
    if (!stat.isDirectory()) return stat.size
    let total = 0
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      total += sizeOf(path.join(target, entry.name))
    }
    return total
  } catch {
    return 0
  }
}

function clientIp(req) {
  const raw = req?.socket?.remoteAddress || ''
  return String(raw).replace(/^::ffff:/, '')
}

// ---------- 计数去重：避免 Range 分段、续传、拖动进度条把一次访问算成数百次 ----------
// 统计口径：请求头无 Range（完整下载）或以 bytes=0- 开头（起始请求）才算一次真实访问；
// bytes=1024-、bytes=5242880-52428800 之类的续传/seek 分段一律不计。
const COUNT_DEDUPE_WINDOW_MS = 30 * 60 * 1000
const downloadSeen = new Map() // `${ip}|${文件相对路径}` -> 最近计数时间
const shareHitSeen = new Map() // `${ip}|${token}` -> 最近计数时间

function isSegmentRequest(req) {
  const raw = req?.headers?.range
  if (!raw) return false
  const value = String(raw).trim().toLowerCase()
  return !value.startsWith('bytes=0-')
}

function dedupeCount(store, key, windowMs = COUNT_DEDUPE_WINDOW_MS) {
  const now = Date.now()
  if (store.size > 500) {
    for (const [entryKey, ts] of store) {
      if (now - ts >= windowMs) store.delete(entryKey)
    }
  }
  const last = store.get(key)
  if (last && now - last < windowMs) return false
  store.set(key, now)
  return true
}

// ---------- 操作日志 ----------
function logPath() {
  return path.join(ctx().dataDir, 'operation-log.jsonl')
}

function pruneRotatedLogs() {
  try {
    const dir = ctx().dataDir
    const files = fs.readdirSync(dir).filter(name => /^operation-log\.\d+\.jsonl$/.test(name)).sort()
    while (files.length > 3) {
      const victim = files.shift()
      try { fs.unlinkSync(path.join(dir, victim)) } catch {}
    }
  } catch {}
}

function appendLog(entry) {
  try {
    ensureDir(ctx().dataDir)
    const file = logPath()
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_ROTATE_BYTES) {
      try { fs.renameSync(file, path.join(ctx().dataDir, `operation-log.${Date.now()}.jsonl`)) } catch {}
      pruneRotatedLogs()
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (error) {
    console.warn('[v3] 日志写入失败：', error.message)
  }
}

// UA -> 可读设备名（形如 Windows·Chrome、iPhone·Safari、Android·微信内置浏览器）
// 解析不出时返回空串，由前端回退展示，绝不返回 undefined
export function describeDevice(uaRaw) {
  const ua = typeof uaRaw === 'string' ? uaRaw : ''
  if (!ua) return ''

  let os = ''
  if (/iPhone|iPod/i.test(ua)) os = 'iPhone'
  else if (/iPad/i.test(ua)) os = 'iPad'
  else if (/HarmonyOS|OpenHarmony/i.test(ua)) os = 'HarmonyOS'
  else if (/Android/i.test(ua)) os = 'Android'
  else if (/Windows NT 10/i.test(ua)) os = 'Windows'
  else if (/Windows/i.test(ua)) os = 'Windows'
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'macOS'
  else if (/CrOS/i.test(ua)) os = 'ChromeOS'
  else if (/Linux/i.test(ua)) os = 'Linux'

  let browser = ''
  if (/MicroMessenger/i.test(ua)) browser = '微信内置浏览器'
  else if (/wxwork/i.test(ua)) browser = '企业微信'
  else if (/DingTalk/i.test(ua)) browser = '钉钉'
  else if (/EdgA?|EdgiOS/i.test(ua)) browser = 'Edge'
  else if (/OPR|Opera|OPiOS/i.test(ua)) browser = 'Opera'
  else if (/Firefox|FxiOS/i.test(ua)) browser = 'Firefox'
  else if (/CriOS|Chrome/i.test(ua)) browser = 'Chrome'
  else if (/Safari/i.test(ua)) browser = 'Safari'
  else if (/MSIE|Trident/i.test(ua)) browser = 'IE'

  if (os && browser) return `${os}·${browser}`
  if (os) return os
  if (browser) return browser
  return ''
}

function clientUa(req) {
  const raw = req?.headers?.['user-agent'] || ''
  const ua = String(raw).replace(/\s+/g, ' ').trim()
  return ua.slice(0, 300)
}

export function logAction(req, action, extra = {}) {
  if (!CTX) return
  const ip = clientIp(req)
  const ua = clientUa(req)
  appendLog({
    ts: Date.now(),
    action,
    ip,
    ua,
    device: describeDevice(ua),
    local: ctx().isLocalAddress(req?.socket?.remoteAddress),
    ...extra
  })
}

function readLogs(limit, action) {
  const file = logPath()
  if (!fs.existsSync(file)) return { items: [], total: 0 }
  let lines = []
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return { items: [], total: 0 }
  }
  const parsed = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let item = null
    try { item = JSON.parse(lines[index]) } catch { continue }
    if (action && action !== 'all' && item.action !== action) continue
    // 兼容历史日志：旧记录可能没有 device 字段（甚至没有 ua），一律补成字符串，避免前端拿到 undefined
    if (!item.device && item.ua) item.device = describeDevice(item.ua)
    if (typeof item.device !== 'string') item.device = ''
    if (typeof item.ip !== 'string') item.ip = item.ip ? String(item.ip) : ''
    parsed.push(item)
    if (parsed.length >= limit) break
  }
  return { items: parsed, total: lines.length }
}

// ---------- 最近访问时间（供定时清理判断） ----------
function loadAccessMap() {
  if (accessMap) return accessMap
  accessMap = readJson(path.join(ctx().dataDir, 'last-access.json'), {})
  if (typeof accessMap !== 'object' || Array.isArray(accessMap)) accessMap = {}
  return accessMap
}

function flushAccessMap() {
  if (!accessDirty || !accessMap) return
  accessDirty = false
  writeJson(path.join(ctx().dataDir, 'last-access.json'), accessMap)
}

export function noteDownload(req, name) {
  if (!CTX || !name) return false
  // 访问时间始终刷新：播放中的分段请求同样说明文件在用，避免定时清理误判为闲置
  const map = loadAccessMap()
  map[name] = Date.now()
  accessDirty = true
  if (!accessTimer) {
    accessTimer = setTimeout(() => {
      accessTimer = null
      flushAccessMap()
    }, 2000)
    accessTimer.unref?.()
  }
  // 续传 / 拖动进度条产生的分段请求不计入下载记录
  if (isSegmentRequest(req)) return false
  // 同一 IP 对同一文件 30 分钟内只记一次
  if (!dedupeCount(downloadSeen, `${clientIp(req)}|${name}`)) return false
  logAction(req, 'download', { name })
  return true
}

function lastAccessOf(rel, stat) {
  const map = loadAccessMap()
  return Math.max(Number(map[rel]) || 0, Number(stat?.mtimeMs) || 0, Number(stat?.atimeMs) || 0)
}

// ---------- 回收站 ----------
function trashIndexPath() {
  return path.join(ctx().trashDir, 'index.json')
}

function readTrashIndex() {
  const list = readJson(trashIndexPath(), [])
  return Array.isArray(list) ? list : []
}

function writeTrashIndex(list) {
  writeJson(trashIndexPath(), list)
}

export async function moveToTrash(req, relInput, reason = 'manual') {
  const rel = normalizeRel(relInput)
  if (!rel) return { ok: false, error: '非法文件名' }
  const abs = resolveInUpload(rel)
  if (!abs || !fs.existsSync(abs)) return { ok: false, error: '文件不存在' }

  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
  const base = path.basename(abs)
  const dir = path.join(ctx().trashDir, 'items', id)
  ensureDir(dir)
  const stored = path.join(dir, base)
  try {
    fs.renameSync(abs, stored)
  } catch (renameError) {
    // 跨盘或权限导致的 rename 失败：先完整复制，再删除源文件，全部成功后才写索引
    try {
      await fsp.cp(abs, stored, { recursive: true })
      await fsp.rm(abs, { recursive: true, force: true })
    } catch (error) {
      try { await fsp.rm(stored, { recursive: true, force: true }) } catch {}
      return { ok: false, error: `移入回收站失败：${error.message || renameError.message}` }
    }
  }

  const stat = fs.existsSync(stored) ? fs.statSync(stored) : null
  if (!stat) return { ok: false, error: '移入回收站失败：目标文件不存在' }
  const item = {
    id,
    name: rel,
    base,
    size: stat.isDirectory() ? 0 : stat.size,
    isDir: stat.isDirectory(),
    deletedAt: Date.now(),
    stored: path.join('items', id, base),
    ip: clientIp(req),
    local: ctx().isLocalAddress(req?.socket?.remoteAddress),
    reason
  }
  const list = readTrashIndex()
  list.unshift(item)
  writeTrashIndex(list)

  // 清理空的上级目录（文件夹上传可能留下空壳）
  cleanupEmptyParents(abs)
  return { ok: true, item }
}

function cleanupEmptyParents(abs) {
  const uploadDir = ctx().uploadDir
  let dir = path.dirname(abs)
  while (dir.startsWith(uploadDir + path.sep)) {
    try {
      if (fs.readdirSync(dir).length > 0) break
      fs.rmdirSync(dir)
    } catch {
      break
    }
    dir = path.dirname(dir)
  }
}

function uniqueTargetDir(target) {
  if (!fs.existsSync(target)) return target
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const stem = path.basename(target, ext)
  for (let index = 1; index < 200; index += 1) {
    const candidate = path.join(dir, `${stem}(恢复${index})${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`)
}

// ---------- 分享链接 ----------
function sharesPath() {
  return path.join(ctx().dataDir, 'shares.json')
}

let sharesCache = null
let sharesWriteChain = Promise.resolve()

function loadSharesCache() {
  if (sharesCache) return sharesCache
  const file = sharesPath()
  try {
    if (!fs.existsSync(file)) {
      sharesCache = {}
      return sharesCache
    }
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) {
      // 空文件多为此前写入被中断，按空集合处理
      sharesCache = {}
      return sharesCache
    }
    const value = JSON.parse(raw)
    sharesCache = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch (error) {
    // 解析失败时先留现场，绝不静默用 {} 覆盖历史记录
    try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
    console.warn('[v3] shares.json 解析失败，已备份损坏文件并重置：', error.message)
    sharesCache = {}
  }
  return sharesCache
}

// 串行落盘：所有分享记录变更共用一条 Promise 链，避免并发读-改-写互相覆盖
function persistShares() {
  const target = sharesPath()
  const payload = JSON.stringify(sharesCache || {}, null, 2)
  sharesWriteChain = sharesWriteChain.then(() => {
    try {
      ensureDir(path.dirname(target))
      const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
      fs.writeFileSync(tmp, payload, 'utf8')
      fs.renameSync(tmp, target)
    } catch (error) {
      console.warn('[v3] shares.json 写入失败：', error.message)
    }
  })
  return sharesWriteChain
}

function mutateShares(mutator) {
  const shares = loadSharesCache()
  const result = mutator(shares)
  persistShares()
  return result
}

function readShares() {
  return loadSharesCache()
}

function writeShares() {
  return persistShares()
}

function createShare(rel, ttlHours) {
  const token = crypto.randomBytes(9).toString('base64url')
  const hours = Number(ttlHours)
  const expiresAt = Number.isFinite(hours) && hours > 0 ? Date.now() + hours * 3600 * 1000 : null
  const item = { token, name: rel, createdAt: Date.now(), expiresAt, hits: 0 }
  mutateShares(shares => {
    shares[token] = item
  })
  return item
}

function resolveShare(token) {
  if (!token) return null
  const shares = readShares()
  if (!hasOwn(shares, token)) return null
  const item = shares[token]
  if (!item || typeof item !== 'object') return null
  if (item.expiresAt && item.expiresAt <= Date.now()) return null
  return item
}

// 访问次数只统计一次真实打开：起始请求（无 Range 或 bytes=0-）+ 同 token 同 IP 30 分钟去重
function bumpShareHit(req, token) {
  if (!token) return false
  if (isSegmentRequest(req)) return false
  if (!dedupeCount(shareHitSeen, `${clientIp(req)}|${token}`)) return false
  let opened = null
  mutateShares(shares => {
    if (!hasOwn(shares, token)) return
    const item = shares[token]
    if (!item || typeof item !== 'object') return
    item.hits = Number(item.hits || 0) + 1
    item.lastHitAt = Date.now()
    opened = item
  })
  if (opened) logAction(req, 'share-open', { token, name: opened.name })
  return Boolean(opened)
}

// ---------- 定时清理状态 ----------
function statePath() {
  return path.join(ctx().dataDir, 'v3-state.json')
}

function readState() {
  const value = readJson(statePath(), {})
  const autoClean = value?.autoClean || {}
  return {
    autoClean: {
      enabled: autoClean.enabled === true,
      days: Math.max(1, Number(autoClean.days) || 30),
      intervalHours: Math.max(1, Number(autoClean.intervalHours) || 6),
      lastRunAt: Number(autoClean.lastRunAt) || 0,
      lastResult: autoClean.lastResult || null
    }
  }
}

function writeState(state) {
  writeJson(statePath(), state)
}

function cleanupCandidates(days) {
  const span = Math.max(1, Number(days) || 30) * 24 * 3600 * 1000
  const now = Date.now()
  const rows = ctx().listFiles()
  return rows
    .map(file => {
      const abs = resolveInUpload(file.name)
      let stat = null
      try { stat = abs ? fs.statSync(abs) : null } catch {}
      const last = lastAccessOf(file.name, stat)
      return { name: file.name, size: file.size, lastAccessAt: last, idleDays: Number(((now - last) / 86400000).toFixed(1)) }
    })
    .filter(row => now - row.lastAccessAt > span)
    .sort((a, b) => a.lastAccessAt - b.lastAccessAt)
}

async function runCleanup(req, days, reason = 'auto-clean') {
  const rows = cleanupCandidates(days)
  const moved = []
  const failed = []
  for (const row of rows) {
    try {
      const result = await moveToTrash(req, row.name, reason)
      if (result.ok) moved.push({ name: row.name, size: row.size })
      else failed.push({ name: row.name, error: result.error })
    } catch (error) {
      failed.push({ name: row.name, error: error.message || '清理失败' })
    }
  }
  logAction(req, 'cleanup', { days: Number(days) || 30, moved: moved.length, failed: failed.length, reason })
  const state = readState()
  state.autoClean.lastRunAt = Date.now()
  state.autoClean.lastResult = { at: Date.now(), moved: moved.length, failed: failed.length, days: Number(days) || 30 }
  writeState(state)
  return { moved, failed }
}

function startCleanupScheduler() {
  const run = async () => {
    try {
      const state = readState()
      const conf = state.autoClean
      if (!conf.enabled) return
      if (Date.now() - conf.lastRunAt < conf.intervalHours * 3600 * 1000) return
      await runCleanup({ socket: { remoteAddress: '::1' } }, conf.days, 'auto-clean')
      flushAccessMap()
    } catch (error) {
      console.warn('[v3] 定时清理失败：', error.message)
    }
  }
  cleanupTimer = setInterval(run, 30 * 60 * 1000)
  cleanupTimer.unref?.()
}

// ---------- 磁盘 ----------
function diskInfo() {
  try {
    const stat = fs.statfsSync(ctx().uploadDir)
    const total = Number(stat.blocks) * Number(stat.bsize)
    const free = Number(stat.bavail) * Number(stat.bsize)
    const used = Math.max(0, total - free)
    return { total, free, used, usedRatio: total ? used / total : 0, uploadsSize: sizeOf(ctx().uploadDir) }
  } catch (error) {
    return { error: error.message }
  }
}

// ---------- 打包下载 ----------
function safeZipName(input, used) {
  let name = String(input || 'file').replace(/[\\/:*?"<>|]/g, '_').trim()
  name = name.replace(/^\.+/, '') || 'file'
  if (name.length > 120) {
    const ext = path.extname(name)
    name = name.slice(0, 120 - ext.length) + ext
  }
  let candidate = name
  let index = 2
  while (used.has(candidate)) {
    const ext = path.extname(name)
    const stem = path.basename(name, ext)
    candidate = `${stem}(${index})${ext}`
    index += 1
  }
  used.add(candidate)
  return candidate
}

function sanitizeDateTimeForName(date) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

// ---------- 分片上传 ----------
function uploadJsonPath(id) {
  return path.join(ctx().chunkDir, `${id}.json`)
}

function uploadPartPath(id) {
  return path.join(ctx().chunkDir, `${id}.part`)
}

function readUploadMeta(id) {
  if (!/^[a-f0-9]{8,64}$/.test(String(id || ''))) return null
  return readJson(uploadJsonPath(id), null)
}

function cleanupStaleChunks() {
  try {
    const now = Date.now()
    for (const name of fs.readdirSync(ctx().chunkDir)) {
      const file = path.join(ctx().chunkDir, name)
      try {
        const stat = fs.statSync(file)
        if (now - stat.mtimeMs > CHUNK_STALE_MS) fs.unlinkSync(file)
      } catch {}
    }
  } catch {}
}

// ============================================================
// 路由注册
// ============================================================
export function attachV3(app, options) {
  CTX = {
    rootDir: options.rootDir,
    uploadDir: options.uploadDir,
    dataDir: path.join(options.rootDir, 'data'),
    trashDir: path.join(options.rootDir, 'data', 'trash'),
    chunkDir: path.join(options.rootDir, 'data', 'chunks'),
    zipTmpDir: path.join(options.rootDir, 'data', 'zip-tmp'),
    requireAuth: options.requireAuth,
    isLocalAddress: options.isLocalAddress,
    safeName: options.safeName,
    displayNameOf: options.displayNameOf,
    mediaTypeOf: options.mediaTypeOf,
    mimeOf: options.mimeOf,
    listFiles: options.listFiles,
    buildAccessUrls: options.buildAccessUrls,
    pickBestLanUrl: options.pickBestLanUrl,
    port: options.port,
    maxFileSize: options.maxFileSize,
    formatLimit: options.formatLimit,
    directSign: options.directSign
  }

  ensureDir(CTX.dataDir)
  ensureDir(CTX.trashDir)
  ensureDir(CTX.chunkDir)
  ensureDir(CTX.zipTmpDir)
  loadAccessMap()
  cleanupStaleChunks()
  startCleanupScheduler()

  app.use(express.urlencoded({ extended: false, limit: '2mb' }))

  const api = express.Router()
  api.use(CTX.requireAuth)

  // ---- 磁盘与概览 ----
  api.get('/disk', (_req, res) => {
    res.json({ ...diskInfo(), maxFileSize: CTX.maxFileSize })
  })

  // ---- 二维码 ----
  // 二维码/分享地址选择：按访问者来源网段匹配真实网卡，排除虚拟网卡，绝不编码打码地址
  function qrTargetFor(req) {
    const remoteAddress = req.socket?.remoteAddress
    if (typeof CTX.pickBestLanUrl === 'function') {
      const picked = CTX.pickBestLanUrl({ port: CTX.port, remoteAddress })
      if (picked) return picked
    }
    return `http://localhost:${CTX.port}`
  }

  api.get('/qr-target', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ url: qrTargetFor(req) })
  })

  api.get('/qr', async (req, res) => {
    const requested = typeof req.query.url === 'string' ? req.query.url.trim() : ''
    // 打码地址（含 *）不可解析，直接忽略，回落到真实局域网地址
    const usable = /^https?:\/\//i.test(requested) && !requested.includes('*')
    const target = usable ? requested : qrTargetFor(req)
    try {
      const svg = await QRCode.toString(target, { type: 'svg', margin: 1, width: 240, errorCorrectionLevel: 'M' })
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.send(svg)
    } catch (error) {
      res.status(500).json({ message: `二维码生成失败：${error.message}` })
    }
  })

  // ---- 免密直链（电视 / 播放器可直接播放，不用输密码） ----
  api.get('/direct', (req, res) => {
    const rel = normalizeRel(req.query && req.query.name)
    const abs = rel ? resolveInUpload(rel) : null
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ message: '文件不存在' })
    }
    if (typeof CTX.directSign !== 'function') {
      return res.status(500).json({ message: '直链签名不可用' })
    }
    const sign = CTX.directSign(rel)
    const encoded = rel.split('/').map(segment => encodeURIComponent(segment)).join('/')
    logAction(req, 'share-create', { name: rel, mode: 'direct' })
    res.json({
      name: rel,
      sign,
      url: `/media/${encoded}?sign=${sign}`,
      downloadUrl: `/files/${encoded}?sign=${sign}`
    })
  })

  // ---- 打包下载 ----
  api.post('/zip', (req, res) => {
    req.setTimeout(0)
    res.setTimeout(0)
    let names = []
    try {
      const raw = req.body?.names
      names = Array.isArray(raw) ? raw : JSON.parse(String(raw || '[]'))
    } catch {
      return res.status(400).json({ message: '打包参数解析失败' })
    }
    if (!Array.isArray(names) || !names.length) return res.status(400).json({ message: '请先选择要打包的文件' })
    if (names.length > MAX_ZIP_FILES) return res.status(400).json({ message: `一次最多打包 ${MAX_ZIP_FILES} 个文件` })

    const entries = []
    for (const raw of names) {
      const rel = normalizeRel(raw)
      if (!rel) continue
      const abs = resolveInUpload(rel)
      if (!abs || !fs.existsSync(abs)) continue
      let stat = null
      try { stat = fs.statSync(abs) } catch { continue }
      if (!stat.isFile()) continue
      entries.push({ rel, abs, display: CTX.displayNameOf(rel).replace(/\//g, ' - ') })
    }
    if (!entries.length) return res.status(404).json({ message: '所选文件均不存在' })

    const stagingDir = path.join(CTX.zipTmpDir, crypto.randomUUID())
    ensureDir(stagingDir)
    const used = new Set()
    const stagedNames = []
    for (const entry of entries) {
      const name = safeZipName(entry.display, used)
      const target = path.join(stagingDir, name)
      try {
        fs.linkSync(entry.abs, target)
      } catch {
        try { fs.copyFileSync(entry.abs, target) } catch { continue }
      }
      stagedNames.push(name)
    }
    if (!stagedNames.length) {
      fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      return res.status(500).json({ message: '打包失败：文件暂存出错' })
    }

    const zipName = `局域网文件打包-${sanitizeDateTimeForName(new Date())}.zip`
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="archive.zip"; filename*=UTF-8''${encodeURIComponent(zipName)}`)
    res.setHeader('Cache-Control', 'no-store')
    logAction(req, 'zip', { count: stagedNames.length })

    const child = spawn('tar', ['--format', 'zip', '-cf', '-', ...stagedNames], {
      cwd: stagingDir,
      windowsHide: true
    })
    let failed = false
    child.on('error', error => {
      failed = true
      console.warn('[v3] 打包进程启动失败：', error.message)
      if (!res.headersSent) res.status(500).end('打包失败：系统缺少 tar 组件')
      else res.destroy()
    })
    child.stdout.pipe(res)
    child.stderr.on('data', chunk => {
      const text = String(chunk || '').trim()
      if (text) console.warn('[v3] 打包提示：', text)
    })
    const cleanup = () => {
      fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    }
    child.on('close', code => {
      cleanup()
      if (code !== 0 && !failed) console.warn('[v3] 打包退出码：', code)
    })
    res.on('close', () => {
      if (!child.killed) child.kill()
      cleanup()
    })
  })

  // ---- 分享链接 ----
  api.post('/share', (req, res) => {
    const rel = normalizeRel(req.body?.name)
    const abs = rel ? resolveInUpload(rel) : null
    if (!abs || !fs.existsSync(abs)) return res.status(404).json({ message: '文件不存在' })
    const ttlHours = req.body?.ttlHours === undefined ? 24 : Number(req.body.ttlHours)
    const share = createShare(rel, ttlHours)
    logAction(req, 'share-create', { name: rel, ttlHours: share.expiresAt ? ttlHours : 0 })
    res.json({ token: share.token, url: `/s/${share.token}`, expiresAt: share.expiresAt, name: rel })
  })

  api.get('/shares', (_req, res) => {
    const shares = readShares()
    const now = Date.now()
    const items = Object.values(shares)
      .map(item => ({ ...item, expired: Boolean(item.expiresAt && item.expiresAt <= now) }))
      .sort((a, b) => b.createdAt - a.createdAt)
    res.json({ items })
  })

  api.delete('/shares/:token', (req, res) => {
    const token = String(req.params.token || '')
    const removed = mutateShares(shares => {
      if (!hasOwn(shares, token)) return null
      const item = shares[token]
      if (!item || typeof item !== 'object') return null
      delete shares[token]
      return item
    })
    if (!removed) return res.status(404).json({ message: '链接不存在' })
    logAction(req, 'share-delete', { name: removed.name })
    res.json({ ok: true })
  })

  // ---- 回收站 ----
  api.get('/trash', (_req, res) => {
    const list = readTrashIndex()
    const totalSize = list.reduce((sum, item) => sum + (Number(item.size) || 0), 0)
    res.json({ items: list, totalSize })
  })

  api.post('/trash/restore', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []
    if (!ids.length) return res.status(400).json({ message: '未选择要恢复的项目' })
    const list = readTrashIndex()
    const restored = []
    const failed = []
    for (const id of ids) {
      const index = list.findIndex(item => item.id === id)
      if (index < 0) {
        failed.push({ id, error: '记录不存在' })
        continue
      }
      const item = list[index]
      const stored = path.join(CTX.trashDir, item.stored)
      if (!fs.existsSync(stored)) {
        failed.push({ id, error: '回收站内文件已丢失' })
        continue
      }
      const target = uniqueTargetDir(path.join(CTX.uploadDir, item.name))
      ensureDir(path.dirname(target))
      try {
        fs.renameSync(stored, target)
      } catch (error) {
        failed.push({ id, error: error.message })
        continue
      }
      list.splice(index, 1)
      restored.push({ id, name: item.name })
      logAction(req, 'restore', { name: item.name })
    }
    writeTrashIndex(list)
    res.json({ ok: failed.length === 0, restored, failed })
  })

  api.post('/trash/purge', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []
    if (!ids.length) return res.status(400).json({ message: '未选择要彻底删除的项目' })
    const list = readTrashIndex()
    const purged = []
    const remain = []
    const failed = []
    for (const item of list) {
      if (!ids.includes(item.id)) {
        remain.push(item)
        continue
      }
      const stored = path.join(CTX.trashDir, item.stored)
      try {
        await fsp.rm(stored, { recursive: true, force: true })
        purged.push(item.id)
        logAction(req, 'purge', { name: item.name })
      } catch (error) {
        failed.push({ id: item.id, error: error.message || '删除失败' })
        remain.push(item)
      }
    }
    writeTrashIndex(remain)
    res.json({ ok: failed.length === 0, purged, remaining: remain.length, failed })
  })

  api.delete('/trash', async (req, res) => {
    const list = readTrashIndex()
    const remain = []
    const failed = []
    for (const item of list) {
      const stored = path.join(CTX.trashDir, item.stored)
      try {
        await fsp.rm(stored, { recursive: true, force: true })
      } catch (error) {
        failed.push({ id: item.id, error: error.message || '删除失败' })
        remain.push(item)
      }
    }
    writeTrashIndex(remain)
    logAction(req, 'trash-empty', { count: list.length - remain.length })
    res.json({ ok: failed.length === 0, cleared: list.length - remain.length, failed })
  })

  // ---- 操作日志 ----
  api.get('/logs', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
    const action = String(req.query.action || 'all')
    const result = readLogs(limit, action)
    res.json({ ...result, actions: ['all', 'upload', 'download', 'delete', 'restore', 'purge', 'zip', 'share-create', 'share-open', 'cleanup'] })
  })

  api.delete('/logs', (_req, res) => {
    try { fs.writeFileSync(logPath(), '', 'utf8') } catch {}
    res.json({ ok: true })
  })

  // ---- 定时清理 ----
  api.get('/cleanup', (_req, res) => {
    res.json(readState())
  })

  api.post('/cleanup/config', (req, res) => {
    const state = readState()
    const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : state.autoClean.enabled
    const days = Number(req.body?.days)
    const intervalHours = Number(req.body?.intervalHours)
    state.autoClean.enabled = enabled
    if (Number.isFinite(days) && days >= 1) state.autoClean.days = Math.min(3650, Math.round(days))
    if (Number.isFinite(intervalHours) && intervalHours >= 1) state.autoClean.intervalHours = Math.min(720, Math.round(intervalHours))
    writeState(state)
    logAction(req, 'cleanup-config', { enabled: state.autoClean.enabled, days: state.autoClean.days, intervalHours: state.autoClean.intervalHours })
    res.json(state)
  })

  api.get('/cleanup/preview', (req, res) => {
    const state = readState()
    const days = Number(req.query.days) || state.autoClean.days
    const rows = cleanupCandidates(days)
    res.json({
      days,
      count: rows.length,
      totalSize: rows.reduce((sum, row) => sum + (Number(row.size) || 0), 0),
      items: rows.slice(0, 500),
      truncated: rows.length > 500,
      autoClean: state.autoClean
    })
  })

  api.post('/cleanup/run', async (req, res) => {
    const state = readState()
    const days = Number(req.body?.days) || state.autoClean.days
    try {
      const result = await runCleanup(req, days, 'manual-clean')
      res.json({ ok: true, days, moved: result.moved.length, failed: result.failed.length, items: result.moved, failures: result.failed })
    } catch (error) {
      res.status(500).json({ message: error.message || '清理失败' })
    }
  })

  // ---- 分片上传 / 断点续传 ----
  api.post('/upload/init', (req, res) => {
    const name = CTX.safeName(req.body?.name || 'file')
    const size = Number(req.body?.size || 0)
    if (!(size > 0)) return res.status(400).json({ message: '文件大小无效' })
    if (size > CTX.maxFileSize) { return res.status(413).json({ message: `单个文件不能超过 ${CTX.formatLimit(CTX.maxFileSize)}` }) }
    const dir = normalizeDir(req.body?.relativePath)
    // 仅靠名字/大小/修改时间会碰撞并串档；加入浏览器随机盐和内容采样指纹
    const fingerprint = String(req.body?.fingerprint || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 96)
    const id = crypto.createHash('sha1').update(`${fingerprint}|${dir}|${name}|${size}`).digest('hex').slice(0, 32)
    const metaPath = uploadJsonPath(id)
    let meta = readJson(metaPath, null)
    if (!meta || meta.size !== size || meta.name !== name || meta.dir !== dir) {
      meta = { id, name, size, dir, createdAt: Date.now() }
      writeJson(metaPath, meta)
      try { fs.writeFileSync(uploadPartPath(id), '') } catch {}
    }
    ensureDir(CTX.chunkDir)
    if (!fs.existsSync(uploadPartPath(id))) fs.writeFileSync(uploadPartPath(id), '')
    const received = fs.statSync(uploadPartPath(id)).size
    res.json({ uploadId: id, chunkSize: CHUNK_SIZE, received, size, resumed: received > 0, name, dir })
  })

  api.post('/upload/chunk', express.raw({ type: () => true, limit: '16mb' }), async (req, res) => {
    req.setTimeout(0)
    const id = String(req.headers['x-upload-id'] || '')
    const meta = readUploadMeta(id)
    if (!meta) return res.status(404).json({ message: '上传任务不存在或已失效' })
    const offset = Number(req.headers['x-offset'] || 0)
    const partPath = uploadPartPath(id)
    const current = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0
    if (!Number.isFinite(offset) || offset !== current) {
      return res.status(409).json({ message: '分片偏移不一致，请重新同步', received: current })
    }
    const buffer = req.body
    if (!Buffer.isBuffer(buffer) || !buffer.length) return res.status(400).json({ message: '分片内容为空' })
    if (current + buffer.length > meta.size) return res.status(413).json({ message: '分片超出文件大小' })
    try {
      await fsp.appendFile(partPath, buffer)
    } catch (error) {
      return res.status(500).json({ message: error.message || '分片写入失败' })
    }
    res.json({ received: current + buffer.length, size: meta.size })
  })

  api.get('/upload/status', (req, res) => {
    const meta = readUploadMeta(String(req.query.uploadId || ''))
    if (!meta) return res.status(404).json({ message: '上传任务不存在' })
    const partPath = uploadPartPath(meta.id)
    const received = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0
    res.json({ uploadId: meta.id, received, size: meta.size, name: meta.name, dir: meta.dir })
  })

  api.post('/upload/complete', (req, res) => {
    const meta = readUploadMeta(String(req.body?.uploadId || ''))
    if (!meta) return res.status(404).json({ message: '上传任务不存在' })
    const partPath = uploadPartPath(meta.id)
    if (!fs.existsSync(partPath)) return res.status(404).json({ message: '分片数据不存在' })
    const size = fs.statSync(partPath).size
    if (size !== meta.size) return res.status(409).json({ message: '文件尚未上传完成', received: size, size: meta.size })

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const finalName = `${stamp}-${crypto.randomUUID().slice(0, 8)}-${meta.name}`
    const targetDir = meta.dir ? path.join(CTX.uploadDir, meta.dir) : CTX.uploadDir
    ensureDir(targetDir)
    const target = path.join(targetDir, finalName)
    try {
      fs.renameSync(partPath, target)
    } catch (error) {
      try { fs.copyFileSync(partPath, target) } catch (copyError) {
        return res.status(500).json({ message: `保存失败：${copyError.message}` })
      }
      try { fs.unlinkSync(partPath) } catch {}
    }
    try { fs.unlinkSync(uploadJsonPath(meta.id)) } catch {}

    const rel = meta.dir ? `${meta.dir}/${finalName}` : finalName
    logAction(req, 'upload', { name: rel, size: meta.size, mode: 'chunked' })
    res.json({ ok: true, name: rel, size: meta.size, path: rel })
  })

  api.delete('/upload', (req, res) => {
    const id = String(req.query.uploadId || req.body?.uploadId || '')
    const meta = readUploadMeta(id)
    if (!meta) return res.status(404).json({ message: '上传任务不存在' })
    try { fs.unlinkSync(uploadPartPath(id)) } catch {}
    try { fs.unlinkSync(uploadJsonPath(id)) } catch {}
    res.json({ ok: true })
  })

  app.use('/api/v3', api)

  // ---- 分享链接访问（无需密码） ----
  app.get('/s/:token', (req, res) => {
    const share = resolveShare(req.params.token)
    if (!share) return res.status(410).send('分享链接已过期或不存在')
    const abs = resolveInUpload(share.name)
    if (!abs || !fs.existsSync(abs)) return res.status(404).send('文件不存在')
    bumpShareHit(req, share.token)
    noteDownload(req, share.name)
    res.setTimeout(0)
    const mediaType = CTX.mediaTypeOf(share.name)
    if (mediaType === 'file') {
      return res.download(abs, CTX.displayNameOf(share.name))
    }
    const mime = CTX.mimeOf(share.name) || 'application/octet-stream'
    const showName = CTX.displayNameOf(share.name).replace(/"/g, "'")
    res.sendFile(abs, {
      acceptRanges: true,
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `inline; filename="${showName}"; filename*=UTF-8''${encodeURIComponent(showName)}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      }
    }, err => {
      if (!err) return
      if (err.code === 'ECONNABORTED' || res.headersSent) return
      if (!res.headersSent) res.status(err.status || 404).end()
    })
  })

  return {
    diskInfo,
    readState,
    readTrashIndex,
    readShares
  }
}
