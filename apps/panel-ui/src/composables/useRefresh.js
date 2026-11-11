// 全局刷新状态：自动刷新档位 / 最近刷新时间 / 侧边栏折叠
import { reactive, ref } from 'vue';

const AUTO_KEY = 'panel.auto';
const MINI_KEY = 'panel.mini';
const SIDEBAR_KEY = 'panel.sidebar';

function readAuto() {
  const raw = localStorage.getItem(AUTO_KEY);
  if (raw == null || raw === '') return 15;
  const n = Number(raw);
  return [0, 5, 15, 60].includes(n) ? n : 15;
}
function readBool(key, def = false) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? def : v === '1';
  } catch { return def; }
}

export const ui = reactive({
  auto: readAuto(),
  lastRefresh: 0,
  refreshing: false,
  mini: readBool(MINI_KEY, false),
  mobileOpen: false,
  health: null,
  version: ''
});

export const refreshTick = ref(0);

export function setAuto(v) {
  const n = Number(v) || 0;
  ui.auto = [0, 5, 15, 60].includes(n) ? n : 15;
  try { localStorage.setItem(AUTO_KEY, String(ui.auto)); } catch {}
  startAuto();
}

export function setMini(v) {
  ui.mini = Boolean(v);
  try { localStorage.setItem(MINI_KEY, ui.mini ? '1' : '0'); } catch {}
}

export function touchRefresh() { ui.lastRefresh = Date.now(); }

export function manualRefresh() { refreshTick.value += 1; }

let timer = 0;
export function startAuto() {
  if (timer) clearInterval(timer);
  timer = 0;
  if (ui.auto > 0) {
    timer = setInterval(() => { refreshTick.value += 1; }, ui.auto * 1000);
  }
}
