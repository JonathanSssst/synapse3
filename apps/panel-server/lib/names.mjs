// Synapse 3 面板后端 · 会话名称解析
// 把 private:QQ / group:群号 解析成 QQ 昵称 / 群名（SnowLuma OneBot HTTP），带缓存与失败回退。
import path from 'node:path';
import { QB, readJson } from './core.mjs';

const NAME_TTL = 10 * 60 * 1000; // 成功缓存 10 分钟
const FAIL_TTL = 60 * 1000; // 失败缓存 1 分钟，避免反复打网关
const cache = new Map(); // key -> { at, ok, name }
const inflight = new Map();

let gw = null;
function gateway() {
  if (gw) return gw;
  const cfg = readJson(path.join(QB, 'config.json'), {}) || {};
  const s = cfg.snowluma || {};
  gw = {
    base: String(s.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: String(s.accessToken || '')
  };
  return gw;
}

export function parseConversationKey(key) {
  const m = /^(private|group|internal):(.+)$/.exec(String(key || ''));
  if (!m) return { kind: 'unknown', id: String(key || '') };
  return { kind: m[1], id: m[2] };
}

async function loadName(kind, id) {
  const cacheKey = `${kind}:${id}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < (hit.ok ? NAME_TTL : FAIL_TTL)) return hit;
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);
  const promise = (async () => {
    try {
      const { base, token } = gateway();
      const apiPath = kind === 'group'
        ? `/get_group_info?group_id=${encodeURIComponent(id)}`
        : `/get_stranger_info?user_id=${encodeURIComponent(id)}`;
      const res = await fetch(base + apiPath, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(2000)
      });
      const body = await res.json().catch(() => null);
      const data = body && body.data;
      const name = String(kind === 'group' ? data?.group_name : data?.nickname || '').trim();
      if (!res.ok || !name) throw new Error(`gateway http ${res.status}`);
      const value = { at: Date.now(), ok: true, name };
      cache.set(cacheKey, value);
      return value;
    } catch {
      const value = { at: Date.now(), ok: false, name: '' };
      cache.set(cacheKey, value);
      return value;
    } finally {
      inflight.delete(cacheKey);
    }
  })();
  inflight.set(cacheKey, promise);
  return promise;
}

// 解析单个会话；网关不可用时回退为「群/私聊 + 号码」，保证表格永远有可读标题
export async function resolveConversation(key, { ownerQQ } = {}) {
  const { kind, id } = parseConversationKey(key);
  const isOwner = kind === 'private' && ownerQQ != null && String(id) === String(ownerQQ);
  if (kind === 'internal') {
    return { key: String(key), kind, id, name: id || '内部会话', isOwner: false, nameResolved: true };
  }
  if (kind !== 'private' && kind !== 'group') {
    return { key: String(key), kind, id, name: id || String(key), isOwner: false, nameResolved: false };
  }
  const r = await loadName(kind, id);
  const fallback = kind === 'group' ? `群 ${id}` : `私聊 ${id}`;
  return {
    key: String(key),
    kind,
    id,
    name: r.ok ? r.name : fallback,
    isOwner,
    nameResolved: r.ok
  };
}

export async function resolveConversations(convs, { ownerQQ } = {}) {
  return Promise.all((convs || []).map(async (item) => {
    const extra = await resolveConversation(item.key, { ownerQQ });
    return { ...item, ...extra };
  }));
}
