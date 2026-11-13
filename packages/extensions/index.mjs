/**
 * 扩展包注册表 —— 决定「哪些能力是裸机自带的，哪些要装」。
 *
 * 为什么要这份表：桥接原本把 91 个工具一次性全注册给模型。每多一个工具，
 * 模型每次请求都要收它的完整描述和参数 schema —— 这是按 token 计费的。
 * 用户多半只用聊天，却为 B 站、抖音、读书、生图这些工具的 schema 一直付钱。
 *
 * 所以这里划一条线：
 *   - 核心（CORE_TOOLS）：收发消息、主动唤醒、人设与记忆、多媒体消息。
 *     这些是「一个 QQ 角色」的最小完整形态，永远在线。
 *   - 扩展（PACKAGES）：B 站 / 抖音 / 空间 / 读书 / 睡镜计划 / 电脑助手 / 联网搜索……
 *     没装就不注册，装了才出现在模型的工具清单里。
 *
 * 新增工具时的铁律：必须归到核心或某个扩展，否则 validate() 会报出来，
 * 并且运行期按「未归属 = 不注册」处理。宁可少一个工具，也不要悄悄多烧 token。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../paths/index.mjs';

export const EXT_DIR = path.join(DATA, 'extensions');
export const STATE_FILE = path.join(DATA, 'extensions.json');

/** 裸机自带的能力：收发消息 / 主动唤醒 / 人设与记忆 / 多媒体消息。 */
export const CORE_TOOLS = [
  // ── 读消息与上下文 ──
  'qq_status',
  'qq_get_prompt',
  'qq_get_unread_messages',
  'qq_wait_for_messages',
  'qq_mark_read',
  'qq_get_recent_messages',
  'qq_get_my_recent_messages',
  'qq_get_message_detail',
  'qq_get_message_images',
  'qq_get_message_files',
  'qq_get_forward_msg',
  'qq_get_active_members',
  'qq_get_group_history',
  'qq_get_group_members',
  'qq_list_groups',
  'qq_list_group_files',
  'qq_get_self_image',

  // ── 发消息（文字 / 分条 / 图片 / 表情 / 语音 / 戳 / 文件 / 撤回） ──
  'qq_send_message',
  'qq_reply',
  'qq_send_private_message',
  'qq_send_group_message',
  'qq_send_burst',
  'qq_send_image',
  'qq_send_sticker',
  'qq_send_voice',
  'qq_tts_say',
  'qq_send_poke',
  'qq_send_file',
  'qq_emoji_like',
  'qq_recall_message',

  // ── 表情包与语音素材（发消息的弹药库） ──
  'qq_list_stickers',
  'qq_get_sticker_image',
  'qq_add_sticker',
  'qq_delete_sticker',
  'qq_collect_sticker',
  'qq_sticker_note',
  'qq_set_sticker_remark',
  'qq_list_voices',

  // ── 人设与记忆 ──
  'qq_set_nickname',
  'qq_set_bio',
  'qq_set_avatar',
  'qq_brain_remember',
  'qq_brain_recall',
  'qq_brain_forget',
  'qq_brain_list',
  'qq_brain_pin',
  'qq_brain_share',
  'qq_memory_append',
  'qq_memory_query',
  'qq_memory_remove',
  'qq_memory_clear',
  'qq_social_state',
  'qq_report_feedback',
  'qq_feature_request',

  // ── 主动唤醒 ──
  'qq_set_wake_config'
];

/**
 * 内置扩展。装 = 写一条安装记录（代码已在本地，不下载）；
 * 卸 = 删记录，工具立刻从模型清单里消失。
 *
 * mcpServers 仅对独立进程的扩展有意义：DSH 那边按安装状态决定挂不挂。
 */
export const PACKAGES = [
  {
    id: 'pc',
    name: '电脑助手',
    desc: '在你的电脑上查状态、找文件、读文件、截图、看余额。每次动手前都要你审批。',
    tools: ['qq_write_file'],
    mcpServers: [
      { id: 'mcp-pcops', serverName: 'pcops', script: 'mcp-pcops.js', toolCallTimeoutMs: 90000 }
    ],
    note: '只对主人私聊生效；范围限制在用户目录与常用盘符。'
  },
  {
    id: 'web',
    name: '联网搜索',
    desc: '上网查资料、看网页、搜图片，并记录它最近对什么感兴趣。',
    tools: ['qq_web_surf', 'qq_surf_interests', 'qq_search_images'],
    mcpServers: [
      { id: 'mcp-web-search-safe', serverName: 'web-search-safe', script: 'mcp-web-search-safe.js' }
    ]
  },
  {
    id: 'bili',
    name: 'B 站',
    desc: '搜视频、看热门、看视频内容、记笔记、收藏、发评论，还能从记忆里翻出看过的。',
    tools: [
      'qq_bili_comment', 'qq_bili_favorite', 'qq_bili_hot', 'qq_bili_memory_search',
      'qq_bili_note', 'qq_bili_search', 'qq_bili_video', 'qq_bili_watch'
    ]
  },
  {
    id: 'douyin',
    name: '抖音',
    desc: '刷抖音热门、看视频内容。',
    tools: ['qq_douyin_hot', 'qq_douyin_video', 'qq_douyin_watch']
  },
  {
    id: 'qzone',
    name: 'QQ 空间',
    desc: '看好友动态、发说说、点赞、评论、转发。配套一个定时发说说的后台服务。',
    tools: [
      'qq_qzone_comment_like', 'qq_qzone_delete', 'qq_qzone_delete_comment', 'qq_qzone_detail',
      'qq_qzone_feeds', 'qq_qzone_forward', 'qq_qzone_like', 'qq_qzone_moments',
      'qq_qzone_publish', 'qq_qzone_reply'
    ],
    services: [{ id: 'qzone', port: 0, autostart: false }],
    note: '后台服务不会随开机自启，避免每次开机就往外发内容。'
  },
  {
    id: 'sleep',
    name: '睡眠计划',
    desc: '安排作息：几点睡、几点醒，睡着期间不主动发消息。',
    tools: ['qq_sleep_plan']
  },
  {
    id: 'diary',
    name: '日记',
    desc: '读它自己写的日记。',
    tools: ['qq_diary_read']
  },
  {
    id: 'slang',
    name: '语料库',
    desc: '查网络流行语、把新词投稿进语料库。',
    tools: ['qq_slang_query', 'qq_slang_submit']
  },
  {
    id: 'reading',
    name: '读书',
    desc: '读书并保存进度、记读书笔记。',
    tools: ['qq_read_book', 'qq_save_book']
  },
  {
    id: 'ref',
    name: '参考图',
    desc: '收藏参考图、给图写备注，聊天时能翻出来用。',
    tools: ['qq_ref_gallery', 'qq_ref_note']
  },
  {
    id: 'eat',
    name: '吃喝',
    desc: '记录吃了什么、饿不饿，影响它的状态和说话方式。',
    tools: ['qq_eat']
  },
  {
    id: 'video',
    name: '刷视频',
    desc: '连续刷视频（比单次看一个更进一步）。',
    tools: ['qq_video_binge']
  },
  {
    id: 'imagegen',
    name: '生图',
    desc: '按描述生成图片并发给你。',
    tools: ['qq_generate_image'],
    note: '调用外部生图服务，会产生额外费用。'
  }
];

const CORE_SET = new Set(CORE_TOOLS);
const TOOL_OWNER = new Map();
for (const p of PACKAGES) {
  for (const t of p.tools) {
    if (TOOL_OWNER.has(t)) {
      // 重复归属是配置错误，不是运行时问题 —— 但也不该静默吞掉。
      console.warn(`[extensions] 工具重复归属：${t} 同时在 ${TOOL_OWNER.get(t)} 与 ${p.id}`);
    }
    TOOL_OWNER.set(t, p.id);
  }
}

export const PACKAGE_BY_ID = new Map(PACKAGES.map((p) => [p.id, p]));

/** 核心工具返回 'core'，属于某扩展返回包 id，未归属返回 null。 */
export function ownerOf(tool) {
  if (CORE_SET.has(tool)) return 'core';
  return TOOL_OWNER.get(tool) ?? null;
}

/**
 * 校验归属表是否覆盖了全部实际注册的工具。
 * 返回 { unknown, orphanPkgs }：
 *   unknown   —— 注册了但没归属的工具（运行期会被当成「不注册」）
 *   orphanPkgs —— 表里写了但实际不存在的工具（通常是被重命名或删掉了）
 */
export function validate(actualTools) {
  const actual = new Set(actualTools);
  const declared = new Set([...CORE_TOOLS, ...TOOL_OWNER.keys()]);
  return {
    unknown: [...actual].filter((t) => !declared.has(t)),
    orphanPkgs: [...declared].filter((t) => !actual.has(t))
  };
}

// ── 安装状态 ──────────────────────────────────────────────────────────────

function emptyState() {
  return { schema: 1, installed: {}, knownMcpIds: [] };
}

export function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      schema: 1,
      installed: j?.installed && typeof j.installed === 'object' ? j.installed : {},
      // 只增不减的账本：卸掉扩展后仍记得它用过哪些 MCP id，
      // 否则 DSH 配置里那条旧条目没人认领，会永远挂着一个连不上的 server。
      knownMcpIds: Array.isArray(j?.knownMcpIds) ? j.knownMcpIds : []
    };
  } catch {
    return emptyState();
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

export function isInstalled(id, state = readState()) {
  return Boolean(state.installed?.[id]);
}

export function install(id, meta = {}) {
  const pkg = PACKAGE_BY_ID.get(id);
  // 内置扩展必须在表里；远端扩展是自带 MCP server 的独立包，代码在 EXT_DIR 下，
  // 它的工具不经过桥接的注册表（否则每个远端扩展都得改这张表并重新发版）。
  if (!pkg && meta.source !== 'remote') throw new Error(`未知扩展：${id}`);
  const state = readState();
  state.installed[id] = {
    version: meta.version || '0.1.0',
    installedAt: new Date().toISOString(),
    source: meta.source || 'builtin'
  };
  const mcpIds = (pkg?.mcpServers || meta.mcpServers || []).map((m) => m.id).filter(Boolean);
  state.knownMcpIds = [...new Set([...(state.knownMcpIds || []), ...mcpIds])];
  writeState(state);
  return state;
}

export function uninstall(id) {
  const state = readState();
  delete state.installed[id];
  writeState(state);
  // 内置扩展的代码在 packages/ 里，EXT_DIR 下没有它的目录，删了也是空操作。
  // 远端下载的扩展目录在这里，卸载就该把代码一起清掉，否则留一堆死代码占地方。
  try { fs.rmSync(path.join(EXT_DIR, id), { recursive: true, force: true }); } catch {}
  return state;
}

/**
 * 这个工具现在该不该注册给模型。
 * 判断顺序：核心 → 扩展是否已装 → 老的 socialV2.tools 单工具开关（两者取交集）。
 *
 * legacyFlagFalse 由调用方传入（桥接知道 cfg），避免本模块依赖配置结构。
 */
export function toolEnabled(tool, opts = {}) {
  const owner = ownerOf(tool);
  if (owner === null) return false;          // 未归属：宁可不注册
  if (owner !== 'core') {
    const installed = opts.installed ?? readState().installed;
    if (!installed?.[owner]) return false;
  }
  if (opts.legacyFlagFalse === true) return false;
  return true;
}

/** 已装扩展对应的 MCP server 列表，供 DSH 配置生成使用。 */
export function activeMcpServers(state = readState()) {
  const out = [];
  for (const p of PACKAGES) {
    if (!state.installed?.[p.id]) continue;
    for (const m of p.mcpServers || []) out.push({ ...m, pkg: p.id });
  }
  // 远端扩展：配置在它自己的 manifest.json 里，脚本位于 data/extensions/<id>/。
  // 读不到 manifest 就当作没有 MCP —— 装了但文件坏了，宁可少挂一个，也不要挂个连不上的。
  for (const id of Object.keys(state.installed || {})) {
    if (PACKAGE_BY_ID.has(id)) continue;
    try {
      const dir = path.join(EXT_DIR, id);
      const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      for (const m of mf.mcpServers || []) out.push({ ...m, pkg: id, dir });
    } catch {}
  }
  return out;
}

/** 已装扩展涉及的后台服务（目前只有 QQ 空间用到）。 */export function activeServices(state = readState()) {
  const out = [];
  for (const p of PACKAGES) {
    if (!state.installed?.[p.id]) continue;
    for (const s of p.services || []) out.push({ ...s, pkg: p.id });
  }
  return out;
}

/**
 * 所有「归本程序管」的 MCP id，包括已卸掉的。
 * 用于清理 DSH 配置：只有认得某个 id 才敢删它，不认得的（用户自己配的 MCP）一律留着。
 */
export function declaredMcpIds(state = readState()) {
  const ids = new Set();
  for (const p of PACKAGES) for (const m of p.mcpServers || []) ids.add(m.id);
  for (const id of state.knownMcpIds || []) ids.add(id);
  return [...ids];
}

/** 给 UI 用的完整视图：每个扩展的元信息 + 是否已装。 */
export function list(state = readState()) {
  return PACKAGES.map((p) => ({
    id: p.id,
    name: p.name,
    desc: p.desc,
    note: p.note || '',
    tools: p.tools,
    toolCount: p.tools.length,
    builtin: p.builtin !== false,
    installed: Boolean(state.installed?.[p.id]),
    version: state.installed?.[p.id]?.version || '',
    installedAt: state.installed?.[p.id]?.installedAt || ''
  }));
}
