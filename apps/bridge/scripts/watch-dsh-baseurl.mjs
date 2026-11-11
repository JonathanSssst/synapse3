// DSH 端口看门狗：DSH 桌面版每次重启都会换端口。
// 桥接自己不会发现端口变了（它只会重试旧端口），所以这里每分钟检查一次：
//   旧 baseUrl 不通 → 重新发现端口 → 写回 config.json → 杀掉 src/bridge.js 进程，
//   让计划任务里的守护 bat 带着新配置把桥接拉起来。
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

function hostPids() {
  const pids = new Set();
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV /NH', { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const cols = line.match(/"([^"]*)"/g);
      if (!cols || cols.length < 2) continue;
      const pid = cols[1].replaceAll('"', '').trim();
      if (/^\d+$/.test(pid)) pids.add(pid);
    }
  } catch {}
  return pids;
}

function candidatePorts() {
  const pids = hostPids();
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

async function probe(baseUrl) {
  const client = new NodeApiClient(baseUrl, 3000, { allowRemote: false });
  try {
    const r = await client.callUnary('settings/describe', null, AbortSignal.timeout(3000));
    return Boolean(r?.result?.ok || r?.result?.value);
  } catch {
    return false;
  }
}

function killBridgeProcesses() {
  let killed = 0;
  try {
    const out = execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine 2>nul', { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      if (!/src[\\/]bridge\.js/.test(line)) continue;
      const m = line.match(/(\d+)\s*$/);
      if (!m) continue;
      try {
        execSync(`taskkill /PID ${m[1]} /F`, { stdio: 'ignore' });
        killed += 1;
      } catch {}
    }
  } catch {}
  return killed;
}

const cfg = loadConfig();
const current = cfg?.dsh?.baseUrl;
if (current && await probe(current)) process.exit(0);

for (const port of candidatePorts()) {
  const baseUrl = `http://127.0.0.1:${port}`;
  if (await probe(baseUrl)) {
    cfg.dsh.baseUrl = baseUrl;
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    const killed = killBridgeProcesses();
    console.log(`${new Date().toISOString()} DSH 端口更新 -> ${baseUrl}，重启桥接进程 ${killed} 个`);
    process.exit(0);
  }
}
console.log(`${new Date().toISOString()} DSH 不在线或未找到端口，保持现状（桥接会继续重试旧地址）`);
process.exit(1);
