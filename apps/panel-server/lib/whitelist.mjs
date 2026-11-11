// Synapse 3 面板后端 · 白名单配置（qq-bridge config.json 读写 + 桥接重启）
// 读取：以桥接实际生效的 allow.groups / allow.private 为准，兼容 socialV2.allowGroups / socialV2.allowPrivate
// 写入：两处同步，避免面板改了但桥接不生效；写前备份 config.json.bak
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QB, QB_STATE, readText } from './core.mjs';

const CONFIG_PATH = path.join(QB, 'config.json');
const BACKUP_PATH = path.join(QB, 'config.json.bak');
const MAX_COUNT = 200;
const RE_ID = /^\d{1,15}$/;

function asIdList(value) {
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
  if (typeof value === 'number') return [String(value)];
  if (typeof value === 'string') return value.split(/[\s,，、]+/).map((x) => x.trim()).filter(Boolean);
  return [];
}

function normId(v, label) {
  const s = String(v).trim();
  if (!s) return null;
  if (!RE_ID.test(s)) throw new Error(`${label}「${s.slice(0, 20)}」不是纯数字（只接受 1~15 位数字）`);
  return s;
}

export function normalizeWhitelistInput(groups, privates) {
  const parse = (raw, label) => {
    const list = asIdList(raw);
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const id = normId(item, label);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    if (out.length > MAX_COUNT) throw new Error(`${label}最多 ${MAX_COUNT} 个（当前 ${out.length} 个）`);
    return out;
  };
  return { groups: parse(groups, '群号'), privates: parse(privates, 'QQ 号') };
}

function readConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object') throw new Error('config.json 不是对象');
    return cfg;
  } catch (error) {
    throw new Error(`读取 config.json 失败：${error?.message ?? error}`);
  }
}

// 读取当前白名单（桥接实际生效的是 allow.*；socialV2.* 作为镜像/兼容）
export function readWhitelist() {
  const cfg = readConfigFile();
  const allow = cfg.allow && typeof cfg.allow === 'object' ? cfg.allow : {};
  const social = cfg.socialV2 && typeof cfg.socialV2 === 'object' ? cfg.socialV2 : {};
  const legacyGroups = asIdList(allow.groups);
  const legacyPrivates = asIdList(allow.private ?? allow.privates);
  const socialGroups = asIdList(social.allowGroups);
  const socialPrivates = asIdList(social.allowPrivate);
  const groups = legacyGroups.length ? legacyGroups : socialGroups;
  const privates = legacyPrivates.length ? legacyPrivates : socialPrivates;
  return {
    ok: true,
    groups,
    privates,
    counts: { groups: groups.length, privates: privates.length },
    sources: {
      groups: legacyGroups.length ? 'allow.groups' : (socialGroups.length ? 'socialV2.allowGroups' : 'default'),
      privates: legacyPrivates.length ? 'allow.private' : (socialPrivates.length ? 'socialV2.allowPrivate' : 'default')
    },
    legacy: { groups: legacyGroups, privates: legacyPrivates },
    socialV2: { allowGroups: socialGroups, allowPrivate: socialPrivates },
    configPath: CONFIG_PATH,
    backupPath: BACKUP_PATH,
    backupExists: fs.existsSync(BACKUP_PATH),
    maxCount: MAX_COUNT
  };
}

function writeConfigAtomic(cfg) {
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

// 保存白名单：校验 → 备份 → 原子写入 allow.* 与 socialV2.*
export function saveWhitelist(groups, privates) {
  const normalized = normalizeWhitelistInput(groups, privates);
  const cfg = readConfigFile();
  if (!cfg.allow || typeof cfg.allow !== 'object') cfg.allow = {};
  if (!cfg.socialV2 || typeof cfg.socialV2 !== 'object') cfg.socialV2 = {};
  const before = {
    groups: asIdList(cfg.allow.groups),
    privates: asIdList(cfg.allow.private ?? cfg.allow.privates)
  };
  // 写前备份（覆盖旧 .bak，保留最近一次可回滚配置）
  fs.copyFileSync(CONFIG_PATH, BACKUP_PATH);
  cfg.allow.groups = normalized.groups;
  cfg.allow.private = normalized.privates;
  // 兼容字段也一起清掉，避免旧键残留造成歧义
  if (cfg.allow.privates !== undefined) delete cfg.allow.privates;
  cfg.socialV2.allowGroups = normalized.groups;
  cfg.socialV2.allowPrivate = normalized.privates;
  writeConfigAtomic(cfg);
  return {
    ok: true,
    groups: normalized.groups,
    privates: normalized.privates,
    counts: { groups: normalized.groups.length, privates: normalized.privates.length },
    before,
    backupPath: BACKUP_PATH,
    configPath: CONFIG_PATH,
    savedAt: new Date().toISOString()
  };
}

// ---------- 桥接重启 ----------
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
  return String(r.stdout || '')
    .split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
    .map(Number);
}

function killPid(pid) {
  const r = spawnSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return r.status === 0;
}

function runBridgeTask() {
  const r = spawnSync('schtasks', ['/run', '/tn', 'QQBridge'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { code: r.status, output: out.slice(0, 300) };
}

async function probeBridge() {
  let token = '';
  try { token = readText(path.join(QB_STATE, 'console-token')).trim(); } catch {}
  try {
    const res = await fetch('http://127.0.0.1:3100/api/status', {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(1500)
    });
    // 401 也说明端口已被桥接监听（只是令牌无效），算“可用”
    return { up: true, httpStatus: res.status };
  } catch {
    return { up: false };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 杀桥接 → schtasks 拉起 → 轮询 /api/status（最长 30s）
export async function restartBridge({ timeoutMs = 30000 } = {}) {
  const startedAt = Date.now();
  const pids = listBridgePids();
  const killed = [];
  for (const pid of pids) {
    if (killPid(pid)) killed.push(pid);
  }
  // 等端口释放，再触发计划任务（守护脚本也会在 5s 内自愈，两者不冲突）
  await sleep(800);
  const task = runBridgeTask();
  let last = { up: false };
  while (Date.now() - startedAt < timeoutMs) {
    last = await probeBridge();
    if (last.up) {
      return {
        ok: true,
        pidsKilled: killed,
        waitedMs: Date.now() - startedAt,
        httpStatus: last.httpStatus,
        task: { code: task.code, output: task.output }
      };
    }
    await sleep(700);
  }
  return {
    ok: false,
    error: `桥接在 ${Math.round(timeoutMs / 1000)}s 内未恢复（http://127.0.0.1:3100/api/status 无响应）`,
    pidsKilled: killed,
    waitedMs: Date.now() - startedAt,
    task: { code: task.code, output: task.output }
  };
}

export const WHITELIST_MAX = MAX_COUNT;
