/**
 * 扩展市场 —— 从远端拉索引、下载扩展包、校验后安装。
 *
 * 这里是整个程序唯一「会把外部代码放到本机并让它跑起来」的入口，
 * 所以校验不是可选项，任何一条不过就直接拒绝安装，不留半成品：
 *   1. 只接受 https，且 host 必须在白名单里（防止索引被改成任意地址）
 *   2. sha256 必须与索引声明一致（防止下到别的东西 / 被中间篡改）
 *   3. 解压后逐条校验路径不越界（防 zip slip 写进系统目录）
 *   4. manifest.id 必须与请求的扩展 id 一致（防止拿 A 的包冒充 B）
 *   5. 文件数与总体积设上限（防 zip bomb 把盘塞满）
 *
 * 内置扩展不走这里：它们的代码随程序发布，安装只是写一条状态记录。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EXT_DIR } from './index.mjs';

export const DEFAULT_REPO = 'JonathanSssst/synapse3-extensions';

/** 允许的下载来源。多一个域名就是多一个信任面，改这里之前先想清楚。 */
const ALLOWED_HOSTS = new Set([
  'raw.githubusercontent.com',
  'github.com',
  'objects.githubusercontent.com',
  'gh-proxy.com',
  'npmmirror.com'
]);

const MAX_INDEX_BYTES = 1024 * 1024;            // 索引不该超过 1MB
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;     // 单个扩展包上限 64MB
const MAX_FILES = 4000;                          // 解压后文件数上限
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;       // 解压后总体积上限

export const INDEX_URLS = {
  direct: (repo = DEFAULT_REPO) => `https://raw.githubusercontent.com/${repo}/main/index.json`,
  ghproxy: (repo = DEFAULT_REPO) => `https://gh-proxy.com/https://raw.githubusercontent.com/${repo}/main/index.json`
};

function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`地址不合法：${raw}`); }
  if (u.protocol !== 'https:') throw new Error(`只允许 https，收到 ${u.protocol}`);
  if (!ALLOWED_HOSTS.has(u.hostname)) throw new Error(`下载来源不在白名单：${u.hostname}`);
  return u;
}

function get(url, { timeout = 20000, maxBytes = MAX_INDEX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const u = assertSafeUrl(url);
    const req = https.get(u, { timeout }, (res) => {
      // 跟随重定向，但每一跳都重新校验（否则 https → 任意跳板就绕过了白名单）
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!res.headers.location) return reject(new Error('重定向缺少 Location'));
        const next = new URL(res.headers.location, u).toString();
        try { assertSafeUrl(next); } catch (e) { return reject(e); }
        return resolve(get(next, { timeout, maxBytes }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error(`响应超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`));
          return;
        }
        chunks.push(d);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.on('error', reject);
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 拉远端索引。按 mirrors 顺序尝试，第一个成功的胜出。
 * 返回 { index, url, mirror } 或抛错（调用方决定是「没网」还是「真出错」）。
 */
export async function fetchIndex({ repo = DEFAULT_REPO, mirrors = ['direct', 'ghproxy'] } = {}) {
  const errors = [];
  for (const m of mirrors) {
    const build = INDEX_URLS[m];
    if (!build) continue;
    const url = build(repo);
    try {
      const buf = await get(url);
      const index = JSON.parse(buf.toString('utf8'));
      if (index?.schema !== 1) throw new Error(`索引 schema 不支持：${index?.schema}`);
      if (!Array.isArray(index.packages)) throw new Error('索引缺少 packages 数组');
      return { index, url, mirror: m, fetchedAt: new Date().toISOString() };
    } catch (e) {
      errors.push(`${m}: ${e.message}`);
    }
  }
  throw new Error(`拉取扩展索引失败（已试 ${mirrors.join(' / ')}）：${errors.join('；')}`);
}

function unzipTo(zipPath, destDir) {
  // Windows 10 1803+ 自带 bsdtar，能直接解 zip；Linux/macOS 也有 tar。
  // 不引第三方 unzip 依赖，是为了不给这个「装外部代码」的路径再加一个供应链环节。
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { timeout: 120000, windowsHide: true });
  if (r.error) throw new Error(`解压失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`解压失败（tar 退出码 ${r.status}）：${String(r.stderr || '').slice(0, 200)}`);
}

/** 解压后逐条核对：不许越界、不许超量。 */
function auditExtracted(root) {
  const rootReal = fs.realpathSync(root);
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`扩展包里不允许符号链接：${p}`);
      if (st.isDirectory()) { stack.push(p); continue; }
      const real = fs.realpathSync(p);
      if (!real.startsWith(rootReal + path.sep) && real !== rootReal) {
        throw new Error(`扩展包路径越界：${p}`);
      }
      files++;
      bytes += st.size;
      if (files > MAX_FILES) throw new Error(`文件数超过 ${MAX_FILES} 上限`);
      if (bytes > MAX_TOTAL_BYTES) throw new Error('解压后体积超过上限');
    }
  }
  return { files, bytes };
}

/** 找到包根：允许 zip 里套一层目录（GitHub 自动打包就是这样）。 */
function findRoot(dir) {
  if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 1) {
    const inner = path.join(dir, entries[0].name);
    if (fs.existsSync(path.join(inner, 'manifest.json'))) return inner;
  }
  throw new Error('扩展包里找不到 manifest.json');
}

/**
 * 下载并安装一个远端扩展。
 * meta 来自索引条目：{ id, version, download: { url, sha256, size } }
 */
export async function installRemote(id, meta) {
  const dl = meta?.download;
  if (!dl?.url) throw new Error('索引里没有这个扩展的下载地址');
  if (!dl.sha256) throw new Error('索引里缺少 sha256，拒绝安装（无法校验完整性）');

  const url = assertSafeUrl(dl.url).toString();
  const buf = await get(url, { timeout: 60000, maxBytes: MAX_PACKAGE_BYTES });

  const actual = sha256(buf);
  if (actual !== String(dl.sha256).toLowerCase()) {
    throw new Error(`校验失败：sha256 不符（期望 ${String(dl.sha256).slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `synapse-ext-${id}-`));
  const zipPath = path.join(work, 'pkg.zip');
  const unpackDir = path.join(work, 'unpack');
  try {
    fs.writeFileSync(zipPath, buf);
    unzipTo(zipPath, unpackDir);
    auditExtracted(unpackDir);
    const root = findRoot(unpackDir);

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    if (manifest.id !== id) throw new Error(`manifest.id（${manifest.id}）与索引 id（${id}）不一致`);

    const target = path.join(EXT_DIR, id);
    // 先删旧的再放新的：半覆盖会留下上一个版本的文件，行为难预测。
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(root, target, { recursive: true });

    return { dir: target, manifest, bytes: buf.length, sha256: actual };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** 把一份索引整理成 UI 能直接用的形状。 */
export function summarize(index, state) {
  return (index?.packages || []).map((p) => ({
    id: p.id,
    name: p.name || p.id,
    desc: p.desc || '',
    version: p.version || '',
    author: p.author || '',
    size: p.download?.size ? Math.round(p.download.size / 1024) : 0,
    tags: Array.isArray(p.tags) ? p.tags : [],
    installed: Boolean(state?.installed?.[p.id]),
    installedVersion: state?.installed?.[p.id]?.version || '',
    source: p.download?.url ? 'remote' : 'builtin'
  }));
}
