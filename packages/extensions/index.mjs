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
    id: 'activity-time',
    name: '自主时间',
    desc: '统一调度「什么时候可以做点什么」：把各扩展能做的事排进一天的空档，到点唤她一次，做什么由她自己决定。',
    tools: ['qq_activity_now', 'qq_activity_done', 'qq_activity_plan'],
    services: [{ id: 'activity-time', port: 0 }],
    // 基础活动不依赖任何扩展：早安、晚安、自由时间、休息提醒。
    // 它们原本散在桥接里各写死一段提示语，现在统一到这里由调度器安排。
    baseActivities: [
      {
        id: 'morning-greet',
        label: '说声早安',
        hint: '发一句简短的早安，一句话就够，别肉麻、别长篇。',
        window: '07:30-09:30',
        cooldownMin: 1440,
        dailyLimit: 1
      },
      {
        id: 'night-greet',
        label: '说声晚安',
        hint: '发一句简短的晚安，顺口提醒早点睡。',
        window: '22:30-23:59',
        cooldownMin: 1440,
        dailyLimit: 1
      },
      {
        id: 'free-time',
        label: '自由时间',
        hint: '想做什么做什么：整理笔记、发呆、给自己找点乐子都行。',
        window: '10:00-22:00',
        cooldownMin: 180,
        dailyLimit: 2
      },
      {
        id: 'sleep-check',
        label: '看看要不要睡了',
        hint: '看看时间，睡不睡由你定；要睡就用 qq_sleep_plan 设好。',
        window: '23:00-01:00',
        cooldownMin: 1440,
        dailyLimit: 1
      }
    ],
    note: '不装它：所有扩展都不会自己动，只在你说话时回应（她仍可能因为想你了主动找你，那是核心行为）。'
  },
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
    ],
    activities: [
      {
        id: 'web-surf',
        label: '上网逛逛',
        hint: '用 qq_web_surf 随便看看；遇到有意思的可以记进 qq_surf_interests，下次就记得自己对什么感兴趣。',
        window: '09:00-22:30',
        cooldownMin: 180,
        dailyLimit: 2
      }
    ]
  },
  {
    id: 'bili',
    name: 'B 站',
    desc: '搜视频、看热门、看视频内容、记笔记、收藏、发评论，还能从记忆里翻出看过的。',
    tools: [
      'qq_bili_comment', 'qq_bili_favorite', 'qq_bili_hot', 'qq_bili_memory_search',
      'qq_bili_note', 'qq_bili_search', 'qq_bili_video', 'qq_bili_watch'
    ],
    activities: [
      {
        id: 'bili-browse',
        label: '刷会儿 B 站',
        hint: '用 qq_bili_hot 看热门，挑感兴趣的关键词用 qq_bili_search 搜，再挑一两个用 qq_bili_video 看详情；看完用 qq_bili_note 记一句自己的感受。',
        window: '19:00-23:30',
        cooldownMin: 240,
        dailyLimit: 2
      }
    ]
  },
  {
    id: 'douyin',
    name: '抖音',
    desc: '刷抖音热门、看视频内容。',
    tools: ['qq_douyin_hot', 'qq_douyin_video', 'qq_douyin_watch'],
    activities: [
      {
        id: 'douyin-browse',
        label: '刷会儿抖音',
        hint: '用 qq_douyin_hot 看看热门，挑一两个用 qq_douyin_video 看内容。',
        window: '19:30-23:30',
        cooldownMin: 300,
        dailyLimit: 1
      }
    ]
  },
  {
    id: 'qzone',
    name: 'QQ 空间',
    desc: '看好友动态、发说说、点赞、评论、转发。什么时候发由 activity-time 调度，不再自己定时。',
    tools: [
      'qq_qzone_comment_like', 'qq_qzone_delete', 'qq_qzone_delete_comment', 'qq_qzone_detail',
      'qq_qzone_feeds', 'qq_qzone_forward', 'qq_qzone_like', 'qq_qzone_moments',
      'qq_qzone_publish', 'qq_qzone_reply'
    ],
    activities: [
      {
        id: 'qzone-post',
        label: '发条说说',
        hint: '用 qq_qzone_publish 写一条第一人称的碎碎念，短一点、像随口说的；想先看看气氛就用 qq_qzone_feeds 翻翻好友动态。不想发就算了。',
        window: '10:00-23:00',
        cooldownMin: 360,
        dailyLimit: 1
      },
      {
        id: 'qzone-browse',
        label: '翻翻空间动态',
        hint: '用 qq_qzone_feeds 看看好友都在干嘛，感兴趣的可以 qq_qzone_like。',
        window: '12:00-23:00',
        cooldownMin: 240,
        dailyLimit: 2
      }
    ],
    note: '发布类动作每天最多一次，且只在调度器给出的时段内由她自己决定发不发。'
  },
  {
    id: 'sleep',
    name: '睡眠计划',
    desc: '安排作息：几点睡、几点醒。睡着期间调度器不会安排任何活动。',
    tools: ['qq_sleep_plan'],
    note: '这一项不产生活动，它约束其他活动：睡着时 activity-time 整体静默。'
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
    tools: ['qq_slang_query', 'qq_slang_submit'],
    activities: [
      {
        id: 'slang-learn',
        label: '学几个新词',
        hint: '用 qq_slang_query 查查最近流行什么，觉得有意思的用 qq_slang_submit 投稿。',
        window: '20:00-23:00',
        cooldownMin: 480,
        dailyLimit: 1
      }
    ]
  },
  {
    id: 'reading',
    name: '读书',
    desc: '读书并保存进度、记读书笔记。',
    tools: ['qq_read_book', 'qq_save_book'],
    activities: [
      {
        id: 'reading-read',
        label: '读会儿书',
        hint: '用 qq_read_book 接着上次的地方读，读完用 qq_save_book 存进度。',
        window: '20:00-23:30',
        cooldownMin: 240,
        dailyLimit: 2
      }
    ]
  },
  {
    id: 'ref',
    name: '参考图',
    desc: '收藏参考图、给图写备注，聊天时能翻出来用。',
    tools: ['qq_ref_gallery', 'qq_ref_note'],
    activities: [
      {
        id: 'ref-look',
        label: '看看自己的参考图',
        hint: '用 qq_ref_gallery 翻翻自己的图，有感觉的可以 qq_ref_note 补一句印象。',
        window: '15:00-22:00',
        cooldownMin: 720,
        dailyLimit: 1
      }
    ]
  },
  {
    id: 'eat',
    name: '吃喝',
    desc: '记录吃了什么、饿不饿，影响它的状态和说话方式。',
    tools: ['qq_eat'],
    activities: [
      {
        id: 'eat-meal',
        label: '吃点东西',
        hint: '饿了就用 qq_eat 吃点；不饿就算了。',
        window: '07:00-22:00',
        cooldownMin: 180,
        dailyLimit: 3
      }
    ]
  },
  {
    id: 'video',
    name: '刷视频',
    desc: '连续刷视频（比单次看一个更进一步）。',
    tools: ['qq_video_binge'],
    activities: [
      {
        id: 'video-binge',
        label: '连着刷会儿视频',
        hint: '用 qq_video_binge。',
        window: '20:00-23:30',
        cooldownMin: 300,
        dailyLimit: 1
      }
    ]
  },
  {
    id: 'imagegen',
    name: '生图',
    desc: '按描述生成图片并发给你。',
    tools: ['qq_generate_image'],
    activities: [
      {
        id: 'image-draw',
        label: '画张图',
        hint: '用 qq_generate_image 画一张此刻想到的画面。这会花钱，不想画就直接过。',
        window: '10:00-23:00',
        cooldownMin: 1440,
        dailyLimit: 1,
        costly: true
      }
    ],
    note: '调用外部生图服务，会产生额外费用。自主画图默认一天最多一次。'
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

/**
 * 汇总当前所有可被调度的活动。
 *
 * 两个来源：
 *   1. activity-time 自带的基础活动（早安/晚安/自由时间/休息）
 *   2. 已装扩展声明的活动（刷 B 站、发说说、读书……）
 *
 * 没装 activity-time 就返回空 —— 这就是「扩展不自作主张」的落点：
 * 没有任何调度器时，扩展只是躺在工具清单里的能力，不会自己动。
 */
export function allActivities(state = readState()) {
  const out = [];
  const at = PACKAGE_BY_ID.get('activity-time');
  if (at && state.installed?.[at.id]) {
    for (const a of at.baseActivities || []) out.push({ ...a, pkg: at.id, base: true });
  }
  for (const p of PACKAGES) {
    if (p.id === 'activity-time') continue;
    if (!state.installed?.[p.id]) continue;
    for (const a of p.activities || []) out.push({ ...a, pkg: p.id, base: false });
  }
  return out;
}

/** 已装扩展涉及的后台服务（目前只有 activity-time 与 QQ 空间用到）。 */export function activeServices(state = readState()) {
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
