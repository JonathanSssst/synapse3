// Synapse 3 面板后端 · 角色状态（代理桥接 API）
import fs from 'node:fs';
import path from 'node:path';
import { QB_STATE } from './core.mjs';

const BRIDGE = 'http://127.0.0.1:3100';
function token() { try { return fs.readFileSync(path.join(QB_STATE, 'console-token'), 'utf8').trim(); } catch { return ''; } }
async function call(pathname, opts = {}) {
  const r = await fetch(BRIDGE + pathname, { ...opts, headers: { 'content-type': 'application/json', 'x-console-token': token(), ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(15000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || `桥接 HTTP ${r.status}`);
  return d;
}
export async function vitalsGet(role) { return call('/api/vitals?role=' + encodeURIComponent(role)); }
export async function vitalsTimeline(role, day) { return call('/api/vitals/timeline?role=' + encodeURIComponent(role) + '&day=' + encodeURIComponent(day || '')); }
export async function vitalsEvent(body) { return call('/api/vitals/event', { method: 'POST', body }); }
