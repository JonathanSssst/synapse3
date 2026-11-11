// Synapse · 审计数据库收集器
// 把 qq-bridge 的 jsonl / log 增量写进 SQLite（<SYNAPSE_HOME>\audit\audit.db），
// 面板与以后的数据分析都从库里读，不再每次解析原始文件。
// 只读原始文件，不改动桥接数据；每 60 秒扫一次。
import { HOME as B, BRIDGE_ROOT } from '../../packages/paths/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const QB = 'E:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace\\qq-bridge';
const STATE = path.join(QB, 'state');
const AUDIT = `${B}\\audit`;
const DB_PATH = path.join(AUDIT, 'audit.db');
const LOCK = path.join(AUDIT, 'collector.lock');

fs.mkdirSync(AUDIT, { recursive: true });

// 单实例锁（防止两个收集器同时写库）
try {
  if (fs.existsSync(LOCK)) {
    const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
    if (pid && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })()) {
      console.log('[collector] 已有实例在运行，退出');
      process.exit(0);
    }
  }
  fs.writeFileSync(LOCK, String(process.pid));
} catch {}

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY, t INTEGER, kind TEXT, sid TEXT, conv_key TEXT, seq INTEGER,
    turn INTEGER, step INTEGER, model TEXT, provider TEXT,
    cache_miss INTEGER, cache_hit INTEGER, cache_write INTEGER, output INTEGER, reasoning INTEGER,
    raw TEXT, ingested_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_token_t ON token_usage(t);
  CREATE INDEX IF NOT EXISTS idx_token_conv ON token_usage(conv_key);
  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY, t TEXT, type TEXT, conv_key TEXT, session_id TEXT, tool TEXT,
    ok INTEGER, error TEXT, args TEXT, raw TEXT, ingested_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tool_tool ON tool_calls(tool);
  CREATE TABLE IF NOT EXISTS activity (
    id TEXT PRIMARY KEY, t TEXT, conv_key TEXT, text TEXT, raw TEXT, ingested_at TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY, t TEXT, source TEXT, action TEXT, conv_key TEXT, target TEXT,
    detail TEXT, ok INTEGER, raw TEXT, ingested_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_source ON audit_events(source);
  CREATE TABLE IF NOT EXISTS ingest_state (
    file TEXT PRIMARY KEY, offset INTEGER, size INTEGER, updated_at TEXT
  );
`);

const now = new Date().toISOString();
const getState = db.prepare('SELECT offset, size FROM ingest_state WHERE file = ?');
const setState = db.prepare(`INSERT INTO ingest_state(file, offset, size, updated_at) VALUES(?,?,?,?)
  ON CONFLICT(file) DO UPDATE SET offset=excluded.offset, size=excluded.size, updated_at=excluded.updated_at`);
const hashId = (s) => createHash('sha256').update(s).digest('hex');

const insToken = db.prepare(`INSERT OR IGNORE INTO token_usage
  (id,t,kind,sid,conv_key,seq,turn,step,model,provider,cache_miss,cache_hit,cache_write,output,reasoning,raw,ingested_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insTool = db.prepare(`INSERT OR IGNORE INTO tool_calls
  (id,t,type,conv_key,session_id,tool,ok,error,args,raw,ingested_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
const insAct = db.prepare(`INSERT OR IGNORE INTO activity (id,t,conv_key,text,raw,ingested_at) VALUES(?,?,?,?,?,?)`);
const insAudit = db.prepare(`INSERT OR IGNORE INTO audit_events
  (id,t,source,action,conv_key,target,detail,ok,raw,ingested_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);

function readFromOffset(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const st = getState.get(file);
  let offset = st ? Number(st.offset) || 0 : 0;
  if (offset > stat.size) offset = 0; // 文件被截断/轮转
  if (offset === stat.size) return { lines: [], offset };
  const fd = fs.openSync(file, 'r');
  try {
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    let text = buf.toString('utf8');
    // 只消费完整的行，避免半行造成 JSON 解析失败与重复
    const lastNl = text.lastIndexOf('\n');
    let consumed = offset;
    let lines = [];
    if (lastNl >= 0) {
      const complete = text.slice(0, lastNl + 1);
      consumed = offset + Buffer.byteLength(complete, 'utf8');
      lines = complete.split(/\r?\n/).filter(Boolean);
    }
    return { lines, offset: consumed };
  } finally {
    fs.closeSync(fd);
  }
}

function ingestJsonl(file, handler) {
  const res = readFromOffset(file);
  if (!res) return 0;
  let n = 0;
  for (const line of res.lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    try { handler(rec, line); n += 1; } catch {}
  }
  setState.run(file, res.offset, fs.statSync(file).size, now);
  return n;
}

function j(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// 1) token 用量
const nTokens = ingestJsonl(path.join(STATE, 'token-usage.jsonl'), (r, line) => {
  const b = r.b || {};
  insToken.run(
    hashId(`token:${line}`), Number(r.t) || null, r.k || '', r.sid || '', r.key || '',
    Number(r.seq) ?? null, Number(r.turn) ?? null, Number(r.step) ?? null,
    r.model || '', r.provider || '',
    Number(b.cacheMiss) || 0, Number(b.cacheHit) || 0, Number(b.cacheWrite) || 0, Number(b.output) || 0, Number(b.reasoning) || 0,
    line.slice(0, 4000), now
  );
});

// 2) 工具调用
const nTools = ingestJsonl(path.join(STATE, 'tool-calls.jsonl'), (r, line) => {
  insTool.run(
    hashId(`tool:${line}`), r.time || '', r.type || '', r.key || '', r.sessionId || '',
    r.tool || '', r.type === 'result' ? (r.ok === false ? 0 : 1) : null,
    r.error ? String(r.error).slice(0, 1000) : null, r.args ? String(r.args).slice(0, 2000) : null,
    line.slice(0, 4000), now
  );
});

// 3) 活动日志（纯文本行）
function ingestLines(file, handler) {
  const res = readFromOffset(file);
  if (!res) return 0;
  for (const line of res.lines) { try { handler(line); } catch {} }
  setState.run(file, res.offset, fs.statSync(file).size, now);
  return res.lines.length;
}
const nActivity = ingestLines(path.join(STATE, 'qq-activity.log'), (line) => {
  const m = /^\[([^\]]+)\]\s+(\S+)\s+(.*)$/.exec(line);
  insAct.run(hashId(`act:${line}`), m ? m[1] : '', m ? m[2] : '', m ? m[3] : line, line, now);
});

// 4) 审计事件（chat / qzone）
function ingestAudit(file, source) {
  const res = readFromOffset(file);
  if (!res) return 0;
  for (const line of res.lines) {
    let t = '';
    let detail = null;
    try {
      const m = /^(\S+)\s+(\{.*\})$/.exec(line);
      if (m) { t = m[1]; detail = JSON.parse(m[2]); } else detail = { text: line };
    } catch { detail = { text: line }; }
    const d = detail || {};
    insAudit.run(
      hashId(`audit:${source}:${line}`), t, source, d.action || '', d.key || '', d.messageId || d.tid || d.stickerId || '',
      j(detail), d.ok === false ? 0 : (d.ok === true ? 1 : null), line.slice(0, 4000), now
    );
  }
  setState.run(file, res.offset, fs.statSync(file).size, now);
  return res.lines.length;
}
const nChat = ingestAudit(path.join(STATE, 'chat-audit.log'), 'chat');
const nQzone = ingestAudit(path.join(STATE, 'qzone-audit.log'), 'qzone');

const counts = {
  token_usage: db.prepare('SELECT COUNT(*) AS c FROM token_usage').get().c,
  tool_calls: db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get().c,
  activity: db.prepare('SELECT COUNT(*) AS c FROM activity').get().c,
  audit_events: db.prepare('SELECT COUNT(*) AS c FROM audit_events').get().c
};
const added = { tokens: nTokens, tools: nTools, activity: nActivity, chat: nChat, qzone: nQzone };
console.log(new Date().toISOString(), 'ingest', JSON.stringify(added), 'rows', JSON.stringify(counts));

db.close();

// 常驻模式：每 60 秒增量扫一遍（守护任务用 --loop 启动）
if (process.argv.includes('--loop')) {
  const runOnce = async () => {
    await new Promise((r) => setTimeout(r, 60000));
    try {
      const { spawnSync } = await import('node:child_process');
      spawnSync(process.execPath, [process.argv[1]], { stdio: 'inherit' });
    } catch {}
    runOnce();
  };
  runOnce();
} else {
  process.exit(0);
}
