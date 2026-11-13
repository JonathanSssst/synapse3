// extensions.cjs · 控制台侧的扩展管理
//
// 三件事：
//   1. 读/装/卸扩展（内置的写状态即可，远端的要下载校验）
//   2. 把「装了哪些扩展」同步到 DSH 的 MCP 配置
//   3. bootstrap：尊重用户机器上的现状
//
// 为什么要有 bootstrap：DSH 的 profile 里可能早就配着 mcp-pcops（电脑助手）。
// 如果按「状态文件里没有 = 没装」处理，第一次点保存就会把那条条目清理掉，
// 用户会发现电脑助手凭空消失，而他什么都没做。所以启动时先反向认领一次。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

let resolveMod = null;
function resolver() {
  if (!resolveMod) resolveMod = require('./resolve-packages.cjs');
  return resolveMod;
}

function packagesDir() { return resolver().packagesDir(); }
function repoRoot() { return path.resolve(packagesDir(), '..'); }

async function extMod() {
  return import(pathToFileURL(path.join(packagesDir(), 'extensions', 'index.mjs')).href);
}
async function marketMod() {
  return import(pathToFileURL(path.join(packagesDir(), 'extensions', 'market.mjs')).href);
}

// ── DSH profile 定位 ──────────────────────────────────────────────────────

/**
 * 找出该改哪个 profile。
 * 优先环境变量；否则选 cordis.patch.yml 最近被改过的那个 —— 正在用的那个一定刚被写过。
 * 选错的表现是「装了扩展但工具没出现」，所以这个值会显示在界面上，让用户能核对。
 */
function detectProfile() {
  if (process.env.SYNAPSE_DSH_PROFILE) return process.env.SYNAPSE_DSH_PROFILE;
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const root = path.join(dshHome, 'profiles');
  try {
    const cands = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name, 'cordis.patch.yml'))
      .filter((f) => fs.existsSync(f))
      .map((f) => ({ name: path.basename(path.dirname(f)), mtime: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (cands.length) return cands[0].name;
  } catch {}
  return 'desktop';
}

function profileFile(profile) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'profiles', profile, 'cordis.patch.yml');
}

/** 把 DSH 里已经配着的、归我们管的 MCP 反向认领为「已安装」。 */
async function bootstrap() {
  const e = await extMod();
  const state = e.readState();
  const profile = detectProfile();
  let text = '';
  try { text = fs.readFileSync(profileFile(profile), 'utf8'); } catch { return { profile, claimed: [] }; }

  // 老用户升级：DSH 里已经挂着 mcp-snowluma，说明这台机器早就在跑机器人。
  // 这时候如果按「状态文件为空 = 什么都没装」处理，B 站、空间、抖音这些
  // 没有 MCP 条目的能力会在升级瞬间全部消失 —— 用户什么都没做，功能却没了。
  // 所以首次迁移按「保持现状」处理：全部标记为已装，要精简可以自己去扩展页卸。
  // 全新安装没有 mcp-snowluma（还没配过 DSH），走下面的按条目认领，即真正的裸机。
  const existingInstall = text.includes('id: mcp-snowluma');
  if (existingInstall && !fs.existsSync(e.STATE_FILE)) {
    for (const p of e.PACKAGES) {
      if (!state.installed?.[p.id]) e.install(p.id, { source: 'builtin', version: '0.1.0' });
    }
    return { profile, claimed: e.PACKAGES.map((p) => p.id), migrated: true };
  }

  const claimed = [];
  // activity-time 是后加的默认扩展：已经在用的机器不会重走「全装」那一步，
  // 不补的话升级后她会突然不再自己安排任何事，而用户什么都没改。
  if (text.includes('id: mcp-snowluma') && !state.installed?.['activity-time']) {
    e.install('activity-time', { source: 'builtin', version: '0.1.0' });
    claimed.push('activity-time');
  }

  for (const p of e.PACKAGES) {
    if (!p.mcpServers?.length) continue;
    if (state.installed?.[p.id]) continue;
    // 必须它的所有 MCP 条目都在配置里才算「本来就装了」，否则只是装了一半。
    const all = p.mcpServers.every((m) => text.includes(`id: ${m.id}`));
    if (!all) continue;
    e.install(p.id, { source: 'builtin', version: '0.1.0' });
    claimed.push(p.id);
  }
  return { profile, claimed };
}

// ── 远端索引缓存 ──────────────────────────────────────────────────────────

const remote = { at: 0, index: null, error: null, mirror: '', url: '' };
const REMOTE_TTL_MS = 10 * 60 * 1000;

async function loadRemote({ force = false } = {}) {
  if (!force && remote.index && Date.now() - remote.at < REMOTE_TTL_MS) return remote;
  try {
    const m = await marketMod();
    const r = await m.fetchIndex();
    Object.assign(remote, { at: Date.now(), index: r.index, error: null, mirror: r.mirror, url: r.url });
  } catch (e) {
    Object.assign(remote, { at: Date.now(), index: null, error: e.message, mirror: '', url: '' });
  }
  return remote;
}

// ── 对外接口 ──────────────────────────────────────────────────────────────

/** 列表：内置扩展 + 远端市场里还没装的包。 */
async function list({ refresh = false } = {}) {
  const e = await extMod();
  const state = e.readState();
  const builtin = e.list(state);
  const builtinIds = new Set(builtin.map((b) => b.id));

  const r = await loadRemote({ force: refresh });
  let market = [];
  if (r.index) {
    const m = await marketMod();
    market = m.summarize(r.index, state).filter((p) => !builtinIds.has(p.id));
  }

  return {
    builtin,
    market,
    profile: detectProfile(),
    installedCount: builtin.filter((b) => b.installed).length + market.filter((p) => p.installed).length,
    coreTools: e.CORE_TOOLS.length,
    indexError: r.error,
    fetchedAt: r.at ? new Date(r.at).toISOString() : ''
  };
}

async function refresh() {
  await loadRemote({ force: true });
  return list();
}

/** 把当前安装状态同步进 DSH 的 MCP 区块。只动这一段，不碰 preset / bundle。 */
function syncDsh() {
  // 源码是 <root>/apps/bridge，打包后是 <resources>/app/bridge —— 少一层 apps。
  // 只写一个路径的话，源码能跑、装完就报「找不到同步脚本」，属于只在打包后暴露的错。
  const candidates = [
    path.join(repoRoot(), 'apps', 'bridge', 'scripts', 'setup-dsh.mjs'),
    path.join(repoRoot(), 'app', 'bridge', 'scripts', 'setup-dsh.mjs')
  ];
  const script = candidates.find((f) => fs.existsSync(f));
  if (!script) return { ok: false, error: `找不到同步脚本：${candidates.join(' 或 ')}` };
  const profile = detectProfile();
  const node = resolver().runtimeNode();
  const r = spawnSync(node, [script, profile, '--sync-mcp-only'], {
    timeout: 60000,
    windowsHide: true,
    encoding: 'utf8'
  });
  if (r.error) return { ok: false, error: r.error.message, profile };
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) return { ok: false, error: out.slice(-400) || `退出码 ${r.status}`, profile };
  return { ok: true, profile, log: out.split('\n').slice(-3).join('\n') };
}

async function install(id) {
  const e = await extMod();
  const builtinPkg = e.PACKAGE_BY_ID.get(id);
  const warnings = [];

  if (builtinPkg) {
    e.install(id, { source: 'builtin' });
  } else {
    // 远端扩展：索引里必须有它，且带 sha256，否则不装。
    const r = await loadRemote();
    const meta = r.index?.packages?.find((p) => p.id === id);
    if (!meta) throw new Error(`扩展市场里没有 ${id}（${r.error || '索引为空'}）`);
    const m = await marketMod();
    // 先下载解包（失败就什么都没写），再写状态 —— 顺序反了会留下"装了但没代码"的记录。
    const res = await m.installRemote(id, meta);
    e.install(id, { source: 'remote', version: meta.version, mcpServers: res.manifest?.mcpServers || [] });
  }

  const dsh = syncDsh();
  if (!dsh.ok) warnings.push(`DSH 配置未同步：${dsh.error}`);
  return { ok: true, id, dsh, warnings };
}

async function uninstall(id) {
  const e = await extMod();
  const state = e.readState();
  if (!state.installed?.[id]) return { ok: true, id, skipped: true };

  // 顺序很重要：先删状态再同步。同步时该 MCP 已不在 active 列表里，
  // 但 id 仍留在 knownMcpIds 账本上，所以旧条目能被认领并清理掉。
  e.uninstall(id);
  const dsh = syncDsh();
  return { ok: true, id, dsh, warnings: dsh.ok ? [] : [`DSH 配置未同步：${dsh.error}`] };
}

module.exports = { list, refresh, install, uninstall, bootstrap, syncDsh, detectProfile };
