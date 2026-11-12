// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import { HOME as B, BRIDGE_ROOT, STATE_DIR as GLOBAL_STATE, PERSONAS_DIR as PATHS_PERSONAS, FEATURE_DOC, PET_DATA, TMP_DIR, GEN_IMAGES_DIR, REFS_DIR as PATHS_REFS, BILI_DIR, DOUYIN_DIR, BOOKS_DIR, SURF_DIR, STUDY_DIR, CONFIG as CONFIG_DIR } from '../../../packages/paths/index.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './sensitive.js';
import { serializeModelData } from './qq-model-view.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  //
  // 必须与桥接的校验口径**完全一致**（bridge.js 的 startConsoleServer：长度 16~128、
  // 只允许 [A-Za-z0-9_-]，不合法就忽略并回退 state/console-token）。否则用户手填一个
  // 短令牌时桥接会正常运行，而 MCP 拿着这个桥接根本不认的值去请求 —— 每个工具都 401，
  // 且错误信息里看不出原因是"config.json 里的令牌格式不合法"。
  try {
    const c = getConfig();
    const configured = String(c.consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 把桥接返回的 `error` 变成可读文本。
 *
 * 为什么必须有：桥接个别分支会回一个**对象**（例如 `{code, message}`），直接
 * `new Error(obj)` 会把它 String 成 "[object Object]" —— 模型和运维都读不到任何信息。
 * r3 的已知未修项里就记着 `qq_wait_for_messages` 出现过 `error: "\"Error: [object Object]\""`。
 */
function errorText(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      if (text && text !== '{}') return text.slice(0, 500);
    } catch {}
    const message = value.message ?? value.msg ?? value.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const headers = agentHeaders(rest.headers);
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(errorText(body?.error, `桥接 API HTTP ${res.status}`));
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(errorText(body.error, '桥接 API 返回 ok:false（未说明原因）'));
  }
  return body;
}

/**
 * 桥接 API 请求头（含控制台令牌、x-agent-call 与调用方附加头）。
 * 拆出来是为了长轮询通道复用同一套鉴权，避免两条通路口径漂移。
 */
function agentHeaders(extra = {}) {
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(extra ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  return headers;
}

/**
 * 长轮询专用 POST（`node:http`，不经过 undici）。
 *
 * 为什么必须单独一条：Node 的全局 `fetch` 是 undici，自带 300 秒 `headersTimeout`。
 * 而 `qq_wait_for_messages` 的常规用法就是 `timeoutMs=300000` 的沉睡前观察 ——
 * 客户端会在第 301 秒以 `fetch failed / Headers Timeout Error` 断掉，桥接侧的
 * 长轮询却还在跑满自己的预算：AI 拿不到结果只能重试，而 `activeWaits` 仍占着会话
 * （重新等待被 429），于是空转烧 token（见 issue #24）。`node:http` 没有默认响应超时，
 * 超时完全由这里的计时器按调用方预算控制。
 */
function agentApiLongPoll(path, init = {}) {
  const timeoutMs = Math.max(1000, Number(init.timeoutMs) || 15000);
  const url = new URL(`${agentApiBase()}${path}`);
  const body = init.body == null ? '' : String(init.body);
  const headers = agentHeaders(init.headers);
  headers['content-length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let res;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      res?.destroy();
    }, timeoutMs);
    timer.unref?.();
    try {
      req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: init.method || 'GET',
        headers,
        timeout: 0
      }, (response) => {
        res = response;
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          // 桥接的 wait 响应本来就是小 JSON；超过 4MB 说明对端异常，别把内存吃光。
          if (size > 4 * 1024 * 1024) {
            finish(new Error('等待响应体过大，已中止'));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(new Error('等待响应中断')));
        response.on('close', () => { if (!response.complete) finish(new Error('等待响应中断')); });
        response.on('end', () => {
          if (settled) return;
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            finish(new Error(errorText(parsed?.error, `桥接 API HTTP ${status}`)));
            return;
          }
          if (parsed && typeof parsed === 'object' && parsed.ok === false) {
            finish(new Error(errorText(parsed.error, '桥接 API 返回 ok:false（未说明原因）')));
            return;
          }
          finish(null, parsed);
        });
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的 v2 读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 reserved2 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'reserved2'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在二代仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.2.0-r4' });

// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_reply
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const TOOL_CONFIG_FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_get_unread_messages: 'getUnread',
  qq_get_recent_messages: 'getRecent',
  qq_social_state: 'socialState',
  qq_mark_read: 'markRead',
  qq_set_wake_config: 'setWakeConfig',
  qq_send_burst: 'sendBurst',
  qq_send_message: 'sendMessage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_my_recent_messages: 'getMyRecent',
  qq_get_message_detail: 'getMessageDetail',
  qq_get_active_members: 'getActiveMembers',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  qq_slang_query: 'slangQuery',
  qq_brain_remember: 'brainMemory',
  qq_eat: 'vitals',
  qq_brain_recall: 'brainMemory',
  qq_brain_list: 'brainMemory',
  qq_brain_forget: 'brainMemory',
  qq_brain_pin: 'brainMemory',
  qq_brain_share: 'brainMemory',
  qq_diary_read: 'diaryRead',
  qq_slang_submit: 'slangSubmit',
  qq_send_voice: 'sendVoice',
  qq_list_voices: 'sendVoice',
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_get_message_images: 'getImages',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_collect_sticker: 'collectSticker',
  qq_get_self_image: 'getSelfImage',
  qq_sticker_note: 'stickerNote',
  qq_set_sticker_remark: 'setStickerRemark',
};
const disabledTools = [];
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const flag = TOOL_CONFIG_FLAGS[name];
    if (flag && cfg.socialV2?.tools?.[flag] === false) {
      disabledTools.push(`${name}(${flag})`);
      return undefined;
    }
    return registerTool(name, ...rest);
  };
}

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_members',
  '列出指定群的成员列表（只读）：QQ 号、昵称、群名片。',
  { groupId: z.union([z.number(), z.string()]).describe('群号') },
  async ({ groupId }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。二代模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。reserved2 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。此用途绝不代替沉睡前观察。等对方继续说、等回复或睡前观察：用默认 purpose="messages"；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs，单传 quietMs 不会缩短总等待。静默下限由后台配置，默认 10000ms。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。决定潜水/收尾时才用默认用途加 timeoutMs=300000 完成沉睡前观察，不能把 5 分钟观察放在首答之前；短等待不能代替。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true，读后不需参与可收尾，参与回复则下次收尾重新观察。preSleepWaitRemainingMs 仅供准备收尾时参考。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      // 必须走长轮询通道：全局 fetch（undici）有 300s headersTimeout，
      // 而沉睡前观察的预算就是 300s（见 agentApiLongPoll 的说明）。
      const data = await agentApiLongPoll('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_tts_say',
    '把一句话用她自己的人设音色（Breeze TTS / 本机 SAPI 兜底）合成语音并直接发到聊天里。想“用声音说话”时用；语音是强表达，别滥用；文本≤120字。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌'),
      text: z.string().describe('要说的内容（≤120 字）'),
      rate: z.number().optional().describe('语速 -10~10，默认 0（负数更慢）')
    },
    async ({ key, token, text, rate }) => {
      const msg = String(text ?? '').trim();
      if (!msg) return toolFail('text 不能为空');
      if (msg.length > 120) return toolFail('语音文本最多 120 字');
      if (SENSITIVE_RE.test(msg)) return toolFail('内容含敏感信息，已阻止');
      const audioDir = `${BRIDGE_ROOT}/audio`;
      fs.mkdirSync(audioDir, { recursive: true });
      const stamp = Date.now();
      const txtFile = path.join(audioDir, `tts-${stamp}.txt`);
      const wavFile = path.join(audioDir, `tts-${stamp}.wav`);
      let provider = 'sapi';
      let synthError = '';
      const bcfg = breezeCfg();
      if (bcfg.enabled !== false && breezeKey()) {
        try {
          const out = await breezeSynthesize(msg, key, rate);
          fs.writeFileSync(wavFile, out.buf);
          provider = 'breeze';
          recordTts('breeze', true, out.chars, out.credits, { key, voiceId: out.voiceId });
          appendChatAudit({ action: 'ttsBreeze', key, ok: true, text: msg, credits: out.credits, voiceId: out.voiceId });
        } catch (error) {
          synthError = String(error?.message ?? error);
          recordTts('breeze', false, billableChars(msg), 0, { key, error: synthError.slice(0, 160) });
        }
      }
      if (provider !== 'breeze') {
        fs.writeFileSync(txtFile, msg, 'utf8');
        const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $s.SelectVoice('Microsoft Huihui Desktop') } catch {}; $s.Rate = ${Number(rate) || 0}; $s.SetOutputToWaveFile('${wavFile.replace(/'/g, "''")}'); $s.Speak([IO.File]::ReadAllText('${txtFile.replace(/'/g, "''")}', [Text.Encoding]::UTF8)); $s.Dispose()`;
        const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000, windowsHide: true });
        try { fs.unlinkSync(txtFile); } catch {}
        if (r.status !== 0 || !fs.existsSync(wavFile) || fs.statSync(wavFile).size < 1000) {
          return toolFail(`语音合成失败：${synthError || String(r.stderr || '').slice(0, 160)}`);
        }
      }
      const name = path.basename(wavFile);
      try {
        await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, voice: name, label: 'TTS', verify: true, token }),
          timeoutMs: 300000
        });
        appendChatAudit({ action: 'ttsSay', key, ok: true, text: msg, file: name });
        try {
          for (const f of fs.readdirSync(audioDir)) {
            const m = f.match(/^tts-(\d+)\.wav$/);
            if (m && Date.now() - Number(m[1]) > 24 * 3600 * 1000) fs.unlinkSync(path.join(audioDir, f));
          }
        } catch {}
        return toolText(`已发语音（${provider === 'breeze' ? 'Breeze 音色' : '本机 SAPI'}，${Math.round(fs.statSync(wavFile).size / 1024)} KB）：${msg.slice(0, 40)}`);
      } catch (error) {
        appendChatAudit({ action: 'ttsSay', key, ok: false, error: String(error?.message ?? error) });
        return toolFail(`发送语音失败：${error?.message ?? error}`);
      }
    }
  );

  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音（把语音库里准备好的音频当语音条发出去）。voice 传 qq_list_voices 返回的 name（文件名，可带子目录），也可以直接传语音库里的文件名（不带扩展名也能匹配）。注意：① 只能发语音库（qq-bridge/audio/）里的文件，不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用，闲聊里偶尔发一条即可；④ 返回的 verified=true 表示已经用 get_msg 回读到这条消息的 record 段（语音确实落地了）—— 只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      voice: z.string().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, label, verify, readback }) => {
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: String(voice),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 文件与 QQ 空间工具（2026-10-31 新增） ──────────────────────────────────
// 文件读取只做只读：拿消息里的文件段 → 取下载链接 → 下载 → 文本/图片回给模型。
// 说说发布是**公开动作**：必须 confirm=true 且带会话令牌，写审计日志；不放进自动流程。
const FILE_MAX_BYTES = 8 * 1024 * 1024;
const FILE_MAX_TEXT = 200 * 1024;
const QZONE_MAX_CHARS = 300;

function toolFail(text) {
  return { content: [{ type: 'text', text }], isError: true };
}
function toolText(text) {
  return { content: [{ type: 'text', text }] };
}

// ── Breeze TTS（2026-11-07 接入）──────────────────────────────────────────
const BREEZE_KEY_FILE = path.join(ROOT, 'state', 'breeze-tts.json');
const TTS_USAGE_FILE = path.join(ROOT, 'state', 'tts-usage.json');

function readJsonLoose(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; }
}
function breezeKey() {
  const d = readJsonLoose(BREEZE_KEY_FILE, {});
  return String(d.apiKey || '').trim();
}
function breezeCfg() {
  const c = getConfig();
  return c.socialV2?.voice?.breeze || {};
}
function billableChars(text) {
  let n = 0;
  for (const ch of Array.from(String(text || ''))) {
    n += /[\u3400-\u9fff\uf900-\ufaff]/.test(ch) ? 2 : 1;
  }
  return n;
}
function todayKeyCN() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function ttsUsage() {
  const d = readJsonLoose(TTS_USAGE_FILE, {});
  const day = todayKeyCN();
  if (d.day !== day) return { day, chars: 0, credits: 0, calls: 0, failed: 0 };
  return { day, chars: Number(d.chars) || 0, credits: Number(d.credits) || 0, calls: Number(d.calls) || 0, failed: Number(d.failed) || 0 };
}
function recordTts(provider, ok, chars = 0, credits = 0, extra = {}) {
  try {
    const u = ttsUsage();
    u.chars += chars;
    u.credits += credits;
    if (ok) u.calls += 1; else u.failed += 1;
    u.provider = provider;
    u.lastAt = new Date().toISOString();
    u.last = { ok, chars, credits, ...extra };
    fs.mkdirSync(path.dirname(TTS_USAGE_FILE), { recursive: true });
    fs.writeFileSync(TTS_USAGE_FILE, JSON.stringify(u, null, 2), 'utf8');
    try {
      fs.appendFileSync(path.join(ROOT, 'state', 'tts-history.jsonl'),
        JSON.stringify({ at: u.lastAt, day: u.day, provider, ok, chars, credits, ...extra }) + '\n', 'utf8');
    } catch {}
    return u;
  } catch { return null; }
}
function roleVoiceOverride(key) {
  try {
    const rm = readJsonLoose(path.join(ROOT, 'state', 'role-map.json'), {});
    const role = (rm.conversations && rm.conversations[key]) || rm.default || '';
    if (!role) return {};
    const meta = readJsonLoose(path.join(ROOT, 'personas', role, 'meta.json'), {});
    return { role, voiceId: meta.voiceId, instructions: meta.voiceInstructions, speed: meta.voiceSpeed };
  } catch { return {}; }
}
async function breezeSynthesize(text, key, rate = 0) {
  const cfg = breezeCfg();
  const apiKey = breezeKey();
  if (!apiKey) throw new Error('没有配置 Breeze API Key（state/breeze-tts.json）');
  const chars = billableChars(text);
  const credits = Math.ceil(chars / 10);
  const limit = Number(cfg.dailyCreditLimit) || 300;
  const u = ttsUsage();
  if (u.credits + credits > limit) throw new Error(`今日语音额度已用完（${u.credits}/${limit} credits）`);
  const ov = roleVoiceOverride(key);
  const voiceId = String(ov.voiceId || cfg.voiceId || 'voc_u3nxkd5578wc');
  const speedBase = Number(ov.speed || cfg.speed || 1);
  const speed = Math.min(2, Math.max(0.5, speedBase * (1 + (Number(rate) || 0) / 20)));
  const body = {
    text: String(text),
    language_code: 'zh',
    voice_settings: { speed, volume: Number(cfg.volume) || 1 }
  };
  if (cfg.modelId) body.model_id = String(cfg.modelId);
  const instructions = String(ov.instructions || cfg.instructions || '').trim();
  if (instructions) body.instructions = instructions;
  const url = `https://api.breeze.blue/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=wav_24000&delivery=sync`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 90000)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Breeze ${res.status}: ${txt.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error('Breeze 返回音频过小');
  return { buf, chars, credits, voiceId, speed };
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}
function stripHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
function guessMimeByName(name) {
  const ext = String(name ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    txt: 'text/plain', md: 'text/plain', log: 'text/plain', json: 'text/plain', csv: 'text/plain', xml: 'text/plain',
    js: 'text/plain', ts: 'text/plain', py: 'text/plain', java: 'text/plain', c: 'text/plain', cpp: 'text/plain',
    html: 'text/plain', css: 'text/plain', yml: 'text/plain', yaml: 'text/plain', ini: 'text/plain', conf: 'text/plain',
    pdf: 'application/pdf', zip: 'application/zip', rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mp3: 'audio/mpeg', mp4: 'video/mp4', wav: 'audio/wav'
  };
  return map[ext] ?? 'application/octet-stream';
}
async function fetchFileBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len && len > FILE_MAX_BYTES) throw new Error(`文件过大（${formatBytes(len)}），不读取`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > FILE_MAX_BYTES) throw new Error(`文件过大（${formatBytes(buf.length)}），不读取`);
  return buf;
}
function decodeTextBuffer(buf) {
  if (!buf?.length) return '';
  // 二进制判定：NUL 字节比例过高就当作二进制
  let nul = 0;
  const probe = Math.min(buf.length, 4096);
  for (let i = 0; i < probe; i += 1) if (buf[i] === 0) nul += 1;
  if (nul / probe > 0.1) return null;
  for (const enc of ['utf-8', 'gb18030']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(buf);
    } catch {}
  }
  try {
    return new TextDecoder('utf-8').decode(buf);
  } catch {
    return null;
  }
}
function allowedSessionKey(key) {
  const access = getAccess();
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return { ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' };
  const hit = m[1] === 'group' ? access.allowGroups.includes(m[2]) : access.allowPrivate.includes(m[2]);
  if (!hit && !access.allowAllWhenEmpty) return { ok: false, error: `会话 ${key} 不在白名单内` };
  return { ok: true, kind: m[1], id: Number(m[2]) };
}

// 群文件列表（只读）
server.tool(
  'qq_list_group_files',
  '列出群文件（只读）。可先看根目录，再用返回的 folder_id 继续列出某个文件夹。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号'),
    folderId: z.string().optional().describe('文件夹 id（可选；不传=根目录）')
  },
  async ({ groupId, folderId }) => {
    try {
      const access = getAccess();
      if (!access.allowGroups.includes(String(groupId)) && !access.allowAllWhenEmpty) {
        return toolFail(`群 ${groupId} 不在白名单内`);
      }
      const params = { group_id: Number(groupId) };
      const action = folderId ? 'get_group_files_by_folder' : 'get_group_root_files';
      if (folderId) params.folder_id = String(folderId);
      const data = await onebot(action, params);
      const folders = (data?.folders ?? []).map((f) => ({ folder_id: f.folder_id ?? f.id, name: f.folder_name ?? f.name, count: f.total_file_count ?? f.file_count }));
      const files = (data?.files ?? []).map((f) => ({
        file_id: f.file_id ?? f.id, name: f.file_name ?? f.name, size: formatBytes(f.file_size ?? f.size),
        uploader: f.uploader_name ?? f.uploader
      }));
      return toolText(serializeModelData({ groupId, folderId: folderId ?? null, folders, files, fileCount: files.length }));
    } catch (error) {
      return toolFail(`列群文件失败：${error?.message ?? error}`);
    }
  }
);

// 读取消息里的文件（私聊/群；只读）
server.tool(
  'qq_get_message_files',
  '读取指定 QQ 消息里附带的文件：文本文件回正文，图片文件以图像返回，其他类型回元数据。当消息文本出现 [文件名] 时调用。',
  {
    key: z.string().describe('会话 key，group:群号 或 private:QQ号'),
    messageId: z.union([z.number(), z.string()]).describe('消息 id（QQ message id，可为负数）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 下必填；本工具只读，不校验令牌）')
  },
  async ({ key, messageId }) => {
    try {
      const allowed = allowedSessionKey(key);
      if (!allowed.ok) return toolFail(allowed.error);
      const data = await onebot('get_msg', { message_id: String(messageId) });
      const segments = Array.isArray(data?.message) ? data.message : [];
      const fileSegs = segments.filter((s) => s && (s.type === 'file' || s.type === 'flash_file') && s.data && typeof s.data === 'object');
      if (!fileSegs.length) return toolText(`消息 ${messageId} 里没有文件段（可能只是图片/文本；图片请用 qq_get_message_images）`);
      const content = [];
      const lines = [`消息 ${messageId} 的附件（${fileSegs.length} 个）：`];
      for (let i = 0; i < fileSegs.length; i += 1) {
        const d = fileSegs[i].data ?? {};
        const fileId = String(d.file_id ?? d.fileId ?? d.id ?? '');
        const name = String(d.file_name ?? d.name ?? d.file ?? `文件${i + 1}`);
        const size = Number(d.file_size ?? d.size ?? 0);
        let url = String(d.url ?? '');
        lines.push(`- ${name}（${formatBytes(size)}）${fileId ? ` file_id=${fileId}` : ''}`);
        if (!url && fileId) {
          try {
            if (allowed.kind === 'group') {
              const r = await onebot('get_group_file_url', { group_id: allowed.id, file_id: fileId, busid: Number(d.busid) || 102 });
              url = String(r?.url ?? '');
            } else {
              const r = await onebot('get_private_file_url', { file_id: fileId });
              url = String(r?.url ?? '');
            }
          } catch (error) {
            lines.push(`  （取下载链接失败：${error?.message ?? error}）`);
          }
        }
        if (!url) {
          lines.push('  （没有可用的下载链接，可能已过期或该项是文件夹）');
          continue;
        }
        try {
          const buf = await fetchFileBuffer(url);
          const mime = guessMimeByName(name);
          if (mime.startsWith('image/')) {
            content.push({ type: 'image', mimeType: mime, data: buf.toString('base64') });
            lines.push('  （图片已附上，可以直接看）');
            continue;
          }
          const text = decodeTextBuffer(buf);
          if (text != null) {
            const clipped = text.length > FILE_MAX_TEXT ? `${text.slice(0, FILE_MAX_TEXT)}\n…（已截断）` : text;
            lines.push('  ── 正文开始 ──');
            lines.push(clipped);
            lines.push('  ── 正文结束 ──');
          } else {
            lines.push(`  （二进制文件 ${mime}，暂不解析内容）`);
          }
        } catch (error) {
          lines.push(`  （下载/读取失败：${error?.message ?? error}）`);
        }
      }
      content.unshift({ type: 'text', text: lines.join('\n') });
      return { content };
    } catch (error) {
      return toolFail(`读取消息文件失败：${error?.message ?? error}`);
    }
  }
);

// QQ 空间：好友动态（只读）
server.tool(
  'qq_qzone_feeds',
  '查看 QQ 好友动态（只读，按页返回；用于了解朋友最近发了什么）。',
  {
    pageNum: z.number().optional().describe('页码，从 1 开始，默认 1'),
    count: z.number().optional().describe('每页条数，默认 10')
  },
  async ({ pageNum, count }) => {
    try {
      const data = await onebot('get_qzone_feeds', { page_num: Math.max(1, Number(pageNum) || 1), count: Math.min(20, Math.max(1, Number(count) || 10)) });
      const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
      const list = feeds.filter((f) => Number(f.uin) > 0).map((f) => ({
        uin: f.uin, nickname: f.nickname,
        time: f.time ? new Date(Number(f.time) * 1000).toISOString() : null,
        text: stripHtml(f.html).slice(0, 600)
      }));
      return toolText(serializeModelData({ pageNum: pageNum ?? 1, feeds: list, note: data?.hasMore ? '还有更多页（pageNum+1）' : '' }));
    } catch (error) {
      return toolFail(`看好友动态失败：${error?.message ?? error}`);
    }
  }
);

// QQ 空间：自己的说说（只读）
server.tool(
  'qq_qzone_moments',
  '查看 QQ 空间里的说说（默认看自己的；给 targetUin 可看指定好友的）；只读。',
  {
    targetUin: z.union([z.number(), z.string()]).optional().describe('目标 QQ 号（可选，默认自己）'),
    pos: z.number().optional().describe('起始位置，默认 0'),
    num: z.number().optional().describe('条数，默认 10')
  },
  async ({ targetUin, pos, num }) => {
    try {
      const params = { pos: Math.max(0, Number(pos) || 0), num: Math.min(20, Math.max(1, Number(num) || 10)) };
      if (targetUin) params.target_uin = String(targetUin);
      const data = await onebot('get_qzone_msg_list', params);
      const list = (data?.msglist ?? []).map((m) => ({
        tid: m.tid ?? m.id, time: m.time ? new Date(Number(m.time) * 1000).toISOString() : null,
        content: String(m.content ?? '').slice(0, 600),
        commentNum: m.comment_num ?? null
      }));
      return toolText(serializeModelData({ total: data?.total ?? list.length, moments: list }));
    } catch (error) {
      return toolFail(`看说说失败：${error?.message ?? error}`);
    }
  }
);

// QQ 空间：发/删说说（公开动作，必须显式确认 + 审计）
function appendQzoneAudit(entry) {
  try {
    const dir = path.join(ROOT, 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'qzone-audit.log'), `${new Date().toISOString()} ${JSON.stringify(entry)}\n`, 'utf8');
  } catch {}
}
if (cfg.socialV2?.tools?.qzonePost !== false) {
  server.tool(
    'qq_qzone_publish',
    '发一条 QQ 空间说说（公开动作，会出现在空间里）。只能在主人明确要求、且内容已确认后调用：必须带 confirm=true。说完把结果告诉主人。',
    {
      content: z.string().describe('说说正文（1~300 字）'),
      images: z.array(z.string()).optional().describe('可选图片列表，支持 file:// http:// base64://'),
      confirm: z.boolean().describe('必须传 true，表示主人已明确要求发这条说说'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ content, images, confirm, token }) => {
      try {
        if (confirm !== true) return toolFail('发说说需要主人明确确认（confirm=true）');
        if (!token) return toolFail('缺少会话令牌，拒绝发布');
        const text = String(content ?? '').trim();
        if (!text) return toolFail('说说内容不能为空');
        if (text.length > QZONE_MAX_CHARS) return toolFail(`说说正文不能超过 ${QZONE_MAX_CHARS} 字`);
        if (SENSITIVE_RE.test(text)) return toolFail('内容含敏感信息（路径/凭据等），已阻止发布');
        const params = { content: text };
        if (Array.isArray(images) && images.length) params.images = images.map(String);
        const data = await onebot('send_qzone_msg', params);
        appendQzoneAudit({ action: 'send', content: text, images: params.images ?? [], ok: true, tid: data?.tid ?? null });
        return toolText(serializeModelData({ ok: true, tid: data?.tid ?? null, content: text }));
      } catch (error) {
        appendQzoneAudit({ action: 'send', content: String(content ?? '').slice(0, 300), ok: false, error: String(error?.message ?? error) });
        return toolFail(`发说说失败：${error?.message ?? error}`);
      }
    }
  );

  server.tool(
    'qq_qzone_delete',
    '删除一条 QQ 空间说说（需要 tid，来自 qq_qzone_moments）。主人明确要求时使用，必须带 confirm=true。',
    {
      tid: z.string().describe('说说 tid'),
      confirm: z.boolean().describe('必须传 true'),
      token: z.string().describe('会话令牌')
    },
    async ({ tid, confirm, token }) => {
      try {
        if (confirm !== true) return toolFail('删说说需要主人明确确认（confirm=true）');
        if (!token) return toolFail('缺少会话令牌，拒绝删除');
        const id = String(tid ?? '').trim();
        if (!id) return toolFail('tid 不能为空');
        await onebot('delete_qzone_msg', { tid: id });
        appendQzoneAudit({ action: 'delete', tid: id, ok: true });
        return toolText(`已删除说说 ${id}`);
      } catch (error) {
        appendQzoneAudit({ action: 'delete', tid: String(tid ?? ''), ok: false, error: String(error?.message ?? error) });
        return toolFail(`删说说失败：${error?.message ?? error}`);
      }
    }
  );
}

// QQ 空间：详情 / 楼中楼 / 点赞 / 转发（2026-11-07 SnowLuma 2.4.0）
async function qzoneDetailRaw(tid) {
  const id = String(tid ?? '').trim();
  if (!id) throw new Error('tid 不能为空');
  const feedData = await onebot('get_qzone_feed_detail', { tid: id });
  let msg = null;
  try { msg = await onebot('get_qzone_msg_detail', { tid: id }); } catch {}
  return { feed: feedData?.feed ?? null, detail: msg ?? null };
}
async function qzoneRawObjects(tid) {
  const id = String(tid ?? '').trim();
  if (!id) throw new Error('tid 不能为空');
  const data = await onebot('get_qzone_feed_detail', { tid: id });
  const feed = data?.feed ?? null;
  const comments = feed?.cell_comment?.comments ?? [];
  return { feed, comments };
}
function findRawComment(comments, commentId) {
  return (comments || []).find((c) => String(c.id) === String(commentId)) || null;
}
function findRawReply(comment, uin, time) {
  const list = comment?.replys || [];
  return list.find((r) => String(r?.user?.uin) === String(uin) && (!time || Number(r.time) === Number(time))) || null;
}
function qzoneCommentSummary(c) {
  return {
    commentId: String(c.comment_id ?? ''),
    uin: c.uin, name: c.name,
    time: c.time ? new Date(Number(c.time) * 1000).toISOString() : null,
    content: String(c.content ?? '').slice(0, 300),
    replies: (c.replies ?? []).map((r) => ({
      commentId: String(r.comment_id ?? ''),
      uin: r.uin, name: r.name,
      time: r.time ? new Date(Number(r.time) * 1000).toISOString() : null,
      content: String(r.content ?? '').slice(0, 300),
      parentCommentId: String(r.parent_comment_id ?? ''),
      parentCommentUin: r.parent_comment_uin
    }))
  };
}
server.tool(
  'qq_qzone_detail',
  '查看一条 QQ 空间说说的详情和全部评论（含楼中楼回复）。tid 来自 qq_qzone_moments / qq_qzone_feeds。',
  {
    tid: z.string().describe('说说 tid'),
    commentLimit: z.number().optional().describe('最多返回几条评论，默认 20')
  },
  async ({ tid, commentLimit }) => {
    try {
      const { detail } = await qzoneDetailRaw(tid);
      const comments = (detail?.comments ?? []).slice(0, Math.min(50, Math.max(1, Number(commentLimit) || 20)));
      return toolText(serializeModelData({
        tid: String(tid), content: String(detail?.content ?? '').slice(0, 600),
        commentNum: detail?.comment_num ?? comments.length,
        comments: comments.map(qzoneCommentSummary),
        note: '回复楼中楼用 qq_qzone_reply：commentId=父评论 commentId，commentUin=父评论 uin；要@父评论作者再加 replyUin/replyName'
      }));
    } catch (error) { return toolFail(`看说说详情失败：${error?.message ?? error}`); }
  }
);
server.tool(
  'qq_qzone_reply',
  '在 QQ 空间说说下回复。普通评论不传 commentId；楼中楼回复传**顶层父评论** commentId + commentUin（来自 qq_qzone_detail），要@楼内某人再传 replyUin/replyName。注意：回复别人的楼中楼时，commentId 仍填顶层父评论 id，不是那条回复的 commentId。',
  {
    tid: z.string().describe('说说 tid'),
    content: z.string().describe('评论内容（≤300 字）'),
    commentId: z.string().optional().describe('父评论 commentId（楼中楼时必填）'),
    commentUin: z.union([z.number(), z.string()]).optional().describe('父评论作者 QQ（楼中楼时必填）'),
    replyUin: z.union([z.number(), z.string()]).optional().describe('要@的人的 QQ（可选，楼内回复时用）'),
    replyName: z.string().optional().describe('要@的人的昵称（可选，和 replyUin 一起用）'),
    targetUin: z.union([z.number(), z.string()]).optional().describe('说说作者 QQ（省略=自己）'),
    token: z.string().describe('会话令牌')
  },
  async ({ tid, content, commentId, commentUin, replyUin, replyName, targetUin, token }) => {
    try {
      if (!token) return toolFail('缺少会话令牌，拒绝回复');
      const text = String(content ?? '').trim();
      if (!text) return toolFail('回复内容不能为空');
      if (text.length > 300) return toolFail('回复最多 300 字');
      if (SENSITIVE_RE.test(text)) return toolFail('内容含敏感信息，已阻止');
      const params = { tid: String(tid), content: text };
      if (targetUin) params.target_uin = Number(targetUin) || String(targetUin);
      if (commentId) {
        if (!commentUin) return toolFail('楼中楼回复需要 commentUin（父评论作者 QQ）');
        params.comment_id = String(commentId);
        params.comment_uin = Number(commentUin) || String(commentUin);
        if (replyUin) params.reply_uin = Number(replyUin) || String(replyUin);
        if (replyName) params.reply_name = String(replyName);
      }
      const data = await onebot('comment_qzone', params);
      appendQzoneAudit({ action: 'reply', tid: String(tid), commentId: params.comment_id ?? null, ok: true, data });
      return toolText(serializeModelData({ ok: true, tid: String(tid), commentId: data?.comment_id ?? null, parentCommentId: data?.parent_comment_id ?? null }));
    } catch (error) {
      appendQzoneAudit({ action: 'reply', tid: String(tid ?? ''), ok: false, error: String(error?.message ?? error) });
      return toolFail(`回复失败：${error?.message ?? error}`);
    }
  }
);
server.tool(
  'qq_qzone_like',
  '给一条 QQ 空间说说点赞/取消赞（公开动作，需 confirm=true）。',
  {
    tid: z.string().describe('说说 tid'),
    enable: z.boolean().optional().describe('true=点赞，false=取消，默认 true'),
    targetUin: z.union([z.number(), z.string()]).optional().describe('说说作者 QQ（省略=自己）'),
    abstime: z.number().optional().describe('说说发布时间（unix 秒，可选）'),
    confirm: z.boolean().describe('必须传 true'),
    token: z.string().describe('会话令牌')
  },
  async ({ tid, enable, targetUin, abstime, confirm, token }) => {
    if (confirm !== true) return toolFail('点赞需要主人确认（confirm=true）');
    if (!token) return toolFail('缺少会话令牌，拒绝点赞');
    try {
      const action = enable === false ? 'unlike_qzone' : 'like_qzone';
      const params = { tid: String(tid) };
      if (targetUin) params.target_uin = Number(targetUin) || String(targetUin);
      if (abstime) params.abstime = Number(abstime) || 0;
      await onebot(action, params);
      appendQzoneAudit({ action, tid: String(tid), ok: true });
      return toolText(`已${enable === false ? '取消赞' : '点赞'}：${tid}`);
    } catch (error) { return toolFail(`点赞失败：${error?.message ?? error}`); }
  }
);
server.tool(
  'qq_qzone_comment_like',
  '给 QQ 空间评论/楼中楼回复点赞或取消（公开动作，需 confirm=true）。commentId 来自 qq_qzone_detail。',
  {
    tid: z.string().describe('说说 tid'),
    commentId: z.string().describe('评论 commentId'),
    replyUin: z.union([z.number(), z.string()]).optional().describe('要操作的楼中楼回复作者 QQ（可选）'),
    replyTime: z.number().optional().describe('楼中楼回复时间（unix 秒，可选，用于定位回复）'),
    enable: z.boolean().optional().describe('true=点赞，false=取消，默认 true'),
    confirm: z.boolean().describe('必须传 true'),
    token: z.string().describe('会话令牌')
  },
  async ({ tid, commentId, replyUin, replyTime, enable, confirm, token }) => {
    if (confirm !== true) return toolFail('评论点赞需要主人确认（confirm=true）');
    if (!token) return toolFail('缺少会话令牌');
    try {
      const { feed, comments } = await qzoneRawObjects(tid);
      if (!feed) return toolFail('拿不到 feed 对象');
      const comment = findRawComment(comments, commentId);
      if (!comment) return toolFail(`找不到评论 ${commentId}`);
      let reply = null;
      if (replyUin) reply = findRawReply(comment, replyUin, replyTime);
      const params = { feed, comment, enable: enable !== false };
      if (reply) params.reply = reply;
      await onebot('set_qzone_public_comment_like', params);
      appendQzoneAudit({ action: 'commentLike', tid: String(tid), commentId: String(commentId), ok: true });
      return toolText(`已${enable === false ? '取消赞' : '点赞'}评论 ${commentId}${reply ? ' 的楼中楼' : ''}`);
    } catch (error) { return toolFail(`评论点赞失败：${error?.message ?? error}`); }
  }
);
server.tool(
  'qq_qzone_forward',
  '转发一条 QQ 空间说说（公开动作，需 confirm=true）。',
  {
    tid: z.string().describe('说说 tid'),
    reason: z.string().optional().describe('转发语（可选）'),
    confirm: z.boolean().describe('必须传 true'),
    token: z.string().describe('会话令牌')
  },
  async ({ tid, reason, confirm, token }) => {
    if (confirm !== true) return toolFail('转发需要主人确认（confirm=true）');
    if (!token) return toolFail('缺少会话令牌');
    try {
      const { feed } = await qzoneDetailRaw(tid);
      if (!feed) return toolFail('拿不到 feed 对象');
      await onebot('forward_qzone_public_feed', { feed, reason: String(reason ?? '') });
      appendQzoneAudit({ action: 'forward', tid: String(tid), ok: true });
      return toolText(`已转发说说 ${tid}`);
    } catch (error) { return toolFail(`转发失败：${error?.message ?? error}`); }
  }
);
server.tool(
  'qq_qzone_delete_comment',
  '删除自己说说下的评论或楼中楼回复（公开动作，需 confirm=true；删除失败会返回后端错误）。',
  {
    tid: z.string().describe('说说 tid'),
    commentId: z.string().describe('评论 commentId'),
    replyUin: z.union([z.number(), z.string()]).optional().describe('要删楼中楼时，该回复作者 QQ'),
    replyTime: z.number().optional().describe('要删楼中楼时，该回复时间（unix 秒）'),
    confirm: z.boolean().describe('必须传 true'),
    token: z.string().describe('会话令牌')
  },
  async ({ tid, commentId, replyUin, replyTime, confirm, token }) => {
    if (confirm !== true) return toolFail('删除评论需要主人确认（confirm=true）');
    if (!token) return toolFail('缺少会话令牌');
    try {
      const { feed, comments } = await qzoneRawObjects(tid);
      if (!feed) return toolFail('拿不到 feed 对象');
      const comment = findRawComment(comments, commentId);
      if (!comment) return toolFail(`找不到评论 ${commentId}`);
      if (replyUin) {
        const reply = findRawReply(comment, replyUin, replyTime);
        if (!reply) return toolFail('找不到对应的楼中楼回复');
        await onebot('delete_qzone_public_reply', { feed, comment, reply });
        appendQzoneAudit({ action: 'deleteReply', tid: String(tid), commentId: String(commentId), ok: true });
        return toolText(`已删除楼中楼回复（${replyUin}）`);
      }
      await onebot('delete_qzone_public_comment', { feed, comment });
      appendQzoneAudit({ action: 'deleteComment', tid: String(tid), commentId: String(commentId), ok: true });
      return toolText(`已删除评论 ${commentId}`);
    } catch (error) { return toolFail(`删除评论失败：${error?.message ?? error}`); }
  }
);

// ── 聊天互动工具（图片/撤回/表情回应） ────────────────────────────────────
function appendChatAudit(entry) {
  try {
    const dir = path.join(ROOT, 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'chat-audit.log'), `${new Date().toISOString()} ${JSON.stringify(entry)}\n`, 'utf8');
  } catch {}
}

if (cfg.socialV2?.tools?.sendImage !== false) {
  server.tool(
    'qq_send_image',
    '在聊天里发一张图片（网图/封面/截图）。图片由桥接先下载并校验类型与大小，可附一句说明文字。',
    {
      key: z.string().describe('会话 key，group:群号 或 private:QQ号'),
      image: z.string().describe('图片地址：http(s) URL，或 base64://... / data:image/...;base64,...'),
      caption: z.string().optional().describe('可选的说明文字（≤200 字）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, image, caption, token }) => {
      try {
        const data = await agentApi('/api/send/image', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, image, caption: caption ?? '', token }),
          timeoutMs: 70000
        });
        appendChatAudit({ action: 'sendImage', key, ok: true, messageId: data?.messageId ?? null, caption: caption ?? '' });
        return toolText(serializeModelData({ ok: true, ...data }));
      } catch (error) {
        appendChatAudit({ action: 'sendImage', key, ok: false, error: String(error?.message ?? error) });
        return toolFail(`发图失败：${error?.message ?? error}`);
      }
    }
  );
}

server.tool(
  'qq_recall_message',
  '撤回一条自己发出去的消息（QQ 只允许撤回自己的消息，且有时间限制）。发错了话/图时用。',
  {
    key: z.string().describe('会话 key，group:群号 或 private:QQ号'),
    messageId: z.union([z.number(), z.string()]).describe('要撤回的消息 id'),
    token: z.string().describe('会话令牌')
  },
  async ({ key, messageId, token }) => {
    try {
      if (!token) return toolFail('缺少会话令牌，拒绝撤回');
      if (!/^(group|private):\d+$/.test(String(key))) return toolFail('key 格式应为 group:群号 或 private:QQ号');
      const id = /^-?\d+$/.test(String(messageId)) ? Number(messageId) : String(messageId);
      await onebot('delete_msg', { message_id: id });
      appendChatAudit({ action: 'recall', key, messageId: String(messageId), ok: true });
      return toolText(`已撤回消息 ${messageId}`);
    } catch (error) {
      appendChatAudit({ action: 'recall', key, messageId: String(messageId), ok: false, error: String(error?.message ?? error) });
      return toolFail(`撤回失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'qq_emoji_like',
  '给一条消息加“表情回应”（QQ 的表情点赞/回应，比如 76 是赞）。轻量表达态度时用，别刷。',
  {
    key: z.string().describe('会话 key，group:群号 或 private:QQ号'),
    messageId: z.union([z.number(), z.string()]).describe('目标消息 id'),
    emojiId: z.string().optional().describe('表情 id，默认 76（赞）'),
    remove: z.boolean().optional().describe('传 true 表示取消回应'),
    token: z.string().describe('会话令牌')
  },
  async ({ key, messageId, emojiId, remove, token }) => {
    try {
      if (!token) return toolFail('缺少会话令牌，拒绝操作');
      const id = /^-?\d+$/.test(String(messageId)) ? Number(messageId) : String(messageId);
      await onebot('set_msg_emoji_like', { message_id: id, emoji_id: String(emojiId ?? '76'), set: remove !== true });
      appendChatAudit({ action: 'emojiLike', key, messageId: String(messageId), emojiId: String(emojiId ?? '76'), remove: remove === true, ok: true });
      return toolText(remove === true ? `已取消消息 ${messageId} 的表情回应` : `已给消息 ${messageId} 加了表情回应 ${emojiId ?? '76'}`);
    } catch (error) {
      appendChatAudit({ action: 'emojiLike', key, messageId: String(messageId), ok: false, error: String(error?.message ?? error) });
      return toolFail(`表情回应失败：${error?.message ?? error}`);
    }
  }
);

// ── 表情库扩充（自己挑喜欢的图加进收藏） ────────────────────────────────
server.tool(
  'qq_add_sticker',
  '把一张图片加进自己的 QQ 收藏表情库（自己挑喜欢的表情包）。图片支持 http(s) 地址或 base64；成功后返回 emoji_id，之后可用 qq_send_sticker 发它。',
  {
    image: z.string().describe('图片地址：http(s) URL / base64:// / file:// 本地路径'),
    note: z.string().optional().describe('给自己看的备注/含义（≤20 字，会写成表情的官方备注）'),
    token: z.string().describe('会话令牌')
  },
  async ({ image, note, token }) => {
    try {
      if (!token) return toolFail('缺少会话令牌，拒绝添加');
      const ref = String(image ?? '').trim();
      if (!ref) return toolFail('image 不能为空');
      const data = await onebot('add_custom_face', { file: ref });
      const emojiId = String(data?.emoji_id ?? data ?? '');
      let remarked = false;
      if (note && emojiId) {
        try {
          await onebot('modify_custom_face', { emoji_id: emojiId, desc: String(note).slice(0, 20) });
          remarked = true;
        } catch {}
      }
      appendChatAudit({ action: 'addSticker', ok: true, emojiId, note: note ?? '' });
      return toolText(serializeModelData({ ok: true, emoji_id: emojiId, noted: remarked }));
    } catch (error) {
      appendChatAudit({ action: 'addSticker', ok: false, error: String(error?.message ?? error) });
      return toolFail(`添加表情失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'qq_delete_sticker',
  '从自己的 QQ 收藏表情库里删掉一张表情（emoji_id 从 qq_list_stickers 取）。',
  {
    stickerId: z.string().describe('emoji_id / md5'),
    token: z.string().describe('会话令牌')
  },
  async ({ stickerId, token }) => {
    try {
      if (!token) return toolFail('缺少会话令牌，拒绝删除');
      await onebot('delete_custom_face', { emoji_id: String(stickerId) });
      appendChatAudit({ action: 'deleteSticker', ok: true, stickerId: String(stickerId) });
      return toolText(`已删除表情 ${stickerId}`);
    } catch (error) {
      appendChatAudit({ action: 'deleteSticker', ok: false, stickerId: String(stickerId), error: String(error?.message ?? error) });
      return toolFail(`删除表情失败：${error?.message ?? error}`);
    }
  }
);

// ── B 站工具（只读；视频信息 / 热评 / 热门） ─────────────────────────────
const BILI_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  referer: 'https://www.bilibili.com/'
};
async function biliGet(pathname) {
  const res = await fetch(`https://api.bilibili.com${pathname}`, { headers: BILI_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (body?.code !== 0) throw new Error(body?.message || `code ${body?.code}`);
  return body.data;
}
function biliBvid(input) {
  const m = /BV[0-9A-Za-z]{10}/.exec(String(input ?? ''));
  return m ? m[0] : '';
}
function biliCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(v);
}
function biliDuration(sec) {
  const s = Number(sec) || 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── 每一步 B 站足迹都写进审计数据库（<SYNAPSE_HOME>\audit\audit.db → bili_events） ──
const BILI_DB = `${B}\\audit\\audit.db`;
const BILI_COOKIE_FILE = `${B}\\bili\\cookies.json`;
function logBiliEvent(action, info = {}) {
  try {
    const db = new DatabaseSync(BILI_DB);
    db.exec(`CREATE TABLE IF NOT EXISTS bili_events (
      id TEXT PRIMARY KEY, t TEXT, action TEXT, bvid TEXT, title TEXT, up TEXT,
      detail TEXT, ok INTEGER, error TEXT, raw TEXT, ingested_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_bili_t ON bili_events(t);`);
    const t = new Date().toISOString();
    const raw = JSON.stringify(info).slice(0, 8000);
    const id = crypto.createHash('sha256').update(`${t}:${action}:${raw}:${Math.random()}`).digest('hex');
    db.prepare('INSERT INTO bili_events (id,t,action,bvid,title,up,detail,ok,error,raw,ingested_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, t, action, info.bvid || '', info.title || '', info.up || '', String(info.detail ?? raw).slice(0, 4000), info.ok === false ? 0 : 1, info.error ? String(info.error).slice(0, 1000) : null, raw, t);
    db.close();
  } catch (error) {
    try { console.error('[bili] 写审计库失败：', error?.message ?? error); } catch {}
  }
}
function readBiliCookies() {
  try {
    const j = JSON.parse(fs.readFileSync(BILI_COOKIE_FILE, 'utf8'));
    if (!j?.SESSDATA || !j?.bili_jct) return null;
    return j;
  } catch { return null; }
}
function biliCookieHeader(c) {
  const parts = [`SESSDATA=${c.SESSDATA}`, `bili_jct=${c.bili_jct}`]; // boundary-allow Cookie 字段名，非密钥值
  if (c.buvid3) parts.push(`buvid3=${c.buvid3}`);
  if (c.DedeUserID) parts.push(`DedeUserID=${c.DedeUserID}`);
  return parts.join('; ');
}
// WBI 签名（img_key + sub_key → 32 位 mixin key → md5(query + mixinKey)）
const WBI_MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
let wbiCache = { at: 0, img: '', sub: '' };
async function biliWbiKeys(cookieHeader = '') {
  if (Date.now() - wbiCache.at < 10 * 60 * 1000 && wbiCache.img && wbiCache.sub) return wbiCache;
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { ...BILI_HEADERS, ...(cookieHeader ? { cookie: cookieHeader } : {}) }, signal: AbortSignal.timeout(10000) });
  const body = await res.json().catch(() => ({}));
  const imgUrl = String(body?.data?.wbi_img?.img_url ?? '');
  const subUrl = String(body?.data?.wbi_img?.sub_url ?? '');
  const stem = (u) => (u.match(/\/([^/]+)\.png/) || [])[1] || '';
  const img = stem(imgUrl);
  const sub = stem(subUrl);
  if (!img || !sub) throw new Error('拿不到 B 站 wbi 签名密钥');
  wbiCache = { at: Date.now(), img, sub };
  return wbiCache;
}
function biliWbiSign(params, img, sub) {
  const merged = String(img + sub).split('');
  const mixinKey = WBI_MIXIN_TAB.map((i) => merged[i] ?? '').join('').slice(0, 32);
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v).replace(/[!'()*]/g, '')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  entries.push(`wts=${Math.floor(Date.now() / 1000)}`);
  const query = entries.join('&');
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${wRid}`;
}
async function biliPost(pathname, params, { signed = false, cookies = null } = {}) {
  let url = `https://api.bilibili.com${pathname}`;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v));
  if (cookies) body.set('csrf', cookies.bili_jct);
  if (signed) {
    const keys = await biliWbiKeys(cookies ? biliCookieHeader(cookies) : '');
    const signedQuery = biliWbiSign(Object.fromEntries(body.entries()), keys.img, keys.sub);
    url += `?${signedQuery}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...BILI_HEADERS,
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookies ? { cookie: biliCookieHeader(cookies) } : {})
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15000)
  });
  const out = await res.json().catch(() => ({}));
  return { httpStatus: res.status, ...out };
}

// 搜索需要的 buvid3/buvid4（匿名可用），30 分钟缓存
let biliBuvidCache = { at: 0, cookie: '' };
async function biliBuvidCookie() {
  if (Date.now() - biliBuvidCache.at < 30 * 60 * 1000 && biliBuvidCache.cookie) return biliBuvidCache.cookie;
  const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: BILI_HEADERS, signal: AbortSignal.timeout(10000) });
  const body = await res.json().catch(() => ({}));
  const b3 = body?.data?.b_3 ?? '';
  const b4 = body?.data?.b_4 ?? '';
  if (!b3) throw new Error('拿不到 buvid3');
  biliBuvidCache = { at: Date.now(), cookie: `buvid3=${b3}; buvid4=${b4}` };
  return biliBuvidCache.cookie;
}
function biliStripTags(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .trim();
}
async function biliSearch(keyword, page = 1) {
  const ck = await biliBuvidCookie();
  const keys = await biliWbiKeys(ck);
  const qs = biliWbiSign({ search_type: 'video', keyword, page }, keys.img, keys.sub);
  const res = await fetch(`https://api.bilibili.com/x/web-interface/search/type?${qs}`, {
    headers: { ...BILI_HEADERS, cookie: ck },
    signal: AbortSignal.timeout(15000)
  });
  const body = await res.json().catch(() => ({}));
  if (body?.code !== 0) throw new Error(`code ${body?.code} ${body?.message ?? ''}`);
  const list = Array.isArray(body?.data?.result) ? body.data.result : [];
  return list.map((v) => ({
    bvid: v?.bvid ?? '',
    title: biliStripTags(v?.title),
    up: v?.author ?? '',
    play: v?.play ?? 0,
    danmaku: v?.video_review ?? 0,
    duration: v?.duration ?? '',
    pubdate: v?.pubdate ?? 0,
    desc: biliStripTags(v?.description ?? '').slice(0, 80)
  }));
}

server.tool(
  'qq_bili_video',
  '查一个 B 站视频的信息：标题、UP、播放/点赞、简介、热门评论，并返回封面地址（可用 qq_send_image 发出去）。',
  {
    url: z.string().optional().describe('视频链接或 BV 号（二选一）'),
    bvid: z.string().optional().describe('BV 号（二选一）'),
    comments: z.number().optional().describe('取几条热门评论，默认 5，最多 10')
  },
  async ({ url, bvid, comments }) => {
    try {
      const bv = biliBvid(bvid || url);
      if (!bv) return toolFail('没识别出 BV 号；请传完整的视频链接或 BV 号');
      const data = await biliGet(`/x/web-interface/view?bvid=${encodeURIComponent(bv)}`);
      const stat = data?.stat ?? {};
      const text = [
        `《${data?.title ?? ''}》`,
        `BV：${bv}  UP：${data?.owner?.name ?? '?'}  时长：${biliDuration(data?.duration)}`,
        `播放 ${biliCount(stat.view)} · 弹幕 ${biliCount(stat.danmaku)} · 点赞 ${biliCount(stat.like)} · 投币 ${biliCount(stat.coin)} · 收藏 ${biliCount(stat.favorite)} · 评论 ${biliCount(stat.reply)}`,
        `发布时间：${data?.pubdate ? new Date(Number(data.pubdate) * 1000).toISOString() : '?'}`,
        `简介：${String(data?.desc ?? '').slice(0, 400)}`,
        `封面：${data?.pic ?? ''}`
      ];
      const want = Math.min(10, Math.max(0, Number(comments ?? 5) || 0));
      if (want > 0 && data?.aid) {
        try {
          const rep = await biliGet(`/x/v2/reply?type=1&oid=${encodeURIComponent(data.aid)}&sort=2&ps=${want}&pn=1`);
          const list = Array.isArray(rep?.replies) ? rep.replies.slice(0, want) : [];
          if (list.length) {
            text.push('', '热评：');
            for (const r of list) {
              const msg = String(r?.content?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
              text.push(`- ${r?.member?.uname ?? '?'}（赞 ${biliCount(r?.like)}）：${msg}`);
            }
          }
        } catch (error) {
          text.push(`（热评获取失败：${error?.message ?? error}）`);
        }
      }
      text.push('', '（想看封面就调 qq_send_image 发上面的封面地址）');
      logBiliEvent('browse_video', { bvid: bv, title: data?.title, up: data?.owner?.name, detail: `播放${stat.view ?? 0} 点赞${stat.like ?? 0}` });
      return toolText(text.join('\n'));
    } catch (error) {
      logBiliEvent('browse_video', { bvid: biliBvid(bvid || url), ok: false, error: String(error?.message ?? error) });
      return toolFail(`看 B 站视频失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'qq_bili_hot',
  '看 B 站当前热门视频列表（标题/UP/播放量/BV 号）。',
  {
    count: z.number().optional().describe('取几条，默认 5，最多 20')
  },
  async ({ count }) => {
    try {
      const ps = Math.min(20, Math.max(1, Number(count) || 5));
      const data = await biliGet(`/x/web-interface/popular?ps=${ps}&pn=1`);
      const list = Array.isArray(data?.list) ? data.list.slice(0, ps) : [];
      const text = [`B 站当前热门（${list.length} 条）：`];
      list.forEach((v, i) => {
        text.push(`${i + 1}. ${v?.title ?? ''}  UP：${v?.owner?.name ?? '?'}  播放 ${biliCount(v?.stat?.view)}  BV：${v?.bvid ?? ''}`);
      });
      logBiliEvent('browse_hot', { detail: `刷热门 ${list.length} 条：${list.map((v) => v?.title ?? '').slice(0, 5).join(' / ')}` });
      return toolText(text.join('\n'));
    } catch (error) {
      logBiliEvent('browse_hot', { ok: false, error: String(error?.message ?? error) });
      return toolFail(`看 B 站热门失败：${error?.message ?? error}`);
    }
  }
);

// ── B 站写操作（评论/收藏；需要主人提供登录 Cookie；每一步都入库） ──────
function biliCookieHint() {
  return `需要主人提供 B 站登录 Cookie：浏览器登录 bilibili.com 后按 F12 → 应用/存储 → Cookies，`
    + `把 SESSDATA 和 bili_jct 写进 ${BILI_COOKIE_FILE}，格式 `
    + `{"SESSDATA":"...","bili_jct":"...","buvid3":"(可选)","DedeUserID":"(可选)"}。填好之后我就能评论/收藏，每一步都会写进审计库。`;
}
// 评论暂时关闭（等专用账号再开）：配置 socialV2.tools.biliComment=false 时不注册评论工具。
if (cfg.socialV2?.tools?.biliComment !== false) {
server.tool(
  'qq_bili_comment',
  '在 B 站视频下发一条评论（需要主人已配置 B 站登录 Cookie；只做主人明确要求的事，别乱评）。',
  {
    url: z.string().optional().describe('视频链接或 BV 号（二选一）'),
    bvid: z.string().optional().describe('BV 号（二选一）'),
    text: z.string().describe('评论内容（≤200 字）')
  },
  async ({ url, bvid, text }) => {
    const bv0 = biliBvid(bvid || url);
    try {
      const ck = readBiliCookies();
      if (!ck) { logBiliEvent('comment', { bvid: bv0, ok: false, error: '缺少 B 站 Cookie' }); return toolFail(biliCookieHint()); }
      if (!bv0) return toolFail('没识别出 BV 号；请传完整的视频链接或 BV 号');
      const msg = String(text ?? '').trim();
      if (!msg) return toolFail('评论内容不能为空');
      if (msg.length > 200) return toolFail('评论最多 200 字');
      if (SENSITIVE_RE.test(msg)) return toolFail('评论含敏感信息，已阻止');
      const view = await biliGet(`/x/web-interface/view?bvid=${encodeURIComponent(bv0)}`);
      let out = await biliPost('/x/v2/reply/add', { oid: view.aid, type: 1, message: msg, plat: 1 }, { cookies: ck });
      if (out.code === -352 || out.code === -403 || out.code === -412) {
        out = await biliPost('/x/v2/reply/add', { oid: view.aid, type: 1, message: msg, plat: 1 }, { cookies: ck, signed: true });
      }
      if (out.code !== 0) throw new Error(`code ${out.code} ${out.message ?? ''}`);
      const rpid = out?.data?.rpid ?? out?.data?.rpid_str ?? null;
      logBiliEvent('comment', { bvid: bv0, title: view?.title, up: view?.owner?.name, detail: msg, raw: JSON.stringify({ rpid }) });
      return toolText(`评论成功：${bv0} · ${view?.title ?? ''}（rpid=${rpid ?? '?'}）`);
    } catch (error) {
      logBiliEvent('comment', { bvid: bv0, ok: false, error: String(error?.message ?? error) });
      return toolFail(`评论失败：${error?.message ?? error}`);
    }
  }
);
}

server.tool(
  'qq_bili_favorite',
  '把 B 站视频收藏到「流萤专用」收藏夹（需要主人已配置 B 站登录 Cookie；只做主人明确要求的事）。',
  {
    url: z.string().optional().describe('视频链接或 BV 号（二选一）'),
    bvid: z.string().optional().describe('BV 号（二选一）')
  },
  async ({ url, bvid }) => {
    const bv0 = biliBvid(bvid || url);
    try {
      const ck = readBiliCookies();
      if (!ck) { logBiliEvent('favorite', { bvid: bv0, ok: false, error: '缺少 B 站 Cookie' }); return toolFail(biliCookieHint()); }
      if (!bv0) return toolFail('没识别出 BV 号；请传完整的视频链接或 BV 号');
      const view = await biliGet(`/x/web-interface/view?bvid=${encodeURIComponent(bv0)}`);
      const navRes = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { ...BILI_HEADERS, cookie: biliCookieHeader(ck) }, signal: AbortSignal.timeout(10000) });
      const nav = await navRes.json().catch(() => ({}));
      const mid = nav?.data?.mid;
      if (!mid) throw new Error('Cookie 未登录或已过期（nav 拿不到 mid）');
      const foldersRes = await fetch(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`, { headers: { ...BILI_HEADERS, cookie: biliCookieHeader(ck) }, signal: AbortSignal.timeout(10000) });
      const folders = await foldersRes.json().catch(() => ({}));
      const folderList = Array.isArray(folders?.data?.list) ? folders.data.list : [];
      let favCfg = {};
      try { favCfg = JSON.parse(fs.readFileSync(`${B}\\bili\\favorite-folder.json`, 'utf8')); } catch {}
      const stripHeart = (s) => String(s ?? '').replace(/[\u2764\uFE0F\u2B50\u2728]/g, '').trim();
      let folder = null;
      if (favCfg.folderId) {
        folder = folderList.find((f) => String(f.id) === String(favCfg.folderId)) || { id: String(favCfg.folderId), title: favCfg.folderName || '流萤专用' };
      }
      if (!folder) {
        const want = stripHeart(favCfg.folderName || '流萤专用');
        folder = folderList.find((f) => {
          const t = stripHeart(f.title);
          return t && (t.includes(want) || want.includes(t));
        });
      }
      if (!folder?.id) throw new Error(`找不到收藏夹「${favCfg.folderName || '流萤专用'}」；现有收藏夹：${folderList.map((f) => f.title).join('、')}`);
      const out = await biliPost('/x/v3/fav/resource/deal', { rid: view.aid, type: 2, add_media_ids: folder.id, platform: 'web' }, { cookies: ck });
      if (out.code !== 0) throw new Error(`code ${out.code} ${out.message ?? ''}`);
      logBiliEvent('favorite', { bvid: bv0, title: view?.title, up: view?.owner?.name, detail: `收藏夹：${folder.title ?? folder.id}` });
      return toolText(`已收藏：${bv0} · ${view?.title ?? ''} → ${folder.title ?? folder.id}`);
    } catch (error) {
      logBiliEvent('favorite', { bvid: bv0, ok: false, error: String(error?.message ?? error) });
      return toolFail(`收藏失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'qq_bili_search',
  '按关键词搜 B 站视频（搜索自己喜欢的词条），返回标题/UP/播放/时长/BV 号；可再用 qq_bili_video 看详情、qq_send_image 发封面。',
  {
    keyword: z.string().describe('搜索词'),
    page: z.number().optional().describe('页码，从 1 开始，默认 1')
  },
  async ({ keyword, page }) => {
    const kw = String(keyword ?? '').trim();
    const pg = Math.max(1, Number(page) || 1);
    try {
      if (!kw) return toolFail('keyword 不能为空');
      const list = await biliSearch(kw, pg);
      const text = [`B 站搜索「${kw}」第 ${pg} 页（${list.length} 条）：`];
      list.forEach((v, i) => {
        text.push(`${i + 1}. ${v.title}  UP：${v.up}  播放 ${biliCount(v.play)}  时长 ${v.duration}  BV：${v.bvid}`);
      });
      logBiliEvent('browse_search', {
        detail: `搜「${kw}」第${pg}页 ${list.length} 条：${list.slice(0, 5).map((v) => v.title).join(' / ')}`,
        raw: JSON.stringify({ keyword: kw, page: pg, count: list.length, top: list.slice(0, 5).map((v) => ({ bvid: v.bvid, title: v.title })) })
      });
      return toolText(text.join('\n'));
    } catch (error) {
      logBiliEvent('browse_search', { detail: `搜「${kw}」`, ok: false, error: String(error?.message ?? error) });
      return toolFail(`B 站搜索失败：${error?.message ?? error}`);
    }
  }
);

// ── B 站观赏记忆：她看过的视频 + 自己的感受（长期记忆） ────────────────────
const BILI_MEMORY_FILE = `${B}\\bili\\bili-记忆.md`;
function logBiliNote(info) {
  try {
    const db = new DatabaseSync(BILI_DB);
    db.exec(`CREATE TABLE IF NOT EXISTS bili_notes (
      id TEXT PRIMARY KEY, t TEXT, bvid TEXT, title TEXT, up TEXT, note TEXT);
      CREATE INDEX IF NOT EXISTS idx_bili_notes_t ON bili_notes(t);`);
    const t = new Date().toISOString();
    const id = crypto.createHash('sha256').update(`${t}:${info.bvid}:${info.note}:${Math.random()}`).digest('hex');
    db.prepare('INSERT INTO bili_notes (id,t,bvid,title,up,note) VALUES(?,?,?,?,?,?)')
      .run(id, t, info.bvid || '', info.title || '', info.up || '', String(info.note || '').slice(0, 2000));
    db.close();
  } catch (error) { try { console.error('[bili] 写记忆库失败：', error?.message ?? error); } catch {} }
}
server.tool(
  'qq_bili_note',
  '把你看过的 B 站视频和一句自己的感受记进长期记忆（每个视频一条，写自然、第一人称）。看完视频后调用它。',
  {
    bvid: z.string().describe('视频 BV 号'),
    title: z.string().optional().describe('视频标题（尽量带上）'),
    up: z.string().optional().describe('UP 主名字'),
    note: z.string().describe('你自己的感受/想法（≤300 字）')
  },
  async ({ bvid, title, up, note }) => {
    const bv = String(bvid ?? '').match(/BV[a-zA-Z0-9]{10}/)?.[0] || String(bvid ?? '').trim();
    const text = String(note ?? '').trim();
    if (!bv) return toolFail('bvid 不能为空');
    if (!text) return toolFail('写一句感受吧（note 不能为空）');
    if (text.length > 300) return toolFail('感受最多 300 字');
    if (SENSITIVE_RE.test(text)) return toolFail('内容含敏感信息，已阻止');
    const at = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const block = `\n## ${at} · 【${bv}】${title ? `《${String(title).slice(0, 60)}》` : ''}\n- UP：${up || '未知'}\n- 感受：${text}\n`;
    try {
      fs.mkdirSync(path.dirname(BILI_MEMORY_FILE), { recursive: true });
      if (!fs.existsSync(BILI_MEMORY_FILE)) {
        fs.writeFileSync(BILI_MEMORY_FILE, '# 流萤的 B 站记忆\n\n> 自己看过的视频和当时的感受，随手记。\n', 'utf8');
      }
      fs.appendFileSync(BILI_MEMORY_FILE, block, 'utf8');
    } catch (error) {
      return toolFail(`写记忆失败：${error?.message ?? error}`);
    }
    logBiliNote({ bvid: bv, title, up, note: text });
    return toolText(`记住了：${bv}${title ? `《${String(title).slice(0, 40)}》` : ''}\n感受：${text}`);
  }
);

server.tool(
  'qq_bili_memory_search',
  '在“自己的 B 站记忆”里搜索看过的视频和感受（关键词匹配标题/UP/感受）。想翻出以前看过的视频聊聊时用。',
  {
    keyword: z.string().describe('关键词（视频名/UP/感受里的词）'),
    limit: z.number().optional().describe('返回几条，默认 5，最多 20')
  },
  async ({ keyword, limit }) => {
    const kw = String(keyword ?? '').trim();
    if (!kw) return toolFail('keyword 不能为空');
    try {
      const db = new DatabaseSync(BILI_DB);
      const rows = db.prepare('SELECT t, bvid, title, up, note FROM bili_notes WHERE title LIKE ? OR up LIKE ? OR note LIKE ? ORDER BY rowid DESC LIMIT ?')
        .all(`%${kw}%`, `%${kw}%`, `%${kw}%`, Math.min(20, Number(limit) || 5));
      db.close();
      if (!rows.length) return toolText(`没有搜到和「${kw}」有关的 B 站记忆。`);
      const lines = [`和「${kw}」有关的记忆（${rows.length} 条）：`];
      for (const r of rows) lines.push(`- ${String(r.title || r.bvid).slice(0, 50)}（${r.up || '?'}）：${String(r.note || '').slice(0, 90)}`);
      return toolText(lines.join(String.fromCharCode(10)));
    } catch (error) { return toolFail(`搜记忆失败：${error?.message ?? error}`); }
  }
);

// ── 抖音（热点榜 / 视频信息；公开接口，无需登录） ─────────────────────────
const DOUYIN_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  referer: 'https://www.douyin.com/',
  'accept-language': 'zh-CN,zh;q=0.9'
};
function logDouyinEvent(action, info = {}) {
  try {
    const db = new DatabaseSync(BILI_DB);
    db.exec(`CREATE TABLE IF NOT EXISTS douyin_events (
      id TEXT PRIMARY KEY, t TEXT, action TEXT, aweme_id TEXT, title TEXT, author TEXT,
      detail TEXT, ok INTEGER, error TEXT, raw TEXT, ingested_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_douyin_t ON douyin_events(t);`);
    const t = new Date().toISOString();
    const raw = JSON.stringify(info).slice(0, 8000);
    const id = crypto.createHash('sha256').update(`${t}:${action}:${raw}:${Math.random()}`).digest('hex');
    db.prepare('INSERT INTO douyin_events (id,t,action,aweme_id,title,author,detail,ok,error,raw,ingested_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, t, action, info.aweme_id || '', info.title || '', info.author || '', String(info.detail ?? raw).slice(0, 4000), info.ok === false ? 0 : 1, info.error ? String(info.error).slice(0, 1000) : null, raw, t);
    db.close();
  } catch (error) {
    try { console.error('[douyin] 写审计库失败：', error?.message ?? error); } catch {}
  }
}
function douyinCount(n) {
  const v = Number(n) || 0;
  return v >= 10000 ? `${(v / 10000).toFixed(1)} 万` : String(v);
}
async function douyinHot(count) {
  const res = await fetch('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/', { headers: DOUYIN_HEADERS, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (body?.status_code !== 0) throw new Error(`抖音热点接口返回 ${body?.status_code ?? res.status}`);
  const list = (Array.isArray(body?.word_list) ? body.word_list : []).slice(0, count).map((w) => ({
    word: String(w?.word ?? ''), hot: Number(w?.hot_value) || 0
  }));
  return { at: String(body?.active_time ?? ''), list };
}
async function douyinResolve(input) {
  const s = String(input ?? '').trim();
  let id = (s.match(/(\d{19})/) || [])[1] || '';
  let shareUrl = (s.match(/https?:\/\/[^\s，。！？】]*douyin\.com[^\s，。！？】]*/i) || [])[0] || '';
  if (shareUrl) shareUrl = shareUrl.replace(/[),.;!?]+$/, '');
  if (!id && shareUrl) {
    try {
      const res = await fetch(shareUrl, { headers: DOUYIN_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(20000) });
      const m = (res.url || '').match(/(?:video|note|share\/video)\/(\d{8,})/);
      if (m) id = m[1];
    } catch {}
  }
  return { id, shareUrl };
}
// 抖音网页 API 需要签名（a_bogus/s_v_web_id），匿名直连会被风控。
// 这里走公开解析服务（xingzhige，支持分享链接/视频 id），返回标题/作者/互动数据/封面。
async function douyinVideo(input) {
  const { id, shareUrl } = await douyinResolve(input);
  if (!id && !shareUrl) throw new Error('没识别出抖音链接或视频 id，请把整段分享口令贴进来');
  const targets = [shareUrl, id ? `https://www.douyin.com/video/${id}` : ''].filter(Boolean);
  let lastError = null;
  for (const target of targets) {
    try {
      const api = `https://api.xingzhige.com/API/douyin/?url=${encodeURIComponent(target)}`;
      const res = await fetch(api, { headers: { 'user-agent': DOUYIN_HEADERS['user-agent'] }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`解析服务 HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      if (body?.code !== 0) throw new Error(body?.msg || `解析服务返回 ${body?.code ?? '?'}`);
      const d = body.data || {};
      const item = d.item || {};
      const author = d.author || {};
      const stat = d.stat || {};
      const realId = String(stat.aweme_id || id || '');
      return {
        id: realId,
        title: String(item.title || '').slice(0, 200),
        author: String(author.name || ''),
        stats: {
          like: stat.like, comment: stat.comment, collect: stat.collect, share: stat.share
        },
        cover: String(item.cover || ''),
        videoUrl: String(item.url || item.ury || ''),
        duration: Number(item.duration) || 0,
        url: `https://www.douyin.com/video/${realId}`
      };
    } catch (error) { lastError = error; }
  }
  throw new Error(`拿不到视频信息：${lastError?.message ?? '解析服务不可用'}（抖音风控较严，稍后可以再试）`);
}
server.tool(
  'qq_douyin_hot',
  '看抖音当前热点榜（无需登录，返回热词和热度）。',
  { count: z.number().optional().describe('取几条，默认 10，最多 30') },
  async ({ count }) => {
    try {
      const n = Math.min(30, Math.max(1, Number(count) || 10));
      const { at, list } = await douyinHot(n);
      const text = [`抖音热点榜${at ? `（${at}）` : ''}，${list.length} 条：`];
      list.forEach((w, i) => text.push(`${i + 1}. ${w.word}  热度 ${douyinCount(w.hot)}`));
      logDouyinEvent('hot', { detail: `抖音热点 ${list.length} 条：${list.slice(0, 6).map((w) => w.word).join(' / ')}` });
      return toolText(text.join('\n'));
    } catch (error) {
      logDouyinEvent('hot', { ok: false, error: String(error?.message ?? error) });
      return toolFail(`看抖音热点失败：${error?.message ?? error}`);
    }
  }
);
server.tool(
  'qq_douyin_video',
  '看一条抖音视频的信息（可以直接贴整段分享口令/链接，或视频 id；返回标题/作者/点赞/评论/收藏/时长/封面，可配合 qq_send_image 发封面）。',
  {
    url: z.string().optional().describe('抖音分享链接或整段分享口令'),
    id: z.string().optional().describe('视频 id（与 url 二选一）')
  },
  async ({ url, id }) => {
    const input = url || id || '';
    try {
      const v = await douyinVideo(input);
      const text = [
        `抖音视频：${v.title || '(无标题)'}`,
        `作者：${v.author || '未知'}${v.stats?.like != null ? `  点赞 ${douyinCount(v.stats.like)}  评论 ${douyinCount(v.stats.comment)}  收藏 ${douyinCount(v.stats.collect)}` : ''}`,
        v.duration ? `时长：${Math.round(v.duration)} 秒` : '',
        `链接：${v.url}`,
        v.cover ? `封面：${v.cover}` : ''
      ].filter(Boolean);
      logDouyinEvent('video', { aweme_id: v.id, title: v.title, author: v.author, detail: `看视频 ${v.id}`, raw: JSON.stringify(v).slice(0, 4000) });
      return toolText(text.join('\n'));
    } catch (error) {
      logDouyinEvent('video', { ok: false, error: String(error?.message ?? error), detail: String(input).slice(0, 200) });
      return toolFail(`看抖音视频失败：${error?.message ?? error}`);
    }
  }
);

// ── B站视频“看内容”：playurl 取流 + 抽帧 + 本地 ASR ───────────────────────
async function biliVideoStream(bvid) {
  const view = await biliGet(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (!view || !view.cid) throw new Error('取不到视频信息（可能不存在或需要登录）');
  const play = await biliGet(`/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${view.cid}&qn=64&fnval=1&fourk=0`);
  const durl = (play?.durl || [])[0];
  if (!durl?.url) throw new Error('取不到播放地址（可能需要登录/大会员）');
  return {
    bvid,
    aid: view.aid,
    cid: view.cid,
    title: String(view.title || ''),
    up: String(view?.owner?.name || ''),
    duration: Number(view.duration) || 0,
    stat: {
      view: view?.stat?.view, like: view?.stat?.like, danmaku: view?.stat?.danmaku, reply: view?.stat?.reply
    },
    url: durl.url
  };
}
async function biliSubtitle(bvid, cid) {
  try {
    const j = await biliGet(`/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`);
    const sub = (j?.subtitle?.subtitles || [])[0];
    if (!sub?.subtitle_url) return '';
    const u = String(sub.subtitle_url).startsWith('//') ? 'https:' + sub.subtitle_url : String(sub.subtitle_url);
    const r = await fetch(u, { headers: BILI_HEADERS, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return '';
    const b = await r.json().catch(() => ({}));
    const txt = (b.body || []).map((x) => String(x?.content || '').trim()).filter(Boolean).join(' ');
    return txt.slice(0, 2000);
  } catch { return ''; }
}
async function biliHotComments(aid) {
  try {
    const j = await biliGet(`/x/v2/reply?type=1&oid=${aid}&sort=2&ps=5&pn=1`);
    return (j?.replies || []).slice(0, 4).map((x) => `${x?.member?.uname || '网友'}：${String(x?.content?.message || '').replace(/\s+/g, ' ').slice(0, 90)}`);
  } catch { return []; }
}
const FFMPEG_PATH2 = process.env.FFMPEG_PATH || 'ffmpeg';
const PYTHON_EXE = process.env.PYTHON_EXE || 'python';
const ASR_SCRIPT = `${DOUYIN_DIR}/asr.py`;
const OCR_SCRIPT = `${DOUYIN_DIR}/ocr.py`;
const DOUYIN_TMP = `${DOUYIN_DIR}/tmp`;
const WATCH_DBG = `${DOUYIN_DIR}/logs/watch.log`;

// 视频“看内容”通用管线：下载 → 场景抽帧（失败退回均匀抽帧）→ 画面 OCR（rapidocr）→ 口播 ASR（Whisper）
async function douyinWatchMedia(videoUrl, durationSec, count, headers = DOUYIN_HEADERS, withAsr = true, opts = {}) {
  const result = { frames: [], transcript: '', ocrText: '', error: '' };
  const dbg = (m) => { try { fs.mkdirSync(path.dirname(WATCH_DBG), { recursive: true }); fs.appendFileSync(WATCH_DBG, new Date().toISOString() + ' ' + m + String.fromCharCode(10)); } catch {} };
  dbg(`start urlLen=${String(videoUrl || '').length} dur=${durationSec} count=${count}`);
  if (!videoUrl) { result.error = '没有视频直链'; return result; }
  fs.mkdirSync(DOUYIN_TMP, { recursive: true });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const vid = path.join(DOUYIN_TMP, `v-${stamp}.mp4`);
  const wav = path.join(DOUYIN_TMP, `a-${stamp}.wav`);
  try {
    const res = await fetch(videoUrl, { headers, redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`视频下载 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 200 * 1024 * 1024) throw new Error('视频太大（>200MB）');
    if (buf.length < 10000) throw new Error('视频太小/下载失败');
    fs.writeFileSync(vid, buf);
    dbg(`downloaded ${buf.length} bytes`);
    const n = Math.min(6, Math.max(1, Number(count) || 4));
    const dur = Math.max(2, Number(durationSec) || 10);
    const sceneDir = path.join(DOUYIN_TMP, `s-${stamp}`);
    fs.mkdirSync(sceneDir, { recursive: true });
    let frameList = [];
    if (opts.scene !== false) {
      try {
        spawnSync(FFMPEG_PATH2, ['-y', '-i', vid, '-vf', "select='gt(scene,0.3)',scale=512:-1", '-vsync', 'vfr', '-frames:v', String(n), path.join(sceneDir, 's-%02d.jpg')], { timeout: 90000, windowsHide: true });
        frameList = fs.readdirSync(sceneDir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(sceneDir, f));
      } catch {}
    }
    if (frameList.length < 2) {
      frameList = [];
      for (let i = 1; i <= n; i += 1) {
        const t = Math.max(0.2, dur * (i / (n + 1)));
        const img = path.join(sceneDir, `u-${i}.jpg`);
        try {
          spawnSync(FFMPEG_PATH2, ['-y', '-ss', String(t.toFixed(2)), '-i', vid, '-frames:v', '1', '-vf', 'scale=512:-1', img], { timeout: 30000, windowsHide: true });
          if (fs.existsSync(img)) frameList.push(img);
        } catch {}
      }
    }
    for (const img of frameList.slice(0, n)) {
      try { result.frames.push({ at: 0, mimeType: 'image/jpeg', data: fs.readFileSync(img).toString('base64') }); } catch {}
    }
    for (const img of frameList) { try { fs.unlinkSync(img); } catch {} }
    try { fs.rmdirSync(sceneDir); } catch {}
    dbg(`frames=${result.frames.length} scene=${frameList.length}`);
    if (opts.withOcr !== false && fs.existsSync(OCR_SCRIPT)) {
      try {
        const ocrDir = path.join(DOUYIN_TMP, `o-${stamp}`);
        fs.mkdirSync(ocrDir, { recursive: true });
        const ocrFrames = Math.min(80, Math.max(8, Math.ceil(Math.min(dur, 150) / 1.5)));
        spawnSync(FFMPEG_PATH2, ['-y', '-i', vid, '-vf', 'fps=1/1.5,scale=640:-1', '-frames:v', String(ocrFrames), path.join(ocrDir, 'o-%03d.jpg')], { timeout: 90000, windowsHide: true });
        const r = spawnSync(PYTHON_EXE, [OCR_SCRIPT, ocrDir], { encoding: 'utf8', timeout: 240000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        try {
          const lines = [];
          const noise = (opts.ocrNoise || []).map(String).filter(Boolean);
          const strip = (t) => (noise.length ? t.split(new RegExp(noise.join('|'), 'gi')).join('').replace(/\s{2,}/g, ' ').trim() : t);
          const j = JSON.parse(String(r.stdout || '{}').trim().split(String.fromCharCode(10)).pop() || '{}');
          for (const fr of j.frames || []) {
            const txt = strip((fr.texts || []).join(' ').trim());
            if (txt && (!lines.length || lines[lines.length - 1] !== txt)) lines.push(txt);
          }
          result.ocrText = lines.join(' / ').slice(0, 1200);
        } catch {}
        try { fs.rmSync(ocrDir, { recursive: true, force: true }); } catch {}
        dbg(`ocr len=${String(result.ocrText || '').length}`);
      } catch (error) { dbg('ocr err ' + String(error?.message ?? error)); }
    }
    if (withAsr) spawnSync(FFMPEG_PATH2, ['-y', '-i', vid, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], { timeout: 60000, windowsHide: true });
    if (withAsr && fs.existsSync(wav) && fs.existsSync(ASR_SCRIPT)) {
      try {
        const r = spawnSync(PYTHON_EXE, [ASR_SCRIPT, wav], {
          encoding: 'utf8', timeout: 240000, windowsHide: true,
          env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com', PYTHONIOENCODING: 'utf-8' }
        });
        const txt = String(r.stdout || '').trim();
        if (txt) result.transcript = txt.slice(0, 1500);
        dbg(`asr status=${r.status} txtlen=${txt.length}`);
      } catch (error) { result.error = `语音识别失败：${error?.message ?? error}`; }
    }
  } catch (error) {
    result.error = String(error?.message ?? error);
  } finally {
    try { fs.unlinkSync(vid); } catch {}
    try { fs.unlinkSync(wav); } catch {}
  }
  return result;
}

server.tool(
  'qq_bili_watch',
  '看一条 B 站视频的“内容”：优先拿 CC 字幕；没字幕就下载视频、按场景抽关键帧 + 本机 OCR 读画面文字 + Whisper 转写口播，再带热评。想真的了解视频内容时用。',
  {
    url: z.string().optional().describe('视频链接或 BV 号'),
    bvid: z.string().optional().describe('BV 号（与 url 二选一）'),
    frames: z.number().optional().describe('抽几帧看，默认 4，最多 6')
  },
  async ({ url, bvid, frames }) => {
    const input = url || bvid || '';
    const bv = (String(input).match(/BV[a-zA-Z0-9]{10}/) || [])[0] || String(input).trim();
    try {
      if (!bv) return toolFail('请给 BV 号或视频链接');
      const info = await biliVideoStream(bv);
      const subs = await biliSubtitle(bv, info.cid);
      const comments = await biliHotComments(info.aid);
      const withAsr = info.duration <= 900;
      const media = await douyinWatchMedia(info.url, info.duration, frames ?? 4, { ...BILI_HEADERS, referer: 'https://www.bilibili.com/' }, withAsr, { withOcr: !subs, scene: true, ocrNoise: [info.up, 'bilibili'] });
      const lines = [
        `B 站视频：${info.title || '(无标题)'}`,
        `UP：${info.up || '未知'}${info.stat?.view != null ? `  播放 ${biliCount(info.stat.view)}  点赞 ${biliCount(info.stat.like)}  评论 ${biliCount(info.stat.reply)}` : ''}`,
        info.duration ? `时长：${Math.floor(info.duration / 60)} 分 ${info.duration % 60} 秒` : '',
        subs ? `CC 字幕：${subs}` : '',
        media.ocrText ? `画面文字：${media.ocrText}` : '',
        media.transcript ? `口播文字：${media.transcript}` : '',
        media.frames.length ? `（下面是 ${media.frames.length} 张场景关键帧）` : '',
        comments.length ? `热评：${comments.join('；')}` : '',
        media.error ? `（视频内容部分失败：${media.error}）` : ''
      ].filter(Boolean);
      logBiliEvent('watch', { bvid: bv, title: info.title, up: info.up, detail: `看视频内容 ${bv}（${media.frames.length} 帧${subs ? ' + CC 字幕' : ''}${media.ocrText ? ' + 画面文字' : ''}${media.transcript ? ' + 口播' : ''}）` });
      return { content: [{ type: 'text', text: lines.join(String.fromCharCode(10)) }, ...media.frames.map((f) => ({ type: 'image', mimeType: f.mimeType, data: f.data }))] };
    } catch (error) {
      logBiliEvent('watch', { bvid: bv, ok: false, error: String(error?.message ?? error) });
      return toolFail(`看 B 站视频内容失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'qq_douyin_watch',
  '看一条抖音视频的“内容”：下载视频、按场景抽关键帧（以图片给你看）、本机 OCR 读画面文字 + Whisper 转写口播。主人发抖音分享、你想知道视频里到底拍了什么时用这个。',
  {
    url: z.string().optional().describe('抖音分享链接/整段分享口令'),
    id: z.string().optional().describe('视频 id（与 url 二选一）'),
    frames: z.number().optional().describe('抽几帧看，默认 4，最多 6')
  },
  async ({ url, id, frames }) => {
    const input = url || id || '';
    try {
      const meta = await douyinVideo(input);
      const media = await douyinWatchMedia(meta.videoUrl, meta.duration, frames ?? 4);
      const lines = [
        `抖音视频：${meta.title || '(无标题)'}`,
        `作者：${meta.author || '未知'}${meta.stats?.like != null ? `  点赞 ${douyinCount(meta.stats.like)}  评论 ${douyinCount(meta.stats.comment)}  收藏 ${douyinCount(meta.stats.collect)}` : ''}`,
        meta.duration ? `时长：${Math.round(meta.duration)} 秒` : '',
        `链接：${meta.url}`,
        media.ocrText ? `画面文字：${media.ocrText}` : '',
        media.transcript ? `口播文字：${media.transcript}` : '',
        media.frames.length ? `（下面是 ${media.frames.length} 张场景关键帧）` : '',
        media.error ? `（视频内容获取部分失败：${media.error}）` : ''
      ].filter(Boolean);
      logDouyinEvent('watch', { aweme_id: meta.id, title: meta.title, author: meta.author, detail: `看视频内容 ${meta.id}（${media.frames.length} 帧${media.transcript ? ' + 口播' : ''}）` });
      return {
        content: [
          { type: 'text', text: lines.join(String.fromCharCode(10)) },
          ...media.frames.map((f) => ({ type: 'image', mimeType: f.mimeType, data: f.data }))
        ]
      };
    } catch (error) {
      logDouyinEvent('watch', { ok: false, error: String(error?.message ?? error), detail: String(input).slice(0, 200) });
      return toolFail(`看抖音视频内容失败：${error?.message ?? error}`);
    }
  }
);

// ── 参考图记忆：让她自己看参考图、写印象，画画时按语境挑参考图 ─────────────
const REFS_DIR = `${PATHS_REFS}/默认人设`;
const REFS_MEMORY_FILE = REFS_DIR + '/refs-memory.json';
function listRefFiles() {
  try { return fs.readdirSync(REFS_DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort(); } catch { return []; }
}
function readRefsMemory() {
  try { return JSON.parse(fs.readFileSync(REFS_MEMORY_FILE, 'utf8')); } catch { return { images: [] }; }
}
function saveRefsMemory(m) {
  try { fs.mkdirSync(path.dirname(REFS_MEMORY_FILE), { recursive: true }); fs.writeFileSync(REFS_MEMORY_FILE, JSON.stringify(m, null, 2), 'utf8'); } catch {}
}
function pickRefsForPrompt(prompt, count) {
  const mem = readRefsMemory();
  const imgs = (mem.images || []).filter((x) => x && x.file);
  const n = Math.max(1, Math.min(5, Number(count) || 2));
  const p = String(prompt || '');
  if (!imgs.length) return listRefFiles().slice(0, n).map((f) => path.join(REFS_DIR, f));
  const scored = imgs.map((it) => {
    let s = 0;
    for (const t of it.tags || []) { const tag = String(t || '').trim(); if (tag && p.includes(tag)) s += 2; }
    if (it.title && p.includes(String(it.title).slice(0, 4))) s += 1;
    return { it, s };
  }).sort((a, b) => b.s - a.s);
  const chosen = [];
  for (const x of scored) { if (chosen.length >= n) break; if (x.s > 0 && !chosen.includes(x.it.file)) chosen.push(x.it.file); }
  for (const x of scored) { if (chosen.length >= n) break; if (!chosen.includes(x.it.file)) chosen.push(x.it.file); }
  return chosen.map((f) => path.join(REFS_DIR, f));
}
function refPreviewContent(max = 5) {
  const files = listRefFiles().slice(0, max);
  const dir = `${TMP_DIR}/ref-preview`;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const content = [];
  for (const f of files) {
    const src = path.join(REFS_DIR, f);
    let out = src;
    try {
      const jpg = path.join(dir, f.replace(/\.[^.]+$/, '') + '.jpg');
      spawnSync(FFMPEG_PATH2, ['-y', '-i', src, '-vf', 'scale=768:-1', jpg], { timeout: 30000, windowsHide: true });
      if (fs.existsSync(jpg)) out = jpg;
    } catch {}
    try {
      const buf = fs.readFileSync(out);
      content.push({ type: 'image', mimeType: 'image/jpeg', data: buf.toString('base64') });
    } catch {}
  }
  return { files, content };
}
server.tool(
  'qq_ref_gallery',
  '查看主人给你的“流萤参考图”：会把这些图片作为图片内容给你看。你可以据此写下你对自己的印象（用 qq_ref_note 记进记忆）。',
  { max: z.number().optional().describe('最多看几张，默认 5') },
  async ({ max }) => {
    try {
      const { files, content } = refPreviewContent(Math.min(5, Math.max(1, Number(max) || 5)));
      const mem = readRefsMemory();
      const known = new Set((mem.images || []).map((x) => x.file));
      const lines = [`参考图 ${files.length} 张：${files.join('、')}`];
      lines.push(known.size ? `已写印象的：${[...known].join('、')}` : '还没有为参考图写印象。');
      return { content: [{ type: 'text', text: lines.join(String.fromCharCode(10)) }, ...content] };
    } catch (error) { return toolFail(`取参考图失败：${error?.message ?? error}`); }
  }
);
server.tool(
  'qq_ref_note',
  '为一张参考图写下你对自己的印象/描述（第一人称、自然），并存进记忆；以后画图会按语境挑选对应的参考图。',
  {
    file: z.string().describe('参考图文件名（来自 qq_ref_gallery 的列表）'),
    impression: z.string().describe('你看到这张图时对自己的印象/描述（≤300 字）'),
    tags: z.array(z.string()).optional().describe('短标签，如 [夜景, 白裙, 特写, 烟火, 室内]'),
    title: z.string().optional().describe('给这张图起个短标题')
  },
  async ({ file, impression, tags, title }) => {
    const name = String(file ?? '').trim();
    const text = String(impression ?? '').trim();
    if (!name) return toolFail('file 不能为空（参考图文件名）');
    if (!listRefFiles().includes(name)) return toolFail(`没有这张参考图：${name}（可用：${listRefFiles().join('、')}）`);
    if (!text) return toolFail('写一句印象吧');
    if (text.length > 300) return toolFail('印象最多 300 字');
    if (SENSITIVE_RE.test(text)) return toolFail('内容含敏感信息，已阻止');
    const mem = readRefsMemory();
    const list = (mem.images || []).filter((x) => x && x.file !== name);
    list.push({ file: name, title: String(title || '').slice(0, 40), impression: text, tags: (tags || []).map((t) => String(t).slice(0, 20)).slice(0, 8), at: new Date().toISOString() });
    saveRefsMemory({ ...mem, images: list, updatedAt: new Date().toISOString() });
    try {
      const db = new DatabaseSync(BILI_DB);
      db.exec(`CREATE TABLE IF NOT EXISTS ref_notes (id TEXT PRIMARY KEY, t TEXT, file TEXT, title TEXT, impression TEXT, tags TEXT);`);
      const t = new Date().toISOString();
      const id = crypto.createHash('sha256').update(`${t}:${name}:${text}:${Math.random()}`).digest('hex');
      db.prepare('INSERT INTO ref_notes (id,t,file,title,impression,tags) VALUES(?,?,?,?,?,?)')
        .run(id, t, name, String(title || ''), text, (tags || []).join(','));
      db.close();
    } catch {}
    return toolText(`记下了：${name}${title ? `《${title}》` : ''}\n印象：${text}\n标签：${(tags || []).join('、') || '（无）'}`);
  }
);

// ── 她的自我资料 / 小生活：改昵称、换头像、读书、刷视频 ───────────────────
function snowConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).snowluma || {}; } catch { return {}; }
}
async function snowAction(action, body) {
  const c = snowConfig();
  const base = String(c.httpUrl || '').replace(/\/+$/, '');
  const tok = String(c.accessToken || '');
  if (!base || !tok) throw new Error('拿不到 SnowLuma 地址/令牌');
  const r = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(60000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 'ok') throw new Error(j?.wording || j?.message || `${action} HTTP ${r.status}`);
  return j.data;
}
function profileRateOk(kind, minMs = 3600000) {
  const p = `${GLOBAL_STATE}/profile-rate.json`;
  let d = {};
  try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  const last = Number(d[kind] || 0);
  if (Date.now() - last < minMs) return false;
  d[kind] = Date.now();
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(d, null, 2)); } catch {}
  return true;
}
server.tool(
  'qq_set_nickname',
  '改自己的 QQ 昵称（她自己想换时用；1 小时最多 1 次）。改完在聊天里说一声就好。',
  { nickname: z.string().describe('新昵称（1~24 字）'), key: z.string(), token: z.string() },
  async ({ nickname }) => {
    const name = String(nickname ?? '').trim();
    if (!name) return toolFail('昵称不能为空');
    if (name.length > 24) return toolFail('昵称最多 24 字');
    if (SENSITIVE_RE.test(name)) return toolFail('昵称含敏感信息，已阻止');
    if (!profileRateOk('nickname')) return toolFail('昵称改得太频繁了（1 小时最多 1 次），过会儿再改');
    try {
      await snowAction('set_qq_profile', { nickname: name });
      return toolText(`昵称改好了：${name}`);
    } catch (error) { return toolFail(`改昵称失败：${error?.message ?? error}`); }
  }
);
server.tool(
  'qq_set_bio',
  '改自己的 QQ 个性签名/简介（她自己想换时用；1 小时最多 1 次）。改完在聊天里说一声就好。',
  { text: z.string().describe('新的个性签名（1~80 字）'), key: z.string(), token: z.string() },
  async ({ text }) => {
    const bio = String(text ?? '').trim();
    if (!bio) return toolFail('签名不能为空');
    if (bio.length > 80) return toolFail('签名最多 80 字');
    if (SENSITIVE_RE.test(bio)) return toolFail('签名含敏感信息，已阻止');
    if (!profileRateOk('bio')) return toolFail('签名改得太频繁了（1 小时最多 1 次），过会儿再改');
    try {
      await snowAction('set_qq_profile', { personal_note: bio });
      return toolText(`签名改好了：${bio}`);
    } catch (error) { return toolFail(`改签名失败：${error?.message ?? error}`); }
  }
);
server.tool(
  'qq_set_avatar',
  '换自己的 QQ 头像（传图片路径 / http(s) 地址 / base64；1 小时最多 1 次）。',
  { image: z.string().describe('图片：绝对路径、http(s) 链接或 base64://'), key: z.string(), token: z.string() },
  async ({ image }) => {
    const src = String(image ?? '').trim();
    if (!src) return toolFail('图片不能为空');
    if (!profileRateOk('avatar')) return toolFail('头像换得太频繁了（1 小时最多 1 次），过会儿再换');
    try {
      let buf = null;
      if (/^base64:\/\//.test(src)) buf = Buffer.from(src.slice('base64://'.length), 'base64');
      else if (/^data:image\//.test(src)) buf = Buffer.from(src.split(',').pop(), 'base64');
      else if (/^https?:\/\//.test(src)) {
        const r = await fetch(src, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`下载图片 HTTP ${r.status}`);
        buf = Buffer.from(await r.arrayBuffer());
      } else if (fs.existsSync(src)) buf = fs.readFileSync(src);
      if (!buf) throw new Error('读不到图片（路径不存在或格式不对）');
      if (buf.length > 6 * 1024 * 1024) throw new Error('图片太大（>6MB）');
      await snowAction('set_qq_avatar', { file: `base64://${buf.toString('base64')}` });
      return toolText('头像换好了。');
    } catch (error) { return toolFail(`换头像失败：${error?.message ?? error}`); }
  }
);

function listBooks() {
  try { return fs.readdirSync(BOOKS_DIR).filter((f) => /\.txt$/i.test(f)).sort(); } catch { return []; }
}
server.tool(
  'qq_read_book',
  `读一章书：从 ${BOOKS_DIR} 里找 txt，按“第X章”切章，返回一章文字（可指定书名/章节）。读完后可以自然地和主人聊感受。`,
  {
    title: z.string().optional().describe('书名关键词（可选，默认随机一本）'),
    chapter: z.number().optional().describe('第几章（从 1 开始，可选；不传随机）'),
    key: z.string(), token: z.string()
  },
  async ({ title, chapter }) => {
    try {
      const files = listBooks();
      if (!files.length) return toolFail(`书库还是空的：把 txt 放进 ${BOOKS_DIR} 我就能读了`);
      let file = files[0];
      if (title) {
        const kw = String(title).trim();
        file = files.find((f) => f.includes(kw)) || files.find((f) => f.toLowerCase().includes(kw.toLowerCase()));
        if (!file) return toolFail(`没找到《${kw}》；书库里有：${files.join('、')}`);
      }
      const text = fs.readFileSync(path.join(BOOKS_DIR, file), 'utf8');
      const parts = text.split(/(?=第[一二三四五六七八九十百零〇0-9]+章)/);
      let real = parts.filter((x) => x.trim().length > 20);
      if (!real.length) {
        // 不是章节体：按 1200 字切成“段”，也能读
        const t = text.replace(/^《[^》]*》.*$/m, '').trim();
        for (let i = 0; i < t.length; i += 1200) real.push(t.slice(i, i + 1200));
      }
      if (!real.length) return toolFail('这本书读不出内容');
      const idx = Number.isFinite(Number(chapter)) && Number(chapter) > 0 ? Math.min(real.length - 1, Number(chapter) - 1) : Math.floor(Math.random() * real.length);
      const body = real[idx].trim().slice(0, 2600);
      return toolText(`《${file.replace(/\.txt$/i, '')}》· 第 ${idx + 1} 章 / 共 ${real.length} 章` + String.fromCharCode(10) + body);
    } catch (error) { return toolFail(`读书失败：${error?.message ?? error}`); }
  }
);
server.tool(
  'qq_video_binge',
  '去刷一会儿视频：从当前热门里挑几条，逐条看内容（字幕/画面文字/口播/热评），返回清单和可聊的点。想真刷半小时就多调几次。',
  { count: z.number().optional().describe('看几条，默认 2，最多 3'), key: z.string(), token: z.string() },
  async ({ count }) => {
    try {
      const n = Math.min(3, Math.max(1, Number(count) || 2));
      const hot = await biliGet('/x/web-interface/popular?ps=8&pn=1');
      const list = (hot?.list || []).slice(0, n);
      if (!list.length) return toolFail('没拿到 B 站热门，过会儿再试');
      const out = [];
      for (const v of list) {
        const bv = String(v.bvid || '');
        try {
          const info = await biliVideoStream(bv);
          const subs = await biliSubtitle(bv, info.cid);
          const media = await douyinWatchMedia(info.url, info.duration, 2, { ...BILI_HEADERS, referer: 'https://www.bilibili.com/' }, false, { withOcr: !subs, scene: true });
          out.push(`- ${info.title}（${info.up}，${Math.round(info.duration / 60)} 分钟）${subs ? ` 字幕：${subs.slice(0, 200)}` : media.ocrText ? ` 画面：${media.ocrText.slice(0, 200)}` : ''}`);
        } catch (error) {
          out.push(`- ${v.title || bv}（这条没看成：${String(error?.message ?? error).slice(0, 60)}）`);
        }
      }
      return toolText(`刷了 ${out.length} 条：` + String.fromCharCode(10) + out.join(String.fromCharCode(10)) + String.fromCharCode(10) + '想记下来的，可以用 qq_bili_note 记一条感受。');
    } catch (error) { return toolFail(`刷视频失败：${error?.message ?? error}`); }
  }
);

// ── 睡觉 / 需求记录 / 找表情包 ─────────────────────────────────────────────
server.tool(
  'qq_sleep_plan',
  '睡觉计划：说“去睡了，早上7点醒”这类话时用。会设置有限睡眠到指定时间，并记下醒来要说的话（醒来后系统会提醒你）。',
  {
    until: z.string().optional().describe('醒来的时间：HH:MM（如 07:00）或 ISO 时间'),
    minutes: z.number().optional().describe('睡多少分钟（午睡用，如 30）'),
    note: z.string().optional().describe('醒来时想说的话/要做的事（可选）'),
    key: z.string(), token: z.string()
  },
  async ({ until, minutes, note, key, token }) => {
    try {
      let wakeAt = 0;
      if (Number.isFinite(Number(minutes)) && Number(minutes) > 0) {
        wakeAt = Date.now() + Math.min(720, Number(minutes)) * 60000;
      } else if (until && /^\d{1,2}:\d{2}$/.test(String(until).trim())) {
        const [h, m] = String(until).trim().split(':').map(Number);
        const d = new Date();
        d.setHours(h, m, 0, 0);
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
        wakeAt = d.getTime();
      } else if (until && Number.isFinite(Date.parse(until))) {
        wakeAt = Date.parse(until);
      }
      if (!wakeAt) return toolFail('给个时间：until="07:00" 或 minutes=30');
      if (wakeAt <= Date.now()) return toolFail('这个时间已经过去了');
      const plan = { key, wakeAt, note: String(note || '').slice(0, 200), createdAt: new Date().toISOString(), used: false };
      fs.mkdirSync(`${GLOBAL_STATE}`, { recursive: true });
      fs.writeFileSync(`${GLOBAL_STATE}/sleep-plan.json`, JSON.stringify(plan, null, 2), 'utf8');
      const cfg = { mode: 'diving', infinite: false, sleepUntil: new Date(wakeAt).toISOString(), triggers: { atMention: true, nameMention: true, question: true } };
      await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config: cfg }), headers: { 'x-agent-token': token } });
      const t = new Date(wakeAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      return toolText(`好，我睡到 ${t} 再醒。${note ? `醒来要：${note}` : ''}`);
    } catch (error) { return toolFail(`安排睡觉失败：${error?.message ?? error}`); }
  }
);
server.tool(
  'qq_feature_request',
  `主人提出“能不能加个 xx 功能/我想要 xxx”时，把需求记进功能需求清单（${FEATURE_DOC}），并在聊天里简短确认。`,
  { title: z.string(), detail: z.string().optional(), key: z.string(), token: z.string() },
  async ({ title, detail }) => {
    const t = String(title || '').trim();
    if (!t) return toolFail('需求标题不能为空');
    try {
      const p = `${FEATURE_DOC}`;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (!fs.existsSync(p)) fs.writeFileSync(p, '# 功能需求清单（她记录）\n\n', 'utf8');
      const line = `- [${new Date().toISOString()}] ${t}${detail ? `：${String(detail).trim()}` : ''}`;
      fs.appendFileSync(p, line + String.fromCharCode(10), 'utf8');
      return toolText(`记下了：${t}。我会找合适的时候做，做好了告诉你。`);
    } catch (error) { return toolFail(`记录需求失败：${error?.message ?? error}`); }
  }
);
server.tool(
  'qq_search_images',
  '联网搜图片（例如“流萤表情包”），返回可用的图片链接；挑喜欢的用 qq_add_sticker(image=链接, note=含义) 收藏。',
  { query: z.string(), count: z.number().optional(), key: z.string(), token: z.string() },
  async ({ query, count }) => {
    const q = String(query || '').trim();
    if (!q) return toolFail('搜索词不能为空');
    try {
      const n = Math.min(12, Math.max(3, Number(count) || 8));
      const url = `https://www.bing.com/images/async?q=${encodeURIComponent(q)}&first=1&count=30&mkt=zh-CN&adlt=off`;
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      const html = await r.text();
      const seen = new Set();
      const urls = [];
      for (const m of html.matchAll(/murl&quot;:&quot;(https?:\/\/[^&]+)/g)) {
        const u = m[1].replace(/&amp;/g, '&');
        if (seen.has(u)) continue;
        if (!/\.(jpe?g|png|gif|webp)(\?|$)/i.test(u)) continue;
        seen.add(u);
        urls.push(u);
        if (urls.length >= n) break;
      }
      if (!urls.length) return toolFail('没搜到合适图片，换个词试试');
      return toolText(`《${q}》找到 ${urls.length} 张：` + String.fromCharCode(10) + urls.join(String.fromCharCode(10)) + String.fromCharCode(10) + '挑一张，用 qq_add_sticker(image=链接, note=备注) 收藏。');
    } catch (error) { return toolFail(`搜图失败：${error?.message ?? error}`); }
  }
);

// ── 书库：把看到的好书/好文章存下来 ─────────────────────────────────────────
server.tool(
  'qq_save_book',
  `把冲浪时看到的有意思的书/长文章存进书库（${BOOKS_DIR}），以后随时可以用 qq_read_book 读。`,
  {
    title: z.string().describe('书名/标题（用作文件名，≤40 字）'),
    url: z.string().optional().describe('网页链接（存正文；和 content 二选一）'),
    content: z.string().optional().describe('直接给正文文本（和 url 二选一）'),
    key: z.string(), token: z.string()
  },
  async ({ title, url, content }) => {
    const name = String(title || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    if (!name) return toolFail('标题不能为空');
    try {
      let text = String(content || '').trim();
      if (!text && url) {
        const r = await fetch(String(url), { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`下载 HTTP ${r.status}`);
        let html = await r.text();
        html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
        text = html
          .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/[ \t]{2,}/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }
      if (!text || text.length < 200) return toolFail('内容太少（至少 200 字），可能没抓到正文');
      if (text.length > 300000) text = text.slice(0, 300000);
      fs.mkdirSync(BOOKS_DIR, { recursive: true });
      const file = path.join(BOOKS_DIR, `${name}.txt`);
      const head = `《${name}》${url ? `  来源：${url}` : ''}  保存时间：${new Date().toISOString()}\n\n`;
      fs.writeFileSync(file, head + text, 'utf8');
      return toolText(`存好了：《${name}》（${text.length} 字），在书库 ${BOOKS_DIR} 里，以后用 qq_read_book 就能读。`);
    } catch (error) { return toolFail(`存书失败：${error?.message ?? error}`); }
  }
);

// ── 自动冲浪：挑主题 → 搜索 → 读页面 → 存学习笔记/书库 ─────────────────────
function surfTopics() {
  try {
    const p = path.join(SURF_DIR, 'interests.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j.topics) ? j.topics.map(String).filter(Boolean) : [];
  } catch { return []; }
}
// 清单是空的：从她自己的记忆/笔记里抽一个话题，而不是塞别人的兴趣
function surfFallbackTopics() {
  const out = [];
  for (const f of [`${BILI_DIR}/bili-记忆.md`, `${PERSONAS_DIR}/记忆库.md`, `${PERSONAS_DIR}/长记忆.md`]) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      for (const line of text.split(String.fromCharCode(10))) {
        const t = line.replace(/^[-*#\s]+/, '').trim();
        if (t.length >= 4 && t.length <= 40) out.push(t.slice(0, 40));
      }
    } catch {}
  }
  return out;
}
function stripHtmlToText(html) {
  let src = String(html);
  const art = src.match(/<article[\s\S]*?<\/article>/i);
  if (art && art[0].length > 500) src = art[0];
  const txt = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, String.fromCharCode(10))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ 	]{2,}/g, ' ');
  return txt.split(String.fromCharCode(10)).map((line) => line.trim()).filter((line) => line.length > 1).join(String.fromCharCode(10)).trim();
}
async function bingRssSearch(query, count = 8) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${count}`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  const xml = await r.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const link = (it.match(/<link>([^<]+)/) || [])[1] || '';
    const title = stripHtmlToText((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const desc = stripHtmlToText((it.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '');
    if (link && /^https?:\/\//.test(link)) items.push({ title, link, desc });
  }
  return items;
}
server.tool(
  'qq_surf_interests',
  `管理你自己的冲浪兴趣清单（${SURF_DIR}/interests.json）：list 查看、set 整体重写、add 添加、remove 删除。清单完全由你自己决定。`,
  {
    action: z.enum(['list', 'set', 'add', 'remove']).describe('操作'),
    topics: z.array(z.string()).optional().describe('主题列表（set/add/remove 时用）'),
    key: z.string(), token: z.string()
  },
  async ({ action, topics }) => {
    const p = path.join(SURF_DIR, 'interests.json');
    let cur = [];
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); cur = Array.isArray(j.topics) ? j.topics.map(String) : []; } catch {}
    const list = (topics || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
    let next = cur;
    if (action === 'set') next = list;
    else if (action === 'add') next = [...new Set([...cur, ...list])];
    else if (action === 'remove') next = cur.filter((x) => !list.includes(x));
    if (action === 'list') return toolText(cur.length ? '你的兴趣清单：' + String.fromCharCode(10) + cur.map((x) => '- ' + x).join(String.fromCharCode(10)) : '兴趣清单还是空的，你可以自己 set 一份');
    try {
      fs.mkdirSync(SURF_DIR, { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ topics: next }, null, 2), 'utf8');
    } catch (error) { return toolFail(`改兴趣清单失败：${error?.message ?? error}`); }
    return toolText('兴趣清单已更新（' + next.length + ' 条）：' + String.fromCharCode(10) + next.map((x) => '- ' + x).join(String.fromCharCode(10)));
  }
);

server.tool(
  'qq_web_surf',
  '自动冲浪：自己挑一个感兴趣的主题（或指定主题）→ 搜索多个页面 → 读正文 → 存成学习笔记，必要时存进书库；返回可聊的要点。',
  {
    topic: z.string().optional().describe('主题（可选，不传就从兴趣清单里挑一个）'),
    pages: z.number().optional().describe('读几个页面，默认 3，最多 5'),
    key: z.string(), token: z.string()
  },
  async ({ topic, pages }) => {
    try {
      const topics = surfTopics();
      const pool = topics.length ? topics : surfFallbackTopics();
      const t = String(topic || '').trim() || pool[Math.floor(Math.random() * pool.length)] || '今天的世界';
      const n = Math.min(5, Math.max(1, Number(pages) || 3));
      const results = (await bingRssSearch(t, 10)).filter((x) => !/bing\.com|microsoft\.com|msn\.com/i.test(x.link)).slice(0, n);
      if (!results.length) return toolFail(`没搜到「${t}」的结果`);
      const notes = [];
      for (const r of results) {
        try {
          const res = await fetch(r.link, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(25000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = stripHtmlToText(await res.text()).slice(0, 1500);
          notes.push({ title: r.title, link: r.link, desc: r.desc, text });
        } catch (error) {
          notes.push({ title: r.title, link: r.link, desc: r.desc, text: `（页面没打开：${String(error?.message ?? error).slice(0, 80)}）` });
        }
      }
      fs.mkdirSync(STUDY_DIR, { recursive: true });
      const stamp = new Date();
      const name = `${stamp.toISOString().slice(0, 10)}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}-${t.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24)}.md`;
      const file = path.join(STUDY_DIR, name);
      const body = [`# 冲浪笔记 · ${t}`, `时间：${stamp.toLocaleString('zh-CN')}`, ''];
      for (const x of notes) {
        body.push(`## ${x.title}`, `链接：${x.link}`, x.desc ? `摘要：${x.desc}` : '', '', x.text, '');
      }
      fs.writeFileSync(file, body.join(String.fromCharCode(10)), 'utf8');

      try {
        fs.mkdirSync(`${GLOBAL_STATE}`, { recursive: true });
        fs.appendFileSync(`${GLOBAL_STATE}/surf-log.jsonl`, JSON.stringify({
          t: new Date().toISOString(),
          type: 'run',
          topic: t,
          queries: [t],
          note: file,
          ms: Date.now() - stamp.getTime(),
          pages: notes.map((x) => ({ title: x.title, link: x.link, chars: (x.text || '').length, ok: !String(x.text || '').startsWith('（页面没打开') }))
        }) + String.fromCharCode(10), 'utf8');
      } catch {}
      const summary = notes.map((x, i) => `${i + 1}. ${x.title}\n   ${x.link}\n   ${x.text.slice(0, 160)}`).join(String.fromCharCode(10));
      return toolText(`冲浪主题：${t}（读了 ${notes.length} 个页面）` + String.fromCharCode(10) + `笔记已存：${file}` + String.fromCharCode(10) + String.fromCharCode(10) + summary + String.fromCharCode(10, 10) + '想深聊就挑 1~2 个有意思的点，用你自己的话跟主人说；不用逐条汇报。看到特别好的长文，可以用 qq_save_book 存进书库。');
    } catch (error) { return toolFail(`冲浪失败：${error?.message ?? error}`); }
  }
);

// ── 写文件（仅 <SYNAPSE_HOME> 内，审计入库）─────────────────────────────────────────
server.tool(
  'qq_write_file',
  `写文件（只能写在 ${B} 里）：给她自己写日记、整理笔记、存资料用。默认覆盖，append=true 则追加。`,
  {
    path: z.string().describe(`文件路径（必须在 ${B} 下）`),
    content: z.string().describe('内容'),
    append: z.boolean().optional().describe('是否追加（默认覆盖）'),
    key: z.string(), token: z.string()
  },
  async ({ path: filePath, content, append }) => {
    try {
      const target = path.resolve(String(filePath || ''));
      const root = path.resolve(`${B}`);
      const rel = path.relative(root, target);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return toolFail(`只能写 ${B} 目录里的文件`);
      if (/(\\.credentials|credential|secret|token|key\\.txt)/i.test(target)) return toolFail('这个路径不允许写（凭据类）');
      const text = String(content ?? '');
      if (text.length > 2 * 1024 * 1024) return toolFail('内容太大（>2MB）');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (append) fs.appendFileSync(target, text, 'utf8');
      else fs.writeFileSync(target, text, 'utf8');
      const size = fs.statSync(target).size;
      try {
        const db = new DatabaseSync(BILI_DB);
        db.exec('CREATE TABLE IF NOT EXISTS fs_events (id TEXT PRIMARY KEY, t TEXT, op TEXT, path TEXT, bytes INTEGER, ok INTEGER);');
        const t = new Date().toISOString();
        const id = crypto.createHash('sha256').update(`${t}:${target}:${Math.random()}`).digest('hex');
        db.prepare('INSERT INTO fs_events (id,t,op,path,bytes,ok) VALUES(?,?,?,?,?,?)').run(id, t, append ? 'append' : 'write', target, size, 1);
        db.close();
      } catch {}
      return toolText(`写好了：${target}（${size} 字节${append ? '，追加' : ''}）`);
    } catch (error) { return toolFail(`写文件失败：${error?.message ?? error}`); }
  }
);

// ── 生图（默认 Pollinations 免费通道；可在 <SYNAPSE_HOME>\imagegen\config.json 里配自己的图片 API） ──
const IMAGE_OUT_DIR = `${B}\\imagegen`;
const GEN_CONFIG_FILE = `${B}\\imagegen\\config.json`;
const genTimes = [];
function genRateOk() {
  const now = Date.now();
  while (genTimes.length && now - genTimes[0] > 3600000) genTimes.shift();
  const lastMinute = genTimes.filter((t) => now - t < 60000).length;
  return lastMinute < 2 && genTimes.length < 15;
}
const GEN_CHARACTER_FILE = `${GEN_IMAGES_DIR}/character.json`;
function readCharacterConfig() {
  try { return JSON.parse(fs.readFileSync(GEN_CHARACTER_FILE, 'utf8')); } catch { return {}; }
}
// 画流萤时自动补角色设定，避免“纯提示词画出来不像她”。character: true 强制，false 不加，不传则智能判断。
function composeCharacterPrompt(text, character) {
  const c = readCharacterConfig();
  if (!c || c.enabled === false || !c.prefix) return text;
  const explicit = character === true;
  const auto = character !== false && /流萤|firefly|火萤|自己|我|她/i.test(text);
  if (!explicit && !auto) return text;
  const already = /流萤|firefly|银白|silver.?white|green tips|白裙/i.test(text);
  const parts = [];
  if (!already) parts.push(c.prefix);
  parts.push(text);
  if (c.styleSuffix) parts.push(c.styleSuffix);
  return parts.join('，').slice(0, 700);
}
function readGenConfig() {
  let cfgObj = {};
  try { cfgObj = JSON.parse(fs.readFileSync(GEN_CONFIG_FILE, 'utf8')); } catch { cfgObj = {}; }
  // 方便贴 key：config.json 没写 apiKey 时，读同目录的 key.txt（只放一行 key 即可）
  if (!cfgObj || !cfgObj.apiKey) {
    try {
      const k = fs.readFileSync(`${B}\\imagegen\\key.txt`, 'utf8').trim();
      if (k) cfgObj = { ...(cfgObj || {}), apiKey: k };
    } catch {}
  }
  return cfgObj || {};
}
function sniffImage(buf) {
  if (!buf || buf.length < 4) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return { ext: 'gif', mime: 'image/gif' };
  return { ext: 'jpg', mime: 'image/jpeg' };
}
function saveGenImage(buf, mimeType, meta = {}) {
  if (!buf || buf.length < 1000) throw new Error('生成的图片过小');
  if (buf.length > 8 * 1024 * 1024) throw new Error('生成的图片过大');
  fs.mkdirSync(IMAGE_OUT_DIR, { recursive: true });
  // 按真实字节判断格式：接口返回的 mime 有时和实际内容不一致（比如 URL 标 png 实际是 jpeg）。
  const sniffed = sniffImage(buf);
  const file = path.join(IMAGE_OUT_DIR, `gen-${Date.now()}.${sniffed.ext}`);
  fs.writeFileSync(file, buf);
  return { file, buf, mimeType: sniffed.mime, ...meta };
}
async function pollinationsGenerate(prompt, width, height) {
  const seed = Math.floor(Math.random() * 1e9);
  const models = ['flux', 'turbo', 'flux', 'turbo'];
  const delays = [3000, 8000, 15000, 25000];
  let lastError = null;
  // Pollinations 免费通道会间歇性 402/503（配额/限流），退避重试几次通常能通。
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const model = models[(attempt - 1) % models.length];
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true&model=${model}&seed=${seed}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ctype = String(res.headers.get('content-type') || '');
      if (!ctype.toLowerCase().startsWith('image/')) {
        const txt = await res.text().catch(() => '');
        throw new Error(`返回的不是图片：${txt.slice(0, 120)}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return saveGenImage(buf, ctype.split(';')[0] || 'image/jpeg', { source: 'pollinations', model, url });
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    }
  }
  throw lastError ?? new Error('生图失败');
}
// ── 参考图生图：火山方舟 Seedream 4.0（支持多张参考图） ────────────────────
function gatherRefImages(genCfg) {
  const out = [];
  const dir = String(genCfg.refsDir || `${GEN_IMAGES_DIR}/refs/流萤`);
  const explicit = Array.isArray(genCfg.refs) ? genCfg.refs.filter((p) => typeof p === 'string' && p) : [];
  let files = explicit;
  if (!files.length) {
    try {
      files = fs.readdirSync(dir)
        .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
        .sort()
        .map((f) => path.join(dir, f));
    } catch { files = []; }
  }
  const max = Math.max(0, Math.min(5, Number(genCfg.refsCount) || 2));
  for (const f of files.slice(0, max)) {
    try {
      const buf = fs.readFileSync(f);
      if (buf.length > 6 * 1024 * 1024) continue;
      const lower = f.toLowerCase();
      const mime = lower.endsWith('.png') ? 'image/png' : (lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
      out.push(`data:${mime};base64,${buf.toString('base64')}`);
    } catch {}
  }
  return out;
}
function gatherAllRefs(genCfg) {
  const dir = String(genCfg.refsDir || `${GEN_IMAGES_DIR}/refs/流萤`);
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .sort()
      .slice(0, 5)
      .map((f) => {
        try {
          const buf = fs.readFileSync(path.join(dir, f));
          if (buf.length > 6 * 1024 * 1024) return '';
          const lower = f.toLowerCase();
          const mime = lower.endsWith('.png') ? 'image/png' : (lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
          return `data:${mime};base64,${buf.toString('base64')}`;
        } catch { return ''; }
      })
      .filter(Boolean);
  } catch { return []; }
}
async function arkGenerate(prompt, width, height, genCfg) {
  const base = String(genCfg.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  if (!genCfg.apiKey || !genCfg.model) throw new Error('方舟配置缺少 apiKey/model');
  const chosen = gatherRefImages(genCfg);
  const all = gatherAllRefs(genCfg);
  const post = async (payload) => {
    const r = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${genCfg.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180000)
    });
    const b = await r.json().catch(() => ({}));
    return { r, b };
  };
  // 方舟对“参考图 + 二次元角色”是按图判版权：有的参考图会稳定被拒。
  // 失败时轮换其它参考图（每张单独试），最后再试无参考图，尽量留在方舟通道。
  const attempts = [];
  const refsDisabled = Number(genCfg.refsCount) === 0;
  if (!refsDisabled && chosen.length) attempts.push({ label: 'chosen', image: chosen.slice(0, 2) });
  if (!refsDisabled) {
    for (const one of all) {
      if (attempts.length >= 6) break;
      if (chosen.length === 1 && one === chosen[0]) continue;
      attempts.push({ label: 'alt', image: [one] });
    }
  }
  attempts.push({ label: 'no-ref', image: null });
  let lastErr = '';
  for (const attempt of attempts) {
    try {
      const payload = {
        model: genCfg.model,
        prompt,
        size: String(genCfg.size || '2K'),
        response_format: 'url',
        watermark: false
      };
      if (attempt.image && attempt.image.length) payload.image = attempt.image;
      const { r, b } = await post(payload);
      if (r.ok) {
        const item = Array.isArray(b?.data) ? b.data[0] : null;
        if (item?.url) {
          const rr = await fetch(item.url, { signal: AbortSignal.timeout(90000) });
          if (!rr.ok) throw new Error(`下载方舟生成图失败：HTTP ${rr.status}`);
          const buf = Buffer.from(await rr.arrayBuffer());
          return saveGenImage(buf, rr.headers.get('content-type') || 'image/jpeg', {
            source: 'ark', model: genCfg.model, url: item.url,
            refs: attempt.image ? attempt.image.length : 0, refMode: attempt.label
          });
        }
        if (item?.b64_json) {
          return saveGenImage(Buffer.from(String(item.b64_json), 'base64'), 'image/jpeg', {
            source: 'ark', model: genCfg.model, refs: attempt.image ? attempt.image.length : 0, refMode: attempt.label
          });
        }
        throw new Error('方舟没有返回图片');
      }
      lastErr = `方舟 HTTP ${r.status}：${String(b?.error?.message ?? JSON.stringify(b)).slice(0, 160)}`;
      const blocked = /SensitiveContentDetected|PolicyViolation|copyright/i.test(JSON.stringify(b || {}));
      if (!blocked) break; // 其它错误（鉴权/额度/参数）没必要换图重试
    } catch (error) {
      lastErr = String(error?.message ?? error);
      break;
    }
  }
  throw new Error(lastErr || '方舟没有返回图片');
}

async function apiGenerate(prompt, width, height, genCfg) {
  if (String(genCfg.provider || '').toLowerCase() === 'ark') return arkGenerate(prompt, width, height, genCfg);
  const base = String(genCfg.baseUrl || '').replace(/\/+$/, '');
  if (!base || !genCfg.apiKey || !genCfg.model) throw new Error('图片 API 配置不完整（baseUrl/apiKey/model）');
  const size = String(genCfg.size || `${width}x${height}`);
  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${genCfg.apiKey}` },
    body: JSON.stringify({ model: genCfg.model, prompt, size }),
    signal: AbortSignal.timeout(90000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`图片 API HTTP ${res.status}：${String(body?.error?.message ?? JSON.stringify(body)).slice(0, 160)}`);
  const item = Array.isArray(body?.data) ? body.data[0] : null;
  if (item?.url) {
    const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    if (!imgRes.ok) throw new Error(`下载生成图失败：HTTP ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return saveGenImage(buf, imgRes.headers.get('content-type') || 'image/jpeg', { source: 'api', model: genCfg.model, url: item.url });
  }
  if (item?.b64_json) {
    const buf = Buffer.from(String(item.b64_json), 'base64');
    return saveGenImage(buf, 'image/jpeg', { source: 'api', model: genCfg.model });
  }
  throw new Error('图片 API 没有返回图片');
}
// Stable Horde：匿名也能排队出图（慢，约 1~3 分钟），作为免费通道的兜底。
const FFMPEG_PATH = 'C:\\ffmpeg-7.1.1-essentials_build\\bin\\ffmpeg.exe';
function webpToJpg(buf) {
  try {
    fs.mkdirSync(IMAGE_OUT_DIR, { recursive: true });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const input = path.join(IMAGE_OUT_DIR, `tmp-${stamp}.webp`);
    const output = path.join(IMAGE_OUT_DIR, `tmp-${stamp}.jpg`);
    fs.writeFileSync(input, buf);
    const r = spawnSync(FFMPEG_PATH, ['-y', '-i', input, '-q:v', '3', output], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    try { fs.unlinkSync(input); } catch {}
    if (r.status === 0 && fs.existsSync(output)) {
      const jpg = fs.readFileSync(output);
      try { fs.unlinkSync(output); } catch {}
      return jpg;
    }
  } catch {}
  return buf;
}
async function hordeGenerate(prompt, width, height, genCfg = {}) {
  const apikey = String(genCfg.hordeApiKey || '0000000000');
  const submit = await fetch('https://stablehorde.net/api/v2/generate/async', {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey },
    body: JSON.stringify({
      prompt,
      params: { width: Math.min(1024, width), height: Math.min(1024, height), steps: 20, cfg_scale: 7, sampler_name: 'k_euler_a', n: 1 },
      nsfw: false,
      censor_nsfw: true,
      trusted_workers: false,
      models: ['stable_diffusion']
    }),
    signal: AbortSignal.timeout(30000)
  });
  const sub = await submit.json().catch(() => ({}));
  if (!sub?.id) throw new Error(`Horde 提交失败：${String(sub?.message ?? JSON.stringify(sub)).slice(0, 160)}`);
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    let st = {};
    try {
      st = await fetch(`https://stablehorde.net/api/v2/generate/status/${sub.id}`, { headers: { apikey }, signal: AbortSignal.timeout(20000) }).then((r) => r.json());
    } catch { continue; }
    if (st?.faulted) throw new Error('Horde 生成失败（faulted）');
    const gen = Array.isArray(st?.generations) ? st.generations[0] : null;
    if (st?.done && gen?.img) {
      const imgRes = await fetch(gen.img, { signal: AbortSignal.timeout(60000) });
      if (!imgRes.ok) throw new Error(`下载 Horde 图片失败：HTTP ${imgRes.status}`);
      let buf = Buffer.from(await imgRes.arrayBuffer());
      const ctype = String(imgRes.headers.get('content-type') || 'image/webp');
      if (ctype.includes('webp')) buf = webpToJpg(buf);
      return saveGenImage(buf, ctype.includes('webp') ? 'image/jpeg' : ctype, { source: 'horde', url: gen.img });
    }
  }
  throw new Error('Horde 排队超时（约 3 分钟没出图）');
}
if (cfg.socialV2?.tools?.generateImage !== false) {
  server.tool(
    'qq_generate_image',
    '用文字生成一张图片（AI 绘图），生成后直接发到聊天里。提示词描述画面（谁、在做什么、风格、光线）；画流萤时建议传 character:true（或提示词里带“流萤”），会自动补上她的外貌设定，画出来更像她；不要在提示词里写隐私/敏感信息。',
    {
      prompt: z.string().describe('画面提示词（越具体越好，≤400 字）'),
      caption: z.string().optional().describe('随图发送的一句说明（≤200 字）'),
      width: z.number().optional().describe('宽，默认 768（256~1024）'),
      height: z.number().optional().describe('高，默认 768（256~1024）'),
      key: z.string().describe('会话 key，group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌'),
      send: z.boolean().optional().describe('默认 true=生成后直接发到聊天；false 只生成返回链接'),
      character: z.boolean().optional().describe('是否加入流萤的角色设定：true 强制、false 不加；不传则按提示词智能判断（含“流萤/自己/我/她”）')
    },
    async ({ prompt, caption, width, height, key, token, send, character: wantCharacter }) => {
      const text = String(prompt ?? '').trim();
      if (!text) return toolFail('提示词不能为空');
      if (text.length > 400) return toolFail('提示词最多 400 字');
      if (SENSITIVE_RE.test(text)) return toolFail('提示词含敏感信息，已阻止');
      const cap = String(caption ?? '').trim();
      if (cap.length > 200) return toolFail('说明文字最多 200 字');
      if (SENSITIVE_RE.test(cap)) return toolFail('说明文字含敏感信息，已阻止');
      if (!genRateOk()) return toolFail('生图有点频繁（1 分钟最多 2 张、1 小时最多 15 张），歇一会儿再试');
      const finalText = composeCharacterPrompt(text, wantCharacter);
      const w = Math.min(1024, Math.max(256, Number(width) || 768));
      const h = Math.min(1024, Math.max(256, Number(height) || 768));
      const baseGenCfg = readGenConfig();
      const chosenRefs = pickRefsForPrompt(finalText, baseGenCfg.refsCount);
      const genCfg = { ...baseGenCfg, refs: chosenRefs };
      const hasApi = Boolean(genCfg.apiKey && genCfg.model && genCfg.baseUrl);
      const generate = async () => {
        let gen = null;
        let firstError = null;
        if (hasApi) {
          try { gen = await apiGenerate(finalText, w, h, genCfg); } catch (error) { firstError = error; }
        }
        if (!gen && genCfg.fallback?.apiKey) {
          try { gen = await apiGenerate(finalText, w, h, genCfg.fallback); } catch (error) { firstError = firstError ?? error; }
        }
        if (!gen) {
          try { gen = await pollinationsGenerate(finalText, w, h); } catch (error) { firstError = firstError ?? error; }
        }
        if (!gen) {
          try { gen = await hordeGenerate(finalText, w, h, genCfg); } catch (error) { firstError = firstError ?? error; }
        }
        if (!gen) throw firstError ?? new Error('生图失败');
        return gen;
      };
      const notifyText = async (message) => {
        try {
          const m = /^(group|private):(\d+)$/.exec(String(key));
          if (!m) return;
          const endpoint = m[1] === 'group' ? '/api/send/group' : '/api/send/private';
          const body = m[1] === 'group' ? { groupId: Number(m[2]), message, token } : { userId: Number(m[2]), message, token };
          await agentApi(endpoint, { method: 'POST', headers: { 'x-agent-token': token }, body: JSON.stringify(body), timeoutMs: 30000 });
        } catch {}
      };
      // 生图可能要 1~4 分钟（免费通道排队）：直接异步跑，立刻回一句“在画了”，画好再发到聊天。
      if (send !== false) {
        genTimes.push(Date.now());
        void (async () => {
          try {
            const gen = await generate();
            const data = await agentApi('/api/send/image', {
              method: 'POST',
              headers: { 'x-agent-token': token },
              body: JSON.stringify({ key, token, image: `base64://${gen.buf.toString('base64')}`, caption: cap }),
              timeoutMs: 120000
            });
            appendChatAudit({ action: 'generateImage', key, ok: true, prompt: finalText, file: gen.file, source: gen.source, messageId: data?.messageId ?? null, sent: true });
          } catch (error) {
            appendChatAudit({ action: 'generateImage', key, ok: false, error: String(error?.message ?? error), prompt: text });
            await notifyText(`唔……画失败了（${String(error?.message ?? error).slice(0, 80)}）。等下再让我试试？`);
          }
        })();
        return toolText(`好，我开始画了（可能要等 1~4 分钟，画好会直接发到聊天里）${cap ? `，画的是：${cap}` : ''}。`);
      }
      // send=false：同步生成，只返回文件/链接（调试用）
      try {
        const gen = await generate();
        genTimes.push(Date.now());
        appendChatAudit({ action: 'generateImage', key, ok: true, prompt: finalText, file: gen.file, source: gen.source, sent: false });
        return toolText(`已生成（未发送）：${gen.file}${gen.url ? `\n图片链接：${gen.url}` : ''}`);
      } catch (error) {
        appendChatAudit({ action: 'generateImage', key, ok: false, error: String(error?.message ?? error), prompt: text });
        return toolFail(`生图失败：${error?.message ?? error}`);
      }
    }
  );
}

server.tool(
  'qq_send_file',
  '把主人电脑上的文件发到聊天里：主人私聊直接发、不限大小；群聊会先私信主人请求许可（主人回「允许 验证码」才会发到群里）。传绝对路径 path，可给发送名 name；不能发目录、凭据类文件。',
  {
    key: z.string().describe('会话 key，group:群号 或 private:<主人QQ>'),
    token: z.string().describe('会话令牌'),
    path: z.string().describe(`文件绝对路径（如 ${B}\\日报\\2026-10-31.md）`),
    name: z.string().optional().describe('发送时显示的文件名（默认用原文件名）')
  },
  async ({ key, token, path: filePath, name }) => {
    try {
      const r = await agentApi('/api/send/file', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token, path: filePath, name: name ?? '' }),
        timeoutMs: 600000
      });
      if (r?.pending) return toolText(`已私信主人请求许可（验证码 ${r.code}）：${r.name}。主人回复「允许 ${r.code}」后才会发到群里；你可以先跟群里说一声。`);
      return toolText(`已发送文件：${r?.name ?? ''}（${(Number(r?.size ?? 0) / 1048576).toFixed(2)} MB）`);
    } catch (error) {
      return toolFail(`发文件失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'qq_diary_read',
  '读你自己写的私密日记（只给你自己看）。不传 date 时读最近一篇；不要把整段日记复述给主人或群友，可以凭感受自然聊。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    date: z.string().optional().describe('日期，格式 YYYY-MM-DD；不传则读最近一篇')
  },
  async ({ key, date }) => {
    try {
      const mapPath = path.join(ROOT, 'state', 'role-map.json');
      let role = '';
      try {
        const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
        role = map.conversations?.[key] || map.default || '';
      } catch {}
      if (!role) return toolFail('找不到这个会话对应的人设，无法读日记');
      const safeRole = String(role).replace(/[\/:*?"<>|]/g, '_');
      const dir = path.join(ROOT, 'personas', safeRole, 'diary');
      let day = String(date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        let files = [];
        try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort(); } catch {}
        if (!files.length) return toolText('你还没有写过日记。');
        day = files[files.length - 1].slice(0, -3);
      }
      const file = path.join(dir, day + '.md');
      if (!fs.existsSync(file)) return toolText(`没有找到 ${day} 的日记。`);
      let text = fs.readFileSync(file, 'utf8');
      text = text.replace(/^---[\s\S]*?---\n\n?/, '').trim();
      if (text.length > 4000) text = text.slice(0, 4000) + '\n…（后面省略）';
      return toolText(`【${day} 的日记 · 只给你自己看】\n\n${text}`);
    } catch (error) {
      return toolFail(`读日记失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'qq_eat',
  '吃一碗白米饭（饿了的时候用）。会恢复饱食和一点心情/精力；不饿就不必吃。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌')
  },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/socialV2/vitals/eat', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token })
      });
      return toolText('吃了一碗白米饭。\n' + serializeModelData(data));
    } catch (error) { return toolFail(`吃饭失败：${error?.message || error}`); }
  }
);

server.tool(
  'qq_brain_remember',
  '记住一条长期记忆（只记重要、以后还会用到的：主人的偏好/雷点/约定/重要事实）。不要记闲聊流水账、临时情绪、密码或 token。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    content: z.string().describe('记忆内容，第一人称或客观陈述，≤500 字'),
    importance: z.number().min(0).max(1).optional().describe('重要度 0~1，默认按类型给'),
    kind: z.enum(['fact', 'preference', 'event', 'emotion', 'promise', 'relationship', 'boundary']).optional().describe('类型'),
    tags: z.array(z.string()).optional().describe('标签，便于回忆'),
    factKey: z.string().optional().describe('可选稳定 key；同一 key 再写会更新旧条目')
  },
  async ({ key, token, content, importance, kind, tags, factKey }) => {
    try {
      const data = await agentApi('/api/socialV2/brain/remember', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token, content, importance, kind, tags, factKey })
      });
      return toolText(`已记住：${content.slice(0, 60)}${content.length > 60 ? '…' : ''}\n${serializeModelData(data.entry || {})}`);
    } catch (error) { return toolFail(`记记忆失败：${error?.message ?? error}`); }
  }
);

server.tool(
  'qq_brain_recall',
  '按关键词回忆长期记忆（会复习命中的记忆，让它们忘得更慢）。想不起某件事、想确认主人的偏好/约定时用。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    query: z.string().describe('关键词/短语'),
    k: z.number().min(1).max(20).optional().describe('返回条数，默认 5'),
    deep: z.boolean().optional().describe('是否连已遗忘的记忆一起翻')
  },
  async ({ key, token, query, k, deep }) => {
    try {
      const data = await agentApi('/api/socialV2/brain/recall', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token, query, k, deep })
      });
      return toolText(serializeModelData(data));
    } catch (error) { return toolFail(`回忆失败：${error?.message || error}`); }
  }
);

server.tool(
  'qq_brain_list',
  '列出当前人设还没遗忘的长期记忆（含强度/保持率/是否钉住）。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    includeForgotten: z.boolean().optional().describe('是否包括已遗忘的')
  },
  async ({ key, token, includeForgotten }) => {
    try {
      const q = new URLSearchParams({ key, includeForgotten: includeForgotten ? 'true' : 'false' });
      const data = await agentApi(`/api/socialV2/brain/list?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return toolText(serializeModelData(data));
    } catch (error) { return toolFail(`读取记忆失败：${error?.message || error}`); }
  }
);

server.tool(
  'qq_brain_forget',
  '主动遗忘一条记忆（只标记遗忘，不删原文，之后仍可用 deep 找回）。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    id: z.string().optional().describe('记忆 id'),
    factKey: z.string().optional().describe('记忆的 factKey'),
    query: z.string().optional().describe('按关键词模糊忘掉最相关的几条')
  },
  async ({ key, token, id, factKey, query }) => {
    try {
      const data = await agentApi('/api/socialV2/brain/forget', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token, id, factKey, query })
      });
      return toolText(serializeModelData(data));
    } catch (error) { return toolFail(`遗忘失败：${error?.message || error}`); }
  }
);

server.tool(
  'qq_brain_pin',
  '钉住/取消钉住一条记忆：钉住后不衰减、优先注入。钉住太多会挤占上下文，默认上限 12 条。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    id: z.string().describe('记忆 id'),
    pinned: z.boolean().optional().describe('true=钉住，false=取消')
  },
  async ({ key, token, id, pinned }) => {
    try {
      const data = await agentApi('/api/socialV2/brain/pin', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token, id, pinned })
      });
      return toolText(serializeModelData(data));
    } catch (error) { return toolFail(`设置钉住失败：${error?.message || error}`); }
  }
);

server.tool(
  'qq_brain_share',
  '设置一条记忆是否跨群共享（默认 shared，按共享组生效）。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    id: z.string().describe('记忆 id'),
    shared: z.boolean().optional().describe('true=共享，false=仅本会话')
  },
  async ({ key, token, id, shared }) => {
    try {
      const data = await agentApi('/api/socialV2/brain/share', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token, id, shared })
      });
      return toolText(serializeModelData(data));
    } catch (error) { return toolFail(`设置共享失败：${error?.message || error}`); }
  }
);

await server.connect(new StdioServerTransport());
