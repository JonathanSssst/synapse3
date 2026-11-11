// Synapse 3 面板后端 · 会话级记忆（qq_memory_append / qq_memory_update 写入）
// 数据源：qq-bridge/state/social-v2.json 的 conversations.*.activeTopics / pendingThoughts / memberImpressions
// 只读；输出对象逐字段显式构造，绝不返回 agentToken / recentMessages / wakeConfig 等无关或敏感字段。
import fs from 'node:fs';
import path from 'node:path';
import { QB_STATE, localTimeStr, readJson } from './core.mjs';

const SOCIAL_PATH = path.join(QB_STATE, 'social-v2.json');
const ROLE_MAP_PATH = path.join(QB_STATE, 'role-map.json');

// 按 mtime + size 缓存，避免自动刷新时反复读大文件
let socialCache = { mtimeMs: -1, size: -1, value: null };
let roleCache = { mtimeMs: -1, size: -1, value: null };

export function readSocialState() {
  try {
    const st = fs.statSync(SOCIAL_PATH);
    if (socialCache.value && socialCache.mtimeMs === st.mtimeMs && socialCache.size === st.size) return socialCache.value;
    const raw = fs.readFileSync(SOCIAL_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const value = parsed && typeof parsed === 'object' && parsed.conversations && typeof parsed.conversations === 'object'
      ? parsed
      : { paused: false, conversations: {} };
    socialCache = { mtimeMs: st.mtimeMs, size: st.size, value };
    return value;
  } catch {
    // 坏文件/文件不存在：返回空结构，面板不崩
    return { paused: false, conversations: {} };
  }
}

export function readRoleMap() {
  try {
    const st = fs.statSync(ROLE_MAP_PATH);
    if (roleCache.value && roleCache.mtimeMs === st.mtimeMs && roleCache.size === st.size) return roleCache.value;
    const parsed = readJson(ROLE_MAP_PATH, {});
    const value = parsed && typeof parsed === 'object' ? parsed : {};
    roleCache = { mtimeMs: st.mtimeMs, size: st.size, value };
    return value;
  } catch {
    return {};
  }
}

const toMs = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n; // 兼容秒/毫秒
  const d = Date.parse(String(v));
  return Number.isFinite(d) ? d : 0;
};
const toIso = (ms) => (ms > 0 ? new Date(ms).toISOString() : '');
const toLocal = (ms) => (ms > 0 ? localTimeStr(ms) : '');
const textOf = (v) => String(v ?? '').trim();

function normTopics(raw) {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  return list
    .map((t) => {
      if (typeof t === 'string') return { text: t.trim(), participants: [], pendingQuestion: '', lastMentionAt: '', lastMentionAtLocal: '' };
      const ms = toMs(t?.lastMentionAt ?? t?.updatedAt ?? t?.at);
      return {
        text: textOf(t?.text ?? t?.topic ?? t?.content),
        participants: Array.isArray(t?.participants) ? t.participants.map(String) : [],
        pendingQuestion: textOf(t?.pendingQuestion),
        lastMentionAt: toIso(ms),
        lastMentionAtLocal: toLocal(ms),
        _ms: ms
      };
    })
    .filter((t) => t.text);
}

function normThoughts(raw) {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  const now = Date.now();
  return list
    .map((t) => {
      if (typeof t === 'string') return { text: t.trim(), motivation: '', expiresAt: '', isExpired: false };
      const created = toMs(t?.createdAt ?? t?.at);
      const expires = toMs(t?.expiresAt);
      return {
        text: textOf(t?.text ?? t?.content),
        motivation: textOf(t?.motivation),
        createdAt: toIso(created),
        createdAtLocal: toLocal(created),
        expiresAt: toIso(expires),
        expiresAtLocal: toLocal(expires),
        isExpired: expires > 0 ? expires < now : false,
        _ms: created
      };
    })
    .filter((t) => t.text);
}

function normImpression(name, value) {
  let summary = '';
  let tags = [];
  let interactionCount = null;
  let lastSeenMs = 0;
  if (typeof value === 'string') {
    summary = value;
  } else if (Array.isArray(value)) {
    summary = value.map((v) => (typeof v === 'string' ? v : textOf(v?.text ?? v?.summary ?? ''))).filter(Boolean).join('；');
  } else if (value && typeof value === 'object') {
    const traits = value.traits ?? value.summary ?? value.note ?? value.text ?? value.description;
    if (Array.isArray(traits)) summary = traits.map((v) => textOf(typeof v === 'string' ? v : v?.text)).filter(Boolean).join('；');
    else summary = textOf(traits);
    tags = Array.isArray(value.tags) ? value.tags.map(String) : [];
    const c = Number(value.interactionCount);
    if (Number.isFinite(c)) interactionCount = c;
    lastSeenMs = toMs(value.lastSeenAt ?? value.updatedAt ?? value.at);
  }
  return {
    name: String(name || '').trim(),
    summary: summary.trim(),
    tags,
    interactionCount,
    lastSeenAt: toIso(lastSeenMs),
    lastSeenAtLocal: toLocal(lastSeenMs)
  };
}
function normImpressions(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .map(([name, value]) => normImpression(name, value))
    .filter((x) => x.name);
}

// 列出会话记忆；kind: all | group | private；q 匹配 key / 话题 / 想法 / 印象
export function listSessions({ q = '', kind = 'all' } = {}) {
  const state = readSocialState();
  const roleMap = readRoleMap();
  const convs = state.conversations && typeof state.conversations === 'object' ? state.conversations : {};
  const kw = String(q || '').trim().toLowerCase();
  const kindFilter = ['group', 'private'].includes(kind) ? kind : 'all';
  const sessions = [];
  for (const [key, conv] of Object.entries(convs)) {
    if (!conv || typeof conv !== 'object') continue;
    const m = /^(private|group):(.+)$/.exec(String(key));
    const k = m ? m[1] : 'other';
    const id = m ? m[2] : String(key);
    if (kindFilter !== 'all' && k !== kindFilter) continue;

    const topics = normTopics(conv.activeTopics ?? conv.activeTopic);
    const thoughts = normThoughts(conv.pendingThoughts ?? conv.pendingThought);
    const impressions = normImpressions(conv.memberImpressions ?? conv.memberImpression);
    if (kw) {
      const hay = [key, ...topics.map((t) => t.text), ...thoughts.map((t) => t.text), ...impressions.map((i) => `${i.name} ${i.summary}`)]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    const updatedMs = Math.max(
      0,
      ...topics.map((t) => t._ms || 0),
      ...thoughts.map((t) => t._ms || 0),
      ...impressions.map((i) => toMs(i.lastSeenAt))
    );
    const counts = { topics: topics.length, thoughts: thoughts.length, impressions: impressions.length };
    sessions.push({
      key: String(key),
      kind: k,
      id,
      role: String(roleMap.conversations?.[key] || roleMap.default || ''),
      topics: topics.map(({ _ms, ...t }) => t),
      thoughts: thoughts.map(({ _ms, ...t }) => t),
      impressions,
      counts,
      hasMemory: counts.topics + counts.thoughts + counts.impressions > 0,
      updatedAt: toIso(updatedMs),
      updatedAtLocal: toLocal(updatedMs)
    });
  }
  sessions.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.key.localeCompare(b.key));
  const totals = sessions.reduce((acc, s) => {
    acc.topics += s.counts.topics;
    acc.thoughts += s.counts.thoughts;
    acc.impressions += s.counts.impressions;
    return acc;
  }, { topics: 0, thoughts: 0, impressions: 0 });
  return {
    sessions,
    counts: { sessions: sessions.length, topics: totals.topics, thoughts: totals.thoughts, impressions: totals.impressions }
  };
}
