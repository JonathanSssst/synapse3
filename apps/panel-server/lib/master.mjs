// Synapse 3 面板后端 · 总开关（临时停止/恢复机器人相关进程）
// 只停/启：桥接（src/bridge.js）、QZone（qzone-bot.mjs）；面板自身与 SnowLuma 网关不动。
// QZoneWatch 会在停止期间被临时禁用，恢复时重新启用，避免看门狗把 qzone 拉起。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QB_STATE } from './core.mjs';

const STATE_FILE = path.join(QB_STATE, 'master-switch.json');
const TASKS = { bridge: 'QQBridge', qzone: 'QZoneBot', qzoneWatch: 'QZoneWatch', bridgeWatch: 'QQBridgeWatch', snowluma: 'SnowLumaGateway' };
const PAT = { bridge: 'src\\bridge.js', qzone: 'qzone-bot.mjs', snowluma: 'SnowLuma' };

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  const cur = readState();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8'); } catch {}
  return next;
}
function nodeProcesses() {
  try {
    const r = spawnSync('wmic', ['process', 'where', "name='node.exe'", 'get', 'ProcessId,CommandLine', '/format:csv'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return String(r.stdout || '').split(/\r?\n/).filter(Boolean).slice(1).map((line) => {
      const m = /^[^,]*,(.*),(\d+)\s*$/.exec(line);
      if (!m) return null;
      return { cmd: m[1], pid: Number(m[2]) };
    }).filter(Boolean);
  } catch { return []; }
}
function findPid(patterns) {
  const hit = nodeProcesses().find((p) => patterns.some((pat) => p.cmd.includes(pat)));
  return hit ? hit.pid : 0;
}
function kill(pid) {
  if (!pid) return false;
  try { return spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8', timeout: 15000, windowsHide: true }).status === 0; } catch { return false; }
}
function schtasks(args) {
  try { return spawnSync('schtasks', args, { encoding: 'utf8', timeout: 20000, windowsHide: true }).status === 0; } catch { return false; }
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function masterStatus() {
  const st = readState();
  const bridgePid = findPid([PAT.bridge]);
  const qzonePid = findPid([PAT.qzone]);
  const snowlumaPid = findPid([PAT.snowluma]);
  return {
    ok: true,
    stopped: st.stopped === true,
    at: st.at || null,
    bridge: { running: bridgePid > 0, pid: bridgePid },
    qzone: { running: qzonePid > 0, pid: qzonePid },
    snowluma: { running: snowlumaPid > 0, pid: snowlumaPid },
    note: '总开关会停桥接、QZone 和 SnowLuma 网关（她的 QQ 会离线）；面板本身不停；恢复时自动启用 QZoneWatch。'
  };
}

export async function masterStop() {
  const log = [];
  schtasks(['/change', '/tn', TASKS.qzoneWatch, '/disable']); // 先禁看门狗，避免停止后被拉起
  schtasks(['/change', '/tn', TASKS.bridgeWatch, '/disable']);
  log.push('QQBridgeWatch / QZoneWatch 已临时禁用');
  const bridgePid = findPid([PAT.bridge]);
  const qzonePid = findPid([PAT.qzone]);
  if (bridgePid) { kill(bridgePid); log.push(`桥接已停止 (pid ${bridgePid})`); } else log.push('桥接本来就没在跑');
  if (qzonePid) { kill(qzonePid); log.push(`QZone 已停止 (pid ${qzonePid})`); } else log.push('QZone 本来就没在跑');
  const snowlumaPid = findPid([PAT.snowluma]);
  if (snowlumaPid) { kill(snowlumaPid); log.push(`SnowLuma 已停止 (pid ${snowlumaPid})，QQ 会离线`); } else log.push('SnowLuma 本来就没在跑');
  writeState({ stopped: true, at: new Date().toISOString(), reason: 'panel-master-switch' });
  await wait(800);
  return { ok: true, action: 'stop', log, status: masterStatus() };
}

export async function masterStart() {
  const log = [];
  schtasks(['/change', '/tn', TASKS.qzoneWatch, '/enable']);
  schtasks(['/change', '/tn', TASKS.bridgeWatch, '/enable']);
  log.push('QQBridgeWatch / QZoneWatch 已启用');
  if (findPid([PAT.bridge])) log.push('桥接已在运行，跳过启动'); else { schtasks(['/run', '/tn', TASKS.bridge]); log.push('已请求启动桥接'); }
  if (findPid([PAT.qzone])) log.push('QZone 已在运行，跳过启动'); else { schtasks(['/run', '/tn', TASKS.qzone]); log.push('已请求启动 QZone'); }
  if (findPid([PAT.snowluma])) log.push('SnowLuma 已在运行，跳过启动'); else { schtasks(['/run', '/tn', TASKS.snowluma]); log.push('已请求启动 SnowLuma'); }
  writeState({ stopped: false, at: new Date().toISOString(), reason: 'panel-master-switch' });
  await wait(2500);
  return { ok: true, action: 'start', log, status: masterStatus() };
}
