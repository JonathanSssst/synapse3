// policy 自检：规则命中、白名单、沙箱范围、频率闸。
// 运行：node tests/policy.test.mjs
import assert from 'node:assert/strict';
import { evaluate, rateLimit, DEFAULT_RULES, ACTIONS } from '../packages/policy/index.mjs';

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const allowlist = { private: ['111', '222'], groups: ['999'] };

ok('白名单内的私聊 → allow', () => {
  const r = evaluate({ action: ACTIONS.SEND_PRIVATE, target: '111', allowlist });
  assert.equal(r.decision, 'allow');
});

ok('白名单外的私聊 → deny', () => {
  const r = evaluate({ action: ACTIONS.SEND_PRIVATE, target: '333', allowlist });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /不在白名单/);
});

ok('白名单内的群 → allow', () => {
  assert.equal(evaluate({ action: ACTIONS.SEND_GROUP, target: '999', allowlist }).decision, 'allow');
});

ok('电脑操作 → ask（不是 allow）', () => {
  const r = evaluate({ action: ACTIONS.MACHINE_OPS, target: 'screenshot' });
  assert.equal(r.decision, 'ask');
});

ok('删除类 → deny', () => {
  assert.equal(evaluate({ action: ACTIONS.FILE_DELETE, target: 'x' }).decision, 'deny');
  assert.equal(evaluate({ action: ACTIONS.QZONE_DELETE, target: 'tid' }).decision, 'deny');
});

ok('改配置 → ask', () => {
  assert.equal(evaluate({ action: ACTIONS.CONFIG_WRITE, target: 'bridge.json' }).decision, 'ask');
});

ok('沙箱内写文件 → allow', () => {
  const r = evaluate({ action: ACTIONS.FILE_WRITE, target: 'E:/Synapse/data/notes/a.md', sandboxRoot: 'E:/Synapse' });
  assert.equal(r.decision, 'allow');
});

ok('越出沙箱写文件 → deny', () => {
  const r = evaluate({ action: ACTIONS.FILE_WRITE, target: 'C:/Windows/system.ini', sandboxRoot: 'E:/Synapse' });
  assert.equal(r.decision, 'deny');
});

ok('服务起停：主人 allow / 他人 deny', () => {
  assert.equal(evaluate({ action: ACTIONS.SERVICE_CONTROL, actor: '1', ownerQQ: '1' }).decision, 'allow');
  assert.equal(evaluate({ action: ACTIONS.SERVICE_CONTROL, actor: '2', ownerQQ: '1' }).decision, 'deny');
});

ok('未知动作 → ask（默认询问，不默认放行）', () => {
  assert.equal(evaluate({ action: 'something.new' }).decision, 'ask');
});

ok('每条规则都有 match 与 decision', () => {
  for (const r of DEFAULT_RULES) {
    assert.ok(r.id && r.match instanceof RegExp && r.decision, `规则不完整：${r.id}`);
  }
});

ok('频率闸：超过上限即拒绝', () => {
  const bucket = {};
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    assert.equal(rateLimit(bucket, 'send', { max: 3, windowMs: 60000, now }).allowed, true, `第 ${i + 1} 次应放行`);
  }
  assert.equal(rateLimit(bucket, 'send', { max: 3, windowMs: 60000, now }).allowed, false);
  assert.equal(rateLimit(bucket, 'send', { max: 3, windowMs: 60000, now: now + 61000 }).allowed, true, '窗口过期后应恢复');
});

console.log(`\n通过 ${pass} 项`);
