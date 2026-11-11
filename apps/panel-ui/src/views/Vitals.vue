<script setup>
import { computed, onMounted, ref } from 'vue';
import SectionCard from '../components/SectionCard.vue';
import EmptyState from '../components/EmptyState.vue';
import Icon from '../components/Icon.vue';
import { api, fmtTime } from '../api/client.js';
import { toast } from '../composables/useToast.js';

const roles = ref([]);
const role = ref('');
const day = ref(new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
const current = ref(null);
const points = ref([]);
const events = ref([]);
const loading = ref(false);
const manualType = ref('meal');

const COLORS = { energy: 'var(--chart-1)', satiety: 'var(--chart-2)', mood: 'var(--chart-3)', health: 'var(--chart-4)' };
const LABELS = { energy: '精力', satiety: '饱食', mood: '心情', health: '健康' };
const MANUAL = [
  ['meal', '吃饭'], ['praised', '被夸'], ['comforted', '被哄好'], ['conflict', '闹别扭'],
  ['tired', '累了'], ['sick', '不舒服'], ['sleep_start', '去睡'], ['sleep_wake', '睡醒']
];

const W = 720, H = 240, PAD = { l: 36, r: 14, t: 14, b: 26 };
const dayStart = computed(() => {
  const d = new Date(day.value + 'T00:00:00+08:00');
  return d.getTime();
});
const xAt = (t) => PAD.l + ((Number(t) - dayStart.value) / 86400000) * (W - PAD.l - PAD.r);
const yAt = (v) => PAD.t + (1 - Number(v) / 100) * (H - PAD.t - PAD.b);
const lines = computed(() => ['energy', 'satiety', 'mood', 'health'].map((k) => {
  const pts = points.value.filter((p) => Number.isFinite(Number(p[k]))).map((p) => `${xAt(p.t).toFixed(1)},${yAt(p[k]).toFixed(1)}`);
  return { key: k, color: COLORS[k], d: pts.length ? 'M' + pts.join(' L') : '' };
}));
const ticks = [0, 25, 50, 75, 100].map((v) => ({ v, y: yAt(v) }));
const hourLabels = [0, 6, 12, 18, 24].map((h) => ({ h, x: PAD.l + (h / 24) * (W - PAD.l - PAD.r) }));

async function loadRoles() {
  try {
    const d = await api.records('persona', { page: 1, pageSize: 50 });
    roles.value = (d.items || []).map((p) => ({ role: p.role || p.id, label: p.displayName || p.name || p.role })).filter((x) => x.role);
    if (!role.value && roles.value.length) role.value = roles.value[0].role;
  } catch {}
}
async function load() {
  if (!role.value) return;
  loading.value = true;
  try {
    current.value = await api.vitalsGet(role.value);
    const tl = await api.vitalsTimeline(role.value, day.value);
    points.value = tl.points || [];
    events.value = tl.events || [];
  } catch (e) { toast('读取状态失败：' + (e?.message || e), 'bad'); }
  finally { loading.value = false; }
}
async function fire() {
  try {
    await api.vitalsEvent({ role: role.value, type: manualType.value, source: 'panel' });
    await load();
  } catch (e) { toast('事件失败：' + (e?.message || e), 'bad'); }
}
function pct(v) { return Math.max(0, Math.min(100, Number(v) || 0)); }
function barColor(v) { return v < 30 ? 'var(--danger)' : v > 75 ? 'var(--ok)' : 'var(--accent)'; }

onMounted(async () => { await loadRoles(); await load(); });
</script>

<template>
  <div class="page">
    <div class="row wrap" style="justify-content: space-between; margin-bottom: 12px">
      <div class="row wrap" style="gap: 8px">
        <span class="pill accent">角色状态</span>
        <select v-model="role" class="select" @change="load">
          <option v-for="r in roles" :key="r.role" :value="r.role">{{ r.label }}</option>
        </select>
        <input v-model="day" type="date" class="input" style="width: 140px" @change="load" />
      </div>
      <div class="row" style="gap: 8px">
        <select v-model="manualType" class="select">
          <option v-for="[v, l] in MANUAL" :key="v" :value="v">{{ l }}</option>
        </select>
        <button class="btn btn-sm" @click="fire">注入事件</button>
        <button class="btn btn-sm" :disabled="loading" @click="load"><Icon name="refresh" :size="12" />刷新</button>
      </div>
    </div>

    <div v-if="current" class="gauges">
      <div v-for="k in ['energy', 'satiety', 'mood', 'health']" :key="k" class="gauge">
        <div class="g-head"><span>{{ LABELS[k] }}</span><b class="num">{{ Math.round(pct(current.state[k])) }}</b></div>
        <div class="g-bar"><i :style="{ width: pct(current.state[k]) + '%', background: barColor(pct(current.state[k])) }" /></div>
      </div>
    </div>
    <div v-if="current" class="tiny faint" style="margin: -4px 0 12px">此刻：{{ current.text }}</div>

    <SectionCard title="24 小时状态曲线" subtitle="每 5 分钟一个点；竖线为重大事件">
      <div v-if="!points.length" class="tiny faint">这一天还没有状态记录（桥接运行后会每 5 分钟记录一次）</div>
      <div v-else class="chart-wrap">
        <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none">
          <line v-for="t in ticks" :key="'g' + t.v" :x1="PAD.l" :x2="W - PAD.r" :y1="t.y" :y2="t.y" class="grid" />
          <text v-for="t in ticks" :key="'tl' + t.v" :x="PAD.l - 6" :y="t.y + 3" text-anchor="end" class="tick">{{ t.v }}</text>
          <text v-for="h in hourLabels" :key="'h' + h.h" :x="h.x" :y="H - 8" text-anchor="middle" class="tick">{{ h.h }}:00</text>
          <line v-for="e in events" :key="'e' + e.t + e.type" :x1="xAt(e.t)" :x2="xAt(e.t)" :y1="PAD.t" :y2="H - PAD.b" class="event-line">
            <title>{{ fmtTime(e.t) }} · {{ e.label }}</title>
          </line>
          <circle v-for="e in events" :key="'ec' + e.t + e.type" :cx="xAt(e.t)" :cy="PAD.t" r="2.5" class="event-dot">
            <title>{{ fmtTime(e.t) }} · {{ e.label }}</title>
          </circle>
          <path v-for="l in lines" :key="l.key" :d="l.d" fill="none" :style="{ stroke: l.color }" stroke-width="2" stroke-linejoin="round" />
        </svg>
        <div class="legend">
          <span v-for="k in ['energy', 'satiety', 'mood', 'health']" :key="k"><i :style="{ background: COLORS[k] }" />{{ LABELS[k] }}</span>
        </div>
      </div>
      <div v-if="events.length" class="events">
        <span v-for="e in events" :key="e.t + e.type" class="ev"><b>{{ fmtTime(e.t) }}</b>{{ e.label }}</span>
      </div>
    </SectionCard>

    <SectionCard title="事件流水" subtitle="状态变化来源">
      <div v-if="events.length" class="table-wrap">
        <table class="table"><thead><tr><th style="width:160px">时间</th><th style="width:140px">事件</th><th>变化</th><th>来源</th></tr></thead>
          <tbody><tr v-for="e in [...events].reverse()" :key="e.t + e.type">
            <td class="mono">{{ fmtTime(e.t) }}</td><td>{{ e.label }}</td>
            <td class="mono tiny">{{ Object.entries(e.delta || {}).map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`).join(' ') }}</td>
            <td class="tiny faint">{{ e.source || '—' }}</td>
          </tr></tbody></table>
      </div>
      <EmptyState v-else text="还没有状态事件" icon="clock" />
    </SectionCard>
  </div>
</template>

<style scoped>
.gauges { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin-bottom: 12px; }
.gauge { padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--card2); }
.g-head { display: flex; justify-content: space-between; font-size: var(--fs-12); color: var(--faint); margin-bottom: 6px; }
.g-head b { color: var(--fg); }
.g-bar { height: 8px; border-radius: 999px; background: var(--border); overflow: hidden; }
.g-bar i { display: block; height: 100%; border-radius: 999px; transition: width .3s; }
.chart-wrap { position: relative; }
.chart-wrap svg { width: 100%; height: 240px; display: block; }
.grid { stroke: var(--chart-grid); stroke-width: 1; stroke-dasharray: 3 4; }
.tick { fill: var(--chart-axis); font-size: 9.5px; font-family: var(--font-mono); }
.event-line { stroke: var(--faint); stroke-width: 1; stroke-dasharray: 2 4; opacity: .7; }
.event-dot { fill: var(--warning, #f59e0b); }
.legend { display: flex; gap: 14px; font-size: var(--fs-12); color: var(--faint); margin-top: 4px; }
.legend i { display: inline-block; width: 10px; height: 3px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
.events { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; font-size: var(--fs-12); color: var(--faint); }
.ev b { color: var(--fg); font-weight: 500; margin-right: 6px; }
.table-wrap { overflow: auto; }
</style>
