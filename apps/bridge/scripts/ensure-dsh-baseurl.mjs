// 保证 DSH 桌面版端口变化后桥接仍能连上：
// 从进程列表里找到 DeepSeek Harness 主进程占用的 127.0.0.1 监听端口，
// 用持久化签名密钥铸造会话 Cookie 并 probe settings/describe，成功即写回 config.json 的 dsh.baseUrl。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient } from '../src/dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

function candidatePorts() {
  let pids = new Set();
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV /NH', { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const cols = line.match(/"([^"]*)"/g);
      if (!cols || cols.length < 2) continue;
      const pid = cols[1].replaceAll('"', '').trim();
      if (/^\d+$/.test(pid)) pids.add(pid);
    }
  } catch {}
  const ports = new Set();
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+(127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (!m) continue;
      if (pids.has(m[3])) ports.add(Number(m[2]));
    }
  } catch {}
  return [...ports];
}

async function probeBase(baseUrl) {
  const client = new NodeApiClient(baseUrl, 4000, { allowRemote: false });
  try {
    const r = await client.callUnary('settings/describe', null, AbortSignal.timeout(4000));
    return Boolean(r?.result?.ok || r?.result?.value);
  } catch {
    return false;
  }
}

const current = loadConfig();
if (current?.dsh?.baseUrl && (await probeBase(current.dsh.baseUrl))) {
  console.log(`[ensure-dsh-baseurl] 现有 baseUrl 可用：${current.dsh.baseUrl}`);
  process.exit(0);
}

for (const port of candidatePorts()) {
  const baseUrl = `http://127.0.0.1:${port}`;
  if (await probeBase(baseUrl)) {
    current.dsh.baseUrl = baseUrl;
    fs.writeFileSync(CONFIG, JSON.stringify(current, null, 2) + '\n', 'utf8');
    console.log(`[ensure-dsh-baseurl] DSH 端口已更新：${baseUrl}`);
    process.exit(0);
  }
}
console.error('[ensure-dsh-baseurl] 没找到可用的 DSH 端口（DSH 是否在运行？）');
process.exit(1);
