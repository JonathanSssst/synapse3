<script setup>
import { computed, ref } from 'vue';
import { fmtMoney, fmtNum } from '../api/client.js';

const props = defineProps({
  labels: { type: Array, default: () => [] },
  values: { type: Array, default: () => [] },
  height: { type: Number, default: 160 },
  format: { type: String, default: 'number' },
  color: { type: String, default: 'var(--chart-1)' }
});

const W = 720;
const PAD = { l: 40, r: 10, t: 12, b: 24 };
const active = ref(-1);
const maxV = computed(() => Math.max(1, ...props.values.map((v) => Number(v) || 0)));
const bw = computed(() => {
  const n = Math.max(props.values.length, 1);
  return ((W - PAD.l - PAD.r) / n) * 0.62;
});
const xAt = (i) => {
  const n = Math.max(props.values.length, 1);
  const step = (W - PAD.l - PAD.r) / n;
  return PAD.l + step * i + step / 2;
};
const yBar = (v) => PAD.t + (1 - (Number(v) || 0) / maxV.value) * (props.height - PAD.t - PAD.b);
const ticks = computed(() => [0, 0.25, 0.5, 0.75, 1].map((r) => ({ v: maxV.value * r, y: PAD.t + (1 - r) * (props.height - PAD.t - PAD.b) })));

function fmtVal(v) {
  if (props.format === 'money') return fmtMoney(v, 2);
  if (props.format === 'percent') return (Number(v) * 100).toFixed(0) + '%';
  return fmtNum(v);
}
function fmtShort(v) {
  const n = Number(v) || 0;
  if (props.format === 'money') return '¥' + (n >= 10 ? n.toFixed(0) : n.toFixed(2));
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
const xLabels = computed(() => {
  const total = props.labels.length;
  if (!total) return [];
  const step = Math.max(1, Math.ceil(total / 7));
  const out = [];
  for (let i = 0; i < total; i += step) out.push({ i, label: String(props.labels[i]) });
  return out;
});
const activeBar = computed(() => {
  if (active.value < 0) return null;
  const i = active.value;
  return {
    x: xAt(i) - bw.value / 2,
    y: yBar(props.values[i]),
    w: bw.value,
    h: props.height - PAD.b - yBar(props.values[i]),
    xc: xAt(i)
  };
});
</script>

<template>
  <div class="chart" :style="{ height: height + 'px' }">
    <svg :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="none">
      <line v-for="(t, i) in ticks" :key="'g' + i" :x1="PAD.l" :x2="W - PAD.r" :y1="t.y" :y2="t.y" class="grid" />
      <text v-for="(t, i) in ticks" :key="'t' + i" :x="PAD.l - 6" :y="t.y + 3.5" text-anchor="end" class="tick">{{ fmtShort(t.v) }}</text>

      <rect
        v-for="(v, i) in values"
        :key="'b' + i"
        :x="xAt(i) - bw / 2"
        :y="yBar(v)"
        :width="bw"
        :height="Math.max(0, height - PAD.b - yBar(v))"
        rx="3"
        :style="{ fill: color, opacity: active === -1 || active === i ? 0.9 : 0.4 }"
        @mouseenter="active = i"
        @mouseleave="active = -1"
      />
      <text v-for="x in xLabels" :key="'x' + x.i" :x="xAt(x.i)" :y="height - 6" text-anchor="middle" class="tick">{{ x.label }}</text>
    </svg>
    <div v-if="activeBar" class="tip" :style="{ left: (activeBar.xc / W) * 100 + '%', top: '4px' }">
      <div class="tip-label">{{ labels[active] }}</div>
      <b class="num">{{ fmtVal(values[active]) }}</b>
    </div>
  </div>
</template>

<style scoped>
.chart { position: relative; width: 100%; }
.chart svg { width: 100%; height: 100%; display: block; overflow: visible; }
.grid { stroke: var(--chart-grid); stroke-width: 1; stroke-dasharray: 3 4; }
.tick { fill: var(--chart-axis); font-size: 9.5px; font-family: var(--font-mono); }
.tip {
  position: absolute;
  transform: translateX(-50%);
  padding: 6px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  box-shadow: var(--shadow-2);
  pointer-events: none;
  z-index: 3;
  min-width: 84px;
}
.tip-label { font-size: 10.5px; color: var(--muted); margin-bottom: 2px; }
.tip b { font-size: 13px; color: var(--text); }
</style>
