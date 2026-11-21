(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const viewMap = {
    home: $("view-home"),
    files: $("view-files"),
    upload: $("view-upload"),
    text: $("view-text"),
    more: $("view-more"),
    info: $("view-info"),
    qrcode: $("view-qrcode"),
  };
  const PROTECTED_VIEWS = new Set(["files", "upload", "text", "more"]);
  const CATEGORY_LABELS = {
    all: "全部",
    folder: "文件夹",
    video: "视频",
    audio: "音频",
    image: "图片",
    installer: "安装包",
    doc: "文档",
    other: "其他",
  };
  const INSTALLER_EXTS = [
    "exe",
    "msi",
    "apk",
    "dmg",
    "pkg",
    "deb",
    "rpm",
    "appx",
    "msix",
  ];
  const DOC_EXTS = [
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "txt",
    "md",
    "csv",
    "json",
    "log",
    "ini",
    "conf",
    "html",
    "css",
    "js",
    "ts",
    "py",
    "java",
    "sql",
  ];
  const ARCHIVE_EXTS = ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"];
  const TEXT_PREVIEW_EXTS = new Set([
    "txt", "md", "csv", "json", "log", "ini", "conf",
    "html", "css", "js", "mjs", "ts", "tsx", "jsx",
    "py", "java", "c", "cpp", "h", "go", "rs", "sql", "sh", "bat",
  ]);

  const LANGUAGE_INFO = {
    js: { key: "javascript", label: "JavaScript" },
    mjs: { key: "javascript", label: "JavaScript" },
    jsx: { key: "javascript", label: "JSX" },
    ts: { key: "javascript", label: "TypeScript" },
    tsx: { key: "javascript", label: "TSX" },
    json: { key: "json", label: "JSON" },
    html: { key: "html", label: "HTML" },
    css: { key: "css", label: "CSS" },
    py: { key: "python", label: "Python" },
    java: { key: "clike", label: "Java" },
    c: { key: "clike", label: "C" },
    cpp: { key: "clike", label: "C++" },
    h: { key: "clike", label: "C/C++" },
    go: { key: "clike", label: "Go" },
    rs: { key: "clike", label: "Rust" },
    sql: { key: "sql", label: "SQL" },
    md: { key: "markdown", label: "Markdown" },
    sh: { key: "shell", label: "Shell" },
    bat: { key: "shell", label: "Batch" },
    txt: { key: "plain", label: "纯文本" },
    log: { key: "plain", label: "日志" },
    csv: { key: "plain", label: "CSV" },
    ini: { key: "plain", label: "INI" },
    conf: { key: "plain", label: "配置" },
  };

  const HIGHLIGHT_RULES = {
    javascript: [
      ["tok-comment", /\/\/[^\n]*|\/\*[\s\S]*?\*\//g],
      ["tok-string", /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g],
      ["tok-number", /\b\d+(?:\.\d+)?\b/g],
      ["tok-keyword", /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|new|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false|this|super|yield)\b/g],
      ["tok-fn", /\b[A-Za-z_$][\w$]*(?=\s*\()/g],
    ],
    json: [
      ["tok-string", /"(?:\\.|[^"\\])*"/g],
      ["tok-number", /\b-?\d+(?:\.\d+)?\b/g],
      ["tok-keyword", /\b(?:true|false|null)\b/g],
    ],
    html: [
      ["tok-comment", /<!--[\s\S]*?-->/g],
      ["tok-tag", /<\/?[A-Za-z][^>]*>/g],
    ],
    css: [
      ["tok-comment", /\/\*[\s\S]*?\*\//g],
      ["tok-string", /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g],
      ["tok-number", /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms)?\b/g],
      ["tok-prop", /\b[a-z-]+(?=\s*:)/g],
    ],
    python: [
      ["tok-comment", /#[^\n]*/g],
      ["tok-string", /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g],
      ["tok-number", /\b\d+(?:\.\d+)?\b/g],
      ["tok-keyword", /\b(?:def|class|return|if|elif|else|for|while|break|continue|import|from|as|with|try|except|finally|raise|lambda|None|True|False|and|or|not|in|is|pass|yield|global|nonlocal|async|await)\b/g],
    ],
    clike: [
      ["tok-comment", /\/\/[^\n]*|\/\*[\s\S]*?\*\//g],
      ["tok-string", /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g],
      ["tok-number", /\b\d+(?:\.\d+)?\b/g],
      ["tok-keyword", /\b(?:public|private|protected|static|final|class|interface|extends|implements|new|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|throws|import|package|void|int|long|float|double|boolean|char|byte|short|const|let|var|function|struct|enum|namespace|using|typename|auto|true|false|null|None|fn|match|impl|pub|mut|defer|go|func|package)\b/g],
      ["tok-fn", /\b[A-Za-z_][\w]*(?=\s*\()/g],
    ],
    sql: [
      ["tok-comment", /--[^\n]*|\/\*[\s\S]*?\*\//g],
      ["tok-string", /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g],
      ["tok-number", /\b\d+(?:\.\d+)?\b/g],
      ["tok-keyword", /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|AS|AND|OR|NOT|NULL|IS|IN|LIKE|BETWEEN|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|INDEX|VIEW|BEGIN|COMMIT|ROLLBACK)\b/gi],
    ],
    markdown: [
      ["tok-heading", /^#{1,6}\s.*$/g],
      ["tok-string", /`[^`\n]*`/g],
      ["tok-keyword", /\*\*[^*]+\*\*|__[^_]+__/g],
      ["tok-fn", /^>\s.*$/g],
    ],
    shell: [
      ["tok-comment", /#[^\n]*/g],
      ["tok-string", /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g],
      ["tok-number", /\b\d+\b/g],
      ["tok-keyword", /\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|export|local|set|echo|cd|ls|cat|grep|sed|awk|npm|node|git)\b/g],
      ["tok-fn", /\$[A-Za-z_][\w]*|\$\{[^}]+\}/g],
    ],
  };

  const els = {
    urls: $("urls"),
    urlsInfo: $("urlsInfo"),
    authBtn: $("authBtn"),
    fileFilters: $("fileFilters"),
    fileBreadcrumb: $("fileBreadcrumb"),
    fileSummary: $("fileSummary"),
    fileList: $("fileList"),
    search: $("search"),
    sortSelect: $("sortSelect"),
    sortOrderBtn: $("sortOrderBtn"),
    refreshBtn: $("refreshBtn"),
    dropZone: $("dropZone"),
    fileInput: $("fileInput"),
    selectBtn: $("selectBtn"),
    uploadQueue: $("uploadQueue"),
    maxSize: $("maxSize"),
    sharedText: $("sharedText"),
    sharedTextStatus: $("sharedTextStatus"),
    saveTextBtn: $("saveTextBtn"),
    copyTextBtn: $("copyTextBtn"),
    pasteTextBtn: $("pasteTextBtn"),
    refreshTextBtn: $("refreshTextBtn"),
    historyTextBtn: $("historyTextBtn"),
    clearTextBtn: $("clearTextBtn"),
    historyModal: $("historyModal"),
    historyList: $("historyList"),
    closeHistoryBtn: $("closeHistoryBtn"),
    clearHistoryBtn: $("clearHistoryBtn"),
    playerModal: $("playerModal"),
    playerHeader: $("playerHeader"),
    playerTitle: $("playerTitle"),
    playerSubtitle: $("playerSubtitle"),
    printPlayerBtn: $("printPlayerBtn"),
    playerStage: $("playerStage"),
    closePlayerBtn: $("closePlayerBtn"),
    authModal: $("authModal"),
    passwordInput: $("passwordInput"),
    authSubmitBtn: $("authSubmitBtn"),
    authCancelBtn: $("authCancelBtn"),
    authError: $("authError"),
    infoMaxSize: $("infoMaxSize"),
    infoPort: $("infoPort"),
    infoAuth: $("infoAuth"),
    toast: $("toast"),
  };

  const ICON_PATHS = {
    share: '<circle cx="18" cy="5" r="2.4"/><circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="19" r="2.4"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
    download: '<path d="M12 4v11m0 0l-4-4m4 4 4-4M5 19h14"/>',
    copy: '<rect x="9" y="9" width="10" height="10" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
    trash: '<path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    sort: '<path d="M7 20V4m0 0L4 7m3-3 3 3M17 4v16m0 0-3-3m3 3 3-3"/>',
    save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
    paste: '<rect x="6" y="5" width="12" height="15" rx="2"/><path d="M9 5V3h6v2"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4M12 8v5l3 2"/>',
    enter: '<path d="M5 12h13m0 0-5-5m5 5-5 5"/>',
    upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5M4 17v2h16v-2"/>',
    folder: '<path d="M4 6h5l2 2h9v10H4z"/>',
    archive: '<rect x="3" y="5" width="18" height="4" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
    pause: '<path d="M9 6v12M15 6v12"/>',
    play: '<path d="M8 5l11 7-11 7z"/>',
    eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/>',
    bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
    restore: '<path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4"/><path d="M12 8v5l3 2"/>',
    up: '<path d="M12 19V5m0 0-6 6m6-6 6 6"/>',
    home: '<path d="M4 11l8-7 8 7v9H4z"/><path d="M9 20v-6h6v6"/>',
    print: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/>',
  };

  function iconSvg(key) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[key] || ""}</svg>`;
  }

  function iconAction(className, key, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn icon-btn ${className}`;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = iconSvg(key);
    return button;
  }

  function iconLink(className, key, label, href) {
    const link = document.createElement("a");
    link.className = `btn icon-btn ${className}`;
    link.href = href;
    link.title = label;
    link.setAttribute("aria-label", label);
    link.innerHTML = iconSvg(key);
    return link;
  }

  window.__appIconSvg = iconSvg;

  const state = {
    files: [],
    filesSignature: "",
    category: "all",
    currentDir: "",
    sort: "time",
    order: "desc",
    keyword: "",
    info: {},
    local: true,
    authed: false,
    authChecked: false,
    pendingView: null,
    currentView: "home",
  };

  const sharedTextState = {
    dirty: false,
    lastLoaded: "",
    loading: false,
    saving: false,
    requestId: 0,
  };

  // ---------------- 通用工具 ----------------
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "--";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
  }

  function formatTime(ms) {
    const date = new Date(ms);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function displayName(name) {
    return String(name).replace(
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[\w-]+?-[\w]{8}-/,
      "",
    );
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function languageOfExt(ext) {
    const key = String(ext || "").toLowerCase();
    return LANGUAGE_INFO[key] || { key: "plain", label: "纯文本" };
  }

  const TEXT_NAME_HINTS = [
    [/\.gitignore$|\.ignore$|\.npmignore$/i, { key: "plain", label: "忽略规则" }],
    [/\.env(?:[.\w-]*)?$/i, { key: "plain", label: "环境变量" }],
    [/^(?:dockerfile|makefile|readme|license|changelog)(?:\.|$)/i, { key: "plain", label: "文本文件" }],
    [/\.css/i, { key: "css", label: "CSS" }],
    [/\.js/i, { key: "javascript", label: "JavaScript" }],
    [/\.ts/i, { key: "javascript", label: "TypeScript" }],
    [/\.json/i, { key: "json", label: "JSON" }],
    [/\.html?/i, { key: "html", label: "HTML" }],
    [/\.py/i, { key: "python", label: "Python" }],
    [/\.sql/i, { key: "sql", label: "SQL" }],
    [/\.md/i, { key: "markdown", label: "Markdown" }],
    [/\.(?:sh|bat|cmd)/i, { key: "shell", label: "Shell" }],
    [/\.(?:ini|conf|cfg|log|csv|txt)/i, { key: "plain", label: "纯文本" }],
  ];

  function textLanguageFromName(name) {
    const base = baseNameOf(name);
    const ext = String(base.match(/\.([^.\s]+)$/)?.[1] || "").toLowerCase();
    if (LANGUAGE_INFO[ext]) return LANGUAGE_INFO[ext];
    for (const [pattern, info] of TEXT_NAME_HINTS) {
      if (pattern.test(base)) return info;
    }
    return null;
  }

  function highlightLine(line, langKey) {
    const rules = HIGHLIGHT_RULES[langKey];
    if (!rules || !rules.length) return escapeHtml(line);
    const source = rules.map(([, pattern]) => `(${pattern.source})`).join("|");
    const flags = rules.some(([, pattern]) => pattern.flags.includes("i")) ? "gi" : "g";
    const matcher = new RegExp(source, flags);
    let html = "";
    let last = 0;
    let match;
    while ((match = matcher.exec(line)) !== null) {
      if (match[0] === "") {
        matcher.lastIndex += 1;
        continue;
      }
      html += escapeHtml(line.slice(last, match.index));
      let className = "";
      for (let i = 0; i < rules.length; i += 1) {
        if (match[i + 1] !== undefined) {
          className = rules[i][0];
          break;
        }
      }
      html += `<span class="${className}">${escapeHtml(match[0])}</span>`;
      last = match.index + match[0].length;
    }
    html += escapeHtml(line.slice(last));
    return html;
  }

  function buildCodeView(text, langKey) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    const shell = document.createElement("div");
    shell.className = "code-shell";
    const view = document.createElement("div");
    view.className = "code-view";
    const gutter = document.createElement("div");
    gutter.className = "code-gutter";
    const content = document.createElement("pre");
    content.className = "code-content";
    lines.forEach((line, index) => {
      const number = document.createElement("span");
      number.textContent = String(index + 1);
      gutter.appendChild(number);
    });
    content.innerHTML = lines.map((line) => highlightLine(line, langKey)).join("\n");
    view.appendChild(gutter);
    view.appendChild(content);
    shell.appendChild(view);
    return shell;
  }

  function baseNameOf(name) {
    const value = String(name || "");
    const index = value.lastIndexOf("/");
    return index >= 0 ? value.slice(index + 1) : value;
  }

  function displayBaseName(name) {
    return displayName(baseNameOf(name));
  }

  function dirPrefix(dir) {
    return dir ? `${dir}/` : "";
  }

  // 把接口的扁平文件列表拆成“当前目录下的子文件夹 + 文件”
  function buildDirectoryEntries() {
    const prefix = dirPrefix(state.currentDir);
    const folderMap = new Map();
    const files = [];

    state.files.forEach((file) => {
      const name = String((file && file.name) || "");
      if (!name) return;
      const relative = prefix
        ? name.startsWith(prefix)
          ? name.slice(prefix.length)
          : ""
        : name;
      if (!relative) return;

      const slash = relative.indexOf("/");
      if (slash >= 0) {
        const base = relative.slice(0, slash);
        if (!base) return;
        let folder = folderMap.get(base);
        if (!folder) {
          const folderPath = `${prefix}${base}`;
          const encoded = folderPath
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/");
          folder = {
            kind: "folder",
            name: folderPath,
            base,
            path: folderPath,
            displayName: base,
            ext: "",
            mediaType: "folder",
            mime: null,
            url: `/files/${encoded}?zip=1`,
            streamUrl: null,
            count: 0,
            size: 0,
            updatedAt: 0,
          };
          folderMap.set(base, folder);
        }
        folder.count += 1;
        folder.size += Number(file.size) || 0;
        folder.updatedAt = Math.max(folder.updatedAt, Number(file.updatedAt) || 0);
        return;
      }

      files.push({ ...file, kind: "file", base: relative });
    });

    return { folders: [...folderMap.values()], files };
  }

  function selectableEntryNames() {
    const names = new Set();
    state.files.forEach((file) => {
      const name = String((file && file.name) || "");
      if (!name) return;
      names.add(name);
      const parts = name.split("/");
      for (let i = 1; i < parts.length; i += 1) {
        names.add(parts.slice(0, i).join("/"));
      }
    });
    return [...names];
  }

  let toastTimer = null;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(helper);
      return ok;
    }
  }

  function categoryOf(file) {
    if (file && (file.kind === "folder" || file.mediaType === "folder")) return "folder";
    const ext = String(file.ext || "").toLowerCase();
    if (file.mediaType === "video") return "video";
    if (file.mediaType === "audio") return "audio";
    if (file.mediaType === "image") return "image";
    if (INSTALLER_EXTS.includes(ext)) return "installer";
    if (DOC_EXTS.includes(ext)) return "doc";
    if (ARCHIVE_EXTS.includes(ext)) return "other";
    return "other";
  }

  function categoryLabelOf(file) {
    const key = categoryOf(file);
    if (
      key === "other" &&
      ARCHIVE_EXTS.includes(String(file.ext || "").toLowerCase())
    )
      return "压缩包";
    return CATEGORY_LABELS[key] || "其他";
  }

  function isMedia(file) {
    return Boolean(file.streamUrl);
  }

  function isPreviewable(file) {
    if (isMedia(file)) return true;
    const ext = String((file && file.ext) || "").toLowerCase();
    return ext === "pdf" || TEXT_PREVIEW_EXTS.has(ext) || Boolean(textLanguageFromName(file && file.name));
  }

  // ---------------- 接口封装 ----------------
  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
    });
    if (response.status === 401) {
      setAuth(false);
      openAuth(state.currentView);
      throw new Error("请先验证访问密码");
    }
    return response;
  }

  // V3 工具箱等模块通过事件上报 401，统一回到这里处理登录态
  document.addEventListener("app:unauthorized", () => {
    if (!state.authed) return;
    setAuth(false);
    openAuth(state.currentView);
  });

  // ---------------- 门禁 ----------------
  function setAuth(authed) {
    state.authed = authed;
    state.authChecked = true;
    els.authBtn.hidden = !authed;
    document.querySelectorAll("[data-lock]").forEach((el) => {
      el.textContent = authed ? "已解锁" : "需要密码";
      el.classList.toggle("unlocked", authed);
    });
    if (els.infoAuth) els.infoAuth.textContent = authed ? "已验证" : "未验证";
    // 广播鉴权结果，供 V3 工具箱等模块在登录态确定后再加载数据（避免首屏 401 卡在“加载中”）
    try {
      document.dispatchEvent(
        new CustomEvent("app:auth", { detail: { authed } }),
      );
    } catch {
      // 忽略事件派发异常
    }
  }

  async function checkAuth() {
    try {
      const response = await fetch("/api/auth/status", {
        credentials: "same-origin",
      });
      const data = await response.json();
      setAuth(Boolean(data.authed));
    } catch {
      setAuth(false);
    }
  }

  function openAuth(pending) {
    state.pendingView = PROTECTED_VIEWS.has(pending)
      ? pending
      : state.pendingView;
    els.authError.hidden = true;
    els.authModal.hidden = false;
    setTimeout(() => els.passwordInput.focus(), 80);
  }

  function closeAuth() {
    els.authModal.hidden = true;
    els.passwordInput.value = "";
    els.authError.hidden = true;
    els.authSubmitBtn.disabled = false;
    els.authSubmitBtn.innerHTML = iconSvg("enter");
    els.authSubmitBtn.title = "验证并进入";
  }

  function showAuthError(message) {
    els.authError.textContent = message;
    els.authError.hidden = false;
    els.authModal.querySelector(".modal-card").classList.remove("shake");
    void els.authModal.offsetWidth;
    els.authModal.querySelector(".modal-card").classList.add("shake");
  }

  async function submitPassword() {
    if (els.authSubmitBtn.disabled) return;
    const password = els.passwordInput.value;
    if (!password) {
      showAuthError("请输入访问密码");
      return;
    }
    els.authSubmitBtn.disabled = true;
    els.authSubmitBtn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>';
    els.authSubmitBtn.title = "验证中";
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || "验证失败，请重试");
      setAuth(true);
      closeAuth();
      toast("验证通过，已解锁功能页");
      applyRoute();
    } catch (error) {
      showAuthError(error.message);
      // 验证失败自动清空输入框，需重新输入
      els.passwordInput.value = "";
      els.passwordInput.focus();
      els.authSubmitBtn.disabled = false;
      els.authSubmitBtn.innerHTML = iconSvg("enter");
      els.authSubmitBtn.title = "验证并进入";
    }
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      // 忽略网络异常，前端状态照常清除
    }
    setAuth(false);
    state.files = [];
    state.filesSignature = "";
    state.currentDir = "";
    state.category = "all";
    state.keyword = "";
    if (els.search) els.search.value = "";
    els.fileList.innerHTML = "";
    els.fileFilters.innerHTML = "";
    if (els.fileBreadcrumb) els.fileBreadcrumb.innerHTML = "";
    if (location.hash !== "#/home") {
      location.hash = "#/home";
    }
    applyRoute();
    toast("已退出验证，功能页已锁定");
  }

  // ---------------- 视图切换 ----------------
  function routeName() {
    const raw = String(location.hash || "").replace(/^#\/?/, "");
    return viewMap[raw] ? raw : "home";
  }

  // instant=true 用于首屏渲染：不做离场/入场动画，直接按目标视图切换
  function showView(name, instant) {
    const next = viewMap[name];
    if (!next) return;
    if (instant) {
      Object.entries(viewMap).forEach(([key, view]) => {
        if (!view) return;
        view.classList.remove("view-enter", "view-leave");
        view.hidden = key !== name;
      });
      state.currentView = name;
      return;
    }
    const current = Object.values(viewMap).find((view) => view && !view.hidden);
    if (current === next) {
      state.currentView = name;
      return;
    }
    // 先隐藏旧视图再显示新视图，避免两个视图短暂叠加造成高度跳动
    if (current) {
      current.hidden = true;
      current.classList.remove("view-enter", "view-leave");
    }
    next.hidden = false;
    next.classList.remove("view-enter");
    void next.offsetWidth;
    next.classList.add("view-enter");
    state.currentView = name;
    window.scrollTo(0, 0);
  }

  function applyRoute(options) {
    const name = routeName();
    const instant = Boolean(options && options.instant);
    if (PROTECTED_VIEWS.has(name) && !state.authed) {
      state.pendingView = name;
      // 首屏鉴权结果未回来前，直接按 hash 渲染目标页骨架，避免先渲染首页再跳转造成闪烁
      if (!state.authChecked) {
        showView(name, instant);
        return;
      }
      showView("home");
      openAuth(name);
      return;
    }
    showView(name, instant);
    if (name === "files") loadFiles(false, false);
    else if (name === "text") loadSharedText(true);
    else if (name === "info") loadInfo();
    else if (name === "upload") loadInfo();
    else if (name === "qrcode") document.dispatchEvent(new CustomEvent("app:qrcode-view"));
  }

  // 本机高权限 UI：非本机访问隐藏工具箱、共享文本清空与文件删除入口
  function applyPermissionUI() {
    const local = state.local;
    document.querySelectorAll('.entry-card[data-view="more"]').forEach((card) => {
      card.hidden = !local;
    });
    if (els.clearTextBtn) els.clearTextBtn.hidden = !local;
    if (els.clearHistoryBtn) els.clearHistoryBtn.hidden = !local;
    document.querySelectorAll('#historyList .history-actions .btn[data-action="delete"]').forEach((btn) => {
      btn.hidden = !local;
    });
    document.querySelectorAll('#fileList .action-btn[data-action="delete"]').forEach((btn) => {
      btn.hidden = !local;
    });
  }

  // ---------------- 服务信息 ----------------
  async function loadInfo() {
    try {
      const response = await fetch("/api/info", { credentials: "same-origin" });
      const data = await response.json();
      state.info = data;
      state.local = data.local !== false;
      applyPermissionUI();
      els.maxSize.textContent = `单文件上限 ${formatBytes(data.maxFileSize)}`;
      els.infoMaxSize.textContent = formatBytes(data.maxFileSize);
      els.infoPort.textContent = String(data.port);
      renderUrls(data.urls || [], data.local !== false);
    } catch {
      els.maxSize.textContent = "";
    }
  }

  function renderUrls(urls, local) {
    const showFull = local !== false;
    const list = Array.isArray(urls) ? urls : [];
    const build = () =>
      list.map((url) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = showFull ? "url-chip" : "url-chip masked";
        chip.textContent = url;
        chip.addEventListener("click", async () => {
          if (!showFull) {
            toast("非本机访问，完整地址已隐藏");
            return;
          }
          const ok = await copyToClipboard(url);
          toast(ok ? "地址已复制" : "复制失败，请手动选择");
        });
        return chip;
      });
    [els.urls, els.urlsInfo].forEach((container) => {
      if (!container) return;
      container.innerHTML = "";
      if (!list.length) {
        container.textContent = "--";
        return;
      }
      build().forEach((chip) => container.appendChild(chip));
      if (!showFull) {
        const note = document.createElement("span");
        note.className = "url-note";
        note.textContent = "仅本机访问显示完整地址";
        container.appendChild(note);
      }
    });
  }

  // ---------------- 文件列表：筛选 / 排序 ----------------
  function keywordMatchedEntries() {
    const { folders, files } = buildDirectoryEntries();
    const keyword = state.keyword.trim().toLowerCase();
    if (!keyword) return [...folders, ...files];
    return [...folders, ...files].filter((entry) =>
      (entry.kind === "folder" ? entry.base : displayBaseName(entry.name))
        .toLowerCase()
        .includes(keyword),
    );
  }

  function filteredEntries() {
    return keywordMatchedEntries().filter(
      (entry) => state.category === "all" || categoryOf(entry) === state.category,
    );
  }

  function sortedEntries(list) {
    const direction = state.order === "asc" ? 1 : -1;
    const entryName = (entry) =>
      entry.kind === "folder" ? entry.base : displayBaseName(entry.name);
    const byName = (a, b) =>
      entryName(a).localeCompare(entryName(b), "zh-CN", { numeric: true });
    const comparators = {
      time: (a, b) => (a.updatedAt || 0) - (b.updatedAt || 0),
      size: (a, b) => (a.size || 0) - (b.size || 0),
      name: byName,
      type: (a, b) => {
        const diff = categoryLabelOf(a).localeCompare(
          categoryLabelOf(b),
          "zh-CN",
        );
        return diff !== 0 ? diff : byName(a, b);
      },
    };
    const comparator = comparators[state.sort] || comparators.time;
    return [...list].sort((a, b) => comparator(a, b) * direction);
  }

  function renderBreadcrumb() {
    if (!els.fileBreadcrumb) return;
    els.fileBreadcrumb.innerHTML = "";
    // 只有进入文件夹后才需要路径导航，根目录保持干净
    els.fileBreadcrumb.hidden = !state.currentDir;
    if (!state.currentDir) return;

    const up = document.createElement("button");
    up.type = "button";
    up.className = "crumb crumb-icon";
    up.innerHTML = iconSvg("up");
    up.title = "上一级";
    up.setAttribute("aria-label", "上一级");
    up.disabled = !state.currentDir;
    up.addEventListener("click", () => {
      if (!state.currentDir) return;
      const parts = state.currentDir.split("/");
      parts.pop();
      navigateToDir(parts.join("/"));
    });
    els.fileBreadcrumb.appendChild(up);

    const root = document.createElement("button");
    root.type = "button";
    root.className = "crumb crumb-icon";
    root.innerHTML = iconSvg("home");
    root.title = "全部文件";
    root.setAttribute("aria-label", "全部文件");
    root.addEventListener("click", () => navigateToDir(""));
    els.fileBreadcrumb.appendChild(root);

    const parts = state.currentDir ? state.currentDir.split("/") : [];
    let path = "";
    parts.forEach((part) => {
      const separator = document.createElement("span");
      separator.className = "crumb-sep";
      separator.textContent = "/";
      els.fileBreadcrumb.appendChild(separator);

      path = path ? `${path}/${part}` : part;
      const target = path;
      const crumb = document.createElement("button");
      crumb.type = "button";
      crumb.className = "crumb";
      crumb.textContent = part;
      crumb.addEventListener("click", () => navigateToDir(target));
      els.fileBreadcrumb.appendChild(crumb);
    });
  }

  function navigateToDir(path) {
    const next = String(path || "");
    if (next === state.currentDir) return;
    state.currentDir = next;
    // 埋点：记录文件夹查看次数
    fetch("/api/v3/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action: "dir-view", path: next })
    }).catch(() => {});
    // 进入文件夹后清空搜索与分类，确保内部内容都能显示和预览
    state.keyword = "";
    state.category = "all";
    if (els.search) els.search.value = "";
    renderFilters();
    renderFiles();
  }

  function renderFilters() {
    const entries = keywordMatchedEntries();
    const counts = { all: entries.length };
    entries.forEach((entry) => {
      const key = categoryOf(entry);
      counts[key] = (counts[key] || 0) + 1;
    });
    const order = [
      "all",
      "folder",
      "video",
      "audio",
      "image",
      "installer",
      "doc",
      "other",
    ];
    els.fileFilters.innerHTML = "";
    order.forEach((key) => {
      const count = counts[key] || 0;
      if (key !== "all" && count === 0) return;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `filter-chip${state.category === key ? " active" : ""}`;
      chip.innerHTML = `${escapeHtml(CATEGORY_LABELS[key])}<span class="filter-count">${count}</span>`;
      chip.addEventListener("click", () => {
        state.category = key;
        renderFilters();
        renderFiles({ animate: false });
      });
      els.fileFilters.appendChild(chip);
    });
  }

  function renderFiles(options) {
    const animate = !options || options.animate !== false;
    renderBreadcrumb();
    els.fileList.dataset.inFolder = state.currentDir ? "1" : "0";
    const { folders, files } = buildDirectoryEntries();
    const entries = sortedEntries(filteredEntries());
    const totalSize = entries.reduce(
      (sum, entry) => sum + (Number(entry.size) || 0),
      0,
    );
    const locationText = state.currentDir
      ? `当前目录：${state.currentDir}`
      : "根目录";
    els.fileSummary.textContent = `${locationText} · 文件夹 ${folders.length} 个，文件 ${files.length} 个，当前显示 ${entries.length} 项，合计 ${formatBytes(totalSize)}`;

    if (!entries.length) {
      els.fileList.innerHTML = '<div class="empty">暂无符合条件的文件或文件夹</div>';
      if (typeof window.__v3PruneSelection === "function") {
        window.__v3PruneSelection(selectableEntryNames());
      }
      return;
    }

    els.fileList.innerHTML = "";
    els.fileList.classList.toggle("no-anim", !animate);
    entries.forEach((entry, index) => {
      const isFolder = entry.kind === "folder";
      // 文件夹内的所有内容（文件和子文件夹）都只读，不再生成任何操作按钮
      const readOnly = Boolean(state.currentDir);
      const item = document.createElement("div");
      item.className = `file-item${isFolder ? " folder-item" : ""}${readOnly ? " is-readonly" : ""}`;
      item.style.setProperty("--delay", `${Math.min(index * 35, 280)}ms`);

      if (isFolder) {
        item.dataset.path = entry.path;
        if (readOnly) {
          const spacer = document.createElement("span");
          spacer.className = "v3-pick-wrap pick-spacer";
          spacer.setAttribute("aria-hidden", "true");
          item.appendChild(spacer);
        }
        const thumb = document.createElement("div");
        thumb.className = "file-thumb";
        thumb.dataset.done = "1";
        thumb.dataset.media = "file";
        thumb.textContent = "FILE";
        item.appendChild(thumb);
        if (!readOnly && typeof window.__v3AddItemExtras === "function") {
          window.__v3AddItemExtras(item, entry);
        }
      } else if (readOnly) {
        const spacer = document.createElement("span");
        spacer.className = "v3-pick-wrap pick-spacer";
        spacer.setAttribute("aria-hidden", "true");
        item.appendChild(spacer);
        const thumb = document.createElement("div");
        thumb.className = "file-thumb";
        thumb.dataset.done = "1";
        thumb.dataset.media = entry.mediaType || "file";
        thumb.dataset.stream = entry.streamUrl || "";
        thumb.dataset.thumb = entry.thumbUrl || "";
        if (entry.mediaType === "image" || entry.mediaType === "video") thumb.classList.add("is-loading");
        thumb.textContent =
          entry.mediaType === "video" ? "▶" :
          entry.mediaType === "audio" ? "♪" :
          entry.mediaType === "doc" ? "PDF" : "FILE";
        item.appendChild(thumb);
        if ((entry.mediaType === "image" || entry.mediaType === "video") && typeof window.__v3RenderThumb === "function") {
          window.__v3RenderThumb(thumb);
        }
      } else if (typeof window.__v3AddItemExtras === "function") {
        window.__v3AddItemExtras(item, entry);
      }

      const info = document.createElement("div");
      info.className = "file-info";
      const name = document.createElement("a");
      name.className = "file-name file-name-link";
      name.href = isFolder ? "#" : entry.streamUrl || entry.url;
      if (!isFolder && !isPreviewable(entry)) name.target = "_blank";
      name.textContent = isFolder ? entry.base : displayBaseName(entry.name);
      name.addEventListener("click", (event) => {
        if (isFolder) {
          event.preventDefault();
          event.stopPropagation();
          navigateToDir(entry.path);
        } else if (isPreviewable(entry)) {
          event.preventDefault();
          event.stopPropagation();
          openPlayer(entry);
        }
      });
      const meta = document.createElement("div");
      meta.className = "file-meta";
      const tagClass = isFolder ? "folder-tag" : "file-tag";
      const countText = isFolder ? `${entry.count} 个文件 · ` : "";
      meta.innerHTML = `<span class="${tagClass}">${escapeHtml(categoryLabelOf(entry))}</span>${countText}${escapeHtml(formatBytes(entry.size))} · ${escapeHtml(formatTime(entry.updatedAt))}`;
      info.appendChild(name);
      info.appendChild(meta);

      item.appendChild(info);

      if (readOnly) {
        const placeholder = document.createElement("span");
        placeholder.className = "actions-placeholder";
        placeholder.setAttribute("aria-hidden", "true");
        item.appendChild(placeholder);
      } else {
        const actions = document.createElement("div");
        actions.className = "file-actions";

        const downloadLink = iconLink(
          "ghost action-btn",
          "download",
          isFolder ? "下载文件夹" : "下载",
          entry.url,
        );
        downloadLink.setAttribute(
          "download",
          isFolder ? `${entry.base}.zip` : displayBaseName(entry.name),
        );
        actions.appendChild(downloadLink);

        const copyBtn = iconAction("ghost action-btn", "copy", "复制链接");
        copyBtn.addEventListener("click", async () => {
          const ok = await copyToClipboard(`${location.origin}${entry.url}`);
          toast(
            ok
              ? "链接已复制（对方设备需先通过密码验证）"
              : "复制失败，请手动复制",
          );
        });
        actions.appendChild(copyBtn);

        const deleteBtn = iconAction("danger action-btn", "trash", "删除");
        deleteBtn.dataset.action = "delete";
        deleteBtn.hidden = !state.local;
        deleteBtn.addEventListener("click", () => deleteFile(entry));
        actions.appendChild(deleteBtn);

        item.appendChild(actions);
      }

      if (isFolder) {
        item.tabIndex = 0;
        item.addEventListener("click", (event) => {
          const target = event.target && event.target.closest ? event.target : null;
          if (target && (target.closest(".file-actions") || target.closest(".v3-pick-wrap"))) return;
          navigateToDir(entry.path);
        });
        item.addEventListener("keydown", (event) => {
          const target = event.target && event.target.closest ? event.target : null;
          if (target && target !== item && (target.closest(".file-actions") || target.closest(".v3-pick-wrap"))) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            navigateToDir(entry.path);
          }
        });
      } else if (isPreviewable(entry)) {
        item.classList.add("is-media-row");
        const previewThumb = item.querySelector(".file-thumb");
        if (previewThumb) {
          previewThumb.tabIndex = 0;
          previewThumb.setAttribute("role", "button");
          previewThumb.setAttribute("aria-label", "预览文件");
          previewThumb.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openPlayer(entry);
            }
          });
        }
        item.addEventListener("click", (event) => {
          const thumb =
            event.target && event.target.closest
              ? event.target.closest(".file-thumb")
              : null;
          if (!thumb) return;
          event.preventDefault();
          openPlayer(entry);
        });
      }

      els.fileList.appendChild(item);
    });
    if (typeof window.__v3PruneSelection === "function") {
      window.__v3PruneSelection(selectableEntryNames());
    }
  }

  // 列表数据指纹：用于判断轮询返回的数据是否真的变化，避免无变动时反复重建行
  function filesSignature(files) {
    return (files || [])
      .map((file) =>
        [
          file.name,
          file.size || 0,
          file.updatedAt || "",
          file.url || "",
          file.streamUrl || "",
          file.mediaType || "",
          file.displayName || "",
        ].join("\u0001"),
      )
      .join("\u0002");
  }

  async function loadFiles(silent = false, animate = true) {
    if (!state.authed) return;
    try {
      const response = await api("/api/files");
      if (!response.ok) throw new Error("文件列表加载失败");
      const data = await response.json();
      const nextFiles = data.files || [];
      const nextSignature = filesSignature(nextFiles);
      const changed = nextSignature !== state.filesSignature;
      state.files = nextFiles;
      state.filesSignature = nextSignature;
      // 当前目录被删空后自动回到根目录，避免停留在无法访问的空路径
      if (state.currentDir) {
        const prefix = dirPrefix(state.currentDir);
        if (!nextFiles.some((file) => String(file.name || "").startsWith(prefix))) {
          state.currentDir = "";
        }
      }
      // 静默轮询且数据未变：不重建列表，保住现有 DOM 与缩略图
      if (silent && !changed) return;
      renderFilters();
      renderFiles({ animate });
    } catch (error) {
      if (!silent) toast(error.message);
    }
  }

  async function deleteFile(file) {
    const ok = window.confirm(
      `确定删除「${displayBaseName(file.name)}」？该文件会从服务端上传目录中移除。`,
    );
    if (!ok) return;
    try {
      const response = await api(
        `/api/files/${encodeURIComponent(file.name)}`,
        { method: "DELETE" },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || "删除失败");
      toast("已删除");
      loadFiles();
    } catch (error) {
      toast(error.message);
    }
  }

  // ---------------- 上传 ----------------
  function addUploadItem(file) {
    const item = document.createElement("div");
    item.className = "upload-item";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = file.name;
    const status = document.createElement("div");
    status.className = "status";
    status.textContent = "等待上传";
    const track = document.createElement("div");
    track.className = "progress-track";
    const bar = document.createElement("div");
    bar.className = "progress-bar";
    track.appendChild(bar);
    item.appendChild(name);
    item.appendChild(status);
    item.appendChild(track);
    els.uploadQueue.appendChild(item);
    return { item, status, bar };
  }

  function uploadFile(file) {
    return new Promise((resolve) => {
      const limit = state.info.maxFileSize;
      if (limit && file.size > limit) {
        const ui = addUploadItem(file);
        ui.status.classList.add("error");
        ui.status.textContent = `超过单文件上限 ${formatBytes(limit)}`;
        resolve(false);
        return;
      }

      const ui = addUploadItem(file);
      const formData = new FormData();
      formData.append("file", file);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.withCredentials = true;

      xhr.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.min(
          100,
          Math.round((event.loaded / event.total) * 100),
        );
        ui.bar.style.width = `${percent}%`;
        ui.status.textContent = `${percent}% · ${formatBytes(event.loaded)} / ${formatBytes(event.total)}`;
      });

      xhr.addEventListener("load", () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText || "{}");
        } catch {
          data = {};
        }
        if (xhr.status === 401) {
          setAuth(false);
          openAuth("upload");
          ui.status.classList.add("error");
          ui.status.textContent = "需要验证访问密码";
          resolve(false);
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          ui.bar.style.width = "100%";
          ui.status.classList.remove("error");
          ui.status.classList.add("done");
          ui.status.textContent = "上传完成";
          resolve(true);
          return;
        }
        ui.status.classList.add("error");
        ui.status.textContent = data.message || `上传失败（${xhr.status}）`;
        resolve(false);
      });

      xhr.addEventListener("error", () => {
        ui.status.classList.add("error");
        ui.status.textContent = "网络异常，上传中断";
        resolve(false);
      });

      xhr.addEventListener("abort", () => {
        ui.status.classList.add("error");
        ui.status.textContent = "已取消上传";
        resolve(false);
      });

      xhr.send(formData);
    });
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    for (const file of files) {
      // 逐个串行上传，避免多条大文件连接同时占用带宽与内存
      await uploadFile(file);
    }
    toast("上传任务已处理完成");
    if (state.currentView === "files") loadFiles(true);
  }

  // ---------------- 共享文本 ----------------
  function setSharedTextStatus(message, type = "") {
    els.sharedTextStatus.textContent = message;
    els.sharedTextStatus.classList.remove("done", "error");
    if (type) els.sharedTextStatus.classList.add(type);
  }

  async function loadSharedText(force = false) {
    if (!state.authed || sharedTextState.loading) return;
    if (
      !force &&
      (sharedTextState.dirty || document.activeElement === els.sharedText)
    )
      return;
    const requestId = ++sharedTextState.requestId;
    sharedTextState.loading = true;
    try {
      const response = await api("/api/shared-text");
      if (!response.ok) throw new Error("读取失败");
      const data = await response.json();
      const text = data.text || "";
      // 请求期间用户可能已输入或保存，过期响应一律丢弃，不能覆盖编辑框
      if (
        requestId !== sharedTextState.requestId ||
        sharedTextState.dirty ||
        document.activeElement === els.sharedText
      )
        return;
      if (text !== sharedTextState.lastLoaded) {
        sharedTextState.lastLoaded = text;
        els.sharedText.value = text;
      }
      sharedTextState.dirty = false;
      setSharedTextStatus(text ? "已同步" : "暂无内容", "done");
    } catch (error) {
      setSharedTextStatus(error.message, "error");
    } finally {
      sharedTextState.loading = false;
    }
  }

  async function saveSharedText() {
    if (sharedTextState.saving) return;
    const text = els.sharedText.value;
    if (!text.trim()) {
      setSharedTextStatus("内容为空，未保存", "error");
      toast("内容为空，未保存");
      return;
    }
    sharedTextState.saving = true;
    setSharedTextStatus("保存中…");
    try {
      const response = await api("/api/shared-text", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || "保存失败");
      sharedTextState.requestId += 1;
      sharedTextState.lastLoaded = text;
      const changedWhileSaving = els.sharedText.value !== text;
      sharedTextState.dirty = changedWhileSaving;
      setSharedTextStatus(
        changedWhileSaving ? "已保存，但编辑框有新修改未保存" : "已保存",
        changedWhileSaving ? "" : "done",
      );
      toast("已保存");
    } catch (error) {
      setSharedTextStatus(error.message, "error");
      toast(error.message);
    } finally {
      sharedTextState.saving = false;
    }
  }

  async function clearSharedText() {
    const ok = window.confirm(
      "确定清空当前共享文本？清空后其他设备将同步为空（历史记录仍保留）。",
    );
    if (!ok) return;
    try {
      const response = await api("/api/shared-text", { method: "DELETE" });
      if (!response.ok) throw new Error("清空失败");
      els.sharedText.value = "";
      sharedTextState.lastLoaded = "";
      sharedTextState.dirty = false;
      setSharedTextStatus("已清空", "done");
      toast("已清空");
    } catch (error) {
      setSharedTextStatus(error.message, "error");
    }
  }

  function renderHistory(history) {
    els.historyList.innerHTML = "";
    if (!history.length) {
      els.historyList.innerHTML = '<div class="empty">暂无历史记录</div>';
      return;
    }
    history.forEach((record) => {
      const item = document.createElement("div");
      item.className = "history-item";

      const meta = document.createElement("div");
      meta.className = "history-meta";
      meta.innerHTML = `<span>${escapeHtml(formatTime(record.createdAt))}</span><span>${escapeHtml(formatBytes(new Blob([record.text || ""]).size))}</span>`;

      const content = document.createElement("pre");
      content.className = "history-content";
      content.textContent = record.text || "";

      const actions = document.createElement("div");
      actions.className = "history-actions";

      const useBtn = iconAction("ghost small", "enter", "载入编辑");
      useBtn.addEventListener("click", () => {
        els.sharedText.value = record.text || "";
        sharedTextState.dirty = true;
        closeHistory();
        toast("已载入到编辑框，保存后生效");
      });

      const copyBtn = iconAction("ghost small", "copy", "复制");
      copyBtn.addEventListener("click", async () => {
        const ok = await copyToClipboard(record.text || "");
        toast(ok ? "已复制" : "复制失败");
      });

      const deleteBtn = iconAction("danger small", "trash", "删除");
      deleteBtn.dataset.action = "delete";
      deleteBtn.hidden = !state.local;
      deleteBtn.addEventListener("click", async () => {
        const ok = window.confirm("确定删除这条历史记录？");
        if (!ok) return;
        try {
          const response = await api(
            `/api/shared-text/history/${encodeURIComponent(record.id)}`,
            { method: "DELETE" },
          );
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.message || "删除失败");
          toast("已删除该记录");
          openHistory(true);
        } catch (error) {
          toast(error.message);
        }
      });

      actions.appendChild(useBtn);
      actions.appendChild(copyBtn);
      actions.appendChild(deleteBtn);
      item.appendChild(meta);
      item.appendChild(content);
      item.appendChild(actions);
      els.historyList.appendChild(item);
    });
  }

  async function openHistory(refreshOnly = false) {
    if (!refreshOnly) els.historyModal.hidden = false;
    try {
      const response = await api("/api/shared-text/history");
      if (!response.ok) throw new Error("读取历史失败");
      const data = await response.json();
      renderHistory(data.history || []);
    } catch (error) {
      els.historyList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    }
  }

  function closeHistory() {
    els.historyModal.hidden = true;
  }

  async function clearHistory() {
    const ok = window.confirm("确定删除全部历史记录？此操作不可恢复。");
    if (!ok) return;
    try {
      const response = await api("/api/shared-text/history", {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("删除失败");
      toast("历史记录已全部删除");
      openHistory(true);
    } catch (error) {
      toast(error.message);
    }
  }

  // ---------------- 预览浮层 ----------------
  let currentPrintFrame = null;

  function showPreviewFallback(frame, message, file) {
    frame.replaceChildren();
    els.printPlayerBtn.hidden = true;
    currentPrintFrame = null;
    const text = document.createElement("div");
    text.className = "player-msg";
    text.textContent = message;
    const link = document.createElement("a");
    link.className = "btn primary small";
    link.href = file.url;
    link.textContent = "下载查看";
    frame.appendChild(text);
    frame.appendChild(link);
  }

  async function renderTextPreview(file, frame, langInfo) {
    const lang = langInfo || textLanguageFromName(file.name) || languageOfExt(file.ext);
    els.playerSubtitle.textContent = `${categoryLabelOf(file)} · ${formatBytes(file.size)} · ${lang.label} 预览`;
    if ((Number(file.size) || 0) > 2 * 1024 * 1024) {
      showPreviewFallback(frame, "文件较大，建议下载后查看。", file);
      return;
    }
    const loading = document.createElement("div");
    loading.className = "player-msg";
    loading.textContent = "加载预览…";
    frame.replaceChildren(loading);
    try {
      const response = await api(file.url);
      if (!response.ok) throw new Error("读取失败");
      const text = await response.text();
      if (text.length > 800000) {
        showPreviewFallback(frame, "文件内容较长，建议下载后查看。", file);
        return;
      }
      frame.replaceChildren(buildCodeView(text, lang.key));
    } catch (error) {
      showPreviewFallback(frame, `预览失败：${error.message}`, file);
    }
  }

  async function openPlayer(file) {
    // 埋点：记录文件查看（预览）次数与文件名
    fetch("/api/v3/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action: "file-view", name: file.name })
    }).catch(() => {});
    els.playerTitle.textContent = displayBaseName(file.name);
    els.playerSubtitle.textContent = `${categoryLabelOf(file)} · ${formatBytes(file.size)}`;
    els.playerStage.innerHTML = "";
    const frame = document.createElement("div");
    frame.className = "player-frame";
    els.playerStage.appendChild(frame);

    const ext = String(file.ext || "").toLowerCase();
    const src = file.streamUrl || file.url;
    const isDoc =
      ext === "pdf" ||
      file.mediaType === "doc" ||
      TEXT_PREVIEW_EXTS.has(ext) ||
      Boolean(textLanguageFromName(file.name));
    els.playerHeader.hidden = !isDoc;
    els.printPlayerBtn.hidden = !isDoc;
    currentPrintFrame = null;

    if (file.mediaType === "video") {
      const wrap = document.createElement("div");
      wrap.className = "video-frame";
      const video = document.createElement("video");
      video.controls = true;
      video.autoplay = true;
      video.preload = "metadata";
      video.playsInline = true;
      video.src = `${src}#t=0.1`;
      video.addEventListener("error", () => {
        showPreviewFallback(
          frame,
          "该视频编码浏览器无法直接播放，请下载后本地播放。",
          file,
        );
      });
      wrap.appendChild(video);
      frame.appendChild(wrap);
    } else if (file.mediaType === "audio") {
      const wrap = document.createElement("div");
      wrap.className = "audio-frame";
      const badge = document.createElement("span");
      badge.className = "audio-badge";
      badge.textContent = "♪";
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.autoplay = true;
      audio.src = src;
      wrap.appendChild(badge);
      wrap.appendChild(audio);
      frame.appendChild(wrap);
    } else if (file.mediaType === "image") {
      const image = document.createElement("img");
      image.className = "preview-image";
      image.src = src;
      image.alt = displayBaseName(file.name);
      frame.appendChild(image);
    } else if (ext === "pdf" || file.mediaType === "doc") {
      const iframe = document.createElement("iframe");
      iframe.className = "doc-preview";
      iframe.src = `${src}#view=FitH`;
      iframe.title = displayBaseName(file.name);
      frame.appendChild(iframe);
      currentPrintFrame = iframe;
    } else if (TEXT_PREVIEW_EXTS.has(ext) || textLanguageFromName(file.name)) {
      await renderTextPreview(file, frame, textLanguageFromName(file.name));
    } else {
      showPreviewFallback(frame, "这种格式暂不支持在线预览。", file);
    }

    els.playerModal.hidden = false;
  }

  function printCurrentPreview() {
    if (els.playerModal.hidden) return;
    const frame = currentPrintFrame;
    if (frame && frame.contentWindow) {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        return;
      } catch (error) {
        // 浏览器限制时退回打印整页
      }
    }
    window.print();
  }

  function closePlayer() {
    els.playerModal.hidden = true;
    els.playerStage.innerHTML = "";
    currentPrintFrame = null;
  }

  // ---------------- 事件绑定 ----------------
  document.querySelectorAll(".entry-card").forEach((card) => {
    card.addEventListener("pointermove", (event) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty(
        "--mx",
        `${((event.clientX - rect.left) / rect.width) * 100}%`,
      );
      card.style.setProperty(
        "--my",
        `${((event.clientY - rect.top) / rect.height) * 100}%`,
      );
    });
    card.addEventListener("click", () => {
      const target = card.dataset.view;
      if (location.hash === `#/${target}`) applyRoute();
      else location.hash = `#/${target}`;
    });
  });

  document.querySelectorAll("[data-back]").forEach((button) => {
    button.addEventListener("click", () => {
      if (location.hash === "#/home") applyRoute();
      else location.hash = "#/home";
    });
  });

  els.authSubmitBtn.addEventListener("click", submitPassword);
  els.authCancelBtn.addEventListener("click", () => {
    closeAuth();
    if (PROTECTED_VIEWS.has(routeName())) {
      location.hash = "#/home";
    }
    applyRoute();
  });
  els.passwordInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submitPassword();
  });
  els.authBtn.addEventListener("click", () => {
    if (state.authed) logout();
    else openAuth(state.currentView);
  });

  els.search.addEventListener("input", () => {
    state.keyword = els.search.value;
    renderFilters();
    renderFiles({ animate: false });
  });

  els.sortSelect.addEventListener("change", () => {
    state.sort = els.sortSelect.value;
    // 名称默认升序更符合阅读习惯，其余维度默认降序
    state.order = state.sort === "name" ? "asc" : "desc";
    updateSortOrderButton();
    renderFiles({ animate: false });
  });

  function updateSortOrderButton() {
    const asc = state.order === "asc";
    els.sortOrderBtn.dataset.order = state.order;
    els.sortOrderBtn.innerHTML = iconSvg("sort");
    els.sortOrderBtn.style.transform = asc ? "scaleY(-1)" : "";
    els.sortOrderBtn.title = asc ? "当前升序，点击切换降序" : "当前降序，点击切换升序";
    els.sortOrderBtn.setAttribute("aria-label", els.sortOrderBtn.title);
  }

  els.sortOrderBtn.addEventListener("click", () => {
    state.order = state.order === "asc" ? "desc" : "asc";
    updateSortOrderButton();
    renderFiles({ animate: false });
  });

  els.refreshBtn.addEventListener("click", () => loadFiles());

  els.selectBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (event) => {
    handleFiles(event.target.files);
    event.target.value = "";
  });
  ["dragenter", "dragover"].forEach((type) => {
    els.dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("dragging");
    });
  });
  ["dragleave", "dragend"].forEach((type) => {
    els.dropZone.addEventListener(type, () =>
      els.dropZone.classList.remove("dragging"),
    );
  });
  els.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("dragging");
    handleFiles(event.dataTransfer?.files);
  });

  els.sharedText.addEventListener("input", () => {
    sharedTextState.dirty = true;
    setSharedTextStatus("未保存的修改");
  });

  els.saveTextBtn.addEventListener("click", saveSharedText);
  els.copyTextBtn.addEventListener("click", async () => {
    const ok = await copyToClipboard(els.sharedText.value);
    toast(ok ? "已复制" : "复制失败");
  });
  els.pasteTextBtn.addEventListener("click", async () => {
    if (!navigator.clipboard || !window.isSecureContext) {
      els.sharedText.focus();
      toast("请按 Ctrl/⌘ + V 粘贴");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      els.sharedText.value = text;
      sharedTextState.dirty = true;
      setSharedTextStatus("已粘贴，记得保存");
    } catch {
      els.sharedText.focus();
      toast("浏览器未授权读取剪贴板，请手动粘贴");
    }
  });
  els.refreshTextBtn.addEventListener("click", () => loadSharedText(true));
  els.historyTextBtn.addEventListener("click", () => openHistory());
  els.clearTextBtn.addEventListener("click", clearSharedText);
  els.closeHistoryBtn.addEventListener("click", closeHistory);
  els.clearHistoryBtn.addEventListener("click", clearHistory);
  els.closePlayerBtn.addEventListener("click", closePlayer);
  els.printPlayerBtn.addEventListener("click", printCurrentPreview);

  els.historyModal.addEventListener("click", (event) => {
    if (event.target === els.historyModal) closeHistory();
  });
  els.playerModal.addEventListener("click", (event) => {
    if (event.target === els.playerModal || event.target === els.playerStage) closePlayer();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!els.playerModal.hidden) closePlayer();
    else if (!els.historyModal.hidden) closeHistory();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!els.playerModal.hidden) return closePlayer();
    if (!els.historyModal.hidden) return closeHistory();
    if (!els.authModal.hidden) {
      closeAuth();
      if (PROTECTED_VIEWS.has(routeName())) location.hash = "#/home";
      applyRoute();
    }
  });

  window.addEventListener("hashchange", applyRoute);

  // 仅在对应功能页且已解锁时轮询，避免无效请求
  setInterval(() => {
    if (state.authed && state.currentView === "files") loadFiles(true);
  }, 15000);

  setInterval(() => {
    if (state.authed && state.currentView === "text") loadSharedText(false);
  }, 3000);

  async function init() {
    updateSortOrderButton();
    // 先同步按当前 hash 渲染目标视图（无动画），避免刷新时先闪一下首页再跳到目标页
    applyRoute({ instant: true });
    document.documentElement.classList.remove("route-booting");
    await checkAuth();
    await loadInfo();
    applyRoute({ instant: true });
  }

  init();
})();
