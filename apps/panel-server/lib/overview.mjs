// Synapse 3 面板后端 · 概览 / 花费 / 健康检查
import fs from 'node:fs';
import path from 'node:path';
import {
  BOT, QB, QB_STATE, IMAGEGEN_DIR, DB_PATH, PORT, HOST, UI_DIST, STARTED_AT,
  todayKey, localTimeStr, localDayOf, dayList, readJson, readText, dbOne, dbBytes,
  alertsConfig, versionInfo, priceTable, safeStat
} from './core.mjs';
import {
  getBalance, getBridgeStatus, tokenStats, toolStats, personaList, stickers, memoryDocList,
  biliNotes, biliEvents, douyinEvents, qzoneEvents, genImages, recentActivity, meta
} from './sources.mjs';
import { resolveConversations } from './names.mjs';

const tokenTotal = (u) => Number(u.cacheMiss || 0) + Number(u.cacheHit || 0) + Number(u.cacheWrite || 0) + Number(u.output || 0) + Number(u.reasoning || 0);

function buildAlerts(tokens, toolCalls, balance, cfg) {
  const alerts = [];
  const todayStr = todayKey();
  const monthStr = todayStr.slice(0, 7);
  const monthCost = tokens.allDays.filter((d) => String(d.day || '').startsWith(monthStr)).reduce((a, d) => a + (Number(d.cost) || 0), 0);
  const monthlyBudget = Number(cfg.monthlyBudget) > 0 ? Number(cfg.monthlyBudget) : 20;
  const todayCost = Number(tokens.today.cost) || 0;
  if (monthCost >= monthlyBudget * 0.8) {
    alerts.push({ level: monthCost >= monthlyBudget ? 'bad' : 'warn', text: `本月花费 ¥${monthCost.toFixed(2)}${monthCost >= monthlyBudget ? ' 已达到' : ' 接近'}预算 ¥${monthlyBudget}` });
  }
  if (todayCost >= Number(cfg.dailyCostWarn)) {
    alerts.push({ level: 'warn', text: `今日花费 ¥${todayCost.toFixed(3)}，超过阈值 ¥${Number(cfg.dailyCostWarn)}` });
  }
  if (balance?.ok && Number(balance.total) <= Number(cfg.balanceWarn)) {
    alerts.push({ level: 'bad', text: `余额只剩 ¥${Number(balance.total).toFixed(2)}，低于阈值 ¥${Number(cfg.balanceWarn)}` });
  }
  const errToday = (toolCalls.errorsToday || []).reduce((a, b) => a + (Number(b.count) || 0), 0);
  if (errToday >= Number(cfg.errorWarn)) alerts.push({ level: 'bad', text: `今日工具错误 ${errToday} 次，超过阈值 ${Number(cfg.errorWarn)}` });
  const costGuard = readJson(path.join(BOT, 'state', 'cost-guard.json'), { active: false });
  const health = readJson(path.join(BOT, 'state', 'health.json'), { ok: true });
  if (costGuard && costGuard.active) alerts.push({ level: 'warn', text: `成本守护：${costGuard.reason || '余额/花费超阈值'}（主动行为已降档、空间暂停）` });
  if (health && health.ok === false && Array.isArray(health.failures) && health.failures.length) {
    const ht = health.at ? new Date(health.at).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '';
    alerts.push({ level: 'bad', text: `健康自检异常（${ht || '时间未知'}）：${health.failures.slice(0, 2).join('；')}${ht ? '（一小时一次，可能已过期）' : ''}` });
  }
  return { alerts, monthCost, todayCost, monthCostRaw: monthCost, costGuard, health };
}

export function latestMap(qzoneAll) {
  const num = (v) => { if (typeof v === 'number' && Number.isFinite(v)) return v; if (typeof v === 'string' && v) return Date.parse(v) || 0; return 0; };
  const ts = (sql) => num(dbOne(sql)?.m);
  let genMax = 0;
  try { for (const f of fs.readdirSync(IMAGEGEN_DIR)) { if (/^gen-.*\.(jpe?g|png|webp)$/i.test(f)) genMax = Math.max(genMax, fs.statSync(path.join(IMAGEGEN_DIR, f)).mtimeMs); } } catch {}
  let lifeMax = 0;
  for (const dir of [path.join(BOT, 'books'), path.join(BOT, '学习')]) {
    try { for (const f of fs.readdirSync(dir)) lifeMax = Math.max(lifeMax, fs.statSync(path.join(dir, f)).mtimeMs); } catch {}
  }
  for (const f of ['free-time.jsonl', 'surf-log.jsonl', 'sleep-plan.json'].map((x) => path.join(BOT, 'state', x))) {
    try { lifeMax = Math.max(lifeMax, fs.statSync(f).mtimeMs); } catch {}
  }
  let memoryMax = 0;
  for (const f of ['记忆库.md', '长记忆.md'].map((x) => path.join(BOT, x))) {
    try { memoryMax = Math.max(memoryMax, fs.statSync(f).mtimeMs); } catch {}
  }
  return {
    overview: Math.max(ts('SELECT MAX(t) AS m FROM tool_calls'), ts('SELECT MAX(t) AS m FROM activity')),
    cost: ts('SELECT MAX(t) AS m FROM token_usage'),
    audit: ts('SELECT MAX(t) AS m FROM tool_calls'),
    bili: Math.max(ts('SELECT MAX(t) AS m FROM bili_events'), ts('SELECT MAX(t) AS m FROM bili_notes')),
    qzone: Math.max(0, ...qzoneAll.slice(0, 1).map((x) => Date.parse(x.at) || 0)),
    douyin: ts('SELECT MAX(t) AS m FROM douyin_events'),
    album: genMax,
    life: Math.max(lifeMax, ts('SELECT MAX(t) AS m FROM fs_events')),
    memory: memoryMax
  };
}

export async function buildOverview(range, opts = {}) {
  const tokens = tokenStats(range);
  const toolCalls = toolStats(range);
  const cfg = alertsConfig();
  const [status, balance] = await Promise.all([getBridgeStatus(), opts.light ? Promise.resolve({ ok: false, light: true }) : getBalance()]);
  const alertInfo = buildAlerts(tokens, toolCalls, balance, cfg);
  const metaObj = meta();
  const todayStr = todayKey();
  const monthStr = todayStr.slice(0, 7);
  const monthCost = tokens.allDays.filter((d) => String(d.day || '').startsWith(monthStr)).reduce((a, d) => a + (Number(d.cost) || 0), 0);
  const todayCost = Number(tokens.today.cost) || 0;
  const rangeCost = Number(tokens.totals.cost) || 0;
  const activeDays = tokens.days.filter((d) => Number(d.steps) > 0).length || 1;
  const rangeToolResults = (toolCalls.tools || []).reduce((a, t) => a + Number(t.ok || 0) + Number(t.error || 0), 0);
  const errorsToday = (toolCalls.errorsToday || []).reduce((a, b) => a + (Number(b.count) || 0), 0);
  const errRatio = rangeToolResults > 0 ? (toolCalls.errors || []).length / rangeToolResults : 0;

  // 近 7 日趋势（费用 / token / 工具错误）
  const dayMap = new Map((tokens.allDays || []).map((d) => [d.day, d]));
  const errMap = new Map((toolCalls.errDays || []).map((d) => [d.day, d.error]));
  const days = dayList(7).map((day) => {
    const u = dayMap.get(day) || {};
    return {
      day,
      cost: Number(u.cost || 0),
      tokens: tokenTotal(u),
      steps: Number(u.steps || 0),
      turns: Number(u.turns || 0),
      error: Number(errMap.get(day) || 0)
    };
  });

  // 模型占比
  const modelTotal = (tokens.models || []).reduce((a, m) => a + (Number(m.cost) || 0), 0) || 1;
  const models = (tokens.models || []).map((m) => ({
    model: m.model, cost: Number(m.cost || 0), tokens: tokenTotal(m),
    share: (Number(m.cost) || 0) / modelTotal
  }));

  const qzoneAll = qzoneEvents(400);
  const biliAll = biliEvents(800);
  const biliNoteAll = biliNotes(800);
  const dyAll = douyinEvents(800);
  const stickersList = stickers();
  const personaRows = personaList();
  const docs = memoryDocList();
  const genList = genImages(400);
  const social = readJson(path.join(QB_STATE, 'social-v2.json'), { conversations: {} });
  const biliSchedule = readJson(path.join(QB_STATE, 'bili-schedule.json'), {});
  const biliNext = {};
  for (const [k, v] of Object.entries(social.conversations || {})) {
    const at = Number(v?.proactiveNextAt || 0);
    if (at > Date.now()) biliNext[k] = at;
  }
  const recentTools = (dbOne("SELECT COUNT(*) AS c FROM tool_calls WHERE type = 'result'")?.c) || 0;

  return {
    generatedAt: new Date().toISOString(),
    range,
    meta: metaObj,
    status,
    balance,
    alerts: alertInfo.alerts,
    alertsConfig: cfg,
    costGuard: alertInfo.costGuard,
    health: alertInfo.health,
    kpis: {
      todayCost, monthCost, rangeCost, monthBudget: cfg.monthlyBudget,
      avgDailyCost: rangeCost / activeDays,
      todayTokens: tokenTotal(tokens.today),
      rangeTokens: tokenTotal(tokens.totals),
      totalCostAllTime: (tokens.allDays || []).reduce((a, d) => a + (Number(d.cost) || 0), 0),
      cacheHitRate: (() => {
        const hit = Number(tokens.totals.cacheHit || 0), miss = Number(tokens.totals.cacheMiss || 0), write = Number(tokens.totals.cacheWrite || 0);
        return hit + miss + write > 0 ? hit / (hit + miss + write) : 0;
      })(),
      toolResults: rangeToolResults,
      toolCallsTotal: recentTools,
      errorsToday, errorRate: errRatio,
      biliToday: biliAll.filter((e) => localDayOf(e.t) === todayStr).length,
      biliTotal: biliAll.length,
      biliNotesTotal: biliNoteAll.length,
      douyinTotal: dyAll.length,
      qzoneToday: qzoneAll.filter((e) => localDayOf(e.at) === todayStr).length,
      qzoneTotal: qzoneAll.length,
      genTotal: genList.length,
      stickersTotal: stickersList.length,
      personasTotal: personaRows.length,
      memoryDocsTotal: docs.length,
      balance: balance?.ok ? Number(balance.total) : null
    },
    trends: { days, toolTop: (toolCalls.tools || []).slice(0, 8), models },
    activity: recentActivity(14),
    recentTools: toolCalls.recent.slice(0, 10),
    errorsToday: toolCalls.errorsTodayList.slice(0, 10),
    counters: {
      bili: dbOne('SELECT COUNT(*) AS c FROM bili_events')?.c || 0,
      biliNotes: dbOne('SELECT COUNT(*) AS c FROM bili_notes')?.c || 0,
      douyin: dbOne('SELECT COUNT(*) AS c FROM douyin_events')?.c || 0,
      qzone: qzoneAll.length,
      gen: genList.length,
      stickers: stickersList.length,
      personas: personaRows.length,
      memoryDocs: docs.length
    },
    next: {
      biliScheduleNext: Number(biliSchedule?.nextBiliAt || 0),
      biliNext,
      sleepPlan: readJson(path.join(BOT, 'state', 'sleep-plan.json'), null),
      freeTimeState: readJson(path.join(QB_STATE, 'free-time.json'), null),
      surfState: readJson(path.join(QB_STATE, 'web-surf.json'), null)
    },
    latest: latestMap(qzoneAll)
  };
}

export async function buildCosts(range) {
  const tokens = tokenStats(range);
  const todayStr = todayKey();
  const monthStr = todayStr.slice(0, 7);
  const monthDays = (tokens.allDays || []).filter((d) => String(d.day || '').startsWith(monthStr));
  const monthCost = monthDays.reduce((a, d) => a + (Number(d.cost) || 0), 0);
  const cfg = alertsConfig();
  const budget = Number(cfg.monthlyBudget) > 0 ? Number(cfg.monthlyBudget) : 20;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = Number(todayKey().slice(8, 10));
  const daysLeft = Math.max(0, daysInMonth - dayOfMonth);
  const modelTotal = (tokens.models || []).reduce((a, m) => a + (Number(m.cost) || 0), 0) || 1;
  const models = (tokens.models || []).map((m) => ({
    model: m.model, cost: Number(m.cost || 0), tokens: tokenTotal(m), steps: m.steps, turns: m.turns,
    share: (Number(m.cost) || 0) / modelTotal
  }));
  const hit = Number(tokens.totals.cacheHit || 0), miss = Number(tokens.totals.cacheMiss || 0), write = Number(tokens.totals.cacheWrite || 0);
  const stepCount = Number(tokens.totals.steps || 0) || 1;
  const turnCount = Number(tokens.totals.turns || 0) || 1;
  const days = (tokens.days || []).slice(0, 60).map((d) => ({
    ...d, tokens: tokenTotal(d), cacheHitRate: (() => { const h = Number(d.cacheHit || 0), m = Number(d.cacheMiss || 0), w = Number(d.cacheWrite || 0); return h + m + w > 0 ? h / (h + m + w) : 0; })()
  }));
  const balance = await getBalance();
  const convsBase = (tokens.convs || []).slice(0, 40).map((c) => ({ ...c, tokens: tokenTotal(c) }));
  // 会话 key 解析成 QQ 昵称 / 群名（网关不可用时回退「私聊/群 + 号码」）
  const convs = await resolveConversations(convsBase, { ownerQQ: meta().ownerQQ });
  return {
    generatedAt: new Date().toISOString(),
    range,
    totals: { ...tokens.totals, tokens: tokenTotal(tokens.totals) },
    today: { ...tokens.today, tokens: tokenTotal(tokens.today) },
    days, models,
    convs,
    cache: { hit, miss, write, hitRate: hit + miss + write > 0 ? hit / (hit + miss + write) : 0 },
    avg: {
      costPerStep: Number(tokens.totals.cost || 0) / stepCount,
      costPerTurn: Number(tokens.totals.cost || 0) / turnCount,
      tokensPerStep: tokenTotal(tokens.totals) / stepCount,
      tokensPerTurn: tokenTotal(tokens.totals) / turnCount,
      costPerDay: Number(tokens.totals.cost || 0) / Math.max(1, Number(range.active ? days.length : (tokens.allDays || []).length || 1))
    },
    month: { month: monthStr, cost: monthCost, budget, pct: budget > 0 ? monthCost / budget : 0, daysLeft, daysInMonth, dayOfMonth, projected: dayOfMonth > 0 ? (monthCost / dayOfMonth) * daysInMonth : 0 },
    price: { version: priceTable().version || '', unit: priceTable().unit || 1e6, peakMultiplier: priceTable().peakMultiplier || 2 },
    balance
  };
}

export function buildHealth() {
  const v = versionInfo();
  const dbOk = Boolean(dbOne('SELECT 1 AS x'));
  const bridgeLog = path.join(QB_STATE, 'bridge.log');
  const bridgeStat = safeStat(bridgeLog);
  let uiBuilt = false;
  try { uiBuilt = fs.existsSync(path.join(UI_DIST, 'index.html')); } catch {}
  const qzPid = readText(path.join(BOT, 'qzone', 'qzone-bot.pid'), '').trim();
  return {
    ok: dbOk,
    name: v.name,
    version: v.version,
    versionUpdatedAt: v.updatedAt,
    startedAt: new Date(STARTED_AT).toISOString(),
    uptime: Math.round(process.uptime()),
    now: localTimeStr(new Date()),
    host: HOST,
    port: PORT,
    pid: process.pid,
    node: process.version,
    memory: { rssMB: Math.round(process.memoryUsage().rss / 1048576) },
    db: { ok: dbOk, path: DB_PATH, bytes: dbBytes() },
    ui: { built: uiBuilt, dist: UI_DIST },
    sources: {
      storeDir: QB_STATE,
      bridgeLogAt: bridgeStat ? bridgeStat.mtime.toISOString() : '',
      qzonePid: qzPid,
      health: readJson(path.join(BOT, 'state', 'health.json'), null)
    }
  };
}
