// main.cjs · SynapseHub 主进程
//
// 职责边界：编排（起停）、观测（状态/日志）、审批（转给桥接）、体检（首启向导）。
// 不承载业务逻辑 —— 业务都留在 bridge / panel / qzone 里，Hub 只是"看得见、按得动"。

const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 启动追踪：打包后如果窗口没出现，唯一的线索就是"停在哪一步"。
// 用 SYNAPSE_HUB_TRACE=1 启动，日志写到系统临时目录的 synapse-hub-trace.log。
// 正常使用不产生任何文件。
const TRACE_FILE = path.join(require('node:os').tmpdir(), 'synapse-hub-trace.log');
function trace(msg) {
  if (!process.env.SYNAPSE_HUB_TRACE) return;
  try { fs.appendFileSync(TRACE_FILE, `${new Date().toISOString()} [${process.pid}] ${msg}\n`); } catch {}
}
trace(`main.cjs 开始加载 | electron=${process.versions.electron} node=${process.versions.node} | execPath=${process.execPath} | resourcesPath=${process.resourcesPath}`);

// ── 数据根（必须在这里定，早于任何 paths 加载）────────────────────────────────
// 打包后 paths 的自动探测会失效：asar 内 packages 位于 resources/packages，
// 往上两级是 resources，既没有 apps/ 也没有 app/，于是 HOME 会落到安装目录甚至
// portable 的临时解压目录（重启即丢）。所以由主进程显式指定，子进程继承环境变量。
//
//   portable 版：PORTABLE_EXECUTABLE_DIR = 用户双击的那个 exe 所在目录 → 数据留在旁边，真便携
//   安装版：%APPDATA%\SynapseHub
//   源码运行：不设置，交给 paths 探测（仓库根）
if (!process.env.SYNAPSE_HOME) {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) process.env.SYNAPSE_HOME = portableDir;
  else if (app.isPackaged) process.env.SYNAPSE_HOME = app.getPath('userData');
}
trace(`SYNAPSE_HOME=${process.env.SYNAPSE_HOME || '(未设置，由 paths 探测)'}`);

const { Supervisor } = require('./services.cjs');
const bridgeConsole = require('./bridge-console.cjs');
const firstrun = require('./firstrun.cjs');
const { loadPaths } = require('./resolve-packages.cjs');
trace('本地模块 require 完成');

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
  const entry = path.join(__dirname, 'renderer', 'index.html');
  trace(`创建窗口，入口=${entry} 存在=${fs.existsSync(entry)}`);
  win.loadFile(entry).then(() => trace('loadFile 完成'))
    .catch((e) => trace(`loadFile 失败：${e && e.message}`));
  win.webContents.on('did-fail-load', (_e, code, desc) => trace(`did-fail-load ${code} ${desc}`));
  win.on('closed', () => { win = null; });
  win.once('show', () => trace('窗口已显示'));
  win.once('hide', () => trace('窗口被隐藏'));
  setTimeout(() => {
    try { trace(`窗口状态 可见=${win.isVisible()} 最小化=${win.isMinimized()} bounds=${JSON.stringify(win.getBounds())}`); } catch {}
  }, 3000);

  // 点 X 不退出：隐藏到托盘，服务继续跑。
  // 为什么不是真退出：桥接/面板是 Hub 用非 detached 方式拉起的子进程，stdout 走管道；
  // Hub 一退出管道断开，子进程下一次写日志就会 EPIPE 崩溃 —— 表面"退出控制台"，
  // 实际把机器人弄死了。所以"关闭"只能是隐藏。
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
    if (!hideHinted && tray) {
      hideHinted = true;
      try {
        tray.displayBalloon({
          title: 'Synapse 3 控制台已缩到托盘',
          content: '机器人和面板仍在后台运行。要彻底停止，右键托盘图标选择「退出并停止服务」。',
          noSound: true,
        });
      } catch { /* 某些系统不支持气泡，忽略 */ }
    }
  });
}

// ── 托盘常驻 ───────────────────────────────────────────────────────────────

let tray = null;
let isQuitting = false;
let hideHinted = false;

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function trayIcon() {
  const file = path.join(__dirname, 'assets', 'tray.png');
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) {
    // asar 内读不到时的兜底：同一张图的 16x16 内联版，保证托盘不会是个空白方块
    img = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVQ4y2Ng'
      + 'GAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AU'
      + 'jIJRMApGwSgYBaNgFIyCUTAKRsEoAAB2nAH/EQ0mQwAAAABJRU5ErkJggg==');
  }
  return img;
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
  } catch (e) {
    trace(`托盘创建失败：${e && e.message}（关窗将直接退出）`);
    return;
  }
  tray.setToolTip('Synapse 3 控制台 · 服务在后台运行');
  const menu = Menu.buildFromTemplate([
    { label: '显示控制台', click: showWindow },
    { label: '打开数据面板', click: () => { shell.openExternal('http://127.0.0.1:3120/ui/').catch(() => {}); } },
    { type: 'separator' },
    { label: '关闭窗口后服务继续在后台运行', enabled: false },
    { type: 'separator' },
    { label: '退出并停止服务', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  trace('托盘已创建');
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
  const p = await loadPaths();
  return { home: p.HOME, layout: p.describe().layout, bridge: p.BRIDGE_ROOT, data: p.DATA, config: p.CONFIG };
});
ipcMain.handle('hub:reveal', async (_e, which) => {
  const p = await loadPaths();
  const map = { home: p.HOME, data: p.DATA, config: p.CONFIG, logs: p.LOGS, bridge: p.BRIDGE_ROOT };
  const target = map[which];
  if (!target) throw new Error('未知位置');
  if (!fs.existsSync(target)) throw new Error(`目录不存在：${target}`);
  shell.openPath(target);
  return { ok: true };
});

// ── 生命周期 ───────────────────────────────────────────────────────────────

trace('准备请求单实例锁');
const gotLock = app.requestSingleInstanceLock();
trace(`单实例锁：${gotLock}`);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    trace('whenReady 触发');
    Menu.setApplicationMenu(null);
    createTray();
    createWindow();
    trace(`createWindow 返回，win=${win ? 'ok' : 'null'}`);
    try { await bootSupervisor(); } catch (e) { pushLog({ id: 'hub', stream: 'hub', line: `编排初始化失败：${e.message}` }); }
    if (win && !win.isDestroyed()) {
      win.webContents.send('hub:services', sup ? sup.snapshot() : []);
    }
  });

  // 有托盘时窗口全关也不退出（托盘还在，服务还要继续跑）；托盘创建失败才回落到旧行为。
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });

  // 只有真正退出（托盘菜单 / 系统关机）才停服务。
  app.on('before-quit', () => {
    isQuitting = true;
    if (pollTimer) clearInterval(pollTimer);
    if (sup) sup.stopAll();
    if (tray) { try { tray.destroy(); } catch {} tray = null; }
  });
}

process.on('uncaughtException', (e) => {
  pushLog({ id: 'hub', stream: 'hub', line: `未捕获异常：${e.stack || e.message}` });
  try { dialog.showErrorBox('SynapseHub 出错', String(e.message || e)); } catch {}
});
