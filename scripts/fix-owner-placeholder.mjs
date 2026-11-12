#!/usr/bin/env node
/**
 * fix-owner-placeholder.mjs — 把提示词里的 `<主人QQ>` 占位符改成自然措辞
 *
 * 背景：为了不把主人 QQ 号写进公开仓，早先把预设提示词里的真实号码
 * 替换成了 `private:<主人QQ>`。但这段文字是**给模型看的**，
 * 留着尖括号占位符会让模型照抄一个不存在的会话 key，属于"看着像占位、实际是错误指令"。
 *
 * 正确做法是不让提示词需要这个数字：会话 key 本来就由桥接在每轮唤醒时下发，
 * 提示词里只需要说清"哪个会话"即可。
 */
import fs from 'node:fs';

const FILES = [
  'dsh/agent-presets/qq-chat-v2/agent.cordis.yml',
  'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml',
];

const PAIRS = [
  ['只在主人私聊（private:<主人QQ>）里可用', '只在主人私聊里可用'],
  ['private:<主人QQ>', '主人私聊会话'],
];

let changed = 0;
for (const f of FILES) {
  if (!fs.existsSync(f)) { console.log(`跳过（不存在）${f}`); continue; }
  const before = fs.readFileSync(f);
  let text = before.toString('utf8');
  let n = 0;
  for (const [a, b] of PAIRS) {
    const c = text.split(a).length - 1;
    if (c) { text = text.split(a).join(b); n += c; }
  }
  if (!n) { console.log(`无占位符 ${f}`); continue; }
  const buf = Buffer.from(text, 'utf8');
  // 保持无 BOM，风格与源文件一致
  fs.writeFileSync(f, buf);
  console.log(`${f}：改 ${n} 处，${before.length} → ${buf.length} 字节`);
  changed += n;
}
console.log(changed ? `完成，共 ${changed} 处` : '无需改动');
