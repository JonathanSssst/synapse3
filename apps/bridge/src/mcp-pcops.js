// 电脑助手 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
// 只把请求转发给本机桥接的 /api/pc-ops；真正的权限校验、动作白名单与审计在桥接里：
// 只允许主人私聊（private:ownerQQ）+ 有效 agent token，群聊/他人一律拒绝。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}
function consoleToken() {
  try {
    const c = String(readConfig().consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(c)) return c;
  } catch {}
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

async function pc(action, params, key, token, timeoutMs = 30000) {
  const cfg = readConfig();
  const port = Number(cfg.consolePort) || 3100;
  const headers = { 'content-type': 'application/json', 'x-agent-call': '1' };
  if (token) headers['x-agent-token'] = token;
  const ct = consoleToken();
  if (ct) headers['x-console-token'] = ct;
  const res = await fetch(`http://127.0.0.1:${port}/api/pc-ops`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ key, token, action, params }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) throw new Error(body?.error || `桥接 HTTP ${res.status}`);
  return body.result;
}

const server = new McpServer({ name: 'pcops', version: '0.1.0' });

server.tool(
  'qq_pc_status',
  '查看主人这台电脑的状态（CPU/内存/磁盘/电池/开机时长）。只允许主人私聊使用。',
  {
    key: z.string().describe('会话 key（必须是 private:<主人QQ>）'),
    token: z.string().describe('会话令牌')
  },
  async ({ key, token }) => {
    try {
      const r = await pc('status', {}, key, token);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `电脑状态查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_pc_balance',
  '查询 DeepSeek 账户余额（元）。只允许主人私聊使用。',
  {
    key: z.string().describe('会话 key（必须是 private:<主人QQ>）'),
    token: z.string().describe('会话令牌')
  },
  async ({ key, token }) => {
    try {
      const r = await pc('balance', {}, key, token);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `余额查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_pc_open_app',
  '打开电脑上的白名单应用或网站（chrome/edge/vscode/qq/hmcl/minecraft/notepad/calc/explorer/bilibili/youtube/github）。只允许主人私聊使用。',
  {
    key: z.string().describe('会话 key（必须是 private:<主人QQ>）'),
    token: z.string().describe('会话令牌'),
    name: z.string().describe('应用名或网站名')
  },
  async ({ key, token, name }) => {
    try {
      const r = await pc('open_app', { name }, key, token);
      return { content: [{ type: 'text', text: `已打开：${JSON.stringify(r)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `打开应用失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_pc_volume',
  '调整系统音量（op=up/down/mute，times=按键次数）。只允许主人私聊使用。',
  {
    key: z.string().describe('会话 key（必须是 private:<主人QQ>）'),
    token: z.string().describe('会话令牌'),
    op: z.string().optional().describe('up / down / mute，默认 up'),
    times: z.number().optional().describe('按几次，1~20，默认 1')
  },
  async ({ key, token, op, times }) => {
    try {
      const r = await pc('volume', { op: op ?? 'up', times: times ?? 1 }, key, token);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `调整音量失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_pc_screenshot',
  '给电脑屏幕截一张图并返回图像（只读视觉，不操作电脑）。只允许主人私聊使用。',
  {
    key: z.string().describe('会话 key（必须是 private:<主人QQ>）'),
    token: z.string().describe('会话令牌')
  },
  async ({ key, token }) => {
    try {
      const r = await pc('screenshot', {}, key, token);
      if (!r?.data || !r?.mimeType) throw new Error('桥接没有返回图片数据');
      return {
        content: [
          { type: 'text', text: `已截屏（${Math.round((r.bytes || 0) / 1024)} KB）` },
          { type: 'image', mimeType: r.mimeType, data: r.data }
        ]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `截屏失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_pc_camera',
  '用电脑摄像头拍一张照片并返回图像（看看电脑前有没有人）。只允许主人私聊使用；会先列出可用摄像头。',
  {
    key: z.string().describe('会话 key（必须是 private:<主人QQ>）'),
    token: z.string().describe('会话令牌'),
    device: z.string().optional().describe('摄像头名称（可选，不传用第一个）')
  },
  async ({ key, token, device }) => {
    try {
      const r = await pc('camera', { device: device ?? '' }, key, token, 45000);
      if (!r?.data || !r?.mimeType) throw new Error('桥接没有返回照片');
      return {
        content: [
          { type: 'text', text: `已拍照（摄像头：${r.device || '默认'}，${Math.round((r.bytes || 0) / 1024)} KB）` },
          { type: 'image', mimeType: r.mimeType, data: r.data }
        ]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `拍照失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_pc_search_files',
  '在主人电脑上按文件名找文件（安装包、文档、压缩包等），返回路径/大小/修改时间。只允许主人私聊使用；范围限制在 E:/D:/下载/桌面/文档。',
  {
    key: z.string().describe('会话 key（必须是 private:<主人QQ>）'),
    token: z.string().describe('会话令牌'),
    query: z.string().optional().describe('文件名关键词（可空＝只按扩展名找）'),
    root: z.string().optional().describe('搜索根目录（可空，默认 E:）'),
    exts: z.array(z.string()).optional().describe('扩展名列表，默认 exe/msi/zip/7z/rar'),
    limit: z.number().optional().describe('最多返回几条，默认 30，最大 50')
  },
  async ({ key, token, query, root, exts, limit }) => {
    try {
      const r = await pc('search_files', { query: query ?? '', root: root ?? '', exts: exts ?? [], limit: limit ?? 30 }, key, token, 90000);
      const files = Array.isArray(r?.files) ? r.files : [];
      const lines = [`搜索根目录：${r?.root ?? ''}  关键词：${r?.query || '(无)'}  扩展名：${(r?.exts || []).join(' ')}`];
      lines.push(`找到 ${files.length} 个文件：`);
      for (const f of files) lines.push(`- ${f.path}（${f.sizeMB} MB，${String(f.mtime || '').slice(0, 19)}）`);
      if (!files.length) lines.push('（没有匹配的文件）');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `找文件失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
