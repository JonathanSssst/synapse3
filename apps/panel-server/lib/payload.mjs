// Synapse 3 面板后端 · 旧版 /api/data 兼容载荷（保持字段与语义不变）
import fs from 'node:fs';
import path from 'node:path';
import {
  BOT, QB, QB_STATE, IMAGEGEN_DIR, todayKey, localTimeStr, localDayOf, readJson, readText,
  tailLines, dbOne, dbRows, alertsConfig
} from './core.mjs';
import {
  getBalance, getBridgeStatus, tokenStats, toolStats, parseAudit, stickers, qzoneEvents,
  biliEvents, biliNotes, douyinEvents, genImages, lifeData, bridgePersonas, personaStickerMap,
  refsData, memoryDocs, meta, personaList
} from './sources.mjs';

export async function buildLegacyPayload(range) {
  const todayStr = todayKey();
  const monthStr = todayStr.slice(0, 7);
  let activityLines = null;
  const rows = dbRows('SELECT raw FROM activity ORDER BY rowid DESC LIMIT 800');
  if (rows) activityLines = rows.map((r) => r.raw);
  if (!activityLines) activityLines = tailLines(readText(path.join(QB_STATE, 'qq-activity.log')), 800).reverse();
  activityLines = activityLines.slice(0, 200);
  // 三个外部/桥接调用并行，避免串行超时把 /api/data 拖到十几秒
  const [balance, bridgeStatus, bridgePersonasData] = await Promise.all([
    getBalance(),
    getBridgeStatus(),
    bridgePersonas()
  ]);
  const tokens = tokenStats(range);
  const toolCalls = toolStats(range);
  const metaObj = meta();
  const alertCfg = alertsConfig();
  const alerts = [];
  const monthCost = tokens.allDays.filter((d) => String(d.day || '').startsWith(monthStr)).reduce((a, d) => a + (Number(d.cost) || 0), 0);
  const monthlyBudget = Number(alertCfg.monthlyBudget) > 0 ? Number(alertCfg.monthlyBudget) : 20;
  const todayCost = Number(tokens.today.cost) || 0;
  if (monthCost >= monthlyBudget * 0.8) {
    alerts.push({ level: monthCost >= monthlyBudget ? 'bad' : 'warn', text: `本月花费 ¥${monthCost.toFixed(2)}${monthCost >= monthlyBudget ? ' 已达到' : ' 接近'}预算 ¥${monthlyBudget}` });
  }
  if (todayCost >= Number(alertCfg.dailyCostWarn)) {
    alerts.push({ level: 'warn', text: `今日花费 ¥${todayCost.toFixed(3)}，超过阈值 ¥${Number(alertCfg.dailyCostWarn)}` });
  }
  if (balance?.ok && Number(balance.total) <= Number(alertCfg.balanceWarn)) {
    alerts.push({ level: 'bad', text: `余额只剩 ¥${Number(balance.total).toFixed(2)}，低于阈值 ¥${Number(alertCfg.balanceWarn)}` });
  }
  const errToday = (toolCalls.errorsToday || []).reduce((a, b) => a + (Number(b.count) || 0), 0);
  if (errToday >= Number(alertCfg.errorWarn)) {
    alerts.push({ level: 'bad', text: `今日工具错误 ${errToday} 次，超过阈值 ${Number(alertCfg.errorWarn)}` });
  }
  const costGuard = readJson(path.join(BOT, 'state', 'cost-guard.json'), { active: false });
  const health = readJson(path.join(BOT, 'state', 'health.json'), { ok: true });
  const biliSchedule = readJson(path.join(QB_STATE, 'bili-schedule.json'), {});
  if (costGuard && costGuard.active) {
    alerts.push({ level: 'warn', text: `成本守护：${costGuard.reason || '余额/花费超阈值'}（主动行为已降档、空间暂停）` });
  }
  if (health && health.ok === false && Array.isArray(health.failures) && health.failures.length) {
    alerts.push({ level: 'bad', text: `健康自检异常：${health.failures.slice(0, 2).join('；')}` });
  }
  metaObj.alerts = alerts;
  const social = readJson(path.join(QB_STATE, 'social-v2.json'), { paused: false, conversations: {} });
  const biliNext = {};
  for (const [k, v] of Object.entries(social.conversations || {})) {
    const at = Number(v?.proactiveNextAt || 0);
    if (at > Date.now()) biliNext[k] = at;
  }
  let biliLast = '';
  let biliToday = 0;
  const biliRows = dbRows('SELECT t FROM bili_events ORDER BY rowid DESC LIMIT 800') || [];
  biliLast = biliRows[0]?.t || '';
  biliToday = biliRows.filter((r) => localDayOf(r.t) === todayStr).length;
  const bili = biliEvents(300, range);
  const biliNoteRows = biliNotes(400, range);
  const douyin = douyinEvents(300, range);
  const qzoneAll = qzoneEvents(400);
  const qzone = qzoneAll;
  const qzoneToday = qzoneAll.filter((e) => localDayOf(e.at) === todayStr).length;
  const upMap = new Map();
  for (const e of bili) {
    const up = String(e.up || '（未知）');
    upMap.set(up, (upMap.get(up) || 0) + 1);
  }
  const biliUp = [...upMap.entries()].map(([up, count]) => ({ up, count })).sort((a, b) => b.count - a.count);
  const num = (v) => { if (typeof v === 'number' && Number.isFinite(v)) return v; if (typeof v === 'string' && v) return Date.parse(v) || 0; return 0; };
  const ts = (sql) => { try { return num(dbOne(sql)?.m); } catch { return 0; } };
  let genMax = 0;
  try { for (const f of fs.readdirSync(IMAGEGEN_DIR)) { if (/^gen-.*\.(jpe?g|png|webp)$/i.test(f)) genMax = Math.max(genMax, fs.statSync(path.join(IMAGEGEN_DIR, f)).mtimeMs); } } catch {}
  let lifeMax = 0;
  try { for (const f of fs.readdirSync(path.join(BOT, 'books'))) lifeMax = Math.max(lifeMax, fs.statSync(path.join(BOT, 'books', f)).mtimeMs); } catch {}
  try { for (const f of fs.readdirSync(path.join(BOT, '学习'))) lifeMax = Math.max(lifeMax, fs.statSync(path.join(BOT, '学习', f)).mtimeMs); } catch {}
  for (const f of [path.join(BOT, 'state', 'free-time.jsonl'), path.join(BOT, 'state', 'surf-log.jsonl'), path.join(BOT, 'state', 'sleep-plan.json')]) { try { lifeMax = Math.max(lifeMax, fs.statSync(f).mtimeMs); } catch {} }
  lifeMax = Math.max(lifeMax, ts('SELECT MAX(t) AS m FROM fs_events'));
  let personaMax = 0;
  try {
    for (const d of fs.readdirSync(path.join(QB, 'personas'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of ['meta.json', 'avatar.jpg', 'persona.md']) {
        try { personaMax = Math.max(personaMax, fs.statSync(path.join(QB, 'personas', d.name, f)).mtimeMs); } catch {}
      }
    }
  } catch {}
  const payload = {
    range: { from: range.from, to: range.to, active: range.active },
    status: bridgeStatus,
    balance,
    tokens,
    toolCalls,
    audit: { qzone: parseAudit('qzone-audit.log', range), chat: parseAudit('chat-audit.log', range) },
    activity: activityLines,
    stickers: stickers(),
    bili,
    biliScheduleNext: Number(biliSchedule?.nextBiliAt || 0),
    biliNotes: biliNoteRows,
    biliUp,
    latest: {
      overview: Math.max(ts('SELECT MAX(t) AS m FROM tool_calls'), ts('SELECT MAX(t) AS m FROM activity')),
      cost: ts('SELECT MAX(t) AS m FROM token_usage'),
      audit: ts('SELECT MAX(t) AS m FROM tool_calls'),
      bili: Math.max(ts('SELECT MAX(t) AS m FROM bili_events'), ts('SELECT MAX(t) AS m FROM bili_notes')),
      qzone: (() => { try { return Math.max(0, ...qzoneAll.slice(0, 1).map((x) => Date.parse(x.at) || 0)); } catch { return 0; } })(),
      douyin: ts('SELECT MAX(t) AS m FROM douyin_events'),
      album: genMax,
      life: lifeMax,
      memory: (() => { let m = 0; for (const f of [path.join(BOT, '记忆库.md'), path.join(BOT, '长记忆.md')]) { try { m = Math.max(m, fs.statSync(f).mtimeMs); } catch {} } return m; })(),
      persona: personaMax
    },
    otherUsage: {
      bili: (() => { try { return Number(dbOne('SELECT COUNT(*) AS c FROM bili_events')?.c || 0); } catch { return 0; } })(),
      douyin: (() => { try { return Number(dbOne('SELECT COUNT(*) AS c FROM douyin_events')?.c || 0); } catch { return 0; } })(),
      gen: (() => { try { return fs.readdirSync(IMAGEGEN_DIR).filter((f) => /^gen-.*\.(jpe?g|png|webp)$/i.test(f)).length; } catch { return 0; } })(),
      qzone: qzoneAll.length
    },
    toolErrorsToday: (toolCalls.errorsToday || []).map((x) => ({ tool: x.tool, error: x.count, lastError: x.lastError, lastAt: x.lastAt })),
    genImages: genImages(),
    life: lifeData(),
    personas: bridgePersonasData,
    personaStickers: personaStickerMap(),
    refs: refsData(),
    monthCost,
    costGuard,
    health,
    douyin,
    biliNext,
    biliLast,
    biliToday,
    qzone,
    qzoneState: readJson(path.join(BOT, 'qzone', 'state.json'), {}),
    qzoneToday,
    memory: memoryDocs(),
    alertsConfig: alertCfg,
    meta: metaObj
  };
  return payload;
}
