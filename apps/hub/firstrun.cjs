// firstrun.cjs · 环境体检
//
// 首启向导的「事实层」：只负责报告"缺什么、怎么补"，不替用户安装第三方软件。
// 这是 A 方案的全部自动化边界：检测 + 引导 + 一键执行本仓内的脚本。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let P = null;
async function paths() {
  if (!P) P = await import('../../packages/paths/index.mjs');
  return P;
}

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

async function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    id: 'node',
    name: 'Node 运行时',
    ok: major >= 22,
    detail: `v${process.versions.node}`,
    hint: major >= 22 ? '' : '需要 Node 22 及以上；安装包已内置 runtime/node.exe，源码运行请升级 Node',
    fix: null
  };
}

async function checkDsh() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const hasHome = exists(home);
  const hasProfile = exists(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'))
    || exists(path.join(home, 'profiles', 'web', 'cordis.patch.yml'));
  return {
    id: 'dsh',
    name: 'DeepSeek Harness',
    ok: hasHome && hasProfile,
    detail: hasHome ? (hasProfile ? '已安装且存在 profile' : '已安装但未初始化 profile') : '未检测到 DSH 配置目录',
    hint: 'Agent 运行时由你自己安装并登录；装好后本程序会自动接入',
    fix: null
  };
}

async function checkSnowluma() {
  const cfg = process.env.SNOWLUMA_HOME || '';
  return {
    id: 'snowluma',
    name: 'SnowLuma 网关',
    ok: Boolean(cfg && exists(cfg)),
    detail: cfg ? cfg : '未设置 SNOWLUMA_HOME（首次运行向导里填写安装目录）',
    hint: 'OneBot v11 网关，需扫码登录 QQ；也可用其它兼容网关，在配置里填 ws/http 地址',
    fix: null
  };
}

async function checkConfig() {
  const p = await paths();
  const bridgeCfg = [
    path.join(p.BRIDGE_ROOT, 'config.json'),
    path.join(p.CONFIG, 'bridge.json')
  ].find(exists);
  let ownerQQ = 0;
  let allow = { private: [], groups: [] };
  if (bridgeCfg) {
    try {
      const j = JSON.parse(fs.readFileSync(bridgeCfg, 'utf8'));
      ownerQQ = Number(j.ownerQQ || 0);
      allow = { private: j.allow?.private || [], groups: j.allow?.groups || [] };
    } catch {}
  }
  return {
    id: 'config',
    name: '机器人配置',
    ok: Boolean(bridgeCfg) && ownerQQ > 0,
    detail: bridgeCfg
      ? `配置文件就绪；主人 QQ ${ownerQQ || '未设置'}，允许私聊 ${allow.private.length} 个 / 群 ${allow.groups.length} 个`
      : '尚未创建 config.json（首次运行向导会生成）',
    hint: ownerQQ > 0 ? '' : '未设置主人 QQ 时，审批与电脑助手会全部失效',
    fix: 'edit-config'
  };
}

async function checkPersona() {
  const p = await paths();
  const dirs = [];
  try {
    for (const name of fs.readdirSync(p.PERSONAS_DIR, { withFileTypes: true })) {
      if (name.isDirectory()) dirs.push(name.name);
    }
  } catch {}
  return {
    id: 'persona',
    name: '人设',
    ok: dirs.length > 0,
    detail: dirs.length ? `${dirs.length} 个：${dirs.slice(0, 6).join('、')}` : '未找到人设目录',
    hint: dirs.length ? '' : '安装包自带默认人设；也可在面板「人设」页新建',
    fix: null
  };
}

async function checkUi() {
  const p = await paths();
  const ok = exists(path.join(p.PANEL_UI_DIST, 'index.html'));
  return {
    id: 'ui',
    name: '面板前端',
    ok,
    detail: ok ? '已构建' : 'dist 不存在（开发期需 npm run build）',
    hint: ok ? '' : '正式安装包已包含构建产物，源码运行请先在 apps/panel-ui 构建',
    fix: null
  };
}

async function run() {
  const items = [];
  for (const fn of [checkNode, checkDsh, checkSnowluma, checkConfig, checkPersona, checkUi]) {
    try { items.push(await fn()); }
    catch (e) { items.push({ id: fn.name, name: fn.name, ok: false, detail: e.message, hint: '', fix: null }); }
  }
  const blocking = items.filter((i) => !i.ok && ['node', 'config'].includes(i.id));
  return { items, ready: blocking.length === 0, blocking: blocking.map((b) => b.name) };
}

module.exports = { run };
