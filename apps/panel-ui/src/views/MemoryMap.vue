<script setup>
import { computed, onMounted, ref } from 'vue';
import SectionCard from '../components/SectionCard.vue';
import EmptyState from '../components/EmptyState.vue';
import Icon from '../components/Icon.vue';
import { api, fmtTime } from '../api/client.js';
import { toast } from '../composables/useToast.js';

const roles = ref([]);
const role = ref('');
const entries = ref([]);
const loading = ref(false);
const selected = ref(null);
const zoom = ref(1);

const KIND_COLOR = {
  fact: '#5eead4', preference: '#60a5fa', event: '#fbbf24', emotion: '#f472b6',
  promise: '#a78bfa', relationship: '#fb7185', boundary: '#ef4444'
};
const KIND_LABEL = { fact: '事实', preference: '偏好', event: '事件', emotion: '情绪', promise: '约定', relationship: '关系', boundary: '边界' };

const W = 820, H = 560, CX = W / 2, CY = H / 2;

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

// 确定性星图布局：类型分扇区，重要度决定离中心距离
const KIND_ANGLE = { boundary: -1.2, relationship: -0.6, promise: 0.1, preference: 0.6, fact: 1.2, event: 1.9, emotion: 2.5 };
const nodes = computed(() => entries.value.map((e) => {
  const imp = Math.max(0.1, Number(e.importance) || 0.5);
  const r = 55 + (1 - imp) * 170 + (e.forgotten ? 55 : 0) + hash(e.id + 'r') * 26;
  const base = KIND_ANGLE[e.kind] ?? 0.8;
  const a = base + (hash(e.id) - 0.5) * 0.9;
  return {
    ...e, x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r,
    rr: 3 + imp * 6 + (e.pin ? 1.5 : 0),
    color: KIND_COLOR[e.kind] || '#94a3b8',
    alpha: e.forgotten ? 0.28 : 0.95,
    delay: (hash(e.id + 'd') * 3).toFixed(2)
  };
}));
const links = computed(() => {
  const out = [];
  const ns = nodes.value;
  for (let i = 0; i < ns.length; i++) {
    let best = -1, bestD = Infinity;
    for (let j = 0; j < ns.length; j++) {
      if (i === j) continue;
      if (ns[i].kind !== ns[j].kind && !(ns[i].tags || []).some((t) => (ns[j].tags || []).includes(t))) continue;
      const d = Math.hypot(ns[i].x - ns[j].x, ns[i].y - ns[j].y);
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best > i) out.push({ a: ns[i], b: ns[best] });
  }
  return out;
});
const stars = Array.from({ length: 90 }, (_, i) => ({
  x: (hash('sx' + i) * W), y: (hash('sy' + i) * H), r: 0.5 + hash('sr' + i) * 1.2, o: 0.15 + hash('so' + i) * 0.4
}));
const legend = computed(() => Object.entries(KIND_COLOR));

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
  selected.value = null;
  try { const d = await api.brainMemory(role.value); entries.value = d.entries || []; }
  catch (e) { toast('读取记忆失败：' + (e?.message || e), 'bad'); }
  finally { loading.value = false; }
}
function pick(n) { selected.value = n; }

onMounted(async () => { await loadRoles(); await load(); });
</script>

<template>
  <div class="page">
    <div class="row wrap" style="justify-content: space-between; margin-bottom: 10px">
      <div class="row wrap" style="gap: 8px">
        <span class="pill accent">记忆星图</span>
        <select v-model="role" class="select" @change="load">
          <option v-for="r in roles" :key="r.role" :value="r.role">{{ r.label }}</option>
        </select>
        <span class="pill plain">{{ entries.length }} 颗星</span>
      </div>
      <div class="row" style="gap: 6px">
        <button class="btn btn-sm" @click="zoom = Math.min(1.6, zoom + 0.1)">＋</button>
        <button class="btn btn-sm" @click="zoom = Math.max(0.6, zoom - 0.1)">－</button>
        <button class="btn btn-sm" :disabled="loading" @click="load"><Icon name="refresh" :size="12" />刷新</button>
      </div>
    </div>

    <div class="map-layout">
      <SectionCard class="map-card" dense>
        <div v-if="loading" class="sub">加载中…</div>
        <div v-else-if="!entries.length" class="empty"><EmptyState text="这个人的记忆星图还是空的" hint="她通过 qq_brain_remember 记下第一件事后，这里会亮起一颗星" icon="memory" /></div>
        <div v-else class="sky">
          <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMid meet">
            <g :transform="`translate(${CX} ${CY}) scale(${zoom}) translate(${-CX} ${-CY})`">
              <circle v-for="(s, i) in stars" :key="'s' + i" :cx="s.x" :cy="s.y" :r="s.r" fill="#cbd5e1" :opacity="s.o" />
              <line v-for="(l, i) in links" :key="'l' + i" :x1="l.a.x" :y1="l.a.y" :x2="l.b.x" :y2="l.b.y" class="link" />
              <g v-for="n in nodes" :key="n.id" class="node" :class="{ on: selected?.id === n.id }" @click="pick(n)">
                <circle :cx="n.x" :cy="n.y" :r="n.rr + 6" class="halo" :style="{ fill: n.color, opacity: n.alpha * 0.12 }" />
                <circle :cx="n.x" :cy="n.y" :r="n.rr" class="star-dot" :style="{ fill: n.color, opacity: n.alpha, animationDelay: n.delay + 's' }" />
                <circle v-if="n.pin" :cx="n.x" :cy="n.y" :r="n.rr + 4.5" class="pin-ring" />
                <title>{{ n.content }}</title>
              </g>
            </g>
          </svg>
          <div class="hint">点击星星查看记忆 · 距离越近越重要 · 灰色已遗忘 · 圆环=钉住</div>
        </div>
      </SectionCard>

      <SectionCard class="detail-card" :title="selected ? '记忆详情' : '星图说明'">
        <div v-if="selected" class="detail">
          <div class="row" style="gap: 6px; margin-bottom: 8px">
            <span class="pill" :style="{ background: KIND_COLOR[selected.kind] + '22', color: KIND_COLOR[selected.kind] }">{{ KIND_LABEL[selected.kind] || selected.kind }}</span>
            <span v-if="selected.pin" class="pill info">钉住</span>
            <span v-if="selected.forgotten" class="pill bad">已遗忘</span>
          </div>
          <div class="detail-text">{{ selected.content }}</div>
          <div class="kv"><span>重要度</span><b>{{ Math.round((Number(selected.importance) || 0) * 100) }}%</b></div>
          <div class="kv"><span>强度</span><b>{{ (Number(selected.strength) || 1).toFixed(2) }}</b></div>
          <div class="kv"><span>保持率</span><b>{{ Math.round((Number(selected.retention) || 0) * 100) }}%</b></div>
          <div class="kv"><span>最后回忆</span><b>{{ fmtTime(selected.lastRecallAt) }}</b></div>
          <div class="kv" v-if="selected.tags?.length"><span>标签</span><b>{{ selected.tags.join(' / ') }}</b></div>
        </div>
        <div v-else class="legend-box">
          <div v-for="[k, c] in legend" :key="k" class="lg"><i :style="{ background: c }" />{{ KIND_LABEL[k] }}</div>
          <div class="tiny faint mt-2">星图按长期事实记忆生成；每次刷新会重新布局。遗忘的记忆会变灰，钉住的会有光环。</div>
        </div>
      </SectionCard>
    </div>
  </div>
</template>

<style scoped>
.map-layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: var(--sp-4); align-items: start; }
.map-card :deep(.card-body) { padding: 0; }
.sky { position: relative; background: radial-gradient(ellipse at 50% 45%, #0b1220 0%, #050810 60%, #01030a 100%); border-radius: var(--radius-sm); overflow: hidden; }
.sky svg { width: 100%; height: clamp(420px, 62vh, 640px); display: block; }
.link { stroke: #38bdf8; stroke-width: .6; opacity: .18; }
.node { cursor: pointer; }
.node .halo { transition: opacity .2s; }
.node:hover .halo { opacity: .35 !important; }
.node.on .halo { opacity: .45 !important; }
.star-dot { animation: twinkle 3.6s ease-in-out infinite; }
.pin-ring { fill: none; stroke: #fbbf24; stroke-width: 1; opacity: .8; }
@keyframes twinkle { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.5); } }
.hint { position: absolute; left: 12px; bottom: 10px; font-size: var(--fs-12); color: #94a3b8; }
.detail-text { font-size: var(--fs-13); line-height: 1.7; margin: 6px 0 12px; padding: 10px; border-radius: var(--radius-sm); background: var(--card2); border: 1px solid var(--border); }
.kv { display: flex; justify-content: space-between; font-size: var(--fs-12); color: var(--faint); padding: 4px 0; border-bottom: 1px dashed var(--border); }
.kv b { color: var(--fg); font-weight: 600; }
.legend-box { display: flex; flex-wrap: wrap; gap: 8px 14px; font-size: var(--fs-12); color: var(--faint); }
.lg { display: inline-flex; align-items: center; gap: 6px; }
.lg i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
@media (max-width: 900px) { .map-layout { grid-template-columns: 1fr; } }
</style>
