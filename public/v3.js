/* ============================================================
   V3.0 前端逻辑：缩略图 / 勾选打包 / 分享直链 / 拖拽进度 /
   分片续传 / 文件夹上传 / 回收站 / 日志 / 存储清理 / 扫码
   ============================================================ */
(function () {
  'use strict'

  const API = '/api/v3'
  const selected = new Set()
  const toastHost = document.createElement('div')
  toastHost.className = 'v3-toast-host'
  toastHost.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:200;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;'
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(toastHost))

  function toast(message, type) {
    const node = document.createElement('div')
    node.textContent = message
    const color = type === 'error' ? 'rgba(217,83,79,.95)' : 'rgba(24,32,44,.95)'
    node.style.cssText = `padding:10px 16px;border-radius:10px;background:${color};color:#fff;font-size:13px;box-shadow:0 10px 26px rgba(0,0,0,.35);max-width:80vw;`
    toastHost.appendChild(node)
    setTimeout(() => node.remove(), 3200)
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

  // ============================================================
  // 一、文件列表：缩略图 + 勾选 + 选择工具条
  // ============================================================
  let selectBar = null

  function ensureSelectBar() {
    const list = document.getElementById('fileList')
    if (!list) return null
    if (selectBar && document.body.contains(selectBar)) return selectBar
    const bar = el('div', 'v3-select-bar')
    bar.innerHTML = `
      <label><input type="checkbox" id="v3SelectAll"> 全选</label>
      <span class="v3-selected-count" id="v3SelectedCount">已选 0 项</span>
      <button type="button" class="btn primary small" id="v3ZipBtn">打包下载 ZIP</button>
      <button type="button" class="btn ghost small" id="v3ClearSel">清空选择</button>
      <span class="v3-hint">勾选多个文件可一键打包</span>
    `
    list.parentNode.insertBefore(bar, list)
    bar.querySelector('#v3SelectAll').addEventListener('change', event => {
      const checked = event.target.checked
      document.querySelectorAll('#fileList .v3-pick').forEach(box => {
        box.checked = checked
        syncSelect(box)
      })
    })
    bar.querySelector('#v3ClearSel').addEventListener('click', () => {
      selected.clear()
      document.querySelectorAll('#fileList .v3-pick').forEach(box => { box.checked = false })
      updateSelectCount()
    })
    bar.querySelector('#v3ZipBtn').addEventListener('click', startZip)
    selectBar = bar
    return bar
  }

  function syncSelect(box) {
    const name = box.dataset.name
    if (!name) return
    if (box.checked) selected.add(name)
    else selected.delete(name)
    updateSelectCount()
  }

  function updateSelectCount() {
    const counter = document.getElementById('v3SelectedCount')
    if (counter) counter.textContent = `已选 ${selected.size} 项`
    const zipBtn = document.getElementById('v3ZipBtn')
    if (zipBtn) zipBtn.disabled = selected.size === 0
  }

  function startZip() {
    if (!selected.size) {
      toast('请先勾选要打包的文件')
      return
    }
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = `${API}/zip`
    form.style.display = 'none'
    const input = document.createElement('textarea')
    input.name = 'names'
    input.value = JSON.stringify([...selected])
    form.appendChild(input)
    document.body.appendChild(form)
    form.submit()
    setTimeout(() => form.remove(), 5000)
    toast(`正在打包 ${selected.size} 个文件`)
  }

  // 缩略图
  const thumbQueue = []
  let thumbActive = 0
  const THUMB_PARALLEL = 2

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
      // 视频缩略图走 /media（inline + Range），不用 /files（attachment）
      thumb.dataset.stream = file.streamUrl || file.url || ''
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
    const share = el('button', 'btn ghost small v3-share', '分享/直链')
    share.type = 'button'
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

  function decorateList() {
    ensureSelectBar()
    const list = document.getElementById('fileList')
    if (!list) return
    list.querySelectorAll('.file-thumb').forEach(node => {
      if (node.dataset.done === '1') return
      node.dataset.done = '1'
      if (!node.dataset.media || node.dataset.media === 'file') {
        node.textContent = 'FILE'
        return
      }
      if (node.dataset.media === 'video' || node.dataset.media === 'audio') {
        paintMediaPlaceholder(node, node.dataset.media)
        return
      }
      node.classList.add('is-loading')
      thumbQueue.push(node)
    })
    list.querySelectorAll('.v3-pick').forEach(box => {
      box.checked = selected.has(box.dataset.name)
    })
    // 补插兜底：动作区已存在但缺分享按钮的行（含历史遗留 data-v3=1 的行）在此补齐
    list.querySelectorAll('.file-item').forEach(item => {
      if (item.querySelector('.file-actions .v3-share')) {
        item.dataset.v3 = '1'
        return
      }
      if (!ensureShareBtn(item)) scheduleShareRetry(item, 20)
    })
    pumpThumbs()
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

  // ---------- 媒体缩略图（静态类型占位，不做浏览器抽帧）----------
  // 移动端从几 GB 的视频里取帧极慢，改为静态占位：不请求媒体本体、不创建 video 元素、
  // 不做 canvas 抽帧、不写 localStorage 缓存，只按类型渲染图标（视频 ▶ / 音频 ♪）。
  // 点击缩略图播放的交互保持不变，由 app.js 的媒体行点击逻辑承担。
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
    const url = node.dataset.url
    const media = node.dataset.media
    // 视频 / 音频：直接渲染静态类型占位，不发起任何媒体请求
    if (media === 'video' || media === 'audio') {
      paintMediaPlaceholder(node, media)
      return Promise.resolve()
    }
    return new Promise(resolve => {
      if (!url) {
        node.classList.remove('is-loading')
        node.textContent = '预览'
        resolve()
        return
      }
      const img = new Image()
      img.loading = 'lazy'
      img.alt = ''
      img.onload = () => {
        node.textContent = ''
        node.classList.remove('is-loading')
        node.appendChild(img)
        resolve()
      }
      img.onerror = () => {
        node.classList.remove('is-loading')
        node.textContent = '图片'
        resolve()
      }
      img.src = url
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
    const observer = new MutationObserver(mutations => {
      const relevant = mutations.some(record => {
        const nodes = [...record.addedNodes, ...record.removedNodes]
        return nodes.some(node => {
          if (!node || node.nodeType !== 1) return false
          return !ownNodeClasses.some(cls => node.classList.contains(cls))
        })
      })
      if (relevant) decorateList()
    })
    observer.observe(list, { childList: true, subtree: true })

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
      <p class="v3-modal-tip">「免密直链」带签名，无需输入密码即可直接在电视、投影、播放器中打开；「免密码链接」生成独立页面链接，可设置过期时间。</p>
      <div class="v3-field"><span style="flex:0 0 68px">文件</span><strong style="flex:1;word-break:break-all;font-weight:500">${display.replace(/</g, '&lt;')}</strong></div>
      <div class="v3-field"><span style="flex:0 0 68px">有效期</span>
        <select id="v3Ttl">
          <option value="1">1 小时</option>
          <option value="24" selected>24 小时</option>
          <option value="168">7 天</option>
          <option value="720">30 天</option>
          <option value="0">永久有效</option>
        </select>
      </div>
      <div class="v3-modal-actions">
        <button type="button" class="btn ghost" id="v3CopyDirect">复制免密直链</button>
        <button type="button" class="btn primary" id="v3MakeShare">生成免密码链接</button>
        <button type="button" class="btn ghost" id="v3CloseShare">关闭</button>
      </div>
      <div id="v3ShareResult"></div>
    `
    mask.appendChild(modal)
    document.body.appendChild(mask)

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
        const box = el('div', 'v3-link-result')
        box.innerHTML = `<div style="opacity:.7;margin-bottom:6px">免密码直链（可直接在电视播放器打开）</div><div>${link}</div>`
        const host = modal.querySelector('#v3ShareResult')
        host.innerHTML = ''
        host.appendChild(box)
      } catch (error) {
        toast(error.message, 'error')
      } finally {
        button.disabled = false
      }
    })

    modal.querySelector('#v3MakeShare').addEventListener('click', async () => {
      const ttl = Number(modal.querySelector('#v3Ttl').value || 0)
      const button = modal.querySelector('#v3MakeShare')
      button.disabled = true
      try {
        const data = await api('/share', { method: 'POST', body: { name, ttlHours: ttl } })
        const link = absolute(data.url)
        const box = el('div', 'v3-link-result')
        box.innerHTML = `<div style="opacity:.7;margin-bottom:6px">${ttl > 0 ? `有效期至 ${formatTime(data.expiresAt)}` : '永久有效'}</div><div>${link}</div>`
        modal.querySelector('#v3ShareResult').innerHTML = ''
        modal.querySelector('#v3ShareResult').appendChild(box)
        const ok = await copyText(link)
        toast(ok ? '免密码链接已生成并复制' : '链接已生成')
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
        <button type="button" class="btn primary small" id="v3PickFiles">选择文件</button>
        <button type="button" class="btn ghost small" id="v3PickFolder">上传文件夹</button>
        <button type="button" class="btn ghost small" id="v3ClearUploads">清空列表</button>
        <span class="v3-upload-hint">支持拖拽上传、8MB 分片续传、文件夹保留目录层级</span>
      </div>
      <div class="v3-upload-list" id="v3UploadList"></div>
      <div class="v3-upload-overall" id="v3UploadOverall" hidden></div>
    `
    const anchor = view.querySelector('.upload-card') || view.querySelector('.card') || view
    if (anchor === view) view.appendChild(card)
    else anchor.parentNode.insertBefore(card, anchor.nextSibling)

    uploadListHost = card.querySelector('#v3UploadList')
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
    const pauseBtn = el('button', 'btn ghost small', '暂停')
    pauseBtn.style.cssText = 'padding:2px 8px;font-size:11.5px;'
    const cancelBtn = el('button', 'btn ghost small', '取消')
    cancelBtn.style.cssText = 'padding:2px 8px;font-size:11.5px;margin-left:6px;'
    pauseBtn.addEventListener('click', () => {
      if (job.state === 'done' || job.state === 'error' || job.state === 'cancelled') return
      job.paused = !job.paused
      pauseBtn.textContent = job.paused ? '继续' : '暂停'
      state.textContent = job.paused ? '已暂停' : '上传中'
      row.classList.toggle('is-paused', job.paused)
      if (!job.paused) {
        const waiters = job.waiters
        job.waiters = []
        waiters.forEach(resolve => resolve())
      }
    })
    cancelBtn.addEventListener('click', () => {
      job.cancelled = true
      job.paused = false
      const waiters = job.waiters
      job.waiters = []
      waiters.forEach(resolve => resolve())
      cancelUploadTask(job)
      state.textContent = '已取消'
      row.classList.add('is-error')
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
    const total = uploadState.totalBytes || 0
    const sent = uploadState.jobs.reduce((sum, job) => sum + Math.min(job.sent || 0, job.file.size), 0)
    const done = uploadState.jobs.filter(job => job.state === 'done').length
    const errors = uploadState.jobs.filter(job => job.state === 'error').length
    const ratio = total ? (sent / total) * 100 : 0
    host.hidden = false
    host.textContent = `总进度 ${ratio.toFixed(1)}% · 已完成 ${done}/${uploadState.jobs.length} 个文件${errors ? ` · 失败 ${errors} 个` : ''} · 已上传 ${formatSize(sent)} / ${formatSize(total)}`
  }

  async function runUpload(job) {
    job.state = 'uploading'
    try {
      const init = await api('/upload/init', {
        method: 'POST',
        body: {
          name: job.file.name,
          size: job.file.size,
          lastModified: job.file.lastModified,
          relativePath: job.dir
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
      const refresh = document.getElementById('refreshBtn')
      if (refresh) refresh.click()
    } catch (error) {
      job.state = 'error'
      if (job.rowRefs) {
        job.rowRefs.row.classList.add('is-error')
        job.rowRefs.state.textContent = error.message || '上传失败'
      }
      toast(`${job.file.name}：${error.message || '上传失败'}`, 'error')
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
        <button type="button" class="v3-tab" data-tab="access">扫码与分享</button>
      </div>

      <section class="v3-panel is-active" data-panel="trash">
        <div class="v3-panel-head">
          <span class="v3-panel-title">回收站</span>
          <span class="v3-panel-sub" id="v3TrashSummary">加载中…</span>
          <span class="v3-spacer"></span>
          <button type="button" class="btn ghost small" id="v3TrashRefresh">刷新</button>
          <button type="button" class="btn ghost small" id="v3TrashEmpty">清空回收站</button>
        </div>
        <div class="v3-list" id="v3TrashList"></div>
      </section>

      <section class="v3-panel" data-panel="logs">
        <div class="v3-panel-head">
          <span class="v3-panel-title">操作日志</span>
          <span class="v3-panel-sub">记录上传、下载、删除、打包、清理等操作</span>
          <span class="v3-spacer"></span>
          <select id="v3LogFilter" style="padding:7px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:inherit;">
            <option value="all">全部类型</option>
            <option value="upload">上传</option>
            <option value="download">下载</option>
            <option value="delete">删除</option>
            <option value="restore">恢复</option>
            <option value="zip">打包下载</option>
            <option value="share-create">创建分享</option>
            <option value="cleanup">清理</option>
          </select>
          <button type="button" class="btn ghost small" id="v3LogRefresh">刷新</button>
        </div>
        <div class="v3-list" id="v3LogList"></div>
      </section>

      <section class="v3-panel" data-panel="storage">
        <div class="v3-panel-head">
          <span class="v3-panel-title">磁盘空间</span>
          <span class="v3-panel-sub" id="v3DiskSummary">加载中…</span>
          <span class="v3-spacer"></span>
          <button type="button" class="btn ghost small" id="v3DiskRefresh">刷新</button>
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
          <button type="button" class="btn primary small" id="v3CleanSave">保存设置</button>
          <button type="button" class="btn ghost small" id="v3CleanPreview">预览将被清理的清单</button>
          <button type="button" class="btn ghost small" id="v3CleanRun">立即清理</button>
          <span class="v3-panel-sub" id="v3CleanStatus"></span>
        </div>
        <div class="v3-list" id="v3CleanList"></div>
      </section>

      <section class="v3-panel" data-panel="access">
        <div class="v3-panel-head">
          <span class="v3-panel-title">手机扫码访问</span>
          <span class="v3-panel-sub">手机与电脑需在同一局域网</span>
        </div>
        <div class="v3-qr-box">
          <div class="v3-qr-card"><img id="v3QrImage" alt="访问二维码"></div>
          <div class="v3-qr-side">
            <div id="v3QrUrl" style="word-break:break-all;opacity:.85"></div>
            <button type="button" class="btn ghost small" id="v3QrDownload" style="margin-top:8px">保存二维码</button>
            <div style="margin-top:16px;font-size:12.5px;opacity:.6">二维码内为当前网络下可直接访问的局域网地址，手机需与电脑处于同一网络。</div>
          </div>
        </div>
        <div id="v3QrError" style="display:none;margin-top:14px;padding:10px 14px;border-radius:10px;background:rgba(217,83,79,.14);border:1px solid rgba(217,83,79,.45);font-size:13px;line-height:1.6;align-items:center;gap:10px;flex-wrap:wrap">
          <span id="v3QrErrorText">二维码加载失败</span>
          <button type="button" class="btn primary small" id="v3QrRelogin">重新登录</button>
        </div>
        <div class="v3-panel-head" style="margin-top:22px">
          <span class="v3-panel-title">分享链接管理</span>
          <span class="v3-panel-sub">已生成的分享链接列表，可复制或撤销</span>
          <span class="v3-spacer"></span>
          <button type="button" class="btn ghost small" id="v3ShareRefresh">刷新列表</button>
        </div>
        <div class="v3-list" id="v3ShareList"></div>
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
        if (key === 'access') {
          loadQr()
          loadShares()
        }
      })
    })

    host.querySelector('#v3TrashRefresh').addEventListener('click', loadTrash)
    host.querySelector('#v3TrashEmpty').addEventListener('click', emptyTrash)
    host.querySelector('#v3LogRefresh').addEventListener('click', loadLogs)
    host.querySelector('#v3LogFilter').addEventListener('change', loadLogs)
    host.querySelector('#v3DiskRefresh').addEventListener('click', loadDisk)
    host.querySelector('#v3CleanSave').addEventListener('click', saveCleanConfig)
    host.querySelector('#v3CleanPreview').addEventListener('click', previewClean)
    host.querySelector('#v3CleanRun').addEventListener('click', runCleanNow)
    host.querySelector('#v3QrDownload').addEventListener('click', downloadQr)
    host.querySelector('#v3QrRelogin').addEventListener('click', reloginFromQr)
    host.querySelector('#v3ShareRefresh').addEventListener('click', loadShares)

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
      } else if (key === 'access') {
        loadQr()
        loadShares()
      }
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
        const restore = el('button', 'btn ghost small', '恢复')
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
        const purge = el('button', 'btn ghost small', '彻底删除')
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
      list.innerHTML = `<div class="v3-empty">${error.message}</div>`
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
    'share-open': '访问分享',
    cleanup: '自动清理',
    'cleanup-config': '清理设置'
  }

  function actionClass(action) {
    if (action === 'upload') return 'is-upload'
    if (action === 'download') return 'is-download'
    if (action === 'delete' || action === 'purge' || action === 'trash-empty') return 'is-delete'
    if (action === 'cleanup') return 'is-cleanup'
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
    list.innerHTML = '<div class="v3-empty">加载中…</div>'
    try {
      const data = await api(`/logs?limit=300&action=${encodeURIComponent(action)}`)
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
        head.appendChild(document.createTextNode(item.name || '—'))
        const meta = el(
          'div',
          'v3-row-meta',
          `${formatTime(item.ts)} · 来源 ${logSourceText(item)}${item.size ? ` · ${formatSize(item.size)}` : ''}${item.count ? ` · ${item.count} 个文件` : ''}`
        )
        main.appendChild(head)
        main.appendChild(meta)
        row.appendChild(main)
        list.appendChild(row)
      }
    } catch (error) {
      list.innerHTML = `<div class="v3-empty">${error.message}</div>`
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
      list.innerHTML = `<div class="v3-empty">${error.message}</div>`
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

  let qrTargetUrl = ''

  function showQrError(message) {
    const box = document.getElementById('v3QrError')
    const text = document.getElementById('v3QrErrorText')
    if (text) text.textContent = message
    if (box) box.style.display = 'flex'
  }

  function hideQrError() {
    const box = document.getElementById('v3QrError')
    if (box) box.style.display = 'none'
  }

  function reloginFromQr() {
    // 强制回到首页并重新走验证流程
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {}).finally(() => {
      location.hash = '#/home'
      location.reload()
    })
  }

  // 二维码地址：由服务端按访问者来源网段挑选真实局域网地址，绝不使用打码地址
  async function resolveQrTarget() {
    try {
      const res = await fetch(`${API}/qr-target`, { credentials: 'same-origin' })
      if (res.status === 401) return { expired: true, url: '' }
      if (res.ok) {
        const data = await res.json()
        if (data && data.url) return { expired: false, url: data.url }
      }
    } catch {}
    // 兜底 1：当前页面自身的来源地址（手机用 IP 打开时最可靠）
    const origin = String(location.origin || '')
    if (/^https?:\/\//i.test(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(origin)) {
      return { expired: false, url: origin }
    }
    // 兜底 2：/api/info 返回的真实地址
    try {
      const info = await fetch('/api/info', { credentials: 'same-origin' }).then(res => (res.ok ? res.json() : null))
      const urls = (info && info.urls) || []
      const real = urls.find(url => !String(url).includes('*'))
      if (real) return { expired: false, url: real }
    } catch {}
    return { expired: false, url: '' }
  }

  async function loadQr() {
    const img = document.getElementById('v3QrImage')
    const label = document.getElementById('v3QrUrl')
    if (!img) return
    hideQrError()
    const resolved = await resolveQrTarget()
    if (resolved.expired) {
      qrTargetUrl = ''
      img.removeAttribute('src')
      if (label) label.textContent = '登录会话已过期，无法生成二维码'
      showQrError('登录会话已过期，二维码无法加载。请点击「重新登录」后刷新本页。')
      return
    }
    const target = resolved.url || `${location.origin}`
    qrTargetUrl = target
    // 页面内不展示具体 IP / 地址，仅提示扫码可用
    if (label) label.textContent = '二维码已按当前网络生成，手机扫码即可打开'
    img.onerror = () => {
      img.removeAttribute('src')
      showQrError('二维码加载失败。可能是登录状态已失效，请点击「重新登录」后重试。')
    }
    img.onload = () => hideQrError()
    img.src = `${API}/qr?url=${encodeURIComponent(target)}&t=${Date.now()}`
  }

  function downloadQr() {
    const img = document.getElementById('v3QrImage')
    if (!img || !img.src) return
    const link = document.createElement('a')
    link.href = img.src
    link.download = `访问二维码-${Date.now()}.svg`
    document.body.appendChild(link)
    link.click()
    link.remove()
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
        const main = el('div', 'v3-row-main')
        main.appendChild(el('div', 'v3-row-name', item.name))
        main.appendChild(
          el(
            'div',
            'v3-row-meta',
            `${item.expiresAt ? (item.expired ? '已过期' : `有效期至 ${formatTime(item.expiresAt)}`) : '永久有效'} · 访问 ${item.hits || 0} 次 · 创建于 ${formatTime(item.createdAt)}`
          )
        )
        const copy = el('button', 'btn ghost small', '复制链接')
        copy.addEventListener('click', async () => {
          const ok = await copyText(absolute(`/s/${item.token}`))
          toast(ok ? '链接已复制' : '复制失败，请手动复制')
        })
        const revoke = el('button', 'btn ghost small', '撤销')
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
      list.innerHTML = `<div class="v3-empty">${error.message}</div>`
    }
  }

  // ============================================================
  // 五、启动
  // ============================================================
  function boot() {
    // 各模块独立初始化：任一环节异常不得阻断后续模块（此前 bootUpload 抛错导致工具箱整块空白）
    const bootSteps = [['bootFileList', bootFileList], ['bootUpload', bootUpload], ['bootMoreView', bootMoreView]]
    for (const step of bootSteps) {
      try {
        step[1]()
      } catch (error) {
        console.warn(`[v3] ${step[0]} 初始化失败`, error)
      }
    }

    // 若列表在 V3 脚本加载前已渲染，触发一次刷新以补齐勾选框/缩略图
    const firstItem = document.querySelector('#fileList .file-item')
    if (firstItem && firstItem.dataset.v3 !== '1') {
      const refresh = document.getElementById('refreshBtn')
      if (refresh) setTimeout(() => refresh.click(), 260)
    }

    document.addEventListener('click', event => {
      const entry = event.target && event.target.closest ? event.target.closest('[data-view="more"]') : null
      if (!entry) return
      setTimeout(() => {
        loadTrash()
        loadDisk()
      }, 260)
    })

    const refresh = document.getElementById('refreshBtn')
    if (refresh) refresh.addEventListener('click', () => setTimeout(decorateList, 500))
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
