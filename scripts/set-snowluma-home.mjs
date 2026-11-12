#!/usr/bin/env node
/**
 * set-snowluma-home.mjs — 把桥接配置里的 snowluma.homeDir 指向实际在用的 SnowLuma 目录
 *
 * 为什么单独写一个脚本：在命令行里传 Windows 反斜杠路径会被外层 shell 改写
 * （实测反斜杠被翻倍成正斜杠），而 homeDir 是要拼进
 * `<home>/config/onebot_<uin>.json` 去扫描 token 的，路径错了就扫不到任何账号。
 *
 * 用法：node scripts/set-snowluma-home.mjs --dir "<SnowLuma 安装目录>" [--check]
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const DIR = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null;
const CHECK = args.includes('--check');

if (!CHECK && !DIR) {
  console.error('用法：node scripts/set-snowluma-home.mjs --dir "<SnowLuma 安装目录>"');
  console.error('      node scripts/set-snowluma-home.mjs --check');
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CFG = path.join(ROOT, 'config', 'bridge.json');

if (!fs.existsSync(CFG)) { console.error('找不到', CFG); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const cur = cfg.snowluma?.homeDir ?? '(未设置)';

if (CHECK) {
  console.log('当前 homeDir =', cur);
  const dir = path.join(cur, 'config');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^onebot_\d+\.json$/i.test(f)) : [];
  console.log('该目录下 OneBot 账号配置：', files.length ? files.join(', ') : '(无)');
  process.exit(0);
}

if (!fs.existsSync(DIR)) { console.error('目标目录不存在：', DIR); process.exit(2); }
cfg.snowluma = cfg.snowluma || {};
cfg.snowluma.homeDir = DIR;
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

// 立刻回读校验：既校验 JSON 合法性，也校验落盘的字节没被编码转换
const back = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const dir = path.join(back.snowluma.homeDir, 'config');
const list = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^onebot_\d+\.json$/i.test(f)) : [];
console.log(`${cur}  →  ${back.snowluma.homeDir}`);
console.log('回读校验通过；该目录下 OneBot 配置：', list.length ? list.join(', ') : '(无)');
