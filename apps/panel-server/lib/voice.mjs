// Synapse 3 面板后端 · 语音（Breeze TTS）设置与用量
// 只读聚合 + 少量写操作（配置/人设覆盖/试听）；不修改桥接与 MCP 的 TTS 逻辑。
// 安全：state/breeze-tts.json 的 apiKey 只在本模块内部使用，绝不写入响应或日志。
import fs from 'node:fs';
import path from 'node:path';
import { PANEL_DIR, QB, readText, readJson, localDayOf, localTimeStr } from './core.mjs';
import { personaDir, readPersonaMeta, savePersonaMeta } from './sources.mjs';

const CONFIG_PATH = path.join(QB, 'config.json');
const CONFIG_BAK = path.join(QB, 'config.json.bak');
const KEY_PATH = path.join(QB, 'state', 'breeze-tts.json');
const USAGE_PATH = path.join(QB, 'state', 'tts-usage.json');
const HISTORY_PATH = path.join(QB, 'state', 'tts-history.jsonl');
const PERSONAS_DIR = path.join(QB, 'personas');
const SAMPLE_DIR = path.join(PANEL_DIR, '.tmp', 'voice-test');
const BREEZE_BASE = 'https://api.breeze.blue/v1';

const FALLBACK_VOICES = [
  { id: 'voc_u3nxkd5578wc', name: '大肥鱼（机灵版）' },
  { id: 'voc_8yud7hz7c9q2', name: '大肥鱼（迷糊版）' }
];

const DEFAULT_TEST_TEXT = '测试一下，这是新音色的声音。';
const TEST_MIN_INTERVAL_MS = 30 * 1000;
const SAMPLE_TTL_MS = 10 * 60 * 1000;

let lastTestAt = 0;
let voicesCache = { at: 0, value: null, error: '' };
let balanceCache = { at: 0, value: null };

// ---------- 读取 ----------
function readKey() {
  const d = readJson(KEY_PATH, {});
  return String(d?.apiKey || '').trim();
}
function readBreezeConfig() {
  const c = readJson(CONFIG_PATH, {}) || {};
  const b = c?.socialV2?.voice?.breeze || {};
  return {
    enabled: b.enabled !== false,
    voiceId: String(b.voiceId || ''),
    modelId: String(b.modelId || ''),
    speed: clampNum(b.speed, 0.5, 2, 1),
    volume: clampNum(b.volume, 0.01, 2, 1),
    instructions: String(b.instructions || ''),
    dailyCreditLimit: clampInt(b.dailyCreditLimit, 1, 2000, 300),
    timeoutMs: clampInt(b.timeoutMs, 5000, 180000, 90000)
  };
}
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function todayCN() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function dayOffsetCN(offsetDays) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() - offsetDays * 86400000));
}
function readUsage() {
  const today = todayCN();
  const d = readJson(USAGE_PATH, {}) || {};
  if (d.day !== today) return { day: today, chars: 0, credits: 0, calls: 0, failed: 0, provider: '', lastAt: '' };
  return {
    day: today,
    chars: Number(d.chars) || 0,
    credits: Number(d.credits) || 0,
    calls: Number(d.calls) || 0,
    failed: Number(d.failed) || 0,
    provider: String(d.provider || ''),
    lastAt: String(d.lastAt || ''),
    last: d.last && typeof d.last === 'object' ? d.last : null
  };
}
function readHistoryEntries() {
  const out = [];
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e || typeof e !== 'object') continue;
        out.push({
          at: String(e.at || ''),
          day: String(e.day || localDayOf(e.at) || ''),
          provider: String(e.provider || ''),
          ok: e.ok !== false,
          chars: Number(e.chars) || 0,
          credits: Number(e.credits) || 0,
          key: String(e.key || ''),
          voiceId: String(e.voiceId || '')
        });
      } catch {}
    }
  } catch {}
  return out;
}
function aggregate(days) {
  const cutoff = dayOffsetCN(days - 1);
  const map = new Map();
  for (const e of readHistoryEntries()) {
    if (!e.day || e.day < cutoff) continue;
    if (!map.has(e.day)) map.set(e.day, { day: e.day, chars: 0, credits: 0, calls: 0, failed: 0 });
    const row = map.get(e.day);
    row.chars += e.chars;
    row.credits += e.credits;
    if (e.ok) row.calls += 1;
    else row.failed += 1;
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayOffsetCN(i);
    out.push(map.get(day) || { day, chars: 0, credits: 0, calls: 0, failed: 0 });
  }
  return out;
}

// ---------- 上游：音色 / 余额（失败不抛 500） ----------
async function fetchVoices() {
  const apiKey = readKey();
  if (!apiKey) return { voices: [], error: '未配置 Breeze API Key（state/breeze-tts.json）' };
  try {
    const res = await fetch(`${BREEZE_BASE}/voices`, { headers: { 'xi-api-key': apiKey }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data?.voices) ? data.voices : [];
    const voices = list.map((v) => ({
      id: String(v.voice_id || v.id || ''),
      name: String(v.name || v.voice_id || ''),
      description: String(v.description || ''),
      language: String(v.language_code || ''),
      gender: String(v.gender || '')
    })).filter((v) => v.id);
    if (!voices.length) throw new Error('音色列表为空');
    return { voices, error: '' };
  } catch (error) {
    return { voices: [], error: `获取音色列表失败：${error?.message ?? error}` };
  }
}

function getVoicesCached() {
  const now = Date.now();
  if (voicesCache.value && now - voicesCache.at < 10 * 60 * 1000) return voicesCache;
  if (voicesCache.errorAt && now - voicesCache.errorAt < 60 * 1000) return voicesCache;
  return null; // 由调用方 await 刷新
}
async function voicesForResponse() {
  const cached = getVoicesCached();
  if (cached) return cached;
  const fresh = await fetchVoices();
  voicesCache = { at: Date.now(), value: fresh.voices, error: fresh.error, errorAt: fresh.error ? Date.now() : 0 };
  return voicesCache;
}

async function fetchBalance() {
  const apiKey = readKey();
  if (!apiKey) return { credits: null, total: null, error: '未配置 Breeze API Key（state/breeze-tts.json）' };
  try {
    const res = await fetch(`${BREEZE_BASE}/balance`, { headers: { 'xi-api-key': apiKey }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const credits = Number(data?.balance);
    if (!Number.isFinite(credits)) throw new Error('余额响应缺少 balance');
    return { credits, total: credits, scale: Number(data?.scale) || 1000, updatedAt: new Date().toISOString(), error: '' };
  } catch (error) {
    return { credits: null, total: null, error: `获取余额失败：${error?.message ?? error}` };
  }
}
async function balanceForResponse() {
  const now = Date.now();
  if (balanceCache.value && now - balanceCache.at < 60 * 1000) return balanceCache.value;
  const fresh = await fetchBalance();
  balanceCache = { at: now, value: fresh };
  return fresh;
}

// ---------- 人设覆盖 ----------
function listPersonaMeta() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PERSONAS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {}
  for (const role of dirs) {
    const meta = readPersonaMeta(role);
    const hasOverride = Boolean(meta.voiceId || meta.voiceInstructions || meta.voiceSpeed != null);
    out.push({
      role,
      displayName: String(meta.displayName || meta.nickname || role),
      voiceId: String(meta.voiceId || ''),
      instructions: String(meta.voiceInstructions || ''),
      speed: meta.voiceSpeed != null && Number.isFinite(Number(meta.voiceSpeed)) ? Number(meta.voiceSpeed) : null,
      hasOverride
    });
  }
  return out;
}

// ---------- GET /api/voice ----------
export async function buildVoiceOverview() {
  const cfg = readBreezeConfig();
  const keyConfigured = Boolean(readKey());
  const [voicesInfo, balance] = await Promise.all([voicesForResponse(), balanceForResponse()]);
  let voices = voicesInfo.value || [];
  if (!voices.length) voices = FALLBACK_VOICES.map((v) => ({ ...v, description: '', language: 'zh', gender: '' }));
  // 保证当前配置的音色在列表里（API 列表缺失时也能显示名字）
  if (cfg.voiceId && !voices.some((v) => v.id === cfg.voiceId)) {
    voices = [{ id: cfg.voiceId, name: cfg.voiceId, description: '', language: '', gender: '' }, ...voices];
  }
  const voiceName = voices.find((v) => v.id === cfg.voiceId)?.name || cfg.voiceId || '';
  const usage = readUsage();
  const personas = listPersonaMeta();
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    enabled: cfg.enabled,
    keyConfigured,
    voiceId: cfg.voiceId,
    voiceName,
    voices: voices.map((v) => ({ id: v.id, name: v.name, description: v.description || '', language: v.language || '', gender: v.gender || '' })),
    voicesError: voicesInfo.error || '',
    settings: {
      speed: cfg.speed,
      volume: cfg.volume,
      instructions: cfg.instructions,
      dailyCreditLimit: cfg.dailyCreditLimit,
      timeoutMs: cfg.timeoutMs
    },
    usage: {
      day: usage.day,
      chars: usage.chars,
      credits: usage.credits,
      calls: usage.calls,
      failed: usage.failed,
      provider: usage.provider,
      lastAt: usage.lastAt,
      lastAtLocal: usage.lastAt ? localTimeStr(usage.lastAt) : '',
      last: usage.last
    },
    history: aggregate(7),
    history30: aggregate(30),
    recent: readHistoryEntries().slice(-20).reverse(),
    balance: {
      credits: balance.credits,
      total: balance.total,
      updatedAt: balance.updatedAt || '',
      error: balance.error || ''
    },
    personaOverrides: personas.filter((p) => p.hasOverride).map((p) => ({
      role: p.role, voiceId: p.voiceId, instructions: p.instructions, speed: p.speed
    })),
    personas
  };
}

// ---------- POST /api/voice/save ----------
export function saveVoiceConfig(body = {}) {
  const cfg = readBreezeConfig();
  const next = { ...cfg };
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') throw new Error('enabled 需要布尔值');
    next.enabled = body.enabled;
  }
  if ('voiceId' in body) {
    const v = String(body.voiceId || '').trim();
    if (v && !/^[\w.-]{4,80}$/.test(v)) throw new Error('voiceId 格式不正确');
    next.voiceId = v;
  }
  if ('speed' in body) {
    const n = Number(body.speed);
    if (!Number.isFinite(n) || n < 0.5 || n > 2) throw new Error('语速需要在 0.5~2 之间');
    next.speed = Math.round(n * 100) / 100;
  }
  if ('volume' in body) {
    const n = Number(body.volume);
    if (!Number.isFinite(n) || n < 0.01 || n > 2) throw new Error('音量需要在 0.01~2 之间');
    next.volume = Math.round(n * 100) / 100;
  }
  if ('dailyCreditLimit' in body) {
    const n = Number(body.dailyCreditLimit);
    if (!Number.isFinite(n) || n < 1 || n > 2000) throw new Error('每日额度需要在 1~2000 之间');
    next.dailyCreditLimit = Math.round(n);
  }
  if ('instructions' in body) {
    const s = String(body.instructions ?? '');
    if ([...s].length > 200) throw new Error('语气指令不能超过 200 字');
    next.instructions = s;
  }
  // 写前备份 + 原子写回（只改 socialV2.voice.breeze）
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const full = JSON.parse(raw);
  if (!full.socialV2 || typeof full.socialV2 !== 'object') full.socialV2 = {};
  if (!full.socialV2.voice || typeof full.socialV2.voice !== 'object') full.socialV2.voice = {};
  full.socialV2.voice.breeze = {
    ...(full.socialV2.voice.breeze || {}),
    enabled: next.enabled,
    voiceId: next.voiceId,
    speed: next.speed,
    volume: next.volume,
    instructions: next.instructions,
    dailyCreditLimit: next.dailyCreditLimit
  };
  fs.copyFileSync(CONFIG_PATH, CONFIG_BAK);
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(full, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  voicesCache = { at: 0, value: null, error: '' };
  return {
    ok: true,
    enabled: next.enabled,
    voiceId: next.voiceId,
    settings: { speed: next.speed, volume: next.volume, instructions: next.instructions, dailyCreditLimit: next.dailyCreditLimit },
    backupPath: CONFIG_BAK,
    savedAt: new Date().toISOString()
  };
}

// ---------- POST /api/voice/persona ----------
export function savePersonaVoice(body = {}) {
  const role = String(body.role || '').replace(/[^\w一-鿿-]/g, '');
  if (!role) throw new Error('role 不能为空');
  const dir = personaDir(role);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) throw new Error(`人设不存在：${role}`);
  const meta = readPersonaMeta(role);
  const voiceId = String(body.voiceId || '').trim();
  const instructions = String(body.instructions ?? '').trim();
  const speedRaw = body.speed;
  const speed = speedRaw === '' || speedRaw == null ? null : Number(speedRaw);
  if (voiceId && !/^[\w.-]{4,80}$/.test(voiceId)) throw new Error('voiceId 格式不正确');
  if ([...instructions].length > 200) throw new Error('语气指令不能超过 200 字');
  if (speed != null && (!Number.isFinite(speed) || speed < 0.5 || speed > 2)) throw new Error('语速需要在 0.5~2 之间');
  // 空值 = 清空覆盖，跟随全局
  if (voiceId) meta.voiceId = voiceId; else delete meta.voiceId;
  if (instructions) meta.voiceInstructions = instructions; else delete meta.voiceInstructions;
  if (speed != null) meta.voiceSpeed = Math.round(speed * 100) / 100; else delete meta.voiceSpeed;
  if (!savePersonaMeta(role, meta)) throw new Error('写入 meta.json 失败');
  return {
    ok: true,
    role,
    voiceId: meta.voiceId || '',
    instructions: meta.voiceInstructions || '',
    speed: meta.voiceSpeed ?? null,
    hasOverride: Boolean(meta.voiceId || meta.voiceInstructions || meta.voiceSpeed != null)
  };
}

// ---------- POST /api/voice/test ----------
function cleanupSamples() {
  try {
    if (!fs.existsSync(SAMPLE_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(SAMPLE_DIR)) {
      const p = path.join(SAMPLE_DIR, f);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > SAMPLE_TTL_MS) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}
function billableChars(text) {
  let n = 0;
  for (const ch of Array.from(String(text || ''))) n += /[\u3400-\u9fff\uf900-\ufaff]/.test(ch) ? 2 : 1;
  return n;
}

export async function synthesizeSample(body = {}) {
  const apiKey = readKey();
  if (!apiKey) return { status: 400, payload: { ok: false, error: '未配置 Breeze API Key（state/breeze-tts.json）' } };
  const now = Date.now();
  if (now - lastTestAt < TEST_MIN_INTERVAL_MS) {
    const left = Math.ceil((TEST_MIN_INTERVAL_MS - (now - lastTestAt)) / 1000);
    return { status: 429, payload: { ok: false, error: `试听太频繁，请 ${left} 秒后再试` } };
  }
  const text = String(body.text ?? '').trim() || DEFAULT_TEST_TEXT;
  if ([...text].length > 30) return { status: 400, payload: { ok: false, error: '试听文本不能超过 30 字' } };
  const cfg = readBreezeConfig();
  if (!cfg.enabled) return { status: 400, payload: { ok: false, error: 'Breeze 语音已在配置中关闭，请先启用并保存' } };
  const usage = readUsage();
  const chars = billableChars(text);
  const credits = Math.ceil(chars / 10);
  if (usage.credits + credits > cfg.dailyCreditLimit) {
    return { status: 429, payload: { ok: false, error: `今日语音额度不足（${usage.credits}/${cfg.dailyCreditLimit} credits）` } };
  }
  const voiceId = cfg.voiceId || 'voc_u3nxkd5578wc';
  const synthBody = {
    text,
    language_code: 'zh',
    voice_settings: { speed: cfg.speed, volume: cfg.volume }
  };
  if (cfg.modelId) synthBody.model_id = cfg.modelId;
  if (cfg.instructions) synthBody.instructions = cfg.instructions;
  lastTestAt = now; // 先占位，失败也不允许连点
  try {
    const url = `${BREEZE_BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=wav_24000&delivery=sync`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(synthBody),
      signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, 120000))
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Breeze ${res.status}：${txt.slice(0, 160)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error('Breeze 返回音频过小');
    fs.mkdirSync(SAMPLE_DIR, { recursive: true });
    cleanupSamples();
    const name = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`;
    fs.writeFileSync(path.join(SAMPLE_DIR, name), buf);
    return {
      status: 200,
      payload: {
        ok: true,
        url: `/api/voice/sample/${encodeURIComponent(name)}`,
        name,
        bytes: buf.length,
        chars,
        credits,
        voiceId,
        text
      }
    };
  } catch (error) {
    return { status: 502, payload: { ok: false, error: `试听生成失败：${error?.message ?? error}` } };
  }
}

export function readSample(name) {
  const safe = String(name || '');
  if (!/^[A-Za-z0-9._-]+\.wav$/.test(safe)) return null;
  const file = path.resolve(SAMPLE_DIR, safe);
  if (file !== path.resolve(SAMPLE_DIR, safe) || !file.startsWith(path.resolve(SAMPLE_DIR) + path.sep)) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return { file, size: st.size };
  } catch {
    return null;
  }
}

export const VOICE_LIMITS = { speed: [0.5, 2], volume: [0.01, 2], dailyCreditLimit: [1, 2000], instructions: 200, testText: 30 };
export { SAMPLE_DIR, DEFAULT_TEST_TEXT };
