// =============================================================================
// IEXA PC - Electron Main Entry
// Native desktop window using the local agent server
// =============================================================================

const { app, BrowserWindow, shell, dialog, Tray, Menu, nativeImage, ipcMain, screen, session, crashReporter, desktopCapturer } = require('electron');
const { autoUpdater } = require('electron-updater');
const { UpdateService } = require('./dist/main/update/UpdateService');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const net = require('net');
const { installWindowCorners } = require('./resources/window-corners.cjs');
const { installZoomControls, stripZoomAccelerators } = require('./resources/zoom-controls.cjs');
const { mainWindowChromeOptions, mainWindowState, runWindowCommand, createWindowResize, trackWindowState, isWindowFullscreen } = require('./resources/window-chrome.cjs');

// The backend listens on IPv4 0.0.0.0 for the optional phone bridge. Keep
// Electron's own control path on an explicit IPv4 loopback address because
// some Windows installations resolve `localhost` to ::1 first.
const LOOPBACK_HOST = '127.0.0.1';
const HEADLESS = process.env.IEXA_HEADLESS === '1';

/** Find a random free port on 127.0.0.1 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Local-only crash collection: dumps stay on this machine and are listed by the
// diagnostics export. Nothing is uploaded.
try {
  crashReporter.start({ productName: 'IEXA-WIN', companyName: 'IEXA', uploadToServer: false, compress: true });
  process.env.IEXA_CRASH_DIR = app.getPath('crashDumps');
} catch { /* crash reporting is best-effort and must never block startup */ }

let PORT = null;let mainWindow = null;
let resizeMainWindow = null;
let desktopLiveWindow = null;
let petWindow = null;
let server = null;
let tray = null;
let updateService = null;
let isQuitting = false;
let windowStateSaveTimer = null;
let desktopLiveStateSaveTimer = null;

function workspaceFile(name) {
  return path.join(process.env.IEXA_WORKSPACE || path.join(__dirname, 'workspace'), name);
}

function readJsonFile(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function loadWindowState() {
  const raw = readJsonFile(workspaceFile('.iexa-window-state.json'));
  const width = Math.round(Math.min(3840, Math.max(800, Number(raw.width) || 1200)));
  const height = Math.round(Math.min(2160, Math.max(600, Number(raw.height) || 800)));
  const x = Number.isFinite(Number(raw.x)) ? Math.round(Number(raw.x)) : undefined;
  const y = Number.isFinite(Number(raw.y)) ? Math.round(Number(raw.y)) : undefined;
  if (x === undefined || y === undefined) return { width, height, maximized: raw.maximized === true };
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return x < area.x + area.width - 80 && x + width > area.x + 80 && y < area.y + area.height - 40 && y + height > area.y + 40;
  });
  return visible ? { x, y, width, height, maximized: raw.maximized === true } : { width, height, maximized: raw.maximized === true };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getNormalBounds();
  writeJsonAtomic(workspaceFile('.iexa-window-state.json'), { ...bounds, maximized: mainWindow.isMaximized() });
}

function loadDesktopLiveWindowState() {
  const raw = readJsonFile(workspaceFile('.iexa-desktop-live-state.json'));
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.round(Math.min(960, Math.max(360, Number(raw.width) || 520)));
  const height = Math.round(Math.min(760, Math.max(260, Number(raw.height) || 390)));
  const fallback = {
    x: area.x + Math.max(12, area.width - width - 24),
    y: area.y + Math.max(12, area.height - height - 24),
    width,
    height,
    pinned: raw.pinned !== false,
  };
  const x = Number.isFinite(Number(raw.x)) ? Math.round(Number(raw.x)) : fallback.x;
  const y = Number.isFinite(Number(raw.y)) ? Math.round(Number(raw.y)) : fallback.y;
  const visible = screen.getAllDisplays().some((display) => {
    const work = display.workArea;
    return x < work.x + work.width - 80 && x + width > work.x + 80
      && y < work.y + work.height - 40 && y + height > work.y + 40;
  });
  return visible ? { x, y, width, height, pinned: fallback.pinned } : fallback;
}

function saveDesktopLiveWindowState() {
  if (!desktopLiveWindow || desktopLiveWindow.isDestroyed()) return;
  writeJsonAtomic(workspaceFile('.iexa-desktop-live-state.json'), {
    ...desktopLiveWindow.getNormalBounds(),
    pinned: desktopLiveWindow.isAlwaysOnTop(),
  });
}

function trustedSender(event) {
  const contents = event.sender;
  if (![mainWindow, desktopLiveWindow, petWindow].some(win => win && !win.isDestroyed() && win.webContents === contents)) return false;
  try { const url = new URL(event.senderFrame.url); return url.origin === `http://${LOOPBACK_HOST}:${PORT}` && ['/', '/index.html', '/desktop-live.html', '/pet.html'].includes(url.pathname) && event.senderFrame === contents.mainFrame; } catch { return false; }
}
const registerHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerHandle(channel, (event, ...args) => {
  if (!trustedSender(event)) throw new Error('Untrusted IPC sender');
  return handler(event, ...args);
});
function secureNavigation(win, trustedPage) {
  win.webContents.on('will-navigate', (event, target) => {
    try { const url = new URL(target); if (url.origin === `http://${LOOPBACK_HOST}:${PORT}` && trustedPage.includes(url.pathname)) return; } catch {}
    event.preventDefault();
  });
}

ipcMain.on('iexa:get-initial-appearance', (event) => {
  event.returnValue = trustedSender(event) ? readJsonFile(workspaceFile('.iexa-appearance.json'), null) : null;
});

ipcMain.on('iexa:get-window-state', (event) => {
  event.returnValue = trustedSender(event) && event.sender === mainWindow?.webContents ? mainWindowState(mainWindow) : null;
});
ipcMain.handle('iexa:window-command', (event, command) => {
  runWindowCommand(mainWindow, event.sender, command);
});
ipcMain.handle('iexa:window-resize', (event, request) => {
  if (!resizeMainWindow || process.platform !== 'win32') throw new Error('Window resize unavailable');
  resizeMainWindow(event.sender, request);
});


function createDesktopLiveWindow() {
  if (desktopLiveWindow && !desktopLiveWindow.isDestroyed()) {
    desktopLiveWindow.show();
    desktopLiveWindow.focus();
    return desktopLiveWindow;
  }
  if (!PORT) throw new Error('IEXA backend is not ready.');
  const saved = loadDesktopLiveWindowState();
  desktopLiveWindow = new BrowserWindow({
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: saved.height,
    minWidth: 360,
    minHeight: 260,
    maxWidth: 1200,
    maxHeight: 900,
    title: 'IEXA 实况桌面',
    icon: path.join(__dirname, 'resources', 'icon.png'),
    frame: false,
    transparent: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: saved.pinned,
    skipTaskbar: false,
    backgroundColor: '#1c1c1e',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  desktopLiveWindow.setMenuBarVisibility(false);
  desktopLiveWindow.setAlwaysOnTop(saved.pinned, 'floating');
  const scheduleSave = () => {
    if (desktopLiveStateSaveTimer) clearTimeout(desktopLiveStateSaveTimer);
    desktopLiveStateSaveTimer = setTimeout(() => {
      desktopLiveStateSaveTimer = null;
      saveDesktopLiveWindowState();
    }, 200);
  };
  desktopLiveWindow.on('move', scheduleSave);
  desktopLiveWindow.on('resize', scheduleSave);
  desktopLiveWindow.once('ready-to-show', () => desktopLiveWindow?.show());
  desktopLiveWindow.on('close', () => {
    if (desktopLiveStateSaveTimer) {
      clearTimeout(desktopLiveStateSaveTimer);
      desktopLiveStateSaveTimer = null;
    }
    saveDesktopLiveWindowState();
  });
  desktopLiveWindow.on('closed', () => {
    desktopLiveWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('iexa:desktop-live-closed');
  });
  secureNavigation(desktopLiveWindow, ['/desktop-live.html']);
  desktopLiveWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  desktopLiveWindow.loadURL(`http://${LOOPBACK_HOST}:${PORT}/desktop-live.html`);
  return desktopLiveWindow;
}

ipcMain.handle('iexa:desktop-live-open', () => {
  const win = createDesktopLiveWindow();
  return { open: true, pinned: win.isAlwaysOnTop(), bounds: win.getBounds() };
});

ipcMain.handle('iexa:desktop-live-state', () => {
  if (!desktopLiveWindow || desktopLiveWindow.isDestroyed()) return { open: false, pinned: true };
  return { open: true, pinned: desktopLiveWindow.isAlwaysOnTop(), bounds: desktopLiveWindow.getBounds() };
});

ipcMain.handle('iexa:desktop-live-pin', (_event, pinned) => {
  if (!desktopLiveWindow || desktopLiveWindow.isDestroyed()) return { open: false, pinned: Boolean(pinned) };
  desktopLiveWindow.setAlwaysOnTop(Boolean(pinned), 'floating');
  saveDesktopLiveWindowState();
  return { open: true, pinned: desktopLiveWindow.isAlwaysOnTop() };
});

ipcMain.handle('iexa:desktop-live-minimize', () => {
  if (desktopLiveWindow && !desktopLiveWindow.isDestroyed()) desktopLiveWindow.minimize();
  return { ok: true };
});

ipcMain.handle('iexa:desktop-live-close', () => {
  if (desktopLiveWindow && !desktopLiveWindow.isDestroyed()) desktopLiveWindow.close();
  return { ok: true };
});

// ---- Desktop pet -------------------------------------------------------
// A frameless, transparent, always-on-top surface the size of its sprite. All
// state lives in the workspace (`.iexa-pet/`); this block only owns the window.
const PET_PAD_X = 36;
const PET_PAD_Y = 70;
let petDrag = null;
let petWanderTimer = null;
let petMoveTimer = null;

function petConfigFile() { return workspaceFile('.iexa-pet/config.json'); }
function petPositionFile() { return workspaceFile('.iexa-pet/position.json'); }

function readPetConfig() {
  const raw = readJsonFile(petConfigFile(), {}) || {};
  return {
    visible: raw.visible === true,
    scale: Math.min(2, Math.max(0.5, Number(raw.scale) || 1)),
    alwaysOnTop: raw.alwaysOnTop !== false,
    wander: raw.wander !== false,
    shadow: raw.shadow !== false,
    reactions: raw.reactions !== false,
  };
}

/** Sprite pixel size straight from the PNG header. */
function petSpriteSize() {
  try {
    const bytes = fs.readFileSync(workspaceFile('.iexa-pet/sprite.png'));
    if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), stamp: `${bytes.length}-${Math.round(fs.statSync(workspaceFile('.iexa-pet/sprite.png')).mtimeMs)}` };
  } catch { return null; }
}

function petWindowSize(size, config) {
  const scale = config.scale || 1;
  return {
    width: Math.max(120, Math.round(size.width * scale) + PET_PAD_X),
    height: Math.max(120, Math.round(size.height * scale) + PET_PAD_Y),
  };
}

function defaultPetPosition(width, height) {
  const display = screen.getPrimaryDisplay().workArea;
  return { x: display.x + display.width - width - 48, y: display.y + display.height - height - 24 };
}

function readPetPosition(width, height) {
  const saved = readJsonFile(petPositionFile(), null);
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return defaultPetPosition(width, height);
  const visible = screen.getAllDisplays().some((display) => {
    const work = display.workArea;
    return saved.x < work.x + work.width - 60 && saved.x + width > work.x + 60
      && saved.y < work.y + work.height - 40 && saved.y + height > work.y + 40;
  });
  return visible ? { x: Math.round(saved.x), y: Math.round(saved.y) } : defaultPetPosition(width, height);
}

function savePetPosition() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const [x, y] = petWindow.getPosition();
  writeJsonAtomic(petPositionFile(), { x, y });
}

/** Ask the surface to redraw from the current sprite and config. */
function pushPetState(extra = {}) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const config = readPetConfig();
  const size = petSpriteSize();
  const bounds = petWindow.getBounds();
  const wanted = size ? petWindowSize(size, config) : null;
  if (wanted && (wanted.width !== bounds.width || wanted.height !== bounds.height)) {
    petWindow.setBounds({ ...bounds, width: wanted.width, height: wanted.height }, false);
  }
  petWindow.setAlwaysOnTop(config.alwaysOnTop, 'floating');
  petWindow.webContents.send('iexa:pet-state', {
    spriteVersion: size ? size.stamp : '',
    config,
    ...extra,
  });
}

function startPetWander() {
  clearInterval(petWanderTimer);
  petWanderTimer = null;
  const config = readPetConfig();
  if (!config.wander || !petWindow || petWindow.isDestroyed()) return;
  petWanderTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || petDrag) return;
    const display = screen.getDisplayMatching(petWindow.getBounds()).workArea;
    const [x, y] = petWindow.getPosition();
    const width = petWindow.getBounds().width;
    const height = petWindow.getBounds().height;
    const targetX = Math.round(display.x + 24 + Math.random() * Math.max(1, display.width - width - 48));
    const targetY = Math.round(display.y + 24 + Math.random() * Math.max(1, display.height - height - 48));
    if (Math.abs(targetX - x) < 40 && Math.abs(targetY - y) < 40) return;
    glidePetTo(x, y, targetX, targetY);
  }, 9000 + Math.random() * 6000);
}

/** 700ms ease-out glide; window moves are discrete, so we interpolate. */
function glidePetTo(fromX, fromY, toX, toY) {
  clearInterval(petMoveTimer);
  const started = Date.now();
  const duration = 700;
  petMoveTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) { clearInterval(petMoveTimer); return; }
    const t = Math.min(1, (Date.now() - started) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    petWindow.setPosition(Math.round(fromX + (toX - fromX) * eased), Math.round(fromY + (toY - fromY) * eased));
    if (t >= 1) { clearInterval(petMoveTimer); petMoveTimer = null; savePetPosition(); }
  }, 16);
}

function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) return petWindow;
  const config = readPetConfig();
  const size = petSpriteSize();
  if (!size) return null;
  const { width, height } = petWindowSize(size, config);
  const position = readPetPosition(width, height);
  petWindow = new BrowserWindow({
    x: position.x,
    y: position.y,
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: config.alwaysOnTop,
    show: false,
    focusable: true,
    title: 'IEXA 桌宠',
    icon: path.join(__dirname, 'resources', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'resources', 'pet-preload.js'),
    },
  });
  petWindow.setMenuBarVisibility(false);
  petWindow.setAlwaysOnTop(config.alwaysOnTop, 'floating');
  petWindow.once('ready-to-show', () => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.showInactive();
  });
  petWindow.on('moved', () => { if (!petDrag) savePetPosition(); });
  petWindow.on('closed', () => {
    clearInterval(petWanderTimer); petWanderTimer = null;
    clearInterval(petMoveTimer); petMoveTimer = null;
    petWindow = null;
  });
  secureNavigation(petWindow, ['/pet.html']);
  petWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  petWindow.loadURL(`http://${LOOPBACK_HOST}:${PORT}/pet.html`);
  startPetWander();
  return petWindow;
}

ipcMain.on('iexa:pet-initial-state', (event) => {
  if (!petWindow || event.sender !== petWindow.webContents) { event.returnValue = null; return; }
  const size = petSpriteSize();
  event.returnValue = { spriteVersion: size ? size.stamp : '', config: readPetConfig() };
});

ipcMain.on('iexa:pet-ready', () => pushPetState());

ipcMain.on('iexa:pet-drag-start', () => {
  if (!petWindow || petWindow.isDestroyed()) return;
  const [x, y] = petWindow.getPosition();
  petDrag = { x, y };
  clearInterval(petMoveTimer); petMoveTimer = null;
});

ipcMain.on('iexa:pet-drag-move', (_event, delta) => {
  if (!petDrag || !petWindow || petWindow.isDestroyed()) return;
  const dx = Number(delta?.dx) || 0;
  const dy = Number(delta?.dy) || 0;
  petWindow.setPosition(Math.round(petDrag.x + dx), Math.round(petDrag.y + dy));
});

ipcMain.on('iexa:pet-drag-end', () => {
  petDrag = null;
  savePetPosition();
});

ipcMain.on('iexa:pet-poked', () => { /* reserved for future reactions */ });

ipcMain.on('iexa:pet-open-main', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

ipcMain.on('iexa:pet-set-wander', (_event, wander) => {
  try {
    const file = petConfigFile();
    const raw = readJsonFile(file, {}) || {};
    writeJsonAtomic(file, { ...raw, wander: Boolean(wander) });
    if (wander) startPetWander(); else { clearInterval(petWanderTimer); petWanderTimer = null; }
  } catch { /* the renderer can retry from settings */ }
});

ipcMain.on('iexa:pet-menu', (_event, action) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (action === 'hide') {
    petWindow.hide();
    try {
      const file = petConfigFile();
      const raw = readJsonFile(file, {}) || {};
      writeJsonAtomic(file, { ...raw, visible: false });
    } catch { /* best effort */ }
    return;
  }
  if (action === 'quit') { petWindow.close(); return; }
  if (action === 'main' && mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

/** Let the HTTP server drive the pet surface (routes cannot open windows). */
function installPetHost() {
  try {
    const { setPetWindowHost } = require('./dist/main/pet/PetWindowHost');
    setPetWindowHost({
      setVisible(visible) {
        if (visible) {
          const win = createPetWindow();
          if (win) win.showInactive();
        } else if (petWindow && !petWindow.isDestroyed()) {
          petWindow.hide();
        }
      },
      applyConfig() { pushPetState(); },
      close() { if (petWindow && !petWindow.isDestroyed()) petWindow.close(); },
      isOpen() { return !!petWindow && !petWindow.isDestroyed() && petWindow.isVisible(); },
    });
    // A pet that was on screen when the app closed comes back with it.
    if (readPetConfig().visible && petSpriteSize()) {
      const win = createPetWindow();
      if (win) win.showInactive();
    }
  } catch (error) {
    console.error('[IEXA] Pet host failed:', error.message);
  }
}

// ---- Per-instance workspace ----
// Each window is its own agent instance. Give it a unique workspace so
// sessions / memory / settings never collide across concurrent windows.
//
// Where does this build keep sessions, settings and uploads?
//
// Order matters: a packaged build must never write beside its own executable —
// dropping an `IEXA-WIN-data` folder on someone's desktop is exactly what made
// the portable build look like it had "lost" every conversation.
//
//   1. IEXA_WORKSPACE            explicit override (launchers, tests, CI)
//   2. %APPDATA%\IEXA-WIN\workspace-path.txt
//                                a pointer, so a packaged build can share the
//                                workspace of a source checkout instead of
//                                starting empty
//   3. %APPDATA%\IEXA-WIN\workspace   the default for any packaged build
//   4. <repo>\workspace          development only
function resolveWorkspaceDir() {
  if (process.env.IEXA_WORKSPACE) return process.env.IEXA_WORKSPACE;
  const appDataRoot = path.join(app.getPath('appData'), 'IEXA-WIN');
  const pointerFile = path.join(appDataRoot, 'workspace-path.txt');
  try {
    const target = fs.readFileSync(pointerFile, 'utf8').trim();
    if (target && fs.existsSync(path.join(target, '.iexa-sessions.json'))) return target;
  } catch { /* no pointer, or unreadable */ }
  if (app.isPackaged) return path.join(appDataRoot, 'workspace');
  return path.join(__dirname, 'workspace');
}

function ensureInstanceWorkspace() {
  if (process.env.IEXA_WORKSPACE) return; // caller explicitly set it
  process.env.IEXA_WORKSPACE = resolveWorkspaceDir();
  fs.mkdirSync(process.env.IEXA_WORKSPACE, { recursive: true });
  console.log('[IEXA] Workspace:', process.env.IEXA_WORKSPACE);
  console.log('[IEXA] Hit Ctrl+C / close window to stop this instance.');
}

// Folder picker for "添加项目"
ipcMain.handle('iexa:pick-folder', async () => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const result = await dialog.showOpenDialog(win || undefined, {
    title: '选择项目文件夹',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

function readSkillFromPath(selected) {
  try {
    const st = fs.statSync(selected);
    let skillMdPath = selected;
    let dirPath = selected;

    if (st.isDirectory()) {
      dirPath = selected;
      const candidate = path.join(selected, 'SKILL.md');
      if (!fs.existsSync(candidate)) {
        return { error: '该文件夹中没有 SKILL.md' };
      }
      skillMdPath = candidate;
    } else {
      dirPath = path.dirname(selected);
      if (!selected.toLowerCase().endsWith('.md')) {
        return { error: '请选择 .md 文件（推荐 SKILL.md）' };
      }
    }

    const content = fs.readFileSync(skillMdPath, 'utf-8');
    if (!content.trim()) return { error: 'SKILL.md 为空' };

    let siblings = [];
    try {
      siblings = fs.readdirSync(dirPath)
        .filter((n) => n.toLowerCase() !== 'skill.md' && !n.startsWith('.'))
        .slice(0, 50);
    } catch { /* */ }

    return {
      path: skillMdPath,
      dir: dirPath,
      content,
      name: path.basename(dirPath),
      siblings,
    };
  } catch (err) {
    return { error: err.message || '读取失败' };
  }
}

// Pick a SKILL.md file
ipcMain.handle('iexa:pick-skill-file', async () => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const result = await dialog.showOpenDialog(win || undefined, {
    title: '选择 SKILL.md 文件',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
  return readSkillFromPath(result.filePaths[0]);
});

// Open a link from the transcript in the system browser. Only web and mail
// schemes are allowed: a model can emit any href, and handing `file:` or
// `javascript:` to the shell would escape the page's sandbox.
ipcMain.handle('iexa:open-external', async (_evt, rawUrl) => {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.length > 4096) {
    return { ok: false, error: '链接无效' };
  }
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return { ok: false, error: '链接无效' }; }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    return { ok: false, error: '只支持 http、https 与 mailto 链接' };
  }
  if (parsed.username || parsed.password) return { ok: false, error: '链接无效' };
  try {
    await shell.openExternal(parsed.href);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || '打开失败' };
  }
});

// Open a path in the OS file manager (for managing skills dir)
ipcMain.handle('iexa:open-path', async (_evt, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') {
    return { ok: false, error: '路径无效' };
  }
  try {
    const abs = path.resolve(targetPath);
    if (/^(\\\\|\\\\[?.]\\)/.test(targetPath) || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { ok: false, error: '请选择已存在的本地目录。' };
    const err = await shell.openPath(abs);
    if (err) return { ok: false, error: err };
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: e.message || '打开失败' };
  }
});

ipcMain.handle('iexa:open-file', async (_evt, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') return { ok: false, error: '路径无效' };
  try {
    const abs = path.resolve(targetPath);
    if (!fs.existsSync(abs)) return { ok: false, error: '文件不存在' };
    const error = await shell.openPath(abs);
    if (error) return { ok: false, error };
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: e.message || '打开失败' };
  }
});

const RUNNABLE_EXTENSIONS = new Set(['.bat', '.cmd', '.ps1', '.py', '.sh', '.exe', '.js', '.vbs']);

ipcMain.handle('iexa:run-file', async (_evt, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') return { ok: false, error: '路径无效' };
  try {
    const abs = path.resolve(targetPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, error: '文件不存在' };
    const ext = path.extname(abs).toLowerCase();
    if (!RUNNABLE_EXTENSIONS.has(ext)) return { ok: false, error: '该类型不支持直接运行' };
    let command = abs;
    let args = [];
    if (ext === '.ps1') { command = 'powershell.exe'; args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', abs]; }
    else if (ext === '.py') { command = 'python'; args = [abs]; }
    else if (ext === '.js') { command = 'node'; args = [abs]; }
    else if (ext === '.sh') { command = 'bash'; args = [abs]; }
    const child = spawn(command, args, {
      cwd: path.dirname(abs),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { ok: true, path: abs, pid: child.pid || null };
  } catch (e) {
    return { ok: false, error: e.message || '运行失败' };
  }
});

ipcMain.handle('iexa:reveal-path', async (_evt, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') return { ok: false, error: '路径无效' };
  try {
    const abs = path.resolve(targetPath);
    if (!fs.existsSync(abs)) return { ok: false, error: '文件不存在' };
    shell.showItemInFolder(abs);
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: e.message || '打开失败' };
  }
});

ipcMain.handle('iexa:pick-plugin-folder', async () => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const result = await dialog.showOpenDialog(win || undefined, {
    title: '选择 IEXA 插件文件夹',
    buttonLabel: '安装插件',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

// ---- Error Dialog Helper ----
function showError(title, message) {
  console.error(`[IEXA] ${title}: ${message}`);
  try {
    dialog.showErrorBox(title, message);
  } catch {
    // dialog might not be available yet
  }
}

// ---- Start the backend server ----
function startBackendServer() {
  return new Promise((resolve, reject) => {
    try {
      // Load the compiled server module
      const serverPath = path.join(__dirname, 'dist', 'main', 'server');
      console.log('[IEXA] Loading server from:', serverPath);

      const { startServer, getServerCredentials } = require(serverPath);
      startServer(PORT, false, LOOPBACK_HOST).then(async (srv) => {
        const credentials = getServerCredentials(srv);
        await session.defaultSession.cookies.set({ url: `http://${LOOPBACK_HOST}:${PORT}`, name: credentials.cookieName, value: credentials.token, path: '/', httpOnly: true, sameSite: 'strict' });
        server = srv;
        console.log('[IEXA] Backend server ready on port', PORT);
        resolve();
      }).catch((err) => {
        console.error('[IEXA] Server start error:', err.message);
        reject(new Error('Server failed to start: ' + err.message));
      });
    } catch (err) {
      console.error('[IEXA] Module load error:', err.message);
      reject(new Error('Cannot load server module: ' + err.message +
        '\n\nMake sure you have run: npm run build'));
    }
  });
}

// ---- Create Window ----
function createWindow() {
  console.log('[IEXA] Creating window...');

  const savedWindow = loadWindowState();

  mainWindow = new BrowserWindow({
    ...mainWindowChromeOptions(),
    width: savedWindow.width,
    height: savedWindow.height,
    ...(savedWindow.x !== undefined ? { x: savedWindow.x } : {}),
    ...(savedWindow.y !== undefined ? { y: savedWindow.y } : {}),
    minWidth: 800,
    minHeight: 600,
    title: 'IEXA-WIN',
    icon: path.join(__dirname, 'resources', 'icon.png'),
    backgroundColor: readJsonFile(workspaceFile('.iexa-appearance.json')).theme === 'dark' ? '#1c1c1f' : '#ffffff',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  trackWindowState(mainWindow);
  // Never shape a native caption: Windows 10 can fall back to classic chrome.
  installWindowCorners(mainWindow, { frameless: process.platform === 'win32', getFullScreen: () => isWindowFullscreen(mainWindow), getScaleFactor: () => screen.getDisplayMatching(mainWindow.getBounds()).scaleFactor });

  if (process.platform === 'win32') resizeMainWindow = createWindowResize(mainWindow, () => screen.getCursorScreenPoint());

  const publishWindowState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('iexa:window-state', mainWindowState(mainWindow));
  };
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) mainWindow.on(event, publishWindowState);
  mainWindow.webContents.on('did-finish-load', publishWindowState);

  // Remove default menu
  mainWindow.setMenuBarVisibility(false);

  // Zoom is ours: the default View menu maps zoom-in to `CommandOrControl+Plus`
  // (Shift+= on most layouts), so Ctrl+= did nothing, and its zoom-out had no
  // floor. Strip those accelerators first, then clamp the range here.
  stripZoomAccelerators(Menu);
  installZoomControls(mainWindow.webContents);

  mainWindow.once('ready-to-show', () => {
    if (!HEADLESS && savedWindow.maximized) mainWindow.maximize();
    console.log('[IEXA] Window ready, showing...');
    if (!HEADLESS) mainWindow.show();
    // Open DevTools in development
    // mainWindow.webContents.openDevTools();
  });

  const scheduleWindowStateSave = () => {
    if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = setTimeout(() => { windowStateSaveTimer = null; saveWindowState(); }, 250);
  };
  mainWindow.on('resize', scheduleWindowStateSave);
  mainWindow.on('move', scheduleWindowStateSave);
  mainWindow.on('maximize', scheduleWindowStateSave);
  mainWindow.on('unmaximize', scheduleWindowStateSave);

  // Closing the desktop window is an actual application shutdown. The
  // backend is owned by this Electron process, so hiding here would leave
  // the server running after the user believed the app was closed.
  mainWindow.on('close', (event) => {
    if (windowStateSaveTimer) { clearTimeout(windowStateSaveTimer); windowStateSaveTimer = null; }
    saveWindowState();
    if (!isQuitting) {
      isQuitting = true;
      console.log('[IEXA] Window closed, shutting down backend');
      app.quit();
    }
  });

  mainWindow.on('closed', () => {
    resizeMainWindow = null;
    mainWindow = null;
  });

  // Open external links in system browser
  secureNavigation(mainWindow, ['/', '/index.html']);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin === `http://${LOOPBACK_HOST}:${PORT}` && (parsed.pathname.startsWith('/api/fs/preview/') || parsed.pathname === '/api/fs/raw')) {
        return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: undefined } } };
      }
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) void shell.openExternal(parsed.href);
    } catch {}
    return { action: 'deny' };
  });

  // Handle page load errors
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[IEXA] Page load failed:', errorDescription);
  });

  const url = `http://${LOOPBACK_HOST}:${PORT}`;
  console.log('[IEXA] Loading URL:', url);
  mainWindow.loadURL(url);
}

// ---- Wait for server to be ready ----
function waitForServer(retries = 20) {
  return new Promise((resolve, reject) => {
    function check(remaining) {
      http.get(`http://${LOOPBACK_HOST}:${PORT}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry(remaining);
        }
      }).on('error', () => {
        retry(remaining);
      });
    }

    function retry(remaining) {
      if (remaining <= 0) {
        reject(new Error('Server did not start in time'));
      } else {
        setTimeout(() => check(remaining - 1), 300);
      }
    }

    check(retries);
  });
}

// ---- System Tray ----
function createTray() {
  // Find tray icon: try resources/tray-icon.png, then icon.png, then create fallback
  let trayIconPath = path.join(__dirname, 'resources', 'tray-icon.png');
  if (!fs.existsSync(trayIconPath)) {
    trayIconPath = path.join(__dirname, 'resources', 'icon.png');
  }

  let trayIcon;
  if (fs.existsSync(trayIconPath)) {
    trayIcon = nativeImage.createFromPath(trayIconPath);
    // Resize to 16x16 for proper tray display
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  } else {
    // Fallback: create a simple 16x16 icon programmatically
    console.log('[IEXA] No tray icon found, using fallback');
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('IEXA-WIN');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示 IEXA',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: '检查更新',
      click: () => { void runUpdateAction(); },
    },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);

  // Click tray icon to toggle window
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  console.log('[IEXA] System tray created');
}

// ---- Auto update ----
async function runUpdateAction() {
  try {
    if (!updateService) {
      await dialog.showMessageBox({ type: 'info', message: '更新服务未就绪。' });
      return;
    }
    const state = updateService.getState();
    if (state.status === 'disabled') {
      await dialog.showMessageBox({ type: 'info', message: '当前为开发模式（未打包），不检查更新。' });
      return;
    }
    if (state.status === 'downloaded') {
      const { response } = await dialog.showMessageBox({
        type: 'info', buttons: ['立即重启', '稍后'], defaultId: 0, cancelId: 1,
        message: `更新 ${state.version || ''} 已下载，重启后生效。`,
      });
      if (response === 0) updateService.install();
      return;
    }
    if (state.status === 'available') {
      const { response } = await dialog.showMessageBox({
        type: 'info', buttons: ['下载', '取消'], defaultId: 0, cancelId: 1,
        message: `发现新版本 ${state.version || ''}，是否现在下载？`,
      });
      if (response === 0) {
        try { await updateService.download(); }
        catch (error) { showError('更新下载失败', error.message || String(error)); }
      }
      return;
    }
    await updateService.check();
    const next = updateService.getState();
    if (next.status === 'not-available') await dialog.showMessageBox({ type: 'info', message: '已是最新版本。' });
    else if (next.status === 'error') showError('检查更新失败', next.message || '未知错误');
  } catch (error) {
    showError('检查更新失败', error.message || String(error));
  }
}

function createUpdateService() {
  try {
    updateService = new UpdateService({
      adapter: autoUpdater,
      enabled: app.isPackaged,
      currentVersion: app.getVersion(),
      onStatus: (event) => {
        try {
          if (tray) tray.setToolTip(event.status === 'downloaded' ? `IEXA-WIN — 更新 ${event.version || ''} 就绪` : 'IEXA-WIN');
        } catch { /* tray may already be gone */ }
        try { mainWindow?.webContents.send('update-status', event); } catch { /* renderer may be gone */ }
      },
    });
    if (app.isPackaged) { try { autoUpdater.logger = console; } catch { /* optional */ } }
    updateService.start();
  } catch (error) {
    console.error('[IEXA] Update service unavailable:', error.message || error);
    updateService = null;
  }
}

// ---- Screen capture ----
// Chromium's own picker is not available in Electron: getDisplayMedia rejects
// unless the main process supplies a source. This shows a small picker with the
// available screens and windows, then hands the chosen source back.
let capturePickerOpen = false;

function pickCaptureSource() {
  return new Promise((resolve) => {
    if (capturePickerOpen) { resolve(null); return; }
    capturePickerOpen = true;

    let sources = [];
    let settled = false;
    let picker = null;

    const finish = (source) => {
      if (settled) return;
      settled = true;
      capturePickerOpen = false;
      ipcMain.removeListener('iexa:capture-choose', onChoose);
      ipcMain.removeListener('iexa:capture-cancel', onCancel);
      if (picker && !picker.isDestroyed()) picker.destroy();
      resolve(source || null);
    };
    const onChoose = (_event, id) => finish(sources.find((item) => item.id === String(id)) || null);
    const onCancel = () => finish(null);

    ipcMain.on('iexa:capture-choose', onChoose);
    ipcMain.on('iexa:capture-cancel', onCancel);

    desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    }).then((list) => {
      if (settled) return;
      sources = list;
      if (!sources.length) { finish(null); return; }

      picker = new BrowserWindow({
        width: 760,
        height: 560,
        minWidth: 520,
        minHeight: 380,
        parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
        modal: true,
        show: false,
        title: '选择要截图的画面',
        backgroundColor: '#14161c',
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          preload: path.join(__dirname, 'resources', 'capture-picker-preload.js'),
        },
      });
      picker.setMenuBarVisibility(false);
      picker.on('closed', () => finish(null));
      picker.once('ready-to-show', () => { if (!picker.isDestroyed()) picker.show(); });
      // ipcMain.handle is refused for file:// senders ("Untrusted IPC sender"),
      // so the list is injected once the page scripts are in place.
      picker.webContents.on('did-finish-load', () => {
        if (!picker || picker.isDestroyed()) return;
        const payload = sources.map((item) => ({
          id: item.id,
          name: item.name || (item.id.startsWith('screen:') ? '屏幕' : '窗口'),
          kind: item.id.startsWith('screen:') ? 'screen' : 'window',
          thumbnail: item.thumbnail && !item.thumbnail.isEmpty() ? item.thumbnail.toDataURL() : '',
        }));
        picker.webContents.executeJavaScript(`window.__setSources(${JSON.stringify(payload)}); true`).catch(() => {});
      });
      picker.loadFile(path.join(__dirname, 'resources', 'capture-picker.html'));
    }).catch(() => finish(null));
  });
}

function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    // The callback is one-shot: a cancel plus a window close must not answer twice.
    let answered = false;
    const answer = (payload) => {
      if (answered) return;
      answered = true;
      try { callback(payload); } catch { /* request already gone */ }
    };
    try {
      const source = await pickCaptureSource();
      answer(source ? { video: source } : {});
    } catch {
      answer({});
    }
  }, { useSystemPicker: false });
}

// ---- App Lifecycle ----
// Scope Chromium cookies/cache to the same explicit workspace as the backend.
ensureInstanceWorkspace();
const profileDirectory = path.join(process.env.IEXA_WORKSPACE, '.iexa-electron-profile');
fs.mkdirSync(profileDirectory, { recursive: true });
app.setPath('userData', profileDirectory);
app.whenReady().then(async () => {
  console.log('[IEXA] Electron app starting...');
  console.log('[IEXA] App dir:', __dirname);

  try {
    // Each instance gets its own workspace (sessions/memory/settings)
    ensureInstanceWorkspace();

    // Dynamically allocate a free port
    PORT = await findFreePort();
    console.log('[IEXA] Allocated port:', PORT);

    await startBackendServer();
    await waitForServer();
    installDisplayMediaHandler();
    createWindow();
    installPetHost();
    if (!HEADLESS) createTray();
    createUpdateService();
    console.log('[IEXA] App ready!');
  } catch (err) {
    console.error('[IEXA] Startup failed:', err.message);
    showError('IEXA - 启动失败',
      'IEXA 启动失败。\n\n' + err.message +
      '\n\n请先运行：\n  npm run build' +
      '\n\n然后重新执行：\n  start-electron.bat');
    app.quit();
  }
});

app.on('window-all-closed', () => {
  isQuitting = true;
  app.quit();
  console.log('[IEXA] All windows closed, shutting down');
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  console.log('[IEXA] Shutting down...');
  // Release owned native helpers before async HTTP shutdown (open sockets may delay close).
  try { require('./dist/main/tools/desktop/DesktopHelperLifetime').closeDesktopHelpers(); }
  catch (error) { console.error('[IEXA] Desktop helper shutdown:', error.message); }
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (server) {
    server.close();
    server = null;
  }
});

// Log unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[IEXA] Uncaught exception:', err);
});
