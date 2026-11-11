// 遗忘曲线记忆 · 服务层
import crypto from 'node:crypto';
import {
  loadStore, saveStore, appendAudit, computeStats, personaRoles
} from './memory-store.js';
import {
  DAY_MS, defaultImportance, retention, effectiveWeight, shouldForget, applyDecay,
  boostOnRecall, similarity, sortForInjection, formatContext
} from './memory-curve.js';

export const MEMORY_DEFAULTS = Object.freeze({
  enabled: true,
  tauDays: 7,
  threshold: 0.15,
  boost: 1.5,
  strengthMax: 6,
  injectMaxItems: 8,
  injectMaxChars: 900,
  recallK: 5,
  pinMax: 12,
  autoExtract: false,
  decayHour: 4,
  maxEntriesPerPersona: 2000,
  defaultVisibility: 'shared'
});

export function memoryCfg(cfg) {
  const raw = cfg?.memory;
  return { ...MEMORY_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
}

function clip(text, n = 500) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

function newId() {
  return 'mem_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

function visibleFor(entry, key, cfg, isSharedKey, { deep = false } = {}) {
  if (!entry || entry.deleted) return false;
  if (entry.supersededBy) return false;
  if (entry.forgotten && !deep) return false;
  const vis = entry.scope?.visibility || memoryCfg(cfg).defaultVisibility || 'shared';
  if (vis === 'shared') {
    if (!isSharedKey) return true;
    return Boolean(isSharedKey(key));
  }
  const conv = entry.scope?.conversation || '';
  return !conv || conv === key;
}

function decorate(entry, now, cfg) {
  return { ...entry, retention: retention(entry, now, memoryCfg(cfg).tauDays), weight: effectiveWeight(entry, now, memoryCfg(cfg).tauDays) };
}

export function listEntries({ role, key, cfg, isSharedKey, includeForgotten = false, now = Date.now() }) {
  const store = loadStore(role);
  const list = store.entries
    .filter((e) => visibleFor(e, key, cfg, isSharedKey, { deep: includeForgotten }))
    .map((e) => decorate(e, now, cfg))
    .sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || b.weight - a.weight || String(a.id).localeCompare(String(b.id)));
  return { entries: list, stats: computeStats(store.entries), role };
}

export function buildMemoryContext({ role, key, cfg, isSharedKey, now = Date.now() }) {
  const m = memoryCfg(cfg);
  if (m.enabled === false) return '';
  let store;
  try { store = loadStore(role); } catch { return ''; }
  const nowMs = now;
  const candidates = [];
  for (const e of store.entries) {
    if (!visibleFor(e, key, cfg, isSharedKey)) continue;
    const w = effectiveWeight(e, nowMs, m.tauDays);
    if (!e.pin && w < (Number(m.threshold) || 0.15) * 0.5) continue;
    candidates.push({ ...e, __weight: w });
  }
  const sorted = sortForInjection(candidates);
  return formatContext(sorted, { maxChars: Number(m.injectMaxChars) || 900, maxItems: Number(m.injectMaxItems) || 8 });
}

export function rememberEntry({ role, key, cfg, isSharedKey, content, importance, kind = 'fact', tags = [], factKey = '', sender = '', visibility, source = {} }) {
  const m = memoryCfg(cfg);
  if (m.enabled === false) throw new Error('记忆功能已关闭');
  const text = clip(content, 500);
  if (!text) throw new Error('content 不能为空');
  const store = loadStore(role);
  const now = Date.now();
  const imp = Number.isFinite(Number(importance)) ? Math.min(1, Math.max(0, Number(importance))) : defaultImportance(kind);
  const targetKey = String(factKey || '').trim();
  let entry = null;

  if (targetKey) {
    const old = store.entries.find((e) => e.factKey === targetKey && !e.deleted && !e.supersededBy);
    if (old) {
      const next = {
        ...old,
        id: old.id,
        content: text,
        importance: imp,
        kind,
        tags: Array.isArray(tags) ? tags.map(String).slice(0, 8) : old.tags || [],
        strength: Math.max(Number(old.strength) || 1, 1 + imp),
        lastRecallAt: now,
        updatedAt: new Date().toISOString()
      };
      Object.assign(old, next);
      saveStore(role, store);
      appendAudit(role, { action: 'update', id: old.id, key, factKey: targetKey });
      return decorate(old, now, cfg);
    }
  }
  const similar = store.entries.find((e) => !e.deleted && !e.supersededBy && !e.forgotten && similarity(e.content, text) > 0.75);
  if (similar && !targetKey) {
    similar.content = text;
    similar.importance = Math.max(Number(similar.importance) || 0, imp);
    similar.updatedAt = new Date().toISOString();
    similar.lastRecallAt = now;
    saveStore(role, store);
    appendAudit(role, { action: 'merge', id: similar.id, key });
    return decorate(similar, now, cfg);
  }

  entry = {
    id: newId(),
    content: text,
    kind: ['fact', 'preference', 'event', 'emotion', 'promise', 'relationship', 'boundary'].includes(kind) ? kind : 'fact',
    factKey: targetKey,
    importance: imp,
    strength: 1 + imp,
    pin: false,
    createdAt: now,
    lastRecallAt: now,
    recallCount: 0,
    tags: Array.isArray(tags) ? tags.map(String).slice(0, 8) : [],
    scope: {
      conversation: key || '',
      visibility: visibility || m.defaultVisibility || 'shared'
    },
    source: {
      key: key || '',
      sender: String(sender || ''),
      messageId: String(source.messageId || ''),
      at: Number(source.at || now)
    },
    supersededBy: null,
    forgotten: false,
    deleted: false
  };
  store.entries.push(entry);
  enforceLimits(store, m);
  saveStore(role, store);
  appendAudit(role, { action: 'remember', id: entry.id, key, kind: entry.kind });
  return decorate(entry, now, cfg);
}

function enforceLimits(store, m) {
  const max = Math.max(50, Number(m.maxEntriesPerPersona) || 2000);
  if (store.entries.length <= max) return;
  const rank = (e) => (e.pin ? 100 : 0) + effectiveWeight(e, Date.now(), m.tauDays) - (e.forgotten ? 10 : 0);
  store.entries.sort((a, b) => rank(b) - rank(a));
  store.entries = store.entries.slice(0, max);
}

export function recallEntries({ role, key, cfg, isSharedKey, query, k, deep = false, now = Date.now() }) {
  const m = memoryCfg(cfg);
  const store = loadStore(role);
  const q = clip(query, 200);
  if (!q) return [];
  const hits = [];
  for (const e of store.entries) {
    if (!visibleFor(e, key, cfg, isSharedKey, { deep })) continue;
    const sim = similarity(q, e.content + ' ' + (e.tags || []).join(' '));
    if (sim <= 0) continue;
    hits.push({ e, score: sim * 2 + effectiveWeight(e, now, m.tauDays) * 0.3 + (e.pin ? 0.2 : 0) });
  }
  hits.sort((a, b) => b.score - a.score);
  const out = hits.slice(0, Math.max(1, Math.min(20, Number(k) || m.recallK || 5)));
  let changed = false;
  for (const { e } of out) {
    boostOnRecall(e, now, m.boost, m.strengthMax);
    changed = true;
  }
  if (changed) {
    saveStore(role, store);
    appendAudit(role, { action: 'recall', key, count: out.length, query: q });
  }
  return out.map(({ e, score }) => ({ ...decorate(e, now, cfg), score: Math.round(score * 1000) / 1000 }));
}

export function forgetEntry({ role, id, factKey, query, cfg, now = Date.now() }) {
  const store = loadStore(role);
  let targets = [];
  if (id) targets = store.entries.filter((e) => e.id === id);
  else if (factKey) targets = store.entries.filter((e) => e.factKey === factKey);
  else if (query) {
    targets = store.entries.filter((e) => similarity(query, e.content) > 0.3).slice(0, 10);
  }
  if (!targets.length) throw new Error('没有找到要遗忘的记忆');
  for (const e of targets) { e.forgotten = true; e.forgottenAt = new Date(now).toISOString(); }
  saveStore(role, store);
  appendAudit(role, { action: 'forget', ids: targets.map((e) => e.id) });
  return targets.map((e) => decorate(e, now, cfg));
}

export function restoreEntry({ role, id, factKey, cfg, now = Date.now() }) {
  const store = loadStore(role);
  const targets = store.entries.filter((e) => (id && e.id === id) || (factKey && e.factKey === factKey));
  if (!targets.length) throw new Error('没有找到要恢复的记忆');
  for (const e of targets) { e.forgotten = false; e.revivedAt = new Date(now).toISOString(); boostOnRecall(e, now, 1.2, memoryCfg(cfg).strengthMax); }
  saveStore(role, store);
  appendAudit(role, { action: 'restore', ids: targets.map((e) => e.id) });
  return targets.map((e) => decorate(e, now, cfg));
}

export function pinEntry({ role, id, pinned, cfg, now = Date.now() }) {
  const store = loadStore(role);
  const e = store.entries.find((x) => x.id === id);
  if (!e) throw new Error('记忆不存在');
  const m = memoryCfg(cfg);
  if (pinned) {
    const pinnedCount = store.entries.filter((x) => x.pin && !x.deleted).length;
    if (pinnedCount >= Math.max(1, Number(m.pinMax) || 12) && !e.pin) throw new Error(`钉住已达上限 ${m.pinMax} 条`);
  }
  e.pin = Boolean(pinned);
  e.updatedAt = new Date().toISOString();
  saveStore(role, store);
  appendAudit(role, { action: pinned ? 'pin' : 'unpin', id });
  return decorate(e, now, cfg);
}

export function shareEntry({ role, id, shared, cfg, now = Date.now() }) {
  const store = loadStore(role);
  const e = store.entries.find((x) => x.id === id);
  if (!e) throw new Error('记忆不存在');
  e.scope = e.scope || {};
  e.scope.visibility = shared ? 'shared' : 'private';
  e.updatedAt = new Date().toISOString();
  saveStore(role, store);
  appendAudit(role, { action: 'share', id, shared: Boolean(shared) });
  return decorate(e, now, cfg);
}

export function decayRole({ role, cfg, now = Date.now() }) {
  const m = memoryCfg(cfg);
  let store;
  try { store = loadStore(role); } catch { return { role, skipped: true }; }
  let forgotten = 0;
  for (const e of store.entries) {
    if (applyDecay(e, now, m.tauDays, m.threshold)) forgotten += 1;
  }
  if (forgotten) {
    saveStore(role, store);
    appendAudit(role, { action: 'decay', forgotten });
  }
  return { role, forgotten, total: store.entries.length };
}

export function decayAll({ cfg, now = Date.now() }) {
  const results = [];
  for (const role of personaRoles()) {
    try { results.push(decayRole({ role, cfg, now })); } catch {}
  }
  return results;
}

export function statsFor({ role }) {
  try { return computeStats(loadStore(role).entries); } catch { return { total: 0, active: 0, forgotten: 0, pinned: 0, shared: 0 }; }
}

export { DAY_MS, shouldForget };
