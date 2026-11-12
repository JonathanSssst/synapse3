// resolve-packages.cjs · 定位并加载 packages/ 下的 ESM 包
//
// 为什么需要单独一个文件：**源码模式与打包模式的目录层级不同**。
//
//   源码：apps/hub/services.cjs              → ../../packages          = <repo>/packages
//   打包：resources/app.asar/services.cjs    → ../../packages          = win-unpacked/packages（不存在！）
//         （asar 内 __dirname 是 resources/app.asar，往上两级已经出了 resources）
//   实际：extraResources 把 packages 放在 resources/packages
//
// 桥接和面板不受影响：它们是以普通文件放在 resources/app/ 下的（不打进 asar），
// `../../../packages` 正好指向 resources/packages。
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

function packagesDir() {
  const candidates = [
    process.env.SYNAPSE_PACKAGES,
    process.resourcesPath ? path.join(process.resourcesPath, 'packages') : null,
    path.resolve(__dirname, '..', '..', 'packages'),
    path.resolve(__dirname, '..', 'packages'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'paths', 'index.mjs'))) return dir;
  }
  return candidates[candidates.length - 1];
}

/** 加载 packages/paths（ESM，必须用动态 import + file URL）。 */
function loadPaths() {
  return import(pathToFileURL(path.join(packagesDir(), 'paths', 'index.mjs')).href);
}

/**
 * 内置 node.exe 的位置。
 * 源码/载荷：<repo>/runtime 或 dist/hub-payload/runtime
 * 打包后：resources/runtime（同样是 asar 外，层级与 packages 一致）
 */
function runtimeNode() {
  const candidates = [
    process.env.SYNAPSE_NODE,
    process.resourcesPath ? path.join(process.resourcesPath, 'runtime', 'node.exe') : null,
    path.resolve(__dirname, '..', '..', 'runtime', 'node.exe'),
    path.resolve(__dirname, '..', '..', 'dist', 'hub-payload', 'runtime', 'node.exe'),
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

module.exports = { packagesDir, loadPaths, runtimeNode };
