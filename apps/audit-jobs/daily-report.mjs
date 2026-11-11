// Synapse · 每日 report：从审计数据库汇总当天用量/花费/工具/审计，写 Markdown，
// 可选推送到主人的 QQ（--push，走桥接 /api/system-notify，只发主人私聊）。
import { HOME as B, BRIDGE_ROOT } from '../../packages/paths/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { priceUsage, resolvePriceTable } from `${BRIDGE_ROOT}/src/model-prices.js`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.resolve(__dirname);
const BOT = path.dirname(AUDIT);
const DB_PATH = path.join(AUDIT, 'audit.db');
const QB = 'E:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace\\qq-bridge';
const OUT_DIR = path.join(BOT, '日报');

const PUSH = process.argv.includes('--push');
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const keyOf = (ms) => new Date(Number(ms)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
// 库里的 t/at 是 UTC ISO（或 epoch）；一律按北京时间判断“今天”。
const localDay = (v) => {
  if (v == null || v === '') return '';
  let d;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
    const n = Number(v);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
};

let db;
try { db = new DatabaseSync(DB_PATH, { readOnly: true }); } catch (error) {
  console.error('[daily] 打不开数据库：', error?.message ?? error);
  process.exit(1);
}

const priceTable = resolvePriceTable(JSON.parse(fs.readFileSync(path.join(QB, 'config.json'), 'utf8')).pricing ?? null);
const PROJECT = (() => { try { return JSON.parse(fs.readFileSync(path.join(BOT, 'VERSION.json'), 'utf8')); } catch { return { name: 'Synapse 3', version: '3.1.5' }; } })();

// 1) 当天 token / 花费
const tokenRows = db.prepare("SELECT t, conv_key, turn, step, model, cache_miss, cache_hit, cache_write, output, reasoning FROM token_usage WHERE kind = 'turn' ORDER BY rowid").all();
const dayRows = tokenRows.filter((r) => keyOf(r.t) === today);
let stats = { steps: 0, turns: 0, cacheMiss: 0, cacheHit: 0, output: 0, cost: 0 };
const convMap = new Map();
for (const r of dayRows) {
  stats.steps += 1;
  if (Number(r.step) === 0 || Number(r.step) === 1) stats.turns += 1;
  stats.cacheMiss += Number(r.cache_miss) || 0;
  stats.cacheHit += Number(r.cache_hit) || 0;
  stats.output += Number(r.output) || 0;
  let cost = 0;
  try {
    cost = priceUsage({ cacheMiss: r.cache_miss, cacheHit: r.cache_hit, cacheWrite: r.cache_write, output: r.output }, { model: r.model, at: r.t, table: priceTable }).cost.total;
  } catch {}
  stats.cost += cost;
  const k = r.conv_key || '(未知)';
  const c = convMap.get(k) || { steps: 0, tokens: 0, cost: 0 };
  c.steps += 1;
  c.tokens += (Number(r.cache_miss) || 0) + (Number(r.cache_hit) || 0) + (Number(r.output) || 0);
  c.cost += cost;
  convMap.set(k, c);
}

// 2) 工具调用
const toolRows = db.prepare("SELECT t, tool, ok, error FROM tool_calls WHERE type = 'result' ORDER BY rowid").all().filter((r) => localDay(r.t) === today);
const toolMap = new Map();
let errors = 0;
for (const r of toolRows) {
  const name = String(r.tool || '').replace('mcp__snowluma__', '');
  const t = toolMap.get(name) || { calls: 0, errors: 0 };
  t.calls += 1;
  if (r.ok === 0) { t.errors += 1; errors += 1; }
  toolMap.set(name, t);
}

// 3) 审计 / 活动
const audits = db.prepare('SELECT t, source, action, ok FROM audit_events ORDER BY rowid').all().filter((r) => localDay(r.t) === today);
const activityCount = db.prepare('SELECT COUNT(*) AS c FROM activity').get().c;
// 3.5) B 站足迹
let biliRows = [];
try {
  biliRows = db.prepare('SELECT t, action, bvid, title, up, ok FROM bili_events ORDER BY rowid').all().filter((r) => localDay(r.t) === today);
} catch { biliRows = []; }
const biliByAction = new Map();
for (const r of biliRows) biliByAction.set(r.action, (biliByAction.get(r.action) || 0) + 1);
const social = (() => { try { return JSON.parse(fs.readFileSync(path.join(QB, 'state', 'social-v2.json'), 'utf8')); } catch { return {}; } })();
const convKeys = Object.keys(social.conversations || {});

const lines = [];
lines.push(`# Synapse 日报 · ${PROJECT.name} v${PROJECT.version} · ${today}`);
lines.push('');
lines.push(`- 消耗：**${stats.steps}** 步 / ${stats.turns} 轮，输入命中 ${stats.cacheHit.toLocaleString('zh-CN')} token、未命中 ${stats.cacheMiss.toLocaleString('zh-CN')}、输出 ${stats.output.toLocaleString('zh-CN')}`);
lines.push(`- 估算花费：**¥${stats.cost.toFixed(3)}**（按官方峰谷价折算）`);
lines.push(`- 工具调用：${toolRows.length} 次，错误 ${errors} 次`);
lines.push(`- 审计事件：${audits.length} 条（说说/发图/撤回/表情库）`);
lines.push(`- B 站足迹：${biliRows.length} 条${biliRows.length ? `（${[...biliByAction.entries()].map(([a, n]) => `${a}×${n}`).join('、')}）` : ''}`);
lines.push('');
lines.push('## 按会话');
lines.push('| 会话 | 步数 | token | 花费 |');
lines.push('| --- | --- | --- | --- |');
for (const [k, v] of [...convMap.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
  lines.push(`| ${k} | ${v.steps} | ${v.tokens.toLocaleString('zh-CN')} | ¥${v.cost.toFixed(3)} |`);
}
if (!convMap.size) lines.push('| （今天还没有用量） | - | - | - |');
lines.push('');
lines.push('## 工具排行');
for (const [name, v] of [...toolMap.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 12)) {
  lines.push(`- ${name}：${v.calls} 次${v.errors ? `（错 ${v.errors}）` : ''}`);
}
if (!toolMap.size) lines.push('- （今天还没有工具调用）');
lines.push('');
lines.push('## B 站足迹');
if (biliRows.length) {
  for (const r of biliRows.slice(-12)) {
    lines.push(`- ${r.action} ${r.bvid ? `· ${r.bvid}` : ''} ${String(r.title || '').slice(0, 40)}${r.ok === 0 ? '（失败）' : ''}`);
  }
} else {
  lines.push('- （今天还没刷 B 站）');
}
lines.push('');
// 3.6) QQ 空间
let qzoneRows = [];
try {
  qzoneRows = fs.readFileSync(path.join(BOT, 'qzone', 'logs', 'qzone-events.log'), 'utf8')
    .split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && localDay(e.at) === today);
} catch {}
const qzPosts = qzoneRows.filter((e) => e.type === 'post_ok').length;
const qzReplies = qzoneRows.filter((e) => e.type === 'reply_ok').length;
const qzRisks = qzoneRows.filter((e) => e.type === 'risk_pause').length;
lines.push('## QQ 空间');
lines.push(`- 发说说 ${qzPosts} 条 · 回复评论 ${qzReplies} 条${qzRisks ? ` · 风控暂停 ${qzRisks} 次` : ''}`);
for (const e of qzoneRows.filter((x) => x.type === 'post_ok').slice(-3)) {
  lines.push(`- ${String(e.content || '').slice(0, 60)}`);
}
if (!qzoneRows.length) lines.push('- （今天空间没动静）');
lines.push('');
// 群聊 / 私聊消息统计（桥接写入 state/message-stats/<day>.json）
let msgStats = null;
try { msgStats = JSON.parse(fs.readFileSync(path.join(QB, 'state', 'message-stats', `${today}.json`), 'utf8')); } catch {}
const msgConvs = Object.entries(msgStats?.conversations || {}).sort((a, b) => (Number(b[1].sent) + Number(b[1].received)) - (Number(a[1].sent) + Number(a[1].received)));
const totalRecv = msgConvs.reduce((n, [, c]) => n + (Number(c.received) || 0), 0);
const totalSent = msgConvs.reduce((n, [, c]) => n + (Number(c.sent) || 0), 0);
lines.push('## 消息统计');
lines.push(`- 收到 **${totalRecv}** 条 · 发出 **${totalSent}** 条`);
if (msgConvs.length) {
  lines.push('| 会话 | 类型 | 收到 | 发出 | 群友数 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const [key, c] of msgConvs) {
    const members = Object.keys(c.members || {}).length;
    lines.push(`| ${key} | ${c.kind === 'group' ? '群' : '私聊'} | ${Number(c.received) || 0} | ${Number(c.sent) || 0} | ${members} |`);
  }
  const groupDetails = msgConvs.filter(([, c]) => c.kind === 'group' && Object.keys(c.members || {}).length);
  if (groupDetails.length) {
    lines.push('');
    lines.push('**群聊活跃成员（今日发言数）**');
    for (const [key, c] of groupDetails) {
      const top = Object.entries(c.members || {}).sort((a, b) => b[1].count - a[1].count).slice(0, 8);
      lines.push(`- ${key}：${top.map(([, m]) => `${m.name}×${m.count}`).join('、')}`);
    }
  }
} else {
  lines.push('- （今天还没有消息统计；桥接升级后开始累计）');
}
lines.push('');
lines.push(`## 活跃会话`);
lines.push(`- ${convKeys.join('、') || '（无）'}`);
lines.push('');
lines.push(`> 生成时间：${new Date().toISOString()} · 数据库行数 ${activityCount} 条活动`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `${today}.md`);
fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
console.log(`[daily] 已写入 ${file}`);

if (PUSH) {
  try {
    const token = fs.readFileSync(path.join(QB, 'state', 'console-token'), 'utf8').trim();
    const summary = [
      `【Synapse 日报】${today}`,
      `项目：${PROJECT.name} v${PROJECT.version}`,
      `用量：${stats.steps} 步 / ${stats.turns} 轮`,
      `花费：¥${stats.cost.toFixed(3)}（输入命中 ${stats.cacheHit.toLocaleString('zh-CN')} / 未命中 ${stats.cacheMiss.toLocaleString('zh-CN')} / 输出 ${stats.output.toLocaleString('zh-CN')}）`,
      `工具：${toolRows.length} 次，错误 ${errors} 次`,
      `B站：${biliRows.length} 条足迹`,
      `消息：收 ${totalRecv} / 发 ${totalSent}`,
      `最常用：${[...toolMap.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 3).map(([n, v]) => `${n}×${v.calls}`).join('、') || '无'}`
    ].join('\n');
    const res = await fetch('http://127.0.0.1:3100/api/system-notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({ text: summary }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    console.log('[daily] 推送', res.ok && body?.ok ? '成功' : `失败：${body?.error || res.status}`);
  } catch (error) {
    console.error('[daily] 推送失败：', error?.message ?? error);
  }
}

db.close();
