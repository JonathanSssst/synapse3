// 角色状态系统 · 精力 / 饱食 / 心情 / 健康（0~100）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state', 'vitals');
const TL_KEEP_MS = 7 * 24 * 3600 * 1000;

export const VITALS_DEFAULTS = Object.freeze({
  enabled: true,
  tickMinutes: 5,
  baseline: { energy: 60, satiety: 50, mood: 60, health: 80 },
  decayPerHour: { energy: 4, satiety: 5, moodTauHours: 6 },
  sleep: { recoverEnergyPerHour: 15 },
  timelineKeepDays: 7
});

export function vitalsCfg(cfg) {
  const raw = cfg?.vitals;
  const out = { ...VITALS_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  out.baseline = { ...VITALS_DEFAULTS.baseline, ...(out.baseline || {}) };
  out.decayPerHour = { ...VITALS_DEFAULTS.decayPerHour, ...(out.decayPerHour || {}) };
  out.sleep = { ...VITALS_DEFAULTS.sleep, ...(out.sleep || {}) };
  return out;
}

function pad(n) { return String(n).padStart(2, '0'); }
export function dateCN(ms = Date.now()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
export function sanitizeRole(role) { return String(role || 'default').replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_').slice(0, 80) || 'default'; }
function roleStatePath(role) { return path.join(STATE_DIR, sanitizeRole(role) + '.json'); }
function roleTimelinePath(role) { return path.join(STATE_DIR, sanitizeRole(role) + '-timeline.jsonl'); }
function roleEventsPath(role) { return path.join(STATE_DIR, sanitizeRole(role) + '-events.jsonl'); }

function clamp(v) { return Math.min(100, Math.max(0, Number(v) || 0)); }
function round(v) { return Math.round(Number(v) * 10) / 10; }

export function loadVitals(role, cfg) {
  const m = vitalsCfg(cfg);
  let st = null;
  try { st = JSON.parse(fs.readFileSync(roleStatePath(role), 'utf8')); } catch {}
  const now = Date.now();
  st = st || { role, energy: m.baseline.energy, satiety: m.baseline.satiety, mood: m.baseline.mood, health: m.baseline.health, lastTickAt: now, createdAt: now, sleep: false };
  for (const k of ['energy', 'satiety', 'mood', 'health']) st[k] = clamp(st[k] ?? m.baseline[k]);
  if (!st.lastTickAt) st.lastTickAt = now;
  return st;
}

export function saveVitals(role, st) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(roleStatePath(role), JSON.stringify(st, null, 2), 'utf8');
}

function isSleepHour(now = new Date()) {
  const h = now.getHours();
  return h >= 23 || h < 7;
}

function applyTime(st, cfg, now = Date.now()) {
  const m = vitalsCfg(cfg);
  const dtH = Math.min(24, Math.max(0, (now - Number(st.lastTickAt || now)) / 3600000));
  if (dtH <= 0) return st;
  const sleeping = isSleepHour(new Date(now));
  st.sleep = sleeping;
  const b = m.baseline;
  const energyRate = sleeping ? Number(m.sleep.recoverEnergyPerHour) || 15 : -(Number(m.decayPerHour.energy) || 4);
  st.energy = clamp(st.energy + energyRate * dtH);
  st.satiety = clamp(st.satiety - (sleeping ? 2 : Number(m.decayPerHour.satiety) || 5) * dtH);
  // 心情向基线回归（指数）
  const tau = Math.max(0.5, Number(m.decayPerHour.moodTauHours) || 6);
  st.mood = clamp(b.mood + (st.mood - b.mood) * Math.exp(-dtH / tau));
  // 健康：长期饿/累会掉，否则缓慢恢复
  const starving = st.satiety < 20 || st.energy < 20;
  st.health = clamp(st.health + (starving ? -0.8 : 0.15) * dtH);
  st.lastTickAt = now;
  st.updatedAt = new Date(now).toISOString();
  return st;
}

export function tickRole({ role, cfg, now = Date.now(), snapshot = true }) {
  const st = applyTime(loadVitals(role, cfg), cfg, now);
  saveVitals(role, st);
  if (snapshot) appendTimeline(role, st, now);
  return st;
}

export function appendTimeline(role, st, now = Date.now()) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const line = JSON.stringify({ t: now, energy: round(st.energy), satiety: round(st.satiety), mood: round(st.mood), health: round(st.health), sleep: Boolean(st.sleep) });
    fs.appendFileSync(roleTimelinePath(role), line + '\n', 'utf8');
    trimTimeline(role);
  } catch {}
}

export function trimTimeline(role, now = Date.now()) {
  const file = roleTimelinePath(role);
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    const kept = [];
    for (const line of lines) {
      try { const o = JSON.parse(line); if (Number(o.t) >= now - TL_KEEP_MS) kept.push(line); } catch {}
    }
    if (kept.length !== lines.length) fs.writeFileSync(file, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
  } catch {}
}

export const EVENT_RULES = Object.freeze({
  owner_msg: { delta: { mood: 0.8, energy: -0.1 }, label: '主人消息' },
  group_msg: { delta: { energy: -0.2 }, label: '群消息' },
  self_msg: { delta: { energy: -0.3 }, label: '她发言' },
  meal: { delta: { satiety: 25, mood: 3, energy: 1 }, label: '吃饭' },
  praised: { delta: { mood: 6, energy: 1 }, label: '被夸' },
  ignored: { delta: { mood: -5 }, label: '被冷落' },
  conflict: { delta: { mood: -12, energy: -3 }, label: '闹别扭' },
  comforted: { delta: { mood: 8 }, label: '被哄好' },
  tired: { delta: { energy: -8 }, label: '累了' },
  sick: { delta: { health: -12, energy: -15 }, label: '不舒服' },
  sleep_start: { delta: { mood: 2 }, label: '睡觉' },
  sleep_wake: { delta: { mood: 3 }, label: '睡醒' }
});

export function applyVitalsEvent({ role, cfg, type, label = '', source = '', delta = null, now = Date.now() }) {
  const rule = EVENT_RULES[type];
  if (!rule && !delta) throw new Error('未知事件类型：' + type);
  const st = applyTime(loadVitals(role, cfg), cfg, now);
  const d = delta || rule.delta || {};
  for (const [k, v] of Object.entries(d)) {
    if (['energy', 'satiety', 'mood', 'health'].includes(k)) st[k] = clamp(st[k] + Number(v));
  }
  st.updatedAt = new Date(now).toISOString();
  saveVitals(role, st);
  const ev = { t: now, type, label: label || rule?.label || type, delta: d, source: String(source || '') };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(roleEventsPath(role), JSON.stringify(ev) + '\n', 'utf8');
  } catch {}
  appendTimeline(role, st, now);
  return { state: st, event: ev };
}

export function readTimeline(role, day) {
  const target = day || dateCN();
  const out = [];
  try {
    for (const line of fs.readFileSync(roleTimelinePath(role), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (dateCN(Number(o.t)) === target) out.push(o);
      } catch {}
    }
  } catch {}
  return out;
}

export function readEvents(role, day) {
  const target = day || dateCN();
  const out = [];
  try {
    for (const line of fs.readFileSync(roleEventsPath(role), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (dateCN(Number(o.t)) === target) out.push(o);
      } catch {}
    }
  } catch {}
  return out;
}

export function vitalsText(st) {
  const parts = [];
  const band = (v, low, high, lowText, highText, midText) => (v < low ? lowText : v > high ? highText : midText);
  parts.push('精力' + band(st.energy, 30, 75, '偏低，有点累', '不错', '还行'));
  parts.push('饱食' + band(st.satiety, 25, 70, '饿了', '很饱', '一般'));
  parts.push('心情' + band(st.mood, 30, 75, '闷闷的', '很好', '平稳'));
  if (st.health < 40) parts.push('身体有点不舒服');
  return `【你现在的状态】${parts.join('；')}。说话时自然流露，不要直接报数值。`;
}

export function personaRoles() {
  try {
    const dir = path.join(ROOT, 'personas');
    return fs.readdirSync(dir).filter((name) => { try { return fs.existsSync(path.join(dir, name, 'persona.md')); } catch { return false; } });
  } catch { return []; }
}
