// bridge-console.cjs · 桥接控制台客户端（只做审批与状态读取）
//
// 鉴权与桥接一致：x-console-token。token 由桥接自己生成在 state/console-token，
// 优先从 data/state/bridge 取，回落到桥接目录下的 state/。

const fs = require('node:fs');
const path = require('node:path');
const { loadPaths, runtimeNode } = require('./resolve-packages.cjs');

let P = null;
async function paths() {
  if (!P) P = await loadPaths();
  return P;
}

const BASE = () => process.env.SYNAPSE_CONSOLE || 'http://127.0.0.1:3100';

async function readToken() {
  const p = await paths();
  const cands = [
    path.join(p.BRIDGE_STATE, 'console-token'),
    path.join(p.SECRETS, 'console-token')
  ];
  for (const f of cands) {
    try {
      const t = fs.readFileSync(f, 'utf8').trim();
      if (t) return t;
    } catch {}
  }
  return '';
}

async function call(pathname, { method = 'GET', body, timeout = 6000 } = {}) {
  const token = await readToken();
  if (!token) throw new Error('未找到控制台 token（桥接尚未启动过？）');
  const res = await fetch(BASE() + pathname, {
    method,
    headers: {
      'x-console-token': token,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout)
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** 挂起中的审批与提问。桥接未启动时返回 { offline: true }。 */
async function pending() {
  try {
    const data = await call('/api/pending');
    return { offline: false, pending: data?.pending || [] };
  } catch (e) {
    return { offline: true, error: e.message, pending: [] };
  }
}

/**
 * 应答一个挂起项。text 对审批是「通过 / 拒绝」，对提问是回答正文。
 * 走的是桥接里与 QQ 回复完全相同的那条逻辑（handlePendingAnswer），不另立规则。
 */
async function answer(key, text) {
  if (!key) throw new Error('缺少 key');
  if (!text) throw new Error('缺少应答内容');
  return call('/api/pending/answer', { method: 'POST', body: { key, text } });
}

async function status() {
  try { return await call('/api/status'); } catch (e) { return { offline: true, error: e.message }; }
}

async function health() {
  try {
    const data = await call('/api/tokens/summary');
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { pending, answer, status, health, readToken, BASE };
