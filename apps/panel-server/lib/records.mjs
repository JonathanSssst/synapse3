// Synapse 3 面板后端 · 统一记录 API（列表 / 详情）
// DB 类型走 SQL 分页（快、total 准确）；文件类数据在 JS 侧过滤分页。
import fs from 'node:fs';
import path from 'node:path';
import {
  BOT, IMAGEGEN_DIR, readJson, readText, localTimeStr, localDayOf,
  dbRows, dbOne, safeStat
} from './core.mjs';
import {
  personaList, personaDir, readPersonaMeta, stickers, stickerPersonaMap, qzoneEvents,
  genImages, memoryDocList, freeTimeEvents, biliNotes, biliEvents, douyinEvents,
  imagegenConfigPath
} from './sources.mjs';

const trim = (s, n = 400) => {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
};
const parseMaybeJson = (v) => {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return null; }
};
const objText = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
};

// ============ DB 类型：SQL 分页 ============
const SQL_DEFS = {
  tool_call: {
    table: 'tool_calls',
    label: '工具调用',
    select: 'id,t,type,conv_key,session_id,tool,ok,error',
    map: (r) => ({
      id: String(r.id || ''), t: r.t, tLocal: localTimeStr(r.t), type: r.type || '',
      convKey: r.conv_key || '', sessionId: r.session_id || '', tool: r.tool || '',
      ok: r.ok === 1 || r.ok === true, error: String(r.error || '')
    }),
    search: ['tool', 'error', 'conv_key', 'type'],
    sort: { tLocal: 't', t: 't', tool: 'tool', type: 'type', convKey: 'conv_key', ok: 'ok' },
    columns: [
      { key: 'tLocal', label: '时间', type: 'time', width: 165 },
      { key: 'tool', label: '工具', type: 'text', width: 190 },
      { key: 'type', label: '阶段', type: 'text', width: 90 },
      { key: 'convKey', label: '会话', type: 'text', width: 170 },
      { key: 'ok', label: '结果', type: 'status', width: 80 },
      { key: 'error', label: '错误', type: 'truncate' }
    ]
  },
  audit_event: {
    table: 'audit_events',
    label: '审计事件',
    select: 'id,t,source,action,conv_key,target,detail,ok',
    map: (r) => ({
      id: String(r.id || ''), t: r.t, tLocal: localTimeStr(r.t), source: r.source || '',
      action: r.action || '', convKey: r.conv_key || '', target: String(r.target || ''),
      detail: String(r.detail || ''), ok: r.ok === 1 || r.ok === true
    }),
    search: ['source', 'action', 'conv_key', 'target', 'detail'],
    sort: { tLocal: 't', t: 't', source: 'source', action: 'action', convKey: 'conv_key', ok: 'ok' },
    columns: [
      { key: 'tLocal', label: '时间', type: 'time', width: 165 },
      { key: 'source', label: '来源', type: 'text', width: 90 },
      { key: 'action', label: '动作', type: 'text', width: 180 },
      { key: 'convKey', label: '会话', type: 'text', width: 170 },
      { key: 'target', label: '对象', type: 'truncate' },
      { key: 'ok', label: '结果', type: 'status', width: 80 }
    ]
  },
  bili_event: {
    table: 'bili_events',
    label: 'B站事件',
    select: 'id,t,action,bvid,title,up,detail,ok,error',
    map: (r) => ({
      id: String(r.id || ''), t: r.t, tLocal: localTimeStr(r.t), action: r.action || '',
      bvid: r.bvid || '', title: r.title || '', up: r.up || '', detail: String(r.detail || ''),
      ok: r.ok === 1 || r.ok === true, error: String(r.error || '')
    }),
    search: ['action', 'title', 'up', 'bvid', 'detail', 'error'],
    sort: { tLocal: 't', t: 't', action: 'action', title: 'title', up: 'up', ok: 'ok' },
    columns: [
      { key: 'tLocal', label: '时间', type: 'time', width: 165 },
      { key: 'action', label: '动作', type: 'text', width: 110 },
      { key: 'title', label: '标题', type: 'truncate' },
      { key: 'up', label: 'UP 主', type: 'text', width: 160 },
      { key: 'bvid', label: 'BV 号', type: 'text', width: 130 },
      { key: 'ok', label: '结果', type: 'status', width: 80 }
    ]
  },
  bili_note: {
    table: 'bili_notes',
    label: 'B站感受',
    select: 'id,t,bvid,title,up,note',
    map: (r) => ({
      id: String(r.id || ''), t: r.t, tLocal: localTimeStr(r.t), bvid: r.bvid || '',
      title: r.title || '', up: r.up || '', note: String(r.note || '')
    }),
    search: ['title', 'up', 'bvid', 'note'],
    sort: { tLocal: 't', t: 't', title: 'title', up: 'up' },
    columns: [
      { key: 'tLocal', label: '时间', type: 'time', width: 165 },
      { key: 'title', label: '视频', type: 'truncate' },
      { key: 'up', label: 'UP 主', type: 'text', width: 160 },
      { key: 'bvid', label: 'BV 号', type: 'text', width: 130 },
      { key: 'note', label: '她的感受', type: 'truncate' }
    ]
  },
  douyin_event: {
    table: 'douyin_events',
    label: '抖音事件',
    select: 'id,t,action,aweme_id,title,author,detail,ok,error',
    map: (r) => ({
      id: String(r.id || ''), t: r.t, tLocal: localTimeStr(r.t), action: r.action || '',
      awemeId: r.aweme_id || '', title: r.title || '', author: r.author || '',
      detail: String(r.detail || ''), ok: r.ok === 1 || r.ok === true, error: String(r.error || '')
    }),
    search: ['action', 'title', 'author', 'aweme_id', 'detail', 'error'],
    sort: { tLocal: 't', t: 't', action: 'action', title: 'title', author: 'author', ok: 'ok' },
    columns: [
      { key: 'tLocal', label: '时间', type: 'time', width: 165 },
      { key: 'action', label: '动作', type: 'text', width: 100 },
      { key: 'title', label: '标题', type: 'truncate' },
      { key: 'author', label: '作者', type: 'text', width: 140 },
      { key: 'awemeId', label: '视频 ID', type: 'text', width: 180 },
      { key: 'ok', label: '结果', type: 'status', width: 80 }
    ]
  },
  fs_event: {
    table: 'fs_events',
    label: '文件事件',
    select: 'id,t,op,path,bytes,ok',
    map: (r) => ({
      id: String(r.id || ''), t: r.t, tLocal: localTimeStr(r.t), op: r.op || '',
      path: String(r.path || ''), bytes: Number(r.bytes || 0), ok: r.ok === 1 || r.ok === true,
      exists: Boolean(safeStat(String(r.path || '')))
    }),
    search: ['op', 'path'],
    sort: { tLocal: 't', t: 't', op: 'op', path: 'path', bytes: 'bytes' },
    columns: [
      { key: 'tLocal', label: '时间', type: 'time', width: 165 },
      { key: 'op', label: '操作', type: 'text', width: 100 },
      { key: 'path', label: '路径', type: 'truncate' },
      { key: 'bytes', label: '大小', type: 'bytes', align: 'right', width: 110 },
      { key: 'ok', label: '结果', type: 'status', width: 80 }
    ]
  },
  activity: {
    table: 'activity',
    label: '聊天活动',
    select: 'id,t,conv_key,text,ingested_at',
    timeCol: "COALESCE(ingested_at, t)",
    map: (r) => ({
      id: String(r.id || ''), t: r.ingested_at || r.t, clock: r.t,
      tLocal: localTimeStr(r.ingested_at || r.t), conv: r.conv_key || '', text: String(r.text || '')
    }),
    search: ['conv_key', 'text'],
    sort: { tLocal: "COALESCE(ingested_at, t)", t: "COALESCE(ingested_at, t)", conv: 'conv_key' },
    columns: [
      { key: 'tLocal', label: '时间', type: 'time', width: 165 },
      { key: 'conv', label: '会话', type: 'text', width: 190 },
      { key: 'text', label: '内容', type: 'truncate' }
    ]
  }
};

// 详情才读取的原始字段（列表不查，减少 IO）
const RAW_BY_ID = {
  tool_call(id) {
    const r = dbRows('SELECT raw,args FROM tool_calls WHERE id = ? LIMIT 1', String(id))?.[0];
    return r ? { raw: r.raw || '', args: r.args || '' } : null;
  },
  audit_event(id) {
    const r = dbRows('SELECT raw FROM audit_events WHERE id = ? LIMIT 1', String(id))?.[0];
    return r ? { raw: r.raw || '' } : null;
  },
  bili_event(id) {
    const r = dbRows('SELECT raw FROM bili_events WHERE id = ? LIMIT 1', String(id))?.[0];
    return r ? { raw: r.raw || '' } : null;
  },
  douyin_event(id) {
    const r = dbRows('SELECT raw FROM douyin_events WHERE id = ? LIMIT 1', String(id))?.[0];
    return r ? { raw: r.raw || '' } : null;
  }
};

// ============ 文件类类型 ============
const FILE_DEFS = {
  qzone_action: {
    label: '空间动作',
    columns: [
      { key: 'tLocal', label: '时间', type: 'time', width: 165 },
      { key: 'type', label: '动作', type: 'text', width: 120 },
      { key: 'summary', label: '内容', type: 'truncate' },
      { key: 'tid', label: '说说 ID', type: 'text', width: 200 }
    ],
    sort: { tLocal: 't', t: 't', type: 'type' },
    search: ['type', 'summary', 'content', 'tid', 'nickname'],
    load: () => qzoneEvents(2000).map((e) => {
      const summary = e.content || e.reply || e.comment || e.wording || e.text || e.error || e.reason || e.detail || e.nickname || e.uin || e.tid || '';
      return {
        ...e, id: e.id, t: e.at || '', tLocal: localTimeStr(e.at), type: e.type || '',
        summary: trim(String(summary), 200), raw: JSON.stringify(e)
      };
    })
  },
  gen_image: {
    label: '生成图',
    columns: [
      { key: 'tLocal', label: '生成时间', type: 'time', width: 165 },
      { key: 'url', label: '预览', type: 'image', width: 90 },
      { key: 'name', label: '文件', type: 'text', width: 200 },
      { key: 'bytes', label: '大小', type: 'bytes', align: 'right', width: 110 }
    ],
    sort: { tLocal: 't', t: 't', name: 'name', bytes: 'bytes' },
    search: ['name'],
    load: () => genImages(400).map((g) => ({
      id: g.name, t: new Date(g.mtime).toISOString(), tLocal: localTimeStr(g.mtime),
      name: g.name, bytes: g.bytes, url: `/api/gen-image?name=${encodeURIComponent(g.name)}`, kind: 'gen'
    }))
  },
  persona: {
    label: '人设',
    columns: [
      { key: 'tLocal', label: '更新时间', type: 'time', width: 165 },
      { key: 'name', label: '人设', type: 'text', width: 160 },
      { key: 'nickname', label: '昵称', type: 'text', width: 160 },
      { key: 'note', label: '备注', type: 'truncate' },
      { key: 'stickers', label: '专属表情', type: 'number', align: 'right', width: 110 }
    ],
    sort: { tLocal: 't', t: 't', name: 'name', stickers: 'stickers' },
    search: ['name', 'nickname', 'displayName', 'note', 'source'],
    load: () => personaList().map((p) => ({ ...p, t: p.updatedAt || p._t || '', tLocal: localTimeStr(p.updatedAt || p._t) }))
  },
  sticker: {
    label: '表情',
    columns: [
      { key: 'tLocal', label: '收藏时间', type: 'time', width: 165 },
      { key: 'imgUrl', label: '预览', type: 'image', width: 80 },
      { key: 'desc', label: '备注', type: 'text', width: 200 },
      { key: 'tags', label: '标签', type: 'tags' },
      { key: 'useCount', label: '使用', type: 'number', align: 'right', width: 80 }
    ],
    sort: { tLocal: 't', t: 't', desc: 'desc', useCount: 'useCount' },
    search: ['desc', 'localNote', 'tags'],
    load: () => {
      const pmap = stickerPersonaMap();
      return stickers().map((s, i) => {
        const t = s.createdAt || s.lastUsedAt || 0;
        return {
          ...s, id: String(s.id || s.md5 || `st-${i}`), t: t ? new Date(t).toISOString() : '',
          tLocal: localTimeStr(t), personas: pmap[String(s.id)] || [], imgUrl: String(s.url || '')
        };
      });
    }
  },
  memory_doc: {
    label: '记忆文档',
    columns: [
      { key: 'tLocal', label: '修改时间', type: 'time', width: 165 },
      { key: 'name', label: '文档', type: 'text', width: 180 },
      { key: 'kind', label: '类型', type: 'text', width: 100 },
      { key: 'preview', label: '摘要', type: 'truncate' },
      { key: 'bytes', label: '大小', type: 'bytes', align: 'right', width: 100 },
      { key: 'lines', label: '行数', type: 'number', align: 'right', width: 90 }
    ],
    sort: { tLocal: 't', t: 't', name: 'name', bytes: 'bytes', lines: 'lines' },
    search: ['name', 'kind', 'preview'],
    load: () => memoryDocList().map((d) => ({ ...d, t: d.mtime || '', tLocal: localTimeStr(d.mtime) }))
  },
  free_time: {
    label: '自主时间',
    columns: [
      { key: 'tLocal', label: '时间', type: 'time', width: 165 },
      { key: 'hit', label: '命中', type: 'bool', width: 90 },
      { key: 'prob', label: '概率', type: 'number', align: 'right', width: 90 },
      { key: 'target', label: '目标会话', type: 'text' }
    ],
    sort: { tLocal: 't', t: 't', hit: 'hit', prob: 'prob' },
    search: ['target'],
    load: () => freeTimeEvents(2000).map((e) => ({ ...e, id: e.id, t: e.at || '', tLocal: localTimeStr(e.at) }))
  }
};

const LABELS = {
  tool_call: '工具调用', audit_event: '审计事件', bili_event: 'B站事件', bili_note: 'B站感受',
  douyin_event: '抖音事件', qzone_action: '空间动作', gen_image: '生成图', persona: '人设',
  sticker: '表情', memory_doc: '记忆文档', fs_event: '文件事件', free_time: '自主时间', activity: '聊天活动'
};

export function isRecordType(type) { return Boolean(SQL_DEFS[type] || FILE_DEFS[type]); }
export const RECORD_TYPES = [...Object.keys(SQL_DEFS), ...Object.keys(FILE_DEFS)];

function fileRows(type) {
  const def = FILE_DEFS[type];
  return def ? def.load() : [];
}

function searchHit(item, fields, q) {
  if (!q) return true;
  for (const f of fields) {
    const v = item[f];
    if (v == null) continue;
    const text = Array.isArray(v) ? v.join(' ') : (typeof v === 'object' ? objText(v) : String(v));
    if (text.toLowerCase().includes(q)) return true;
  }
  return false;
}

function sqlWhere(def, { q, from, to }) {
  const clauses = [];
  const params = [];
  const timeCol = def.timeCol || 't';
  if (from) {
    clauses.push(`${timeCol} >= ?`);
    params.push(new Date(`${from}T00:00:00+08:00`).toISOString());
  }
  if (to) {
    clauses.push(`${timeCol} < ?`);
    params.push(new Date(new Date(`${to}T00:00:00+08:00`).getTime() + 86400000).toISOString());
  }
  if (q) {
    const like = '%' + q.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
    clauses.push('(' + def.search.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    for (const _ of def.search) params.push(like);
  }
  return { where: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params };
}

export function listRecords(type, opts = {}) {
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(200, Math.max(5, Number(opts.pageSize) || 25));
  const qRaw = String(opts.q || '').trim();
  const q = qRaw.toLowerCase();
  const from = opts.from || '';
  const to = opts.to || '';
  const dir = opts.dir === 'asc' ? 'asc' : 'desc';
  const def = SQL_DEFS[type] || FILE_DEFS[type];
  if (!def) return null;
  const sortable = Object.keys(def.sort);
  const sortField = sortable.includes(opts.sort) ? opts.sort : 'tLocal';
  let items = [];
  let total = 0;

  if (SQL_DEFS[type]) {
    const { where, params } = sqlWhere(def, { q, from, to });
    try {
      total = Number(dbOne(`SELECT COUNT(*) AS c FROM ${def.table}${where}`, ...params)?.c || 0);
      const totalPages0 = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, totalPages0);
      const sortCol = def.sort[sortField] || (def.timeCol || 't');
      const rows = dbRows(
        `SELECT ${def.select} FROM ${def.table}${where} ORDER BY ${sortCol} ${dir.toUpperCase()} LIMIT ? OFFSET ?`,
        ...params, pageSize, (safePage - 1) * pageSize
      ) || [];
      items = rows.map(def.map);
      return {
        type, label: def.label || LABELS[type] || type, page: safePage, pageSize, total,
        totalPages: totalPages0, sort: { field: sortField, dir }, sortable,
        filters: { q: qRaw, from, to }, columns: def.columns || [], items,
        generatedAt: new Date().toISOString()
      };
    } catch {
      return { type, label: def.label || type, page: 1, pageSize, total: 0, totalPages: 1, sort: { field: sortField, dir }, sortable, filters: { q: qRaw, from, to }, columns: def.columns || [], items: [], generatedAt: new Date().toISOString() };
    }
  }

  // 文件类：JS 过滤 / 排序 / 分页
  let rows = fileRows(type).filter((r) => {
    const day = localDayOf(r.t);
    if (from && (!day || day < from)) return false;
    if (to && (!day || day > to)) return false;
    return true;
  });
  if (q) rows = rows.filter((r) => searchHit(r, def.search || [], q));
  const cmp = (a, b) => {
    let av = a[sortField], bv = b[sortField];
    if (sortField === 't') { av = Date.parse(av) || 0; bv = Date.parse(bv) || 0; }
    if (sortField === 'tLocal') { av = Date.parse(a.t) || 0; bv = Date.parse(b.t) || 0; }
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    if (typeof av === 'boolean' && typeof bv === 'boolean') return (av ? 1 : 0) - (bv ? 1 : 0);
    const as = String(av ?? ''), bs = String(bv ?? '');
    return as < bs ? -1 : as > bs ? 1 : 0;
  };
  rows = rows.slice().sort((a, b) => (dir === 'asc' ? cmp(a, b) : cmp(b, a)));
  total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  items = rows.slice((safePage - 1) * pageSize, safePage * pageSize);
  return {
    type, label: def.label || LABELS[type] || type, page: safePage, pageSize, total, totalPages,
    sort: { field: sortField, dir }, sortable,
    filters: { q: qRaw, from, to }, columns: def.columns || [], items,
    generatedAt: new Date().toISOString()
  };
}

// ============ 关联 / 文件 / 详情 ============
function detailFiles(type, item) {
  const files = [];
  if (type === 'gen_image') files.push({ label: '图片文件', path: path.join(IMAGEGEN_DIR, item.name), url: item.url, kind: 'image' });
  if (type === 'persona') {
    const dir = personaDir(item.name);
    for (const f of ['persona.md', 'meta.json', 'avatar.jpg']) {
      const p = path.join(dir, f);
      const st = safeStat(p);
      if (st) files.push({
        label: f, path: p, bytes: st.size, kind: f.endsWith('.jpg') ? 'image' : 'text',
        url: f === 'avatar.jpg' ? `/api/persona/avatar?role=${encodeURIComponent(item.name)}` : ''
      });
    }
  }
  if (type === 'memory_doc') {
    const st = safeStat(item.path);
    if (st) files.push({ label: item.name, path: item.path, bytes: st.size, kind: 'text' });
  }
  if (type === 'sticker' && item.url) files.push({ label: '表情图片', path: '', url: item.url, kind: 'image' });
  if (type === 'fs_event') {
    const st = safeStat(item.path);
    if (st) files.push({ label: '文件', path: item.path, bytes: st.size, kind: 'text' });
  }
  return files;
}

function relatedOf(type, item) {
  const out = [];
  const push = (t, id, label, title, tLocal, extra = '') => out.push({ type: t, id, label, title, tLocal, extra });
  try {
    if (type === 'tool_call') {
      const peers = (dbRows('SELECT id,t,tool,ok,error FROM tool_calls WHERE conv_key = ? ORDER BY rowid DESC LIMIT 12', item.convKey) || [])
        .filter((r) => String(r.id) !== String(item.id));
      for (const r of peers.slice(0, 8)) push('tool_call', r.id, '同会话工具调用', `${r.tool}${r.ok ? '' : ' · 失败'}`, localTimeStr(r.t), r.error ? trim(r.error, 120) : '');
    } else if (type === 'audit_event') {
      const peers = (dbRows('SELECT id,t,action,target FROM audit_events WHERE conv_key = ? ORDER BY rowid DESC LIMIT 12', item.convKey) || [])
        .filter((r) => String(r.id) !== String(item.id));
      for (const r of peers.slice(0, 8)) push('audit_event', r.id, '同会话审计', r.action, localTimeStr(r.t), r.target || '');
    } else if (type === 'bili_event' && item.bvid) {
      for (const n of biliNotes(20)) if (n.bvid === item.bvid) push('bili_note', n.id, '同一视频的她的感受', n.title, localTimeStr(n.t), trim(n.note, 120));
      for (const e of biliEvents(30)) if (e.bvid === item.bvid && String(e.id) !== String(item.id)) push('bili_event', e.id, '同一视频的其它动作', e.action, localTimeStr(e.t));
    } else if (type === 'bili_note' && item.bvid) {
      for (const e of biliEvents(30)) if (e.bvid === item.bvid) push('bili_event', e.id, '同一视频的观看动作', e.action, localTimeStr(e.t));
    } else if (type === 'douyin_event') {
      const peers = douyinEvents(60).filter((e) => String(e.id) !== String(item.id) && (e.author === item.author || e.aweme_id === item.awemeId)).slice(0, 8);
      for (const e of peers) push('douyin_event', e.id, '同作者/同视频', e.title || e.action, localTimeStr(e.t));
    } else if (type === 'qzone_action') {
      const peers = qzoneEvents(60).filter((e) => String(e.id) !== String(item.id)).slice(0, 10);
      for (const e of peers) push('qzone_action', e.id, '空间动作', e.type, localTimeStr(e.at));
    } else if (type === 'sticker') {
      for (const role of item.personas || []) push('persona', role, '使用此人设', role, '');
    } else if (type === 'memory_doc') {
      for (const d of memoryDocList().filter((x) => x.id !== item.id).slice(0, 12)) {
        push('memory_doc', d.id, d.kind === 'daily' ? '日报' : '记忆文档', d.name, localTimeStr(d.mtime));
      }
    } else if (type === 'persona') {
      const pmap = stickerPersonaMap();
      for (const s of stickers().filter((x) => (pmap[String(x.id)] || []).includes(item.name)).slice(0, 10)) {
        push('sticker', String(s.id), '专属表情', s.desc || s.md5 || '');
      }
    } else if (type === 'gen_image') {
      const cfg = readJson(imagegenConfigPath(), {});
      out.push({ type: 'meta', id: '', label: '生图配置', title: `${cfg.model || ''} · ${cfg.size || ''}`, tLocal: '', extra: `refsCount=${cfg.refsCount ?? 0}` });
    } else if (type === 'free_time') {
      for (const e of freeTimeEvents(12).filter((x) => String(x.id) !== String(item.id))) {
        push('free_time', e.id, '自主时间判定', e.hit ? '命中' : '未命中', localTimeStr(e.at), `p=${e.prob}`);
      }
    } else if (type === 'activity') {
      const peers = (dbRows('SELECT id,t,text FROM activity WHERE conv_key = ? ORDER BY rowid DESC LIMIT 12', item.conv) || [])
        .filter((r) => String(r.id) !== String(item.id)).slice(0, 8);
      for (const r of peers) push('activity', r.id, '同会话消息', trim(r.text, 80), localTimeStr(r.t));
    } else if (type === 'fs_event') {
      out.push({ type: 'meta', id: '', label: '文件状态', title: item.exists ? '文件存在' : '文件已不存在', tLocal: '', extra: item.path });
    }
  } catch {}
  return out.slice(0, 12);
}

export function getRecord(type, id) {
  const def = SQL_DEFS[type] || FILE_DEFS[type];
  if (!def) return null;
  let item = null;
  if (SQL_DEFS[type]) {
    const r = dbRows(`SELECT ${def.select} FROM ${def.table} WHERE id = ? LIMIT 1`, String(id))?.[0];
    if (!r) return null;
    item = def.map(r);
  } else {
    item = fileRows(type).find((r) => String(r.id) === String(id));
    if (!item) return null;
  }
  let raw = null;
  let content = '';
  if (type === 'memory_doc') {
    content = readText(item.path, '');
    raw = { path: item.path, bytes: item.bytes, lines: item.lines, content: content.slice(0, 300 * 1024) };
  } else if (type === 'persona') {
    const meta = readPersonaMeta(item.name);
    const personaPath = path.join(personaDir(item.name), 'persona.md');
    const md = readText(personaPath, '');
    raw = { meta, personaMd: md.slice(0, 200 * 1024), personaPath };
    content = md;
  } else if (type === 'gen_image') {
    const p = path.join(IMAGEGEN_DIR, item.name);
    const st = safeStat(p);
    raw = { path: p, bytes: st?.size ?? 0, mtime: st ? st.mtime.toISOString() : '' };
  } else if (type === 'sticker') {
    raw = { ...item };
  } else if (RAW_BY_ID[type]) {
    const extra = RAW_BY_ID[type](String(id));
    item = { ...item, ...(extra || {}) };
    const parsedRaw = parseMaybeJson(item.raw);
    raw = parsedRaw ?? (item.raw || { ...item });
  } else {
    raw = { ...item };
  }
  return {
    type, id: String(id), label: def.label || LABELS[type] || type, columns: def.columns || [],
    item, raw, content, files: detailFiles(type, item), related: relatedOf(type, item),
    generatedAt: new Date().toISOString()
  };
}
