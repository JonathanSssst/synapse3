// firstrun.cjs · 环境体检
//
// 首启向导的「事实层」：只负责报告"缺什么、怎么补"，不替用户安装第三方软件。
// 这是 A 方案的全部自动化边界：检测 + 引导 + 一键执行本仓内的脚本。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { loadPaths, runtimeNode } = require('./resolve-packages.cjs');

let P = null;
async function paths() {
  if (!P) P = await loadPaths();
  return P;
}

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

// ── 配置读写 ───────────────────────────────────────────────────────────────
//
// 写回哪个文件有讲究：历史遗留里配置可能在 apps/bridge/config.json，
// 桥接的 configPath() 是「config/bridge.json 优先，回落 ROOT/config.json」。
// 如果向导不看现状就往 config/bridge.json 写，会凭空多出一份配置把旧的盖掉
// —— 旧配置里那些没进表单的字段（pricing / slang / socialV2 …）就丢了。
// 所以：改哪里取决于「现在生效的是哪个文件」，没有才新建。

function configCandidates(p) {
  return [path.join(p.CONFIG, 'bridge.json'), path.join(p.BRIDGE_ROOT, 'config.json')];
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 当前生效的配置文件（桥接实际会读的那个）。 */
async function activeConfigPath() {
  const p = await paths();
  return configCandidates(p).find(exists) || path.join(p.CONFIG, 'bridge.json');
}

function readConfigSync(p) {
  for (const f of configCandidates(p)) {
    const j = readJson(f);
    if (j) return j;
  }
  return null;
}

/** 出厂模板：打包后在 resources/config-default，源码在 config/default。 */
function templateFile() {
  const cands = [
    process.resourcesPath ? path.join(process.resourcesPath, 'config-default', 'bridge.example.json') : null,
    path.resolve(__dirname, '..', '..', 'config', 'default', 'bridge.example.json'),
    path.resolve(__dirname, '..', '..', '..', 'config', 'default', 'bridge.example.json')
  ].filter(Boolean);
  return cands.find(exists) || null;
}

function getPath(obj, keys) {
  return keys.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

// 原子写：先写同目录临时文件再 rename。桥接随时可能读这个文件，
// 直接覆盖会有一瞬间读到半截 JSON 的窗口。
function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function backupConfig(file, p) {
  if (!exists(file)) return null;
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const dir = path.join(p.BACKUPS, 'config');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `bridge-${stamp}.json`);
  fs.copyFileSync(file, dst);
  return dst;
}

// ── 表单元数据 ─────────────────────────────────────────────────────────────
//
// 字段定义放在服务端：校验规则只有一份，前端只负责渲染和收集。
// label/hint 直接写给"零基础用户"看，不出现 path / JSON 这类词。

const GROUPS = [
  {
    id: 'identity',
    title: '第 1 步 · 你是谁',
    desc: '机器人靠这一组认出主人。审批请求、电脑助手都只认这个号。',
    fields: [
      {
        key: 'ownerQQ', path: ['ownerQQ'], label: '你的 QQ 号', type: 'qq', required: true,
        hint: '填你自己的号，不是机器人的号。之前踩过的坑就是把它填成了 bot。'
      },
      {
        key: 'allowPrivate', path: ['allow', 'private'], label: '允许私聊的 QQ 号', type: 'qqlist',
        hint: '留空会自动把你的号加进去。多个用逗号分隔。'
      },
      {
        key: 'allowGroups', path: ['allow', 'groups'], label: '允许的群号', type: 'qqlist',
        hint: '想让它在群里说话就填群号，留空则只在私聊里工作。'
      }
    ]
  },
  {
    id: 'gateway',
    title: '第 2 步 · QQ 网关（SnowLuma）',
    desc: '机器人登录 QQ 靠它。装好并扫码登录之后，这里填它监听在哪。',
    fields: [
      {
        key: 'snowlumaHome', path: ['snowluma', 'homeDir'], label: 'SnowLuma 安装目录', type: 'dir',
        hint: '选到解压出来的那一层文件夹。填了才知道怎么帮你重启它。'
      },
      {
        key: 'snowlumaHttp', path: ['snowluma', 'httpUrl'], label: 'HTTP 地址', type: 'url',
        placeholder: 'http://127.0.0.1:3000', hint: '默认 3000，没改过就不用动。'
      },
      {
        key: 'snowlumaWs', path: ['snowluma', 'wsUrl'], label: 'WebSocket 地址', type: 'url',
        placeholder: 'ws://127.0.0.1:3001', hint: '默认 3001，没改过就不用动。'
      },
      {
        key: 'snowlumaToken', path: ['snowluma', 'accessToken'], label: '访问令牌', type: 'secret',
        hint: 'SnowLuma 的 WebUI 里能看到。空着通常也能连，但填上更稳。'
      }
    ]
  },
  {
    id: 'agent',
    title: '第 3 步 · 智能体（DSH）',
    desc: '真正负责"思考"的那一层。端口每次启动都可能变，所以可以自动探测。',
    fields: [
      {
        key: 'dshBaseUrl', path: ['dsh', 'baseUrl'], label: 'API 地址', type: 'url', detect: 'dsh',
        placeholder: 'http://127.0.0.1:5744', hint: '不知道就点右边的「自动探测」。'
      },
      {
        key: 'dshToken', path: ['dsh', 'authToken'], label: '访问令牌', type: 'secret',
        hint: 'DSH 开了鉴权才需要；没开就留空。'
      }
    ]
  }
];

const ALL_FIELDS = GROUPS.flatMap((g) => g.fields);

function coerce(field, raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (field.type === 'qq') return v ? Number(v) : 0;
  if (field.type === 'qqlist') {
    return v.split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean);
  }
  return v;
}

function validate(values) {
  const errors = {};
  for (const f of ALL_FIELDS) {
    // 只校验这次真的提交上来的字段。前端每次都提交全量，
    // 但接口留出局部更新的余地（换个调用方就不用为了改一项而回填全部）。
    if (!(f.key in values)) continue;
    const raw = values[f.key];
    const s = String(raw == null ? '' : raw).trim();
    if (f.required && !s) { errors[f.key] = '这一项必填'; continue; }
    if (!s) continue;
    if (f.type === 'qq' && !/^\d{5,12}$/.test(s)) errors[f.key] = 'QQ 号应该是 5~12 位数字';
    if (f.type === 'qqlist') {
      const bad = s.split(/[\s,，、;；]+/).filter(Boolean).filter((x) => !/^\d{5,12}$/.test(x));
      if (bad.length) errors[f.key] = `这些不是合法号码：${bad.slice(0, 3).join('、')}`;
    }
    if (f.type === 'url' && !/^(https?|wss?):\/\/[^\s]+$/i.test(s)) {
      errors[f.key] = '要以 http:// 或 ws:// 开头';
    }
  }
  return errors;
}

/** 把当前配置摊平成表单值。 */
function valuesFromConfig(cfg) {
  const out = {};
  for (const f of ALL_FIELDS) {
    const v = cfg ? getPath(cfg, f.path) : undefined;
    out[f.key] = Array.isArray(v) ? v.join(', ') : (v == null ? '' : v);
    if (f.key === 'ownerQQ' && !out[f.key]) out[f.key] = '';
  }
  return out;
}


async function checkNode() {
  // 别测 process.versions.node：打包后那是 Electron 自带的 Node（20.x），
  // 而真正跑桥接的是 resources/runtime/node.exe。测错对象会一直报"版本不够"。
  const exe = runtimeNode();
  let version = process.versions.node;
  let where = 'Electron 内置';
  try {
    const out = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    const m = out.match(/v?(\d+\.\d+\.\d+)/);
    if (m) {
      version = m[1];
      where = /[\\/]runtime[\\/]/i.test(exe) ? '随包内置' : '系统';
    }
  } catch { /* 探不到就按 Electron 的版本算，至少给个数字 */ }
  const major = Number(version.split('.')[0]);
  return {
    id: 'node',
    name: 'Node 运行时',
    ok: major >= 22,
    detail: `v${version}（${where}）`,
    hint: major >= 22 ? '' : '跑桥接的 Node 需要 22 及以上；安装包请用 Node 22+ 构建',
    fix: null
  };
}

async function checkDsh() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const hasHome = exists(home);
  const hasProfile = exists(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'))
    || exists(path.join(home, 'profiles', 'web', 'cordis.patch.yml'));
  // TODO(D6)：DSH 没有稳定的版本文件（只有 app-update.yml 的 channel），
  // 版本比对暂用"安装目录存在 + profile 就位"。等官方提供版本接口再钉 44.x。
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
  const p = await paths();
  // 环境变量优先，其次读配置里的 snowluma.homeDir。
  // 只读环境变量是错的：正常安装的用户不会去设它，会一直显示"未设置"。
  const cfg = readConfigSync(p);
  const home = process.env.SNOWLUMA_HOME || getPath(cfg || {}, ['snowluma', 'homeDir']) || '';
  const httpUrl = getPath(cfg || {}, ['snowluma', 'httpUrl']) || '';
  const missing = !home || !exists(home);
  return {
    id: 'snowluma',
    name: 'SnowLuma 网关',
    ok: !missing,
    detail: missing
      ? (home ? `目录不存在：${home}` : '还没填安装目录')
      : home,
    hint: missing
      ? 'OneBot v11 网关，需扫码登录 QQ；在下面的向导里填安装目录即可'
      : `接口地址：${httpUrl || '(未设置)'}`,
    fix: 'guide'
  };
}

async function checkConfig() {
  const p = await paths();
  const bridgeCfg = configCandidates(p).find(exists);
  const j = readConfigSync(p) || {};
  const ownerQQ = Number(j.ownerQQ || 0);
  const allow = { private: getPath(j, ['allow', 'private']) || [], groups: getPath(j, ['allow', 'groups']) || [] };
  return {
    id: 'config',
    name: '机器人配置',
    ok: Boolean(bridgeCfg) && ownerQQ > 0,
    detail: bridgeCfg
      ? `配置文件就绪；主人 QQ ${ownerQQ || '未设置'}，允许私聊 ${allow.private.length} 个 / 群 ${allow.groups.length} 个`
      : '还没有配置文件（在下面的向导里填完会自动生成）',
    hint: ownerQQ > 0 ? '' : '没设置主人 QQ 时，审批和电脑助手会全部失效',
    fix: 'guide'
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

// ── 向导：读现状 → 填 → 落盘 ───────────────────────────────────────────────

async function form() {
  const p = await paths();
  const cfg = readConfigSync(p);
  const tplFile = templateFile();
  const base = cfg || readJson(tplFile || '') || {};
  const values = valuesFromConfig(base);
  const empty = ALL_FIELDS.filter((f) => !String(values[f.key] ?? '').trim()).map((f) => f.key);
  return {
    groups: GROUPS,
    values,
    configPath: await activeConfigPath(),
    exists: Boolean(cfg),
    template: tplFile,
    // 没有实例配置时，表单值来自出厂模板 —— 用户看到的默认端口就是模板里的
    fromTemplate: !cfg,
    empty,
    needsSetup: !cfg || Number(base.ownerQQ || 0) <= 0
  };
}

async function save(values) {
  const errors = validate(values || {});
  if (Object.keys(errors).length) return { ok: false, errors };

  const p = await paths();
  const file = await activeConfigPath();
  const cfg = readConfigSync(p) || readJson(templateFile() || '') || {};
  const before = JSON.stringify(cfg);

  for (const f of ALL_FIELDS) {
    if (!(f.key in (values || {}))) continue;
    setPath(cfg, f.path, coerce(f, values[f.key]));
  }

  const warnings = [];
  const owner = Number(cfg.ownerQQ || 0);
  if (owner > 0) {
    const priv = getPath(cfg, ['allow', 'private']);
    // allow.private 为空 + allowAllWhenEmpty=false 时，连主人都进不来。
    // 用户只填了"我是谁"却没填"允许谁"，这一步替他补上。
    if (!Array.isArray(priv) || priv.length === 0) {
      setPath(cfg, ['allow', 'private'], [String(owner)]);
      warnings.push('私聊白名单原本是空的，已自动把你的号填进去');
    }
  } else {
    warnings.push('没填主人 QQ：审批和电脑助手不会工作');
  }

  const home = String(getPath(cfg, ['snowluma', 'homeDir']) || '');
  if (home && !exists(home)) warnings.push(`SnowLuma 目录不存在：${home}`);

  // 什么都没改就别动文件 —— 每次点保存都刷新一遍 mtime 会让用户以为出事了
  const after = JSON.stringify(cfg);
  if (after === before) {
    return { ok: true, path: file, backup: null, changed: false, warnings };
  }

  const backup = backupConfig(file, p);
  atomicWriteJson(file, cfg);

  return {
    ok: true,
    path: file,
    backup,
    changed: true,
    warnings
  };
}

/** 复用 services 里那套指纹探测，避免两处各写一份 DSH 端口扫描。 */
async function detectDshUrl() {
  const { detectDsh } = require('./services.cjs');
  return detectDsh();
}

async function run() {
  const items = [];
  for (const fn of [checkNode, checkDsh, checkSnowluma, checkConfig, checkPersona, checkUi]) {
    try { items.push(await fn()); }
    catch (e) { items.push({ id: fn.name, name: fn.name, ok: false, detail: e.message, hint: '', fix: null }); }
  }
  const blocking = items.filter((i) => !i.ok && ['node', 'config'].includes(i.id));
  return {
    items,
    ready: blocking.length === 0,
    blocking: blocking.map((b) => b.name),
    // 有 fix:'guide' 的项没通过 → 该把向导推到用户面前
    needsSetup: items.some((i) => i.fix === 'guide' && !i.ok)
  };
}

module.exports = { run, form, save, detectDshUrl };
