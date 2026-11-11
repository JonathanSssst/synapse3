// 主题：默认深色，localStorage 记忆
import { ref } from 'vue';

const KEY = 'panel.theme';

function read() {
  try {
    const param = new URLSearchParams(location.search).get('theme');
    if (param === 'light' || param === 'dark') return param;
    const v = localStorage.getItem(KEY);
    return v === 'light' ? 'light' : 'dark';
  } catch { return 'dark'; }
}

export const theme = ref(read());

export function applyTheme(t) {
  theme.value = t === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme.value;
  try { localStorage.setItem(KEY, theme.value); } catch {}
}

export function setTheme(t) { applyTheme(t); }
export function toggleTheme() { applyTheme(theme.value === 'dark' ? 'light' : 'dark'); }

// 模块加载时同步一次（index.html 已提前设置，这里兜底）
applyTheme(theme.value);
