// Synapse 3 面板后端 · 黑话库（代理桥接控制台 API，保持桥接内存与磁盘一致）
import fs from 'node:fs';
import path from 'node:path';
import { QB_STATE } from './core.mjs';

const BRIDGE = 'http://127.0.0.1:3100';

function token() {
  try { return fs.readFileSync(path.join(QB_STATE, 'console-token'), 'utf8').trim(); } catch { return ''; }
}
async function bridge(pathname, opts = {}) {
  const headers = { ...(opts.headers || {}), 'x-console-token': token() };
  if (opts.body) headers['content-type'] = 'application/json';
  const r = await fetch(BRIDGE + pathname, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || `桥接 HTTP ${r.status}`);
  return d;
}

export async function listSlang(q = '', status = '') {
  const d = await bridge('/api/slang');
  const entries = Array.isArray(d.entries) ? d.entries : [];
  const filtered = entries
    .filter((e) => (!status || e.status === status))
    .filter((e) => {
      if (!q) return true;
      const s = String(q).toLowerCase();
      return [e.content, e.meaning, e.usage, e.example].some((x) => String(x ?? '').toLowerCase().includes(s));
    })
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0) || String(a.content).localeCompare(String(b.content), 'zh-CN'));
  const stats = { total: entries.length, candidate: 0, confirmed: 0, rejected: 0 };
  for (const e of entries) stats[e.status] = (stats[e.status] || 0) + 1;
  return { ok: true, entries: filtered, config: d.config || {}, writable: d.writable !== false, stats };
}

export async function batchSlang(action, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!list.length) throw new Error('ids 不能为空');
  const pathname = action === 'confirm' ? '/api/slang/batch-confirm' : '/api/slang/batch-reject';
  const d = await bridge(pathname, { method: 'POST', body: { ids: list } });
  return { ok: true, ...d };
}

export async function updateSlang(id, patch) {
  const d = await bridge('/api/slang/' + encodeURIComponent(String(id)), { method: 'PATCH', body: patch || {} });
  return { ok: true, entry: d.entry };
}
