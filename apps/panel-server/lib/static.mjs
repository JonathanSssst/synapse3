// Synapse 3 面板后端 · 静态资源（Vue 构建产物 /ui）
import fs from 'node:fs';
import path from 'node:path';
import { UI_DIST, sendText, versionInfo } from './core.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function placeholderHtml(reason) {
  const v = versionInfo();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Synapse 3 · ${v.version}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{height:100%;margin:0;background:#0a0e15;color:#e8eef7;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;display:grid;place-items:center}
  .box{max-width:640px;padding:32px 36px;border:1px solid #243042;border-radius:16px;background:#111722}
  h1{font-size:20px;margin:0 0 8px;color:#38d6bd}p{color:#8b9ab0;margin:6px 0}code{background:#16202d;padding:2px 6px;border-radius:6px;color:#ffb454}
  a{color:#38d6bd}
</style></head><body><div class="box">
<h1>Synapse 3 面板 · 前端未构建</h1>
<p>后端已就绪（${v.name} ${v.version}），但没有找到 <code>${UI_DIST.replace(/&/g, '&amp;').replace(/</g, '&lt;')}\\index.html</code>。</p>
<p>${String(reason || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>
<p>构建：<code>cd E:\\BOT\\panel-ui &amp;&amp; npm run build</code>，然后刷新本页。</p>
<p>接口自检：<a href="/api/health">/api/health</a> · <a href="/api/overview">/api/overview</a> · <a href="/api/records/tool_call">/api/records/tool_call</a></p>
</div></body></html>`;
}

export function uiBuilt() {
  try { return fs.existsSync(path.join(UI_DIST, 'index.html')); } catch { return false; }
}

export function serveStatic(req, res, url) {
  const p = decodeURIComponent(url.pathname);
  if (p === '/') {
    res.writeHead(302, { location: '/ui/' });
    res.end();
    return true;
  }
  if (p === '/ui') {
    res.writeHead(302, { location: '/ui/' });
    res.end();
    return true;
  }
  if (p !== '/ui' && !p.startsWith('/ui/')) return false;

  let rel = p.slice('/ui/'.length);
  if (!rel) rel = 'index.html';

  if (!uiBuilt()) {
    sendText(res, 200, placeholderHtml('后端已启动，前端构建产物缺失。'), 'text/html; charset=utf-8');
    return true;
  }

  const distRoot = path.resolve(UI_DIST);
  const file = path.resolve(distRoot, rel);
  if (file !== distRoot && !file.startsWith(distRoot + path.sep)) {
    sendText(res, 403, 'forbidden');
    return true;
  }

  let target = file;
  let stat = null;
  try { stat = fs.statSync(target); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    // SPA fallback：/ui/assets/ 之外的缺失路径都交给 index.html
    // （详情页 id 可能带扩展名，如 gen-*.jpg，不能只按“无扩展名”判断）
    if (!rel.startsWith('assets/') && !rel.startsWith('assets\\')) {
      target = path.join(distRoot, 'index.html');
      try { stat = fs.statSync(target); } catch { stat = null; }
    }
  }
  if (!stat || !stat.isFile()) {
    sendText(res, 404, 'not found');
    return true;
  }
  const isIndex = path.basename(target) === 'index.html';
  const cache = isIndex ? 'no-store' : 'public, max-age=31536000, immutable';
  res.writeHead(200, {
    'content-type': mimeOf(target),
    'content-length': stat.size,
    'cache-control': cache
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(target).pipe(res);
  return true;
}
