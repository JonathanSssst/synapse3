#!/usr/bin/env node
// build-hub.mjs · 组装 SynapseHub 的运行时载荷
//
// 产出 dist/hub-payload/：
//   app/        bridge · panel-server · panel-ui/dist · qzone
//   packages/   paths · policy · llm-adapter     ← 必须在安装根，供 app/*/../.. 解析
//   runtime/    node.exe
//   extensions/ 内置市场索引
//
// 只做"复制 + 校验"，不做编译。electron-builder 由 npm run build 负责。
//
// 用法：node scripts/build-hub.mjs [--with-deps]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'hub-payload');
const withDeps = process.argv.includes('--with-deps');
const allowMissingUi = process.argv.includes('--allow-missing-ui');

const log = (m) => console.log(`[build-hub] ${m}`);

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
function cp(src, dst) {
  if (!fs.existsSync(src)) { log(`跳过（不存在）：${path.relative(ROOT, src)}`); return false; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, dereference: true });
  return true;
}
function must(p, label) {
  if (!fs.existsSync(p)) throw new Error(`缺少 ${label}：${p}`);
}

// ── 1. 清空 ────────────────────────────────────────────────────────────────
rmrf(OUT);
fs.mkdirSync(path.join(OUT, 'app'), { recursive: true });

// ── 2. bridge ──────────────────────────────────────────────────────────────
const bridgeSrc = path.join(ROOT, 'apps', 'bridge');
const bridgeDst = path.join(OUT, 'app', 'bridge');
for (const item of ['src', 'plugins', 'dsh', 'roles', 'scripts', 'assets', 'public', 'docs']) {
  cp(path.join(bridgeSrc, item), path.join(bridgeDst, item));
}
for (const item of ['package.json', 'package-lock.json', 'config.example.json', 'README.md', 'LICENSE', 'RULES.md']) {
  cp(path.join(bridgeSrc, item), path.join(bridgeDst, item));
}
// 依赖必须随包：打包后的 bridge 在 asar 外独立运行，找不到 node_modules 就会直接
// ERR_MODULE_NOT_FOUND（这次就是 js-yaml）。源码树里 apps/bridge/node_modules 是迁移期
// 指向旧树的符号链接，cp() 的 dereference 会把真实文件复制进来，顺带解除对旧树的依赖。
// 不跑 npm ci：离线也能构建，且不会破坏源目录那个符号链接。
const bridgeNm = path.join(bridgeSrc, 'node_modules');
if (fs.existsSync(bridgeNm)) {
  cp(bridgeNm, path.join(bridgeDst, 'node_modules'));
} else if (withDeps) {
  log('安装 bridge 生产依赖…');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['ci', '--omit=dev', '--no-audit', '--no-fund'],
    { cwd: bridgeSrc, stdio: 'inherit', shell: process.platform === 'win32' });
  cp(bridgeNm, path.join(bridgeDst, 'node_modules'));
} else {
  throw new Error('缺少 apps/bridge/node_modules：先 npm ci，或加 --with-deps 自动安装');
}

// ── 3. panel-server / qzone ────────────────────────────────────────────────
const panelSrc = path.join(ROOT, 'apps', 'panel-server');
const panelDst = path.join(OUT, 'app', 'panel-server');
for (const f of fs.readdirSync(panelSrc)) {
  if (f === 'node_modules' || f === 'logs') continue;
  cp(path.join(panelSrc, f), path.join(panelDst, f));
}
cp(path.join(ROOT, 'apps', 'qzone'), path.join(OUT, 'app', 'qzone'));

// ── 4. panel-ui 构建产物 ───────────────────────────────────────────────────
const uiDist = path.join(ROOT, 'apps', 'panel-ui', 'dist');
if (!fs.existsSync(path.join(uiDist, 'index.html'))) {
  if (!allowMissingUi) throw new Error('panel-ui 未构建：先在 apps/panel-ui 执行 npm ci && npm run build');
  log('⚠️ 面板前端未构建（--allow-missing-ui）：仅用于本地验证载荷结构，不能发版');
} else {
  cp(uiDist, path.join(OUT, 'app', 'panel-ui', 'dist'));
}

// ── 5. packages（必须放安装根）─────────────────────────────────────────────
for (const p of ['paths', 'policy', 'llm-adapter']) {
  cp(path.join(ROOT, 'packages', p), path.join(OUT, 'packages', p));
}

// ── 6. node 运行时 ─────────────────────────────────────────────────────────
const nodeSrc = process.env.NODE_EXE || (process.platform === 'win32' ? process.execPath : '');
if (nodeSrc && fs.existsSync(nodeSrc) && /node(\.exe)?$/i.test(nodeSrc)) {
  fs.mkdirSync(path.join(OUT, 'runtime'), { recursive: true });
  fs.copyFileSync(nodeSrc, path.join(OUT, 'runtime', path.basename(nodeSrc)));
  log(`内置运行时：${path.basename(nodeSrc)}（${(fs.statSync(nodeSrc).size / 1048576).toFixed(1)} MB）`);
} else {
  log('⚠️ 未找到可内置的 node 可执行文件：设置 NODE_EXE 或让安装包依赖系统 Node');
}

// ── 7. 扩展索引 ────────────────────────────────────────────────────────────
cp(path.join(ROOT, 'extensions'), path.join(OUT, 'extensions'));

// ── 8. 校验 ────────────────────────────────────────────────────────────────
must(path.join(OUT, 'app', 'bridge', 'src', 'bridge.js'), '桥接入口');
must(path.join(OUT, 'app', 'panel-server', 'server.mjs'), '面板入口');
if (!allowMissingUi) must(path.join(OUT, 'app', 'panel-ui', 'dist', 'index.html'), '面板前端');
must(path.join(OUT, 'packages', 'paths', 'index.mjs'), 'paths 包');

// 依赖自检：光看"node_modules 目录存在"不够，符号链接复制失败时目录可能还在但里面是空的。
// 逐个核对 package.json 里声明的生产依赖，缺一个就让构建直接失败，
// 而不是等用户装完 exe 才在启动时看到 ERR_MODULE_NOT_FOUND。
const bridgeDeps = JSON.parse(fs.readFileSync(path.join(bridgeSrc, 'package.json'), 'utf8')).dependencies || {};
for (const name of Object.keys(bridgeDeps)) {
  must(path.join(OUT, 'app', 'bridge', 'node_modules', name, 'package.json'), `桥接依赖 ${name}`);
}
log(`桥接依赖自检通过：${Object.keys(bridgeDeps).length} 个`);

for (const f of [
  path.join(OUT, 'app', 'bridge', 'src', 'bridge.js'),
  path.join(OUT, 'app', 'panel-server', 'server.mjs')
]) {
  const tmp = f + '.chk.mjs';
  fs.copyFileSync(f, tmp);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  finally { fs.rmSync(tmp, { force: true }); }
}
log('入口语法检查通过');

const size = (p) => {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q); else n += fs.statSync(q).size;
    }
  };
  walk(p);
  return n;
};
log(`载荷体积：${(size(OUT) / 1048576).toFixed(1)} MB → ${path.relative(ROOT, OUT)}`);
log('完成。下一步：cd apps/hub && npm install && npm run build');
