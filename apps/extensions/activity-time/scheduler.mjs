#!/usr/bin/env node
/**
 * activity-time 调度器 —— 所有「到点做点什么」的唯一来源。
 *
 * 设计原则（这一版最重要的一条）：
 *   **扩展不自己动。** 刷 B 站、发说说、读书、上网这些，扩展只声明「这件事叫什么、
 *   什么时段适合做、一天最多几次」。什么时候真的发生，由这里统一决定；
 *   发生的时候做什么、做不做，由模型自己决定。调度器不替她选内容。
 *
 * 为什么要把这件事收回来：原来桥接里有五个独立的定时器（刷B站/自由时间/上网/
 * 休息提醒/早安晚安），每个都写死了一段「现在该干什么」的提示语，扩展装没装都照跑。
 * 结果就是「扩展只提供能力」这条原则在实现上是假的。
 *
 * 这里只负责三件事：
 *   1. 读活动表（activity-time 的 baseActivities + 已装扩展声明的 activities）
 *   2. 判断「现在有没有一段空档适合做点什么」
 *   3. 叫醒她，并说明现在有哪些可选 —— 然后就不管了
 *
 * 她做完（或决定不做）会调 qq_activity_done，这里据此记账，避免反复打扰。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA, BRIDGE_STATE, CONFIG } from '../../../packages/paths/index.mjs';
import { allActivities, readState as readExtState, isInstalled } from '../../../packages/extensions/index.mjs';

const STATE_DIR = path.join(DATA, 'activity-time');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const CONF_FILE = path.join(CONFIG, 'activity-time.json');

const DEFAULTS = {
  enabled: true,
  tickMs: 60000,        // 检查间隔
  minGapMin: 45,        // 两次「提议」之间至少隔多久
  quiet: ['00:30-07:30'], // 这段完全不打扰（睡眠之外的兜底）
  overrides: {}         // { <activityId>: { enabled, window, dailyLimit, cooldownMin } }
};

const log = (m) => process.stderr.write(`[activity-time] ${m}\n`);

// ── 小工具 ────────────────────────────────────────────────────────────────

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

const dayKey = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 'HH:MM' → 当天分钟数 */
function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 'HH:MM-HH:MM' → { start, end, cross }；支持跨天（如 23:00-01:00） */
export function parseWindow(text) {
  const s = String(text || '').trim();
  const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(s);
  if (!m) return null;
  const start = toMin(m[1]);
  const end = toMin(m[2]);
  if (start === null || end === null) return null;
  return { start, end, cross: start > end };
}

export function inWindow(win, date = new Date()) {
  if (!win) return true;                       // 没写时段 = 不限
  const cur = date.getHours() * 60 + date.getMinutes();
  if (win.cross) return cur >= win.start || cur <= win.end;
  return cur >= win.start && cur <= win.end;
}

function inAny(winTexts, date = new Date()) {
  const list = Array.isArray(winTexts) ? winTexts : [winTexts];
  return list.filter(Boolean).some((w) => inWindow(parseWindow(w), date));
}

function loadConf() {
  const raw = readJson(CONF_FILE, {});
  return { ...DEFAULTS, ...raw, overrides: raw?.overrides && typeof raw.overrides === 'object' ? raw.overrides : {} };
}

function loadState() {
  const st = readJson(STATE_FILE, {});
  const today = dayKey();
  if (st.day !== today) {
    // 跨天重置：只清计数，保留 lastAnyAt 让冷却跨零点仍然生效
    return { day: today, triggers: {}, lastAnyAt: Number(st.lastAnyAt) || 0, lastDoneAt: {} };
  }
  return {
    day: today,
    triggers: st.triggers && typeof st.triggers === 'object' ? st.triggers : {},
    lastAnyAt: Number(st.lastAnyAt) || 0,
    lastDoneAt: st.lastDoneAt && typeof st.lastDoneAt === 'object' ? st.lastDoneAt : {}
  };
}

/** 当前生效的活动表：注册表声明 + 用户配置覆盖。 */
export function effectiveActivities(conf = loadConf()) {
  const extState = readExtState();
  const base = allActivities(extState);
  return base.map((a) => {
    const o = conf.overrides?.[a.id] || {};
    return {
      ...a,
      enabled: o.enabled !== false && a.enabled !== false,
      window: o.window ?? a.window,
      dailyLimit: Number.isFinite(Number(o.dailyLimit)) ? Number(o.dailyLimit) : (a.dailyLimit ?? 1),
      cooldownMin: Number.isFinite(Number(o.cooldownMin)) ? Number(o.cooldownMin) : (a.cooldownMin ?? 120)
    };
  });
}

// ── 与桥接通信 ────────────────────────────────────────────────────────────

function bridgeEndpoint() {
  const cfg = readJson(path.join(CONFIG, 'bridge.json'), {}) || {};
  // 兼容旧布局：桥接的配置也可能在 apps/bridge/config.json
  const legacy = readJson(path.join(import.meta.dirname, '..', '..', 'bridge', 'config.json'), {});
  const port = Number(cfg.consolePort || legacy.consolePort || 3100);
  let token = String(cfg.consoleToken || '').trim();
  if (!token) {
    for (const f of ['console-token', 'bridge-token']) {
      try { token = fs.readFileSync(path.join(BRIDGE_STATE, f), 'utf8').trim(); break; } catch {}
    }
  }
  const ownerQQ = String(cfg.ownerQQ || legacy.ownerQQ || '').trim();
  return { port, token, ownerQQ };
}

async function wakeBridge(activity, targetKey) {
  const { port, token, ownerQQ } = bridgeEndpoint();
  const key = targetKey || (ownerQQ ? `private:${ownerQQ}` : '');
  if (!key) return { ok: false, error: '没有可用的会话（未配置主人 QQ）' };
  const res = await fetch(`http://127.0.0.1:${port}/api/activity/wake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify({
      activityId: activity.id,
      label: activity.label,
      hint: activity.hint || '',
      key
    }),
    signal: AbortSignal.timeout(10000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, error: body?.error || `HTTP ${res.status}` };
  return { ok: true, key };
}

// ── 核心：挑一个活动 ──────────────────────────────────────────────────────

/**
 * 返回此刻值得提议的活动（可能为空）。
 * 判据全部是「限制」而不是「指令」：只决定**要不要开口**，不决定她做什么。
 */
export function pickDue(now = new Date(), conf = loadConf(), state = loadState()) {
  if (!conf.enabled) return [];
  if (!isInstalled('activity-time')) return [];
  if (inAny(conf.quiet, now)) return [];

  const nowMs = now.getTime();
  const gapMs = Math.max(0, Number(conf.minGapMin) || 0) * 60000;
  if (state.lastAnyAt && nowMs - state.lastAnyAt < gapMs) return [];

  return effectiveActivities(conf)
    .filter((a) => a.enabled)
    .filter((a) => inWindow(parseWindow(a.window), now))
    .filter((a) => {
      const times = Array.isArray(state.triggers?.[a.id]) ? state.triggers[a.id] : [];
      // 日限额按「提议次数」算，不是按「执行次数」。
      // 否则她每次都拒绝时会一天被问十几次，那不叫给人自由，那叫骚扰。
      if (times.length >= a.dailyLimit) return false;
      const last = times.length ? Math.max(...times) : 0;
      return !last || nowMs - last >= a.cooldownMin * 60000;
    });
}

// ── 主循环 ────────────────────────────────────────────────────────────────

let pending = null;   // { id, label, at }

async function tick() {
  const conf = loadConf();
  const state = loadState();
  // 她在别的进程里记过账了（qq_activity_done 写盘），这边的 pending 就该清掉，
  // 否则会一直等 15 分钟，期间不再提新的事。
  if (pending && state.lastHandled && Number(state.lastHandled.at) >= pending.at) pending = null;

  const due = pickDue(new Date(), conf, state);
  if (!due.length) return;

  // 上一次提议还没被回应（她没调 qq_activity_done），先不叠新的。
  if (pending && Date.now() - pending.at < 15 * 60000) return;
  pending = null;

  // 随机挑一个：让「今天做什么」不是每天同一个顺序，但同一天不会连环追问。
  const pick = due[Math.floor(Math.random() * due.length)];
  let r;
  try {
    r = await wakeBridge(pick);
  } catch (e) {
    // fetch 的 message 只有一句 "fetch failed"，真因在 cause 里（ECONNREFUSED / 超时）。
    log(`提议「${pick.label}」连不上桥接：${e?.cause?.code || e?.cause?.message || e?.message || e}`);
    return;
  }
  if (!r.ok) {
    // 409 = 环境没准备好（不在对话模式、或她正在睡）。这不是故障，
    // 每分钟记一条只会把日志刷满，静默跳过就好。
    if (r.status !== 409) log(`提议「${pick.label}」失败：${r.error}`);
    return;
  }

  state.triggers[pick.id] = [...(state.triggers[pick.id] || []), Date.now()];
  state.lastAnyAt = Date.now();
  writeJson(STATE_FILE, state);
  pending = { id: pick.id, label: pick.label, at: Date.now() };
  log(`提议「${pick.label}」→ ${r.key}（今天第 ${state.triggers[pick.id].length}/${pick.dailyLimit} 次）`);
}

/** qq_activity_done 写状态后置位，调度器据此清掉 pending。 */
export function markHandled(activityId) {
  if (pending && (!activityId || pending.id === activityId)) pending = null;
}

/**
 * 记账：这段空档做了什么（或决定不做）。
 * 由 MCP 工具跨进程调用 → 只能落盘，调度器下一轮 tick 读 lastHandled 来清 pending。
 */
export function recordHandled(activityId, action = 'done', note = '') {
  const state = loadState();
  state.lastHandled = {
    id: String(activityId || ''),
    action: action === 'skip' ? 'skip' : 'done',
    note: String(note || '').slice(0, 300),
    at: Date.now()
  };
  writeJson(STATE_FILE, state);
  markHandled(activityId);   // 同进程（理论上不会）也顺手清一下
  return state.lastHandled;
}

/** 改某个活动的时段/开关/限额。只写用户覆盖，不动默认值。 */
export function updateOverride(activityId, patch = {}) {
  const raw = readJson(CONF_FILE, {});
  if (!raw.overrides || typeof raw.overrides !== 'object') raw.overrides = {};
  raw.overrides[activityId] = { ...(raw.overrides[activityId] || {}), ...patch };
  writeJson(CONF_FILE, raw);
  return raw.overrides[activityId];
}

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const conf = loadConf();
  if (!fs.existsSync(CONF_FILE)) writeJson(CONF_FILE, DEFAULTS);

  const acts = effectiveActivities(conf);
  log(`启动：${acts.length} 个活动可调度（${acts.map((a) => a.id).join(', ') || '无'}），每 ${Math.round(conf.tickMs / 1000)}s 检查一次`);
  if (!isInstalled('activity-time')) {
    log('activity-time 未安装，调度器空转（不会触发任何活动）');
  }

  // 单实例：同一时刻只该有一个调度器，否则同一段空档会被提议两次。
  const lockFile = path.join(STATE_DIR, 'scheduler.pid');
  const old = Number(readJson(lockFile, 0));
  if (old && old !== process.pid) {
    try { process.kill(old, 0); log(`已有调度器在跑（pid ${old}），本次退出`); return; } catch {}
  }
  writeJson(lockFile, process.pid);

  const loop = async () => {
    try { await tick(); } catch (e) { log(`tick 异常：${e?.message ?? e}${e?.cause?.code ? `（${e.cause.code}）` : ''}`); }
    // 不能用 .unref()：这个定时器是进程唯一的「保持存活」来源，
    // unref 之后事件循环一空，进程就 exit 0 了 —— 表现是服务列表里
    // 「自主时间：未运行，exit 0」，看起来像正常退出，其实什么都没干。
    setTimeout(loop, Math.max(15000, Number(loadConf().tickMs) || 60000));
  };
  loop();

  // 收到退出信号时清 lock，避免下次启动误判「已有实例」
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try { fs.rmSync(lockFile, { force: true }); } catch {}
      process.exit(0);
    });
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => { log(`致命错误：${e?.stack ?? e}`); process.exit(1); });
}
