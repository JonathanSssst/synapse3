// Synapse 3 面板后端 · 长期事实记忆（代理桥接控制台 API）
import fs from 'node:fs';
import path from 'node:path';
import { QB_STATE } from './core.mjs';

const BRIDGE = 'http://127.0.0.1:3100';
function token() { try { return fs.readFileSync(path.join(QB_STATE, 'console-token'), 'utf8').trim(); } catch { return ''; } }
async function bridge(pathname, opts = {}) {
  const r = await fetch(BRIDGE + pathname, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-console-token': token(), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || `桥接 HTTP ${r.status}`);
  return d;
}

export async function brainMemory(role) {
  const d = await bridge('/api/brain-memory?role=' + encodeURIComponent(role));
  return { ok: true, role, entries: d.entries || [], stats: d.stats || {} };
}
export async function brainAction(action, body) {
  const map = { pin: '/api/brain-memory/pin', forget: '/api/brain-memory/forget', restore: '/api/brain-memory/restore', decay: '/api/brain-memory/decay' };
  const p = map[action];
  if (!p) throw new Error('未知操作：' + action);
  return bridge(p, action === 'decay' ? { method: 'POST', body: {} } : { method: 'POST', body });
}
export async function brainContext(role, key) {
  const d = await bridge('/api/brain-memory/context?role=' + encodeURIComponent(role) + '&key=' + encodeURIComponent(key));
  return { ok: true, block: d.block || '' };
}
