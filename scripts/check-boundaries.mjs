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
import { execFileSync } from 'node:child_process';
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
    re: /(?<!\d)(?:3681901185|1539541945)(?!\d)/g // boundary-allow 规则定义本身
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

// 只检查「将进入提交」的文件：git 跟踪列表优先，避免把 gitignore 的运行时配置
// （config/bridge.json 之类，里面有真实 QQ 号）当成待发布内容误报。
function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return out.split('\0').filter(Boolean)
      .map((rel) => path.join(ROOT, rel))
      .filter((abs) => {
        if (!CODE_EXT.has(path.extname(abs).toLowerCase())) return false;
        const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
        return SCAN_DIRS.some((d) => rel === d || rel.startsWith(d + '/'));
      });
  } catch { return null; }
}

const files = trackedFiles();
const targets = files ?? SCAN_DIRS.flatMap((sub) => [...walk(path.join(ROOT, sub))]);
console.log(files ? `[boundaries] 扫描 git 跟踪文件 ${targets.length} 个` : '[boundaries] 非 git 环境，扫描目录');

const findings = [];
{
  for (const file of targets) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    // BOM 检查：DSH 的 YAML 加载器对带 BOM 的配置可能解析异常，且 BOM 会让
    // 「文件差异」看起来整篇都被改过，掩盖真正的改动。源代码一律不允许 BOM。
    if (text.charCodeAt(0) === 0xfeff) {
      findings.push({
        rule: 'bom',
        label: '文件带 UTF-8 BOM',
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        line: 1,
        match: 'BOM',
      });
      text = text.slice(1);
    }
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
  console.log('[boundaries] 干净：无绝对路径、无个人信息、无密钥样式字符串、无 BOM');
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
