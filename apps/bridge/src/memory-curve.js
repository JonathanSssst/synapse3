// 遗忘曲线记忆 · 纯函数（无 IO）
// R(t)=exp(-Δt/(strength*tauDays))；strength=1+importance；回忆 boost；pin 不衰减。

export const DAY_MS = 24 * 60 * 60 * 1000;

export const KIND_WEIGHT = Object.freeze({
  boundary: 1.3,
  relationship: 1.2,
  preference: 1.1,
  promise: 1.1,
  fact: 1.0,
  event: 0.9,
  emotion: 0.8
});

export const KIND_IMPORTANCE = Object.freeze({
  boundary: 0.9,
  relationship: 0.8,
  promise: 0.7,
  preference: 0.7,
  fact: 0.6,
  event: 0.5,
  emotion: 0.4
});

export function defaultImportance(kind) {
  return KIND_IMPORTANCE[String(kind || 'fact')] ?? 0.6;
}

export function kindWeight(kind) {
  return KIND_WEIGHT[String(kind || 'fact')] ?? 1.0;
}

export function retention(entry, now = Date.now(), tauDays = 7) {
  if (entry?.pin) return 1;
  const last = Number(entry?.lastRecallAt || entry?.createdAt || now);
  const dt = Math.max(0, (now - last) / DAY_MS);
  const strength = Math.max(0.2, Number(entry?.strength) || (1 + Number(entry?.importance || 0)));
  const tau = Math.max(0.5, Number(tauDays) || 7);
  return Math.exp(-dt / (strength * tau));
}

export function effectiveWeight(entry, now = Date.now(), tauDays = 7) {
  const imp = Math.min(1, Math.max(0, Number(entry?.importance) || 0));
  return retention(entry, now, tauDays) * (0.5 + 0.5 * imp) * kindWeight(entry?.kind);
}

export function shouldForget(entry, now, tauDays, threshold) {
  if (!entry || entry.pin || entry.deleted || entry.forgotten) return false;
  return retention(entry, now, tauDays) < Math.max(0, Number(threshold) || 0.15);
}

export function applyDecay(entry, now, tauDays, threshold) {
  if (shouldForget(entry, now, tauDays, threshold)) {
    entry.forgotten = true;
    entry.forgottenAt = new Date(now).toISOString();
    return true;
  }
  return false;
}

export function boostOnRecall(entry, now, boost = 1.5, strengthMax = 6) {
  const b = Math.max(1, Number(boost) || 1.5);
  const max = Math.max(1, Number(strengthMax) || 6);
  const base = Number(entry.strength) || (1 + Number(entry.importance || 0));
  entry.strength = Math.min(max, base * b);
  entry.lastRecallAt = now;
  entry.recallCount = Number(entry.recallCount || 0) + 1;
  if (entry.forgotten) {
    entry.forgotten = false;
    entry.revivedAt = new Date(now).toISOString();
  }
}

function isCjk(ch) {
  return /[\u3400-\u9fff]/.test(ch);
}

export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
  let run = '';
  const flush = () => {
    if (!run) return;
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2));
    run = '';
  };
  for (const ch of s) {
    if (isCjk(ch)) run += ch;
    else flush();
  }
  flush();
  return out;
}

export function similarity(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export function sortForInjection(entries) {
  return [...entries].sort((a, b) => {
    if (Boolean(b.pin) !== Boolean(a.pin)) return b.pin ? 1 : -1;
    const wa = Number(a.__weight ?? 0);
    const wb = Number(b.__weight ?? 0);
    if (wb !== wa) return wb - wa;
    return String(a.id).localeCompare(String(b.id));
  });
}

const KIND_LABEL = { boundary: '边界', relationship: '关系', preference: '偏好', promise: '约定', fact: '事实', event: '事件', emotion: '情绪' };

export function formatContext(entries, { maxChars = 900, maxItems = 8 } = {}) {
  const picked = [];
  let used = 0;
  for (const e of entries) {
    if (picked.length >= maxItems) break;
    const line = `- [${KIND_LABEL[e.kind] || '记忆'}] ${String(e.content || '').replace(/\s+/g, ' ').trim()}`;
    if (used + line.length > maxChars && picked.length > 0) break;
    picked.push(line);
    used += line.length + 1;
  }
  if (!picked.length) return '';
  return `【长期记忆（你自己记住的事）】\n${picked.join('\n')}`;
}
