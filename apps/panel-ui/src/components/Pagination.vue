<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({
  page: { type: Number, default: 1 },
  totalPages: { type: Number, default: 1 },
  total: { type: Number, default: 0 },
  pageSize: { type: Number, default: 25 },
  pageSizes: { type: Array, default: () => [10, 25, 50, 100] }
});
const emit = defineEmits(['page', 'pageSize']);

const pages = computed(() => {
  const tp = Math.max(1, props.totalPages);
  const cur = Math.min(Math.max(1, props.page), tp);
  const out = [];
  if (tp <= 7) {
    for (let i = 1; i <= tp; i++) out.push(i);
  } else {
    out.push(1);
    if (cur > 4) out.push('l');
    const start = Math.max(2, cur - 1);
    const end = Math.min(tp - 1, cur + 1);
    for (let i = start; i <= end; i++) out.push(i);
    if (cur < tp - 3) out.push('r');
    out.push(tp);
  }
  return out;
});

function go(p) {
  if (p === 'l' || p === 'r') return;
  const n = Math.min(Math.max(1, p), Math.max(1, props.totalPages));
  if (n !== props.page) emit('page', n);
}
</script>

<template>
  <div class="pagination">
    <div class="pager">
      <button class="icon-btn" :disabled="page <= 1" title="上一页" @click="go(page - 1)">
        <Icon name="collapse" :size="15" />
      </button>
      <template v-for="(p, i) in pages" :key="i">
        <span v-if="p === 'l' || p === 'r'" class="ellipsis">…</span>
        <button v-else class="page-btn num" :class="{ on: p === page }" @click="go(p)">{{ p }}</button>
      </template>
      <button class="icon-btn" :disabled="page >= totalPages" title="下一页" @click="go(page + 1)">
        <Icon name="chevron" :size="15" />
      </button>
    </div>
    <div class="meta">
      <span>共 <b class="num">{{ total.toLocaleString('zh-CN') }}</b> 条</span>
      <span class="faint">第 {{ page }} / {{ totalPages }} 页</span>
      <select class="select" :value="pageSize" @change="emit('pageSize', Number($event.target.value))">
        <option v-for="n in pageSizes" :key="n" :value="n">{{ n }} 条/页</option>
      </select>
    </div>
  </div>
</template>

<style scoped>
.pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
.pager { display: flex; align-items: center; gap: 2px; }
.page-btn {
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border-radius: var(--radius-xs);
  color: var(--muted);
  font-size: var(--fs-12);
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.page-btn:hover { background: var(--surface-2); color: var(--text); }
.page-btn.on { background: var(--accent-soft); color: var(--accent); font-weight: 650; }
.ellipsis { color: var(--faint); padding: 0 4px; font-size: var(--fs-12); }
.meta { display: flex; align-items: center; gap: 14px; font-size: var(--fs-11); color: var(--muted); }
.meta b { color: var(--text-2); font-weight: 600; }
.meta .select { height: 26px; font-size: var(--fs-11); }
.icon-btn[disabled] { opacity: 0.35; cursor: not-allowed; }
</style>
