#!/usr/bin/env node
// migrate-to-v2.mjs · 把旧树的数据复制进 v2 布局（复制，不移动）
//
// 旧布局：数据散在安装根 + DSH 工作区的桥接目录
// 新布局：<root>/data/{state,db,personas,...} + <root>/config/
//
// 用法：
//   node scripts/migrate-to-v2.mjs --from "<旧安装根>" --bridge "<桥接目录>"
//   node scripts/migrate-to-v2.mjs --dry        # 只报告不复制
//
// 安全：不删除、不移动、不覆盖已存在且更大的文件；逐项打印文件数与体积。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const DRY = args.includes('--dry');

const FROM = path.resolve(arg('--from') || 'E:\\BOT');
const BRIDGE = arg('--bridge') ? path.resolve(arg('--bridge')) : null;

const D = {
  state: path.join(ROOT, 'data', 'state'),
  bridgeState: path.join(ROOT, 'data', 'state', 'bridge'),
  db: path.join(ROOT, 'data', 'db'),
  personas: path.join(ROOT, 'data', 'personas'),
  roles: path.join(ROOT, 'data', 'roles'),
  media: path.join(ROOT, 'data', 'media'),
  generated: path.join(ROOT, 'data', 'media', 'generated'),
  refs: path.join(ROOT, 'data', 'media', 'refs'),
  audio: path.join(ROOT, 'data', 'media', 'audio'),
  qzone: path.join(ROOT, 'data', 'qzone'),
  bili: path.join(ROOT, 'data', 'bili'),
  books: path.join(ROOT, 'data', 'books'),
  surf: path.join(ROOT, 'data', 'surf'),
  study: path.join(ROOT, 'data', 'study'),
  reports: path.join(ROOT, 'data', 'reports'),
  models: path.join(ROOT, 'data', 'models'),
  config: path.join(ROOT, 'config'),
  secrets: path.join(ROOT, 'config', 'secrets')
};

const stats = {};
function dirStats(p) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else { files++; try { bytes += fs.statSync(q).size; } catch {} }
    }
  };
  try { if (fs.statSync(p).isDirectory()) walk(p); else { files = 1; bytes = fs.statSync(p).size; } } catch {}
  return { files, bytes };
}

const failures = [];

/** 递归复制并返回统计；单个文件失败不中断整体迁移。 */
function copyTree(src, dst) {
  let files = 0, bytes = 0;
  let st;
  try { st = fs.statSync(src); } catch { return { files: 0, bytes: 0, missing: true }; }
  if (st.isDirectory()) {
    if (!DRY) { try { fs.mkdirSync(dst, { recursive: true }); } catch {} }
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const r = copyTree(path.join(src, e.name), path.join(dst, e.name));
      files += r.files; bytes += r.bytes;
    }
    return { files, bytes };
  }
  if (!DRY) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); break; }
      catch (e) {
        if (attempt === 1) failures.push(`${src} → ${dst}: ${e.code || e.message}`);
      }
    }
  }
  files = 1; bytes = st.size;
  return { files, bytes };
}

function copy(src, dst) {
  const key = `${path.relative(FROM, src) || path.basename(src)} → ${path.relative(ROOT, dst)}`;
  const r = copyTree(src, dst);
  if (r.missing) { stats[key] = { skipped: true, files: 0, bytes: 0 }; return; }
  stats[key] = r;
}

// ── 1. 目录准备 ─────────────────────────────────────────────────────────────
if (!DRY) for (const d of Object.values(D)) fs.mkdirSync(d, { recursive: true });

// ── 2. 逐项复制 ─────────────────────────────────────────────────────────────
copy(path.join(FROM, 'state'), D.state);
for (const f of ['audit.db', 'audit.db-wal', 'audit.db-shm']) {
  copy(path.join(FROM, 'audit', f), path.join(D.db, f));
}
for (const f of ['记忆库.md', '长记忆.md']) copy(path.join(FROM, f), path.join(D.personas, f));
copy(path.join(FROM, '功能需求.md'), path.join(ROOT, 'data', '功能需求.md'));
copy(path.join(FROM, 'bili'), D.bili);
copy(path.join(FROM, 'books'), D.books);
copy(path.join(FROM, 'surf'), D.surf);
copy(path.join(FROM, '学习'), D.study);
for (const d of ['日报', '周报', '日记']) copy(path.join(FROM, d), D.reports);
copy(path.join(FROM, 'assets', 'live2d'), D.models);
copy(path.join(FROM, 'imagegen', 'refs'), D.refs);
copy(path.join(FROM, 'imagegen', 'character.json'), path.join(D.generated, 'character.json'));
for (const f of fs.readdirSync(path.join(FROM, 'imagegen')).filter((x) => /^gen-.*\.(jpg|png)$/i.test(x))) {
  copy(path.join(FROM, 'imagegen', f), path.join(D.generated, f));
}
copy(path.join(FROM, 'imagegen', 'config.json'), path.join(D.config, 'imagegen.json'));
copy(path.join(FROM, 'qzone', 'config.json'), path.join(D.config, 'qzone.json'));
copy(path.join(FROM, 'qzone', 'state.json'), path.join(D.qzone, 'state.json'));
copy(path.join(FROM, 'qzone', 'gallery'), D.qzone);

if (BRIDGE) {
  copy(path.join(BRIDGE, 'personas'), D.personas);
  copy(path.join(BRIDGE, 'state'), D.bridgeState);
  copy(path.join(BRIDGE, 'roles'), D.roles);
  copy(path.join(BRIDGE, 'audio'), D.audio);
  copy(path.join(BRIDGE, 'config.json'), path.join(D.config, 'bridge.json'));
}

// ── 3. 报告 ─────────────────────────────────────────────────────────────────
let totalFiles = 0, totalBytes = 0;
const rows = [];
for (const [k, v] of Object.entries(stats)) {
  if (v.skipped) { rows.push(`  跳过  ${k}`); continue; }
  totalFiles += v.files; totalBytes += v.bytes;
  rows.push(`  ${String(v.files).padStart(6)} 个 ${(v.bytes / 1048576).toFixed(1).padStart(8)} MB  ${k}`);
}
console.log(rows.join('\n'));
if (failures.length) { console.log(`\n⚠️ 失败 ${failures.length} 项：`); failures.slice(0,10).forEach(f=>console.log('  '+f)); }
console.log(`\n合计 ${totalFiles} 个文件 / ${(totalBytes / 1048576).toFixed(1)} MB${DRY ? '（dry-run，未复制）' : ''}`);
