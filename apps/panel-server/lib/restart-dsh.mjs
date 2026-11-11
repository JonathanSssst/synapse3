// Synapse 3 面板后端 · 重启 DSH（本机桌面应用）
// 只从面板进程调用：先回包，再异步杀/起 DSH，更新 baseUrl 并重启桥接。
import { HOME as B, BRIDGE_ROOT } from '../../../packages/paths/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { QB, QB_STATE } from './core.mjs';
import { stopBridge, startBridgeTask, waitDshReady } from './reconnect-dsh.mjs';

const BOT = `${B}`;
const DSH_EXE = process.env.DSH_EXE || 'E:\\Program\\dsh\\DeepSeek Harness.exe';
const STATE_FILE = path.join(BOT, 'state', 'dsh-restart.json');
const NODE = process.execPath;

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, v) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8'); } catch {} }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function dshRestartStatus() {
  const st = readJson(STATE_FILE, {});
  return { ok: true, at: st.at || null, status: st.status || 'idle', baseUrl: st.baseUrl || '', error: st.error || '' };
}

export function requestDshRestart() {
  const st = readJson(STATE_FILE, {});
  if (st.status === 'running' && Date.now() - Date.parse(st.at || 0) < 120000) {
    return { ok: false, error: 'DSH 正在重启中，请稍等' };
  }
  const started = { at: new Date().toISOString(), status: 'running', baseUrl: '', error: '' };
  writeJson(STATE_FILE, started);
  setTimeout(() => { runRestart().catch((e) => {
    writeJson(STATE_FILE, { ...started, status: 'failed', error: String(e?.message ?? e) });
  }); }, 800);
  return { ok: true, accepted: true, note: '将在 1 秒内重启 DSH；约 20~40 秒后请重新打开 DSH 窗口' };
}

async function dshAlive(baseUrl) {
  if (!baseUrl) return false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    await fetch(baseUrl.replace(/\/+$/, '') + '/', { signal: ctl.signal });
    clearTimeout(t);
    return true; // 401 也算活着
  } catch (e) {
    return /HTTP|401|403|status/i.test(String(e)) ? true : false;
  }
}

async function runRestart() {
  const started = readJson(STATE_FILE, {});
  const result = { ...started, baseUrl: '', error: '' };
  try {
    // 1) 杀 DSH 主进程（所有子进程）
    spawnSync('taskkill', ['/IM', 'DeepSeek Harness.exe', '/F'], { timeout: 30000, windowsHide: true });
    await wait(2500);

    // 2) 启动 DSH（通过 PowerShell Start-Process，确保桌面窗口正常显示）
    if (!fs.existsSync(DSH_EXE)) throw new Error('找不到 DSH 程序：' + DSH_EXE);
    const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process -FilePath '${DSH_EXE.replace(/'/g, "''")}'`], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();

    // 3) 等 DSH 起来并更新 baseUrl
    let baseUrl = '';
    for (let i = 0; i < 40; i += 1) {
      await wait(1500);
      try {
        spawnSync(NODE, [path.join(QB, 'scripts', 'ensure-dsh-baseurl.mjs')], { cwd: QB, timeout: 20000, windowsHide: true });
      } catch {}
      const cfg = readJson(path.join(QB, 'config.json'), {});
      baseUrl = String(cfg?.dsh?.baseUrl || '');
      if (await dshAlive(baseUrl)) break;
      baseUrl = '';
    }
    if (!baseUrl) throw new Error('DSH 启动后 60 秒内不可访问');
    result.baseUrl = baseUrl;
    try { fs.writeFileSync(path.join(BOT, 'state', 'dsh-url.txt'), baseUrl + '\n', 'utf8'); } catch {}

    // DSH 的 HTTP 端口可能先开、事件流还没就绪；多等一会再重启桥接
    await wait(8000);

    // 4) 重启桥接（让它用新 baseUrl）
    const token = (() => { try { return fs.readFileSync(path.join(QB_STATE, 'console-token'), 'utf8').trim(); } catch { return ''; } })();
    async function restartBridgeAndWait(seconds) {
      // 必须真的杀进程并清僵尸锁：计划任务 /end 杀不掉被守护脚本拉起的 detached node，
      // 旧进程会继续用内存里的旧 baseUrl，dshReady 永远不恢复（2026-11-09 实故障）。
      await stopBridge();
      await wait(600);
      startBridgeTask();
      const last = await waitDshReady(seconds);
      return Boolean(last.dshReady);
    }

    // 5) 等桥接连上 DSH；首次失败再重启一次桥接
    let bridgeReady = await restartBridgeAndWait(60);
    if (!bridgeReady) {
      result.retriedBridge = true;
      bridgeReady = await restartBridgeAndWait(45);
    }
    result.status = bridgeReady ? 'done' : 'bridge-wait';
    result.bridgeReady = bridgeReady;
    writeJson(STATE_FILE, result);
  } catch (error) {
    result.status = 'failed';
    result.error = String(error?.message ?? error);
    writeJson(STATE_FILE, result);
  }
}
