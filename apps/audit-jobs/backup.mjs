// Synapse 3 · 每日自动备份：配置/状态/记忆/审计库 → <SYNAPSE_HOME>\backup\YYYY-MM-DD\，保留 7 天。
import { HOME as B, BRIDGE_ROOT } from '../../packages/paths/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BOT = `${B}`;
const BACKUP_ROOT = path.join(BOT, 'backup');
const LOG_FILE = path.join(BOT, 'audit', 'backup.log');
const QQB = 'E:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace\\qq-bridge';
const DSH_SESSIONS = 'C:\\Users\\Administrator\\.dsh\\sessions';
const KEEP_DAYS = 7;

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(LOG_FILE, s, 'utf8'); } catch {}
  console.log(s.trim());
}
const dayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function copyInto(src, dst) {
  try {
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch (error) { log(`复制失败 ${src}: ${error?.message ?? error}`); return false; }
}

const FILES = [
  ['VERSION.json', 'VERSION.json'],
  ['CHANGELOG.md', 'CHANGELOG.md'],
  ['记忆库.md', '记忆库.md'],
  ['长记忆.md', '长记忆.md'],
  ['下一步计划.md', '下一步计划.md'],
  [path.join(QQB, 'config.json'), 'qq-bridge/config.json'],
  [path.join(QQB, 'state', 'social-v2.json'), 'qq-bridge/state/social-v2.json'],
  [path.join(QQB, 'state', 'stickers.json'), 'qq-bridge/state/stickers.json'],
  [path.join(QQB, 'state', 'slang.json'), 'qq-bridge/state/slang.json'],
  ['imagegen/config.json', 'imagegen/config.json'],
  ['qzone/config.json', 'qzone/config.json'],
  ['qzone/state.json', 'qzone/state.json'],
  ['qzone/logs/qzone-events.log', 'qzone/qzone-events.log']
];

function copyDirInto(src, dst) {
  try {
    if (!fs.existsSync(src)) return false;
    fs.cpSync(src, dst, { recursive: true, force: true });
    return true;
  } catch (error) { log(`目录复制失败 ${src}: ${error?.message ?? error}`); return false; }
}

function backupDb(dst) {
  try {
    const db = new DatabaseSync(path.join(BOT, 'audit', 'audit.db'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
    db.exec(`VACUUM INTO '${dst.replace(/\\/g, '/').replace(/'/g, "''")}'`);
    db.close();
    return true;
  } catch (error) { log(`audit.db 备份失败：${error?.message ?? error}`); return false; }
}

function rotate() {
  try {
    const dirs = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)).map((d) => d.name).sort();
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000);
    const cutoffKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(cutoff);
    for (const name of dirs) {
      if (name < cutoffKey) {
        fs.rmSync(path.join(BACKUP_ROOT, name), { recursive: true, force: true });
        log(`轮转删除旧备份 ${name}`);
      }
    }
  } catch (error) { log(`备份轮转失败：${error?.message ?? error}`); }
}

function main() {
  const day = dayKey();
  const dir = path.join(BACKUP_ROOT, day);
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const missing = [];
  // 注意：FILES 里的 src 有两种形式——相对 BOT 的路径（如 'VERSION.json'）与
  // qq-bridge 的绝对路径。path.join(BOT, 绝对路径) 不会重置，会拼成
  // 注意：源路径可能本身就是绝对路径，直接拼接会产生不存在的路径，导致静默失败。此处必须先判断。
  for (const [src, rel] of FILES) {
    const abs = path.isAbsolute(src) ? src : path.join(BOT, src);
    if (copyInto(abs, path.join(dir, rel))) n += 1; else missing.push(rel);
  }
  if (backupDb(path.join(dir, 'audit.db'))) n += 1; else missing.push('audit.db');
  // DSH 会话（便于会话损坏时恢复历史；体积较大，随 7 天轮转清理）
  if (copyDirInto(DSH_SESSIONS, path.join(dir, 'dsh-sessions'))) n += 1; else missing.push('dsh-sessions');
  const expected = FILES.length + 2;
  const ok = missing.length === 0;
  if (!ok) log(`备份不完整：期望 ${expected} 项，成功 ${n} 项，缺失：${missing.join(', ')}`);
  fs.writeFileSync(path.join(dir, 'README.txt'), `Synapse 3 自动备份 ${day}\n文件数：${n} / 期望 ${expected}\n状态：${ok ? '完整' : '不完整，缺失：' + missing.join(', ')}\n恢复：运行 E:\\BOT\\backup\\restore.ps1 或用对应文件覆盖回去。\n`, 'utf8');
  rotate();
  log(`备份完成：${dir}（${n}/${expected} 个文件）${ok ? '' : '  ⚠ 不完整'}`);
  if (!ok) process.exitCode = 1;
}
main();
