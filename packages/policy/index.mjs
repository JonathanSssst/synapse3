// packages/policy · 审批策略引擎
//
// 目标：把"什么动作必须问主人"从散落各处的 if 里抽出来，变成一张可审阅的规则表。
//
// 重要：本文件目前**不改变任何运行行为**。它是决策层，接线点在 P3.5：
//   1) bridge 的 sendToQQ / 发送类工具调用前      → evaluate()
//   2) panel 的写接口（config/persona/gen-*）      → evaluate()
//   3) Hub 的服务起停与配置修改                     → evaluate()
// 接线前需要先把"默认 ask"跑成一条可回滚的灰度，否则会突然开始拦消息。
//
// 设计三原则：
//   - 默认拒绝/默认询问，绝不是默认放行
//   - 规则命中即返回，不做多规则投票（可预测 > 聪明）
//   - 每次决策都必须能落到一条审计记录里

import fs from 'node:fs';
import path from 'node:path';

/** 归一化的动作名。新增动作必须同时补一条规则，否则落到 default（ask）。 */
export const ACTIONS = Object.freeze({
  SEND_PRIVATE: 'send.private',
  SEND_GROUP: 'send.group',
  SEND_VOICE: 'send.voice',
  SEND_IMAGE: 'send.image',
  QZONE_PUBLISH: 'qzone.publish',
  QZONE_DELETE: 'qzone.delete',
  CONFIG_WRITE: 'config.write',
  PERSONA_SWITCH: 'persona.switch',
  PERSONA_WRITE: 'persona.write',
  MACHINE_OPS: 'machine.ops',
  FILE_WRITE: 'file.write',
  FILE_DELETE: 'file.delete',
  SERVICE_CONTROL: 'service.control',
  MEMORY_WRITE: 'memory.write'
});

/**
 * 规则表。ctx 形如：
 *   { action, target, actor, ownerQQ, allowlist: { private:[], groups:[] }, payload, now }
 * decision 可为函数，返回 { decision, reason } 以支持条件判断。
 */
export const DEFAULT_RULES = Object.freeze([
  {
    id: 'owner-only-machine',
    match: /^machine\./,
    decision: 'ask',
    reason: '电脑操作（截屏/摄像头/打开程序）必须主人确认'
  },
  {
    id: 'destructive-deny',
    match: /^(file\.delete|qzone\.delete)$/,
    decision: 'deny',
    reason: '删除类动作默认拒绝，需人工在面板操作'
  },
  {
    id: 'config-ask',
    match: /^config\./,
    decision: 'ask',
    reason: '改配置会影响全局行为'
  },
  {
    id: 'persona-ask',
    match: /^persona\./,
    decision: 'ask',
    reason: '切人设会改写 QQ 资料'
  },
  {
    id: 'send-allowlist',
    match: /^send\.(private|group)$/,
    decision: (ctx) => {
      const list = String(ctx.action).endsWith('group')
        ? (ctx.allowlist?.groups || []).map(String)
        : (ctx.allowlist?.private || []).map(String);
      const target = String(ctx.target ?? '');
      if (!target) return { decision: 'deny', reason: '缺少发送目标' };
      if (list.includes(target)) return { decision: 'allow', reason: '目标在白名单内' };
      return { decision: 'deny', reason: `目标 ${target} 不在白名单` };
    }
  },
  {
    id: 'qzone-publish-ask',
    match: /^qzone\.publish$/,
    decision: 'ask',
    reason: '发说说属于公开动作'
  },
  {
    id: 'service-control-allow-owner',
    match: /^service\./,
    decision: (ctx) => (String(ctx.actor ?? '') === String(ctx.ownerQQ ?? '')
      ? { decision: 'allow', reason: '主人操作自己的服务' }
      : { decision: 'deny', reason: '非主人不能起停服务' })
  },
  {
    id: 'file-write-scope',
    match: /^file\.write$/,
    decision: (ctx) => {
      const root = String(ctx.sandboxRoot ?? '');
      const p = path.resolve(String(ctx.target ?? ''));
      if (!root) return { decision: 'ask', reason: '未指定沙箱根，无法判断范围' };
      const rel = path.relative(path.resolve(root), p);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return { decision: 'allow', reason: '写在沙箱内' };
      }
      return { decision: 'deny', reason: '越出沙箱范围' };
    }
  },
  { id: 'memory-write-allow', match: /^memory\.write$/, decision: 'allow', reason: '记忆写入是她自己的事' },
  { id: 'default-ask', match: /.*/, decision: 'ask', reason: '未识别动作，默认询问' }
]);

/**
 * 评估一个动作。
 * @returns {{ decision:'allow'|'deny'|'ask', rule:string, reason:string }}
 */
export function evaluate(ctx, rules = DEFAULT_RULES) {
  if (!ctx || !ctx.action) throw new Error('evaluate 需要 ctx.action');
  for (const rule of rules) {
    if (!rule.match.test(String(ctx.action))) continue;
    const d = typeof rule.decision === 'function' ? rule.decision(ctx) : { decision: rule.decision, reason: rule.reason };
    const decision = d?.decision || 'ask';
    if (!['allow', 'deny', 'ask'].includes(decision)) throw new Error(`规则 ${rule.id} 返回了非法决策：${decision}`);
    return { decision, rule: rule.id, reason: d?.reason || rule.reason || '' };
  }
  return { decision: 'ask', rule: 'fallthrough', reason: '没有匹配规则' };
}

/** 简易频率闸：返回 { allowed, count, windowMs }。用于发送类动作的一分钟/一小时上限。 */
export function rateLimit(bucket, key, { max, windowMs, now = Date.now() }) {
  bucket[key] = (bucket[key] || []).filter((t) => now - t < windowMs);
  if (bucket[key].length >= max) return { allowed: false, count: bucket[key].length, windowMs };
  bucket[key].push(now);
  return { allowed: true, count: bucket[key].length, windowMs };
}

/** 决策落盘：一行一条 JSONL，便于 grep 与面板读取。 */
export class PolicyLog {
  constructor(file) { this.file = file; }
  append(record) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, line, 'utf8');
      return true;
    } catch { return false; }
  }
}

export default { ACTIONS, DEFAULT_RULES, evaluate, rateLimit, PolicyLog };
