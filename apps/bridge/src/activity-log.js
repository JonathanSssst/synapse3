// 共享活动记忆：桌宠陪看看到的东西，写成很短的一行，供 QQ 私聊唤醒时回忆。
//
// 只存「时间 + 前台窗口 + 她当时说的一句」，不存截图，也不进 DSH 会话上下文。
// 这样陪看可以继续用独立会话，聊天时又能自然接上“你刚才在干嘛”。
import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 400;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function fmtTime(ts) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(ts));
  } catch {
    return '';
  }
}

function oneLine(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function createActivityLog(file) {
  let cache = null;
  let cacheStamp = 0;

  function readAll() {
    try {
      const st = fs.statSync(file);
      if (cache && st.mtimeMs === cacheStamp) return cache;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
      const out = [];
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item && Number.isFinite(Number(item.ts))) out.push(item);
        } catch {}
      }
      cache = out;
      cacheStamp = st.mtimeMs;
      return out;
    } catch {
      cache = [];
      cacheStamp = 0;
      return cache;
    }
  }

  function prune() {
    const now = Date.now();
    const kept = readAll()
      .filter((item) => now - Number(item.ts) <= MAX_AGE_MS)
      .slice(-MAX_ENTRIES);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, kept.map((item) => JSON.stringify(item)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
      fs.renameSync(tmp, file);
      cache = kept;
      cacheStamp = fs.statSync(file).mtimeMs;
    } catch {}
  }

  function append({ role, title, text, looked }) {
    const item = {
      ts: Date.now(),
      t: new Date().toISOString(),
      role: oneLine(role, 60),
      title: oneLine(title, 60),
      text: oneLine(text, 80),
      looked: looked === true
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(item) + '\n', 'utf8');
      cache = null;
      cacheStamp = 0;
      if (readAll().length > MAX_ENTRIES) prune();
    } catch {}
    return item;
  }

  function recent({ role, limit = 3, withinMs = 6 * 60 * 60 * 1000 } = {}) {
    const now = Date.now();
    const want = String(role || '').trim();
    return readAll()
      .filter((item) => now - Number(item.ts) <= withinMs)
      .filter((item) => !want || !item.role || item.role === want)
      .slice(-Math.max(1, limit));
  }

  function format({ role, limit = 3 } = {}) {
    const items = recent({ role, limit });
    if (!items.length) return '';
    const lines = items.map((item) => {
      const time = fmtTime(item.ts);
      const where = item.title ? `主人在「${item.title}」` : '主人在电脑前';
      const said = item.text ? `，我当时说：${item.text}` : '';
      return `- ${time ? time + ' ' : ''}${where}${said}`;
    });
    return `【你刚才在桌宠里看到的】\n${lines.join('\n')}\n\n`;
  }

  return { file, append, recent, format, prune };
}
