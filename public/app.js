(() => {
  'use strict'

  const $ = id => document.getElementById(id)

  const viewMap = {
    home: $('view-home'),
    files: $('view-files'),
    upload: $('view-upload'),
    text: $('view-text'),
    more: $('view-more'),
    info: $('view-info')
  }
  const PROTECTED_VIEWS = new Set(['files', 'upload', 'text', 'more'])
  const CATEGORY_LABELS = {
    all: '全部',
    video: '视频',
    audio: '音频',
    image: '图片',
    installer: '安装包',
    doc: '文档',
    other: '其他'
  }
  const INSTALLER_EXTS = ['exe', 'msi', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appx', 'msix']
  const DOC_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'json', 'log', 'ini', 'conf', 'html', 'css', 'js', 'ts', 'py', 'java', 'sql']
  const ARCHIVE_EXTS = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso']

  const els = {
    urls: $('urls'),
    urlsInfo: $('urlsInfo'),
    authBtn: $('authBtn'),
    fileFilters: $('fileFilters'),
    fileSummary: $('fileSummary'),
    fileList: $('fileList'),
    search: $('search'),
    sortSelect: $('sortSelect'),
    sortOrderBtn: $('sortOrderBtn'),
    refreshBtn: $('refreshBtn'),
    dropZone: $('dropZone'),
    fileInput: $('fileInput'),
    selectBtn: $('selectBtn'),
    uploadQueue: $('uploadQueue'),
    maxSize: $('maxSize'),
    sharedText: $('sharedText'),
    sharedTextStatus: $('sharedTextStatus'),
    saveTextBtn: $('saveTextBtn'),
    copyTextBtn: $('copyTextBtn'),
    pasteTextBtn: $('pasteTextBtn'),
    refreshTextBtn: $('refreshTextBtn'),
    historyTextBtn: $('historyTextBtn'),
    clearTextBtn: $('clearTextBtn'),
    historyModal: $('historyModal'),
    historyList: $('historyList'),
    closeHistoryBtn: $('closeHistoryBtn'),
    clearHistoryBtn: $('clearHistoryBtn'),
    playerModal: $('playerModal'),
    playerTitle: $('playerTitle'),
    playerSubtitle: $('playerSubtitle'),
    playerStage: $('playerStage'),
    closePlayerBtn: $('closePlayerBtn'),
    authModal: $('authModal'),
    passwordInput: $('passwordInput'),
    authSubmitBtn: $('authSubmitBtn'),
    authCancelBtn: $('authCancelBtn'),
    authError: $('authError'),
    infoMaxSize: $('infoMaxSize'),
    infoPort: $('infoPort'),
    infoAuth: $('infoAuth'),
    toast: $('toast')
  }

  const state = {
    files: [],
    filesSignature: '',
    category: 'all',
    sort: 'time',
    order: 'desc',
    keyword: '',
    info: {},
    authed: false,
    authChecked: false,
    pendingView: null,
    currentView: 'home'
  }

  const sharedTextState = { dirty: false, lastLoaded: '', loading: false, saving: false, requestId: 0 }

  // ---------------- 通用工具 ----------------
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '--'
    if (bytes < 1024) return `${bytes} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = bytes / 1024
    let index = 0
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024
      index += 1
    }
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`
  }

  function formatTime(ms) {
    const date = new Date(ms)
    const pad = value => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function displayName(name) {
    return String(name).replace(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[\w-]+?-[\w]{8}-/, '')
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  let toastTimer = null
  function toast(message) {
    els.toast.textContent = message
    els.toast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600)
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      const helper = document.createElement('textarea')
      helper.value = text
      helper.style.position = 'fixed'
      helper.style.opacity = '0'
      document.body.appendChild(helper)
      helper.select()
      let ok = false
      try {
        ok = document.execCommand('copy')
      } catch {
        ok = false
      }
      document.body.removeChild(helper)
      return ok
    }
  }

  function categoryOf(file) {
    const ext = String(file.ext || '').toLowerCase()
    if (file.mediaType === 'video') return 'video'
    if (file.mediaType === 'audio') return 'audio'
    if (file.mediaType === 'image') return 'image'
    if (INSTALLER_EXTS.includes(ext)) return 'installer'
    if (DOC_EXTS.includes(ext)) return 'doc'
    if (ARCHIVE_EXTS.includes(ext)) return 'other'
    return 'other'
  }

  function categoryLabelOf(file) {
    const key = categoryOf(file)
    if (key === 'other' && ARCHIVE_EXTS.includes(String(file.ext || '').toLowerCase())) return '压缩包'
    return CATEGORY_LABELS[key] || '其他'
  }

  function isMedia(file) {
    return Boolean(file.streamUrl)
  }

  // ---------------- 接口封装 ----------------
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options })
    if (response.status === 401) {
      setAuth(false)
      openAuth(state.currentView)
      throw new Error('请先验证访问密码')
    }
    return response
  }

  // V3 工具箱等模块通过事件上报 401，统一回到这里处理登录态
  document.addEventListener('app:unauthorized', () => {
    if (!state.authed) return
    setAuth(false)
    openAuth(state.currentView)
  })

  // ---------------- 门禁 ----------------
  function setAuth(authed) {
    state.authed = authed
    state.authChecked = true
    els.authBtn.hidden = !authed
    document.querySelectorAll('[data-lock]').forEach(el => {
      el.textContent = authed ? '已解锁' : '需要密码'
      el.classList.toggle('unlocked', authed)
    })
    if (els.infoAuth) els.infoAuth.textContent = authed ? '已验证' : '未验证'
    // 广播鉴权结果，供 V3 工具箱等模块在登录态确定后再加载数据（避免首屏 401 卡在“加载中”）
    try {
      document.dispatchEvent(new CustomEvent('app:auth', { detail: { authed } }))
    } catch {
      // 忽略事件派发异常
    }
  }

  async function checkAuth() {
    try {
      const response = await fetch('/api/auth/status', { credentials: 'same-origin' })
      const data = await response.json()
      setAuth(Boolean(data.authed))
    } catch {
      setAuth(false)
    }
  }

  function openAuth(pending) {
    state.pendingView = PROTECTED_VIEWS.has(pending) ? pending : state.pendingView
    els.authError.hidden = true
    els.authModal.hidden = false
    setTimeout(() => els.passwordInput.focus(), 80)
  }

  function closeAuth() {
    els.authModal.hidden = true
    els.passwordInput.value = ''
    els.authError.hidden = true
    els.authSubmitBtn.disabled = false
    els.authSubmitBtn.textContent = '验证并进入'
  }

  function showAuthError(message) {
    els.authError.textContent = message
    els.authError.hidden = false
    els.authModal.querySelector('.modal-card').classList.remove('shake')
    void els.authModal.offsetWidth
    els.authModal.querySelector('.modal-card').classList.add('shake')
  }

  async function submitPassword() {
    const password = els.passwordInput.value
    if (!password) {
      showAuthError('请输入访问密码')
      return
    }
    els.authSubmitBtn.disabled = true
    els.authSubmitBtn.textContent = '验证中…'
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.message || '验证失败，请重试')
      setAuth(true)
      closeAuth()
      toast('验证通过，已解锁功能页')
      applyRoute()
    } catch (error) {
      showAuthError(error.message)
      // 验证失败自动清空输入框，需重新输入
      els.passwordInput.value = ''
      els.passwordInput.focus()
      els.authSubmitBtn.disabled = false
      els.authSubmitBtn.textContent = '验证并进入'
    }
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    } catch {
      // 忽略网络异常，前端状态照常清除
    }
    setAuth(false)
    state.files = []
    els.fileList.innerHTML = ''
    els.fileFilters.innerHTML = ''
    if (location.hash !== '#/home') {
      location.hash = '#/home'
    }
    applyRoute()
    toast('已退出验证，功能页已锁定')
  }

  // ---------------- 视图切换 ----------------
  function routeName() {
    const raw = String(location.hash || '').replace(/^#\/?/, '')
    return viewMap[raw] ? raw : 'home'
  }

  // instant=true 用于首屏渲染：不做离场/入场动画，直接按目标视图切换
  function showView(name, instant) {
    const next = viewMap[name]
    if (!next) return
    if (instant) {
      Object.entries(viewMap).forEach(([key, view]) => {
        if (!view) return
        view.classList.remove('view-enter', 'view-leave')
        view.hidden = key !== name
      })
      state.currentView = name
      return
    }
    const current = Object.values(viewMap).find(view => view && !view.hidden)
    if (current === next) {
      state.currentView = name
      return
    }
    if (current) {
      const leaving = current
      leaving.classList.remove('view-enter')
      leaving.classList.add('view-leave')
      setTimeout(() => {
        if (!leaving.classList.contains('view-leave')) return
        leaving.hidden = true
        leaving.classList.remove('view-leave')
      }, 150)
    }
    next.hidden = false
    next.classList.remove('view-enter')
    void next.offsetWidth
    next.classList.add('view-enter')
    state.currentView = name
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function applyRoute(options) {
    const name = routeName()
    const instant = Boolean(options && options.instant)
    if (PROTECTED_VIEWS.has(name) && !state.authed) {
      state.pendingView = name
      // 首屏鉴权结果未回来前，直接按 hash 渲染目标页骨架，避免先渲染首页再跳转造成闪烁
      if (!state.authChecked) {
        showView(name, instant)
        return
      }
      showView('home')
      openAuth(name)
      return
    }
    showView(name, instant)
    if (name === 'files') loadFiles()
    else if (name === 'text') loadSharedText(true)
    else if (name === 'info') loadInfo()
    else if (name === 'upload') loadInfo()
  }

  // ---------------- 服务信息 ----------------
  async function loadInfo() {
    try {
      const response = await fetch('/api/info', { credentials: 'same-origin' })
      const data = await response.json()
      state.info = data
      els.maxSize.textContent = `单文件上限 ${formatBytes(data.maxFileSize)}`
      els.infoMaxSize.textContent = formatBytes(data.maxFileSize)
      els.infoPort.textContent = String(data.port)
      renderUrls(data.urls || [], data.local !== false)
    } catch {
      els.maxSize.textContent = ''
    }
  }

  function renderUrls(urls, local) {
    const showFull = local !== false
    const list = Array.isArray(urls) ? urls : []
    const build = () => list.map(url => {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = showFull ? 'url-chip' : 'url-chip masked'
      chip.textContent = url
      chip.addEventListener('click', async () => {
        if (!showFull) {
          toast('非本机访问，完整地址已隐藏')
          return
        }
        const ok = await copyToClipboard(url)
        toast(ok ? '地址已复制' : '复制失败，请手动选择')
      })
      return chip
    })
    ;[els.urls, els.urlsInfo].forEach(container => {
      if (!container) return
      container.innerHTML = ''
      if (!list.length) {
        container.textContent = '--'
        return
      }
      build().forEach(chip => container.appendChild(chip))
      if (!showFull) {
        const note = document.createElement('span')
        note.className = 'url-note'
        note.textContent = '仅本机访问显示完整地址'
        container.appendChild(note)
      }
    })
  }

  // ---------------- 文件列表：筛选 / 排序 ----------------
  function filteredFiles() {
    const keyword = state.keyword.trim().toLowerCase()
    return state.files.filter(file => {
      if (state.category !== 'all' && categoryOf(file) !== state.category) return false
      if (keyword && !displayName(file.name).toLowerCase().includes(keyword)) return false
      return true
    })
  }

  function sortedFiles(list) {
    const direction = state.order === 'asc' ? 1 : -1
    const byName = (a, b) => displayName(a.name).localeCompare(displayName(b.name), 'zh-CN', { numeric: true })
    const comparators = {
      time: (a, b) => a.updatedAt - b.updatedAt,
      size: (a, b) => a.size - b.size,
      name: byName,
      type: (a, b) => {
        const diff = categoryLabelOf(a).localeCompare(categoryLabelOf(b), 'zh-CN')
        return diff !== 0 ? diff : byName(a, b)
      }
    }
    const comparator = comparators[state.sort] || comparators.time
    return [...list].sort((a, b) => comparator(a, b) * direction)
  }

  function renderFilters() {
    const counts = { all: state.files.length }
    state.files.forEach(file => {
      const key = categoryOf(file)
      counts[key] = (counts[key] || 0) + 1
    })
    const order = ['all', 'video', 'audio', 'image', 'installer', 'doc', 'other']
    els.fileFilters.innerHTML = ''
    order.forEach(key => {
      const count = counts[key] || 0
      if (key !== 'all' && count === 0) return
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = `filter-chip${state.category === key ? ' active' : ''}`
      chip.innerHTML = `${escapeHtml(CATEGORY_LABELS[key])}<span class="filter-count">${count}</span>`
      chip.addEventListener('click', () => {
        state.category = key
        renderFilters()
        renderFiles()
      })
      els.fileFilters.appendChild(chip)
    })
  }

  function renderFiles() {
    const list = sortedFiles(filteredFiles())
    const totalSize = list.reduce((sum, file) => sum + (file.size || 0), 0)
    els.fileSummary.textContent = `共 ${state.files.length} 个文件，当前显示 ${list.length} 个，合计 ${formatBytes(totalSize)}`

    if (!list.length) {
      els.fileList.innerHTML = '<div class="empty">暂无符合条件的文件</div>'
      if (typeof window.__v3PruneSelection === 'function') {
        window.__v3PruneSelection(state.files.map(file => file.name))
      }
      return
    }

    els.fileList.innerHTML = ''
    list.forEach((file, index) => {
      const item = document.createElement('div')
      item.className = 'file-item'
      item.style.setProperty('--delay', `${Math.min(index * 35, 280)}ms`)
      if (typeof window.__v3AddItemExtras === 'function') {
        window.__v3AddItemExtras(item, file)
      }

      const info = document.createElement('div')
      const name = document.createElement('div')
      name.className = 'file-name'
      name.textContent = displayName(file.name)
      const meta = document.createElement('div')
      meta.className = 'file-meta'
      meta.innerHTML = `<span class="file-tag">${escapeHtml(categoryLabelOf(file))}</span>${escapeHtml(formatBytes(file.size))} · ${escapeHtml(formatTime(file.updatedAt))}`
      info.appendChild(name)
      info.appendChild(meta)

      const actions = document.createElement('div')
      actions.className = 'file-actions'

      const downloadLink = document.createElement('a')
      downloadLink.className = 'btn ghost small'
      downloadLink.href = file.url
      downloadLink.textContent = '下载'
      downloadLink.setAttribute('download', displayName(file.name))
      actions.appendChild(downloadLink)

      const copyBtn = document.createElement('button')
      copyBtn.type = 'button'
      copyBtn.className = 'btn ghost small'
      copyBtn.textContent = '复制链接'
      copyBtn.addEventListener('click', async () => {
        const ok = await copyToClipboard(`${location.origin}${file.url}`)
        toast(ok ? '链接已复制（对方设备需先通过密码验证）' : '复制失败，请手动复制')
      })
      actions.appendChild(copyBtn)

      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.className = 'btn danger small'
      deleteBtn.textContent = '删除'
      deleteBtn.addEventListener('click', () => deleteFile(file))
      actions.appendChild(deleteBtn)

      item.appendChild(info)
      item.appendChild(actions)

      // 媒体文件：点击最左侧缩略图直接播放（原「播放」按钮已移除）
      if (isMedia(file)) {
        item.classList.add('is-media-row')
        item.addEventListener('click', event => {
          const thumb = event.target && event.target.closest ? event.target.closest('.file-thumb') : null
          if (!thumb) return
          event.preventDefault()
          openPlayer(file)
        })
      }

      els.fileList.appendChild(item)
    })
    if (typeof window.__v3PruneSelection === 'function') {
      window.__v3PruneSelection(state.files.map(file => file.name))
    }
  }

  // 列表数据指纹：用于判断轮询返回的数据是否真的变化，避免无变动时反复重建行
  function filesSignature(files) {
    return (files || [])
      .map(file => [file.name, file.size || 0, file.updatedAt || '', file.url || '', file.streamUrl || '', file.mediaType || '', file.displayName || ''].join('\u0001'))
      .join('\u0002')
  }

  async function loadFiles(silent = false) {
    if (!state.authed) return
    try {
      const response = await api('/api/files')
      if (!response.ok) throw new Error('文件列表加载失败')
      const data = await response.json()
      const nextFiles = data.files || []
      const nextSignature = filesSignature(nextFiles)
      const changed = nextSignature !== state.filesSignature
      state.files = nextFiles
      state.filesSignature = nextSignature
      // 静默轮询且数据未变：不重建列表，保住现有 DOM 与缩略图
      if (silent && !changed) return
      renderFilters()
      renderFiles()
    } catch (error) {
      if (!silent) toast(error.message)
    }
  }

  async function deleteFile(file) {
    const ok = window.confirm(`确定删除「${displayName(file.name)}」？该文件会从服务端上传目录中移除。`)
    if (!ok) return
    try {
      const response = await api(`/api/files/${encodeURIComponent(file.name)}`, { method: 'DELETE' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.message || '删除失败')
      toast('已删除')
      loadFiles()
    } catch (error) {
      toast(error.message)
    }
  }

  // ---------------- 上传 ----------------
  function addUploadItem(file) {
    const item = document.createElement('div')
    item.className = 'upload-item'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = file.name
    const status = document.createElement('div')
    status.className = 'status'
    status.textContent = '等待上传'
    const track = document.createElement('div')
    track.className = 'progress-track'
    const bar = document.createElement('div')
    bar.className = 'progress-bar'
    track.appendChild(bar)
    item.appendChild(name)
    item.appendChild(status)
    item.appendChild(track)
    els.uploadQueue.appendChild(item)
    return { item, status, bar }
  }

  function uploadFile(file) {
    return new Promise(resolve => {
      const limit = state.info.maxFileSize
      if (limit && file.size > limit) {
        const ui = addUploadItem(file)
        ui.status.classList.add('error')
        ui.status.textContent = `超过单文件上限 ${formatBytes(limit)}`
        resolve(false)
        return
      }

      const ui = addUploadItem(file)
      const formData = new FormData()
      formData.append('file', file)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/upload')
      xhr.withCredentials = true

      xhr.upload.addEventListener('progress', event => {
        if (!event.lengthComputable) return
        const percent = Math.min(100, Math.round((event.loaded / event.total) * 100))
        ui.bar.style.width = `${percent}%`
        ui.status.textContent = `${percent}% · ${formatBytes(event.loaded)} / ${formatBytes(event.total)}`
      })

      xhr.addEventListener('load', () => {
        let data = {}
        try {
          data = JSON.parse(xhr.responseText || '{}')
        } catch {
          data = {}
        }
        if (xhr.status === 401) {
          setAuth(false)
          openAuth('upload')
          ui.status.classList.add('error')
          ui.status.textContent = '需要验证访问密码'
          resolve(false)
          return
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          ui.bar.style.width = '100%'
          ui.status.classList.remove('error')
          ui.status.classList.add('done')
          ui.status.textContent = '上传完成'
          resolve(true)
          return
        }
        ui.status.classList.add('error')
        ui.status.textContent = data.message || `上传失败（${xhr.status}）`
        resolve(false)
      })

      xhr.addEventListener('error', () => {
        ui.status.classList.add('error')
        ui.status.textContent = '网络异常，上传中断'
        resolve(false)
      })

      xhr.addEventListener('abort', () => {
        ui.status.classList.add('error')
        ui.status.textContent = '已取消上传'
        resolve(false)
      })

      xhr.send(formData)
    })
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length) return
    for (const file of files) {
      // 逐个串行上传，避免多条大文件连接同时占用带宽与内存
      await uploadFile(file)
    }
    toast('上传任务已处理完成')
    if (state.currentView === 'files') loadFiles(true)
  }

  // ---------------- 共享文本 ----------------
  function setSharedTextStatus(message, type = '') {
    els.sharedTextStatus.textContent = message
    els.sharedTextStatus.classList.remove('done', 'error')
    if (type) els.sharedTextStatus.classList.add(type)
  }

  async function loadSharedText(force = false) {
    if (!state.authed || sharedTextState.loading) return
    if (!force && (sharedTextState.dirty || document.activeElement === els.sharedText)) return
    const requestId = ++sharedTextState.requestId
    sharedTextState.loading = true
    try {
      const response = await api('/api/shared-text')
      if (!response.ok) throw new Error('读取失败')
      const data = await response.json()
      const text = data.text || ''
      // 请求期间用户可能已输入或保存，过期响应一律丢弃，不能覆盖编辑框
      if (requestId !== sharedTextState.requestId || sharedTextState.dirty || document.activeElement === els.sharedText) return
      if (text !== sharedTextState.lastLoaded) {
        sharedTextState.lastLoaded = text
        els.sharedText.value = text
      }
      sharedTextState.dirty = false
      setSharedTextStatus(text ? '已同步' : '暂无内容', 'done')
    } catch (error) {
      setSharedTextStatus(error.message, 'error')
    } finally {
      sharedTextState.loading = false
    }
  }

  async function saveSharedText() {
    if (sharedTextState.saving) return
    const text = els.sharedText.value
    if (!text.trim()) {
      setSharedTextStatus('内容为空，未保存', 'error')
      toast('内容为空，未保存')
      return
    }
    sharedTextState.saving = true
    setSharedTextStatus('保存中…')
    try {
      const response = await api('/api/shared-text', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.message || '保存失败')
      sharedTextState.requestId += 1
      sharedTextState.lastLoaded = text
      const changedWhileSaving = els.sharedText.value !== text
      sharedTextState.dirty = changedWhileSaving
      setSharedTextStatus(changedWhileSaving ? '已保存，但编辑框有新修改未保存' : '已保存', changedWhileSaving ? '' : 'done')
      toast('已保存')
    } catch (error) {
      setSharedTextStatus(error.message, 'error')
      toast(error.message)
    } finally {
      sharedTextState.saving = false
    }
  }

  async function clearSharedText() {
    const ok = window.confirm('确定清空当前共享文本？清空后其他设备将同步为空（历史记录仍保留）。')
    if (!ok) return
    try {
      const response = await api('/api/shared-text', { method: 'DELETE' })
      if (!response.ok) throw new Error('清空失败')
      els.sharedText.value = ''
      sharedTextState.lastLoaded = ''
      sharedTextState.dirty = false
      setSharedTextStatus('已清空', 'done')
      toast('已清空')
    } catch (error) {
      setSharedTextStatus(error.message, 'error')
    }
  }

  function renderHistory(history) {
    els.historyList.innerHTML = ''
    if (!history.length) {
      els.historyList.innerHTML = '<div class="empty">暂无历史记录</div>'
      return
    }
    history.forEach(record => {
      const item = document.createElement('div')
      item.className = 'history-item'

      const meta = document.createElement('div')
      meta.className = 'history-meta'
      meta.innerHTML = `<span>${escapeHtml(formatTime(record.createdAt))}</span><span>${escapeHtml(formatBytes(new Blob([record.text || '']).size))}</span>`

      const content = document.createElement('pre')
      content.className = 'history-content'
      content.textContent = record.text || ''

      const actions = document.createElement('div')
      actions.className = 'history-actions'

      const useBtn = document.createElement('button')
      useBtn.type = 'button'
      useBtn.className = 'btn ghost small'
      useBtn.textContent = '载入编辑'
      useBtn.addEventListener('click', () => {
        els.sharedText.value = record.text || ''
        sharedTextState.dirty = true
        closeHistory()
        toast('已载入到编辑框，保存后生效')
      })

      const copyBtn = document.createElement('button')
      copyBtn.type = 'button'
      copyBtn.className = 'btn ghost small'
      copyBtn.textContent = '复制'
      copyBtn.addEventListener('click', async () => {
        const ok = await copyToClipboard(record.text || '')
        toast(ok ? '已复制' : '复制失败')
      })

      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.className = 'btn danger small'
      deleteBtn.textContent = '删除'
      deleteBtn.addEventListener('click', async () => {
        const ok = window.confirm('确定删除这条历史记录？')
        if (!ok) return
        try {
          const response = await api(`/api/shared-text/history/${encodeURIComponent(record.id)}`, { method: 'DELETE' })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.message || '删除失败')
          toast('已删除该记录')
          openHistory(true)
        } catch (error) {
          toast(error.message)
        }
      })

      actions.appendChild(useBtn)
      actions.appendChild(copyBtn)
      actions.appendChild(deleteBtn)
      item.appendChild(meta)
      item.appendChild(content)
      item.appendChild(actions)
      els.historyList.appendChild(item)
    })
  }

  async function openHistory(refreshOnly = false) {
    if (!refreshOnly) els.historyModal.hidden = false
    try {
      const response = await api('/api/shared-text/history')
      if (!response.ok) throw new Error('读取历史失败')
      const data = await response.json()
      renderHistory(data.history || [])
    } catch (error) {
      els.historyList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`
    }
  }

  function closeHistory() {
    els.historyModal.hidden = true
  }

  async function clearHistory() {
    const ok = window.confirm('确定删除全部历史记录？此操作不可恢复。')
    if (!ok) return
    try {
      const response = await api('/api/shared-text/history', { method: 'DELETE' })
      if (!response.ok) throw new Error('删除失败')
      toast('历史记录已全部删除')
      openHistory(true)
    } catch (error) {
      toast(error.message)
    }
  }

  // ---------------- 播放浮层 ----------------
  function openPlayer(file) {
    els.playerTitle.textContent = displayName(file.name)
    els.playerSubtitle.textContent = `${categoryLabelOf(file)} · ${formatBytes(file.size)}`
    els.playerStage.innerHTML = ''

    if (file.mediaType === 'video') {
      const video = document.createElement('video')
      video.controls = true
      video.autoplay = true
      video.preload = 'metadata'
      video.src = `${file.streamUrl}#t=0.1`
      video.addEventListener('error', () => {
        els.playerStage.innerHTML = '<div class="player-msg">该视频编码浏览器无法直接播放，请使用下载后本地播放。</div>'
      })
      els.playerStage.appendChild(video)
    } else if (file.mediaType === 'audio') {
      const audio = document.createElement('audio')
      audio.controls = true
      audio.autoplay = true
      audio.src = file.streamUrl
      els.playerStage.appendChild(audio)
    } else if (file.mediaType === 'image') {
      const image = document.createElement('img')
      image.src = file.streamUrl
      image.alt = displayName(file.name)
      image.style.maxWidth = '100%'
      image.style.maxHeight = '68vh'
      els.playerStage.appendChild(image)
    }

    els.playerModal.hidden = false
  }

  function closePlayer() {
    els.playerModal.hidden = true
    els.playerStage.innerHTML = ''
  }

  // ---------------- 事件绑定 ----------------
  document.querySelectorAll('.entry-card').forEach(card => {
    card.addEventListener('pointermove', event => {
      const rect = card.getBoundingClientRect()
      card.style.setProperty('--mx', `${((event.clientX - rect.left) / rect.width) * 100}%`)
      card.style.setProperty('--my', `${((event.clientY - rect.top) / rect.height) * 100}%`)
    })
    card.addEventListener('click', () => {
      const target = card.dataset.view
      if (location.hash === `#/${target}`) applyRoute()
      else location.hash = `#/${target}`
    })
  })

  document.querySelectorAll('[data-back]').forEach(button => {
    button.addEventListener('click', () => {
      if (location.hash === '#/home') applyRoute()
      else location.hash = '#/home'
    })
  })

  els.authSubmitBtn.addEventListener('click', submitPassword)
  els.authCancelBtn.addEventListener('click', () => {
    closeAuth()
    if (PROTECTED_VIEWS.has(routeName())) {
      location.hash = '#/home'
    }
    applyRoute()
  })
  els.passwordInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') submitPassword()
  })
  els.authBtn.addEventListener('click', () => {
    if (state.authed) logout()
    else openAuth(state.currentView)
  })

  els.search.addEventListener('input', () => {
    state.keyword = els.search.value
    renderFiles()
  })

  els.sortSelect.addEventListener('change', () => {
    state.sort = els.sortSelect.value
    // 名称默认升序更符合阅读习惯，其余维度默认降序
    state.order = state.sort === 'name' ? 'asc' : 'desc'
    updateSortOrderButton()
    renderFiles()
  })

  function updateSortOrderButton() {
    const asc = state.order === 'asc'
    els.sortOrderBtn.dataset.order = state.order
    els.sortOrderBtn.textContent = asc ? '↑ 升序' : '↓ 降序'
  }

  els.sortOrderBtn.addEventListener('click', () => {
    state.order = state.order === 'asc' ? 'desc' : 'asc'
    updateSortOrderButton()
    renderFiles()
  })

  els.refreshBtn.addEventListener('click', () => loadFiles())

  els.selectBtn.addEventListener('click', () => els.fileInput.click())
  els.fileInput.addEventListener('change', event => {
    handleFiles(event.target.files)
    event.target.value = ''
  })

  ;['dragenter', 'dragover'].forEach(type => {
    els.dropZone.addEventListener(type, event => {
      event.preventDefault()
      els.dropZone.classList.add('dragging')
    })
  })
  ;['dragleave', 'dragend'].forEach(type => {
    els.dropZone.addEventListener(type, () => els.dropZone.classList.remove('dragging'))
  })
  els.dropZone.addEventListener('drop', event => {
    event.preventDefault()
    els.dropZone.classList.remove('dragging')
    handleFiles(event.dataTransfer?.files)
  })

  els.sharedText.addEventListener('input', () => {
    sharedTextState.dirty = true
    setSharedTextStatus('未保存的修改')
  })

  els.saveTextBtn.addEventListener('click', saveSharedText)
  els.copyTextBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(els.sharedText.value)
    toast(ok ? '已复制' : '复制失败')
  })
  els.pasteTextBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText()
      els.sharedText.value = text
      sharedTextState.dirty = true
      setSharedTextStatus('已粘贴，记得保存')
    } catch {
      toast('浏览器未授权读取剪贴板，请手动粘贴')
    }
  })
  els.refreshTextBtn.addEventListener('click', () => loadSharedText(true))
  els.historyTextBtn.addEventListener('click', () => openHistory())
  els.clearTextBtn.addEventListener('click', clearSharedText)
  els.closeHistoryBtn.addEventListener('click', closeHistory)
  els.clearHistoryBtn.addEventListener('click', clearHistory)
  els.closePlayerBtn.addEventListener('click', closePlayer)

  els.historyModal.addEventListener('click', event => {
    if (event.target === els.historyModal) closeHistory()
  })
  els.playerModal.addEventListener('click', event => {
    if (event.target === els.playerModal) closePlayer()
  })

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    if (!els.playerModal.hidden) return closePlayer()
    if (!els.historyModal.hidden) return closeHistory()
    if (!els.authModal.hidden) {
      closeAuth()
      if (PROTECTED_VIEWS.has(routeName())) location.hash = '#/home'
      applyRoute()
    }
  })

  window.addEventListener('hashchange', applyRoute)

  // 仅在对应功能页且已解锁时轮询，避免无效请求
  setInterval(() => {
    if (state.authed && state.currentView === 'files') loadFiles(true)
  }, 15000)

  setInterval(() => {
    if (state.authed && state.currentView === 'text') loadSharedText(false)
  }, 3000)

  async function init() {
    updateSortOrderButton()
    // 先同步按当前 hash 渲染目标视图（无动画），避免刷新时先闪一下首页再跳到目标页
    applyRoute({ instant: true })
    document.documentElement.classList.remove('route-booting')
    await checkAuth()
    await loadInfo()
    applyRoute({ instant: true })
  }

  init()
})()
