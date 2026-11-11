// Synapse 3 面板后端 · 消息统计（读取桥接写入的 state/message-stats/<day>.json）
import fs from 'node:fs';
import path from 'node:path';
import { QB_STATE, BOT } from './core.mjs';

const DIR = path.join(QB_STATE, 'message-stats');
const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }

export function listMessageStatDays() {
  try {
    return fs.readdirSync(DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .filter((d) => RE_DAY.test(d))
      .sort()
      .reverse()
      .slice(0, 60);
  } catch { return []; }
}

export function getMessageStats(dayRaw) {
  let day = String(dayRaw || '').trim();
  if (!RE_DAY.test(day)) day = todayKey();
  const data = readJson(path.join(DIR, day + '.json'), { day, conversations: {} });
  const conversations = Object.entries(data.conversations || {}).map(([key, c]) => {
    const members = Object.entries(c.members || {}).map(([id, m]) => ({ id, name: m.name || id, count: Number(m.count) || 0 }))
      .filter((m) => m.count > 0)
      .sort((a, b) => b.count - a.count);
    return {
      key,
      kind: c.kind || (key.startsWith('group:') ? 'group' : 'private'),
      received: Number(c.received) || 0,
      sent: Number(c.sent) || 0,
      selfSent: Number(c.selfSent) || 0,
      members,
      memberCount: members.length,
      total: (Number(c.received) || 0) + (Number(c.sent) || 0)
    };
  }).sort((a, b) => b.total - a.total);
  const totals = conversations.reduce((acc, c) => {
    acc.received += c.received; acc.sent += c.sent; acc.total += c.total;
    return acc;
  }, { received: 0, sent: 0, total: 0 });
  return { ok: true, day, days: listMessageStatDays(), conversations, totals, note: '收到=别人发的；发出=她发的；群聊成员列表只统计别人，自己单独计在发出' };
}
