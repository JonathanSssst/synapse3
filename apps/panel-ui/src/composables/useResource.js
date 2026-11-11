// 非列表资源加载（概览 / 花费 / 生活 / 相册 ...），响应全局刷新
import { ref, watch, onMounted } from 'vue';
import { refreshTick, touchRefresh } from './useRefresh.js';

export function useResource(fn, options = {}) {
  const { immediate = true, followRefresh = true } = options;
  const data = ref(null);
  const loading = ref(false);
  const error = ref('');
  const ready = ref(false);
  let seq = 0;

  async function load(silent = false) {
    const my = ++seq;
    if (!silent) loading.value = true;
    error.value = '';
    try {
      const res = await fn();
      if (my !== seq) return;
      data.value = res;
      ready.value = true;
      touchRefresh();
    } catch (e) {
      if (my !== seq) return;
      error.value = e?.message || String(e);
      ready.value = true;
    } finally {
      if (my === seq) loading.value = false;
    }
  }

  if (followRefresh) watch(refreshTick, () => load(true));
  if (immediate) onMounted(() => load());

  return { data, loading, error, ready, load };
}
