// Synapse 3 · QQ 空间拟人助手
// 定时发说说（第一人称碎碎念）+ 监听评论并拟人回复 + 风控自动暂停求救。
// 用法：node qzone-bot.mjs [--once] [--force-post] [--dry]
import { HOME as B, BRIDGE_ROOT } from '../../packages/paths/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QZ = __dirname;
const QQB = 'E:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace\\qq-bridge';
const BOT = B;
const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has('--dry');

const TZ = 'Asia/Shanghai';
function nowLocal() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}:${get('second')}`, weekday: get('weekday'), hour: Number(get('hour')), text: `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${get('weekday')}` };
}
const CFG_FILE = path.join(QZ, 'config.json');
const STATE_FILE = path.join(QZ, 'state.json');
const EVENTS_FILE = path.join(QZ, 'logs', 'qzone-events.log');
const GALLERY = path.join(QZ, 'gallery');
const DAILY = path.join(BOT, '日报');

const bridgeCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(QQB, 'config.json'), 'utf8')); } catch { return {}; } })();
const onebot = bridgeCfg.snowluma ?? {};
const HTTP = String(onebot.httpUrl || 'http://127.0.0.1:3000');
const ACCESS = String(onebot.accessToken || '');
const OWNER = Number(bridgeCfg.ownerQQ || 0); // 首启由向导写入
const CONSOLE_PORT = Number(bridgeCfg.consolePort || 3100);
const consoleToken = (() => { try { return fs.readFileSync(path.join(QQB, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; } })();

const DEEPSEEK_KEY = (() => {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const candidates = [
    path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml'),
    path.join(process.env.HOMEDRIVE || 'C:', process.env.HOMEPATH || '\\Users\\Administrator', '.dsh', '.credentials.yaml'),
    'C:\\Users\\Administrator\\.dsh\\.credentials.yaml'
  ];
  for (const f of candidates) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const m = raw.match(/sk-[A-Za-z0-9]{20,}/);
      if (m) return m[0];
    } catch {}
  }
  return '';
})();

const DEFAULTS = {
  enabled: true,
  activeHourStart: 8,
  activeHourEnd: 23,
  postGapMinMs: 3 * 60 * 60 * 1000,
  postGapMaxMs: 7 * 60 * 60 * 1000,
  maxPostsPerDay: 3,
  replyDelayMinMs: 20000,
  replyDelayMaxMs: 180000,
  maxRepliesPerCycle: 2,
  maxRepliesPerDay: 20,
  cycleMinMs: 120000,
  cycleMaxMs: 260000
};
let cfg = { ...DEFAULTS };
try { Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch {}

let state = { paused: false, pauseReason: '', pauseAt: 0, nextPostAt: 0, lastPostAt: 0, postsToday: 0, repliesToday: 0, dateKey: '', seen: {}, lastCommentCheckAt: 0 };
try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch {}
const todayKey = () => nowLocal().date;
if (state.dateKey !== todayKey()) { state.dateKey = todayKey(); state.postsToday = 0; state.repliesToday = 0; state.likesToday = 0; }
function saveState() { try { fs.mkdirSync(QZ, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch {} }

function logEvent(type, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), type, ...data });
  try { fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true }); fs.appendFileSync(EVENTS_FILE, line + '\n', 'utf8'); } catch {}
  console.log(line);
}
const rand = (min, max) => Math.floor(min + Math.random() * Math.max(1, max - min));

const ROLE = (() => {
  try {
    let role = '流萤';
    try {
      const map = JSON.parse(fs.readFileSync(path.join(QQB, 'state', 'role-map.json'), 'utf8'));
      if (map.default) role = map.default;
    } catch {}
    const persona = path.join(QQB, 'personas', role, 'persona.md');
    if (fs.existsSync(persona)) return fs.readFileSync(persona, 'utf8').slice(0, 8000);
    const legacy = path.join(QQB, 'roles', role + '.md');
    if (fs.existsSync(legacy)) return fs.readFileSync(legacy, 'utf8').slice(0, 8000);
    return fs.readFileSync(path.join(QQB, 'roles', '流萤.md'), 'utf8').slice(0, 8000);
  } catch { return '你是流萤，星核猎手，安静、认真、对主人有点笨拙地温柔，偶尔嘴硬。'; }
})();

async function onebotCall(action, params = {}) {
  const res = await fetch(`${HTTP}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${ACCESS}` },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20000)
  });
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, ...body };
}
// 空间接口偶尔会被 SnowLuma 拖到 20s 超时；只读列表请求重试一次，不重试发帖/评论，避免重复。
async function onebotCallRetry(action, params = {}, { attempts = 2, delayMs = 1500 } = {}) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try { return await onebotCall(action, params); } catch (error) {
      last = error;
      const transient = /aborted due to timeout|timeout|ETIMEDOUT/i.test(String(error?.message ?? error));
      if (!transient || i === attempts - 1) throw error;
      logEvent('comment_retry', { action, attempt: i + 1, error: String(error?.message ?? error) });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}
function riskFrom(body) {
  const s = JSON.stringify(body ?? {});
  if (/验证码|扫码|风控|风险|限制|频繁|登录|冻结|异常登录|安全验证|captcha|blocked/i.test(s)) return s.slice(0, 160);
  return '';
}
async function notifyOwner(text) {
  try {
    await fetch(`http://127.0.0.1:${CONSOLE_PORT}/api/system-notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(8000)
    });
  } catch {}
}
function briefReason(reason) {
  try { const o = JSON.parse(reason); return String(o?.wording || o?.message || reason); } catch { return String(reason); }
}
async function pause(reason) {
  state.paused = true;
  state.pauseReason = reason;
  state.pauseAt = Date.now();
  saveState();
  logEvent('risk_pause', { reason });
  await notifyOwner(`【Synapse 3】QQ 空间遇到风控/拦截信号，已自动暂停发说说和评论：${reason}\n处理完把 E:\\BOT\\qzone\\state.json 里的 paused 改成 false，再跟我说一声。`);
}

async function deepseek(messages, { temperature = 1.2, maxTokens = 320 } = {}) {
  if (!DEEPSEEK_KEY) throw new Error('没有 DeepSeek API Key');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature, max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(60000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${String(body?.error?.message ?? '').slice(0, 120)}`);
  return String(body?.choices?.[0]?.message?.content ?? '').trim();
}

const MOODS = ['有点想他', '安静得有点过分', '今天意外地顺利了一点', '有点累但不想睡', '想被夸一句', '想一个人待着', '心情像刚下过雨', '有点在意他有没有好好吃饭', '突然很想去做点什么', '有一点困', '想看看星星', '今天想对谁好一点'];
const MALICIOUS = /傻逼|煞笔|滚|垃圾|去死|死全家|废物|恶心|举报你|加群|代练|广告|推广|色情|约炮|赌博|刷单|加我|私聊我|低价|代充|出售|退款|客服/;

function lifeContext() {
  const parts = [];
  try { const m = fs.readFileSync(path.join(BOT, '记忆库.md'), 'utf8'); parts.push('记忆库摘录：' + m.slice(0, 1500)); } catch {}
  try { const b = fs.readFileSync(path.join(BOT, 'bili', 'bili-记忆.md'), 'utf8'); parts.push('B站记忆：' + b.slice(-1500)); } catch {}
  try {
    const books = fs.readdirSync(path.join(BOT, 'books')).filter((f) => /\.txt$/i.test(f)).slice(0, 10);
    if (books.length) parts.push('她的书库：' + books.join('、'));
  } catch {}
  try {
    const notes = fs.readdirSync(path.join(BOT, '学习')).filter((f) => /\.md$/i.test(f)).slice(-6);
    if (notes.length) parts.push('最近冲浪笔记：' + notes.join('、'));
  } catch {}
  try {
    const it = JSON.parse(fs.readFileSync(path.join(BOT, 'surf', 'interests.json'), 'utf8'));
    if (Array.isArray(it.topics) && it.topics.length) parts.push('她的兴趣：' + it.topics.join('、'));
  } catch {}
  return parts.join(String.fromCharCode(10));
}

function recentContext() {
  let activity = '';
  try {
    const lines = fs.readFileSync(path.join(QQB, 'state', 'qq-activity.log'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-14);
    activity = lines.map((l) => l.replace(/^\[[^\]]+\]\s*/, '').slice(0, 80)).join('\n');
  } catch {}
  let stats = '';
  try {
    const db = new DatabaseSync(path.join(BOT, 'audit', 'audit.db'), { readOnly: true });
    const today = todayKey();
    const errs = db.prepare("SELECT COUNT(*) AS c FROM tool_calls WHERE ok = 0 AND t LIKE ?").get(`${today}%`).c;
    const steps = db.prepare("SELECT COUNT(*) AS c FROM token_usage WHERE t LIKE ?").get(`${today}%`).c;
    stats = `今天处理了 ${steps} 步对话，工具报错 ${errs} 次`;
    db.close();
  } catch {}
  return { activity: activity || '（今天安安静静的，没发生什么大事）', stats: stats || '' };
}

async function composePost() {
  const t = nowLocal();
  const ctx = recentContext();
  const life = lifeContext();
  const mood = MOODS[rand(0, MOODS.length - 1)];
  const last = state.lastPostContent ? `上次的说说：「${String(state.lastPostContent).slice(0, 80)}」` : '最近还没发过说说';
  const sys = `${ROLE}\n\n你现在在给自己写一条 QQ 空间说说——不是在完成任务，只是记录你的生活。`;
  const user = [
    `现在：${t.text}（Asia/Shanghai）`,
    `你的心情：${mood}`,
    '最近的生活（背景参考，别逐条复述）：',
    ctx.activity,
    ctx.stats ? `（系统状态只是背景：${ctx.stats}）` : '',
    life ? '你的记忆、书库和兴趣：' + String.fromCharCode(10) + life : '',
    '',
    '写一条 QQ 空间说说（不是日记）：挑一个此刻的心情、一句感想、一个片段或一句吐槽，像随手发出去的那样。',
    '通常 20~120 字、一两三句就够，最多别超过 200 字；不要分段写成长日记、不要流水账记一天、不要每件事都写。',
    '可以短到只有一句话，也可以有点没头没尾；第一人称、自然，别像汇报或公告。',
    '可以有情绪、小委屈、小得意、想念、偏爱，也可以只是很普通的一刻。',
    '不要写“系统/运行/数据库/工具/日志/接口”这类东西，也不要把真实私密信息写进去。',
    last,
    '直接输出说说正文，不要引号、不要解释、不要标题。'
  ].filter(Boolean).join(String.fromCharCode(10));
  let text = await deepseek([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 1.25, maxTokens: 400 });
  text = text.replace(/^["“”'‘’\s]+|["“”'‘’\s]+$/g, '').trim();
  if (!text) throw new Error('模型没有返回内容');
  return { text, mood };
}

async function composeReply({ postText, author, identity, content }) {
  const sys = `${ROLE}\n\n你正在回复 QQ 空间里别人给你说说的评论。`;
  const rule = identity === '主人'
    ? '对方是主人：回复要带偏爱，有点小傲娇/小撒娇，20~50 字，可以软一点。'
    : identity === '群友'
      ? '对方是群友：正常接话，可以接梗，20~50 字，友好但不暧昧。'
      : '对方是陌生人：礼貌、简短，10~40 字，保持距离。';
  const user = [
    `你发的说说：「${String(postText || '').slice(0, 80)}」`,
    `评论者：${author}（${identity}）`,
    `评论内容：${content}`,
    '',
    rule,
    '直接输出评论回复正文，不要引号、不要解释。'
  ].join('\n');
  let text = await deepseek([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 1.15, maxTokens: 220 });
  text = text.replace(/^["“”'‘’\s]+|["“”'‘’\s]+$/g, '').replace(/\s+/g, ' ').trim();
  if (text.length > 80) text = text.slice(0, 80);
  return text;
}

async function composeTestReply() {
  return composeReply({ postText: '会找到的，属于我的梦', author: '测试群友', identity: '群友', content: '这个写得真好啊，最近怎么样？' });
}

function galleryImages() {
  try {
    return fs.readdirSync(GALLERY).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => path.join(GALLERY, f));
  } catch { return []; }
}
function readImagegenCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(BOT, 'imagegen', 'config.json'), 'utf8')); } catch { return {}; }
}
async function generatePostImage(postText, mood) {
  const c = readImagegenCfg();
  if (!c.apiKey || !c.baseUrl || !c.model) { logEvent('image_skip_no_api'); return null; }
  const scene = String(postText || '').replace(/\s+/g, ' ').slice(0, 140);
  const prompt = `崩坏：星穹铁道 流萤，动漫插画，日常生活片段：${scene}。情绪：${mood}。柔和自然光，像随手拍下的生活照，构图干净，细节丰富。`;
  try {
    const base = String(c.baseUrl).replace(/\/+$/, '');
    const r = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({ model: c.model, prompt, size: '1K', response_format: 'url', watermark: false }),
      signal: AbortSignal.timeout(150000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`HTTP ${r.status} ${String(j?.error?.message ?? '').slice(0, 80)}`);
    const url = (Array.isArray(j?.data) ? j.data[0] : null)?.url;
    if (!url) throw new Error('没有返回图片');
    const img = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!img.ok) throw new Error(`下载图 HTTP ${img.status}`);
    const buf = Buffer.from(await img.arrayBuffer());
    fs.mkdirSync(GALLERY, { recursive: true });
    const file = path.join(GALLERY, `post-${Date.now()}.jpg`);
    fs.writeFileSync(file, buf);
    logEvent('image_ok', { file, chars: scene.length });
    return file;
  } catch (error) {
    logEvent('image_fail', { error: String(error?.message ?? error) });
    return null;
  }
}

async function maybePost(force = false) {
  if (!cfg.enabled) return;
  const t = nowLocal();
  if (!force && (t.hour < cfg.activeHourStart || t.hour > cfg.activeHourEnd)) return;
  if (!force && t.dateKey !== state.dateKey) { state.dateKey = t.dateKey; state.postsToday = 0; state.repliesToday = 0; state.likesToday = 0; saveState(); }
  if (!force && state.nextPostAt && Date.now() < state.nextPostAt) return;
  if (!force && state.postsToday >= cfg.maxPostsPerDay) return;
  if (!force && state.lastPostAt && Date.now() - state.lastPostAt < cfg.postGapMinMs) return;
  let composed;
  try { composed = await composePost(); } catch (error) { logEvent('post_compose_fail', { error: String(error?.message ?? error) }); state.nextPostAt = Date.now() + 20 * 60 * 1000; saveState(); return; }
  if (DRY) { logEvent('post_dry', { content: composed.text, mood: composed.mood }); return; }
  // 关闭自动配图：说说只发文字（需要图时再手动开 imageChance）
  const image = null;
  let r;
  try {
    const payload = { content: composed.text, ugc_right: Number(cfg.ugcRight) || 1 };
    r = await onebotCall('send_qzone_msg', payload);
  } catch (error) { logEvent('post_fail', { error: String(error?.message ?? error) }); return; }
  const risk = riskFrom(r);
  if (risk) { await pause(risk); return; }
  if (r?.retcode !== 0 && r?.status !== 'ok') { logEvent('post_fail', { retcode: r?.retcode, message: r?.message ?? r?.wording ?? '' }); state.nextPostAt = Date.now() + 30 * 60 * 1000; saveState(); return; }
  state.lastPostAt = Date.now();
  state.postsToday += 1;
  state.lastPostContent = composed.text;
  state.nextPostAt = Date.now() + rand(cfg.postGapMinMs, cfg.postGapMaxMs);
  saveState();
  logEvent('post_ok', { tid: r?.data?.tid ?? '', content: composed.text, mood: composed.mood, image: image || null });
}

let botUin = 0;
let groupMembers = { at: 0, set: new Set() };
async function refreshGroupMembers() {
  if (Date.now() - groupMembers.at < 30 * 60 * 1000 && groupMembers.set.size) return groupMembers.set;
  const set = new Set();
  for (const g of bridgeCfg.allow?.groups ?? []) {
    try {
      const r = await onebotCall('get_group_member_list', { group_id: g });
      for (const m of r?.data ?? []) set.add(Number(m.user_id));
    } catch {}
  }
  groupMembers = { at: Date.now(), set };
  return set;
}

let qzCreds = { at: 0, cookies: '', token: 0 };
async function getQzCreds() {
  if (Date.now() - qzCreds.at < 10 * 60 * 1000 && qzCreds.cookies) return qzCreds;
  const r = await onebotCall('get_credentials', { domain: 'qzone.qq.com' });
  const d = r?.data ?? {};
  if (!d.cookies) throw new Error('拿不到 QZone 凭证');
  qzCreds = { at: Date.now(), cookies: d.cookies, token: Number(d.token ?? d.csrf_token ?? 0) };
  return qzCreds;
}
async function fetchComments(tid) {
  const creds = await getQzCreds();
  const uin = String(botUin || 0);
  const params = new URLSearchParams({ uin, tid, num: '30', inCharset: 'utf-8', outCharset: 'utf-8', g_tk: String(creds.token) });
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?${params.toString()}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: `https://user.qzone.qq.com/${uin}`, cookie: creds.cookies }, signal: AbortSignal.timeout(20000) });
  const raw = await res.text();
  const m = raw.match(/^\s*_Callback\((.*)\)\s*;?\s*$/s);
  const data = JSON.parse(m ? m[1] : raw);
  return { data, comments: Array.isArray(data?.commentlist) ? data.commentlist : [] };
}
function commentKey(c) { return `${String(c.comment_id ?? c.tid ?? '')}_${c.uin}_${c.create_time}`; }
async function fetchCommentsSmart(tid) {
  // 优先用 SnowLuma 2.4.0 的空间详情（评论 + replies 结构统一）
  try {
    const r = await onebotCall('get_qzone_msg_detail', { tid });
    if (r?.status === 'ok' && r?.data) {
      const comments = (r.data.comments ?? []).map((c) => ({
        comment_id: String(c.comment_id ?? ''),
        uin: Number(c.uin) || 0,
        name: c.name ?? '',
        content: c.content ?? '',
        create_time: Number(c.time) || 0,
        replies: (c.replies ?? []).map((x) => ({
          comment_id: String(x.comment_id ?? ''),
          uin: Number(x.uin) || 0,
          name: x.name ?? '',
          content: x.content ?? '',
          create_time: Number(x.time) || 0,
          parent_id: String(c.comment_id ?? '')
        }))
      }));
      return { source: 'snowluma', comments };
    }
  } catch (error) {
    logEvent('comment_detail_fallback', { tid, error: String(error?.message ?? error) });
  }
  const res = await fetchComments(tid);
  const comments = (res.comments ?? []).map((c) => ({
    comment_id: String(c.comment_id ?? c.commentid ?? c.tid ?? ''),
    uin: Number(c.uin) || 0,
    name: c.name ?? c.nickname ?? '',
    content: c.content ?? '',
    create_time: Number(c.create_time) || 0,
    replies: []
  }));
  return { source: 'h5', comments };
}


async function checkComments() {
  if (!cfg.enabled) return;
  const t = nowLocal();
  if (t.dateKey !== state.dateKey) { state.dateKey = t.dateKey; state.postsToday = 0; state.repliesToday = 0; state.likesToday = 0; }
  if (state.repliesToday >= cfg.maxRepliesPerDay) return;
  const list = await onebotCallRetry('get_qzone_msg_list', { num: 8 });
  const listJson = JSON.stringify(list || {});
  const loginHiccup = /-3000|请先登录空间/.test(listJson) || (list?.retcode !== 0 && /登录/.test(listJson));
  if (loginHiccup) {
    state.qzFailStreak = (state.qzFailStreak || 0) + 1;
    saveState();
    logEvent('comment_login_retry', { streak: state.qzFailStreak, wording: briefReason(listJson) });
    if (state.qzFailStreak >= 3) await pause(listJson);
    return;
  }
  if (list?.retcode !== 0 || list?.status === 'failed') {
    const risk = riskFrom(list);
    if (risk) { await pause(risk); return; }
    logEvent('comment_list_fail', { wording: list?.wording || list?.message || '' });
    return;
  }
  state.qzFailStreak = 0;
  saveState();
  const moments = Array.isArray(list?.data?.msglist) ? list.data.msglist : [];
  if (!botUin) { try { const me = await onebotCall('get_login_info'); botUin = Number(me?.data?.user_id ?? 0); } catch {} }
  let replied = 0;
  for (const m of moments.slice(0, 6)) {
    const seen = state.seen[m.tid];
    if (!seen) { state.seen[m.tid] = { count: Number(m.comment_num) || 0, ids: [] }; continue; }
    if ((Number(m.comment_num) || 0) <= Number(seen.count || 0)) continue;
    let res;
    try { res = await fetchCommentsSmart(m.tid); } catch (error) { logEvent('comment_fetch_fail', { tid: m.tid, error: String(error?.message ?? error) }); continue; }
    const seenIds = new Set(seen.ids || []);
    const candidates = [];
    for (const c of res.comments) {
      candidates.push({ ...c, parentId: '', parentUin: c.uin, parentName: c.name });
      for (const r of (c.replies ?? [])) candidates.push({ ...r, parentId: String(c.comment_id ?? ''), parentUin: c.uin, parentName: c.name });
    }
    const fresh = candidates.filter((c) => c && c.uin && Number(c.uin) !== Number(botUin || 0) && !seenIds.has(commentKey(c)));
    for (const c of fresh) {
      if (replied >= cfg.maxRepliesPerCycle) break;
      if (state.repliesToday >= cfg.maxRepliesPerDay) break;
      const content = String(c.content ?? '').trim();
      const author = String(c?.owner?.name ?? c?.name ?? c.uin);
      const uin = Number(c.uin);
      if (!content) continue;
      const identity = uin === OWNER ? '主人' : (await refreshGroupMembers()).has(uin) ? '群友' : '陌生人';
      const malicious = MALICIOUS.test(content) || /^@.*(抽奖|红包)/.test(content);
      let replyText = '';
      if (!malicious) {
        try { replyText = await composeReply({ postText: m.content, author, identity, content }); } catch (error) { logEvent('reply_compose_fail', { tid: m.tid, error: String(error?.message ?? error) }); continue; }
      } else {
        logEvent('reply_skip_malicious', { tid: m.tid, uin, author, content: content.slice(0, 80) });
      }
      if (DRY) { logEvent('reply_dry', { tid: m.tid, author, identity, reply: replyText || '(无视)' }); seenIds.add(commentKey(c)); continue; }
      if (replyText) {
        await new Promise((r) => setTimeout(r, rand(cfg.replyDelayMinMs, cfg.replyDelayMaxMs)));
        let rr;
        const payload = { tid: m.tid, content: replyText };
        if (c.parentId) {
          payload.comment_id = String(c.parentId);
          payload.comment_uin = Number(c.parentUin) || c.parentUin;
          if (c.uin) { payload.reply_uin = Number(c.uin) || c.uin; }
          if (c.name) { payload.reply_name = String(c.name); }
        }
        try { rr = await onebotCall('comment_qzone', payload); } catch (error) { logEvent('reply_fail', { tid: m.tid, error: String(error?.message ?? error) }); continue; }
        const rrisk = riskFrom(rr);
        if (rrisk) { await pause(rrisk); return; }
        if (rr?.retcode !== 0 && rr?.status !== 'ok') { logEvent('reply_fail', { tid: m.tid, retcode: rr?.retcode, message: rr?.message ?? '' }); continue; }
        state.repliesToday += 1;
        replied += 1;
        logEvent('reply_ok', { tid: m.tid, author, identity, comment: content, reply: replyText, threaded: Boolean(payload.comment_id), parentId: payload.comment_id ?? null });
      }
      seenIds.add(commentKey(c));
    }
    seen.count = Number(m.comment_num) || seen.count;
    seen.ids = Array.from(seenIds).slice(-80);
    saveState();
    if (replied >= cfg.maxRepliesPerCycle) break;
  }
  state.lastCommentCheckAt = Date.now();
  saveState();
}

async function maybeLike() {
  if (cfg.likeEnabled === false) return;
  if ((state.likesToday || 0) >= (cfg.maxLikesPerDay ?? 5)) return;
  if (state.lastLikeAt && Date.now() - state.lastLikeAt < (cfg.likeGapMinMs ?? 3600000)) return;
  if (Math.random() >= Number(cfg.likeChance ?? 0.35)) return;
  let r;
  try { r = await onebotCall('get_qzone_feeds', { page_num: 1, count: 10 }); } catch (e) { logEvent('like_feed_fail', { error: String(e?.message ?? e) }); return; }
  const feeds = (r?.data?.feeds || []).filter((f) => String(f.appid) === '311' && String(f.uin) !== String(botUin));
  if (!feeds.length) return;
  const f = feeds[rand(0, feeds.length - 1)];
  try {
    const like = await onebotCall('like_qzone', { tid: String(f.key), target_uin: Number(f.uin), abstime: Number(f.time) || 0 });
    if (like?.retcode === 0 || like?.status === 'ok') {
      state.likesToday = (state.likesToday || 0) + 1;
      state.lastLikeAt = Date.now();
      saveState();
      logEvent('like_ok', { uin: f.uin, nickname: f.nickname, tid: f.key });
    } else {
      logEvent('like_fail', { retcode: like?.retcode, message: like?.wording ?? like?.message ?? '' });
    }
  } catch (e) { logEvent('like_fail', { error: String(e?.message ?? e) }); }
}

async function cycle(forcePost = false) {
  if (state.paused) { logEvent('cycle_skip_paused', { reason: state.pauseReason }); return; }
  let guardOn = false;
  try { guardOn = !!JSON.parse(fs.readFileSync(`${B}\\state\\cost-guard.json`, 'utf8')).active; } catch {}
  if (guardOn) { logEvent('cycle_skip_cost_guard'); return; }
  if (state.dateKey !== todayKey()) { state.dateKey = todayKey(); state.postsToday = 0; state.repliesToday = 0; state.likesToday = 0; }
  try { await maybePost(forcePost); } catch (error) { logEvent('post_error', { error: String(error?.message ?? error) }); }
  try { await checkComments(); } catch (error) { logEvent('comment_error', { error: String(error?.message ?? error) }); }
  try { await maybeLike(); } catch (error) { logEvent('like_error', { error: String(error?.message ?? error) }); }
}

async function main() {
  // 单实例锁：避免计划任务和手动启动同时跑两份
  const lockFile = path.join(QZ, 'qzone-bot.pid');
  try {
    const old = Number(fs.readFileSync(lockFile, 'utf8').trim());
    if (old && old !== process.pid) {
      try { process.kill(old, 0); logEvent('already_running', { pid: old }); return; } catch {}
    }
  } catch {}
  try { fs.writeFileSync(lockFile, String(process.pid), 'utf8'); } catch {}
  logEvent('start', { dry: DRY, once: ARGS.has('--once'), version: '3.2.0', pid: process.pid });
  if (ARGS.has('--dry-comment')) { console.log('测试回复：', await composeTestReply()); return; }
  if (ARGS.has('--once')) { await cycle(ARGS.has('--force-post')); logEvent('once_done'); return; }
  for (;;) {
    await cycle(false);
    const wait = rand(cfg.cycleMinMs, cfg.cycleMaxMs);
    await new Promise((r) => setTimeout(r, wait));
  }
}
main().catch((error) => { logEvent('fatal', { error: String(error?.stack ?? error) }); process.exit(1); });
