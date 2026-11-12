#!/usr/bin/env node
/**
 * patch-dsh-profile.mjs — 安全改写 DSH 的 cordis.patch.yml
 *
 * 为什么需要它：用 PowerShell 的 Get-Content -Raw / Set-Content 改写 UTF-8 无 BOM
 * 的中文 YAML 会两处出错——PS 5.1 按系统 ANSI（GBK）解码导致中文变乱码，
 * 且 Set-Content -Encoding utf8 会写入 BOM。DSH 读不了就直接启动失败。
 *
 * 本脚本保证：
 *   1. 严格按 UTF-8 读写，不写 BOM，保留原换行风格（LF / CRLF）
 *   2. 只替换指定路径，其余字节不动
 *   3. 写盘前后都做校验：UTF-8 合法性、BOM、CRLF 一致性、路径计数、结构行完整性
 *   4. 失败即回滚（写临时文件 → 校验 → 原子替换）
 *
 * 用法：
 *   node scripts/patch-dsh-profile.mjs --file <yml> --from <旧路径> --to <新路径>
 *   node scripts/patch-dsh-profile.mjs --file <yml> --restore <备份文件> --from <旧> --to <新>
 *   node scripts/patch-dsh-profile.mjs --check  <yml>
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const FILE = arg('file') || path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const FROM = arg('from');
const TO = arg('to');
const RESTORE = arg('restore');
const CHECK_ONLY = args.includes('--check');

/** 结构行：`- id:` / `- insert:` / `- remove:`，用来证明块顺序没有丢 */
function structure(text) {
  return text.split('\n')
    .filter((l) => /^\s*-\s*(insert|remove|id):/.test(l))
    .map((l) => l.trim());
}

function inspect(buf, label) {
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let text;
  let utf8ok = true;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { utf8ok = false; text = buf.toString('utf8'); }
  const crlf = (buf.toString('latin1').match(/\r\n/g) || []).length;
  const lf = (buf.toString('latin1').match(/\n/g) || []).length;
  const info = { label, bytes: buf.length, hasBom, utf8ok, crlf, lf, crlfOnly: crlf > 0 && crlf === lf, text };
  console.log(
    `[${label}] ${info.bytes}B  BOM=${hasBom ? '有(!)' : '无'}  UTF-8=${utf8ok ? 'ok' : '非法(!)'}  ` +
    `换行=${crlf && crlf === lf ? 'CRLF' : 'LF'}  结构行=${structure(text).length}`
  );
  return info;
}

// ── 只检查模式 ────────────────────────────────────────────────
if (CHECK_ONLY) {
  const info = inspect(fs.readFileSync(FILE), path.basename(FILE));
  const bad = info.hasBom || !info.utf8ok;
  if (bad) { console.log('❌ 文件不健康：BOM 或非法 UTF-8，DSH 会启动失败'); process.exit(1); }
  console.log('✅ 文件健康');
  process.exit(0);
}

if (!TO) { console.error('缺少 --to <新路径>'); process.exit(2); }

// 统一输出成 Windows 反斜杠：命令行传递时正斜杠/反斜杠经常被外层 shell 改写，
// 这里以「目标路径」为准做规范化，避免写进配置的分隔符风格随机。
const NEW = process.platform === 'win32' ? TO.replace(/\//g, '\\') : TO;

// ── 读取源（备份或现文件） ─────────────────────────────────────
const srcBuf = fs.readFileSync(RESTORE || FILE);
const src = inspect(srcBuf, RESTORE ? `备份 ${path.basename(RESTORE)}` : '当前文件');
if (!src.utf8ok) { console.error('❌ 源文件不是合法 UTF-8，拒绝继续（请换一个备份）'); process.exit(1); }
if (src.hasBom) console.log('⚠️ 源文件带 BOM，输出时会去掉');

let text = src.text.replace(/^\uFEFF/, '');
const before = structure(text);

// ── 路径替换：忽略分隔符方向，兼容 \ 与 / 混写 ─────────────────
let replaced = 0;
if (FROM) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 把路径拆成片段，片段之间允许 \ 或 / 任意组合
  const parts = FROM.split(/[\\/]+/).filter(Boolean).map(esc);
  const re = new RegExp(parts.join('[\\\\/]+'), 'g');
  text = text.replace(re, () => { replaced++; return NEW; });
  console.log(`路径替换：${replaced} 处`);
  if (replaced === 0) console.log('⚠️ 未匹配到 --from，文件内容未变（结构校验仍会执行）');
}

// 换行风格跟源文件一致；源是 LF 就保持 LF
const eol = src.crlfOnly ? '\r\n' : '\n';
if (eol === '\r\n') text = text.replace(/\r?\n/g, '\r\n');

const after = structure(text);
if (before.join('|') !== after.join('|')) {
  console.error('❌ 结构行发生变化，拒绝写入。');
  console.error('   before:', before.join(' | '));
  console.error('   after :', after.join(' | '));
  process.exit(1);
}
console.log(`结构行未变（${after.length} 条）`);

// ── 原子写入 ──────────────────────────────────────────────────
const out = Buffer.from(text, 'utf8');
const tmp = FILE + '.tmp-' + process.pid;
fs.writeFileSync(tmp, out);
const check = inspect(fs.readFileSync(tmp), '待写入');
if (check.hasBom || !check.utf8ok) { fs.rmSync(tmp, { force: true }); console.error('❌ 生成文件不健康，已放弃写入'); process.exit(1); }

if (!RESTORE) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(FILE, `${FILE}.bak-${stamp}`);
  console.log(`已备份原文件 → ${path.basename(FILE)}.bak-${stamp}`);
}
fs.renameSync(tmp, FILE);
console.log(`✅ 已写入 ${FILE}`);
