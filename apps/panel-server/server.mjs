// Synapse 3 面板后端 · HTTP 入口
// 只监听 127.0.0.1；提供 JSON API + Vue 静态资源 + 旧 /api/data 兼容
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  BOT, QB_STATE, PORT, HOST, parseRange, sendJson, readBody, readJson, localTimeStr, versionInfo, logLine, dbOne
} from './lib/core.mjs';
import { buildOverview, buildCosts, buildHealth, latestMap } from './lib/overview.mjs';
import { buildLegacyPayload } from './lib/payload.mjs';
import { listRecords, getRecord, isRecordType, RECORD_TYPES } from './lib/records.mjs';
import { handleGet, handlePost, handleExport } from './lib/actions.mjs';
import { readWhitelist, saveWhitelist, restartBridge } from './lib/whitelist.mjs';
import { listSessions as listSessionMemory } from './lib/session-memory.mjs';
import { buildVoiceOverview, saveVoiceConfig, savePersonaVoice, synthesizeSample, readSample } from './lib/voice.mjs';
import { createPersona, deletePersona, getPersonaTemplate, PersonaError } from './lib/personas.mjs';
import { masterStatus, masterStop, masterStart } from './lib/master.mjs';
import { dshRestartStatus, requestDshRestart } from './lib/restart-dsh.mjs';
import { reconnectDshStatus, requestDshReconnect } from './lib/reconnect-dsh.mjs';
import { checkBreezeClaim, markBreezeClaimed, startBreezeClaimWatch } from './lib/breeze-claim.mjs';
import { getSettings, saveSettings, removeConversation } from './lib/settings.mjs';
import { listSlang, batchSlang, updateSlang } from './lib/slang.mjs';
import { getMessageStats } from './lib/message-stats.mjs';
import { buildPetOverview, savePetSettings } from './lib/pet.mjs';
import { brainMemory, brainAction, brainContext } from './lib/brain-memory.mjs';
import { vitalsGet, vitalsTimeline, vitalsEvent } from './lib/vitals.mjs';
import { serveStatic, uiBuilt } from './lib/static.mjs';
import { lifeData, qzoneEvents, stickers, personaList, memoryDocList, genImages, refsData, meta as metaInfo } from './lib/sources.mjs';

const __dataCache = new Map();
const DATA_CACHE_TTL = 5 * 60 * 1000;
function refreshLegacyPayload(key, range, hit) {
  if (hit && hit.refreshing) return;
  if (hit) hit.refreshing = true;
  buildLegacyPayload(range).then((value) => {
    __dataCache.set(key, { at: Date.now(), value });
  }).catch((error) => {
    logLine(`legacy payload refresh failed: ${error?.message ?? error}`);
  }).finally(() => {
    const cur = __dataCache.get(key);
    if (cur) cur.refreshing = false;
  });
}
async function cachedLegacyPayload(range) {
  const key = `${range.from}|${range.to}`;
  const hit = __dataCache.get(key);
  // 有旧数据就直接返回（陈旧 5 分钟后后台刷新），保证 /api/data 始终是毫秒级
  if (hit) {
    if (Date.now() - hit.at > DATA_CACHE_TTL) refreshLegacyPayload(key, range, hit);
    return hit.value;
  }
  const value = await buildLegacyPayload(range);
  __dataCache.set(key, { at: Date.now(), value });
  if (__dataCache.size > 6) __dataCache.delete(__dataCache.keys().next().value);
  return value;
}
const __overviewCache = new Map();
async function cachedOverview(range, light) {
  const key = JSON.stringify([range.from, range.to, light]);
  const hit = __overviewCache.get(key);
  if (hit && Date.now() - hit.at < 20000) return hit.value;
  const value = await buildOverview(range, { light });
  __overviewCache.set(key, { at: Date.now(), value });
  if (__overviewCache.size > 20) __overviewCache.delete(__overviewCache.keys().next().value);
  return value;
}
const __costsCache = new Map();
async function cachedCosts(range) {
  const key = JSON.stringify([range.from, range.to]);
  const hit = __costsCache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.value;
  const value = await buildCosts(range);
  __costsCache.set(key, { at: Date.now(), value });
  if (__costsCache.size > 20) __costsCache.delete(__costsCache.keys().next().value);
  return value;
}
async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  // ---- 角色状态 ----
  if (p === '/api/vitals') {
    try {
      const role = String(url.searchParams.get('role') || '');
      if (!role) throw new Error('role 不能为空');
      sendJson(res, 200, await vitalsGet(role));
    } catch (error) { sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }); }
    return;
  }
  if (p === '/api/vitals/timeline') {
    try {
      const role = String(url.searchParams.get('role') || '');
      if (!role) throw new Error('role 不能为空');
      sendJson(res, 200, await vitalsTimeline(role, String(url.searchParams.get('day') || '')));
    } catch (error) { sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }); }
    return;
  }
  if (p === '/api/vitals/event' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      sendJson(res, 200, await vitalsEvent(body));
    } catch (error) { sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }); }
    return;
  }

  // ---- 长期事实记忆 ----
  if (p === '/api/brain-memory') {
    if (req.method === 'GET') {
      try {
        const role = String(url.searchParams.get('role') || '');
        if (!role) throw new Error('role 不能为空');
        sendJson(res, 200, { ok: true, ...(await brainMemory(role)) });
      } catch (error) { sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const action = String(body.action || '');
        if (action === 'context') sendJson(res, 200, await brainContext(String(body.role || ''), String(body.key || '')));
        else sendJson(res, 200, await brainAction(action, body));
      } catch (error) { sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  // ---- 消息统计 ----
  if (p === '/api/message-stats') {
    if (req.method === 'GET') { sendJson(res, 200, getMessageStats(url.searchParams.get('day') || '')); return; }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  // ---- 黑话库（代理桥接控制台 API）----
  if (p === '/api/slang') {
    if (req.method === 'GET') {
      try { sendJson(res, 200, await listSlang(url.searchParams.get('q') || '', url.searchParams.get('status') || '')); }
      catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  if ((p === '/api/slang/confirm' || p === '/api/slang/reject') && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { throw new Error('请求体不是合法 JSON'); }
      sendJson(res, 200, await batchSlang(p.endsWith('/confirm') ? 'confirm' : 'reject', body.ids));
    } catch (error) { sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }); }
    return;
  }
  if (p === '/api/slang/update' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { throw new Error('请求体不是合法 JSON'); }
      const id = String(body.id || '');
      if (!id) throw new Error('id 不能为空');
      sendJson(res, 200, await updateSlang(id, body.patch || {}));
    } catch (error) { sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }); }
    return;
  }

  // ---- 配置中心（桥接 / QZone / 会话）----
  if (p === '/api/settings') {
    if (req.method === 'GET') { sendJson(res, 200, getSettings()); return; }
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { throw new Error('请求体不是合法 JSON'); }
        sendJson(res, 200, await saveSettings(body));
      } catch (error) { sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  if (p === '/api/conversations/remove') {
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { throw new Error('请求体不是合法 JSON'); }
        if (body.confirm !== true) throw new Error('需要 confirm=true');
        sendJson(res, 200, await removeConversation(body.key));
      } catch (error) { sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  // ---- Breeze 每日签到提醒 ----
  if (p === '/api/breeze-claim') {
    if (req.method === 'GET') {
      try { sendJson(res, 200, await checkBreezeClaim({ force: false, notify: false })); }
      catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const action = String(body.action || 'check');
        if (action === 'mark') sendJson(res, 200, await markBreezeClaimed());
        else sendJson(res, 200, await checkBreezeClaim({ force: true, notify: true }));
      } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  // ---- 重启 DSH（本机桌面应用；先回包再异步执行）----
  if (p === '/api/restart-dsh') {
    if (req.method === 'GET') { sendJson(res, 200, dshRestartStatus()); return; }
    if (req.method === 'POST') {
      try { sendJson(res, 202, requestDshRestart()); } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  // ---- 重新接入 DSH 端口（不重启 DSH，只重发现端口 + 重启桥接）----
  if (p === '/api/reconnect-dsh') {
    if (req.method === 'GET') { sendJson(res, 200, reconnectDshStatus()); return; }
    if (req.method === 'POST') {
      try { sendJson(res, 202, requestDshReconnect()); } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  // ---- 总开关（临时停止/恢复桥接与 QZone；面板自身不停）----
  if (p === '/api/master') {
    if (req.method === 'GET') { sendJson(res, 200, masterStatus()); return; }
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { throw new Error('请求体不是合法 JSON'); }
        const action = String(body.action || '');
        if (action === 'stop') sendJson(res, 200, await masterStop());
        else if (action === 'start') sendJson(res, 200, await masterStart());
        else sendJson(res, 400, { ok: false, error: 'action 必须是 stop / start' });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  // ---- 健康 / 版本 ----
  if (p === '/api/health') {
    const h = buildHealth();
    sendJson(res, 200, h);
    return;
  }
  if (p === '/api/version') {
    sendJson(res, 200, { ok: true, ...versionInfo(), api: 1 });
    return;
  }
  if (p === '/api/latest') {
    sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), latest: latestMap(qzoneEvents(1)) });
    return;
  }
  if (p === '/api/meta') {
    sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), meta: metaInfo() });
    return;
  }

  // ---- 概览 / 花费 ----
  if (p === '/api/overview') {
    const range = parseRange(url.searchParams);
    sendJson(res, 200, await cachedOverview(range, url.searchParams.get('light') === '1'));
    return;
  }
  if (p === '/api/costs') {
    const range = parseRange(url.searchParams);
    sendJson(res, 200, await cachedCosts(range));
    return;
  }

  // ---- 统一记录 ----
  const rec = /^\/api\/records\/([a-z_]+)(?:\/([^/]+))?$/.exec(p);
  if (rec) {
    const type = rec[1];
    if (!isRecordType(type)) { sendJson(res, 404, { ok: false, error: `未知的记录类型：${type}`, types: RECORD_TYPES }); return; }
    if (rec[2] === undefined) {
      const data = listRecords(type, {
        page: url.searchParams.get('page'),
        pageSize: url.searchParams.get('pageSize'),
        q: url.searchParams.get('q'),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        sort: url.searchParams.get('sort'),
        dir: url.searchParams.get('dir')
      });
      sendJson(res, 200, data ?? { items: [], total: 0 });
      return;
    }
    const detail = getRecord(type, decodeURIComponent(rec[2]));
    if (!detail) { sendJson(res, 404, { ok: false, error: '记录不存在', type, id: rec[2] }); return; }
    sendJson(res, 200, detail);
    return;
  }

  // ---- 白名单配置（写 qq-bridge/config.json，保存后重启桥接）----
  if (p === '/api/config/whitelist') {
    if (req.method === 'GET') {
      try {
        sendJson(res, 200, readWhitelist());
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    if (req.method === 'POST') {
      let saved = null;
      try {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { throw new Error('请求体不是合法 JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体需要 JSON 对象');
        if (!('groups' in body) && !('privates' in body)) throw new Error('缺少 groups / privates 字段');
        saved = saveWhitelist(body.groups ?? [], body.privates ?? []);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      // 配置已落盘；桥接重启失败也要把 saved 结果带回去，便于人工处理
      const bridge = await restartBridge();
      if (!bridge.ok) {
        sendJson(res, 500, {
          ...saved, ok: false, saved: true, bridge,
          error: `白名单已保存，但桥接重启失败：${bridge.error}（配置已生效，可稍后重试或手动 schtasks /run /tn QQBridge）`
        });
        return;
      }
      sendJson(res, 200, { ...saved, bridge, message: `白名单已更新（群 ${saved.counts.groups} 个 · QQ ${saved.counts.privates} 个），桥接已重启（${bridge.waitedMs}ms）` });
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  // ---- 跨群记忆共享配置（写 qq-bridge/state/memory-sharing.json，桥接热读，无需重启）----
  if (p === '/api/memory-sharing') {
    const QB = path.dirname(QB_STATE);
    const shareFile = path.join(QB_STATE, 'memory-sharing.json');
    if (req.method === 'GET') {
      let cfg = {};
      try { cfg = readJson(shareFile, {}); } catch {}
      let role = '';
      try { role = String(readJson(path.join(QB_STATE, 'role-map.json'), {}).default || ''); } catch {}
      let global = '';
      if (role) { try { global = fs.readFileSync(path.join(QB, 'personas', role, 'memory', 'global.md'), 'utf8'); } catch {} }
      sendJson(res, 200, {
        ok: true,
        enabled: cfg.enabled !== false,
        groups: Array.isArray(cfg.groups) ? cfg.groups.map(String) : [],
        includePrivate: cfg.includePrivate === true,
        role,
        global
      });
      return;
    }
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { throw new Error('请求体不是合法 JSON'); }
        const groups = (Array.isArray(body.groups) ? body.groups : [])
          .map((g) => String(g).trim())
          .filter((g) => /^\d{5,12}$/.test(g));
        const data = { enabled: body.enabled !== false, groups: [...new Set(groups)], includePrivate: body.includePrivate === true };
        fs.mkdirSync(path.dirname(shareFile), { recursive: true });
        fs.writeFileSync(shareFile, JSON.stringify(data, null, 2), 'utf8');
        sendJson(res, 200, { ok: true, ...data, message: `共享记忆已更新：${data.groups.length} 个群${data.includePrivate ? ' + 主人私聊' : ''}` });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  // ---- 旧版整包（兼容）----
  if (p === '/api/data') {
    const range = parseRange(url.searchParams);
    sendJson(res, 200, await cachedLegacyPayload(range));
    return;
  }

  // ---- 聚合视图 ----
  if (p === '/api/life') {
    const life = lifeData();
    sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), ...life, booksAll: life.books, surfNotes: life.surfNotes });
    return;
  }
  if (p === '/api/qzone') {
    const events = qzoneEvents(400);
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    sendJson(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      state: readJson(path.join(BOT, 'qzone', 'state.json'), {}),
      paused: Boolean(readJson(path.join(BOT, 'qzone', 'state.json'), {}).paused),
      total: events.length,
      today: events.filter((e) => localTimeStr(e.at).slice(0, 10) === today).length,
      events: events.slice(0, 200)
    });
    return;
  }
  if (p === '/api/album') {
    sendJson(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      gen: genImages(200),
      refs: refsData(),
      stickers: stickers(),
      personas: personaList()
    });
    return;
  }
  if (p === '/api/memory') {
    sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), docs: memoryDocList() });
    return;
  }
  if (p === '/api/session-memory') {
    if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }
    try {
      const q = String(url.searchParams.get('q') || '');
      const kindRaw = String(url.searchParams.get('kind') || 'all');
      const kind = ['all', 'group', 'private'].includes(kindRaw) ? kindRaw : 'all';
      const { sessions, counts } = listSessionMemory({ q, kind });
      sendJson(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        filters: { q, kind },
        counts,
        sessions
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }

  // ---- 桌宠：状态 / 配置 / 陪看用量 / 活动记录 ----
  if (p === '/api/pet') {
    if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }
    try {
      sendJson(res, 200, await buildPetOverview());
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }
  if (p === '/api/pet/config' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, savePetSettings(body));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }

  // ---- 语音（Breeze TTS）设置 / 用量 / 试听 ----
  if (p === '/api/voice') {
    if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }
    try {
      sendJson(res, 200, await buildVoiceOverview());
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }
  const voiceSample = /^\/api\/voice\/sample\/([^/]+)$/.exec(p);
  if (voiceSample) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }
    const sample = readSample(decodeURIComponent(voiceSample[1]));
    if (!sample) { sendJson(res, 404, { ok: false, error: '试听文件不存在或已过期' }); return; }
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': sample.size, 'cache-control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(sample.file).pipe(res);
    return;
  }
  if (p === '/api/voice/save' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, saveVoiceConfig(body));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }
  if (p === '/api/voice/persona' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, savePersonaVoice(body));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }
  if (p === '/api/voice/test' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = await synthesizeSample(body);
      sendJson(res, r.status, r.payload);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }

  // ---- 人设创建 / 删除 / 模板（只写 personas 与 role-map）----
  if (p === '/api/persona/template' && req.method === 'GET') {
    sendJson(res, 200, getPersonaTemplate());
    return;
  }
  if ((p === '/api/persona/create' || p === '/api/persona/delete') && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const out = p.endsWith('/create') ? createPersona(body) : deletePersona(body);
      sendJson(res, 200, out);
    } catch (error) {
      const status = error instanceof PersonaError ? error.status : 400;
      sendJson(res, status, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }

  // ---- 动作 / 二进制 / 文本 ----
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (handleExport(req, res, url)) return;
    if (handleGet(req, res, url)) return;
  }
  if (req.method === 'POST') {
    if (await handlePost(req, res, url)) return;
  }

  // ---- 静态前端 ----
  if (serveStatic(req, res, url)) return;

  sendJson(res, 404, { ok: false, error: 'not found', path: p });
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (ms > 1500) logLine(`slow ${req.method} ${req.url} ${res.statusCode} ${ms}ms`);
  });
  handle(req, res).catch((error) => {
    logLine(`ERROR ${req.method} ${req.url} ${error?.stack || error}`);
    try { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); } catch { try { res.end(); } catch {} }
  });
});

server.on('error', async (error) => {
  logLine(`server error: ${error?.stack || error}`);
  if (error?.code !== 'EADDRINUSE') return;
  // 端口已被占用：若已有实例在服务，本进程是重复启动，直接退出（不重试、不常驻）
  try {
    const probe = await fetch(`http://${HOST}:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (probe.ok) {
      logLine('duplicate panel instance detected (port already serving /api/health); exiting');
      process.exit(0);
    }
  } catch {}
  logLine(`port ${PORT} is in use by another process; exiting`);
  process.exit(1);
});

process.on('uncaughtException', (error) => logLine(`uncaught: ${error?.stack || error}`));
process.on('unhandledRejection', (error) => logLine(`unhandled: ${error?.stack || error}`));

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

server.listen(PORT, HOST, () => {
  const v = versionInfo();
  console.log(`[panel] ${v.name} ${v.version} · API http://${HOST}:${PORT}/api/health · UI http://${HOST}:${PORT}/ui/`);
  console.log(`[panel] ui built: ${uiBuilt()} · db: ${dbOne('SELECT 1 AS x') ? 'ok' : 'unavailable'}`);
  startBreezeClaimWatch();
  // 只预热一次（无定时器、无常驻循环），让旧接口首次探活也走缓存
  setTimeout(() => {
    cachedLegacyPayload({ from: '', to: '', active: false })
      .then(() => logLine('legacy payload warmup done'))
      .catch((error) => logLine(`legacy payload warmup failed: ${error?.message ?? error}`));
  }, 1500);
});

// 供测试脚本读取的运行时信息
export { server };
