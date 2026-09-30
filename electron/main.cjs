'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, safeStorage, nativeTheme, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Storage, atomicWrite } = require('./storage.cjs');
const { streamChat, validateMessages, validateModel, validateThinking, validateHarnessUrl } = require('./chat-client.cjs');
const { createHarnessManager } = require('./harness-manager.cjs');
const { prepareHarnessLaunch } = require('./harness-connections.cjs');
const { configureAppIdentity } = require('./app-identity.cjs');
const { createHarnessUpdater } = require('./harness-updater.cjs');
const { acquireInstallationLock } = require('./harness-installation-lock.cjs');
const { createHarnessRuntimeValidator } = require('./harness-runtime-validator.cjs');

const rendererFile = path.join(__dirname, '..', 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererFile).href;
const activeRequests = new Map();
let mainWindow;
let storage;
let harness;
let harnessUpdater;
let harnessInstallationLock;
let harnessOperation = false;
let harnessView = null;
let mode = 'chat';
let harnessVisible = true;
let harnessBounds = { x: 260, y: 56, width: 900, height: 680 };
let harnessGeneration = 0;
let quitStarted = false;
let quitReady = false;
let closeAllowed = false;
let closeTimer = null;

function publicError(error, fallback) {
  if (typeof error?.message === 'string' && /[\u4e00-\u9fff]/.test(error.message)) return error.message.slice(0, 400);
  return fallback;
}

function trustedFrame(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  return event.senderFrame.url.split(/[?#]/, 1)[0] === rendererUrl;
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedFrame(event)) throw new Error('不允许的应用调用。');
    try { return await callback(event, ...args); }
    catch (error) { throw new Error(publicError(error, '操作未完成，请稍后重试。')); }
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function allowedExternal(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    if (['deepseek.com', 'www.deepseek.com', 'api.deepseek.com', 'api-docs.deepseek.com', 'platform.deepseek.com', 'chat.deepseek.com'].includes(url.hostname)) return true;
    return url.hostname === 'github.com' && (url.pathname === '/deepseek-ai' || url.pathname.startsWith('/deepseek-ai/'));
  } catch { return false; }
}

function lockSession(session) {
  const allowClipboardWrite = (contents, permission, details) => {
    if (permission !== 'clipboard-sanitized-write' || !details?.isMainFrame || !contents || contents.isDestroyed() || !contents.isFocused()) return false;
    return Boolean((mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents)
      || (harnessView && contents === harnessView.webContents));
  };
  session.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowClipboardWrite(contents, permission, details)));
  session.setPermissionCheckHandler((contents, permission, _origin, details) => allowClipboardWrite(contents, permission, details));
}

function updateHarnessBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !harnessView) return;
  const [windowWidth, windowHeight] = mainWindow.getContentSize();
  const x = Math.max(0, Math.min(windowWidth, Math.round(harnessBounds.x)));
  const y = Math.max(0, Math.min(windowHeight, Math.round(harnessBounds.y)));
  const width = Math.max(0, Math.min(windowWidth - x, Math.round(harnessBounds.width)));
  const height = Math.max(0, Math.min(windowHeight - y, Math.round(harnessBounds.height)));
  harnessView.setBounds({ x, y, width, height });
  harnessView.setVisible(mode === 'codex' && harnessVisible && width > 0 && height > 0);
}

function removeHarnessView() {
  if (!harnessView) return;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(harnessView);
  if (!harnessView.webContents.isDestroyed()) harnessView.webContents.close();
  harnessView = null;
}

async function loadHarness(url) {
  const validated = validateHarnessUrl(url);
  const origin = new URL(validated).origin;
  removeHarnessView();
  const view = new WebContentsView({ webPreferences: {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    partition: 'persist:deepseek-harness',
  } });
  harnessView = view;
  lockSession(view.webContents.session);
  view.webContents.setWindowOpenHandler(({ url: destination }) => {
    if (allowedExternal(destination)) shell.openExternal(destination).catch(() => {});
    return { action: 'deny' };
  });
  const guardNavigation = (event, destination) => {
    try { if (new URL(destination).origin === origin) return; } catch { /* deny */ }
    event.preventDefault();
  };
  view.webContents.on('will-navigate', guardNavigation);
  view.webContents.on('will-redirect', guardNavigation);
  view.webContents.on('will-attach-webview', (event) => event.preventDefault());
  view.webContents.on('render-process-gone', () => {
    if (harnessView === view) send('desktop:harness-status', { ...harness.getStatus(), state: 'error', message: 'Harness 页面已退出，请重新连接。' });
  });
  mainWindow.contentView.addChildView(view);
  updateHarnessBounds();
  try { await view.webContents.loadURL(validated); }
  catch {
    if (harnessView === view) removeHarnessView();
    throw new Error('Harness 已启动，但页面加载失败。请重新连接。');
  }
}

function createCurrentHarnessManager() {
  harness = createHarnessManager({
    ...harnessUpdater.getRuntime(),
    dataDir: app.getPath('userData'),
    prepareLaunch: () => prepareHarnessLaunch(storage, app.getPath('userData')),
    onStatus: status => {
      if (status.state === 'stopped' || status.state === 'error') removeHarnessView();
      send('desktop:harness-status', status);
    },
  });
  send('desktop:harness-status', harness.getStatus());
}

async function changeHarnessRuntime(operation) {
  if (harnessOperation || harnessUpdater.getStatus().busy) throw new Error('Harness 更新正在进行，请稍候。');
  if (harness.isActive()) throw new Error('请先结束任务并停止 Harness 引擎，再更新。');
  harnessOperation = true;
  harnessGeneration += 1;
  try {
    const result = await operation();
    if (!quitStarted) createCurrentHarnessManager();
    return result;
  } finally { harnessOperation = false; }
}

function wireIPC() {
  handle('desktop:harness-update-status', () => harnessUpdater.getStatus());
  handle('desktop:harness-check-update', () => harnessUpdater.check());
  handle('desktop:harness-update', () => changeHarnessRuntime(() => harnessUpdater.update()));
  handle('desktop:harness-cancel-update', () => harnessUpdater.cancel());
  handle('desktop:get-settings', () => storage.publicSettings());
  handle('desktop:refresh-models', () => storage.refreshModels());
  handle('desktop:save-settings', async (_event, settings) => {
    const saved = await storage.saveSettings(settings);
    nativeTheme.themeSource = saved.theme;
    return saved;
  });
  handle('desktop:get-history', () => storage.getHistory());
  handle('desktop:save-history', (_event, sessions) => storage.saveHistory(sessions));
  handle('desktop:export-history', async (_event, payload) => {
    if (!payload || typeof payload.content !== 'string' || Buffer.byteLength(payload.content, 'utf8') > 30 * 1024 * 1024) throw new Error('导出内容无效或超过 30 MB。');
    let filename = typeof payload.filename === 'string' ? path.basename(payload.filename) : 'DeepSeek-对话.md';
    filename = filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180);
    if (!filename.toLowerCase().endsWith('.md')) filename += '.md';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出对话',
      defaultPath: path.join(app.getPath('documents'), filename),
      filters: [{ name: 'Markdown 文档', extensions: ['md'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await atomicWrite(result.filePath, payload.content);
    return { saved: true, path: result.filePath };
  });
  handle('desktop:finish-close', async () => {
    if (!closeTimer) return { closed: false };
    await storage.queue;
    clearTimeout(closeTimer);
    closeTimer = null;
    closeAllowed = true;
    // Let the invoke response reach the renderer before destroying its frame.
    setImmediate(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); });
    return { closed: true };
  });
  handle('desktop:choose-workspace', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Harness 项目文件夹',
      defaultPath: storage.settings.workspace || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    await storage.saveSettings({ workspace: result.filePaths[0] });
    return result.filePaths[0];
  });
  handle('desktop:chat', (event, request) => {
    if (!request || typeof request.requestId !== 'string' || !/^[\w-]{1,128}$/.test(request.requestId)) throw new Error('请求标识无效。');
    if (activeRequests.has(request.requestId)) throw new Error('此请求已经在运行。');
    if (activeRequests.size >= 4) throw new Error('已有多个回复正在生成，请稍后再试。');
    const requestedModel = validateModel(request.model || storage.settings.model);
    const {apiKey,model,baseUrl,apiProtocol,modelProfiles} = storage.getChatConnection(requestedModel);
    const thinking = validateThinking(request.thinking === undefined ? storage.settings.thinking : request.thinking);
    const messages = validateMessages(request.messages);
    const controller = new AbortController();
    const entry = { owner: event.sender.id, controller, cancelled: false };
    activeRequests.set(request.requestId, entry);
    const emit = (payload) => {
      if (activeRequests.get(request.requestId) !== entry) return;
      send('desktop:chat-event', { requestId: request.requestId, ...payload });
    };
    setImmediate(async () => {
      const timeout = setTimeout(() => controller.abort(new Error('timeout')), 10 * 60 * 1000);
      try {
        await streamChat({ baseUrl, apiKey, model, thinking, apiProtocol, modelProfiles, messages, signal: controller.signal, onEvent: emit });
        emit({ type: 'done' });
      } catch (error) {
        if (entry.cancelled) emit({ type: 'done', cancelled: true });
        else if (controller.signal.aborted) emit({ type: 'error', text: '请求超时，请重试。' });
        else emit({ type: 'error', text: publicError(error, '连接模型服务失败，请检查网络和 API 地址。') });
      } finally {
        clearTimeout(timeout);
        if (activeRequests.get(request.requestId) === entry) activeRequests.delete(request.requestId);
      }
    });
    return { started: true, requestId: request.requestId };
  });
  handle('desktop:cancel-chat', (event, requestId) => {
    const entry = activeRequests.get(requestId);
    if (!entry || entry.owner !== event.sender.id) return { cancelled: false };
    entry.cancelled = true;
    entry.controller.abort();
    return { cancelled: true };
  });
  handle('desktop:window-control', (_event, action) => {
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    else if (action === 'close') mainWindow.close();
    else throw new Error('窗口操作无效。');
    return { ok: true };
  });
  handle('desktop:open-external', async (_event, url) => {
    if (!allowedExternal(url)) throw new Error('仅允许打开 DeepSeek 官方页面和官方 GitHub 仓库。');
    await shell.openExternal(url);
    return { opened: true };
  });
  handle('desktop:set-mode', (_event, nextMode) => {
    if (!['chat', 'codex'].includes(nextMode)) throw new Error('模式无效。');
    mode = nextMode;
    updateHarnessBounds();
    // Keep keyboard input with the visible workspace when native views switch.
    if (mode === 'chat') mainWindow.webContents.focus();
    else if (harnessView?.getVisible()) harnessView.webContents.focus();
    return { mode };
  });
  handle('desktop:set-harness-visible', (_event, visible) => {
    if (typeof visible !== 'boolean') throw new Error('显示参数无效。');
    const wasVisible = Boolean(harnessView?.getVisible());
    harnessVisible = visible;
    updateHarnessBounds();
    const nowVisible = Boolean(harnessView?.getVisible());
    if (nowVisible && !wasVisible) harnessView.webContents.focus();
    else if (wasVisible && !nowVisible) mainWindow.webContents.focus();
    return { visible: nowVisible };
  });
  handle('desktop:set-harness-bounds', (_event, bounds) => {
    if (!bounds || ['x', 'y', 'width', 'height'].some((key) => typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key]) || Math.abs(bounds[key]) > 100000)) throw new Error('页面尺寸无效。');
    harnessBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    updateHarnessBounds();
    return { ok: true };
  });
  handle('desktop:connect-harness', async () => {
    if (harnessOperation || harnessUpdater.getStatus().busy) throw new Error('请等待 Harness 更新完成，或先取消更新。');
    if (!storage.settings.workspace) throw new Error('请先选择 Harness 项目文件夹。');
    const generation = ++harnessGeneration;
    try {
      const result = await harness.start({ workspace: storage.settings.workspace });
      if (generation !== harnessGeneration) return { connected: false };
      await loadHarness(result.url);
      if (generation !== harnessGeneration) return { connected: false };
      const status = harness.getStatus();
      send('desktop:harness-status', status);
      return { connected: true, ...status };
    } catch (error) {
      if (generation !== harnessGeneration) return { connected: false };
      const message = publicError(error, 'Harness 启动失败，请检查运行环境。');
      send('desktop:harness-status', { ...harness.getStatus(), state: 'error', message });
      throw new Error(message);
    }
  });
  handle('desktop:disconnect-harness', async () => {
    harnessGeneration += 1;
    removeHarnessView();
    await harness.stop();
    return { disconnected: true };
  });
}

function createWindow() {
  closeAllowed = false;
  mainWindow = new BrowserWindow({
    title: 'DeepSeek',
    icon: path.join(__dirname, '..', 'renderer', 'icon.ico'),
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: '#f8f9fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  if (process.platform === 'win32') {
    // Resolve taskbar branding explicitly: legacy shortcuts can share this
    // AppUserModelID while pointing to a removed installation.
    mainWindow.setAppDetails({
      appId: 'studio.deepseek.personal',
      appIconPath: app.isPackaged ? process.execPath : path.join(__dirname, '..', 'renderer', 'icon.ico'),
      appIconIndex: 0,
      relaunchCommand: app.isPackaged ? '\"' + process.execPath + '\"' : '\"' + process.execPath + '\" \"' + app.getAppPath() + '\"',
      relaunchDisplayName: 'DeepSeek',
    });
  }
  mainWindow.setMenu(null);
  lockSession(mainWindow.webContents.session);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url.split(/[?#]/, 1)[0] !== rendererUrl) event.preventDefault(); });
  mainWindow.webContents.on('will-redirect', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      for (const entry of activeRequests.values()) { entry.cancelled = true; entry.controller.abort(); }
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    send('desktop:harness-status', harness.getStatus());
    send('desktop:harness-update-event', harnessUpdater.getStatus());
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('resize', updateHarnessBounds);
  mainWindow.on('close', (event) => {
    if (closeAllowed || mainWindow.webContents.isDestroyed()) return;
    event.preventDefault();
    if (closeTimer) return;
    send('desktop:before-close', {});
    // The renderer flushes its current conversation snapshot before acknowledging.
    // A crashed/unresponsive UI must still be closable without leaving processes behind.
    closeTimer = setTimeout(async () => {
      await storage.queue;
      closeTimer = null;
      closeAllowed = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    }, 10000);
  });
  mainWindow.on('closed', () => {
    clearTimeout(closeTimer);
    closeTimer = null;
    removeHarnessView();
    mainWindow = null;
    for (const entry of activeRequests.values()) { entry.cancelled = true; entry.controller.abort(); }
  });
  mainWindow.loadFile(rendererFile).catch(() => dialog.showErrorBox('启动失败', '无法加载桌面界面，请重新安装应用。'));
}

configureAppIdentity(app);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('studio.deepseek.personal');
    storage = new Storage(app.getPath('userData'), safeStorage);
    await storage.initialize();
    nativeTheme.themeSource = storage.settings.theme;
    const bundledRuntimeRoot = path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'), 'runtime');
    if (app.isPackaged) harnessInstallationLock = await acquireInstallationLock(bundledRuntimeRoot);
    harnessUpdater = createHarnessUpdater({
      bundledRuntimeRoot,
      installedRuntime: app.isPackaged,
      dataDir: app.getPath('userData'),
      fetchImpl: (url, options) => net.fetch(url, options),
      isHarnessStopped: () => !harness?.isActive(),
      onStatus: status => send('desktop:harness-update-event', status),
      validateCandidate: createHarnessRuntimeValidator({
        smokeScript: app.isPackaged ? path.join(process.resourcesPath, 'support/harness-runtime-check.cjs') : path.join(__dirname, 'harness-runtime-check.cjs'),
      }),
    });
    await harnessUpdater.initialize();
    createCurrentHarnessManager();
    wireIPC();
    createWindow();
  }).catch((error) => {
    dialog.showErrorBox('启动失败', publicError(error, '应用无法启动，请重新安装后重试。'));
    app.quit();
  });
  app.on('will-quit', () => { void harnessInstallationLock?.release(); });
  app.on('activate', () => { if (!mainWindow && storage && harness) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', (event) => {
    if (quitReady || !harness) return;
    event.preventDefault();
    if (quitStarted) return;
    quitStarted = true;
    for (const entry of activeRequests.values()) { entry.cancelled = true; entry.controller.abort(); }
    removeHarnessView();
    Promise.allSettled([harness.stop(), harnessUpdater.shutdown(), storage.queue]).finally(() => { quitReady = true; app.quit(); });
  });
}
