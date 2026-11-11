#!/usr/bin/env node
// codemod-paths.mjs — 把桥接/面板里的本机绝对路径换成 packages/paths 的符号
//
// 只在「复制到新仓之后的副本」上运行，绝不碰正在运行的旧树。 // boundary-allow 说明
// 三种形态：
//   1. 引号字面量里的 <盘符>:\BOT\x 或正斜杠写法（含提示词里嵌的路径）→ `${B}/x`
//   2. path.join('E:\\','BOT',...)                      → path.join(B, ...)
//   3. qq-bridge 绝对路径（audio 等）                    → `${BRIDGE_ROOT}/...`
//
// 用法：node scripts/codemod-paths.mjs [--dry] <file...>

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
function importLineFor(file) {
  let rel = path.relative(path.dirname(file), path.join(ROOT, 'packages', 'paths', 'index.mjs')).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return `import { HOME as B, BRIDGE_ROOT } from '${rel}';`;
}
const dry = process.argv.includes('--dry');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const LITERAL_RE = /(['"])((?:\\.|(?!\1)[^\\\n])*?)\1/g;

function isComment(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function convertFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  let changed = 0;

  const out = lines.map((line) => {
    let next = line;

    // 形态 2：路径拼接
    if (next.includes("path.join('E:\\\\', 'BOT'") || next.includes("path.join('E:\\\\',\"BOT\"")) {
      next = next.replace(/path\.join\('E:\\\\',\s*'BOT',\s*/, 'path.join(B, ');
      changed++;
    }

    // 跳过纯注释行，避免把说明文字改成模板字符串
    if (isComment(next)) {
      return next.replace(/E:[\\/]+BOT/g, '<SYNAPSE_HOME>');
    }

    // 形态 1：引号字面量
    next = next.replace(LITERAL_RE, (whole, quote, body) => {
      if (body.includes('${')) return whole;            // 已是模板
      if (!/E:[\\/]+BOT/.test(body)) return whole;      // 不含目标
      if (body.includes('`')) return whole;             // 含反引号，跳过待人工
      const replaced = body.replace(/E:[\\/]+BOT/g, '${B}');
      changed++;
      return '`' + replaced + '`';
    });

    // 形态 3：桥接自身绝对路径
    if (next.includes('deepseek-harness/default-workspace/qq-bridge')) {
      next = next.replace(/'[^']*deepseek-harness\/default-workspace\/qq-bridge(\/[^']*)?'/g,
        (_m, rest = '') => '`${BRIDGE_ROOT}' + rest + '`');
      changed++;
    }
    return next;
  });

  let text = out.join('\n');
  if (changed === 0) return { file, changed };

  const IMPORT_LINE = importLineFor(file);
  if (!/import \{[^}]*HOME as B[^}]*\} from '[^']*packages\/paths/.test(text)) {
    // 插到第一处 import 之前；没有 import 就放文件头注释之后
    const m = /^import\s/m.exec(text);
    if (m) {
      const at = m.index;
      text = text.slice(0, at) + IMPORT_LINE + '\n' + text.slice(at);
    } else {
      text = IMPORT_LINE + '\n' + text;
    }
  }

  if (!dry) fs.writeFileSync(file, text, 'utf8');
  return { file, changed };
}

let total = 0;
for (const f of files) {
  const abs = path.resolve(f);
  if (!fs.existsSync(abs)) { console.error(`跳过（不存在）: ${f}`); continue; }
  const r = convertFile(abs);
  total += r.changed;
  console.log(`${String(r.changed).padStart(3)} 处  ${path.relative(process.cwd(), abs)}`);
}
console.log(`\n合计 ${total} 处${dry ? '（dry-run，未写入）' : ''}`);
