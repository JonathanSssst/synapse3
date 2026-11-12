#!/usr/bin/env node
/**
 * detect-dsh.mjs — 找出 DSH 桌面版当前的 API 地址（端口每次启动都会变）
 *
 * 背景：桥接用 `cfg.dsh.baseUrl` 连 DSH 的 apiproxy。DSH 桌面版启动时随机分配端口，
 * 而配置里写死的是某一次的端口（历史上是 1918，经本机反向代理转发）。DSH 一重启，
 * 桥接就连不上，日志表现是「连上事件流但收到 0 帧」，很容易误判成协议不兼容。
 *
 * 判定方式：DSH 的 web 服务对未认证请求会回
 *   `dsh web authentication required; reopen the URL printed by dsh web.`
 * 这句是它独有的，用它做指纹比按端口猜可靠。
 *
 * 用法：
 *   node scripts/detect-dsh.mjs            # 打印检测到的 baseUrl
 *   node scripts/detect-dsh.mjs --json     # 机器可读
 *   node scripts/detect-dsh.mjs --apply    # 写入 config/bridge.json 的 dsh.baseUrl
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const FINGERPRINT = 'dsh web authentication required';

/** 取本机所有处于 LISTEN 的 127.0.0.1 端口 */
function listeningPorts() {
  const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'latin1', windowsHide: true, timeout: 8000 });
  const ports = new Set();
  for (const line of out.split('\n')) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const [, addr, port] = m;
    if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])$/.test(addr)) continue;
    ports.add(Number(port));
  }
  return [...ports].sort((a, b) => a - b);
}

/** 探测一个端口是不是 DSH 的 web 服务：strong = 认证提示指纹，weak = 前端外壳 */
async function probe(port) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 400);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
    const text = await res.text();
    if (text.includes(FINGERPRINT)) return 'strong';
    // 认证已通过时返回前端外壳；但它也可能是另一个前端（如 Vite 预览），
    // 所以只当弱证据，只有在没有任何 strong 命中时才采用。
    if (res.status === 200 && /dsh|DeepSeek Harness/i.test(text.slice(0, 400))) return 'weak';
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const ports = listeningPorts();
const strong = [];
const weak = [];
// 并发探测，避免几十个端口串行等超时
const CONCURRENCY = 8;
for (let i = 0; i < ports.length; i += CONCURRENCY) {
  const batch = ports.slice(i, i + CONCURRENCY);
  const results = await Promise.all(batch.map(async (p) => ({ p, kind: await probe(p) })));
  for (const r of results) {
    if (r.kind === 'strong') strong.push(r.p);
    else if (r.kind === 'weak') weak.push(r.p);
  }
}

const hits = strong.length ? strong : weak;
const baseUrl = hits.length ? `http://127.0.0.1:${hits[0]}` : null;
const apply = process.argv.includes('--apply');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ baseUrl, candidates: hits, scanned: ports.length }, null, 2));
} else {
  console.log(`扫描 ${ports.length} 个回环端口，命中 ${hits.length} 个：${hits.join(', ') || '(无)'}`);
  console.log(baseUrl ? `DSH API = ${baseUrl}` : '未找到 DSH：它可能没在运行');
}

if (apply && baseUrl) {
  const cfgPath = path.join(ROOT, 'config', 'bridge.json');
  if (!fs.existsSync(cfgPath)) { console.error('找不到', cfgPath); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const old = cfg.dsh?.baseUrl ?? '(未设置)';
  cfg.dsh = cfg.dsh || {};
  cfg.dsh.baseUrl = baseUrl;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  const back = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  console.log(`已写入 config/bridge.json：${old} → ${back.dsh.baseUrl}（重启桥接后生效）`);
}

process.exit(baseUrl ? 0 : 1);
