// main.cjs · SynapseHub 主进程
//
// 职责边界：编排（起停）、观测（状态/日志）、审批（转给桥接）、体检（首启向导）。
// 不承载业务逻辑 —— 业务都留在 bridge / panel / qzone 里，Hub 只是"看得见、按得动"。

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { Supervisor } = require('./services.cjs');
const bridgeConsole = require('./bridge-console.cjs');
const firstrun = require('./firstrun.cjs');

let win = null;
let sup = null;
let pollTimer = null;
const logs = [];            // { at, id, stream, line }
const LOG_MAX = 4000;

function pushLog(entry) {
  const rec = { at: Date.now(), ...entry };
  logs.push(rec);
  if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX);
  if (win && !win.isDestroyed()) win.webContents.send('hub:log', rec);
}

async function bootSupervisor() {
  sup = new Supervisor({ onLog: pushLog });
  await sup.init();
  await sup.refresh();

  // 只自动拉起"上次是运行状态"的服务？首版保持不自动启动，避免与用户现有启动方式打架。
  // P2 切换后再开启自动启动。
  pollTimer = setInterval(async () => {
    try {
      const snap = await sup.refresh();
      if (win && !win.isDestroyed()) win.webContents.send('hub:services', snap);
    } catch (e) { /* 探测失败不应该拖垮界面 */ }
  }, 3000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f6f5f2',
    title: 'Synapse 3 控制台',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

// ── IPC ────────────────────────────────────────────────────────────────────

ipcMain.handle('hub:services', async () => (sup ? await sup.refresh() : []));
ipcMain.handle('hub:start', async (_e, id) => sup.start(id));
ipcMain.handle('hub:stop', async (_e, id) => sup.stop(id));
ipcMain.handle('hub:restart', async (_e, id) => sup.restart(id));

ipcMain.handle('hub:pending', async () => bridgeConsole.pending());
ipcMain.handle('hub:answer', async (_e, { key, text }) => bridgeConsole.answer(key, text));
ipcMain.handle('hub:bridgeStatus', async () => bridgeConsole.status());

ipcMain.handle('hub:firstrun', async () => firstrun.run());
ipcMain.handle('hub:logs', async (_e, filter) => {
  const id = filter?.id;
  return logs.filter((l) => !id || l.id === id).slice(-500);
});

ipcMain.handle('hub:openPanel', async () => {
  await shell.openExternal('http://127.0.0.1:3120/ui/');
  return { ok: true };
});
ipcMain.handle('hub:openExternal', async (_e, url) => {
  if (!/^https?:\/\//i.test(String(url))) throw new Error('只允许 http/https');
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('hub:paths', async () => {
  const p = await import('../../packages/paths/index.mjs');
  return { home: p.HOME, layout: p.describe().layout, bridge: p.BRIDGE_ROOT, data: p.DATA, config: p.CONFIG };
});
ipcMain.handle('hub:reveal', async (_e, which) => {
  const p = await import('../../packages/paths/index.mjs');
  const map = { home: p.HOME, data: p.DATA, config: p.CONFIG, logs: p.LOGS, bridge: p.BRIDGE_ROOT };
  const target = map[which];
  if (!target) throw new Error('未知位置');
  if (!fs.existsSync(target)) throw new Error(`目录不存在：${target}`);
  shell.openPath(target);
  return { ok: true };
});

// ── 生命周期 ───────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    createWindow();
    try { await bootSupervisor(); } catch (e) { pushLog({ id: 'hub', stream: 'hub', line: `编排初始化失败：${e.message}` }); }
    if (win && !win.isDestroyed()) {
      win.webContents.send('hub:services', sup ? sup.snapshot() : []);
    }
  });

  app.on('window-all-closed', () => { /* 托盘常驻语义：关窗不退出，交由托盘/菜单退出 */ app.quit(); });

  app.on('before-quit', () => {
    if (pollTimer) clearInterval(pollTimer);
    if (sup) sup.stopAll();
  });
}

process.on('uncaughtException', (e) => {
  pushLog({ id: 'hub', stream: 'hub', line: `未捕获异常：${e.stack || e.message}` });
  try { dialog.showErrorBox('SynapseHub 出错', String(e.message || e)); } catch {}
});
