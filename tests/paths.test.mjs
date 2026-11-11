// paths 自检：用临时夹具构造 legacy / v2 两种布局，不依赖本机真实数据。
// 这样在 CI 的干净 checkout 里也能跑。
//
// 运行：node tests/paths.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { console.error(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-paths-'));
let seq = 0;

/** 造一个安装根，按需创建 v2 或 legacy 的标志目录。 */
function fixture(kind) {
  const home = path.join(tmpRoot, `h${++seq}`);
  fs.mkdirSync(home, { recursive: true });
  if (kind === 'v2') {
    fs.mkdirSync(path.join(home, 'data', 'state'), { recursive: true });
    fs.mkdirSync(path.join(home, 'data', 'db'), { recursive: true });
    fs.writeFileSync(path.join(home, 'data', 'db', 'audit.db'), '');
    fs.mkdirSync(path.join(home, 'data', 'personas', '默认人设'), { recursive: true });
  } else {
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.mkdirSync(path.join(home, 'audit'), { recursive: true });
    fs.writeFileSync(path.join(home, 'audit', 'audit.db'), '');
  }
  return home;
}

async function load(home, extraEnv = {}) {
  // 环境变量在模块加载时读取，必须用查询串绕开 import 缓存
  process.env.SYNAPSE_HOME = home;
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  return import(`../packages/paths/index.mjs?case=${seq}-${Date.now()}`);
}

// ── 用例 1：v2 布局 ────────────────────────────────────────────────────────
{
  const home = fixture('v2');
  const P = await load(home);
  const d = P.describe();
  ok('v2：布局判定', d.layout === 'v2', d.layout);
  ok('v2：STATE_DIR 指向 data/state', P.STATE_DIR === path.join(home, 'data', 'state'), P.STATE_DIR);
  ok('v2：DB_FILE 指向 data/db', P.DB_FILE === path.join(home, 'data', 'db', 'audit.db'), P.DB_FILE);
  ok('v2：PERSONAS_DIR 指向 data/personas', P.PERSONAS_DIR === path.join(home, 'data', 'personas'), P.PERSONAS_DIR);
  ok('v2：SECRETS 在 config/secrets', P.SECRETS === path.join(home, 'config', 'secrets'), P.SECRETS);
  ok('v2：WRITE_SANDBOX === HOME', P.WRITE_SANDBOX === home);
}

// ── 用例 2：legacy 布局（迁移前）──────────────────────────────────────────
{
  const home = fixture('legacy');
  const P = await load(home);
  const d = P.describe();
  ok('legacy：布局判定', d.layout === 'legacy', d.layout);
  ok('legacy：STATE_DIR 回落根目录 state', P.STATE_DIR === path.join(home, 'state'), P.STATE_DIR);
  ok('legacy：DB_FILE 回落到 audit/audit.db', P.DB_FILE === path.join(home, 'audit', 'audit.db'), P.DB_FILE);
}

// ── 用例 3：代码根独立于数据根 ─────────────────────────────────────────────
{
  const home = fixture('v2');
  const P = await load(home);
  const codeRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  ok('APPS 跟着代码走，不跟着数据走', P.APPS === path.join(codeRoot, 'apps'), `${P.APPS} vs ${path.join(codeRoot, 'apps')}`);
  ok('BRIDGE_ROOT 默认在 apps/bridge', P.BRIDGE_ROOT === path.join(codeRoot, 'apps', 'bridge'), P.BRIDGE_ROOT);
  ok('PATH 是绝对路径', path.isAbsolute(P.PANEL_UI_DIST));
}

// ── 用例 4：SYNAPSE_BRIDGE 覆盖（迁移期把数据留在旧目录）───────────────────
{
  const home = fixture('v2');
  const external = path.join(tmpRoot, 'external-bridge');
  fs.mkdirSync(path.join(external, 'personas'), { recursive: true });
  const P = await load(home, { SYNAPSE_BRIDGE: external });
  ok('SYNAPSE_BRIDGE 覆盖代码根', P.BRIDGE_ROOT === path.resolve(external), P.BRIDGE_ROOT);
}

// ── 用例 5：导出项全部是绝对路径 ──────────────────────────────────────────
{
  const home = fixture('v2');
  const P = await load(home);
  for (const [k, v] of Object.entries(P.default)) {
    if (typeof v === 'string') assert.ok(path.isAbsolute(v), `${k} 不是绝对路径: ${v}`);
  }
  ok('全部路径导出项均为绝对路径', true);
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
console.log(`\n通过 ${pass} 项`);
