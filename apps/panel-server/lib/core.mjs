// Synapse 3 面板后端 · 基础层
// 路径常量 / 文件与时间工具 / SQLite 只读句柄 / 价目表 / 告警配置
import { HOME, BRIDGE_ROOT, BRIDGE_STATE, DB_FILE, GEN_IMAGES_DIR, PANEL_UI_DIST, LOGS } from '../../../packages/paths/index.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
// 价目表是桥接的单一真源，面板只读引用（同仓相对路径，换机不受影响）
import { priceUsage, resolvePriceTable } from '../../bridge/src/model-prices.js';

export { priceUsage };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PANEL_DIR = path.resolve(HERE, '..');
export const BOT = HOME;
export const QB = BRIDGE_ROOT;
export const QB_STATE = BRIDGE_STATE;
export const DB_PATH = DB_FILE;
export const IMAGEGEN_DIR = GEN_IMAGES_DIR;
export const UI_DIST = process.env.PANEL_UI_DIST ? path.resolve(process.env.PANEL_UI_DIST) : PANEL_UI_DIST;
export const LOG_DIR = path.join(LOGS, 'panel');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
export const PORT = Number(process.env.PANEL_PORT || 3120);
export const HOST = '127.0.0.1';
export const STARTED_AT = Date.now();
export const TZ = 'Asia/Shanghai';

// ---------- 文件 ----------
export function readText(p, fallback = '') {
  try {
    const buf = fs.readFileSync(p);
    let text = buf.toString('utf8');
    const bad = (text.match(/\uFFFD/g) || []).length;
    if (bad > 5) text = new TextDecoder('gb18030').decode(buf);
    return text;
  } catch {
    return fallback;
  }
}
export function readJson(p, fallback = null) {
  try { return JSON.parse(readText(p)); } catch { return fallback; }
}
export function writeJson(p, value) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(value, null, 2), 'utf8'); return true; } catch { return false; }
}
export function tailLines(text, n = 100) {
  return String(text).split(/\r?\n/).filter(Boolean).slice(-n);
}
export function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}
export function fileInfo(p) {
  const st = safeStat(p);
  return st ? { path: p, bytes: st.size, mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs } : null;
}
export function genId(prefix, text) {
  return `${prefix}-${crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16)}`;
}
export function versionInfo() {
  const v = readJson(path.join(BOT, 'VERSION.json'), {});
  return { name: v.name || 'Synapse 3', version: v.version || '0.0.0', updatedAt: v.updatedAt || '' };
}

// ---------- 时间（统一 Asia/Shanghai）----------
export function todayKey(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: TZ });
}
export function localTimeStr(v) {
  if (v == null || v === '') return '';
  let d;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
    const n = Number(v);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('sv-SE', { timeZone: TZ });
}
export function localDayOf(v) {
  const s = localTimeStr(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}
export function isoNow() { return new Date().toISOString(); }
export function dayList(n = 7) {
  const out = [];
  const base = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    out.push(todayKey(d));
  }
  return out;
}

// ---------- 日期范围（北京时间自然日）----------
export function parseRange(sp) {
  const ok = (s) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(s || ''));
  const from = ok(sp.get('from')) ? String(sp.get('from')) : '';
  const to = ok(sp.get('to')) ? String(sp.get('to')) : '';
  return { from, to, active: Boolean(from || to) };
}
export function inRange(day, range) {
  if (!range || !range.active) return true;
  if (!day) return false;
  if (range.from && day < range.from) return false;
  if (range.to && day > range.to) return false;
  return true;
}

// ---------- 用量聚合 ----------
export function emptyUsage() {
  return { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0, steps: 0, turns: 0, cost: 0 };
}
export function addUsage(target, b, cost, turnStart) {
  target.cacheMiss += Number(b.cacheMiss) || 0;
  target.cacheHit += Number(b.cacheHit) || 0;
  target.cacheWrite += Number(b.cacheWrite) || 0;
  target.output += Number(b.output) || 0;
  target.reasoning += Number(b.reasoning) || 0;
  target.steps += 1;
  target.cost += Number(cost) || 0;
  if (turnStart) target.turns += 1;
}
export function sumUsage(list) {
  const out = emptyUsage();
  for (const item of list || []) {
    for (const k of ['cacheMiss', 'cacheHit', 'cacheWrite', 'output', 'reasoning', 'steps', 'turns', 'cost']) out[k] += Number(item[k]) || 0;
  }
  return out;
}

// ---------- HTTP 小工具 ----------
export function sendJson(res, code, obj, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(obj));
}
export function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}
export function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > limit) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => resolve(b || '{}'));
    req.on('error', reject);
  });
}

// ---------- SQLite ----------
let db = null;
try { db = new DatabaseSync(DB_PATH, { readOnly: true }); } catch { db = null; }
export function getDb() { return db; }
export function dbRows(sql, ...params) {
  if (!db) return null;
  try { return db.prepare(sql).all(...params); } catch { return null; }
}
export function dbOne(sql, ...params) {
  if (!db) return null;
  try { return db.prepare(sql).get(...params) ?? null; } catch { return null; }
}
export function dbCount(table) {
  const r = dbOne(`SELECT COUNT(*) AS c FROM ${table}`);
  return r ? Number(r.c) : 0;
}
export function dbBytes() {
  const st = safeStat(DB_PATH);
  return st ? st.size : 0;
}

// ---------- 价目表 ----------
const PRICE_TABLE = resolvePriceTable(readJson(path.join(QB, 'config.json'), {}).pricing ?? null);
export function priceTable() { return PRICE_TABLE; }
export function priceOf(buckets, model, at) {
  try {
    return priceUsage(buckets, { model, at: Number(at) || Date.now(), table: PRICE_TABLE }).cost.total;
  } catch { return 0; }
}

// ---------- 告警配置 ----------
export const ALERT_DEFAULTS = { dailyCostWarn: 5, balanceWarn: 3, errorWarn: 50, monthlyBudget: 30 };
export function alertsConfig() {
  const raw = readJson(path.join(PANEL_DIR, 'alerts.json'), {});
  const cfg = Object.assign({}, ALERT_DEFAULTS);
  for (const k of Object.keys(ALERT_DEFAULTS)) {
    const n = Number(raw?.[k]);
    if (Number.isFinite(n) && n >= 0) cfg[k] = n;
  }
  return cfg;
}
export function saveAlertsConfig(patch) {
  const cfg = alertsConfig();
  for (const k of Object.keys(ALERT_DEFAULTS)) {
    if (!(k in patch)) continue;
    const n = Number(patch[k]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k} 需要非负数字`);
    cfg[k] = Math.min(100000, Math.round(n * 1000) / 1000);
  }
  writeJson(path.join(PANEL_DIR, 'alerts.json'), cfg);
  return cfg;
}
export function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(path.join(LOG_DIR, 'panel-debug.log'), line + '\n', 'utf8'); } catch {}
  console.log(line);
}
export { os };
