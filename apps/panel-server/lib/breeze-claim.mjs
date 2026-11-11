// Synapse 3 · Breeze 每日签到提醒
// 每天免费 400 credits 需要在官网手动领取；这里跟踪余额变化推断是否已领。
import fs from 'node:fs';
import path from 'node:path';
import { QB_STATE, BOT } from './core.mjs';

const KEY_FILE = path.join(QB_STATE, 'breeze-tts.json');
const STATE_FILE = path.join(BOT, 'state', 'breeze-claim.json');
const LINK = 'https://breezeblue.ai/app';
const REMIND_START_HOUR = 9;
const REMIND_END_HOUR = 23;
const CACHE_MS = 60 * 1000;
const JUMP_THRESHOLD = 300;

let cache = { at: 0, value: null };

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, v) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8'); } catch {} }
function apiKey() { return String(readJson(KEY_FILE, {}).apiKey || '').trim(); }
function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function hourNow() {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date()));
}
function readState() {
  const s = readJson(STATE_FILE, {});
  return {
    day: s.day || '', baseline: Number.isFinite(s.baseline) ? s.baseline : null,
    lastBalance: Number.isFinite(s.lastBalance) ? s.lastBalance : null,
    lastCheckedAt: s.lastCheckedAt || '', claimed: s.claimed === true, claimedAt: s.claimedAt || '',
    remindedAt: s.remindedAt || '', source: s.source || '', lastError: s.lastError || ''
  };
}

async function fetchBalance() {
  const key = apiKey();
  if (!key) throw new Error('没有配置 Breeze API Key');
  const r = await fetch('https://api.breeze.blue/v1/balance', {
    headers: { 'xi-api-key': key },
    signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) throw new Error(`Breeze balance HTTP ${r.status}`);
  const d = await r.json().catch(() => ({}));
  const bal = Number(d.balance);
  if (!Number.isFinite(bal)) throw new Error('Breeze balance 返回无效');
  return bal;
}

export async function checkBreezeClaim({ force = false, notify = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < CACHE_MS) return cache.value;
  const st = readState();
  const day = todayKey();
  let balance = null;
  let error = '';
  try { balance = await fetchBalance(); } catch (e) { error = String(e?.message ?? e); }
  if (!error) {
    if (st.day !== day) {
      st.baseline = st.lastBalance ?? balance;
      st.day = day;
      st.claimed = false;
      st.claimedAt = '';
      st.remindedAt = '';
      st.source = '';
    }
    if (!st.claimed && st.baseline !== null && balance >= st.baseline + JUMP_THRESHOLD) {
      st.claimed = true;
      st.claimedAt = new Date().toISOString();
      st.source = 'balance-jump';
    }
    st.lastBalance = balance;
    st.lastCheckedAt = new Date().toISOString();
  } else {
    st.lastError = error;
  }
  writeJson(STATE_FILE, st);

  const hour = hourNow();
  let reminded = false;
  if (notify && !error && !st.claimed && hour >= REMIND_START_HOUR && hour < REMIND_END_HOUR) {
    const lastRemind = st.remindedAt ? Date.parse(st.remindedAt) : 0;
    if (!lastRemind || Date.now() - lastRemind > 20 * 3600 * 1000) {
      try {
        const token = fs.readFileSync(path.join(QB_STATE, 'console-token'), 'utf8').trim();
        const text = `💰 Breeze 签到提醒：今天还没领 400 积分（当前 ${balance ?? '?'} credits）。\n去这里签到：${LINK}\n签到后余额会增加约 400，我会自动认出来。`;
        await fetch('http://127.0.0.1:3100/api/system-notify', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-console-token': token },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(15000)
        });
        st.remindedAt = new Date().toISOString();
        writeJson(STATE_FILE, st);
        reminded = true;
      } catch (e) { st.lastError = '通知发送失败：' + String(e?.message ?? e); writeJson(STATE_FILE, st); }
    }
  }

  const status = {
    ok: true, day, claimed: st.claimed, claimedAt: st.claimedAt, source: st.source,
    balance, baseline: st.baseline, lastBalance: st.lastBalance, lastCheckedAt: st.lastCheckedAt,
    remindedAt: st.remindedAt, reminded, link: LINK, error,
    rule: '同一天余额比基线增加 ≥300 credits 视为已签到'
  };
  cache = { at: Date.now(), value: status };
  return status;
}

export async function markBreezeClaimed() {
  const st = readState();
  st.claimed = true;
  st.claimedAt = new Date().toISOString();
  st.source = 'manual';
  writeJson(STATE_FILE, st);
  cache = { at: 0, value: null };
  return checkBreezeClaim({ force: true, notify: false });
}

let timer = null;
export function startBreezeClaimWatch() {
  if (timer) return;
  const run = () => { checkBreezeClaim({ force: true, notify: true }).catch(() => {}); };
  setTimeout(run, 20000);
  timer = setInterval(run, 30 * 60 * 1000);
  timer.unref?.();
}
