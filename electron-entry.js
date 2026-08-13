// =============================================================================
// IEXA PC - Electron Main Entry
// Native desktop window using the local agent server
// =============================================================================

const { app, BrowserWindow, shell, dialog, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const net = require('net');

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

let PORT = null;
let mainWindow = null;
let server = null;
let tray = null;
let isQuitting = false;

// ---- Per-instance workspace ----
// Each window is its own agent instance. Give it a unique workspace so
// sessions / memory / settings never collide across concurrent windows.
function ensureInstanceWorkspace() {
  if (process.env.IEXA_WORKSPACE) return; // caller explicitly set it
  const base = path.join(__dirname, 'workspace');
  process.env.IEXA_WORKSPACE = base;
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

// Open a path in the OS file manager (for managing skills dir)
ipcMain.handle('iexa:open-path', async (_evt, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') {
    return { ok: false, error: '路径无效' };
  }
  try {
    const abs = path.resolve(targetPath);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
    }
    const err = await shell.openPath(abs);
    if (err) return { ok: false, error: err };
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: e.message || '打开失败' };
  }
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

      const { startServer } = require(serverPath);
      startServer(PORT, false).then((srv) => {
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

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'IEXA-WIN',
    icon: path.join(__dirname, 'resources', 'icon.png'),
    backgroundColor: '#1a1a2e',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Remove default menu
  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    console.log('[IEXA] Window ready, showing...');
    mainWindow.show();
    // Open DevTools in development
    // mainWindow.webContents.openDevTools();
  });

  // Closing the desktop window is an actual application shutdown. The
  // backend is owned by this Electron process, so hiding here would leave
  // the server running after the user believed the app was closed.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      isQuitting = true;
      console.log('[IEXA] Window closed, shutting down backend');
      app.quit();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost:' + PORT) || url.startsWith('file://')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle page load errors
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[IEXA] Page load failed:', errorDescription);
  });

  const url = `http://localhost:${PORT}`;
  console.log('[IEXA] Loading URL:', url);
  mainWindow.loadURL(url);
}

// ---- Wait for server to be ready ----
function waitForServer(retries = 20) {
  return new Promise((resolve, reject) => {
    function check(remaining) {
      http.get(`http://localhost:${PORT}/`, (res) => {
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

// ---- App Lifecycle ----
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
    createWindow();
    createTray();
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