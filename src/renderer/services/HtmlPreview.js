// =============================================================================
// HTML effect preview
//
// Sandboxed iframe preview with live reload, debounced re-render and
// persisted viewport geometry.
//
// Classic script, extracted verbatim from app.js. Top-level declarations land
// in the global lexical environment, so app.js and the other services keep
// calling these by bare name. index.html fixes the load order; nothing here
// touches the DOM at load time.
// =============================================================================
const HTML_PREVIEW_STORAGE_KEY = 'iexa-html-preview-viewport';
const HTML_PREVIEW_LIVE_KEY = 'iexa-html-preview-live';
const HTML_PREVIEW_GEOMETRY_KEY = 'iexa-html-preview-geometry';
// The document can be rewritten by the agent's tool calls, an external editor,
// git or a build step. A local stat poll covers every one of those without
// threading a watcher through the tool layer, and it is what makes the pane
// live rather than a snapshot.
const HTML_PREVIEW_POLL_MS = 700;
// Several writes in one turn should produce one render, not one per file.
const HTML_PREVIEW_DEBOUNCE_MS = 180;
const HTML_PREVIEW_MIN_WIDTH = 360;
const HTML_PREVIEW_MIN_HEIGHT = 260;

let htmlPreviewTarget = null;
let htmlPreviewLastFocus = null;

const htmlPreviewState = {
  open: false,
  live: true,
  snapshot: null,
  missing: false,
  frames: [],
  active: 0,
  pollTimer: 0,
  debounceTimer: 0,
  resizeTimer: 0,
  loading: false,
  queued: false,
  primed: false,
  scrollY: 0,
  errors: [],
  geometry: null,
  drag: null,
};

function safelyDecodePath(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function isHtmlFilePath(value) {
  return /\.(?:html?|xhtml)(?:[?#].*)?$/i.test(String(value || '').trim());
}

function relativePathWithin(absolutePath, rootPath) {
  const value = String(absolutePath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const root = String(rootPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!value || !root) return null;
  const valueLower = value.toLowerCase();
  const rootLower = root.toLowerCase();
  if (valueLower === rootLower) return '';
  return valueLower.startsWith(rootLower + '/') ? value.slice(root.length + 1) : null;
}

function htmlPreviewEncodedPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function htmlPreviewUrl(scope, filePath) {
  return `${API_BASE}/api/fs/preview/${scope}/${htmlPreviewEncodedPath(filePath)}`;
}

function htmlPreviewStatUrl(scope, filePath) {
  return `${API_BASE}/api/fs/preview-stat/${scope}/${htmlPreviewEncodedPath(filePath)}`;
}

function resolveHtmlPreviewTarget(rawValue) {
  let raw = String(rawValue || '').trim();
  if (!raw || !isHtmlFilePath(raw)) return null;
  if (/^(?:https?|mailto|javascript|data|blob):/i.test(raw)) return null;

  if (!/^file:/i.test(raw) && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.hostname.toLowerCase() !== 'attachments') return null;
      const workspacePath = safelyDecodePath(`${url.hostname}${url.pathname}`).replace(/^\/+/, '');
      if (!isHtmlFilePath(workspacePath)) return null;
      return {
        scope: 'workspace',
        path: workspacePath,
        displayPath: `workspace/${workspacePath}`,
        absolutePath: '',
        url: htmlPreviewUrl('workspace', workspacePath),
      };
    } catch { return null; }
  }

  if (/^file:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      raw = safelyDecodePath(url.pathname).replace(/^\/(?=[A-Za-z]:\/)/, '');
    } catch { return null; }
  } else {
    raw = safelyDecodePath(raw.split('#')[0].split('?')[0]);
  }
  raw = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!isHtmlFilePath(raw) || (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[A-Za-z]:\//.test(raw))) return null;

  const isAbsolute = /^[A-Za-z]:\//.test(raw) || raw.startsWith('/');
  if (isAbsolute) {
    const projectRelative = relativePathWithin(raw, projectRoot);
    if (projectRelative != null) {
      return {
        scope: 'project', path: projectRelative, displayPath: raw,
        absolutePath: raw, url: htmlPreviewUrl('project', projectRelative),
      };
    }
    return {
      scope: 'absolute', path: raw, displayPath: raw,
      absolutePath: raw, url: htmlPreviewUrl('absolute', raw),
    };
  }

  if (!projectRoot && /^workspace\//i.test(raw)) {
    const workspacePath = raw.replace(/^workspace\//i, '');
    return {
      scope: 'workspace', path: workspacePath, displayPath: raw,
      absolutePath: '', url: htmlPreviewUrl('workspace', workspacePath),
    };
  }
  return {
    scope: projectRoot ? 'project' : 'workspace', path: raw, displayPath: raw,
    absolutePath: projectRoot ? `${String(projectRoot).replace(/[\\/]$/, '')}\\${raw.replace(/\//g, '\\')}` : '',
    url: htmlPreviewUrl(projectRoot ? 'project' : 'workspace', raw),
  };
}

function setHtmlPreviewViewport(viewport) {
  const allowed = new Set(['desktop', 'tablet', 'mobile']);
  const selected = allowed.has(viewport) ? viewport : 'desktop';
  const stage = document.getElementById('htmlPreviewStage');
  if (stage) stage.dataset.viewport = selected;
  document.querySelectorAll('[data-preview-viewport]').forEach((button) => {
    const active = button.dataset.previewViewport === selected;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  try { localStorage.setItem(HTML_PREVIEW_STORAGE_KEY, selected); } catch { /* ignore */ }
  updateHtmlPreviewDimensions();
}

function updateHtmlPreviewDimensions() {
  const canvas = document.getElementById('htmlPreviewCanvas');
  const label = document.getElementById('htmlPreviewDimensions');
  if (!canvas || !label) return;
  const rect = canvas.getBoundingClientRect();
  label.textContent = rect.width > 0 ? `${Math.round(rect.width)} × ${Math.round(rect.height)} px` : '自适应画布';
}

function setHtmlPreviewStatus(text) {
  const status = document.getElementById('htmlPreviewStatus');
  if (status && typeof text === 'string') status.textContent = text;
}

function readHtmlPreviewLivePreference() {
  try { return localStorage.getItem(HTML_PREVIEW_LIVE_KEY) !== '0'; } catch { return true; }
}

function renderHtmlPreviewLive() {
  const button = document.getElementById('htmlPreviewLive');
  if (!button) return;
  const live = htmlPreviewState.live;
  button.setAttribute('aria-pressed', live ? 'true' : 'false');
  button.title = live ? '文件变化时自动重新渲染（点击暂停）' : '自动重新渲染已暂停（点击开启）';
  const label = document.getElementById('htmlPreviewLiveLabel');
  if (label) label.textContent = live ? '实时' : '已暂停';
}

function renderHtmlPreviewErrors() {
  const badge = document.getElementById('htmlPreviewErrors');
  if (!badge) return;
  const count = htmlPreviewState.errors.length;
  badge.hidden = count === 0;
  badge.textContent = count === 1 ? '1 个脚本错误' : `${count} 个脚本错误`;
  badge.title = htmlPreviewState.errors.join('\n');
  document.querySelector('.html-preview-ready')?.classList.toggle('is-error', count > 0);
}

async function readHtmlPreviewSnapshot(target) {
  try {
    const response = await fetch(`${htmlPreviewStatUrl(target.scope, target.path)}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data) return null;
    if (!data.exists) return { exists: false };
    return { exists: true, mtimeMs: Number(data.mtimeMs) || 0, size: Number(data.size) || 0 };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Window geometry: the preview behaves like a floating pane. It keeps its
// place between sessions but is always clamped into the current viewport.
// ---------------------------------------------------------------------------

function defaultHtmlPreviewGeometry() {
  const width = Math.min(1120, Math.max(520, Math.round(window.innerWidth * 0.74)));
  const height = Math.min(820, Math.max(400, Math.round(window.innerHeight * 0.8)));
  return {
    left: Math.round((window.innerWidth - width) / 2),
    top: Math.round((window.innerHeight - height) / 2),
    width,
    height,
  };
}

function clampHtmlPreviewGeometry(geometry) {
  const maxWidth = Math.max(HTML_PREVIEW_MIN_WIDTH, window.innerWidth - 16);
  const maxHeight = Math.max(HTML_PREVIEW_MIN_HEIGHT, window.innerHeight - 16);
  const width = Math.min(Math.max(Number(geometry && geometry.width) || 720, Math.min(HTML_PREVIEW_MIN_WIDTH, maxWidth)), maxWidth);
  const height = Math.min(Math.max(Number(geometry && geometry.height) || 520, Math.min(HTML_PREVIEW_MIN_HEIGHT, maxHeight)), maxHeight);
  const left = Math.min(Math.max(Number(geometry && geometry.left) || 0, 8), Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(Math.max(Number(geometry && geometry.top) || 0, 8), Math.max(8, window.innerHeight - height - 8));
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
}

function readHtmlPreviewGeometry() {
  try {
    const raw = JSON.parse(localStorage.getItem(HTML_PREVIEW_GEOMETRY_KEY) || 'null');
    if (raw && Number.isFinite(raw.left) && Number.isFinite(raw.top)
      && Number.isFinite(raw.width) && Number.isFinite(raw.height)) return raw;
  } catch { /* corrupt geometry is not worth keeping */ }
  return null;
}

function applyHtmlPreviewGeometry(geometry) {
  const element = document.getElementById('htmlPreviewWindow');
  if (!element) return null;
  const next = clampHtmlPreviewGeometry(geometry || htmlPreviewState.geometry || readHtmlPreviewGeometry() || defaultHtmlPreviewGeometry());
  htmlPreviewState.geometry = next;
  element.style.left = `${next.left}px`;
  element.style.top = `${next.top}px`;
  element.style.width = `${next.width}px`;
  element.style.height = `${next.height}px`;
  return next;
}

function saveHtmlPreviewGeometry() {
  const element = document.getElementById('htmlPreviewWindow');
  if (!element || !htmlPreviewState.open) return;
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  htmlPreviewState.geometry = clampHtmlPreviewGeometry({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  try { localStorage.setItem(HTML_PREVIEW_GEOMETRY_KEY, JSON.stringify(htmlPreviewState.geometry)); } catch { /* storage may be unavailable */ }
}

function startHtmlPreviewDrag(event) {
  if (event.button !== 0) return;
  if (event.target.closest('button, input, select, textarea, a')) return;
  const element = document.getElementById('htmlPreviewWindow');
  if (!element) return;
  const rect = element.getBoundingClientRect();
  htmlPreviewState.drag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
  element.classList.add('is-dragging');
  event.currentTarget.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function moveHtmlPreviewDrag(event) {
  const drag = htmlPreviewState.drag;
  const element = document.getElementById('htmlPreviewWindow');
  if (!drag || !element || event.pointerId !== drag.id) return;
  const rect = element.getBoundingClientRect();
  const next = clampHtmlPreviewGeometry({
    left: event.clientX - drag.dx,
    top: event.clientY - drag.dy,
    width: rect.width,
    height: rect.height,
  });
  element.style.left = `${next.left}px`;
  element.style.top = `${next.top}px`;
}

function endHtmlPreviewDrag() {
  if (!htmlPreviewState.drag) return;
  htmlPreviewState.drag = null;
  document.getElementById('htmlPreviewWindow')?.classList.remove('is-dragging');
  saveHtmlPreviewGeometry();
}

// ---------------------------------------------------------------------------
// Double-buffered rendering
//
// Two iframes alternate. The next document loads into the hidden one and only
// swaps in once it has loaded, so a live update never shows a blank frame and
// never loses the reader's scroll position.
// ---------------------------------------------------------------------------

function postHtmlPreviewCommand(frame, payload) {
  try { frame.contentWindow?.postMessage({ __iexaPreviewCommand: 1, ...payload }, '*'); }
  catch { /* frame was replaced mid-flight */ }
}

function handleHtmlPreviewMessage(event) {
  if (!htmlPreviewState.open) return;
  const frame = htmlPreviewState.frames.find((item) => item.contentWindow === event.source);
  if (!frame) return;
  const data = event.data;
  if (!data || data.__iexaPreview !== 1) return;
  if (data.type === 'scroll') {
    if (frame === htmlPreviewState.frames[htmlPreviewState.active]) {
      const value = Number(data.scrollY);
      if (Number.isFinite(value)) htmlPreviewState.scrollY = Math.max(0, value);
    }
    return;
  }
  if (data.type === 'error') {
    const message = String(data.message || '脚本错误');
    if (!htmlPreviewState.errors.includes(message)) {
      htmlPreviewState.errors.push(message);
      renderHtmlPreviewErrors();
    }
  }
}

function loadHtmlPreviewFrame(initial) {
  const target = htmlPreviewTarget;
  const frames = htmlPreviewState.frames;
  if (!target || !htmlPreviewState.open || frames.length < 2) return;
  if (htmlPreviewState.loading) { htmlPreviewState.queued = true; return; }
  const next = frames[1 - htmlPreviewState.active];
  const loading = document.getElementById('htmlPreviewLoading');
  htmlPreviewState.loading = true;
  htmlPreviewState.errors = [];
  renderHtmlPreviewErrors();
  if (loading) loading.hidden = false;
  setHtmlPreviewStatus(initial ? '正在载入' : '正在重新渲染');
  next.dataset.pending = '1';
  next.dataset.reason = initial ? 'initial' : 'live';
  // `iexa_runtime` makes the server inject the scroll/error channel. It is
  // independent of the renderer's own change polling.
  next.src = `${target.url}?iexa_runtime=1&iexa_preview=${Date.now()}`;
}

function commitHtmlPreviewFrame(frame) {
  const frames = htmlPreviewState.frames;
  const index = frames.indexOf(frame);
  if (index < 0) return;
  const reason = frame.dataset.reason || 'initial';
  delete frame.dataset.reason;
  htmlPreviewState.loading = false;
  htmlPreviewState.active = index;
  frames.forEach((item, itemIndex) => {
    item.classList.toggle('is-active', itemIndex === index);
    item.setAttribute('aria-hidden', itemIndex === index ? 'false' : 'true');
    item.tabIndex = itemIndex === index ? 0 : -1;
  });
  // Restore the position in the incoming document while it is still
  // transparent, so the swap never jumps to the top of the page.
  postHtmlPreviewCommand(frame, { type: 'scroll', y: htmlPreviewState.scrollY });
  const commit = () => {
    if (!htmlPreviewState.open || htmlPreviewState.frames[index] !== frame) return;
    const loading = document.getElementById('htmlPreviewLoading');
    if (loading) loading.hidden = true;
    if (reason === 'initial') {
      setHtmlPreviewStatus('预览已就绪');
    } else {
      const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      setHtmlPreviewStatus(`已更新 ${stamp}`);
    }
    updateHtmlPreviewDimensions();
    if (htmlPreviewState.queued) {
      htmlPreviewState.queued = false;
      loadHtmlPreviewFrame(false);
    }
  };
  if (reason === 'initial') commit();
  else window.setTimeout(commit, 60);
}

async function primeHtmlPreview() {
  const target = htmlPreviewTarget;
  if (!target || !htmlPreviewState.open) return;
  const snapshot = await readHtmlPreviewSnapshot(target);
  if (!htmlPreviewState.open || htmlPreviewTarget !== target) return;
  // A failed stat is not a missing file: render anyway and let the poll decide.
  htmlPreviewState.snapshot = snapshot && snapshot.exists ? snapshot : null;
  htmlPreviewState.missing = Boolean(snapshot && !snapshot.exists);
  htmlPreviewState.primed = true;
  loadHtmlPreviewFrame(true);
}

function openHtmlPreview(rawPath) {
  const target = typeof rawPath === 'object' && rawPath ? rawPath : resolveHtmlPreviewTarget(rawPath);
  const overlay = document.getElementById('htmlPreviewOverlay');
  if (!target || !overlay) return false;
  if (htmlPreviewState.frames.length < 2) {
    htmlPreviewState.frames = [document.getElementById('htmlPreviewFrame'), document.getElementById('htmlPreviewFrameBack')].filter(Boolean);
  }
  if (htmlPreviewState.frames.length < 2) return false;

  htmlPreviewTarget = target;
  htmlPreviewState.open = true;
  htmlPreviewState.errors = [];
  htmlPreviewState.scrollY = 0;
  htmlPreviewState.snapshot = null;
  htmlPreviewState.missing = false;
  htmlPreviewState.loading = false;
  htmlPreviewState.queued = false;
  htmlPreviewState.primed = false;
  htmlPreviewLastFocus = document.activeElement;

  const title = String(target.displayPath || target.path).replace(/\\/g, '/').split('/').pop() || 'HTML 预览';
  const titleEl = document.getElementById('htmlPreviewTitle');
  const address = document.getElementById('htmlPreviewAddress');
  if (titleEl) titleEl.textContent = title;
  if (address) { address.textContent = target.displayPath || target.path; address.title = target.displayPath || target.path; }
  setHtmlPreviewStatus('正在载入');
  const loading = document.getElementById('htmlPreviewLoading');
  if (loading) loading.hidden = false;

  htmlPreviewState.live = readHtmlPreviewLivePreference();
  renderHtmlPreviewLive();
  renderHtmlPreviewErrors();
  overlay.hidden = false;
  applyHtmlPreviewGeometry();
  requestAnimationFrame(updateHtmlPreviewDimensions);
  primeHtmlPreview();
  scheduleHtmlPreviewPoll();
  document.getElementById('htmlPreviewWindow')?.focus?.();
  return true;
}

function closeHtmlPreview() {
  const overlay = document.getElementById('htmlPreviewOverlay');
  if (!overlay || overlay.hidden) return;
  saveHtmlPreviewGeometry();
  htmlPreviewState.open = false;
  window.clearTimeout(htmlPreviewState.pollTimer);
  window.clearTimeout(htmlPreviewState.debounceTimer);
  htmlPreviewState.loading = false;
  htmlPreviewState.queued = false;
  endHtmlPreviewDrag();
  overlay.hidden = true;
  htmlPreviewState.frames.forEach((frame) => {
    delete frame.dataset.pending;
    delete frame.dataset.reason;
    frame.classList.remove('is-active');
    try { frame.src = 'about:blank'; } catch { /* ignore */ }
  });
  htmlPreviewTarget = null;
  htmlPreviewState.scrollY = 0;
  htmlPreviewState.errors = [];
  if (htmlPreviewLastFocus && typeof htmlPreviewLastFocus.focus === 'function') htmlPreviewLastFocus.focus();
  htmlPreviewLastFocus = null;
}

function reloadHtmlPreview() {
  if (!htmlPreviewTarget) return;
  htmlPreviewState.snapshot = null;
  primeHtmlPreview();
}

function scheduleHtmlPreviewReload() {
  window.clearTimeout(htmlPreviewState.debounceTimer);
  htmlPreviewState.debounceTimer = window.setTimeout(() => loadHtmlPreviewFrame(false), HTML_PREVIEW_DEBOUNCE_MS);
}

function scheduleHtmlPreviewPoll() {
  window.clearTimeout(htmlPreviewState.pollTimer);
  htmlPreviewState.pollTimer = window.setTimeout(pollHtmlPreviewFile, HTML_PREVIEW_POLL_MS);
}

async function pollHtmlPreviewFile() {
  const target = htmlPreviewTarget;
  if (!htmlPreviewState.open || !target) return;
  if (!htmlPreviewState.live) {
    // Keep the loop alive so flipping the switch back on resumes immediately.
    scheduleHtmlPreviewPoll();
    return;
  }
  // The first snapshot is taken while opening; comparing before it lands would
  // look like "no file" and queue a redundant second render.
  if (!htmlPreviewState.primed) {
    scheduleHtmlPreviewPoll();
    return;
  }
  const snapshot = await readHtmlPreviewSnapshot(target);
  if (!htmlPreviewState.open || htmlPreviewTarget !== target) return;
  if (!snapshot) {
    // Transport hiccup (the local server is restarting, the tab was suspended):
    // keep the last rendered document and retry on the next tick instead of
    // claiming the file was deleted.
  } else if (!snapshot.exists) {
    htmlPreviewState.missing = true;
    setHtmlPreviewStatus('文件已删除，显示上次渲染');
  } else if (htmlPreviewState.missing || !htmlPreviewState.snapshot) {
    htmlPreviewState.missing = false;
    htmlPreviewState.snapshot = snapshot;
    scheduleHtmlPreviewReload();
  } else if (snapshot.mtimeMs !== htmlPreviewState.snapshot.mtimeMs || snapshot.size !== htmlPreviewState.snapshot.size) {
    htmlPreviewState.snapshot = snapshot;
    scheduleHtmlPreviewReload();
  }
  scheduleHtmlPreviewPoll();
}

function setHtmlPreviewLive(live) {
  htmlPreviewState.live = Boolean(live);
  try { localStorage.setItem(HTML_PREVIEW_LIVE_KEY, htmlPreviewState.live ? '1' : '0'); } catch { /* ignore */ }
  renderHtmlPreviewLive();
  setHtmlPreviewStatus(htmlPreviewState.live ? '实时监听中' : '实时已暂停');
  if (htmlPreviewState.live) {
    window.clearTimeout(htmlPreviewState.pollTimer);
    scheduleHtmlPreviewPoll();
  }
}

function initHtmlPreview() {
  const overlay = document.getElementById('htmlPreviewOverlay');
  if (!overlay) return;
  htmlPreviewState.frames = [
    document.getElementById('htmlPreviewFrame'),
    document.getElementById('htmlPreviewFrameBack'),
  ].filter(Boolean);
  htmlPreviewState.frames.forEach((frame) => {
    frame.addEventListener('load', () => {
      if (!htmlPreviewState.open || !frame.dataset.pending) return;
      delete frame.dataset.pending;
      commitHtmlPreviewFrame(frame);
    });
  });

  document.getElementById('htmlPreviewClose')?.addEventListener('click', closeHtmlPreview);
  document.getElementById('htmlPreviewReload')?.addEventListener('click', reloadHtmlPreview);
  document.getElementById('htmlPreviewLive')?.addEventListener('click', () => setHtmlPreviewLive(!htmlPreviewState.live));
  document.getElementById('htmlPreviewCopyPath')?.addEventListener('click', async (event) => {
    if (!htmlPreviewTarget) return;
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(htmlPreviewTarget.absolutePath || htmlPreviewTarget.displayPath || htmlPreviewTarget.path);
      button.classList.add('is-confirmed');
      window.setTimeout(() => button.classList.remove('is-confirmed'), 1200);
    } catch { /* clipboard permission is surfaced by the browser */ }
  });
  document.getElementById('htmlPreviewOpenExternal')?.addEventListener('click', async () => {
    if (!htmlPreviewTarget) return;
    if (htmlPreviewTarget.absolutePath && window.iexaDesktop?.openPath) {
      await window.iexaDesktop.openPath(htmlPreviewTarget.absolutePath);
      return;
    }
    window.open(htmlPreviewTarget.url, '_blank', 'noopener,noreferrer');
  });
  document.querySelectorAll('[data-preview-viewport]').forEach((button) => {
    button.addEventListener('click', () => setHtmlPreviewViewport(button.dataset.previewViewport));
  });

  window.addEventListener('message', handleHtmlPreviewMessage);

  const titlebar = document.querySelector('.html-preview-titlebar');
  if (titlebar) {
    titlebar.addEventListener('pointerdown', startHtmlPreviewDrag);
    titlebar.addEventListener('dblclick', (event) => {
      if (event.target.closest('button, input, a')) return;
      applyHtmlPreviewGeometry(defaultHtmlPreviewGeometry());
      saveHtmlPreviewGeometry();
    });
  }
  // Moves are tracked on the window, not the titlebar: once the pointer leaves
  // the 43px bar it is over the document, and a sandboxed iframe is a separate
  // document that swallows pointer events. The is-dragging rule below disables
  // hit-testing inside the frame for the duration so the drag keeps flowing.
  window.addEventListener('pointermove', moveHtmlPreviewDrag);
  // A pointer released outside the window, or a cancelled capture, must not
  // leave the pane stuck in the dragging state.
  window.addEventListener('pointerup', endHtmlPreviewDrag);
  window.addEventListener('pointercancel', endHtmlPreviewDrag);
  window.addEventListener('blur', endHtmlPreviewDrag);
  window.addEventListener('resize', () => {
    if (!htmlPreviewState.open) return;
    applyHtmlPreviewGeometry();
  });

  const canvas = document.getElementById('htmlPreviewCanvas');
  if (canvas && window.ResizeObserver) new ResizeObserver(updateHtmlPreviewDimensions).observe(canvas);
  const windowEl = document.getElementById('htmlPreviewWindow');
  if (windowEl && window.ResizeObserver) {
    new ResizeObserver(() => {
      if (!htmlPreviewState.open) return;
      window.clearTimeout(htmlPreviewState.resizeTimer);
      htmlPreviewState.resizeTimer = window.setTimeout(saveHtmlPreviewGeometry, 260);
    }).observe(windowEl);
  }

  let savedViewport = 'desktop';
  try { savedViewport = localStorage.getItem(HTML_PREVIEW_STORAGE_KEY) || 'desktop'; } catch { /* ignore */ }
  setHtmlPreviewViewport(savedViewport);

  htmlPreviewState.live = readHtmlPreviewLivePreference();
  renderHtmlPreviewLive();
  renderHtmlPreviewErrors();

  // Escape closes the preview from anywhere, but only while it is open. Installed
  // here rather than at load time so this file has no startup side effects.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && htmlPreviewState.open) closeHtmlPreview();
  });
}
