// 遗忘曲线记忆 · 存储层（每名人设一个 JSON，原子写 + 每日备份 + 审计流水）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const MEMORY_DIR = path.join(STATE_DIR, 'memory');
const BACKUP_DIR = path.join(MEMORY_DIR, 'backup');

export function sanitizeRole(role) {
  return String(role || 'default').replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_').slice(0, 80) || 'default';
}

export function memoryFilePath(role) {
  return path.join(MEMORY_DIR, sanitizeRole(role) + '.json');
}
export function memoryAuditPath(role) {
  return path.join(MEMORY_DIR, sanitizeRole(role) + '.jsonl');
}

function todayCN() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function loadStore(role) {
  const file = memoryFilePath(role);
  const empty = { version: 1, role: sanitizeRole(role), entries: [], updatedAt: new Date().toISOString() };
  if (!fs.existsSync(file)) return empty;
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.entries)) throw new Error('记忆文件格式不对：' + file);
  return data;
}

export function loadStoreSafe(role) {
  try {
    return { ok: true, store: loadStore(role) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), store: null };
  }
}

export function saveStore(role, store) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const file = memoryFilePath(role);
  try {
    if (fs.existsSync(file)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const bak = path.join(BACKUP_DIR, sanitizeRole(role) + '-' + todayCN() + '.json');
      if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    }
  } catch {}
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ ...store, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function appendAudit(role, event) {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
    fs.appendFileSync(memoryAuditPath(role), line, 'utf8');
    const file = memoryAuditPath(role);
    if (fs.statSync(file).size > 5 * 1024 * 1024) {
      fs.renameSync(file, file + '.' + Date.now());
    }
  } catch {}
}

export function personaRoles() {
  try {
    const dir = path.join(ROOT, 'personas');
    return fs.readdirSync(dir).filter((name) => {
      try { return fs.existsSync(path.join(dir, name, 'persona.md')); } catch { return false; }
    });
  } catch { return []; }
}

export function listMemoryRoles() {
  const roles = new Set(personaRoles());
  try {
    for (const f of fs.readdirSync(MEMORY_DIR)) {
      if (f.endsWith('.json')) roles.add(f.slice(0, -5));
    }
  } catch {}
  return [...roles];
}

export function computeStats(entries) {
  const stats = { total: 0, active: 0, forgotten: 0, pinned: 0, shared: 0 };
  for (const e of entries || []) {
    if (e.deleted) continue;
    stats.total += 1;
    if (e.forgotten) stats.forgotten += 1;
    else stats.active += 1;
    if (e.pin) stats.pinned += 1;
    if (e.scope?.visibility === 'shared') stats.shared += 1;
  }
  return stats;
}
