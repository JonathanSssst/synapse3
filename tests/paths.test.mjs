// paths 自检：在 legacy（E:\BOT 现状）与 v2 两种布局下都要给出正确结果。
// 运行：node tests/paths.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const P = await import('../packages/paths/index.mjs');

let pass = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { console.error(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
}

console.log(`HOME = ${P.HOME}`);
console.log(`layout = ${P.describe().layout}\n`);

ok('HOME 存在', fs.existsSync(P.HOME));
ok('STATE_DIR 存在', fs.existsSync(P.STATE_DIR), P.STATE_DIR);
ok('DB_FILE 存在', fs.existsSync(P.DB_FILE), P.DB_FILE);
ok('PERSONAS_DIR 存在', fs.existsSync(P.PERSONAS_DIR), P.PERSONAS_DIR);
ok('BRIDGE_ROOT 存在', fs.existsSync(P.BRIDGE_ROOT), P.BRIDGE_ROOT);
ok('STATE_DIR 是绝对路径', path.isAbsolute(P.STATE_DIR));
ok('WRITE_SANDBOX === HOME', P.WRITE_SANDBOX === P.HOME);

// 所有导出的路径项都必须是绝对路径且不含混合分隔符写法
for (const [k, v] of Object.entries(P.default)) {
  if (typeof v === 'string' && k !== 'layout') {
    assert.ok(path.isAbsolute(v), `${k} 不是绝对路径: ${v}`);
  }
}
ok('全部导出项均为绝对路径', true);

// 两种布局的核心差异点：v2 时 DATA/state 存在，legacy 时 HOME/state 存在
const v2 = fs.existsSync(path.join(P.DATA, 'state'));
ok('布局判定与探测一致', v2 === (P.describe().layout === 'v2'));

console.log(`\n通过 ${pass} 项`);
