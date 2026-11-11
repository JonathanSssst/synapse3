// Synapse 3 面板后端 · 桌宠
// 读取桌宠状态/屏幕陪看配置/活动记录，并把桌宠陪看的 token 用量汇总成面板数据。
// 只写 desktop-pet/data/settings.json；桌宠自身会 1 秒内热重载，不需要重启。
import fs from 'node:fs';
import path from 'node:path';
import { BOT, QB_STATE, readJson, readText, logLine } from './core.mjs';

const PET_DIR = path.join(BOT, 'desktop-pet');
const SETTINGS_PATH = path.join(PET_DIR, 'data', 'settings.json');
const WINDOW_PATH = path.join(PET_DIR, 'data', 'window.json');
const ACTIVITY_PATH = path.join(QB_STATE, 'activity-log.jsonl');
const BRIDGE = 'http://127.0.0.1:3100';
const PET = 'http://127.0.0.1:3135';
const TOKEN_KEY = 'internal:桌宠陪看';

function bridgeToken() {
  return readText(path.join(QB_STATE, 'console-token')).trim();
}

async function getJson(base, pathname, timeout = 6000) {
  const headers = base === BRIDGE && bridgeToken() ? { 'x-console-token': bridgeToken() } : {};
  const res = await fetch(base + pathname, { headers, signal: AbortSignal.timeout(timeout), cache: 'no-store' });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function clampInt(v, min, max, fallback) {
  return Math.round(clampNum(v, min, max, fallback));
}
function asBool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

function readPetSettings() {
  const raw = readJson(SETTINGS_PATH, {}) || {};
  const sense = raw.screenSense && typeof raw.screenSense === 'object' ? raw.screenSense : {};
  return {
    ...raw,
    role: String(raw.role || '大肥鱼女友版'),
    width: clampInt(raw.width, 160, 800, 320),
    height: clampInt(raw.height, 220, 1200, 460),
    alwaysOnTop: asBool(raw.alwaysOnTop, true),
    clickThrough: asBool(raw.clickThrough, false),
    idleSleepSec: clampInt(raw.idleSleepSec, 10, 3600, 180),
    screenSense: {
      enabled: asBool(sense.enabled, true),
      auto: asBool(sense.auto, true),
      intervalMs: clampInt(sense.intervalMs, 1000, 60000, 4000),
      threshold: clampNum(sense.threshold, 0.005, 0.5, 0.03),
      cooldownMs: clampInt(sense.cooldownMs, 10000, 600000, 90000),
      maxWidth: clampInt(sense.maxWidth, 640, 3840, 1280),
      maxPerHour: clampInt(sense.maxPerHour, 1, 120, 12),
      quietUntil: Math.max(0, Number(sense.quietUntil) || 0)
    }
  };
}

function writeSettings(next) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = SETTINGS_PATH + '.panel.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_PATH);
}

function readActivity(limit = 200) {
  const out = [];
  try {
    const raw = fs.readFileSync(ACTIVITY_PATH, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item && Number.isFinite(Number(item.ts))) out.push(item);
      } catch {}
    }
  } catch { /* 还没有记录 */ }
  out.sort((a, b) => Number(b.ts) - Number(a.ts));
  return out.slice(0, Math.max(1, Math.min(500, limit))).map((item) => ({
    ts: Number(item.ts),
    time: new Date(Number(item.ts)).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' '),
    role: String(item.role || ''),
    title: String(item.title || ''),
    text: String(item.text || ''),
    looked: item.looked === true
  }));
}

function tokensFromBuckets(b = {}) {
  return ['cacheMiss', 'cacheHit', 'cacheWrite', 'output', 'reasoning']
    .reduce((sum, k) => sum + (Number(b[k]) || 0), 0);
}

function dayKey(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(n));
}

function dayLabel(key) {
  return key ? key.slice(5) : '';
}

async function buildTokenUsage() {
  try {
    const conv = await getJson(BRIDGE, `/api/tokens/turns?key=${encodeURIComponent(TOKEN_KEY)}&limit=500`, 8000);
    const rows = Array.isArray(conv?.turns) ? conv.turns : [];
    const totalTokens = tokensFromBuckets(conv?.buckets || {});
    const today = dayKey(Date.now());
    const todayRows = rows.filter((r) => dayKey(r.startedAt) === today);
    const dayMap = new Map();
    for (let i = 6; i >= 0; i -= 1) {
      const k = dayKey(Date.now() - i * 86400000);
      dayMap.set(k, { day: dayLabel(k), date: k, tokens: 0, cost: 0, calls: 0 });
    }
    for (const row of rows) {
      const k = dayKey(row.startedAt);
      const bucket = dayMap.get(k);
      if (!bucket) continue;
      bucket.tokens += tokensFromBuckets(row.buckets || {});
      bucket.cost += Number(row.cost) || 0;
      bucket.calls += 1;
    }
    return {
      ok: true,
      key: TOKEN_KEY,
      label: '桌宠陪看',
      total: {
        tokens: totalTokens,
        cost: Number(conv?.cost) || 0,
        calls: rows.length,
        turns: Number(conv?.turns) || rows.length
      },
      today: {
        tokens: todayRows.reduce((s, r) => s + tokensFromBuckets(r.buckets || {}), 0),
        cost: todayRows.reduce((s, r) => s + (Number(r.cost) || 0), 0),
        calls: todayRows.length
      },
      days: [...dayMap.values()],
      recent: rows.slice(0, 40).map((r) => ({
        time: new Date(Number(r.startedAt) || Date.now()).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' '),
        turn: r.turn,
        model: r.model || '',
        tokens: tokensFromBuckets(r.buckets || {}),
        cost: Number(r.cost) || 0,
        steps: Number(r.steps) || 0
      })),
      note: Number(conv?.unattributedCost) > 0 ? '部分历史用量只有累计值，无法拆到逐轮' : ''
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), total: { tokens: 0, cost: 0, calls: 0, turns: 0 }, today: { tokens: 0, cost: 0, calls: 0 }, days: [], recent: [] };
  }
}

export async function buildPetOverview() {
  const settings = readPetSettings();
  const [petState, senseState, tokenUsage] = await Promise.all([
    getJson(PET, '/state', 2500).catch((e) => ({ ok: false, error: String(e?.message || e) })),
    getJson(PET, '/sense/state', 2500).catch((e) => ({ ok: false, error: String(e?.message || e) })),
    buildTokenUsage()
  ]);
  const activity = readActivity(120);
  return {
    ok: true,
    generatedAt: Date.now(),
    settings,
    status: {
      online: Boolean(petState?.ok || senseState?.ok),
      pet: petState,
      sense: senseState
    },
    window: readJson(WINDOW_PATH, null),
    activity,
    tokens: tokenUsage,
    paths: { settings: SETTINGS_PATH, window: WINDOW_PATH, activity: ACTIVITY_PATH }
  };
}

export function savePetSettings(patch = {}) {
  const current = readPetSettings();
  const source = patch && typeof patch === 'object' ? patch : {};
  const next = { ...current };

  if (source.role !== undefined) next.role = String(source.role || current.role).slice(0, 60);
  if (source.width !== undefined) next.width = clampInt(source.width, 160, 800, current.width);
  if (source.height !== undefined) next.height = clampInt(source.height, 220, 1200, current.height);
  if (source.alwaysOnTop !== undefined) next.alwaysOnTop = asBool(source.alwaysOnTop, current.alwaysOnTop);
  if (source.clickThrough !== undefined) next.clickThrough = asBool(source.clickThrough, current.clickThrough);
  if (source.idleSleepSec !== undefined) next.idleSleepSec = clampInt(source.idleSleepSec, 10, 3600, current.idleSleepSec);

  const sensePatch = source.screenSense && typeof source.screenSense === 'object' ? source.screenSense : {};
  const sense = { ...current.screenSense };
  if (sensePatch.enabled !== undefined) sense.enabled = asBool(sensePatch.enabled, sense.enabled);
  if (sensePatch.auto !== undefined) sense.auto = asBool(sensePatch.auto, sense.auto);
  if (sensePatch.intervalMs !== undefined) sense.intervalMs = clampInt(sensePatch.intervalMs, 1000, 60000, sense.intervalMs);
  if (sensePatch.threshold !== undefined) sense.threshold = clampNum(sensePatch.threshold, 0.005, 0.5, sense.threshold);
  if (sensePatch.cooldownMs !== undefined) sense.cooldownMs = clampInt(sensePatch.cooldownMs, 10000, 600000, sense.cooldownMs);
  if (sensePatch.maxWidth !== undefined) sense.maxWidth = clampInt(sensePatch.maxWidth, 640, 3840, sense.maxWidth);
  if (sensePatch.maxPerHour !== undefined) sense.maxPerHour = clampInt(sensePatch.maxPerHour, 1, 120, sense.maxPerHour);
  next.screenSense = sense;

  writeSettings(next);
  logLine(`pet settings saved: ${next.width}x${next.height}, sense=${sense.enabled ? 'on' : 'off'}, auto=${sense.auto ? 'on' : 'off'}`);
  return { ok: true, settings: next };
}
