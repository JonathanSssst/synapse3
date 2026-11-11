<script setup>
import { computed, ref } from 'vue';
import { fmtNum, fmtBytes, fmtMoney, fmtPct } from '../api/client.js';
import StatusPill from './StatusPill.vue';

const props = defineProps({
  row: { type: Object, required: true },
  col: { type: Object, required: true }
});
const broken = ref(false);

const value = computed(() => props.row[props.col.key]);
const type = computed(() => props.col.type || 'text');
const text = computed(() => {
  const v = value.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
});
const display = computed(() => {
  const v = value.value;
  switch (type.value) {
    case 'number': return Number.isFinite(Number(v)) ? fmtNum(v) : '—';
    case 'bytes': return fmtBytes(v);
    case 'money': return fmtMoney(v, 3);
    case 'percent': return fmtPct(v, 1);
    case 'time': return v ? String(v) : '—';
    case 'bool': {
      if (props.col.labels) return v ? props.col.labels[0] : props.col.labels[1];
      return v ? '是' : '否';
    }
    default: return text.value || '—';
  }
});
const tags = computed(() => {
  const v = value.value;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v) return v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  return [];
});
</script>

<template>
  <template v-if="type === 'image'">
    <img
      v-if="text && !broken"
      class="thumb"
      :src="text"
      loading="lazy"
      alt="预览"
      @error="broken = true"
      @click.stop="$emit('preview', text, col, row)"
    />
    <span v-else class="thumb thumb-fallback">无图</span>
  </template>
  <StatusPill v-else-if="type === 'status'" :ok="Boolean(value)" />
  <span v-else-if="type === 'bool'" class="pill" :class="value ? 'ok' : 'plain'">{{ display }}</span>
  <span v-else-if="type === 'tags'" class="tags">
    <span v-for="t in tags" :key="t" class="tag">{{ t }}</span>
    <span v-if="!tags.length" class="faint">—</span>
  </span>
  <span v-else-if="type === 'number' || type === 'bytes' || type === 'money'" class="num">{{ display }}</span>
  <span v-else-if="type === 'time'" class="num">{{ display }}</span>
  <span v-else-if="type === 'mono' || type === 'json'" class="cell-truncate mono" :title="text">{{ display }}</span>
  <span v-else class="cell-truncate" :title="text">{{ display }}</span>
</template>

<script>
export default { emits: ['preview'] };
</script>

<style scoped>
.thumb { width: 38px; height: 38px; border-radius: var(--radius-xs); object-fit: cover; border: 1px solid var(--border); background: var(--surface-2); cursor: zoom-in; }
.thumb-fallback { display: inline-grid; place-items: center; font-size: 10px; color: var(--faint); }
.tags { display: flex; flex-wrap: wrap; gap: 2px 0; }
</style>
