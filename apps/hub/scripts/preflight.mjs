// 打包前置自检 —— 专治「源码能跑、装完就崩」。
//
// 起因：新增 extensions.cjs 后，electron-builder.yml 的 files 是逐个列文件名的，
// 漏了它。源码 `npm start` 一切正常，打成 exe 一启动就
// `Cannot find module './extensions.cjs'`，弹出的还是主进程崩溃框。
// 这类错的共同点是：只有安装后才暴露，而开发者本机永远复现不出来。
//
// 所以打包前做三件事：
//   1. 每个 .cjs 都过一遍 --check（原来的 check 脚本也是硬编码文件名，同样会漏）
//   2. files 清单必须覆盖所有 .cjs
//   3. extraResources 必须提供代码在运行时依赖的目录
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = path.resolve(import.meta.dirname, '..');
const fail = (msg) => { console.error(`[preflight] ✗ ${msg}`); process.exit(1); };

// ── 1. 语法 ────────────────────────────────────────────────────────────────
const cjs = fs.readdirSync(dir).filter((f) => f.endsWith('.cjs')).sort();
for (const f of cjs) {
  try {
    execFileSync(process.execPath, ['--check', path.join(dir, f)], { stdio: 'pipe' });
  } catch (e) {
    fail(`${f} 语法错误：\n${String(e.stderr || e.message)}`);
  }
}

// ── 2. files 覆盖 ──────────────────────────────────────────────────────────
const ymlPath = path.join(dir, 'electron-builder.yml');
if (!fs.existsSync(ymlPath)) fail('缺 electron-builder.yml');
const yml = fs.readFileSync(ymlPath, 'utf8');

// 按行切段：yml 是 CRLF 还是 LF 不该影响判断（之前用 `^files:\n` 就因为 CRLF 直接没匹配上）。
const lines = yml.split(/\r?\n/);
const start = lines.findIndex((l) => /^files:\s*$/.test(l));
if (start < 0) fail('electron-builder.yml 里找不到 files 段');
const filesBlock = (() => {
  const buf = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && !/^\s/.test(l)) break;   // 顶层键 → 段结束
    buf.push(l);
  }
  return buf.join('\n');
})();
if (!filesBlock.trim()) fail('electron-builder.yml 的 files 段是空的');

// 有通配符就不逐个比对；没有就必须全部列出。
const wildcard = /(["']?)\*\.cjs\1/.test(filesBlock);
if (!wildcard) {
  const missing = cjs.filter((f) => !filesBlock.includes(f));
  if (missing.length) {
    fail(`files 漏了这些主进程文件：${missing.join(', ')}\n` +
      `  源码能跑，装完会崩在 require。改成 "*.cjs" 一劳永逸。`);
  }
}

// ── 3. 运行时依赖的目录必须在 extraResources 里 ────────────────────────────
const needs = [
  { key: 'hub-payload/app', why: '桥接与面板的代码' },
  { key: 'hub-payload/packages', why: 'paths / extensions 等共享包（asar 内靠它定位）' },
  { key: 'hub-payload/runtime', why: '内置 node.exe' },
  { key: 'config/default', why: '首启向导的出厂模板' }
];
for (const n of needs) {
  if (!yml.includes(n.key)) fail(`extraResources 缺少 ${n.key}（${n.why}）`);
}

// ── 4. 载荷是否已构建 ──────────────────────────────────────────────────────
const payload = path.resolve(dir, '..', '..', 'dist', 'hub-payload');
if (!fs.existsSync(path.join(payload, 'app', 'bridge', 'src'))) {
  fail('dist/hub-payload 不存在或不完整。先跑：node scripts/build-hub.mjs');
}
if (!fs.existsSync(path.join(payload, 'packages', 'extensions', 'index.mjs'))) {
  fail('载荷里没有 packages/extensions。build-hub.mjs 的 packages 列表要包含 extensions');
}

console.log(`[preflight] ${cjs.length} 个主进程文件语法通过；files 覆盖、extraResources、载荷检查通过`);
