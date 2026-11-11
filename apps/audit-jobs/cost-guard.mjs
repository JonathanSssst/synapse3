// Synapse 3 · 成本守护：余额或今日花费超阈值时写降档标记，桥接/空间助手据此收敛主动行为。
import { HOME as B, BRIDGE_ROOT } from '../../packages/paths/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BOT = `${B}`;
const STATE_DIR = path.join(BOT, 'state');
const CONF_FILE = path.join(BOT, 'audit', 'cost-guard.json');
const STATE_FILE = path.join(STATE_DIR, 'cost-guard.json');
const LOG_FILE = path.join(BOT, 'audit', 'cost-guard.log');
const QQB = 'E:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace\\qq-bridge';

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, s, 'utf8'); } catch {}
  console.log(s.trim());
}
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, obj) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); } catch {} }

const conf = { balanceWarn: 3, dailyCostWarn: 2, recoverMargin: 2, ...readJson(CONF_FILE, {}) };
const panelAlerts = readJson(path.join(BOT, 'panel', 'alerts.json'), {});
// 以 panel/alerts.json 为准（面板告警与自动守护用同一套阈值，避免两处配置漂移）
if (Number(panelAlerts.balanceWarn) > 0) conf.balanceWarn = Number(panelAlerts.balanceWarn);
if (Number(panelAlerts.dailyCostWarn) > 0) conf.dailyCostWarn = Number(panelAlerts.dailyCostWarn);
const monthlyBudget = Number(panelAlerts.monthlyBudget) > 0 ? Number(panelAlerts.monthlyBudget) : 20;
if (!fs.existsSync(CONF_FILE)) writeJson(CONF_FILE, conf);

async function viaPanel() {
  const res = await fetch('http://127.0.0.1:3120/api/data', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`panel HTTP ${res.status}`);
  const d = await res.json();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const day = (d.tokens?.days || []).find((x) => x.day === today);
  const monthPrefix = today.slice(0, 7);
  const monthCost = (d.tokens?.days || []).filter((x) => String(x.day || '').startsWith(monthPrefix)).reduce((a, x) => a + (Number(x.cost) || 0), 0);
  return { balance: Number(d.balance?.total ?? NaN), todayCost: Number(day?.cost ?? 0), monthCost, reachable: true };
}
async function viaDeepSeek() {
  const raw = fs.readFileSync(path.join(process.env.USERPROFILE || 'C:\\Users\\Administrator', '.dsh', '.credentials.yaml'), 'utf8');
  const key = (raw.match(/sk-[A-Za-z0-9]{20,}/) || [])[0];
  if (!key) throw new Error('没有 DeepSeek key');
  const res = await fetch('https://api.deepseek.com/user/balance', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
  const d = await res.json().catch(() => ({}));
  const total = Number((d.balance_infos || [])[0]?.total_balance ?? NaN);
  return { balance: total, todayCost: NaN, monthCost: NaN, reachable: true };
}

async function notify(text) {
  try {
    const token = fs.readFileSync(path.join(QQB, 'state', 'console-token'), 'utf8').trim();
    await fetch('http://127.0.0.1:3100/api/system-notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({ text })
    });
  } catch (error) { log(`通知主人失败：${error?.message ?? error}`); }
}

async function main() {
  // 余额优先直连 DeepSeek（不依赖面板）；今日/本月花费有面板才用。
  let ds = null;
  let panel = null;
  try { ds = await viaDeepSeek(); } catch (error) { log(`DeepSeek 余额取数失败：${error?.message ?? error}`); }
  try { panel = await viaPanel(); } catch (error) { log(`面板取数失败（花费统计暂缺）：${error?.message ?? error}`); }
  const stats = panel ? { ...panel, balance: Number.isFinite(ds?.balance) ? ds.balance : panel.balance } : ds;
  if (!stats || !Number.isFinite(stats.balance)) { log('余额拿不到，跳过本次判定'); return; }
  const prev = readJson(STATE_FILE, { active: false });
  const costBad = Number.isFinite(stats.todayCost) && stats.todayCost > conf.dailyCostWarn;
  const balBad = stats.balance < conf.balanceWarn;
  const monthBad = Number.isFinite(stats.monthCost) && stats.monthCost >= monthlyBudget;
  let active = balBad || costBad || monthBad;
  if (prev.active && !active && stats.balance > conf.balanceWarn + conf.recoverMargin && !costBad) active = false;
  const reasons = [];
  if (balBad) reasons.push(`余额 ¥${stats.balance.toFixed(2)} < ¥${conf.balanceWarn}`);
  if (costBad) reasons.push(`今日花费 ¥${stats.todayCost.toFixed(2)} > ¥${conf.dailyCostWarn}`);
  if (monthBad) reasons.push(`本月花费 ¥${stats.monthCost.toFixed(2)} 达到预算 ¥${monthlyBudget}`);
  const reason = reasons.join('；') || (active ? '成本守护中' : '');
  writeJson(STATE_FILE, {
    active, at: new Date().toISOString(), reason,
    balance: Number(stats.balance.toFixed(2)),
    todayCost: Number.isFinite(stats.todayCost) ? Number(stats.todayCost.toFixed(3)) : null,
    thresholds: { ...conf, monthlyBudget }
  });
  if (active && !prev.active) {
    log(`成本守护开启：${reason}`);
    await notify(`【Synapse 3】成本守护已开启：${reason}。\n已自动把主动机会概率降到 0.2，并暂停 QQ 空间自动发帖/回复；充值或降下来后会自动解除（也会私信你）。`);
  } else if (!active && prev.active) {
    log('成本守护解除');
    await notify('【Synapse 3】成本守护已解除，主动行为恢复正常。');
  } else {
    log(`成本守护状态：${active ? '开启' : '关闭'}（余额 ¥${stats.balance.toFixed(2)}，今日 ¥${Number.isFinite(stats.todayCost) ? stats.todayCost.toFixed(2) : '?'}）`);
  }
}
main().catch((error) => { log(`出错：${error?.stack ?? error}`); process.exitCode = 1; });
