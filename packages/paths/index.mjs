// packages/paths · 全仓唯一路径真源
//
// 目标：任何位置都不再出现 'E:\\BOT' 这类字面量。所有目录从这里取。
//
// 两种布局同时支持（靠存在性探测，不需要环境变量开关）：
//   v2（迁移后）   <HOME>/data/state        <HOME>/data/db/audit.db
//   legacy（迁移前）<HOME>/state            <HOME>/audit/audit.db
//
// 因此同一份代码在「旧布局（数据散在根）」与「新布局（data/）」下都能跑，
// 这也是 P1 能零停机完成、P2 再切换数据的原理。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <root>/packages/paths

/** 安装根。环境变量优先；否则按目录特征探测；最后退回 exe 所在目录。 */
function detectHome() {
  if (process.env.SYNAPSE_HOME) return path.resolve(process.env.SYNAPSE_HOME);
  const repoRoot = path.resolve(HERE, '..', '..');
  // 源码树特征：同时存在 apps/ 与 packages/
  if (fs.existsSync(path.join(repoRoot, 'apps')) && fs.existsSync(path.join(repoRoot, 'packages'))) {
    return repoRoot;
  }
  // 打包后：exe 在根，app/ 与 data/ 同级
  const exeDir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(exeDir, 'app'))) return exeDir;
  return repoRoot;
}

export const HOME = detectHome();

/** 取第一个存在的候选；都不存在时返回最后一个（用来做"默认新建位置"）。 */
function pick(...cands) {
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return cands[cands.length - 1];
}

// 代码根与数据根必须分开：
//   代码根 = 程序装在哪（源码树 apps/ 或打包后的 app/）
//   数据根 = HOME（用户数据，可换盘）
// 混在一起的后果：把 SYNAPSE_HOME 指向旧树时，程序会去旧树找 apps/panel-ui。
const CODE_ROOT = (() => {
  const repo = path.resolve(HERE, '..', '..');
  if (fs.existsSync(path.join(repo, 'apps'))) return repo;                  // 源码树
  if (fs.existsSync(path.join(repo, 'app'))) return repo;                   // 组装载荷 dist/hub-payload
  const packed = path.dirname(process.execPath);
  if (fs.existsSync(path.join(packed, 'app'))) return packed;               // 打包安装后
  return repo;
})();

export const APPS = fs.existsSync(path.join(CODE_ROOT, 'app'))
  ? path.join(CODE_ROOT, 'app')
  : path.join(CODE_ROOT, 'apps');
export const PACKAGES = path.join(CODE_ROOT, 'packages');
export const DATA = path.join(HOME, 'data');
export const CONFIG = path.join(HOME, 'config');
export const SECRETS = path.join(CONFIG, 'secrets');
export const BACKUPS = path.join(HOME, 'backups');
export const LOGS = path.join(DATA, 'logs');

/** 桥接根。SYNAPSE_BRIDGE 优先（迁移期把数据留在旧目录时用）。 */
export const BRIDGE_ROOT = process.env.SYNAPSE_BRIDGE
  ? path.resolve(process.env.SYNAPSE_BRIDGE)
  : path.join(APPS, 'bridge');
export const PANEL_ROOT = path.join(APPS, 'panel-server');
export const PANEL_UI_DIST = path.join(APPS, 'panel-ui', 'dist');

// ── 数据区（v2 优先，legacy 回落）──────────────────────────────────────────

export const STATE_DIR = pick(path.join(DATA, 'state'), path.join(HOME, 'state'));
export const PERSONAS_DIR = pick(path.join(DATA, 'personas'), path.join(BRIDGE_ROOT, 'personas'));
export const BRIDGE_STATE = pick(path.join(DATA, 'state', 'bridge'), path.join(BRIDGE_ROOT, 'state'));
export const MODELS_DIR = pick(path.join(DATA, 'models'), path.join(HOME, 'data', 'models'));
export const MEDIA_DIR = path.join(DATA, 'media');

export const DB_FILE = pick(
  path.join(DATA, 'db', 'audit.db'),
  path.join(HOME, 'audit', 'audit.db')
);
export const GEN_IMAGES_DIR = pick(path.join(MEDIA_DIR, 'generated'), path.join(HOME, 'imagegen'));
export const REFS_DIR = pick(path.join(MEDIA_DIR, 'refs'), path.join(HOME, 'imagegen', 'refs'));
export const BILI_DIR = pick(path.join(DATA, 'bili'), path.join(HOME, 'bili'));
export const DOUYIN_DIR = pick(path.join(DATA, 'douyin'), path.join(HOME, 'douyin'));
export const BOOKS_DIR = pick(path.join(DATA, 'books'), path.join(HOME, 'books'));
export const SURF_DIR = pick(path.join(DATA, 'surf'), path.join(HOME, 'surf'));
export const STUDY_DIR = pick(path.join(DATA, 'study'), path.join(HOME, '学习'));
export const QZONE_ROOT = pick(path.join(HOME, 'app', 'qzone'), path.join(APPS, 'qzone'));
export const QZONE_DATA = pick(path.join(DATA, 'qzone'), path.join(QZONE_ROOT));
export const PET_DATA = pick(path.join(DATA, 'pet'), path.join(APPS, 'pet', 'data'));
export const TMP_DIR = path.join(DATA, 'tmp');

/** 人设相关的根级文档（迁移后搬进 data/personas，legacy 在 HOME 根）。 */
export const MEMORY_DOCS = [
  path.join(PERSONAS_DIR, '记忆库.md'),
  path.join(PERSONAS_DIR, '长记忆.md')
];
export const FEATURE_DOC = pick(path.join(DATA, '功能需求.md'), path.join(HOME, '功能需求.md'));

/** 机器人「能写」的沙箱根：只允许写 HOME 内。 */
export const WRITE_SANDBOX = HOME;

/** 日报/周报/日记/学习产物落盘目录。 */
export const REPORTS_DIR = pick(path.join(DATA, 'reports'), HOME);

export function ensureDirs() {
  for (const d of [DATA, STATE_DIR, LOGS, path.dirname(DB_FILE), CONFIG, SECRETS]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
}

/** 诊断输出：排查"为什么它读的是旧目录"时用。 */
export function describe() {
  return {
    HOME,
    layout: fs.existsSync(path.join(DATA, 'state')) ? 'v2' : 'legacy',
    STATE_DIR, BRIDGE_STATE, PERSONAS_DIR, DB_FILE, GEN_IMAGES_DIR, BILI_DIR, DOUYIN_DIR, BOOKS_DIR, SURF_DIR,
    BRIDGE_ROOT, PANEL_UI_DIST, SECRETS
  };
}

export default {
  HOME, APPS, PACKAGES, DATA, CONFIG, SECRETS, BACKUPS, LOGS,
  BRIDGE_ROOT, PANEL_ROOT, PANEL_UI_DIST,
  STATE_DIR, BRIDGE_STATE, PERSONAS_DIR, MODELS_DIR, MEDIA_DIR, DB_FILE,
  GEN_IMAGES_DIR, REFS_DIR, BILI_DIR, DOUYIN_DIR, BOOKS_DIR, SURF_DIR, STUDY_DIR,
  QZONE_ROOT, QZONE_DATA, PET_DATA, TMP_DIR, MEMORY_DOCS, FEATURE_DOC, WRITE_SANDBOX, REPORTS_DIR,
  ensureDirs, describe
};
