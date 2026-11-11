// 把「{{VIDEO_CALL}}」标记替换成一次性视频通话链接。
// 这是她自己的"给出视频链接"能力：她像平常一样用 qq_send_message / qq_send_private_message 发消息，
// 消息里带标记时由桥接在发送前换成真实链接；她可以自己决定这次给不给、怎么说。
// 不新增 MCP 工具（DSH 启动时才加载工具表，新增工具需要重启 DSH），用标记 + 桥接替换即可。
import fs from 'node:fs';

export const VIDEO_CALL_MARKER = '{{VIDEO_CALL}}';
const DEFAULT_URL = 'http://127.0.0.1:3130';
const DEFAULT_RATE_LIMIT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 4_000;

let lastLinkAt = 0;

function consoleToken() {
  try {
    return fs.readFileSync(new URL('../state/console-token', import.meta.url), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 替换文本里的视频通话标记。
 * @returns {{ text: string, used: boolean, url?: string, callId?: string, error?: string }}
 */
export async function expandVideoCallMarker(text, { cfg, key, log } = {}) {
  const s = String(text ?? '');
  if (!s.includes(VIDEO_CALL_MARKER)) return { text: s, used: false };

  const fill = (replacement) => s.split(VIDEO_CALL_MARKER).join(replacement);
  const ownerKey = `private:${String(cfg?.ownerQQ ?? '')}`;
  const vc = cfg?.videoCall ?? {};

  if (vc.enabled === false) {
    return { text: fill('（视频通话功能没开）'), used: true, error: 'videoCall.disabled' };
  }
  if (key !== ownerKey) {
    return { text: fill('（视频通话链接只能在主人私聊里发）'), used: true, error: 'not-owner-private' };
  }

  const now = Date.now();
  const limit = Number(vc.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS);
  if (now - lastLinkAt < limit) {
    const waitSec = Math.ceil((limit - (now - lastLinkAt)) / 1000);
    log?.(`[video-call] 标记命中但频控中（还需 ${waitSec}s）`);
    return { text: fill(`（刚发过视频链接啦，等 ${waitSec} 秒再要嘛）`), used: true, error: 'rate-limited' };
  }

  const base = String(vc.url || DEFAULT_URL).replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  const token = consoleToken();
  if (token) headers['x-console-token'] = token;

  try {
    const res = await fetch(`${base}/api/session/new`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ownerQQ: cfg?.ownerQQ ?? undefined }),
      signal: AbortSignal.timeout(Number(vc.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.url) throw new Error(`HTTP ${res.status}${body?.error ? ' ' + body.error : ''}`);
    lastLinkAt = now;
    const onlyMarker = s.trim() === VIDEO_CALL_MARKER;
    const filled = onlyMarker
      ? `点这个来见我吧～\n${body.url}`
      : s.split(VIDEO_CALL_MARKER).join(body.url);
    log?.(`[video-call] 已生成通话链接（${body.callId || 'call'}）并替换标记`);
    return { text: filled, used: true, url: body.url, callId: body.callId };
  } catch (error) {
    lastLinkAt = now; // 失败也计入频控，避免连续重试刷屏
    log?.(`[video-call] 生成通话链接失败：${error?.message ?? error}`);
    return { text: fill('（视频服务没起来，等会儿再试）'), used: true, error: String(error?.message ?? error) };
  }
}

export function _resetVideoCallLinkForTest() {
  lastLinkAt = 0;
}
