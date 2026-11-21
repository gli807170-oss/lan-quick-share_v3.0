import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
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
const LOG_COMPRESS_BYTES = 10 * 1024 * 1024
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

function asciiHeaderName(name) {
  const value = String(name || '').replace(/[\r\n]/g, '_')
  const ascii = value.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'").trim()
  return ascii || 'file'
}

function inlineDispositionOf(name) {
  const shown = CTX.displayNameOf(name)
  return `inline; filename="${asciiHeaderName(shown)}"; filename*=UTF-8''${encodeURIComponent(shown)}`
}

// ---------- 路径安全 ----------
function normalizeRel(input) {
  const raw = String(input || '').replace(/\\/g, '/')
  const parts = raw.split('/').filter(part => part && part !== '.')
  if (!parts.length) return null
  for (const part of parts) {
    if (part === '..' || part === '.') return null
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

// ---------- 操作日志（统一存放于项目根目录 LOG/） ----------
function logDir() {
  return path.join(ctx().rootDir, 'LOG')
}

// 三类结构化日志，统一命名 <kind>-log.jsonl
const LOG_KINDS = ['operation', 'detail', 'access']
function logPath(kind = 'operation') {
  return path.join(logDir(), `${kind}-log.jsonl`)
}

// 迁移历史日志：把 data/ 下的旧日志搬到 LOG/，避免散落两处
function migrateLegacyLogs() {
  const dataDir = ctx().dataDir
  const target = logDir()
  try { ensureDir(target) } catch {}
  const collect = (dir) => {
    try {
      for (const name of fs.readdirSync(dir)) {
        // 只收拢本应用的结构化 JSONL 日志；旧的重定向 .log 已废弃，不再迁移
        if (!/^(operation|detail|access)-log.*\.jsonl(\.gz)?$/.test(name)) continue
        const from = path.join(dir, name)
        const to = path.join(target, name)
        try {
          if (!fs.existsSync(to)) fs.renameSync(from, to)
        } catch {}
      }
    } catch {}
  }
  collect(dataDir)
  collect(ctx().rootDir)
}

// 日志达到 10MB 时压缩归档：按「时间节点 + 日志类型」命名，永久保留
// 归档完成后清空活动日志，以当前时间节点开启新日志
function compressLogsIfNeeded(kind = 'operation') {
  const src = logPath(kind)
  let size = 0
  try { size = fs.statSync(src).size } catch { return }
  if (size < LOG_COMPRESS_BYTES) return
  const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean)
  if (!lines.length) return
  const groups = new Map()
  for (const line of lines) {
    let item = null
    try { item = JSON.parse(line) } catch { continue }
    const action = typeof item.action === 'string' && item.action ? item.action : 'other'
    if (!groups.has(action)) groups.set(action, [])
    groups.get(action).push(line)
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
  for (const [action, groupLines] of groups) {
    const safeAction = action.replace(/[^a-zA-Z0-9-_]/g, '_')
    const out = path.join(logDir(), `${kind}-log.${stamp}.${safeAction}.jsonl.gz`)
    try {
      fs.writeFileSync(out, zlib.gzipSync(`${groupLines.join('\n')}\n`))
    } catch (error) {
      console.warn('[v3] 日志压缩失败：', error.message)
    }
  }
  try { fs.writeFileSync(src, '') } catch {}
}

function appendLogTo(kind, entry) {
  try {
    ensureDir(logDir())
    const file = logPath(kind)
    compressLogsIfNeeded(kind)
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (error) {
    console.warn('[v3] 日志写入失败：', error.message)
  }
}

function appendLog(entry) {
  appendLogTo('operation', entry)
}

// 读取某类日志的全部条目（含 gz 归档），供统计聚合使用
function readAllLogEntries(kind = 'operation') {
  const dir = logDir()
  const prefix = `${kind}-log`
  const groups = []
  try {
    const archives = fs.readdirSync(dir).filter(name => new RegExp(`^${prefix}\\..*\\.jsonl\\.gz$`).test(name)).sort()
    for (const name of archives) {
      try {
        groups.push(zlib.gunzipSync(fs.readFileSync(path.join(dir, name))).toString('utf8').split('\n').filter(Boolean))
      } catch {}
    }
  } catch {}
  const file = logPath(kind)
  if (fs.existsSync(file)) {
    try { groups.push(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) } catch {}
  }
  const entries = []
  for (const lines of groups) {
    for (const line of lines) {
      try { entries.push(JSON.parse(line)) } catch {}
    }
  }
  return entries
}

// 详细日志：记录所有设备及 IP 的访问与动作（供 server.js 中间件调用）
export function writeDetailLog(entry) {
  appendLogTo('detail', entry)
}

// 启动日志：记录服务启动信息
export function writeStartupLog(entry) {
  appendLogTo('access', entry)
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

function readLogs(limit, action, kind = 'operation') {
  const dir = logDir()
  const chunks = []
  const prefix = `${kind}-log`
  // 归档（.gz）按文件名倒序：文件名内嵌时间戳，越新越靠后
  try {
    const archives = fs.readdirSync(dir).filter(name => new RegExp(`^${prefix}\\..*\\.jsonl\\.gz$`).test(name)).sort().reverse()
    for (const name of archives) {
      try {
        const text = zlib.gunzipSync(fs.readFileSync(path.join(dir, name))).toString('utf8')
        chunks.push(text.split('\n').filter(Boolean))
      } catch {}
    }
  } catch {}
  // 当前活动日志
  const file = logPath(kind)
  if (fs.existsSync(file)) {
    try { chunks.push(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) } catch {}
  }
  const total = chunks.reduce((sum, group) => sum + group.length, 0)
  const parsed = []
  outer: for (let g = chunks.length - 1; g >= 0; g -= 1) {
    const lines = chunks[g]
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let item = null
      try { item = JSON.parse(lines[index]) } catch { continue }
      if (action && action !== 'all' && item.action !== action) continue
      if (!item.device && item.ua) item.device = describeDevice(item.ua)
      if (typeof item.device !== 'string') item.device = ''
      if (typeof item.ip !== 'string') item.ip = item.ip ? String(item.ip) : ''
      parsed.push(item)
      if (parsed.length >= limit) break outer
    }
  }
  return { items: parsed, total }
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
  const now = Date.now()
  // 复用：同名且未过期的链接直接返回，避免重复生成浪费资源
  const existing = Object.values(readShares()).find(item =>
    item && item.name === rel && (!item.expiresAt || item.expiresAt > now))
  if (existing) return { item: existing, reused: true }

  const token = crypto.randomBytes(9).toString('base64url')
  const hours = Number(ttlHours)
  const expiresAt = Number.isFinite(hours) && hours > 0 ? now + hours * 3600 * 1000 : null
  const item = { token, name: rel, createdAt: now, expiresAt, hits: 0 }
  mutateShares(shares => {
    shares[token] = item
  })
  return { item, reused: false }
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

function collectZipEntries(absDir, relBase = '', depth = 0, out = []) {
  if (depth > 8) return out
  let entries = []
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith('.')) continue
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name
    const abs = path.join(absDir, entry.name)
    if (entry.isDirectory()) collectZipEntries(abs, rel, depth + 1, out)
    else if (entry.isFile()) out.push({ abs, display: rel })
  }
  return out
}

export function streamZipEntries(req, res, entries, zipName, zipTmpDir) {
  const stagingDir = path.join(zipTmpDir, crypto.randomUUID())
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
    return false
  }

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
  return true
}

export function streamDirectoryZip(req, res, absDir, displayName, zipTmpDir) {
  const entries = collectZipEntries(absDir)
  if (!entries.length) return false
  const zipName = `${displayName}-${sanitizeDateTimeForName(new Date())}.zip`
  return streamZipEntries(req, res, entries, zipName, zipTmpDir)
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
  ensureDir(logDir())
  migrateLegacyLogs()
  loadAccessMap()
  cleanupStaleChunks()
  startCleanupScheduler()

  app.use(express.urlencoded({ extended: false, limit: '2mb' }))

  const api = express.Router()
  api.use(CTX.requireAuth)

  // 仅服务器本机 IP 可执行的高权限操作
  function requireLocal(req, res, next) {
    const local = typeof CTX.isLocalAddress === 'function'
      && CTX.isLocalAddress(req?.socket?.remoteAddress)
    if (!local) {
      return res.status(403).json({ code: 'LOCAL_ONLY', message: '该操作仅允许在服务器本机执行' })
    }
    next()
  }

  // 高权限命名空间：回收站 / 日志 / 磁盘与清理 / 分享链接管理
  // 放在业务路由之前，统一拦截非本机访问
  api.use((req, res, next) => {
    const highPriv = /^\/(trash|logs|cleanup|disk|shares)(\/|$)/.test(req.path)
    if (!highPriv) return next()
    return requireLocal(req, res, next)
  })

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
    let stat = null
    try { stat = abs ? fs.statSync(abs) : null } catch {}
    if (!stat || (!stat.isFile() && !stat.isDirectory())) {
      return res.status(404).json({ message: '文件或文件夹不存在' })
    }
    if (typeof CTX.directSign !== 'function') {
      return res.status(500).json({ message: '直链签名不可用' })
    }
    const isDir = stat.isDirectory()
    const sign = CTX.directSign(rel)
    const encoded = rel.split('/').map(segment => encodeURIComponent(segment)).join('/')
    const suffix = isDir ? `zip=1&sign=${sign}` : `sign=${sign}`
    logAction(req, 'direct-link', { name: rel, mode: isDir ? 'folder' : 'file' })
    res.json({
      name: rel,
      sign,
      isDir,
      url: isDir ? `/files/${encoded}?${suffix}` : `/media/${encoded}?${suffix}`,
      downloadUrl: `/files/${encoded}?${suffix}`
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
      if (stat.isDirectory()) {
        for (const found of collectZipEntries(abs, rel)) {
          entries.push({ abs: found.abs, display: found.display })
        }
      } else if (stat.isFile()) {
        entries.push({ abs, display: CTX.displayNameOf(rel).replace(/\//g, ' - ') })
      }
    }
    if (!entries.length) return res.status(404).json({ message: '所选文件均不存在' })

    const zipName = `局域网文件打包-${sanitizeDateTimeForName(new Date())}.zip`
    if (!streamZipEntries(req, res, entries, zipName, CTX.zipTmpDir)) {
      return res.status(500).json({ message: '打包失败：文件暂存出错' })
    }
  })

  // ---- 分享链接 ----
  api.post('/share', (req, res) => {
    const rel = normalizeRel(req.body?.name)
    const abs = rel ? resolveInUpload(rel) : null
    if (!abs || !fs.existsSync(abs)) return res.status(404).json({ message: '文件或文件夹不存在' })
    const ttlHours = req.body?.ttlHours === undefined ? 24 : Number(req.body.ttlHours)
    const { item: share, reused } = createShare(rel, ttlHours)
    if (!reused) logAction(req, 'share-create', { name: rel, ttlHours: share.expiresAt ? ttlHours : 0 })
    res.json({ token: share.token, url: `/s/${share.token}`, expiresAt: share.expiresAt, name: rel, reused })
  })

  api.get('/shares', (_req, res) => {
    const shares = readShares()
    const now = Date.now()
    const items = Object.values(shares)
      .map(item => ({ ...item, expired: Boolean(item.expiresAt && item.expiresAt <= now) }))
      .sort((a, b) => b.createdAt - a.createdAt)
    res.json({ items })
  })

  // 批量撤销：放在 /:token 之前，避免 batch 被当作 token
  api.delete('/shares/batch', (req, res) => {
    const tokens = Array.isArray(req.body?.tokens) ? req.body.tokens.map(String) : []
    if (!tokens.length) return res.status(400).json({ message: '未指定要撤销的链接' })
    let removed = 0
    mutateShares(shares => {
      for (const token of tokens) {
        if (hasOwn(shares, token)) {
          delete shares[token]
          removed += 1
        }
      }
    })
    if (removed) logAction(req, 'share-delete', { count: removed, mode: 'batch' })
    res.json({ ok: true, removed })
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

  // ---- 行为埋点（文件/文件夹查看等轻量事件） ----
  api.post('/track', (req, res) => {
    const action = String(req.body?.action || '')
    if (action === 'dir-view') {
      const path = String(req.body?.path || '').split('/').filter(Boolean).join('/').slice(0, 500)
      logAction(req, 'dir-view', { name: path || '/' })
      return res.json({ ok: true })
    }
    if (action === 'file-view') {
      const name = normalizeRel(String(req.body?.name || ''))
      if (name) logAction(req, 'file-view', { name })
      return res.json({ ok: true })
    }
    res.status(400).json({ message: '未知埋点类型' })
  })

  // ---- 我的上传记录（与操作日志一致，仅当前 IP） ----
  // 直接以操作日志中的 upload 条目为准，逐条核对文件当前状态
  api.get('/my-uploads', (req, res) => {
    const ip = clientIp(req)
    const result = readLogs(500, 'upload')
    const items = result.items
      .filter(item => item.ip === ip)
      .map(item => {
        const name = String(item.name || '')
        const abs = resolveInUpload(name)
        let exists = false
        if (abs) {
          try { exists = fs.existsSync(abs) } catch {}
        }
        return {
          name,
          displayName: CTX.displayNameOf(name),
          size: Number(item.size) || 0,
          dir: typeof item.dir === 'string' ? item.dir : '',
          ts: Number(item.ts) || 0,
          mode: item.mode || '',
          status: exists ? 'exists' : 'deleted'
        }
      })
    res.json({ items, total: items.length })
  })

  // ---- 重复文件检测（按内容指纹 + 大小） ----
  api.post('/upload/check', (req, res) => {
    const size = Number(req.body?.size || 0)
    const fingerprint = String(req.body?.fingerprint || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 96)
    if (!(size > 0) || !fingerprint) return res.json({ duplicate: false })
    // 扫描指纹索引：上传完成时写入 data/upload-fingerprints.json
    const index = readJson(path.join(ctx().dataDir, 'upload-fingerprints.json'), {})
    let match = null
    for (const key of Object.keys(index)) {
      const entry = index[key]
      if (!entry || entry.size !== size || entry.fingerprint !== fingerprint) continue
      const abs = resolveInUpload(entry.name)
      let exists = false
      try { exists = abs ? fs.existsSync(abs) : false } catch {}
      if (!exists) continue
      match = entry
      break
    }
    res.json({ duplicate: Boolean(match), name: match ? CTX.displayNameOf(match.name) : '' })
  })

  // ---- 统计（上传/下载/文件查看/各IP设备登录/热门文件） ----
  api.get('/stats', (_req, res) => {
    const op = readAllLogEntries('operation')
    const count = action => op.filter(item => item && item.action === action).length
    // 各 IP 登录次数：同时把设备归并
    const loginMap = new Map()
    // 热门文件：按动作分别聚合文件名出现次数
    const hotView = new Map()
    const hotDownload = new Map()
    const hotShare = new Map()
    const bump = (map, name) => {
      if (!name) return
      map.set(name, (map.get(name) || 0) + 1)
    }
    for (const item of op) {
      if (!item) continue
      const name = String(item.name || '')
      if (item.action === 'login') {
        const ip = String(item.ip || '未知')
        if (!loginMap.has(ip)) loginMap.set(ip, { ip, count: 0, device: item.device || '', local: Boolean(item.local) })
        loginMap.get(ip).count += 1
      }
      if (item.action === 'file-view') bump(hotView, name)
      if (item.action === 'download' || item.action === 'zip') bump(hotDownload, name)
      if (item.action === 'share-create') bump(hotShare, name)
    }
    const logins = [...loginMap.values()].sort((a, b) => b.count - a.count)
    const topN = map => [...map.entries()]
      .map(([name, count]) => ({ name: CTX.displayNameOf(name), count }))
      .sort((a, b) => b.count - a.count).slice(0, 8)
    // 近 7 天趋势（按本地日期）
    const days = []
    const dayMap = new Map()
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      dayMap.set(key, { date: key, upload: 0, download: 0 })
      days.push(key)
    }
    for (const item of op) {
      if (!item || !item.ts) continue
      const d = new Date(Number(item.ts))
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const bucket = dayMap.get(key)
      if (!bucket) continue
      if (item.action === 'upload') bucket.upload += 1
      if (item.action === 'download' || item.action === 'zip') bucket.download += 1
    }
    res.json({
      total: {
        upload: count('upload'),
        download: count('download') + count('zip'),
        fileView: count('file-view'),
        login: count('login')
      },
      logins,
      trend: days.map(key => dayMap.get(key)),
      hot: { view: topN(hotView), download: topN(hotDownload), share: topN(hotShare) }
    })
  })

  // ---- 操作日志 ----
  api.get('/logs', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
    const action = String(req.query.action || 'all')
    const kind = LOG_KINDS.includes(String(req.query.kind)) ? String(req.query.kind) : 'operation'
    const result = readLogs(limit, action, kind)
    res.json({ ...result, kind, actions: ['all', 'upload', 'download', 'delete', 'restore', 'purge', 'trash-empty', 'zip', 'share-create', 'share-delete', 'share-open', 'direct-link', 'cleanup', 'cleanup-config', 'dir-view', 'file-view', 'login', 'visit', 'startup'] })
  })

  api.delete('/logs', (req, res) => {
    const kind = LOG_KINDS.includes(String(req.query.kind)) ? String(req.query.kind) : 'operation'
    try { fs.writeFileSync(logPath(kind), '', 'utf8') } catch {}
    try {
      const prefix = `${kind}-log`
      for (const name of fs.readdirSync(logDir())) {
        if (new RegExp(`^${prefix}\\..*\\.jsonl\\.gz$`).test(name)) {
          try { fs.unlinkSync(path.join(logDir(), name)) } catch {}
        }
      }
    } catch {}
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
    if (!meta || meta.size !== size || meta.name !== name || meta.dir !== dir || meta.fingerprint !== fingerprint) {
      meta = { id, name, size, dir, fingerprint, createdAt: Date.now() }
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
    // 记录内容指纹索引，供重复上传检测使用
    if (meta.fingerprint) {
      const indexFile = path.join(ctx().dataDir, 'upload-fingerprints.json')
      const index = readJson(indexFile, {})
      index[`${meta.fingerprint}|${meta.size}`] = {
        name: rel, size: meta.size, fingerprint: meta.fingerprint, at: Date.now()
      }
      writeJson(indexFile, index)
    }
    logAction(req, 'upload', { name: rel, size: meta.size, mode: 'chunked', fingerprint: meta.fingerprint || '', dir: meta.dir || '' })
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

  // ---- 公开二维码访问（无需密码，任何 IP 可用） ----
  app.get('/api/public/qr-target', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ url: qrTargetFor(req) })
  })
  app.get('/api/public/qr', async (req, res) => {
    const requested = typeof req.query.url === 'string' ? req.query.url.trim() : ''
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

  // ---- 分享链接访问（无需密码） ----
  app.get('/s/:token', (req, res) => {
    const share = resolveShare(req.params.token)
    if (!share) return res.status(410).send('分享链接已过期或不存在')
    const abs = resolveInUpload(share.name)
    if (!abs || !fs.existsSync(abs)) return res.status(404).send('文件不存在')
    let stat = null
    try { stat = fs.statSync(abs) } catch {}
    if (!stat) return res.status(404).send('文件不存在')
    bumpShareHit(req, share.token)
    noteDownload(req, share.name)
    res.setTimeout(0)
    if (stat.isDirectory()) {
      if (!streamDirectoryZip(req, res, abs, path.basename(share.name), CTX.zipTmpDir)) {
        return res.status(404).send('文件夹为空或不存在')
      }
      return
    }
    const mediaType = CTX.mediaTypeOf(share.name)
    if (mediaType === 'file') {
      return res.download(abs, CTX.displayNameOf(share.name), { dotfiles: 'allow' })
    }
    const mime = CTX.mimeOf(share.name) || 'application/octet-stream'
    res.sendFile(abs, {
      acceptRanges: true,
      dotfiles: 'allow',
      headers: {
        'Content-Type': mime,
        'Content-Disposition': inlineDispositionOf(share.name),
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
