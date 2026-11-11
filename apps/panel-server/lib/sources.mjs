// Synapse 3 面板后端 · 数据源
// 只读采集：SQLite 审计库、桥接状态文件、安装根下的业务文件
import fs from 'node:fs';
import path from 'node:path';
import {
  BOT, QB, QB_STATE, IMAGEGEN_DIR, priceOf, readText, readJson, writeJson, tailLines,
  todayKey, localTimeStr, localDayOf, inRange, emptyUsage, addUsage, dbRows, dbOne, genId, safeStat
} from './core.mjs';

// ---------- 人设 ----------
export function personaDir(role) {
  return path.join(QB, 'personas', String(role || '').replace(/[^\w一-鿿-]/g, ''));
}
export function personaMetaFile(role) { return path.join(personaDir(role), 'meta.json'); }
export function readPersonaMeta(role) {
  return readJson(personaMetaFile(role), {}) || {};
}
export function savePersonaMeta(role, meta) {
  return writeJson(personaMetaFile(role), meta);
}
export function personaStickerMap() {
  const roles = [];
  const map = {};
  let dirs = [];
  try {
    dirs = fs.readdirSync(path.join(QB, 'personas'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {}
  for (const role of dirs) {
    const meta = readPersonaMeta(role);
    const ids = [];
    try {
      const j = readJson(path.join(QB, 'personas', role, 'stickers.json'), {});
      const items = Array.isArray(j) ? j : (Array.isArray(j?.items) ? j.items : []);
      for (const it of items) {
        const id = String(it?.emoji_id || it?.id || '');
        if (id) ids.push(id);
      }
    } catch {}
    roles.push({ name: role, display: String(meta.nickname || meta.displayName || role), count: ids.length });
    for (const id of ids) (map[id] = map[id] || []).push(role);
  }
  return { roles, map };
}

// 本地人设清单（不依赖桥接在线）
export function personaList() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(path.join(QB, 'personas'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {}
  const cur = readJson(path.join(QB_STATE, 'current-role.json'), {});
  const map = personaStickerMap().map;
  for (const role of dirs) {
    const meta = readPersonaMeta(role);
    const dir = personaDir(role);
    const avatarFile = meta.avatar ? (path.isAbsolute(String(meta.avatar)) ? String(meta.avatar) : path.join(dir, String(meta.avatar))) : path.join(dir, 'avatar.jpg');
    const st = safeStat(avatarFile);
    let stickers = 0;
    try {
      const j = readJson(path.join(dir, 'stickers.json'), {});
      const items = Array.isArray(j) ? j : (Array.isArray(j?.items) ? j.items : []);
      stickers = items.length;
    } catch { stickers = 0; }
    const personaFile = path.join(dir, 'persona.md');
    const pf = safeStat(personaFile);
    out.push({
      id: role,
      name: role,
      role: cur.role || '',
      displayName: String(meta.displayName || meta.nickname || role),
      nickname: String(meta.nickname || ''),
      note: String(meta.note || ''),
      source: String(meta.source || ''),
      updatedAt: String(meta.updatedAt || ''),
      avatarUrl: `/api/persona/avatar?role=${encodeURIComponent(role)}`,
      hasAvatar: Boolean(st),
      avatarBytes: st ? st.size : 0,
      stickers,
      hasPersonaMd: Boolean(pf),
      personaBytes: pf ? pf.size : 0,
      isCurrent: String(cur.role || '') === role,
      _t: st ? st.mtime.toISOString() : ''
    });
  }
  return out;
}

// ---------- 桥接 ----------
let bridgeCache = { at: 0, value: null };
export async function getBridgeStatus(force = false) {
  if (!force && Date.now() - bridgeCache.at < 15000) return bridgeCache.value;
  let value;
  const aliveByFile = () => {
    try {
      const st = fs.statSync(path.join(QB_STATE, 'qq-activity.log'));
      return Date.now() - st.mtimeMs < 180000;
    } catch { return false; }
  };
  try {
    const token = readText(path.join(QB_STATE, 'console-token')).trim();
    const res = await fetch('http://127.0.0.1:3100/api/status', {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) value = { reachable: false, httpStatus: res.status };
    else value = { reachable: true, ...(await res.json()) };
  } catch (error) {
    // 桥接在跑但 HTTP 响应慢（DSH 忙/事件循环排队）时，不要显示“离线”：用状态文件新鲜度兜底
    if (aliveByFile()) value = { reachable: true, degraded: true, error: String(error?.message ?? error) };
    else value = { reachable: false, error: String(error?.message ?? error) };
  }
  bridgeCache = { at: Date.now(), value };
  return value;
}

export async function bridgePersonas() {
  try {
    const token = readText(path.join(QB_STATE, 'console-token')).trim();
    const r = await fetch('http://127.0.0.1:3100/api/roles', { headers: { 'x-console-token': token }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { ok: false };
    const d = await r.json();
    d.roles = (d.roles || []).map((x) => ({ ...x, meta: readPersonaMeta(x.name) }));
    return d;
  } catch { return { ok: false }; }
}

// ---------- 余额 ----------
let balanceCache = { at: 0, value: null };
export async function getBalance() {
  if (Date.now() - balanceCache.at < 60000 && balanceCache.value) return balanceCache.value;
  let value;
  try {
    const cred = readText(path.join(process.env.USERPROFILE || 'C:\\Users\\Administrator', '.dsh', '.credentials.yaml'));
    const key = (cred.match(/sk-[A-Za-z0-9]+/) || [])[0];
    if (!key) throw new Error('没找到 DeepSeek API key');
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : null;
    value = {
      ok: true,
      available: data?.is_available === true,
      currency: info?.currency || 'CNY',
      total: info?.total_balance ?? null,
      granted: info?.granted_balance ?? null,
      toppedUp: info?.topped_up_balance ?? null,
      at: new Date().toISOString()
    };
  } catch (error) {
    value = { ok: false, error: String(error?.message ?? error) };
  }
  balanceCache = { at: Date.now(), value };
  return value;
}

// ---------- token 用量 ----------
const tokenCache = { at: 0, key: '', value: null };
export function tokenStats(range) {
  const cacheKey = `${range.from}|${range.to}`;
  if (tokenCache.value && tokenCache.key === cacheKey && Date.now() - tokenCache.at < 20000) return tokenCache.value;
  let lines = null;
  const rows = dbRows("SELECT raw FROM token_usage WHERE kind = 'turn' ORDER BY rowid");
  if (rows) lines = rows.map((r) => r.raw);
  if (!lines) {
    lines = readText(path.join(QB_STATE, 'token-usage.jsonl')).split(/\r?\n/).filter(Boolean);
  }
  const byDay = new Map();
  const byConv = new Map();
  const byModel = new Map();
  const allDays = new Map();
  const totals = emptyUsage();
  const today = emptyUsage();
  const todayStr = todayKey();
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.k !== 'turn') continue;
    const b = rec.b || {};
    const turnCost = priceOf(b, rec.model, rec.t);
    const at = Number(rec.t) || Date.now();
    const day = todayKey(new Date(at));
    const turnStart = Number(rec.step) === 0 || Number(rec.step) === 1;
    const model = String(rec.model || '未知');
    if (!allDays.has(day)) allDays.set(day, emptyUsage());
    addUsage(allDays.get(day), b, turnCost, turnStart);
    if (day === todayStr) addUsage(today, b, turnCost, turnStart);
    if (!inRange(day, range)) continue;
    addUsage(totals, b, turnCost, turnStart);
    if (!byDay.has(day)) byDay.set(day, emptyUsage());
    addUsage(byDay.get(day), b, turnCost, turnStart);
    if (!byModel.has(model)) byModel.set(model, Object.assign({ model }, emptyUsage()));
    addUsage(byModel.get(model), b, turnCost, turnStart);
    const key = String(rec.key || '(未知)');
    if (!byConv.has(key)) byConv.set(key, Object.assign({ key }, emptyUsage(), { lastAt: 0 }));
    const c = byConv.get(key);
    addUsage(c, b, turnCost, turnStart);
    c.lastAt = Math.max(c.lastAt, at);
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 60).map(([day, v]) => ({ day, ...v }));
  const allDayList = [...allDays.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, v]) => ({ day, ...v }));
  const convs = [...byConv.values()].sort((a, b) => b.lastAt - a.lastAt);
  const models = [...byModel.values()].sort((a, b) => b.cost - a.cost);
  const value = { totals, today, days, allDays: allDayList, convs, models };
  tokenCache.at = Date.now(); tokenCache.key = cacheKey; tokenCache.value = value;
  return value;
}

// ---------- 工具调用 ----------
const toolCache = { at: 0, key: '', value: null };
export function toolStats(range) {
  const cacheKey = `${range.from}|${range.to}`;
  if (toolCache.value && toolCache.key === cacheKey && Date.now() - toolCache.at < 20000) return toolCache.value;
  let lines = null;
  const rows = dbRows('SELECT raw FROM tool_calls ORDER BY rowid');
  if (rows) lines = rows.map((r) => r.raw);
  if (!lines) lines = readText(path.join(QB_STATE, 'tool-calls.jsonl')).split(/\r?\n/).filter(Boolean);
  const tables = new Map();
  const recent = [];
  const errors = [];
  const errDays = new Map();
  const todayErrors = new Map();
  const todayErrorList = [];
  const todayStr = todayKey();
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const tool = String(rec.tool || '');
    if (!tool) continue;
    const day = localDayOf(rec.time);
    const isResult = rec.type === 'result';
    const isError = isResult && rec.ok === false;
    if (inRange(day, range)) {
      if (!tables.has(tool)) tables.set(tool, { tool, calls: 0, ok: 0, error: 0, lastError: '' });
      const t = tables.get(tool);
      if (rec.type === 'call') t.calls += 1;
      if (isResult) {
        if (rec.ok) t.ok += 1;
        else { t.error += 1; t.lastError = String(rec.error || '').slice(0, 300); }
        const item = { time: rec.time, tool, conv: String(rec.conv || ''), ok: rec.ok !== false, error: rec.error ? String(rec.error) : '' };
        recent.push(item);
        if (isError) errors.push(item);
      }
      if (isError && day) errDays.set(day, (errDays.get(day) || 0) + 1);
    }
    if (isError && day === todayStr) {
      const e = todayErrors.get(tool) || { tool, count: 0, lastAt: '', lastError: '' };
      e.count += 1;
      if (String(rec.time || '') >= String(e.lastAt || '')) { e.lastAt = rec.time || ''; e.lastError = String(rec.error || '').slice(0, 300); }
      todayErrors.set(tool, e);
      todayErrorList.push({ time: rec.time, tool, conv: String(rec.conv || ''), error: String(rec.error || '') });
    }
  }
  const errDayList = [...errDays.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, error]) => ({ day, error }));
  const value = {
    tools: [...tables.values()].sort((a, b) => b.calls - a.calls),
    recent: recent.slice(-40).reverse(),
    errors: errors.slice(-80).reverse(),
    errDays: errDayList,
    errorsToday: [...todayErrors.values()].sort((a, b) => b.count - a.count),
    errorsTodayList: todayErrorList.slice(-60).reverse()
  };
  toolCache.at = Date.now(); toolCache.key = cacheKey; toolCache.value = value;
  return value;
}

// ---------- 审计事件 ----------
export function parseAudit(file, range) {
  const source = file.startsWith('qzone') ? 'qzone' : 'chat';
  let lines = null;
  const rows = dbRows('SELECT raw FROM audit_events WHERE source = ? ORDER BY rowid DESC LIMIT 300', source);
  if (rows) lines = rows.map((r) => r.raw);
  if (!lines) lines = tailLines(readText(path.join(QB_STATE, file)), 300).reverse();
  const out = [];
  for (const line of lines) {
    const m = /^(\S+)\s+(\{.*\})$/.exec(line);
    let item;
    if (m) {
      try { item = { time: m[1], ...JSON.parse(m[2]) }; } catch { item = { time: '', text: line }; }
    } else {
      item = { time: '', text: line };
    }
    if (!inRange(localDayOf(item.time), range)) continue;
    out.push(item);
    if (out.length >= 80) break;
  }
  return out;
}
export function auditEventRows(source = '') {
  const sql = source
    ? 'SELECT id,t,source,action,conv_key,target,detail,ok,raw FROM audit_events WHERE source = ? ORDER BY rowid DESC LIMIT 2000'
    : 'SELECT id,t,source,action,conv_key,target,detail,ok,raw FROM audit_events ORDER BY rowid DESC LIMIT 2000';
  return dbRows(sql, source) || [];
}

// ---------- 表情 ----------
export function stickers() {
  const list = readJson(path.join(QB_STATE, 'stickers.json'), []);
  return (Array.isArray(list) ? list : []).map((s) => ({
    id: s.id, md5: s.md5, desc: s.desc || '', localNote: s.localNote || '',
    tags: s.tags || [], url: s.url || '', useCount: s.useCount || 0, lastUsedAt: s.lastUsedAt || 0,
    createdAt: Date.parse(s.createdAt || '') || 0
  })).sort((a, b) => (b.createdAt || b.lastUsedAt || 0) - (a.createdAt || a.lastUsedAt || 0));
}
export function stickerPersonaMap() {
  const { map } = personaStickerMap();
  return map;
}

// ---------- 空间动作 ----------
export function qzoneEvents(limit = 200, range = null) {
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(BOT, 'qzone', 'logs', 'qzone-events.log'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-2000).reverse();
  } catch {}
  const out = [];
  for (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (!inRange(localDayOf(item.at), range)) continue;
    item.id = genId('qz', line);
    item.t = item.at || '';
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- 生图 ----------
export function imagegenConfigPath() { return path.join(BOT, 'imagegen', 'config.json'); }
export function refsDirPath() { return path.join(BOT, 'imagegen', 'refs', '流萤'); }
export function saveImagegenConfig(patch) {
  let cfg = {};
  try { cfg = JSON.parse(readText(imagegenConfigPath())); } catch {}
  const next = { ...cfg, ...patch };
  fs.writeFileSync(imagegenConfigPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}
export function updateRefNote(file, policySafe) {
  const p = path.join(refsDirPath(), 'refs-memory.json');
  let mem = {};
  try { mem = JSON.parse(readText(p)); } catch { mem = { images: [] }; }
  const list = Array.isArray(mem.images) ? mem.images : [];
  const idx = list.findIndex((x) => x && x.file === file);
  if (idx >= 0) list[idx].policySafe = policySafe === true;
  else list.push({ file, policySafe: policySafe === true });
  mem.images = list; mem.updatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(mem, null, 2), 'utf8');
}
export function genImages(limit = 120) {
  try {
    return fs.readdirSync(IMAGEGEN_DIR)
      .filter((f) => /^gen-\d+\.(jpe?g|png|webp)$/i.test(f))
      .map((f) => { const st = fs.statSync(path.join(IMAGEGEN_DIR, f)); return { name: f, mtime: st.mtimeMs, bytes: st.size }; })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch { return []; }
}
export function refsData() {
  let cfg = {};
  try { cfg = JSON.parse(readText(imagegenConfigPath())); } catch {}
  let mem = {};
  try { mem = JSON.parse(readText(path.join(refsDirPath(), 'refs-memory.json'))); } catch {}
  const byFile = new Map((mem.images || []).map((x) => [x.file, x]));
  let files = [];
  try {
    files = fs.readdirSync(refsDirPath()).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
      .map((f) => ({ name: f, ...(byFile.get(f) || {}) }));
  } catch {}
  return { files, config: { model: cfg.model || '', refsCount: Number(cfg.refsCount) || 0, size: cfg.size || '', provider: cfg.provider || '' } };
}

// ---------- B 站 / 抖音 / 文件事件 ----------
export function biliNotes(limit = 300, range = null) {
  const rows = dbRows('SELECT id,t,bvid,title,up,note FROM bili_notes ORDER BY rowid DESC LIMIT 800');
  if (!rows) return [];
  return rows.filter((r) => inRange(localDayOf(r.t), range)).slice(0, limit);
}
export function douyinEvents(limit = 200, range = null) {
  const rows = dbRows('SELECT id,t,action,aweme_id,title,author,detail,ok,error FROM douyin_events ORDER BY rowid DESC LIMIT 800');
  if (!rows) return [];
  return rows.filter((r) => inRange(localDayOf(r.t), range)).slice(0, limit);
}
export function biliEvents(limit = 200, range = null) {
  const rows = dbRows('SELECT id,t,action,bvid,title,up,detail,ok,error FROM bili_events ORDER BY rowid DESC LIMIT 800');
  if (!rows) return [];
  return rows.filter((r) => inRange(localDayOf(r.t), range)).slice(0, limit);
}

// ---------- 记忆库 ----------
export const MEMORY_DOC_DEFS = [
  { id: 'memory', name: '记忆库', rel: '记忆库.md', kind: 'memory' },
  { id: 'long-memory', name: '长记忆', rel: '长记忆.md', kind: 'memory' },
  { id: 'next-plan', name: '下一步计划', rel: '下一步计划.md', kind: 'plan' },
  { id: 'agent-rules', name: 'Agent操作规范', rel: 'Agent操作规范.md', kind: 'rules' }
];
export function memoryDocs() {
  const docs = MEMORY_DOC_DEFS.map((d) => [d.name, path.join(BOT, d.rel)]);
  try {
    const dir = path.join(BOT, '日报');
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
    if (files.length) docs.push([`日报 ${files[files.length - 1].slice(0, 10)}`, path.join(dir, files[files.length - 1])]);
  } catch {}
  return docs.map(([name, p]) => ({ name, content: readText(p, '（文件不存在）') }));
}
export function memoryDocList() {
  const out = [];
  for (const def of MEMORY_DOC_DEFS) {
    const p = path.join(BOT, def.rel);
    const st = safeStat(p);
    const text = readText(p, '');
    out.push({
      id: def.id,
      name: def.name,
      kind: def.kind,
      path: p,
      bytes: st ? st.size : 0,
      mtime: st ? st.mtime.toISOString() : '',
      lines: text ? text.split('\n').length : 0,
      preview: text.replace(/\s+/g, ' ').slice(0, 160),
      exists: Boolean(st)
    });
  }
  try {
    const dir = path.join(BOT, '日报');
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse();
    for (const f of files.slice(0, 10)) {
      const p = path.join(dir, f);
      const st = safeStat(p);
      const text = readText(p, '');
      out.push({
        id: `daily-${f.slice(0, 10)}`,
        name: `日报 ${f.slice(0, 10)}`,
        kind: 'daily',
        path: p,
        bytes: st ? st.size : 0,
        mtime: st ? st.mtime.toISOString() : '',
        lines: text.split('\n').length,
        preview: text.replace(/\s+/g, ' ').slice(0, 160),
        exists: true
      });
    }
  } catch {}
  return out;
}

// ---------- 生活 / 自由时间 ----------
export function freeTimeEvents(limit = 60, range = null) {
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(BOT, 'state', 'free-time.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-1000).reverse();
  } catch {}
  const out = [];
  for (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (!inRange(localDayOf(item.at), range)) continue;
    item.id = genId('ft', line);
    item.t = item.at || '';
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export function lifeData() {
  let books = [];
  try {
    books = fs.readdirSync(path.join(BOT, 'books'))
      .filter((f) => /\.txt$/i.test(f))
      .map((f) => {
        try { const st = fs.statSync(path.join(BOT, 'books', f)); return { name: f, size: st.size, mtime: st.mtime.toISOString() }; } catch { return null; }
      })
      .filter(Boolean);
  } catch {}
  let features = [];
  try { features = tailLines(readText(path.join(BOT, '功能需求.md')), 60); } catch {}
  const sleepPlan = readJson(path.join(BOT, 'state', 'sleep-plan.json'), null);
  const profileRate = readJson(path.join(BOT, 'state', 'profile-rate.json'), null);
  let surfNotes = [];
  try {
    surfNotes = fs.readdirSync(path.join(BOT, '学习'))
      .filter((f) => /\.md$/i.test(f))
      .map((f) => { try { const st = fs.statSync(path.join(BOT, '学习', f)); return { name: f, size: st.size, mtime: st.mtime.toISOString() }; } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
      .slice(0, 30);
  } catch {}
  let fsEvents = [];
  try { fsEvents = dbRows('SELECT t,op,path,bytes,ok FROM fs_events ORDER BY t DESC LIMIT 40') || []; } catch {}
  let freeTime = [];
  try {
    freeTime = fs.readFileSync(path.join(BOT, 'state', 'free-time.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-40)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).reverse();
  } catch {}
  const sleepCheckState = readJson(path.join(QB_STATE, 'sleep-check.json'), null);
  const freeTimeState = readJson(path.join(QB_STATE, 'free-time.json'), null);
  let surfLog = [];
  try {
    surfLog = fs.readFileSync(path.join(BOT, 'state', 'surf-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-80)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).reverse();
  } catch {}
  const surfState = readJson(path.join(QB_STATE, 'web-surf.json'), null);
  return { books, features, sleepPlan, profileRate, surfNotes, surfState, surfLog, fsEvents, freeTime, freeTimeState, sleepCheckState };
}

// ---------- meta ----------
export function meta() {
  const cfg = readJson(path.join(QB, 'config.json'), {});
  const social = readJson(path.join(QB_STATE, 'social-v2.json'), { paused: false, conversations: {} });
  const project = readJson(path.join(BOT, 'VERSION.json'), { name: 'Synapse 3', version: '3.1.5' });
  let dbStats = null;
  try {
    const one = (sql) => Number(dbOne(sql)?.c || 0);
    dbStats = {
      path: 'audit/audit.db',
      bytes: (() => { try { return fs.statSync(path.join(BOT, 'audit', 'audit.db')).size; } catch { return 0; } })(),
      tokens: one('SELECT COUNT(*) AS c FROM token_usage'),
      tools: one('SELECT COUNT(*) AS c FROM tool_calls'),
      activity: one('SELECT COUNT(*) AS c FROM activity'),
      audits: one('SELECT COUNT(*) AS c FROM audit_events')
    };
  } catch {}
  return {
    mode: cfg.mode || readJson(path.join(QB_STATE, 'mode.json'), {}).mode || '',
    role: readJson(path.join(QB_STATE, 'current-role.json'), {}).role || '',
    ownerQQ: cfg.ownerQQ || null,
    allowPrivate: cfg.allow?.private || [],
    allowGroups: cfg.allow?.groups || [],
    conversations: Object.keys(social.conversations || {}),
    paused: social.paused === true,
    project: { name: project.name || 'Synapse 3', version: project.version || '' },
    db: dbStats,
    now: localTimeStr(new Date())
  };
}

// ---------- 最近活动 ----------
export function recentActivity(limit = 40) {
  const rows = dbRows('SELECT t,conv_key,text,ingested_at FROM activity ORDER BY rowid DESC LIMIT ?', limit) || [];
  return rows.map((r) => ({
    t: r.ingested_at || r.t,
    clock: r.t,
    tLocal: localTimeStr(r.ingested_at || r.t),
    conv: r.conv_key,
    text: String(r.text || '')
  }));
}
