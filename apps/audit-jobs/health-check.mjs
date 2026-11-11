// Synapse 3 · 健康自检：每天查关键服务；异常才私信主人（1 小时内不重复打扰）。
import { HOME as B, BRIDGE_ROOT } from '../../packages/paths/index.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const BOT = `${B}`;
const STATE_DIR = path.join(BOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'health.json');
const LOG_FILE = path.join(BOT, 'audit', 'health.log');
const QQB = 'E:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace\\qq-bridge';

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(LOG_FILE, s, 'utf8'); } catch {}
}
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, o) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8'); } catch {} }
function portOpen(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
async function fetchJson(url, opts = {}, timeoutMs = 5000) {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, body };
  } catch (e) { return { ok: false, body: { error: String(e?.message ?? e) } }; }
}
async function retry(fn, tries = 2, waitMs = 2500) {
  let ok = false;
  for (let i = 0; i < tries; i += 1) {
    ok = await fn();
    if (ok) return true;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs));
  }
  return ok;
}

async function notify(text) {
  try {
    const token = fs.readFileSync(path.join(QQB, 'state', 'console-token'), 'utf8').trim();
    await fetch('http://127.0.0.1:3100/api/system-notify', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': token }, body: JSON.stringify({ text })
    });
    return true;
  } catch { return false; }
}
async function main() {
  const master = readJson(path.join(QQB, 'state', 'master-switch.json'), {});
  if (master.stopped === true) {
    const prev = readJson(STATE_FILE, {});
    writeJson(STATE_FILE, { ok: true, at: new Date().toISOString(), failures: [], note: `总开关已停止（${master.at || ''}），跳过自检`, lastNotifiedAt: prev.lastNotifiedAt || 0 });
    log('总开关已停止，跳过本次自检');
    return;
  }
  const fails = [];
  const ports = { SnowLuma网关: 3000, SnowLumaWS: 3001, 桥接: 3100, 面板: 3120 };
  for (const [name, port] of Object.entries(ports)) if (!(await retry(() => portOpen(port)))) fails.push(`${name} 端口 ${port} 不通`);
  let bridge = await fetchJson('http://127.0.0.1:3100/api/status', { headers: { 'x-console-token': fs.existsSync(path.join(QQB, 'state', 'console-token')) ? fs.readFileSync(path.join(QQB, 'state', 'console-token'), 'utf8').trim() : '' } }, 15000);
  if (!bridge.ok) { await new Promise((r) => setTimeout(r, 2500)); bridge = await fetchJson('http://127.0.0.1:3100/api/status', { headers: { 'x-console-token': fs.readFileSync(path.join(QQB, 'state', 'console-token'), 'utf8').trim() } }, 30000); }
  if (!bridge.ok) fails.push('桥接 /api/status 不可用（接口超时）');
  else {
    if (!bridge.body.dshReady) fails.push('桥接报告 DSH 未就绪（端口或会话问题）');
    if (!bridge.body.snowluma?.connected) fails.push('桥接与 SnowLuma 未连接');
    if (!bridge.body.snowluma?.accountOnline) fails.push('QQ 账号离线');
  }
  let panel = await fetchJson('http://127.0.0.1:3120/api/health', {}, 20000);
  if (!panel.ok) { await new Promise((r) => setTimeout(r, 2500)); panel = await fetchJson('http://127.0.0.1:3120/api/health', {}, 20000); }
  if (!panel.ok) fails.push('面板不可用');
  // 空间助手
  try {
    let pid = 0;
    try { pid = Number(fs.readFileSync(path.join(BOT, 'qzone', 'qzone-bot.pid'), 'utf8').trim()); } catch {}
    let alive = false;
    if (pid) {
      try {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 15000 });
        alive = out.includes(`"${pid}"`);
      } catch {}
    }
    if (!alive) {
      // 兜底：按命令行找 qzone-bot.mjs（pid 文件可能过期）
      try {
        const out = execFileSync('wmic', ['process', 'where', "name='node.exe'", 'get', 'ProcessId,CommandLine'], { encoding: 'utf8', timeout: 20000 });
        alive = String(out).includes('qzone-bot.mjs');
      } catch {}
    }
    if (!alive) fails.push('QQ 空间助手进程不在');
  } catch { fails.push('QQ 空间助手未运行（没有 pid）'); }
  // 生图配置
  const gen = readJson(path.join(BOT, 'imagegen', 'config.json'), {});
  if (!gen.apiKey) {
    const keyFile = path.join(BOT, 'imagegen', 'key.txt');
    if (!fs.existsSync(keyFile)) fails.push('生图没配置 API Key');
  }
  const now = Date.now();
  const prev = readJson(STATE_FILE, { ok: true });
  const state = { ok: fails.length === 0, at: new Date().toISOString(), failures: fails, lastNotifiedAt: prev.lastNotifiedAt || 0 };
  writeJson(STATE_FILE, state);
  if (fails.length) {
    log(`异常：${fails.join('；')}`);
    if (now - Number(prev.lastNotifiedAt || 0) > 60 * 60 * 1000) {
      const sent = await notify(`【Synapse 3 健康自检】发现问题：\n- ${fails.join('\n- ')}\n（详情见 E:\\BOT\\audit\\health.log）`);
      if (sent) { state.lastNotifiedAt = now; writeJson(STATE_FILE, state); }
    }
  } else {
    log('全部正常');
    if (prev.ok === false) {
      const was = Array.isArray(prev.failures) && prev.failures.length ? prev.failures.join('、') : '未知问题';
      const sent = await notify(`【Synapse 3 健康自检】已恢复 ✅\n- 之前的问题：${was}\n- 现在：桥接 / 面板 / QZone / SnowLuma 全部正常`);
      log(sent ? '已发送恢复通知' : '恢复通知发送失败');
      if (sent) { state.lastRecoveredAt = now; writeJson(STATE_FILE, state); }
    }
  }
}
main().catch((e) => log(`自检脚本出错：${e?.stack ?? e}`));
