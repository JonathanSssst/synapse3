<script setup>
import { computed, ref } from 'vue';
import { fmtMoney, fmtNum } from '../api/client.js';

const props = defineProps({
  labels: { type: Array, default: () => [] },
  series: { type: Array, default: () => [] },
  height: { type: Number, default: 190 },
  format: { type: String, default: 'number' },
  area: { type: Boolean, default: true },
  colors: { type: Array, default: () => ['var(--chart-1)', 'var(--chart-2)'] }
});

const W = 720;
const uid = 'lc' + Math.random().toString(36).slice(2, 8);
const active = ref(-1);
const PAD = { l: 46, r: 14, t: 14, b: 24 };

const n = computed(() => Math.max(props.labels.length, ...props.series.map((s) => s.data.length), 0));
const maxV = computed(() => {
  let m = 0;
  for (const s of props.series) for (const v of s.data) m = Math.max(m, Number(v) || 0);
  return m > 0 ? m : 1;
});
const xAt = (i) => (n.value <= 1 ? W / 2 : PAD.l + (i / (n.value - 1)) * (W - PAD.l - PAD.r));
const yAt = (v) => PAD.t + (1 - (Number(v) || 0) / maxV.value) * (props.height - PAD.t - PAD.b);

const ticks = computed(() => {
  const out = [];
  for (let i = 0; i <= 4; i++) {
    const v = (maxV.value / 4) * i;
    out.push({ v, y: yAt(v) });
  }
  return out;
});

const lines = computed(() =>
  props.series.map((s, si) => {
    const pts = s.data.map((v, i) => `${xAt(i)},${yAt(v)}`);
    const color = s.color || props.colors[si % props.colors.length];
    return {
      name: s.name,
      color,
      d: pts.length ? 'M' + pts.join(' L') : '',
      areaD: pts.length ? `M${xAt(0)},${props.height - PAD.b} L` + pts.join(' L') + ` L${xAt(pts.length - 1)},${props.height - PAD.b} Z` : ''
    };
  })
);

const xLabels = computed(() => {
  const total = props.labels.length;
  if (!total) return [];
  const step = Math.max(1, Math.ceil(total / 6));
  const out = [];
  for (let i = 0; i < total; i += step) out.push({ i, label: String(props.labels[i]) });
  return out;
});

function fmtVal(v) {
  if (props.format === 'money') return fmtMoney(v, 2);
  if (props.format === 'percent') return (Number(v) * 100).toFixed(0) + '%';
  return fmtNum(v);
}
function fmtShort(v) {
  const n = Number(v) || 0;
  if (props.format === 'money') return '¥' + (n >= 10 ? n.toFixed(1) : n.toFixed(2));
  if (props.format === 'percent') return (n * 100).toFixed(0) + '%';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function onMove(ev) {
  const rect = ev.currentTarget.getBoundingClientRect();
  const ratio = (ev.clientX - rect.left) / rect.width;
  const i = Math.round(ratio * (n.value - 1));
  active.value = Math.min(Math.max(i, 0), n.value - 1);
}
function onLeave() { active.value = -1; }
const activeX = computed(() => (active.value >= 0 ? xAt(active.value) : 0));
</script>

<template>
  <div class="chart" :style="{ height: height + 'px' }">
    <svg :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="none" @mousemove="onMove" @mouseleave="onLeave">
      <defs>
        <linearGradient :id="uid + '-g0'" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--chart-1)" stop-opacity="0.28" />
          <stop offset="100%" stop-color="var(--chart-1)" stop-opacity="0" />
        </linearGradient>
        <linearGradient :id="uid + '-g1'" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--chart-2)" stop-opacity="0.2" />
          <stop offset="100%" stop-color="var(--chart-2)" stop-opacity="0" />
        </linearGradient>
      </defs>

      <g>
        <line v-for="(t, i) in ticks" :key="'g' + i" :x1="PAD.l" :x2="W - PAD.r" :y1="t.y" :y2="t.y" class="grid" />
        <text v-for="(t, i) in ticks" :key="'t' + i" :x="PAD.l - 8" :y="t.y + 3.5" text-anchor="end" class="tick">{{ fmtShort(t.v) }}</text>
      </g>

      <g v-for="(s, si) in lines" :key="s.name + si">
        <path v-if="area && n > 1" :d="s.areaD" :fill="`url(#${uid}-g${si % 2})`" stroke="none" />
        <path :d="s.d" fill="none" :style="{ stroke: s.color }" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      </g>

      <g v-if="active >= 0">
        <line :x1="activeX" :x2="activeX" :y1="PAD.t" :y2="height - PAD.b" class="cursor" />
        <circle v-for="(s, si) in series" :key="'pt' + si" :cx="activeX" :cy="yAt(s.data[active])" r="3.5" :style="{ fill: s.color || colors[si % colors.length] }" />
      </g>

      <g>
        <text v-for="x in xLabels" :key="'x' + x.i" :x="xAt(x.i)" :y="height - 6" text-anchor="middle" class="tick">{{ x.label }}</text>
      </g>
    </svg>

    <div v-if="active >= 0" class="tip" :style="{ left: (activeX / W) * 100 + '%', top: '6px' }">
      <div class="tip-label">{{ labels[active] }}</div>
      <div v-for="(s, si) in series" :key="'tip' + si" class="tip-row">
        <i :style="{ background: s.color || colors[si % colors.length] }" />
        <span class="tip-name">{{ s.name }}</span>
        <b class="num">{{ fmtVal(s.data[active]) }}</b>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chart { position: relative; width: 100%; }
.chart svg { width: 100%; height: 100%; display: block; overflow: visible; }
.grid { stroke: var(--chart-grid); stroke-width: 1; stroke-dasharray: 3 4; }
.tick { fill: var(--chart-axis); font-size: 9.5px; font-family: var(--font-mono); }
.cursor { stroke: var(--border-strong); stroke-width: 1; stroke-dasharray: 3 3; }
.tip {
  position: absolute;
  transform: translateX(-50%);
  min-width: 120px;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  box-shadow: var(--shadow-2);
  pointer-events: none;
  z-index: 3;
}
.tip-label { font-size: 10.5px; color: var(--muted); margin-bottom: 3px; }
.tip-row { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-2); }
.tip-row i { width: 7px; height: 7px; border-radius: 2px; }
.tip-name { flex: 1; }
.tip-row b { color: var(--text); font-weight: 600; }
</style>
