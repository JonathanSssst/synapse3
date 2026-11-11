// Synapse 3 面板后端 · 配置中心（桥接 + QZone + 会话管理）
import fs from 'node:fs';
import path from 'node:path';
import { QB, QB_STATE, BOT } from './core.mjs';
import { restartBridge } from './whitelist.mjs';

const BRIDGE_FILE = path.join(QB, 'config.json');
const QZONE_FILE = path.join(BOT, 'qzone', 'config.json');
const SOCIAL_FILE = path.join(QB_STATE, 'social-v2.json');
const SESSIONS_FILE = path.join(QB_STATE, 'sessions.json');
const ROLEMAP_FILE = path.join(QB_STATE, 'role-map.json');

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8'); }
function backup(p) {
  try { if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)); } catch {}
}
function getPath(obj, dotted) {
  return String(dotted).split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}
function setPath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// 可编辑字段：min/max 针对数字；bool/string/timeList 单独校验
const BRIDGE_FIELDS = {
  'socialV2.proactive.enabled': { type: 'bool' },
  'socialV2.proactive.probability': { type: 'number', min: 0, max: 1 },
  'socialV2.proactive.weekdayProbability': { type: 'number', min: 0, max: 1 },
  'socialV2.proactive.weekendProbability': { type: 'number', min: 0, max: 1 },
  'socialV2.proactive.holidayProbability': { type: 'number', min: 0, max: 1 },
  'socialV2.proactive.nonOwnerPrivateMultiplier': { type: 'number', min: 0, max: 1 },
  'socialV2.proactive.checkIntervalMinMs': { type: 'number', min: 5 * MIN, max: 12 * HOUR },
  'socialV2.proactive.checkIntervalMaxMs': { type: 'number', min: 5 * MIN, max: 24 * HOUR },
  'socialV2.proactive.idleThresholdMs': { type: 'number', min: MIN, max: 12 * HOUR },
  'socialV2.biliSchedule.enabled': { type: 'bool' },
  'socialV2.biliSchedule.intervalMinMs': { type: 'number', min: 10 * MIN, max: 48 * HOUR },
  'socialV2.biliSchedule.intervalMaxMs': { type: 'number', min: 10 * MIN, max: 72 * HOUR },
  'socialV2.biliSchedule.activeHourStart': { type: 'number', min: 0, max: 23 },
  'socialV2.biliSchedule.activeHourEnd': { type: 'number', min: 0, max: 23 },
  'socialV2.biliSchedule.targetKey': { type: 'string' },
  'socialV2.freeTime.enabled': { type: 'bool' },
  'socialV2.freeTime.probability': { type: 'number', min: 0, max: 1 },
  'socialV2.freeTime.intervalMinMs': { type: 'number', min: 5 * MIN, max: 48 * HOUR },
  'socialV2.freeTime.intervalMaxMs': { type: 'number', min: 5 * MIN, max: 72 * HOUR },
  'socialV2.freeTime.activeHourStart': { type: 'number', min: 0, max: 23 },
  'socialV2.freeTime.activeHourEnd': { type: 'number', min: 0, max: 23 },
  'socialV2.freeTime.targetKey': { type: 'string' },
  'socialV2.webSurf.enabled': { type: 'bool' },
  'socialV2.webSurf.intervalMinMs': { type: 'number', min: 10 * MIN, max: 72 * HOUR },
  'socialV2.webSurf.intervalMaxMs': { type: 'number', min: 10 * MIN, max: 96 * HOUR },
  'socialV2.webSurf.activeHourStart': { type: 'number', min: 0, max: 23 },
  'socialV2.webSurf.activeHourEnd': { type: 'number', min: 0, max: 23 },
  'socialV2.sleepCheck.enabled': { type: 'bool' },
  'socialV2.sleepCheck.times': { type: 'timeList' },
  'socialV2.sleepCheck.targetKey': { type: 'string' },
  'socialV2.send.burstEnabled': { type: 'bool' },
  'socialV2.send.burstMaxMessages': { type: 'number', min: 1, max: 20 },
  'socialV2.send.maxSendPerMinute': { type: 'number', min: 1, max: 60 },
  'socialV2.send.maxSendPerHour': { type: 'number', min: 1, max: 500 },
  'socialV2.send.maxMessageChars': { type: 'number', min: 50, max: 3000 },
  'socialV2.agentMaxTurnsPerSession': { type: 'number', min: 10, max: 500 },
  'socialV2.sticker.enabled': { type: 'bool' },
  'socialV2.sticker.promptMaxStickers': { type: 'number', min: 1, max: 30 },
  'socialV2.sticker.maxListCount': { type: 'number', min: 10, max: 500 },
  'socialV2.friendAutoAccept': { type: 'bool' },
  'socialV2.voice.breeze.enabled': { type: 'bool' },
  'socialV2.voice.breeze.voiceId': { type: 'string' },
  'socialV2.voice.breeze.speed': { type: 'number', min: 0.5, max: 2 },
  'socialV2.voice.breeze.volume': { type: 'number', min: 0.01, max: 2 },
  'socialV2.voice.breeze.instructions': { type: 'string', maxLen: 200 },
  'socialV2.voice.breeze.dailyCreditLimit': { type: 'number', min: 0, max: 5000 },
  'slang.enabled': { type: 'bool' },
  'slang.autoResearch': { type: 'bool' },
  'slang.autoConfirm': { type: 'bool' },
  'slang.injectMax': { type: 'number', min: 1, max: 30 },
  'slang.extractMinMessages': { type: 'number', min: 1, max: 100 }
};

const QZONE_FIELDS = {
  'enabled': { type: 'bool' },
  'activeHourStart': { type: 'number', min: 0, max: 23 },
  'activeHourEnd': { type: 'number', min: 0, max: 23 },
  'postGapMinMs': { type: 'number', min: HOUR, max: 72 * HOUR },
  'postGapMaxMs': { type: 'number', min: HOUR, max: 96 * HOUR },
  'maxPostsPerDay': { type: 'number', min: 0, max: 10 },
  'maxRepliesPerDay': { type: 'number', min: 0, max: 200 },
  'imageChance': { type: 'number', min: 0, max: 1 },
  'requireImage': { type: 'bool' },
  'ugcRight': { type: 'number', min: 1, max: 128 },
  'likeEnabled': { type: 'bool' },
  'likeChance': { type: 'number', min: 0, max: 1 },
  'maxLikesPerDay': { type: 'number', min: 0, max: 50 }
};

function validate(fields, patch) {
  const out = {};
  for (const [key, raw] of Object.entries(patch || {})) {
    const spec = fields[key];
    if (!spec) continue;
    if (spec.type === 'bool') { out[key] = raw === true || raw === 'true'; continue; }
    if (spec.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) throw new Error(`${key} 需要在 ${spec.min}~${spec.max} 之间`);
      out[key] = n;
      continue;
    }
    if (spec.type === 'timeList') {
      const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[,，\s]+/)).map((s) => String(s).trim()).filter(Boolean);
      for (const t of list) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`时间格式不对：${t}（应为 HH:MM）`);
      out[key] = [...new Set(list)].sort();
      continue;
    }
    const s = String(raw ?? '').trim();
    if (spec.maxLen && s.length > spec.maxLen) throw new Error(`${key} 最多 ${spec.maxLen} 字`);
    out[key] = s;
  }
  return out;
}

export function getSettings() {
  const bridge = readJson(BRIDGE_FILE, {});
  const qzone = readJson(QZONE_FILE, {});
  const social = readJson(SOCIAL_FILE, { conversations: {} });
  const sessions = readJson(SESSIONS_FILE, { sessions: {} });
  const rolemap = readJson(ROLEMAP_FILE, {});
  const allow = new Set([...(bridge.allow?.groups ?? []), ...(bridge.allow?.private ?? [])].map(String));
  const conversations = Object.keys(social?.conversations ?? {}).map((key) => ({
    key,
    kind: key.startsWith('group:') ? 'group' : 'private',
    id: key.slice(key.indexOf(':') + 1),
    role: rolemap?.conversations?.[key] || rolemap?.default || '',
    session: sessions?.sessions?.[key] || '',
    inWhitelist: allow.has(key.slice(key.indexOf(':') + 1)),
    topics: (social.conversations[key]?.activeTopics ?? []).length,
    thoughts: (social.conversations[key]?.pendingThoughts ?? []).length,
    lastIncomingAt: social.conversations[key]?.lastIncomingAt || 0
  })).sort((a, b) => b.lastIncomingAt - a.lastIncomingAt);

  const valuesBridge = {};
  for (const key of Object.keys(BRIDGE_FIELDS)) valuesBridge[key] = getPath(bridge, key);
  const valuesQzone = {};
  for (const key of Object.keys(QZONE_FIELDS)) valuesQzone[key] = getPath(qzone, key);

  return {
    ok: true,
    bridge: valuesBridge,
    qzone: valuesQzone,
    conversations,
    targets: [
      { key: `private:${bridge.ownerQQ || ''}`, label: `主人私聊 private:${bridge.ownerQQ || '?'}` },
      ...conversations.filter((c) => c.kind === 'group').map((c) => ({ key: c.key, label: `群 ${c.id}` }))
    ],
    voice: {
      today: readJson(path.join(BOT, 'state', 'tts-usage.json'), {}),
      keyConfigured: Boolean(readJson(path.join(QB_STATE, 'breeze-tts.json'), {}).apiKey)
    }
  };
}

export async function saveSettings(patch) {
  const changedFiles = [];
  const bridgePatch = validate(BRIDGE_FIELDS, patch?.bridge || {});
  if (Object.keys(bridgePatch).length) {
    const cfg = readJson(BRIDGE_FILE, {});
    for (const [k, v] of Object.entries(bridgePatch)) setPath(cfg, k, v);
    backup(BRIDGE_FILE);
    writeJson(BRIDGE_FILE, cfg);
    changedFiles.push('qq-bridge/config.json');
  }
  const qzPatch = validate(QZONE_FIELDS, patch?.qzone || {});
  if (Object.keys(qzPatch).length) {
    const cfg = readJson(QZONE_FILE, {});
    for (const [k, v] of Object.entries(qzPatch)) setPath(cfg, k, v);
    backup(QZONE_FILE);
    writeJson(QZONE_FILE, cfg);
    changedFiles.push('qzone/config.json');
  }
  let bridge = null;
  if (Object.keys(bridgePatch).length) bridge = await restartBridge();
  let qzone = null;
  if (Object.keys(qzPatch).length) qzone = restartQzone();
  return { ok: true, changedFiles, bridge, qzone };
}

function restartQzone() {
  try {
    const pidFile = path.join(BOT, 'qzone', 'qzone-bot.pid');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      // Windows：SIGTERM 不保证，走 taskkill
      import('node:child_process').then(({ spawnSync }) => {
        spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 15000 });
        spawnSync('schtasks', ['/run', '/tn', 'QZoneBot'], { windowsHide: true, timeout: 15000 });
      });
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

export async function removeConversation(key) {
  const k = String(key || '').trim();
  if (!/^(group|private):\d+$/.test(k)) throw new Error('会话 key 格式不对');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  for (const f of [SOCIAL_FILE, SESSIONS_FILE, ROLEMAP_FILE, BRIDGE_FILE]) backup(f);
  let removed = false;
  const social = readJson(SOCIAL_FILE, { conversations: {} });
  if (social.conversations?.[k]) { delete social.conversations[k]; writeJson(SOCIAL_FILE, social); removed = true; }
  const sessions = readJson(SESSIONS_FILE, { sessions: {} });
  if (sessions.sessions?.[k]) { delete sessions.sessions[k]; removed = true; }
  if (sessions.sessionPolicies?.[k]) delete sessions.sessionPolicies[k];
  writeJson(SESSIONS_FILE, sessions);
  const rolemap = readJson(ROLEMAP_FILE, {});
  if (rolemap.conversations?.[k]) { delete rolemap.conversations[k]; writeJson(ROLEMAP_FILE, rolemap); }
  const cfg = readJson(BRIDGE_FILE, {});
  const id = k.slice(k.indexOf(':') + 1);
  for (const [parent, field] of [['allow', 'groups'], ['allow', 'private'], ['socialV2', 'allowGroups'], ['socialV2', 'allowPrivate']]) {
    const arr = cfg?.[parent]?.[field];
    if (Array.isArray(arr)) cfg[parent][field] = arr.filter((x) => String(x) !== id);
  }
  writeJson(BRIDGE_FILE, cfg);
  const bridge = await restartBridge();
  return { ok: true, removed, key: k, bridge, backupStamp: stamp };
}
