#!/usr/bin/env node
// check-boundaries.mjs — 公开仓边界守卫
//
// 拦三类东西进提交：
//   1. 绝对路径硬编码（换机即崩的根因）
//   2. 作者个人信息（QQ 号、私人目录）
//   3. 密钥样式字符串
//
// 用法：node scripts/check-boundaries.mjs [--json]
// 退出码：0 干净；1 有命中（CI 直接失败）
//
// 该行如需豁免，在行尾加注释 `boundary-allow`，并写明原因。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['apps', 'packages', 'scripts', 'extensions', 'config'];
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.jsx', '.tsx', '.json', '.yml', '.yaml', '.ps1', '.bat', '.vbs']);
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', 'out', 'release', '.git', 'data', 'backups', 'logs', 'archive']);

const RULES = [
  {
    id: 'abs-path',
    label: '绝对路径硬编码',
    // 只认「盘符 + 本机真实存在的项目目录」，避免误伤 C:\Windows 这类正常系统路径
    re: /(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/](?:BOT|Users|Dev|snapshot|Synapse|Program|Programs)\b/g
  },
  {
    id: 'personal-id',
    label: '作者个人信息（QQ 号等）',
    re: /\b(?:3681901185|1539541945)\b/g // boundary-allow 规则定义本身
  },
  {
    id: 'secret',
    label: '疑似密钥',
    re: /(?:sk-[A-Za-z0-9]{20,}|SESSDATA=|Bearer\s+[A-Za-z0-9._-]{24,})/g // boundary-allow 规则定义本身
  }
];

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      yield* walk(path.join(dir, e.name));
    } else if (e.isFile() && CODE_EXT.has(path.extname(e.name).toLowerCase())) {
      yield path.join(dir, e.name);
    }
  }
}

const findings = [];
for (const sub of SCAN_DIRS) {
  for (const file of walk(path.join(ROOT, sub))) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (text.length > 4 * 1024 * 1024) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes('boundary-allow')) return;
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        const hit = rule.re.exec(line);
        if (!hit) continue;
        findings.push({
          rule: rule.id,
          label: rule.label,
          file: path.relative(ROOT, file).replace(/\\/g, '/'),
          line: i + 1,
          match: hit[0].trim()
        });
      }
    });
  }
}

// .gitignore 必须覆盖 secrets
try {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const need of ['config/secrets/', 'node_modules/']) {
    if (!gi.includes(need)) {
      findings.push({ rule: 'gitignore', label: '.gitignore 缺少规则', file: '.gitignore', line: 0, match: need });
    }
  }
} catch {
  findings.push({ rule: 'gitignore', label: '.gitignore 缺失', file: '.gitignore', line: 0, match: '' });
}

const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
} else if (findings.length === 0) {
  console.log('[boundaries] 干净：无绝对路径、无个人信息、无密钥样式字符串');
} else {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, list] of byFile) {
    console.log(`\n${file}`);
    for (const f of list) {
      console.log(`  L${f.line}  [${f.label}]  ${f.match}`);
    }
  }
  console.log(`\n[boundaries] 共 ${findings.length} 处命中。修正后重跑；确需保留请加注释 boundary-allow 并说明原因。`);
}
process.exit(findings.length === 0 ? 0 : 1);
