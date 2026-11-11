// Synapse 3 面板后端 · 重新接入 DSH 端口
// 只处理「DSH 端口变了 / 桥接还连着旧端口」：不杀 DSH、不重启 DSH。
// 流程：ensure-dsh-baseurl 重新发现端口并写回 config.json → 杀干净桥接进程 →
//       清掉僵尸锁 → 用计划任务拉起桥接 → 轮询 /api/status 的 dshReady。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BOT, QB, QB_STATE, readJson, writeJson, readText, logLine } from './core.mjs';

const STATE_FILE = path.join(BOT, 'state', 'dsh-reconnect.json');
const LOCK_FILE = path.join(QB_STATE, 'bridge.lock');
const CONFIG_FILE = path.join(QB, 'config.json');
const BRIDGE_STATUS = 'http://127.0.0.1:3100/api/status';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readToken() {
  try { return readText(path.join(QB_STATE, 'console-token')).trim(); } catch { return ''; }
}

function configBaseUrl() {
  return String(readJson(CONFIG_FILE, {})?.dsh?.baseUrl || '');
}

// 找出所有 src\bridge.js 的 node 进程（桥接可能被计划任务/守护脚本多拉起过）
function listBridgePids() {
  const ps = [
    "$ErrorActionPreference='SilentlyContinue';",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
    "| Where-Object { $_.CommandLine -like '*bridge.js*' }",
    '| Select-Object -ExpandProperty ProcessId'
  ].join(' ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8', windowsHide: true, timeout: 15000
  });
  return String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);
}

function killPid(pid) {
  const r = spawnSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return r.status === 0;
}

// 僵尸锁：进程已经不在、锁文件还留着，会让新桥接直接退出（"已有实例在运行"）。
function clearStaleLock(pidsLeft) {
  if (pidsLeft.length > 0) return false;
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    fs.unlinkSync(LOCK_FILE);
    logLine('[reconnect-dsh] 已清理僵尸桥接锁');
    return true;
  } catch { return false; }
}

export function startBridgeTask() {
  const r = spawnSync('schtasks', ['/run', '/tn', 'QQBridge'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const ok = r.status === 0;
  return { ok, output: out.slice(0, 300) };
}

async function probeBridge() {
  const token = readToken();
  try {
    const res = await fetch(BRIDGE_STATUS, {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(6000)
    });
    const data = await res.json().catch(() => ({}));
    return { up: true, httpStatus: res.status, dshReady: data?.dshReady === true };
  } catch {
    return { up: false, dshReady: false };
  }
}

export async function stopBridge() {
  const before = listBridgePids();
  const killed = [];
  for (const pid of before) if (killPid(pid)) killed.push(pid);
  await sleep(1200);
  const after = listBridgePids();
  const lockCleared = clearStaleLock(after);
  return { killed, left: after, lockCleared };
}

export async function waitDshReady(seconds) {
  const deadline = Date.now() + seconds * 1000;
  let last = { up: false, dshReady: false };
  while (Date.now() < deadline) {
    last = await probeBridge();
    if (last.dshReady) return last;
    await sleep(2000);
  }
  return last;
}

function saveResult(patch) {
  const prev = readJson(STATE_FILE, {});
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  writeJson(STATE_FILE, next);
  return next;
}

export function reconnectDshStatus() {
  const st = readJson(STATE_FILE, {});
  return {
    ok: true,
    at: st.at || null,
    updatedAt: st.updatedAt || null,
    status: st.status || 'idle',
    phase: st.phase || '',
    baseUrl: st.baseUrl || '',
    bridgeReady: Boolean(st.bridgeReady),
    error: st.error || ''
  };
}

export function requestDshReconnect() {
  const st = readJson(STATE_FILE, {});
  if (st.status === 'running' && Date.now() - Date.parse(st.updatedAt || st.at || 0) < 120000) {
    return { ok: false, error: '正在重新接入 DSH 端口，请稍等' };
  }
  const started = {
    at: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    phase: 'ensure',
    baseUrl: configBaseUrl(),
    bridgeReady: false,
    error: ''
  };
  writeJson(STATE_FILE, started);
  setTimeout(() => {
    runReconnect().catch((error) => {
      saveResult({ status: 'failed', phase: 'error', error: String(error?.message ?? error) });
      logLine(`[reconnect-dsh] 失败：${error?.message ?? error}`);
    });
  }, 300);
  return { ok: true, accepted: true, baseUrl: started.baseUrl, note: '正在重新发现 DSH 端口并重启桥接（不重启 DSH）' };
}

async function runReconnect() {
  const token = readToken();
  let baseUrl = configBaseUrl();
  let ensureOutput = '';

  // 1) 重新发现 DSH 端口（DSH 仍在本机运行，只是端口可能变了）
  saveResult({ phase: 'ensure', status: 'running', error: '' });
  try {
    const r = spawnSync(process.execPath, [path.join(QB, 'scripts', 'ensure-dsh-baseurl.mjs')], {
      cwd: QB, encoding: 'utf8', windowsHide: true, timeout: 40000
    });
    ensureOutput = `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 400);
    const discovered = configBaseUrl();
    if (discovered) baseUrl = discovered;
    saveResult({ baseUrl, ensureOutput });
    logLine(`[reconnect-dsh] ensure 完成：${ensureOutput || '(no output)'}`);
  } catch (error) {
    ensureOutput = String(error?.message ?? error);
    logLine(`[reconnect-dsh] ensure 失败，继续用现有端口：${ensureOutput}`);
  }

  // 2) 重启桥接（必须真的杀进程；schtasks /end 杀不掉被守护脚本拉起的 detached node）
  saveResult({ phase: 'restart', baseUrl, status: 'running' });
  let stop = await stopBridge();
  logLine(`[reconnect-dsh] 桥接已停止 pids=${stop.killed.join(',') || '-'} left=${stop.left.join(',') || '-'} lockCleared=${stop.lockCleared}`);
  let start = startBridgeTask();
  saveResult({ bridgeStart: start.output, phase: 'wait' });

  // 3) 等 dshReady；首次失败再彻底重启一次桥接
  let last = await waitDshReady(45);
  if (!last.dshReady) {
    logLine('[reconnect-dsh] 首次未就绪，重试一次');
    stop = await stopBridge();
    start = startBridgeTask();
    last = await waitDshReady(40);
  }

  const bridgeReady = Boolean(last.dshReady);
  const result = saveResult({
    status: bridgeReady ? 'done' : 'bridge-wait',
    phase: bridgeReady ? 'done' : 'wait',
    baseUrl,
    bridgeReady,
    bridgeUp: Boolean(last.up),
    httpStatus: last.httpStatus ?? null,
    error: bridgeReady ? '' : '桥接已启动，但 DSH 在等待窗口内仍未就绪；请确认 DSH 窗口仍在运行'
  });
  logLine(`[reconnect-dsh] 结束 status=${result.status} baseUrl=${baseUrl} dshReady=${bridgeReady}`);

  // 4) 顺手探测一次，状态文件里留下可读结果（不抛错）
  try {
    await fetch(BRIDGE_STATUS, {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(6000)
    });
  } catch {}
}
