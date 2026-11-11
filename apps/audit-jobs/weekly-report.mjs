// Synapse 3 · 生活周报：汇总本周（近 7 天）花费/浏览/说说/记忆，写 Markdown 并推送到主人 QQ。
import { HOME as B, BRIDGE_ROOT } from '../../packages/paths/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { priceUsage, resolvePriceTable } from `${BRIDGE_ROOT}/src/model-prices.js`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT = path.dirname(__dirname);
const QQB = 'E:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace\\qq-bridge';
const OUT_DIR = path.join(BOT, '周报');
const DB_PATH = path.join(BOT, 'audit', 'audit.db');
const PUSH = process.argv.includes('--push');

const TZ = 'Asia/Shanghai';
const dayKey = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: TZ });
const localDay = (v) => {
  if (v == null || v === '') return '';
  let d;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) { const n = Number(v); d = new Date(n < 1e12 ? n * 1000 : n); } else d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  return dayKey(d);
};
const now = new Date();
const from = new Date(now.getTime() - 6 * 86400000);
const days = new Set();
for (let i = 0; i < 7; i += 1) days.add(dayKey(new Date(from.getTime() + i * 86400000)));
const inRange = (v) => days.has(localDay(v));

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const priceTable = resolvePriceTable(null);

// 用量
const rows = db.prepare("SELECT t, kind, model, cache_miss, cache_hit, cache_write, output, reasoning FROM token_usage WHERE kind = 'turn'").all().filter((r) => inRange(r.t));
let cost = 0, steps = rows.length;
for (const r of rows) {
  try { cost += priceUsage({ cacheMiss: r.cache_miss, cacheHit: r.cache_hit, cacheWrite: r.cache_write, output: r.output, reasoning: r.reasoning }, { model: r.model, at: Number(r.t) || Date.now(), table: priceTable }).cost.total; } catch {}
}
const monthKey = dayKey(now).slice(0, 7);
const monthRows = db.prepare("SELECT t, kind, model, cache_miss, cache_hit, cache_write, output, reasoning FROM token_usage WHERE kind = 'turn'").all().filter((r) => localDay(r.t).startsWith(monthKey));
let monthCost = 0;
for (const r of monthRows) { try { monthCost += priceUsage({ cacheMiss: r.cache_miss, cacheHit: r.cache_hit, cacheWrite: r.cache_write, output: r.output, reasoning: r.reasoning }, { model: r.model, at: Number(r.t) || Date.now(), table: priceTable }).cost.total; } catch {} }

// B 站记忆 + 足迹
const notes = db.prepare('SELECT t, bvid, title, up, note FROM bili_notes ORDER BY rowid').all().filter((r) => inRange(r.t));
const biliEvents = db.prepare("SELECT t, action FROM bili_events ORDER BY rowid").all().filter((r) => inRange(r.t));
const biliCount = {}; for (const e of biliEvents) biliCount[e.action] = (biliCount[e.action] || 0) + 1;
// 抖音
const dyEvents = db.prepare("SELECT t, action FROM douyin_events ORDER BY rowid").all().filter((r) => inRange(r.t));
// 空间
let qzEvents = [];
try {
  qzEvents = fs.readFileSync(path.join(BOT, 'qzone', 'logs', 'qzone-events.log'), 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && inRange(e.at));
} catch {}
const qzPosts = qzEvents.filter((e) => e.type === 'post_ok');
const qzReplies = qzEvents.filter((e) => e.type === 'reply_ok');
const toolErrors = db.prepare("SELECT COUNT(*) AS c FROM tool_calls WHERE ok = 0").get().c;

const lines = [];
lines.push(`# 默认人设生活周报 · ${dayKey(from)} ~ ${dayKey(now)}`);
lines.push('');
lines.push('## 本周花费');
lines.push(`- 本周 **¥${cost.toFixed(2)}**（${steps} 步）· 本月累计 **¥${monthCost.toFixed(2)}**`);
lines.push(`- 工具错误累计 ${toolErrors} 次`);
lines.push('');
lines.push('## 看过的视频（她写的感受）');
if (notes.length) {
  for (const n of notes.slice(-12)) {
    lines.push(`- ${String(n.title || n.bvid).slice(0, 60)}${n.up ? `（${n.up}）` : ''}`);
    lines.push(`  > ${String(n.note || '').replace(/\s+/g, ' ').slice(0, 120)}`);
  }
} else lines.push('- 这周还没写 B 站记忆');
lines.push('');
lines.push('## B 站足迹');
lines.push(`- ${Object.entries(biliCount).map(([k, v]) => `${k}×${v}`).join('、') || '（无）'}`);
lines.push('');
lines.push('## 抖音足迹');
lines.push(`- ${dyEvents.length} 次${dyEvents.length ? `（${[...new Set(dyEvents.map((e) => e.action))].join('/')}）` : ''}`);
lines.push('');
lines.push('## QQ 空间');
lines.push(`- 发说说 ${qzPosts.length} 条 · 回复评论 ${qzReplies.length} 条`);
for (const p of qzPosts.slice(-3)) lines.push(`  > ${String(p.content || '').slice(0, 80)}`);
lines.push('');
lines.push(`> 生成：${new Date().toISOString()} · Synapse 3`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `${dayKey(now)}.md`);
fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
console.log(`[weekly] 已写入 ${file}`);

if (PUSH) {
  try {
    const token = fs.readFileSync(path.join(QQB, 'state', 'console-token'), 'utf8').trim();
    const summary = [
      `【默认人设生活周报】${dayKey(from)} ~ ${dayKey(now)}`,
      `本周花费 ¥${cost.toFixed(2)}（本月 ¥${monthCost.toFixed(2)}）`,
      `看过的视频：${notes.length} 条记忆`,
      `B 站 ${biliEvents.length} 次 · 抖音 ${dyEvents.length} 次 · 说说 ${qzPosts.length} 条`,
      '详情我整理在电脑里了，想看全文跟我说。'
    ].join('\n');
    await fetch('http://127.0.0.1:3100/api/system-notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({ text: summary })
    });
    console.log('[weekly] 已推送到主人 QQ');
  } catch (error) { console.error('[weekly] 推送失败', error?.message ?? error); }
}
