// 未读黄点：轮询 /api/latest，按页面记录已读时间
import { reactive } from 'vue';
import { api } from '../api/client.js';

const SEEN_KEY = 'panel.seen.v2';

function loadSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

export const unread = reactive({ latest: {}, seen: loadSeen(), ready: false, error: '' });
let firstPoll = true;

export async function pollLatest() {
  try {
    const d = await api.latest();
    unread.latest = d.latest || {};
    // 首次拿到画像时，把「还没记录过已读」的板块按当前进度补成已读，避免整排黄点
    if (firstPoll) {
      let changed = false;
      for (const [k, v] of Object.entries(unread.latest)) {
        if (unread.seen[k] == null && Number(v)) { unread.seen[k] = Number(v); changed = true; }
      }
      if (changed) {
        try { localStorage.setItem(SEEN_KEY, JSON.stringify(unread.seen)); } catch {}
      }
      firstPoll = false;
    }
    unread.ready = true;
    unread.error = '';
  } catch (e) {
    unread.error = e?.message || String(e);
  }
}

export function isUnread(tab) {
  if (!tab) return false;
  const at = Number(unread.latest[tab] || 0);
  if (!at) return false;
  return at > Number(unread.seen[tab] || 0);
}

export function markSeen(tab, at) {
  if (!tab) return;
  const value = Number(at ?? unread.latest[tab] ?? 0);
  if (!value) return; // 还没有该板块数据时不虚标“已读”
  unread.seen[tab] = value;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(unread.seen)); } catch {}
}
