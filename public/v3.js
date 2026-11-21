/* ============================================================
   V3.0 前端逻辑：缩略图 / 勾选打包 / 分享直链 / 拖拽进度 /
   分片续传 / 文件夹上传 / 回收站 / 日志 / 存储清理 / 扫码
   ============================================================ */
(function () {
  'use strict'

  const API = '/api/v3'
  const selected = new Set()
  const SERVER_DOWN_THRESHOLD = 3
  let serverFailCount = 0
  let serverDownNotified = false
  const toastHost = document.createElement('div')
  toastHost.className = 'v3-toast-host'
  toastHost.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:1300;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;'
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(toastHost))

  function toast(message, type) {
    const node = document.createElement('div')
    node.textContent = message
    const color = type === 'error' ? 'rgba(217,83,79,.95)' : 'rgba(24,32,44,.95)'
    node.style.cssText = `padding:10px 16px;border-radius:10px;background:${color};color:#fff;font-size:13px;box-shadow:0 10px 26px rgba(0,0,0,.35);max-width:80vw;`
    toastHost.appendChild(node)
    setTimeout(() => node.remove(), 3200)
  }

  function notifyUnauthorized() {
    try {
      document.dispatchEvent(new CustomEvent('app:unauthorized'))
    } catch {}
  }

  // 全局上传浮标：切换任意视图都能看到后台上传状态，点击回到上传页
  const uploadBadge = document.createElement('button')
  uploadBadge.type = 'button'
  uploadBadge.className = 'v3-upload-badge'
  uploadBadge.hidden = true
  uploadBadge.addEventListener('click', () => {
    if (location.hash !== '#/upload') location.hash = '#/upload'
    else window.scrollTo({ top: 0, behavior: 'smooth' })
  })
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(uploadBadge))

  function updateUploadBadge() {
    const active = uploadState.jobs.filter(job => job.state === 'uploading' || job.state === 'waiting')
    if (!active.length) {
      uploadBadge.hidden = true
      return
    }
    const paused = active.filter(job => job.paused).length
    const done = uploadState.jobs.filter(job => job.state === 'done').length
    uploadBadge.hidden = false
    uploadBadge.textContent = paused
      ? `${active.length} 个上传已暂停 · 点击查看`
      : `后台上传中 ${active.length} 个（已完成 ${done}） · 点击查看`
  }

  function notifyUploadDone(job) {
    toast(`${job.file.name} 上传成功`)
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('上传完成', { body: `${job.file.name} 已上传成功` })
      }
    } catch {}
  }

  async function api(path, options) {
    const opts = options || {}
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} }
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(opts.body)
    }
    const res = await fetch(API + path, init)
    let data = {}
    try {
      data = await res.json()
    } catch {}
    if (!res.ok) {
      if (res.status === 401) notifyUnauthorized()
      const error = new Error(data.message || `请求失败（${res.status}）`)
      error.status = res.status
      error.data = data
      throw error
    }
    return data
  }

  function formatSize(bytes) {
    const value = Number(bytes) || 0
    if (value < 1024) return `${value} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let size = value / 1024
    let index = 0
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024
      index += 1
    }
    return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`
  }

  function formatTime(ts) {
    if (!ts) return '—'
    const date = new Date(Number(ts))
    if (Number.isNaN(date.getTime())) return '—'
    const pad = value => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {}
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.cssText = 'position:fixed;opacity:0;top:0;left:0;'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function icon(key) {
    return typeof window.__appIconSvg === 'function' ? window.__appIconSvg(key) : ''
  }

  function iconButton(className, key, label) {
    const button = el('button', `btn icon-btn ${className}`)
    button.type = 'button'
    button.title = label
    button.setAttribute('aria-label', label)
    button.innerHTML = icon(key)
    return button
  }

  // ============================================================
  // 一、文件列表：缩略图 + 勾选 + 选择工具条
  // ============================================================
  let selectBar = null
  let listObserver = null

  function visiblePickBoxes() {
    return Array.prototype.slice.call(document.querySelectorAll('#fileList .v3-pick'))
  }

  function syncSelectAllState() {
    const box = document.getElementById('v3SelectAll')
    if (!box) return
    const picks = visiblePickBoxes()
    const checked = picks.filter(pick => pick.checked).length
    box.checked = picks.length > 0 && checked === picks.length
    box.indeterminate = checked > 0 && checked < picks.length
  }

  function pruneSelection(names) {
    if (!Array.isArray(names)) return
    const valid = new Set(names.map(String))
    let changed = false
    for (const name of selected) {
      if (!valid.has(name)) {
        selected.delete(name)
        changed = true
      }
    }
    if (changed) updateSelectCount()
    syncSelectAllState()
  }

  window.__v3PruneSelection = pruneSelection

  function syncSelectBarVisibility() {
    const list = document.getElementById('fileList')
    const inFolder = Boolean(list && list.dataset.inFolder === '1')
    if (selectBar) selectBar.hidden = inFolder
    if (inFolder && selected.size) {
      selected.clear()
      updateSelectCount()
    }
  }

  function ensureSelectBar() {
    const list = document.getElementById('fileList')
    if (!list) return null
    if (selectBar && document.body.contains(selectBar)) {
      syncSelectBarVisibility()
      return selectBar
    }
    const bar = el('div', 'v3-select-bar')
    bar.innerHTML = `
      <label title="全选"><input type="checkbox" id="v3SelectAll" aria-label="全选"></label>
      <span class="v3-selected-count" id="v3SelectedCount">已选 0 项</span>
      <button type="button" class="btn icon-btn primary small" id="v3ZipBtn" disabled title="打包下载 ZIP" aria-label="打包下载 ZIP">${icon('archive')}</button>
      <button type="button" class="btn icon-btn ghost small" id="v3ClearSel" disabled title="清空选择" aria-label="清空选择">${icon('trash')}</button>
      <span class="v3-hint">勾选多个文件可一键打包</span>
    `
    list.parentNode.insertBefore(bar, list)
    bar.querySelector('#v3SelectAll').addEventListener('change', event => {
      const checked = event.target.checked
      visiblePickBoxes().forEach(box => {
        box.checked = checked
        syncSelect(box)
      })
      syncSelectAllState()
    })
    bar.querySelector('#v3ClearSel').addEventListener('click', () => {
      selected.clear()
      visiblePickBoxes().forEach(box => { box.checked = false })
      updateSelectCount()
      syncSelectAllState()
    })
    bar.querySelector('#v3ZipBtn').addEventListener('click', startZip)
    selectBar = bar
    updateSelectCount()
    syncSelectAllState()
    syncSelectBarVisibility()
    return bar
  }

  function syncSelect(box) {
    const name = box.dataset.name
    if (!name) return
    if (box.checked) selected.add(name)
    else selected.delete(name)
    updateSelectCount()
    syncSelectAllState()
  }

  function updateSelectCount() {
    const counter = document.getElementById('v3SelectedCount')
    if (counter) counter.textContent = `已选 ${selected.size} 项`
    const zipBtn = document.getElementById('v3ZipBtn')
    if (zipBtn) zipBtn.disabled = selected.size === 0
    const clearBtn = document.getElementById('v3ClearSel')
    if (clearBtn) clearBtn.disabled = selected.size === 0
  }

  async function startZip() {
    if (!selected.size) {
      toast('请先勾选要打包的文件')
      return
    }
    const names = [...selected]
    toast(`正在打包 ${names.length} 个文件`)
    try {
      const res = await fetch(`${API}/zip`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names })
      })
      if (res.status === 401) notifyUnauthorized()
      if (!res.ok) {
        let data = {}
        try { data = await res.json() } catch {}
        throw new Error(data.message || `打包失败（${res.status}）`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const disposition = res.headers.get('Content-Disposition') || ''
      const match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = match ? decodeURIComponent(match[1]) : 'archive.zip'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      toast('打包完成')
    } catch (error) {
      toast(error.message || '打包失败', 'error')
    }
  }

  // 缩略图
  const thumbQueue = []
  let thumbActive = 0
  const THUMB_PARALLEL = 4

  // 幂等依靠元素存在性判断，而不是提前置位 data-v3：
  // 此前 addItemExtras 在 app.js 挂载 .file-actions 之前执行，查询到 null 直接跳过，
  // 但 data-v3 已被置 1，后续重渲染全部被挡掉，分享按钮永久缺失。
  function addItemExtras(item, file) {
    if (!item || !file) return
    const name = file.name
    const display = file.displayName || file.name
    item.dataset.name = name
    item.dataset.display = display

    if (!item.querySelector('.v3-pick-wrap')) {
      const label = el('label', 'v3-pick-wrap')
      label.title = '勾选后可打包下载'
      const pick = el('input')
      pick.type = 'checkbox'
      pick.className = 'v3-pick'
      pick.dataset.name = name
      pick.checked = selected.has(name)
      label.appendChild(pick)
      label.appendChild(el('span', 'v3-pick-box'))
      item.insertBefore(label, item.firstChild)
    }

    if (!item.querySelector('.file-thumb')) {
      const thumb = el('div', 'file-thumb')
      thumb.dataset.media = file.mediaType || 'file'
      thumb.dataset.url = file.url || ''
      // 图片走 /media 内联通道；视频优先用服务端抽帧缓存的缩略图
      thumb.dataset.stream = file.streamUrl || file.url || ''
      thumb.dataset.thumb = file.thumbUrl || ''
      thumb.dataset.name = name
      thumb.dataset.mtime = String(file.updatedAt || file.mtimeMs || file.mtime || '')
      const anchor = item.querySelector('.v3-pick-wrap')
      item.insertBefore(thumb, anchor ? anchor.nextSibling : item.firstChild)
    }

    if (!ensureShareBtn(item)) scheduleShareRetry(item, 30)
  }

  // 分享/直链按钮：仅在 .file-actions 已挂载时插入；插入成功后才置 data-v3='1'
  function ensureShareBtn(item) {
    if (!item) return false
    const actions = item.querySelector('.file-actions')
    if (!actions) return false
    if (actions.querySelector('.v3-share')) {
      item.dataset.v3 = '1'
      return true
    }
    const name = item.dataset.name || ''
    if (!name) return false
    const display = item.dataset.display || name
    const share = el('button', 'btn icon-btn ghost small v3-share')
    share.type = 'button'
    share.title = '分享/直链'
    share.setAttribute('aria-label', '分享/直链')
    share.innerHTML = typeof window.__appIconSvg === 'function'
      ? window.__appIconSvg('share')
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="18" cy="5" r="2.4"/><circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="19" r="2.4"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/></svg>'
    share.dataset.name = name
    share.dataset.display = display
    actions.insertBefore(share, actions.firstChild)
    item.dataset.v3 = '1'
    return true
  }

  // 动作区晚于行内容挂载时，用有限次数的短轮询补齐（rAF 优先，兜底 setTimeout）
  function scheduleShareRetry(item, remain) {
    const left = typeof remain === 'number' ? remain : 30
    if (!item || left <= 0) return
    const next = () => {
      if (ensureShareBtn(item)) return
      scheduleShareRetry(item, left - 1)
    }
    if (typeof requestAnimationFrame === 'function' && left > 20) {
      requestAnimationFrame(next)
    } else {
      setTimeout(next, 30)
    }
  }

  window.__v3AddItemExtras = addItemExtras
  window.__v3RenderThumb = renderThumb

  function decorateList() {
    const list = document.getElementById('fileList')
    if (!list) return
    if (listObserver) listObserver.disconnect()
    try {
      ensureSelectBar()
      syncSelectBarVisibility()
      list.querySelectorAll('.file-thumb').forEach(node => {
        if (node.dataset.done === '1') return
        node.dataset.done = '1'
        if (!node.dataset.media || node.dataset.media === 'file') {
          node.textContent = 'FILE'
          return
        }
        if (node.dataset.media === 'doc') {
          node.textContent = 'PDF'
          return
        }
        // 音频保持静态占位；视频改走服务端抽帧缓存的真实缩略图
        if (node.dataset.media === 'audio') {
          paintMediaPlaceholder(node, 'audio')
          return
        }
        node.classList.add('is-loading')
        thumbQueue.push(node)
      })
      visiblePickBoxes().forEach(box => {
        box.checked = selected.has(box.dataset.name)
      })
      // 补插兜底：动作区已存在但缺分享按钮的行（含历史遗留 data-v3=1 的行）在此补齐
      list.querySelectorAll('.file-item').forEach(item => {
        // 只读行（文件夹内部内容）不参与分享按钮注入，避免无意义的重试定时器
        if (item.classList.contains('is-readonly')) return
        if (item.querySelector('.file-actions .v3-share')) {
          item.dataset.v3 = '1'
          return
        }
        if (!ensureShareBtn(item)) scheduleShareRetry(item, 20)
      })
      syncSelectAllState()
      pumpThumbs()
    } finally {
      if (listObserver) listObserver.observe(list, { childList: true, subtree: true })
    }
  }

  function pumpThumbs() {
    while (thumbActive < THUMB_PARALLEL && thumbQueue.length) {
      const node = thumbQueue.shift()
      thumbActive += 1
      renderThumb(node).finally(() => {
        thumbActive -= 1
        pumpThumbs()
      })
    }
  }

  // ---------- 媒体缩略图 ----------
  // 图片走 /media 内联通道；视频走服务端抽帧并缓存的 /api/thumb，列表只加载几 KB 的 JPEG。
  // 音频没有画面，仍用静态占位。点击缩略图播放的交互由 app.js 的媒体行点击逻辑承担。
  function paintMediaPlaceholder(node, media) {
    const isAudio = media === 'audio'
    node.classList.remove('is-loading')
    node.classList.remove('is-video')
    node.classList.remove('is-video-ok')
    node.classList.add('is-media-icon')
    node.classList.add(isAudio ? 'is-media-audio' : 'is-media-video')
    node.textContent = isAudio ? '♪' : '▶'
    node.title = isAudio ? '音频文件，点击播放' : '视频文件，点击播放'
  }

  // 旧版抽帧写入的 localStorage 缓存（v3thumb:v1:*）已无用途，启动时清理一次释放空间
  ;(function dropLegacyThumbCache() {
    try {
      const keys = []
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i)
        if (k && k.indexOf('v3thumb:v1:') === 0) keys.push(k)
      }
      keys.forEach(k => localStorage.removeItem(k))
    } catch {
      // localStorage 不可用时忽略，不影响页面
    }
  })()

  function renderThumb(node) {
    // 图片走 /media 内联通道；视频走服务端抽帧缓存，都是轻量请求
    const url = node.dataset.stream || node.dataset.url
    const media = node.dataset.media
    const thumbUrl = node.dataset.thumb

    // 音频没有画面，保持静态占位
    if (media === 'audio') {
      paintMediaPlaceholder(node, 'audio')
      return Promise.resolve()
    }

    return new Promise(resolve => {
      const src = media === 'video' ? thumbUrl : url
      if (!src) {
        if (media === 'video') paintMediaPlaceholder(node, 'video')
        else {
          node.classList.remove('is-loading')
          node.textContent = '预览'
        }
        resolve()
        return
      }
      const img = new Image()
      img.decoding = 'async'
      img.alt = ''
      img.onload = () => {
        node.textContent = ''
        node.classList.remove('is-loading', 'is-media-icon', 'is-media-video', 'is-media-audio')
        // 视频成功态：真实画面 + 右下角小 ▶ 角标
        if (media === 'video') {
          node.classList.add('is-video-ok')
          node.title = '视频文件，点击播放'
        }
        node.appendChild(img)
        resolve()
      }
      img.onerror = () => {
        if (media === 'video') paintMediaPlaceholder(node, 'video')
        else {
          node.classList.remove('is-loading')
          node.textContent = '图片'
        }
        resolve()
      }
      img.src = src
    })
  }

  function bootFileList() {
    const list = document.getElementById('fileList')
    if (!list) return
    ensureSelectBar()
    decorateList()

    list.addEventListener('change', event => {
      const box = event.target.closest('.v3-pick')
      if (box) syncSelect(box)
    })

    list.addEventListener('click', event => {
      const shareBtn = event.target.closest('.v3-share')
      if (shareBtn) {
        event.preventDefault()
        openShareDialog(shareBtn.dataset.name, shareBtn.dataset.display || shareBtn.dataset.name)
      }
    })

    // 只对「列表行/动作区」的结构性变化做出反应；忽略自身注入节点（缩略图/勾选框/分享按钮）
    // 引起的回声，避免 decorateList 被自己的插入动作反复触发
    const ownNodeClasses = ['file-thumb', 'v3-pick-wrap', 'v3-pick-box', 'v3-share']
    listObserver = new MutationObserver(mutations => {
      const relevant = mutations.some(record => {
        const nodes = [...record.addedNodes, ...record.removedNodes]
        return nodes.some(node => {
          if (!node || node.nodeType !== 1) return false
          return !ownNodeClasses.some(cls => node.classList.contains(cls))
        })
      })
      if (relevant) decorateList()
    })
    listObserver.observe(list, { childList: true, subtree: true })

    const refresh = document.getElementById('refreshBtn')
    if (refresh) refresh.addEventListener('click', () => setTimeout(decorateList, 400))
  }

  // ============================================================
  // 二、分享 / 直链弹层
  // ============================================================
  function absolute(path) {
    if (!path) return ''
    if (/^https?:\/\//i.test(path)) return path
    return `${location.origin}${path.startsWith('/') ? '' : '/'}${path}`
  }

  function openShareDialog(name, display) {
    if (!name) return
    const mask = el('div', 'v3-modal-mask')
    const modal = el('div', 'v3-modal')
    modal.innerHTML = `
      <h3>链接与直链</h3>
      <p class="v3-modal-tip">「免密直链」带签名，无需密码即可在电视、投影、播放器中直接打开；「免密码链接」为独立页面链接，同名文件会复用已有链接。</p>
      <div class="v3-field"><span style="flex:0 0 68px">文件</span><strong style="flex:1;word-break:break-all;font-weight:500">${escapeHtml(display)}</strong></div>
      <div class="v3-field" id="v3TtlField"><span style="flex:0 0 68px">有效期</span>
        <select id="v3Ttl">
          <option value="1">1 小时</option>
          <option value="24" selected>24 小时</option>
          <option value="168">7 天</option>
          <option value="720">30 天</option>
          <option value="0">永久有效</option>
        </select>
      </div>
      <div class="v3-modal-actions">
        <button type="button" class="btn icon-btn ghost" id="v3CopyDirect" title="复制免密直链" aria-label="复制免密直链">${icon('copy')}</button>
        <button type="button" class="btn icon-btn primary" id="v3MakeShare" title="获取免密码链接" aria-label="获取免密码链接">${icon('link')}</button>
        <button type="button" class="btn icon-btn ghost" id="v3CloseShare" title="关闭" aria-label="关闭">${icon('close')}</button>
      </div>
      <div id="v3ShareResult"></div>
    `
    mask.appendChild(modal)
    document.body.appendChild(mask)

    const resultHost = modal.querySelector('#v3ShareResult')
    const showLink = (title, link) => {
      const box = el('div', 'v3-link-result')
      box.innerHTML = `<div style="opacity:.7;margin-bottom:6px">${escapeHtml(title)}</div><div>${escapeHtml(link)}</div>`
      resultHost.innerHTML = ''
      resultHost.appendChild(box)
    }

    const close = () => mask.remove()
    mask.addEventListener('click', event => {
      if (event.target === mask) close()
    })
    modal.querySelector('#v3CloseShare').addEventListener('click', close)

    modal.querySelector('#v3CopyDirect').addEventListener('click', async () => {
      const button = modal.querySelector('#v3CopyDirect')
      button.disabled = true
      try {
        const data = await api(`/direct?name=${encodeURIComponent(name)}`)
        const link = absolute(data.url)
        const ok = await copyText(link)
        toast(ok ? '免密直链已复制，电视/播放器可直接打开' : '直链已生成，请手动复制')
        showLink('免密直链（可直接在电视播放器打开）', link)
      } catch (error) {
        toast(error.message, 'error')
      } finally {
        button.disabled = false
      }
    })

    // 打开时先查已有链接：有则直接展示，不再发起生成请求
    const preloadExisting = async () => {
      try {
        const data = await api('/shares')
        const items = (data.items || []).filter(item =>
          item.name === name && !item.expired)
        if (!items.length) return false
        const item = items[0]
        const link = absolute(`/s/${item.token}`)
        const title = item.expiresAt ? `免密码链接（已存在，有效期至 ${formatTime(item.expiresAt)}）` : '免密码链接（已存在，永久有效）'
        showLink(title, link)
        modal.querySelector('#v3TtlField').hidden = true
        return true
      } catch {}
      return false
    }
    preloadExisting()

    modal.querySelector('#v3MakeShare').addEventListener('click', async () => {
      const ttl = Number(modal.querySelector('#v3Ttl').value || 0)
      const button = modal.querySelector('#v3MakeShare')
      button.disabled = true
      try {
        const data = await api('/share', { method: 'POST', body: { name, ttlHours: ttl } })
        const link = absolute(data.url)
        const title = data.reused
          ? '免密码链接（已存在，直接复用）'
          : (data.expiresAt ? `免密码链接（有效期至 ${formatTime(data.expiresAt)}）` : '免密码链接（永久有效）')
        showLink(title, link)
        const ok = await copyText(link)
        toast(data.reused ? '已复用已有链接并复制' : (ok ? '免密码链接已生成并复制' : '链接已生成'))
      } catch (error) {
        toast(error.message, 'error')
      } finally {
        button.disabled = false
      }
    })
  }

  // ============================================================
  // 三、上传：拖拽进度 / 分片续传 / 文件夹上传
  // ============================================================
  const uploadState = { queue: [], active: 0, jobs: [], totalBytes: 0, sentBytes: 0 }
  const MAX_PARALLEL_UPLOAD = 2
  let fileInput = null
  let folderInput = null
  let uploadListHost = null
  let uploadLogHost = null

  // 上传记录：以服务端操作日志为准（仅当前 IP），与操作日志保持一致
  let uploadLog = []
  let uploadLogLoading = false
  async function fetchUploadLog() {
    if (uploadLogLoading) return
    uploadLogLoading = true
    try {
      const data = await api('/my-uploads')
      uploadLog = Array.isArray(data.items) ? data.items : []
    } catch {
      uploadLog = []
    } finally {
      uploadLogLoading = false
      renderUploadLog()
    }
  }
  function loadUploadLog() { return fetchUploadLog() }
  function pushUploadLog() { return fetchUploadLog() }
  function resetUploadLog() {
    uploadLog = []
    renderUploadLog()
  }
  function renderUploadLog() {
    if (!uploadLogHost) return
    uploadLogHost.innerHTML = ''
    if (!uploadLog.length) {
      uploadLogHost.hidden = true
      return
    }
    uploadLogHost.hidden = false
    const title = el('div', 'v3-upload-log-title', `我的上传记录（${uploadLog.length}）`)
    uploadLogHost.appendChild(title)
    for (const item of uploadLog) {
      const row = el('div', 'v3-upload-log-item')
      const name = el('span', 'v3-upload-log-name', item.displayName || item.name)
      name.title = item.name
      const deleted = item.status === 'deleted'
      const meta = el('span', 'v3-upload-log-meta',
        `${deleted ? '已删除' : '已上传'} · ${formatSize(item.size)} · ${formatTime(item.ts)}`)
      if (deleted) row.classList.add('is-deleted')
      row.appendChild(name)
      row.appendChild(meta)
      uploadLogHost.appendChild(row)
    }
  }

  function ensureUploadUI() {
    const view = document.getElementById('view-upload')
    if (!view || view.dataset.v3Ready === '1') return
    view.dataset.v3Ready = '1'

    fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.multiple = true
    fileInput.style.display = 'none'
    fileInput.addEventListener('change', () => {
      handlePicked(Array.from(fileInput.files || []).map(file => ({ file, dir: '' })))
      fileInput.value = ''
    })
    document.body.appendChild(fileInput)

    folderInput = document.createElement('input')
    folderInput.type = 'file'
    folderInput.multiple = true
    folderInput.webkitdirectory = true
    folderInput.style.display = 'none'
    folderInput.addEventListener('change', () => {
      const entries = Array.from(folderInput.files || []).map(file => {
        const relative = String(file.webkitRelativePath || '').replace(/\\/g, '/')
        const index = relative.lastIndexOf('/')
        return { file, dir: index > 0 ? relative.slice(0, index) : '' }
      })
      handlePicked(entries)
      folderInput.value = ''
    })
    document.body.appendChild(folderInput)

    const card = el('section', 'card v3-upload-card')
    card.innerHTML = `
      <div class="v3-upload-actions">
        <button type="button" class="btn icon-btn primary small" id="v3PickFiles" title="选择文件" aria-label="选择文件">${icon('upload')}</button>
        <button type="button" class="btn icon-btn ghost small" id="v3PickFolder" title="上传文件夹" aria-label="上传文件夹">${icon('folder')}</button>
        <button type="button" class="btn icon-btn ghost small" id="v3ClearUploads" title="清空列表" aria-label="清空列表">${icon('trash')}</button>
        <span class="v3-upload-hint">支持拖拽上传、8MB 分片续传、文件夹保留目录层级</span>
      </div>
      <div class="v3-upload-list" id="v3UploadList"></div>
      <div class="v3-upload-overall" id="v3UploadOverall" hidden></div>
      <div class="v3-upload-log" id="v3UploadLog" hidden></div>
    `
    const anchor = view.querySelector('.upload-card') || view.querySelector('.card') || view
    if (anchor === view) view.appendChild(card)
    else anchor.parentNode.insertBefore(card, anchor.nextSibling)

    uploadListHost = card.querySelector('#v3UploadList')
    uploadLogHost = card.querySelector('#v3UploadLog')
    renderUploadLog()
    card.querySelector('#v3PickFiles').addEventListener('click', () => fileInput.click())
    card.querySelector('#v3PickFolder').addEventListener('click', () => folderInput.click())
    card.querySelector('#v3ClearUploads').addEventListener('click', () => {
      if (uploadState.jobs.some(job => job.state === 'uploading')) {
        toast('仍有文件在上传，请先等待完成或取消')
        return
      }
      uploadState.jobs = []
      uploadState.totalBytes = 0
      uploadState.sentBytes = 0
      uploadListHost.innerHTML = ''
      updateOverall()
    })
  }

  let clientSalt = null
  function getClientSalt() {
    if (clientSalt) return clientSalt
    try {
      clientSalt = sessionStorage.getItem('v3UploadSalt')
      if (!clientSalt) {
        const bytes = new Uint32Array(2)
        if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
          window.crypto.getRandomValues(bytes)
        } else {
          bytes[0] = Date.now() >>> 0
          bytes[1] = Math.floor(Math.random() * 0xffffffff) >>> 0
        }
        clientSalt = `${bytes[0].toString(16)}${bytes[1].toString(16)}`
        sessionStorage.setItem('v3UploadSalt', clientSalt)
      }
    } catch {
      clientSalt = `fallback-${Date.now().toString(16)}`
    }
    return clientSalt
  }

  async function fileFingerprint(file) {
    try {
      const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer())
      const tail = file.size > 65536
        ? new Uint8Array(await file.slice(file.size - 65536).arrayBuffer())
        : new Uint8Array(0)
      let hash = 2166136261
      const mix = bytes => {
        for (let i = 0; i < bytes.length; i += 1) {
          hash ^= bytes[i]
          hash = Math.imul(hash, 16777619) >>> 0
        }
      }
      mix(head)
      mix(tail)
      return `${getClientSalt()}-${hash.toString(16)}-${head.length + tail.length}`
    } catch {
      return getClientSalt()
    }
  }

  function handlePicked(entries) {
    const valid = entries.filter(entry => entry && entry.file && entry.file.size > 0)
    if (!valid.length) {
      toast('没有可上传的文件', 'error')
      return
    }
    for (const entry of valid) {
      const job = {
        file: entry.file,
        dir: entry.dir || '',
        state: 'waiting',
        sent: 0,
        paused: false,
        cancelled: false,
        waiters: [],
        row: null
      }
      job.row = createUploadRow(job)
      uploadState.jobs.push(job)
      uploadState.totalBytes += job.file.size
      uploadState.queue.push(job)
    }
    toast(`已加入 ${valid.length} 个文件（共 ${formatSize(valid.reduce((sum, item) => sum + item.file.size, 0))}）`)
    pumpUploads()
    updateOverall()
  }

  function createUploadRow(job) {
    const row = el('div', 'v3-upload-item')
    const head = el('div', 'v3-upload-item-head')
    const name = el('span', 'v3-upload-item-name', `${job.dir ? `${job.dir}/` : ''}${job.file.name}`)
    const state = el('span', 'v3-upload-item-state', '等待中')
    const actions = el('span', 'v3-upload-item-actions')
    const pauseBtn = iconButton('ghost small', 'pause', '暂停')
    pauseBtn.style.cssText = 'width:24px;height:24px;'
    const cancelBtn = iconButton('ghost small', 'close', '取消')
    cancelBtn.style.cssText = 'width:24px;height:24px;margin-left:6px;'
    pauseBtn.addEventListener('click', () => {
      if (job.state === 'done' || job.state === 'error' || job.state === 'cancelled') return
      job.paused = !job.paused
      pauseBtn.innerHTML = icon(job.paused ? 'play' : 'pause')
      pauseBtn.title = job.paused ? '继续' : '暂停'
      pauseBtn.setAttribute('aria-label', pauseBtn.title)
      state.textContent = job.paused ? '已暂停' : '上传中'
      row.classList.toggle('is-paused', job.paused)
      updateUploadBadge()
      if (!job.paused) {
        const waiters = job.waiters
        job.waiters = []
        waiters.forEach(resolve => resolve())
      }
    })
    cancelBtn.addEventListener('click', () => {
      job.cancelled = true
      job.paused = false
      job.state = 'cancelled'
      const waiters = job.waiters
      job.waiters = []
      waiters.forEach(resolve => resolve())
      cancelUploadTask(job)
      state.textContent = '已取消'
      row.classList.add('is-error')
      updateOverall()
    })
    actions.appendChild(pauseBtn)
    actions.appendChild(cancelBtn)
    head.appendChild(name)
    head.appendChild(state)
    head.appendChild(actions)
    const progress = el('div', 'v3-progress')
    const bar = el('span')
    progress.appendChild(bar)
    row.appendChild(head)
    row.appendChild(progress)
    job.rowRefs = { row, state, bar }
    uploadListHost.appendChild(row)
    return row
  }

  async function cancelUploadTask(job) {
    if (!job.uploadId) return
    try {
      await fetch(`${API}/upload?uploadId=${encodeURIComponent(job.uploadId)}`, { method: 'DELETE', credentials: 'same-origin' })
    } catch {}
  }

  function pumpUploads() {
    while (uploadState.active < MAX_PARALLEL_UPLOAD && uploadState.queue.length) {
      const job = uploadState.queue.shift()
      if (job.cancelled) continue
      uploadState.active += 1
      runUpload(job)
        .catch(() => {})
        .finally(() => {
          uploadState.active -= 1
          pumpUploads()
          updateOverall()
        })
    }
    updateOverall()
  }

  function setJobProgress(job, sent, label) {
    job.sent = sent
    if (job.rowRefs) {
      const ratio = job.file.size ? Math.min(100, (sent / job.file.size) * 100) : 0
      job.rowRefs.bar.style.width = `${ratio.toFixed(1)}%`
      job.rowRefs.state.textContent = label || `${ratio.toFixed(1)}% · ${formatSize(sent)} / ${formatSize(job.file.size)}`
    }
    updateOverall()
  }

  function updateOverall() {
    const host = document.getElementById('v3UploadOverall')
    if (!host) return
    if (!uploadState.jobs.length) {
      host.hidden = true
      host.textContent = ''
      return
    }
    const counted = uploadState.jobs.filter(job => job.state !== 'cancelled' && job.state !== 'error')
    const total = counted.reduce((sum, job) => sum + job.file.size, 0)
    const sent = counted.reduce((sum, job) => sum + Math.min(job.sent || 0, job.file.size), 0)
    const done = uploadState.jobs.filter(job => job.state === 'done').length
    const errors = uploadState.jobs.filter(job => job.state === 'error').length
    const cancelled = uploadState.jobs.filter(job => job.state === 'cancelled').length
    const ratio = total ? (sent / total) * 100 : 100
    host.hidden = false
    host.textContent = `总进度 ${ratio.toFixed(1)}% · 已完成 ${done}/${uploadState.jobs.length} 个文件${errors ? ` · 失败 ${errors} 个` : ''}${cancelled ? ` · 已取消 ${cancelled} 个` : ''} · 已上传 ${formatSize(sent)} / ${formatSize(total)}`
    updateUploadBadge()
  }

  async function runUpload(job) {
    job.state = 'uploading'
    try {
      const fingerprint = await fileFingerprint(job.file)
      // 内容指纹 + 大小检测重复：内容一致才提示，同名不同内容不打扰
      try {
        const check = await api('/upload/check', {
          method: 'POST',
          body: { name: job.file.name, size: job.file.size, fingerprint }
        })
        if (check && check.duplicate && !job.forceUpload) {
          const proceed = window.confirm(`检测到相同内容的文件已存在：${check.name || job.file.name}\n是否仍要继续上传？`)
          if (!proceed) {
            job.cancelled = true
            job.state = 'cancelled'
            if (job.rowRefs) {
              job.rowRefs.state.textContent = '已跳过（重复）'
              job.rowRefs.row.classList.add('is-paused')
            }
            updateOverall()
            return
          }
          job.forceUpload = true
        }
      } catch {}
      const init = await api('/upload/init', {
        method: 'POST',
        body: {
          name: job.file.name,
          size: job.file.size,
          lastModified: job.file.lastModified,
          relativePath: job.dir,
          fingerprint
        }
      })
      job.uploadId = init.uploadId
      let offset = Number(init.received) || 0
      setJobProgress(job, offset, offset > 0 ? `断点续传 ${((offset / job.file.size) * 100).toFixed(1)}%` : '上传中')

      while (offset < job.file.size) {
        if (job.cancelled) throw new Error('已取消')
        if (job.paused) {
          await new Promise(resolve => job.waiters.push(resolve))
          if (job.cancelled) throw new Error('已取消')
          continue
        }
        const end = Math.min(offset + init.chunkSize, job.file.size)
        const blob = job.file.slice(offset, end)
        let response = null
        try {
          response = await sendChunk(init.uploadId, offset, blob, loaded => {
            setJobProgress(job, offset + loaded)
          })
        } catch (error) {
          if (error.status === 409 && error.data && typeof error.data.received === 'number') {
            offset = error.data.received
            setJobProgress(job, offset, '重新同步中')
            continue
          }
          throw error
        }
        offset = Number(response.received)
        setJobProgress(job, offset)
      }

      await api('/upload/complete', { method: 'POST', body: { uploadId: init.uploadId } })
      job.state = 'done'
      setJobProgress(job, job.file.size, '已完成')
      if (job.rowRefs) {
        job.rowRefs.row.classList.add('is-done')
      }
      pushUploadLog(job.file.name, job.file.size, job.dir)
      notifyUploadDone(job)
      const refresh = document.getElementById('refreshBtn')
      if (refresh) refresh.click()
    } catch (error) {
      if (job.cancelled || job.state === 'cancelled') {
        job.state = 'cancelled'
        if (job.rowRefs) job.rowRefs.state.textContent = '已取消'
      } else {
        job.state = 'error'
        if (job.rowRefs) {
          job.rowRefs.row.classList.add('is-error')
          job.rowRefs.state.textContent = error.message || '上传失败'
        }
        toast(`${job.file.name}：${error.message || '上传失败'}`, 'error')
      }
    }
  }

  function sendChunk(uploadId, offset, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${API}/upload/chunk`)
      xhr.setRequestHeader('x-upload-id', uploadId)
      xhr.setRequestHeader('x-offset', String(offset))
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      if (xhr.upload) {
        xhr.upload.onprogress = event => {
          if (event.lengthComputable && onProgress) onProgress(event.loaded)
        }
      }
      xhr.onload = () => {
        let data = {}
        try {
          data = JSON.parse(xhr.responseText || '{}')
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data)
          return
        }
        if (xhr.status === 401) notifyUnauthorized()
        const error = new Error(data.message || `分片上传失败（${xhr.status}）`)
        error.status = xhr.status
        error.data = data
        reject(error)
      }
      xhr.onerror = () => reject(new Error('网络异常，分片上传中断'))
      xhr.ontimeout = () => reject(new Error('分片上传超时'))
      xhr.send(blob)
    })
  }

  // 拖拽拦截：拆成独立顶层函数，避免在 bootUpload 大闭包里内联大箭头函数
  const DRAG_HOOK_TYPES = ['dragenter', 'dragover', 'dragleave', 'drop']

  function onDragHook(type, event) {
    const zone = event.target && event.target.closest ? event.target.closest('#dropZone') : null
    if (!zone) return
    event.preventDefault()
    event.stopPropagation()
    if (type === 'dragover') {
      zone.classList.add('is-dragover')
      return
    }
    if (type === 'dragleave') {
      zone.classList.remove('is-dragover')
      return
    }
    zone.classList.remove('is-dragover')
    const dt = event.dataTransfer
    if (!dt) return
    const entries = []
    if (dt.items && dt.items.length && typeof dt.items[0].webkitGetAsEntry === 'function') {
      const roots = []
      for (let index = 0; index < dt.items.length; index += 1) {
        const item = dt.items[index]
        if (item.kind !== 'file') continue
        const entry = item.webkitGetAsEntry()
        if (entry) roots.push(entry)
      }
      collectEntries(roots).then(function (list) {
        ensureUploadUI()
        handlePicked(list)
      })
      return
    }
    for (let index = 0; index < dt.files.length; index += 1) {
      entries.push({ file: dt.files[index], dir: '' })
    }
    ensureUploadUI()
    handlePicked(entries)
  }

  function onDocumentClickHook(event) {
    if (!event.target || !event.target.closest) return
    if (!event.target.closest('#selectBtn')) return
    event.preventDefault()
    event.stopPropagation()
    ensureUploadUI()
    if (fileInput) fileInput.click()
  }

  function bootUpload() {
    ensureUploadUI()
    // 拦截原有拖拽区与选择按钮，改用分片上传通道
    for (let index = 0; index < DRAG_HOOK_TYPES.length; index += 1) {
      const type = DRAG_HOOK_TYPES[index]
      document.addEventListener(type, function (event) { onDragHook(type, event) }, true)
    }
    document.addEventListener('click', onDocumentClickHook, true)
  }

  function collectEntries(roots) {
    const output = []
    const walk = (entry, prefix) => new Promise(resolve => {
      if (!entry) {
        resolve()
        return
      }
      if (entry.isFile) {
        entry.file(
          file => {
            output.push({ file, dir: prefix })
            resolve()
          },
          () => resolve()
        )
        return
      }
      if (entry.isDirectory) {
        const reader = entry.createReader()
        const dirPath = prefix ? `${prefix}/${entry.name}` : entry.name
        const readBatch = () => {
          reader.readEntries(
            async batch => {
              if (!batch.length) {
                resolve()
                return
              }
              for (const child of batch) await walk(child, dirPath)
              readBatch()
            },
            () => resolve()
          )
        }
        readBatch()
        return
      }
      resolve()
    })
    return Promise.all(roots.map(entry => walk(entry, ''))).then(() => output)
  }

  // ============================================================
  // 四、工具箱视图
  // ============================================================
  function bootMoreView() {
    const view = document.getElementById('view-more')
    if (!view) return
    const host = view.querySelector('.v3-more-body') || view
    if (!host) return

    host.innerHTML = `
      <div class="v3-tabs">
        <button type="button" class="v3-tab is-active" data-tab="trash">回收站</button>
        <button type="button" class="v3-tab" data-tab="logs">操作日志</button>
        <button type="button" class="v3-tab" data-tab="storage">存储与清理</button>
        <button type="button" class="v3-tab" data-tab="access">分享链接管理</button>
        <button type="button" class="v3-tab" data-tab="stats">统计</button>
      </div>

      <section class="v3-panel is-active" data-panel="trash">
        <div class="v3-panel-head">
          <span class="v3-panel-title">回收站</span>
          <span class="v3-panel-sub" id="v3TrashSummary">加载中…</span>
          <span class="v3-spacer"></span>
          <button type="button" class="btn icon-btn ghost small" id="v3TrashRefresh" title="刷新" aria-label="刷新">${icon('refresh')}</button>
          <button type="button" class="btn icon-btn ghost small" id="v3TrashEmpty" title="清空回收站" aria-label="清空回收站">${icon('trash')}</button>
        </div>
        <div class="v3-list" id="v3TrashList"></div>
      </section>

      <section class="v3-panel" data-panel="logs">
        <div class="v3-panel-head">
          <span class="v3-panel-title">日志记录</span>
          <span class="v3-panel-sub">操作 / 访问明细 / 服务启动</span>
          <span class="v3-spacer"></span>
          <select id="v3LogKind" style="padding:7px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:inherit;">
            <option value="operation">操作日志</option>
            <option value="detail">访问明细</option>
            <option value="access">服务启动</option>
          </select>
          <select id="v3LogFilter" style="padding:7px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:inherit;">
            <option value="all">全部类型</option>
            <option value="upload">上传</option>
            <option value="download">下载</option>
            <option value="delete">删除</option>
            <option value="restore">恢复</option>
            <option value="purge">彻底删除</option>
            <option value="trash-empty">清空回收站</option>
            <option value="zip">打包下载</option>
            <option value="share-create">创建分享</option>
            <option value="share-delete">撤销分享</option>
            <option value="share-open">访问分享</option>
            <option value="direct-link">获取直链</option>
            <option value="cleanup">自动清理</option>
            <option value="cleanup-config">清理设置</option>
            <option value="dir-view">查看文件夹</option>
            <option value="file-view">查看文件</option>
            <option value="login">设备登录</option>
            <option value="visit">访问</option>
            <option value="startup">服务启动</option>
          </select>
          <button type="button" class="btn icon-btn ghost small" id="v3LogRefresh" title="刷新日志" aria-label="刷新日志">${icon('refresh')}</button>
        </div>
        <div class="v3-list" id="v3LogList"></div>
      </section>

      <section class="v3-panel" data-panel="storage">
        <div class="v3-panel-head">
          <span class="v3-panel-title">磁盘空间</span>
          <span class="v3-panel-sub" id="v3DiskSummary">加载中…</span>
          <span class="v3-spacer"></span>
          <button type="button" class="btn icon-btn ghost small" id="v3DiskRefresh" title="刷新磁盘信息" aria-label="刷新磁盘信息">${icon('refresh')}</button>
        </div>
        <div class="v3-disk" id="v3DiskBox">
          <div class="v3-disk-bar" id="v3DiskBar"><span style="width:0%"></span></div>
          <div class="v3-disk-legend" id="v3DiskLegend"></div>
        </div>

        <div class="v3-panel-head" style="margin-top:18px">
          <span class="v3-panel-title">定时清理（默认关闭）</span>
          <span class="v3-panel-sub">仅在你手动开启后执行，执行前可预览清单；清理的文件进入回收站可恢复</span>
        </div>
        <div class="v3-form-row">
          <label class="v3-switch"><input type="checkbox" id="v3CleanEnabled"> 启用定时清理</label>
          <label>清理超过 <input type="number" id="v3CleanDays" min="1" max="3650" value="30"> 天未访问的文件</label>
          <label>检查间隔 <input type="number" id="v3CleanInterval" min="1" max="720" value="6"> 小时</label>
        </div>
        <div class="v3-form-row">
          <button type="button" class="btn icon-btn primary small" id="v3CleanSave" title="保存设置" aria-label="保存设置">${icon('save')}</button>
          <button type="button" class="btn icon-btn ghost small" id="v3CleanPreview" title="预览清理清单" aria-label="预览清理清单">${icon('eye')}</button>
          <button type="button" class="btn icon-btn ghost small" id="v3CleanRun" title="立即清理" aria-label="立即清理">${icon('bolt')}</button>
          <span class="v3-panel-sub" id="v3CleanStatus"></span>
        </div>
        <div class="v3-list" id="v3CleanList"></div>
      </section>

      <section class="v3-panel" data-panel="access">
        <div class="v3-panel-head">
          <span class="v3-panel-title">分享链接管理</span>
          <span class="v3-panel-sub">勾选多条可批量撤销，节省资源</span>
          <span class="v3-spacer"></span>
          <label class="v3-share-all" style="display:flex;align-items:center;gap:5px;font-size:12.5px;cursor:pointer"><input type="checkbox" id="v3ShareAll"> 全选</label>
          <button type="button" class="btn icon-btn danger small" id="v3ShareBatchDelete" title="批量撤销选中链接" aria-label="批量撤销选中链接">${icon('trash')}</button>
          <button type="button" class="btn icon-btn ghost small" id="v3ShareRefresh" title="刷新分享列表" aria-label="刷新分享列表">${icon('refresh')}</button>
        </div>
        <div class="v3-list" id="v3ShareList"></div>
      </section>

      <section class="v3-panel" data-panel="stats">
        <div class="v3-panel-head">
          <span class="v3-panel-title">使用统计</span>
          <span class="v3-panel-sub">上传 / 下载 / 文件查看 / 设备登录</span>
          <span class="v3-spacer"></span>
          <button type="button" class="btn icon-btn ghost small" id="v3StatsRefresh" title="刷新统计" aria-label="刷新统计">${icon('refresh')}</button>
        </div>
        <div class="v3-stats-cards" id="v3StatsCards"></div>
        <div class="v3-stats-chart" id="v3StatsTrend"></div>
        <div class="v3-stats-chart" id="v3StatsLogins"></div>
        <div class="v3-hot-grid">
          <div class="v3-stats-chart" id="v3HotView"></div>
          <div class="v3-stats-chart" id="v3HotDownload"></div>
          <div class="v3-stats-chart" id="v3HotShare"></div>
        </div>
      </section>
    `

    host.querySelectorAll('.v3-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        host.querySelectorAll('.v3-tab').forEach(node => node.classList.toggle('is-active', node === tab))
        const key = tab.dataset.tab
        host.querySelectorAll('.v3-panel').forEach(panel => panel.classList.toggle('is-active', panel.dataset.panel === key))
        if (key === 'trash') loadTrash()
        if (key === 'logs') loadLogs()
        if (key === 'storage') {
          loadDisk()
          loadCleanConfig()
        }
        if (key === 'access') loadShares()
        if (key === 'stats') loadStats()
      })
    })

    host.querySelector('#v3TrashRefresh').addEventListener('click', loadTrash)
    host.querySelector('#v3TrashEmpty').addEventListener('click', emptyTrash)
    host.querySelector('#v3LogRefresh').addEventListener('click', loadLogs)
    host.querySelector('#v3LogFilter').addEventListener('change', loadLogs)
    host.querySelector('#v3LogKind').addEventListener('change', loadLogs)
    host.querySelector('#v3DiskRefresh').addEventListener('click', loadDisk)
    host.querySelector('#v3CleanSave').addEventListener('click', saveCleanConfig)
    host.querySelector('#v3CleanPreview').addEventListener('click', previewClean)
    host.querySelector('#v3CleanRun').addEventListener('click', runCleanNow)
    host.querySelector('#v3ShareRefresh').addEventListener('click', loadShares)
    host.querySelector('#v3ShareAll').addEventListener('change', event => {
      document.querySelectorAll('#v3ShareList .v3-share-check').forEach(box => {
        box.checked = event.target.checked
      })
    })
    host.querySelector('#v3ShareBatchDelete').addEventListener('click', batchDeleteShares)
    host.querySelector('#v3StatsRefresh').addEventListener('click', loadStats)

    // 直接刷新页面进入 #/more 时，默认激活的是“回收站”标签，必须立即加载一次
    // （此前只有点击标签才会触发 loadTrash，刷新场景下汇总一直停在“加载中…”）
    const syncActivePanel = () => {
      const activePanel = host.querySelector('.v3-panel.is-active')
      const key = activePanel ? activePanel.dataset.panel : 'trash'
      if (key === 'trash') loadTrash()
      else if (key === 'logs') loadLogs()
      else if (key === 'storage') {
        loadDisk()
        loadCleanConfig()
      } else if (key === 'access') loadShares()
      else if (key === 'stats') loadStats()
    }

    // 登录态确定后再同步一次，避免首屏 401 把面板打成失败态
    document.addEventListener('app:auth', event => {
      if (event && event.detail && event.detail.authed) syncActivePanel()
    })

    window.addEventListener('hashchange', () => {
      if (String(location.hash || '').replace(/^#\/?/, '') === 'more') syncActivePanel()
    })

    // 已解锁时立即加载当前面板
    fetch('/api/auth/status', { credentials: 'same-origin' })
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (data && data.authed) syncActivePanel()
      })
      .catch(() => {})
  }

  let trashCache = []

  async function loadTrash() {
    const list = document.getElementById('v3TrashList')
    const summary = document.getElementById('v3TrashSummary')
    if (!list) return
    list.innerHTML = '<div class="v3-empty">加载中…</div>'
    try {
      const data = await api('/trash')
      trashCache = data.items || []
      if (summary) summary.textContent = `${trashCache.length} 项 · 共 ${formatSize(data.totalSize)}`
      if (!trashCache.length) {
        list.innerHTML = '<div class="v3-empty">回收站是空的</div>'
        return
      }
      list.innerHTML = ''
      for (const item of trashCache) {
        const row = el('div', 'v3-row')
        const main = el('div', 'v3-row-main')
        const name = el('div', 'v3-row-name', item.name)
        const meta = el(
          'div',
          'v3-row-meta',
          `${item.isDir ? '文件夹' : formatSize(item.size)} · 删除于 ${formatTime(item.deletedAt)} · 来源 ${item.local ? '本机' : '其他设备'}${item.reason === 'auto-clean' || item.reason === 'manual-clean' ? ' · 自动清理' : ''}`
        )
        main.appendChild(name)
        main.appendChild(meta)
        const restore = iconButton('ghost small', 'restore', '恢复')
        restore.addEventListener('click', async () => {
          try {
            const result = await api('/trash/restore', { method: 'POST', body: { ids: [item.id] } })
            if (result.failed && result.failed.length) toast(result.failed[0].error, 'error')
            else toast('已恢复')
            loadTrash()
            const refresh = document.getElementById('refreshBtn')
            if (refresh) refresh.click()
          } catch (error) {
            toast(error.message, 'error')
          }
        })
        const purge = iconButton('danger small', 'trash', '彻底删除')
        purge.addEventListener('click', async () => {
          if (!window.confirm(`确定彻底删除「${item.name}」？此操作不可恢复。`)) return
          try {
            await api('/trash/purge', { method: 'POST', body: { ids: [item.id] } })
            toast('已彻底删除')
            loadTrash()
          } catch (error) {
            toast(error.message, 'error')
          }
        })
        row.appendChild(main)
        row.appendChild(restore)
        row.appendChild(purge)
        list.appendChild(row)
      }
    } catch (error) {
      trashCache = []
      // 失败时也要结束“加载中…”状态，给出明确提示
      if (summary) summary.textContent = `加载失败`
      list.innerHTML = `<div class="v3-empty">${escapeHtml(error.message)}</div>`
    }
  }

  async function emptyTrash() {
    if (!trashCache.length) {
      toast('回收站已经是空的')
      return
    }
    if (!window.confirm(`确定清空回收站？${trashCache.length} 项将被永久删除，不可恢复。`)) return
    try {
      await api('/trash', { method: 'DELETE' })
      toast('回收站已清空')
      loadTrash()
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  const ACTION_LABELS = {
    upload: '上传',
    download: '下载',
    delete: '删除',
    restore: '恢复',
    purge: '彻底删除',
    'trash-empty': '清空回收站',
    zip: '打包下载',
    'share-create': '创建分享',
    'share-delete': '撤销分享',
    'share-open': '访问分享',
    'direct-link': '获取直链',
    cleanup: '自动清理',
    'cleanup-config': '清理设置',
    'dir-view': '查看文件夹',
    'file-view': '查看文件',
    login: '设备登录',
    visit: '访问',
    startup: '服务启动',
    other: '其他'
  }

  function actionClass(action) {
    if (action === 'upload') return 'is-upload'
    if (action === 'download' || action === 'zip') return 'is-download'
    if (action === 'delete' || action === 'purge' || action === 'trash-empty' || action === 'share-delete') return 'is-delete'
    if (action === 'cleanup' || action === 'cleanup-config') return 'is-cleanup'
    if (action === 'login' || action === 'dir-view' || action === 'file-view' || action === 'visit' || action === 'startup') return 'is-visit'
    if (action && action.startsWith('share')) return 'is-share'
    return ''
  }

  // 操作日志来源展示：「设备名称 IP」（如 Windows·Chrome 192.168.1.7）
  // 历史日志没有 device / ua 时退回原来的本机 / 其他设备文案，绝不出现 undefined
  function logSourceText(item) {
    if (!item) return '未知'
    const device = typeof item.device === 'string' ? item.device.trim() : ''
    const ip = typeof item.ip === 'string' ? item.ip.trim() : ''
    if (device && ip) return `${device} ${ip}`
    if (device) return device
    if (ip) return ip
    return item.local ? '本机' : '其他设备'
  }

  async function loadLogs() {
    const list = document.getElementById('v3LogList')
    if (!list) return
    const action = document.getElementById('v3LogFilter')?.value || 'all'
    const kind = document.getElementById('v3LogKind')?.value || 'operation'
    list.innerHTML = '<div class="v3-empty">加载中…</div>'
    try {
      const data = await api(`/logs?limit=300&action=${encodeURIComponent(action)}&kind=${encodeURIComponent(kind)}`)
      const items = data.items || []
      if (!items.length) {
        list.innerHTML = '<div class="v3-empty">暂无日志记录</div>'
        return
      }
      list.innerHTML = ''
      for (const item of items) {
        const row = el('div', 'v3-row')
        const main = el('div', 'v3-row-main')
        const head = el('div', 'v3-row-name')
        const badge = el('span', `v3-badge ${actionClass(item.action)}`, ACTION_LABELS[item.action] || item.action)
        head.appendChild(badge)
        let label = item.name || ''
        if (!label && kind === 'detail') label = `${item.method || ''} ${item.path || ''}`.trim()
        if (!label && kind === 'access') label = `端口 ${item.port || ''} · ${item.pid || ''}`.trim()
        head.appendChild(document.createTextNode(label || '—'))
        let metaText = `${formatTime(item.ts)} · 来源 ${logSourceText(item)}`
        if (kind === 'detail') metaText += ` · ${item.status || ''}${item.ms != null ? ` · ${item.ms}ms` : ''}`
        if (kind === 'access' && Array.isArray(item.urls)) metaText += ` · ${item.urls.join(' / ')}`
        if (item.size) metaText += ` · ${formatSize(item.size)}`
        if (item.count) metaText += ` · ${item.count} 个文件`
        const meta = el('div', 'v3-row-meta', metaText)
        main.appendChild(head)
        main.appendChild(meta)
        row.appendChild(main)
        list.appendChild(row)
      }
    } catch (error) {
      list.innerHTML = `<div class="v3-empty">${escapeHtml(error.message)}</div>`
    }
  }

  async function loadDisk() {
    const summary = document.getElementById('v3DiskSummary')
    const legend = document.getElementById('v3DiskLegend')
    const bar = document.getElementById('v3DiskBar')
    if (!legend) return
    try {
      const data = await api('/disk')
      if (data.error) {
        summary.textContent = `读取失败：${data.error}`
        return
      }
      const ratio = Math.min(1, data.usedRatio || 0)
      summary.textContent = `剩余 ${formatSize(data.free)} / 共 ${formatSize(data.total)}`
      bar.querySelector('span').style.width = `${(ratio * 100).toFixed(1)}%`
      bar.classList.toggle('is-warn', ratio >= 0.8 && ratio < 0.92)
      bar.classList.toggle('is-danger', ratio >= 0.92)
      legend.innerHTML = `
        <span>磁盘已用：${formatSize(data.used)}（${(ratio * 100).toFixed(1)}%）</span>
        <span>磁盘剩余：${formatSize(data.free)}</span>
        <span>本服务占用：${formatSize(data.uploadsSize)}</span>
        <span>单文件上限：${formatSize(data.maxFileSize)}</span>
      `
    } catch (error) {
      summary.textContent = error.message
    }
  }

  async function loadCleanConfig() {
    try {
      const data = await api('/cleanup')
      const conf = data.autoClean || {}
      document.getElementById('v3CleanEnabled').checked = conf.enabled === true
      document.getElementById('v3CleanDays').value = conf.days || 30
      document.getElementById('v3CleanInterval').value = conf.intervalHours || 6
      const status = document.getElementById('v3CleanStatus')
      const last = conf.lastResult
      status.textContent = last
        ? `上次执行：${formatTime(last.at)}，清理 ${last.moved} 个文件${last.failed ? `，失败 ${last.failed} 个` : ''}`
        : '尚未执行过自动清理'
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function saveCleanConfig() {
    try {
      const body = {
        enabled: document.getElementById('v3CleanEnabled').checked,
        days: Number(document.getElementById('v3CleanDays').value) || 30,
        intervalHours: Number(document.getElementById('v3CleanInterval').value) || 6
      }
      const data = await api('/cleanup/config', { method: 'POST', body })
      toast(data.autoClean.enabled ? `已启用：每 ${data.autoClean.intervalHours} 小时检查，清理 ${data.autoClean.days} 天未访问的文件` : '已关闭定时清理')
      loadCleanConfig()
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function previewClean() {
    const list = document.getElementById('v3CleanList')
    if (!list) return
    const days = Number(document.getElementById('v3CleanDays').value) || 30
    list.innerHTML = '<div class="v3-empty">正在统计…</div>'
    try {
      const data = await api(`/cleanup/preview?days=${encodeURIComponent(days)}`)
      const items = data.items || []
      if (!items.length) {
        list.innerHTML = `<div class="v3-empty">没有超过 ${data.days} 天未访问的文件，无需清理</div>`
        return
      }
      list.innerHTML = `<div class="v3-panel-head"><span class="v3-panel-sub">共 ${data.count} 个文件将被清理，合计 ${formatSize(data.totalSize)}（清理后进入回收站，可恢复）</span></div>`
      for (const item of items) {
        const row = el('div', 'v3-row')
        const main = el('div', 'v3-row-main')
        main.appendChild(el('div', 'v3-row-name', item.name))
        main.appendChild(el('div', 'v3-row-meta', `${formatSize(item.size)} · 最近访问 ${formatTime(item.lastAccessAt)} · 已闲置 ${item.idleDays} 天`))
        row.appendChild(main)
        list.appendChild(row)
      }
      if (data.truncated) {
        list.appendChild(el('div', 'v3-empty', '仅展示前 500 项，实际清理会包含全部匹配文件'))
      }
    } catch (error) {
      list.innerHTML = `<div class="v3-empty">${escapeHtml(error.message)}</div>`
    }
  }

  async function runCleanNow() {
    const days = Number(document.getElementById('v3CleanDays').value) || 30
    if (!window.confirm(`将把超过 ${days} 天未访问的文件移入回收站，确定执行？`)) return
    try {
      const data = await api('/cleanup/run', { method: 'POST', body: { days } })
      toast(`已清理 ${data.moved} 个文件${data.failed ? `，失败 ${data.failed} 个` : ''}，可在回收站恢复`)
      previewClean()
      loadTrash()
      loadCleanConfig()
      const refresh = document.getElementById('refreshBtn')
      if (refresh) refresh.click()
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function loadShares() {
    const list = document.getElementById('v3ShareList')
    if (!list) return
    list.innerHTML = '<div class="v3-empty">加载中…</div>'
    try {
      const data = await api('/shares')
      const items = data.items || []
      if (!items.length) {
        list.innerHTML = '<div class="v3-empty">还没有生成过分享链接</div>'
        return
      }
      list.innerHTML = ''
      for (const item of items) {
        const row = el('div', 'v3-row')
        const check = el('input', 'v3-share-check')
        check.type = 'checkbox'
        check.dataset.token = item.token
        row.appendChild(check)
        const main = el('div', 'v3-row-main')
        main.appendChild(el('div', 'v3-row-name', item.name))
        main.appendChild(
          el(
            'div',
            'v3-row-meta',
            `${item.expiresAt ? (item.expired ? '已过期' : `有效期至 ${formatTime(item.expiresAt)}`) : '永久有效'} · 访问 ${item.hits || 0} 次 · 创建于 ${formatTime(item.createdAt)}`
          )
        )
        const copy = iconButton('ghost small', 'copy', '复制链接')
        copy.addEventListener('click', async () => {
          const ok = await copyText(absolute(`/s/${item.token}`))
          toast(ok ? '链接已复制' : '复制失败，请手动复制')
        })
        const revoke = iconButton('danger small', 'close', '撤销分享')
        revoke.addEventListener('click', async () => {
          try {
            await api(`/shares/${encodeURIComponent(item.token)}`, { method: 'DELETE' })
            toast('已撤销')
            loadShares()
          } catch (error) {
            toast(error.message, 'error')
          }
        })
        row.appendChild(main)
        row.appendChild(copy)
        row.appendChild(revoke)
        list.appendChild(row)
      }
    } catch (error) {
      list.innerHTML = `<div class="v3-empty">${escapeHtml(error.message)}</div>`
    }
  }

  async function batchDeleteShares() {
    const tokens = [...document.querySelectorAll('#v3ShareList .v3-share-check:checked')]
      .map(box => box.dataset.token).filter(Boolean)
    if (!tokens.length) {
      toast('请先勾选要撤销的链接', 'error')
      return
    }
    if (!window.confirm(`确认撤销选中的 ${tokens.length} 条分享链接？此操作不可恢复。`)) return
    try {
      await api('/shares/batch', { method: 'DELETE', body: { tokens } })
      toast(`已批量撤销 ${tokens.length} 条链接`)
      const all = document.getElementById('v3ShareAll')
      if (all) all.checked = false
      loadShares()
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  // ============================================================
  // 统计（纯 CSS 图表，无外部依赖）
  // ============================================================
  async function loadStats() {
    const cardsHost = document.getElementById('v3StatsCards')
    const trendHost = document.getElementById('v3StatsTrend')
    const loginHost = document.getElementById('v3StatsLogins')
    if (!cardsHost || !trendHost || !loginHost) return
    const hotHosts = {
      view: document.getElementById('v3HotView'),
      download: document.getElementById('v3HotDownload'),
      share: document.getElementById('v3HotShare')
    }
    cardsHost.innerHTML = '<div class="v3-empty">加载中…</div>'
    try {
      const data = await api('/stats')
      const total = data.total || {}
      const cards = [
        { label: '上传次数', value: total.upload || 0, cls: 'up' },
        { label: '下载次数', value: total.download || 0, cls: 'down' },
        { label: '文件查看', value: total.fileView || 0, cls: 'view' },
        { label: '设备登录', value: total.login || 0, cls: 'login' }
      ]
      cardsHost.innerHTML = ''
      for (const card of cards) {
        const box = el('div', `v3-stat-card ${card.cls}`)
        box.appendChild(el('div', 'v3-stat-value', String(card.value)))
        box.appendChild(el('div', 'v3-stat-label', card.label))
        cardsHost.appendChild(box)
      }
      // 近 7 天趋势柱状图
      const trend = Array.isArray(data.trend) ? data.trend : []
      const maxTrend = Math.max(1, ...trend.flatMap(d => [d.upload, d.download]))
      trendHost.innerHTML = '<div class="v3-stats-title">近 7 天上传 / 下载趋势</div>'
      const bars = el('div', 'v3-bars')
      for (const d of trend) {
        const group = el('div', 'v3-bar-group')
        const barWrap = el('div', 'v3-bar-wrap')
        const up = el('div', 'v3-bar up')
        up.style.height = `${Math.round((d.upload / maxTrend) * 100)}%`
        up.title = `上传 ${d.upload}`
        const down = el('div', 'v3-bar down')
        down.style.height = `${Math.round((d.download / maxTrend) * 100)}%`
        down.title = `下载 ${d.download}`
        barWrap.appendChild(up)
        barWrap.appendChild(down)
        group.appendChild(barWrap)
        group.appendChild(el('div', 'v3-bar-label', d.date.slice(5)))
        bars.appendChild(group)
      }
      trendHost.appendChild(bars)
      trendHost.insertAdjacentHTML('beforeend', '<div class="v3-legend"><span class="up">上传</span><span class="down">下载</span></div>')
      // 各 IP 登录次数横向条
      const logins = Array.isArray(data.logins) ? data.logins : []
      loginHost.innerHTML = '<div class="v3-stats-title">各 IP 设备登录次数</div>'
      if (!logins.length) {
        loginHost.insertAdjacentHTML('beforeend', '<div class="v3-empty">暂无登录记录</div>')
      } else {
        const maxLogin = Math.max(1, ...logins.map(l => l.count))
        for (const item of logins) {
          const row = el('div', 'v3-login-row')
          const label = el('div', 'v3-login-label', `${item.device || '设备'} · ${item.ip}${item.local ? '（本机）' : ''}`)
          const track = el('div', 'v3-login-track')
          const fill = el('div', 'v3-login-fill')
          fill.style.width = `${Math.round((item.count / maxLogin) * 100)}%`
          track.appendChild(fill)
          row.appendChild(label)
          row.appendChild(track)
          row.appendChild(el('div', 'v3-login-count', String(item.count)))
          loginHost.appendChild(row)
        }
      }
      // 热门文件：查看 / 下载 / 分享
      const hot = data.hot || {}
      const hotTitles = { view: '热门查看文件', download: '热门下载文件', share: '热门分享文件' }
      for (const key of ['view', 'download', 'share']) {
        const host = hotHosts[key]
        if (!host) continue
        host.innerHTML = `<div class="v3-stats-title">${hotTitles[key]}</div>`
        const list = Array.isArray(hot[key]) ? hot[key] : []
        if (!list.length) {
          host.insertAdjacentHTML('beforeend', '<div class="v3-empty">暂无记录</div>')
          continue
        }
        const max = Math.max(1, ...list.map(item => item.count))
        for (const item of list) {
          const row = el('div', 'v3-hot-row')
          const label = el('div', 'v3-hot-name', item.name)
          label.title = item.name
          const track = el('div', 'v3-hot-track')
          const fill = el('div', `v3-hot-fill ${key}`)
          fill.style.width = `${Math.round((item.count / max) * 100)}%`
          track.appendChild(fill)
          row.appendChild(label)
          row.appendChild(track)
          row.appendChild(el('div', 'v3-hot-count', String(item.count)))
          host.appendChild(row)
        }
      }
    } catch (error) {
      cardsHost.innerHTML = `<div class="v3-empty">${escapeHtml(error.message)}</div>`
    }
  }

  // ============================================================
  // 扫码访问（公开视图，无需密码）
  // ============================================================
  let publicQrUrl = ''
  async function loadPublicQr() {
    const img = document.getElementById('publicQrImage')
    const label = document.getElementById('publicQrUrl')
    const errorBox = document.getElementById('publicQrError')
    if (!img) return
    try {
      const res = await fetch('/api/public/qr-target', { credentials: 'same-origin', cache: 'no-store' })
      const data = res.ok ? await res.json() : {}
      const target = String(data.url || location.origin)
      publicQrUrl = target
      if (label) label.textContent = target
      if (errorBox) errorBox.style.display = 'none'
      img.onerror = () => { if (errorBox) errorBox.style.display = 'block' }
      img.onload = () => { if (errorBox) errorBox.style.display = 'none' }
      img.src = `/api/public/qr?url=${encodeURIComponent(target)}&t=${Date.now()}`
    } catch {
      if (errorBox) errorBox.style.display = 'block'
    }
  }

  function bootPublicQr() {
    const download = document.getElementById('publicQrDownload')
    if (download) {
      download.addEventListener('click', () => {
        const img = document.getElementById('publicQrImage')
        if (!img || !img.src) return
        const link = document.createElement('a')
        link.href = img.src
        link.download = `访问二维码-${Date.now()}.svg`
        document.body.appendChild(link)
        link.click()
        link.remove()
      })
    }
    document.addEventListener('app:qrcode-view', loadPublicQr)
    // 直接以 #/qrcode 刷新时，DOMContentLoaded 后主动加载一次
    if (location.hash === '#/qrcode') setTimeout(loadPublicQr, 60)
  }

  // ============================================================
  // 五、服务器状态心跳：断开时重置上传记录，恢复后提示
  // ============================================================
  function startServerHeartbeat() {
    setInterval(async () => {
      let reachable = false
      try {
        const res = await fetch('/api/info', { credentials: 'same-origin', cache: 'no-store' })
        reachable = res.ok
      } catch {}
      if (reachable) {
        if (serverDownNotified) {
          serverDownNotified = false
          toast('服务器已恢复连接')
        }
        serverFailCount = 0
        return
      }
      serverFailCount += 1
      if (serverFailCount >= SERVER_DOWN_THRESHOLD && !serverDownNotified) {
        serverDownNotified = true
        resetUploadLog()
        uploadState.jobs = []
        uploadState.queue = []
        uploadState.totalBytes = 0
        uploadState.sentBytes = 0
        if (uploadListHost) uploadListHost.innerHTML = ''
        updateOverall()
        toast('服务器已断开，上传记录已重置', 'error')
      }
    }, 10000)
  }

  // ============================================================
  // 六、启动
  // ============================================================
  function boot() {
    // 各模块独立初始化：任一环节异常不得阻断后续模块（此前 bootUpload 抛错导致工具箱整块空白）
    const bootSteps = [['bootFileList', bootFileList], ['bootUpload', bootUpload], ['bootMoreView', bootMoreView], ['bootPublicQr', bootPublicQr]]
    for (const step of bootSteps) {
      try {
        step[1]()
      } catch (error) {
        console.warn(`[v3] ${step[0]} 初始化失败`, error)
      }
    }

    loadUploadLog()
    renderUploadLog()
    startServerHeartbeat()

    // 若列表在 V3 脚本加载前已渲染，触发一次刷新以补齐勾选框/缩略图
    const firstItem = document.querySelector('#fileList .file-item')
    if (firstItem && firstItem.dataset.v3 !== '1') {
      const refresh = document.getElementById('refreshBtn')
      if (refresh) setTimeout(() => refresh.click(), 260)
    }

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
