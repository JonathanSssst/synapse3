#!/usr/bin/env node
/**
 * 按官方方式重启 SnowLuma，并在启动前确认没有残留进程。
 *
 * 为什么必须确认残留：
 *   2026-11-12 17:15 那次重启，只 Stop-Process 了主进程就立刻启动，结果新进程把
 *   messages.db 以**只读**方式打开，日志持续报
 *     SQLITE_READONLY: attempt to write a readonly database
 *   消息事件在 SnowLuma 内部就被丢弃，桥接连一个包都收不到 —— 表现为"机器人不回话，
 *   但 dshReady / snowluma.connected 全是 True"，极易误判成模型或余额问题。
 *   同一个 db 用 node 直接打开写入却完全正常，说明不是文件权限，而是旧进程还握着句柄。
 *
 * 为什么用绝对路径启动：
 *   官方 run-2.4.0-hidden.vbs 传的是绝对路径 `node.exe <绝对路径>\index.mjs`。
 *   桥接侧启动容易写成相对路径，虽然一般也能跑，但与官方启动方式不一致会引入变量。
 *
 * 用法：
 *   node scripts/restart-snowluma.mjs                # 目录取自 config/bridge.json 的 snowluma.homeDir
 *   node scripts/restart-snowluma.mjs --dir "<SnowLuma 安装目录>"
 *   node scripts/restart-snowluma.mjs --check        # 只看进程与端口，不动进程
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const PORTS = [3000, 3001, 5099];

/** SnowLuma 安装目录：--dir 优先，其次读 config/bridge.json 的 snowluma.homeDir。 */
function resolveDir() {
  if (args.includes('--dir')) return path.resolve(args[args.indexOf('--dir') + 1]);
  try {
    const home = process.env.SYNAPSE_HOME || path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config', 'bridge.json'), 'utf8'));
    const d = cfg?.snowluma?.homeDir;
    if (d) return path.resolve(d);
  } catch {}
  return null;
}

const DIR = resolveDir();
if (!DIR) {
  console.error('✗ 没拿到 SnowLuma 目录。用 --dir 指定，或先在 config/bridge.json 里配 snowluma.homeDir。');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listeningPorts() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const set = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const cols = line.trim().split(/\s+/);
      const port = Number((cols[1] || '').split(':').pop());
      if (PORTS.includes(port)) set.add(port);
    }
    return [...set];
  } catch { return []; }
}

/** 列出命令行里含 SnowLuma 目录的 node 进程（主进程与它派生的 worker 都算） */
function snowLumaProcesses() {
  try {
    const ps = [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ];
    const out = execFileSync('powershell', ps, { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
    if (!out) return [];
    const arr = JSON.parse(out);
    return (Array.isArray(arr) ? arr : [arr])
      .filter((p) => p && p.CommandLine && p.CommandLine.includes('SnowLuma'))
      .map((p) => ({ pid: p.ProcessId, cmd: p.CommandLine }));
  } catch { return []; }
}

function killPid(pid) {
  try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
}

function canConnect(port, timeout = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    let done = false;
    const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeout, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

if (!fs.existsSync(path.join(DIR, 'index.mjs'))) {
  console.error(`✗ 目录里没有 index.mjs：${DIR}`);
  process.exit(2);
}

const listen = listeningPorts();
const procs = snowLumaProcesses();
console.log(`SnowLuma 目录：${DIR}`);
console.log(`监听端口：${listen.length ? listen.join(', ') : '（无）'}`);
console.log(`node 进程：${procs.length ? procs.map((p) => p.pid).join(', ') : '（无）'}`);

if (CHECK_ONLY) {
  for (const p of procs) console.log(`  [${p.pid}] ${p.cmd}`);
  process.exit(0);
}

// ① 停止全部相关进程
if (procs.length) {
  console.log('\n[1/4] 停止 SnowLuma 进程');
  for (const p of procs) {
    const ok = killPid(p.pid);
    console.log(`  ${ok ? '✓' : '✗'} PID ${p.pid}`);
  }
}

// ② 等它们真退出（这是上次踩坑的地方：只停主进程、立刻启动 → db 只读）
//
// SnowLuma 运行时是「启动器父进程 → 实际工作子进程」两层的结构。只杀父进程会留下
// 变成孤儿的子进程，它仍握着数据库句柄；下一次启动就变成两棵独立的进程树共用同一个
// messages.db，后启动的那棵只能以只读方式打开。所以这里每轮都重新枚举并补杀。
console.log('\n[2/4] 等待进程完全退出（最多 20 秒，会补杀父进程留下的孤儿子进程）');
let left = [];
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  left = snowLumaProcesses();
  if (left.length === 0 && listeningPorts().length === 0) break;
  if (i >= 2) for (const p of left) killPid(p.pid);
}
if (left.length) {
  console.error('✗ 仍有残留进程，已中止启动（否则新进程会把数据库降级为只读）');
  for (const p of left) console.error(`  [${p.pid}] ${p.cmd}`);
  console.error('\n处理办法：确认上面这些进程可以结束后，用 taskkill /F /PID <pid> 逐条清理，再重跑本脚本。');
  process.exit(3);
}
console.log('  ✓ 已完全退出');

// ③ 用绝对路径启动（与官方 VBS 一致）
console.log('\n[3/4] 启动');
const exe = path.join(DIR, 'node.exe');
const entry = path.join(DIR, 'index.mjs');
const logDir = path.join(DIR, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const outFile = path.join(logDir, 'restart-stdout.log');
const out = fs.openSync(outFile, 'a');
const child = spawn(exe, [entry], {
  cwd: DIR,
  detached: true,
  stdio: ['ignore', out, out],
  windowsHide: true,
});
child.unref();
console.log(`  ✓ 已启动 PID ${child.pid}（输出追加到 ${outFile}）`);

// ④ 等端口就绪
console.log('\n[4/4] 等待 3000 / 3001 就绪（最多 45 秒）');
let ready = false;
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  if (await canConnect(3000) && await canConnect(3001)) { ready = true; break; }
}
if (!ready) {
  console.error('✗ 45 秒内 3000/3001 未就绪，看看日志：');
  console.error(`  tail -40 "${outFile}"`);
  process.exit(4);
}
console.log('  ✓ OneBot HTTP/WS 已就绪');

console.log('\n下一步：SnowLuma 重启后桥接的 WebSocket 不会自己接回来，需要重启桥接。');
