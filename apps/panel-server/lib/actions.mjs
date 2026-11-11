// Synapse 3 面板后端 · 动作接口（写操作与二进制/文本输出）
import { HOME as B, BRIDGE_ROOT } from '../../../packages/paths/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {
  BOT, QB, QB_STATE, IMAGEGEN_DIR, PANEL_DIR, readText, readJson, readBody, sendJson,
  sendText, dbRows, alertsConfig, saveAlertsConfig
} from './core.mjs';
import {
  personaDir, readPersonaMeta, savePersonaMeta, refsDirPath, saveImagegenConfig, updateRefNote,
  refsData, imagegenConfigPath
} from './sources.mjs';

const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp|ico)$/i;
const TEXT_EXT = /\.(md|txt|log|json|jsonl|csv|yml|yaml|mjs|js|ps1|vbs|bat|html|htm|css|toml|ini)$/i;

function mimeOf(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.json' || ext === '.jsonl') return 'application/json; charset=utf-8';
  if (ext === '.csv') return 'text/csv; charset=utf-8';
  if (ext === '.md' || ext === '.txt' || ext === '.log' || ext === '.yml' || ext === '.yaml') return 'text/plain; charset=utf-8';
  return 'image/jpeg';
}

// 只允许 <SYNAPSE_HOME> 与 qq-bridge\personas 下的文件（不越界）
export function resolveSafePath(rawPath, roots = [BOT, path.join(QB, 'personas')]) {
  let target = '';
  try { target = path.resolve(String(rawPath || '')); } catch { return null; }
  for (const root of roots) {
    const resolvedRoot = path.resolve(root).toLowerCase();
    const lower = target.toLowerCase();
    if (lower === resolvedRoot || lower.startsWith(resolvedRoot + path.sep)) return target;
  }
  return null;
}

function sendFile(res, file, cache = 'max-age=3600') {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) { sendText(res, 404, 'not found'); return; }
    res.writeHead(200, { 'content-type': mimeOf(file), 'content-length': st.size, 'cache-control': cache });
    fs.createReadStream(file).pipe(res);
  } catch { sendText(res, 404, 'not found'); }
}

function bodyJson(req) {
  return readBody(req).then((b) => { try { return JSON.parse(b || '{}'); } catch { return {}; } });
}

// GET 类二进制 / 文本接口
export function handleGet(req, res, url) {
  const p = url.pathname;

  if (p === '/api/gen-image') {
    const nm = String(url.searchParams.get('name') || '');
    if (!/^gen-\d+\.(jpe?g|png|webp)$/i.test(nm)) { sendText(res, 400, 'bad name'); return true; }
    sendFile(res, path.join(IMAGEGEN_DIR, nm));
    return true;
  }

  if (p === '/api/persona/avatar') {
    const role = String(url.searchParams.get('role') || '');
    const dir = personaDir(role);
    let file = path.join(dir, 'avatar.jpg');
    try { const meta = readPersonaMeta(role); if (meta.avatar) { const m = String(meta.avatar); file = path.isAbsolute(m) ? m : path.join(dir, m); } } catch {}
    if (!resolveSafePath(file)) { sendText(res, 400, 'bad path'); return true; }
    sendFile(res, file, 'no-cache');
    return true;
  }

  if (p === '/api/ref-image') {
    const nm = String(url.searchParams.get('name') || '');
    if (!/^[^/\\]+\.(png|jpe?g|webp)$/i.test(nm)) { sendText(res, 400, 'bad name'); return true; }
    sendFile(res, path.join(refsDirPath(), nm));
    return true;
  }

  if (p === '/api/media') {
    const target = resolveSafePath(url.searchParams.get('path') || '');
    if (!target) { sendText(res, 400, `只能读取 ${B} 与 qq-bridge/personas 内的文件`); return true; }
    if (!IMG_EXT.test(target)) { sendText(res, 400, '不是图片文件'); return true; }
    sendFile(res, target);
    return true;
  }

  if (p === '/api/preview') {
    // 文本预览严格限制在 <SYNAPSE_HOME> 内（不含 qq-bridge 等其它目录）
    const target = resolveSafePath(url.searchParams.get('path') || '', [BOT]);
    if (!target) { sendText(res, 400, `只能预览 ${B} 内的文件`); return true; }
    if (!TEXT_EXT.test(target)) { sendText(res, 400, '只支持文本文件预览'); return true; }
    try {
      const st = fs.statSync(target);
      if (st.size > 300 * 1024) { sendText(res, 413, '文件太大（>300KB）'); return true; }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readText(target));
    } catch { sendText(res, 404, '找不到文件'); }
    return true;
  }

  if (p === '/api/gen-delete') {
    const nm = String(url.searchParams.get('name') || '');
    if (!/^gen-\d+\.(png|jpe?g|webp)$/i.test(nm)) { sendJson(res, 400, { ok: false, error: 'bad name' }); return true; }
    try { fs.unlinkSync(path.join(BOT, 'imagegen', nm)); sendJson(res, 200, { ok: true }); }
    catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); }
    return true;
  }

  if (p === '/api/gen-resend') return handleGenResend(req, res, url);

  if (p === '/api/alerts') {
    if (req.method === 'GET') { sendJson(res, 200, { ok: true, config: alertsConfig() }); return true; }
    return false;
  }

  if (p === '/api/refs/config' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, refs: refsData() });
    return true;
  }

  return false;
}

async function handleGenResend(req, res, url) {
  try {
    const nm = String(url.searchParams.get('name') || '');
    if (!/^gen-\d+\.(png|jpe?g|webp)$/i.test(nm)) { sendJson(res, 400, { ok: false, error: 'bad name' }); return true; }
    const ownerQQ = Number(readJson(path.join(QB, 'config.json'), {}).ownerQQ || 0);
    const social = readJson(path.join(QB_STATE, 'social-v2.json'), { conversations: {} });
    const st = (social.conversations || {})[`private:${ownerQQ}`] || {};
    const token = String(st.agentToken || '');
    if (!token) { sendJson(res, 503, { ok: false, error: '拿不到主人会话 token' }); return true; }
    const buf = fs.readFileSync(path.join(BOT, 'imagegen', nm));
    const r = await fetch('http://127.0.0.1:3100/api/send/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-token': token },
      body: JSON.stringify({ key: `private:${ownerQQ}`, token, image: `base64://${buf.toString('base64')}`, caption: '重发一张之前生成的图。' })
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok || b.ok === false) throw new Error(b.error || `HTTP ${r.status}`);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
  return true;
}

// POST 接口
export async function handlePost(req, res, url) {
  const p = url.pathname;

  if (p === '/api/alerts') {
    try {
      const body = await bodyJson(req);
      const cfg = saveAlertsConfig(body);
      sendJson(res, 200, { ok: true, config: cfg });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
    return true;
  }

  if (p === '/api/persona/save') {
    try {
      const body = await bodyJson(req);
      const role = String(body.role || '').replace(/[^\w一-鿿-]/g, '');
      if (!role) { sendJson(res, 400, { ok: false, error: 'role 不能为空' }); return true; }
      const meta = readPersonaMeta(role);
      if (typeof body.nickname === 'string') meta.nickname = body.nickname.slice(0, 24);
      if (typeof body.note === 'string') meta.note = body.note.slice(0, 60);
      if (typeof body.avatar === 'string' && body.avatar.trim()) meta.avatar = body.avatar.trim();
      if (typeof body.avatarBase64 === 'string' && body.avatarBase64.startsWith('data:image/')) {
        const buf = Buffer.from(body.avatarBase64.split(',').pop(), 'base64');
        if (buf.length > 6 * 1024 * 1024) throw new Error('头像太大（>6MB）');
        fs.mkdirSync(personaDir(role), { recursive: true });
        fs.writeFileSync(path.join(personaDir(role), 'avatar.jpg'), buf);
        meta.avatar = 'avatar.jpg';
      }
      meta.name = role;
      if (!savePersonaMeta(role, meta)) throw new Error('写入 meta.json 失败');
      sendJson(res, 200, { ok: true, meta });
    } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); }
    return true;
  }

  if (p === '/api/persona/apply') {
    try {
      const body = await bodyJson(req);
      const token = readText(path.join(QB_STATE, 'console-token')).trim();
      const r = await fetch('http://127.0.0.1:3100/api/persona/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': token },
        body: JSON.stringify({ role: body.role }),
        signal: AbortSignal.timeout(60000)
      });
      const d = await r.json().catch(() => ({}));
      sendJson(res, r.ok ? 200 : 400, d);
    } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); }
    return true;
  }

  if (p === '/api/persona/switch') {
    try {
      const body = await bodyJson(req);
      const token = readText(path.join(QB_STATE, 'console-token')).trim();
      const r = await fetch('http://127.0.0.1:3100/api/role', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': token },
        body: JSON.stringify({ role: body.name, key: body.key || '' }),
        signal: AbortSignal.timeout(8000)
      });
      const d = await r.json().catch(() => ({}));
      sendJson(res, r.ok ? 200 : 400, d);
    } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); }
    return true;
  }

  if (p === '/api/refs/config') {
    try {
      const body = await bodyJson(req);
      const patch = {};
      if ('refsCount' in body) patch.refsCount = Math.max(0, Math.min(5, Number(body.refsCount) || 0));
      if ('model' in body && /^doubao-seedream-5-0-(flash-260915|pro-260628)$/.test(String(body.model))) patch.model = String(body.model);
      if ('size' in body && /^(1K|1\.5K|2K|4K|\d{3,4}x\d{3,4})$/.test(String(body.size))) patch.size = String(body.size);
      const next = saveImagegenConfig(patch);
      sendJson(res, 200, { ok: true, config: { model: next.model, refsCount: next.refsCount, size: next.size } });
    } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); }
    return true;
  }

  if (p === '/api/ref-note') {
    try {
      const body = await bodyJson(req);
      const file = String(body.file || '');
      if (!file) { sendJson(res, 400, { ok: false, error: 'file 不能为空' }); return true; }
      updateRefNote(file, body.policySafe === true);
      sendJson(res, 200, { ok: true, refs: refsData() });
    } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); }
    return true;
  }

  return false;
}

// CSV 导出
export function handleExport(req, res, url) {
  const m = /^\/api\/export\/(tokens|tools|activity|audit|bili|bilinotes|fs)$/.exec(url.pathname);
  if (!m) return false;
  const kind = m[1];
  let csv = '';
  try {
    if (kind === 'tokens') {
      const rows = dbRows('SELECT t, kind, conv_key, turn, step, model, cache_miss, cache_hit, cache_write, output, reasoning FROM token_usage ORDER BY rowid') || [];
      csv = 'timestamp,date,kind,conversation,turn,step,model,cache_miss,cache_hit,cache_write,output,reasoning\n' +
        rows.map((r) => [r.t, new Date(r.t).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), r.kind, r.conv_key, r.turn ?? '', r.step ?? '', r.model, r.cache_miss, r.cache_hit, r.cache_write, r.output, r.reasoning].join(',')).join('\n');
    } else if (kind === 'tools') {
      const rows = dbRows('SELECT t, type, conv_key, tool, ok, error FROM tool_calls ORDER BY rowid') || [];
      csv = 'time,type,conversation,tool,ok,error\n' + rows.map((r) => [r.t, r.type, r.conv_key, r.tool, r.ok ?? '', JSON.stringify(String(r.error ?? ''))].join(',')).join('\n');
    } else if (kind === 'activity') {
      const rows = dbRows('SELECT t, conv_key, text FROM activity ORDER BY rowid') || [];
      csv = 'time,conversation,text\n' + rows.map((r) => [r.t, r.conv_key, JSON.stringify(String(r.text ?? ''))].join(',')).join('\n');
    } else if (kind === 'bili') {
      const rows = dbRows('SELECT t, action, bvid, title, up, detail, ok, error FROM bili_events ORDER BY rowid') || [];
      csv = 'time,action,bv,title,up,detail,ok,error\n' + rows.map((r) => [r.t, r.action, r.bvid, JSON.stringify(String(r.title ?? '')), JSON.stringify(String(r.up ?? '')), JSON.stringify(String(r.detail ?? '')), r.ok ?? '', JSON.stringify(String(r.error ?? ''))].join(',')).join('\n');
    } else if (kind === 'bilinotes') {
      const rows = dbRows('SELECT t, bvid, title, up, note FROM bili_notes ORDER BY rowid') || [];
      csv = 'time,bv,title,up,note\n' + rows.map((r) => [r.t, r.bvid, JSON.stringify(String(r.title ?? '')), JSON.stringify(String(r.up ?? '')), JSON.stringify(String(r.note ?? ''))].join(',')).join('\n');
    } else if (kind === 'fs') {
      const rows = dbRows('SELECT t, op, path, bytes, ok FROM fs_events ORDER BY rowid') || [];
      csv = 'time,op,path,bytes,ok\n' + rows.map((r) => [r.t, r.op, JSON.stringify(String(r.path ?? '')), r.bytes, r.ok ?? ''].join(',')).join('\n');
    } else {
      const rows = dbRows('SELECT t, source, action, conv_key, target, ok, detail FROM audit_events ORDER BY rowid') || [];
      csv = 'time,source,action,key,target,ok,detail\n' + rows.map((r) => [r.t, r.source, r.action, r.conv_key, r.target, r.ok ?? '', JSON.stringify(String(r.detail ?? ''))].join(',')).join('\n');
    }
  } catch {}
  if (!csv) csv = '（数据库未就绪，暂无可导出数据）\n';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="synapse-${kind}-${stamp}.csv"`,
    'cache-control': 'no-store'
  });
  res.end('\uFEFF' + csv);
  return true;
}

export { imagegenConfigPath, PANEL_DIR };
