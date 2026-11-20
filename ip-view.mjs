// 地址展示策略：
// 1) 页面 UI 展示：本机访问返回完整局域网地址，其他设备访问只返回打码地址（打码仅用于展示）。
// 2) 二维码 / 分享：始终需要真实可用的局域网地址，优先与访问者同网段的网卡，其次默认路由网卡。
// 3) 判定依据是服务端 socket 的真实连接来源地址，不使用 X-Forwarded-For / X-Real-IP 等可伪造请求头。

import os from 'node:os'
import { execSync } from 'node:child_process'

function normalizeRemoteAddress(raw) {
  const value = String(raw || '').trim()
  if (value.startsWith('::ffff:')) return value.slice(7)
  return value
}

// 虚拟网卡 / 非常规网卡名称特征：Hyper-V、WSL、VMware、VirtualBox、Docker、Tailscale 等
const VIRTUAL_IFACE_PATTERNS = [
  /vEthernet/i,
  /hyper-?v/i,
  /vmware/i,
  /virtualbox/i,
  /vbox/i,
  /wsl/i,
  /docker/i,
  /tailscale/i,
  /zerotier/i,
  /hamachi/i,
  /radmin/i,
  /npcap/i,
  /pseudo/i,
  /loopback/i,
  /teredo/i,
  /isatap/i,
  /tap[-_\s]?windows/i,
  /^tap/i,
  /^tun/i,
  /virtual/i,
  /bluetooth/i,
  /default switch/i,
  /local area connection\s*\*/i,
  /本地连接\s*\*/i
]

function isVirtualInterface(name) {
  const text = String(name || '')
  return VIRTUAL_IFACE_PATTERNS.some((pattern) => pattern.test(text))
}

function ipToInt(ip) {
  const parts = String(ip || '').split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const number = Number(part)
    if (number > 255) return null
    value = value * 256 + number
  }
  return value
}

function inSameSubnet(left, right, netmask) {
  const a = ipToInt(left)
  const b = ipToInt(right)
  if (a === null || b === null) return false
  const mask = ipToInt(netmask || '255.255.255.0')
  if (mask === null) return false
  return (a & mask) === (b & mask)
}

// 默认路由对应的网卡地址（真实上网网卡），带 60 秒缓存，避免每次请求都起子进程
let defaultRouteCache = { ip: '', at: 0 }
const DEFAULT_ROUTE_TTL = 60 * 1000

function readDefaultRouteIp() {
  const now = Date.now()
  if (defaultRouteCache.ip && now - defaultRouteCache.at < DEFAULT_ROUTE_TTL) return defaultRouteCache.ip
  let ip = ''
  try {
    if (process.platform === 'win32') {
      const output = execSync('route print -4', { encoding: 'utf8', timeout: 5000, windowsHide: true })
      const candidates = []
      for (const line of String(output).split(/\r?\n/)) {
        const matched = line.trim().match(/^0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+(\S+)\s+(\d+)/)
        if (!matched) continue
        candidates.push({ address: matched[2], metric: Number(matched[3]) })
      }
      candidates.sort((left, right) => left.metric - right.metric)
      if (candidates.length) ip = candidates[0].address
    } else {
      const output = execSync('ip route show default', { encoding: 'utf8', timeout: 4000 })
      const device = String(output).match(/default\s+via\s+\S+\s+dev\s+(\S+)/)
      if (device) {
        const addressOutput = execSync(`ip -4 -o addr show dev ${device[1]}`, { encoding: 'utf8', timeout: 4000 })
        const address = String(addressOutput).match(/inet\s+(\d+\.\d+\.\d+\.\d+)/)
        if (address) ip = address[1]
      }
    }
  } catch {
    ip = ''
  }
  if (ip) defaultRouteCache = { ip, at: now }
  return ip
}

// 返回按优先级排序的网卡地址明细：
// 分数 0：与访问者同网段的真实网卡（最优先，手机扫码即走这一条）
// 分数 1：默认路由对应的真实网卡
// 分数 2：其他真实网卡
// 分数 3：默认路由对应的虚拟网卡
// 分数 4：其他虚拟网卡（Hyper-V / WSL / 热点虚拟适配器等）
export function listLocalIPv4Detailed(remoteAddress) {
  const remote = normalizeRemoteAddress(remoteAddress)
  const defaultRouteIp = readDefaultRouteIp()
  const seen = new Set()
  const items = []

  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (!address || address.internal) continue
      const family = String(address.family)
      if (family !== 'IPv4' && family !== '4') continue
      // APIPA 169.254.x.x 为自分配地址，手机无法访问
      if (String(address.address).startsWith('169.254.')) continue
      if (seen.has(address.address)) continue
      seen.add(address.address)

      const virtual = isVirtualInterface(name)
      const sameSubnet = remote ? inSameSubnet(remote, address.address, address.netmask) : false
      let score = virtual ? 4 : 2
      if (address.address === defaultRouteIp) score = virtual ? 3 : 1
      if (sameSubnet && !virtual) score = 0

      items.push({
        address: address.address,
        netmask: address.netmask,
        iface: name,
        virtual,
        sameSubnet,
        score
      })
    }
  }

  items.sort((left, right) => (left.score - right.score) || left.address.localeCompare(right.address))
  return items
}

export function listLocalIPv4(remoteAddress) {
  return listLocalIPv4Detailed(remoteAddress).map((item) => item.address)
}

export function isLocalAddress(raw) {
  const value = normalizeRemoteAddress(raw)
  if (!value) return false
  if (value === '::1') return true
  if (value.startsWith('127.')) return true
  return listLocalIPv4().includes(value)
}

export function maskIp(ip) {
  const parts = String(ip).split('.')
  if (parts.length !== 4) return ip
  return `${parts[0]}.${parts[1]}.*.*`
}

export function buildAccessUrls({ port, local, remoteAddress, real } = {}) {
  const base = Number(port) || 9988
  const items = listLocalIPv4Detailed(remoteAddress)
  const allowReal = real === true || local === true
  const urls = allowReal
    ? items.map((item) => `http://${item.address}:${base}`)
    : [...new Set(items.map((item) => `http://${maskIp(item.address)}:${base}`))]

  if (local === true) return [...new Set([`http://localhost:${base}`, ...urls])]
  if (!urls.length) return [`http://localhost:${base}`]
  return urls
}

// 二维码 / 分享专用：只返回真实可用的局域网地址，绝不返回打码地址
export function pickBestLanUrl({ port, remoteAddress } = {}) {
  const base = Number(port) || 9988
  const items = listLocalIPv4Detailed(remoteAddress)
  const best = items[0]
  if (best && best.address) return `http://${best.address}:${base}`
  return `http://localhost:${base}`
}
