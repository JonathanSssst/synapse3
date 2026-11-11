<script setup>
import { computed } from 'vue';
import { fmtNum, fmtMoney } from '../api/client.js';

const props = defineProps({
  items: { type: Array, default: () => [] },
  limit: { type: Number, default: 10 },
  format: { type: String, default: 'number' },
  showShare: { type: Boolean, default: true },
  colors: { type: Array, default: () => ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'] }
});

const rows = computed(() => {
  const list = props.items.slice(0, props.limit);
  const max = Math.max(1, ...list.map((x) => Number(x.value ?? x.count ?? x.share ?? 0)));
  return list.map((x, i) => {
    const v = Number(x.value ?? x.count ?? 0);
    const share = x.share != null ? Number(x.share) : v / max;
    return { ...x, v, share, color: x.color || props.colors[i % props.colors.length], label: x.label ?? x.name ?? x.tool ?? x.model ?? '' };
  });
});
function fmt(v, row) {
  if (props.format === 'money') return fmtMoney(v, 3);
  if (props.format === 'percent') return (Number(row.share) * 100).toFixed(1) + '%';
  return fmtNum(v, 0);
}
</script>

<template>
  <div class="hbars">
    <div v-if="!rows.length" class="faint small" style="padding: 8px 0">暂无数据</div>
    <div v-for="row in rows" :key="row.label" class="hbar">
      <div class="hbar-label truncate" :title="String(row.label)">{{ row.label }}</div>
      <div class="hbar-track"><i :style="{ width: Math.max(2, Math.round(row.share * 100)) + '%', background: row.color }" /></div>
      <div class="hbar-value num">{{ fmt(row.v, row) }}</div>
    </div>
  </div>
</template>

<style scoped>
.hbars { display: flex; flex-direction: column; gap: 8px; }
.hbar { display: grid; grid-template-columns: minmax(84px, 34%) minmax(0, 1fr) 84px; align-items: center; gap: 10px; }
.hbar-label { font-size: var(--fs-12); color: var(--text-2); }
.hbar-track { height: 7px; background: var(--surface-2); border-radius: var(--radius-pill); overflow: hidden; }
.hbar-track i { display: block; height: 100%; border-radius: var(--radius-pill); transition: width var(--dur) var(--ease); }
.hbar-value { text-align: right; font-size: var(--fs-11); color: var(--muted); }
</style>
