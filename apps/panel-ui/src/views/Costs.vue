<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SectionCard from '../components/SectionCard.vue';
import KpiCard from '../components/KpiCard.vue';
import LineChart from '../components/LineChart.vue';
import HBars from '../components/HBars.vue';
import DataTable from '../components/DataTable.vue';
import ErrorState from '../components/ErrorState.vue';
import FilterBar from '../components/FilterBar.vue';
import Icon from '../components/Icon.vue';
import { api, fmtMoney, fmtNum, fmtPct, fmtCompact, fmtTime } from '../api/client.js';
import { useResource } from '../composables/useResource.js';

const route = useRoute();
const router = useRouter();
const range = computed(() => ({ from: String(route.query.from || ''), to: String(route.query.to || '') }));
const { data, loading, error, load } = useResource(() => api.costs(range.value));
watch(() => route.query.from + '|' + route.query.to, () => load(true));

function setRange(patch) {
  const q = { ...route.query };
  for (const [k, v] of Object.entries(patch)) { if (v) q[k] = v; else delete q[k]; }
  router.replace({ query: q });
}
function quick(kind) {
  const t = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const ymd = (o) => new Date(Date.now() - o * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  if (kind === 'today') setRange({ from: t, to: t });
  else if (kind === '7') setRange({ from: ymd(6), to: t });
  else if (kind === '30') setRange({ from: ymd(29), to: t });
  else setRange({ from: '', to: '' });
}

const d = computed(() => data.value || {});
const cards = computed(() => {
  const total = d.value.totals || {};
  const today = d.value.today || {};
  const month = d.value.month || {};
  const cache = d.value.cache || {};
  const avg = d.value.avg || {};
  return [
    { label: '区间总花费', value: fmtMoney(total.cost, 3), hint: `${fmtNum(total.steps)} 步 · ${fmtNum(total.turns)} 轮`, tone: 'accent' },
    { label: '今日花费', value: fmtMoney(today.cost, 3), hint: `今日 ${fmtCompact(today.tokens)} tokens`, tone: 'info' },
    { label: '本月花费', value: fmtMoney(month.cost, 2), hint: `预算 ¥${fmtNum(month.budget)} · 已用 ${fmtPct(month.pct, 1)}`, tone: month.pct > 1 ? 'danger' : month.pct > 0.8 ? 'warn' : 'success' },
    { label: '账户余额', value: d.value.balance?.ok ? fmtMoney(d.value.balance.total, 2) : '—', hint: d.value.balance?.ok ? d.value.balance.currency : '未获取', tone: 'success' },
    { label: '缓存命中率', value: fmtPct(cache.hitRate, 1), hint: `命中 ${fmtCompact(cache.hit)} / 未命中 ${fmtCompact(cache.miss)}`, tone: 'accent' },
    { label: '单步均价', value: fmtMoney(avg.costPerStep, 4), hint: `单轮 ${fmtMoney(avg.costPerTurn, 3)}`, tone: 'info' },
    { label: '区间 Tokens', value: fmtCompact(total.tokens), hint: `日均 ${fmtCompact(avg.tokensPerTurn)} / 轮`, tone: 'accent' },
    { label: '本月预测', value: fmtMoney(month.projected, 2), hint: `剩余 ${month.daysLeft} 天 · 价目 ${d.value.price?.version || '—'}`, tone: month.projected > month.budget ? 'warn' : 'success' }
  ];
});

const dayLabels = computed(() => (d.value.days || []).slice(0, 30).reverse().map((x) => x.day.slice(5)));
const costSeries = computed(() => [{ name: '花费', color: 'var(--chart-1)', data: (d.value.days || []).slice(0, 30).reverse().map((x) => x.cost) }]);
const cacheSeries = computed(() => [{ name: '命中率', color: 'var(--chart-2)', data: (d.value.days || []).slice(0, 30).reverse().map((x) => x.cacheHitRate) }]);
const modelItems = computed(() => (d.value.models || []).map((m) => ({ label: m.model, value: m.cost, share: m.share })));

const daySort = ref({ key: 'day', dir: 'desc' });
const dayRows = computed(() => {
  const list = [...(d.value.days || [])];
  const { key, dir } = daySort.value;
  list.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'number' && typeof bv === 'number') return dir === 'asc' ? av - bv : bv - av;
    return dir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });
  return list;
});
const dayCols = [
  { key: 'day', label: '日期', width: 120 },
  { key: 'cost', label: '花费', type: 'money', align: 'right', width: 110 },
  { key: 'tokens', label: 'Tokens', type: 'number', align: 'right', width: 120 },
  { key: 'steps', label: '步数', type: 'number', align: 'right', width: 90 },
  { key: 'turns', label: '轮次', type: 'number', align: 'right', width: 90 },
  { key: 'cacheHitRate', label: '缓存命中', type: 'percent', align: 'right', width: 100 }
];
function toggleDaySort(k) {
  if (daySort.value.key === k) daySort.value.dir = daySort.value.dir === 'asc' ? 'desc' : 'asc';
  else daySort.value = { key: k, dir: 'desc' };
}

const convSort = ref({ key: 'cost', dir: 'desc' });
const convRows = computed(() => {
  const list = [...(d.value.convs || [])].map((c) => ({ ...c, name: c.name || c.key }));
  const { key, dir } = convSort.value;
  list.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'number' && typeof bv === 'number') return dir === 'asc' ? av - bv : bv - av;
    return dir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });
  return list;
});
const convCols = [
  { key: 'name', label: '会话', width: 260 },
  { key: 'cost', label: '花费', type: 'money', align: 'right', width: 110 },
  { key: 'tokens', label: 'Tokens', type: 'number', align: 'right', width: 120 },
  { key: 'steps', label: '步数', type: 'number', align: 'right', width: 90 },
  { key: 'turns', label: '轮次', type: 'number', align: 'right', width: 90 },
  { key: 'lastAt', label: '最近活动', type: 'time', width: 170 }
];
function toggleConvSort(k) {
  if (convSort.value.key === k) convSort.value.dir = convSort.value.dir === 'asc' ? 'desc' : 'asc';
  else convSort.value = { key: k, dir: 'desc' };
}
const fmtTs = (v) => fmtTime(v);
</script>

<template>
  <div class="page">
    <div class="row wrap" style="justify-content: space-between">
      <span class="small faint">用量来自 DSH 会话记录，费用按桥接价目表折算（峰谷分时）</span>
      <a class="btn" :href="api.exportUrl('tokens')" download><Icon name="download" :size="14" />导出用量 CSV</a>
    </div>

    <FilterBar
      :from="range.from"
      :to="range.to"
      :has-range="Boolean(range.from || range.to)"
      :show-search="false"
      @update:from="(v) => setRange({ from: v })"
      @update:to="(v) => setRange({ to: v })"
      @quick="quick"
      @clear="setRange({ from: '', to: '' })"
    />

    <ErrorState v-if="error && !data" :message="error" @retry="load(false)" />

    <template v-if="data">
      <div class="grid grid-4">
        <KpiCard v-for="c in cards" :key="c.label" :label="c.label" :value="c.value" :hint="c.hint" :tone="c.tone" small />
      </div>

      <div class="grid grid-2">
        <SectionCard title="每日花费" dense>
          <LineChart :labels="dayLabels" :series="costSeries" :height="210" format="money" />
        </SectionCard>
        <SectionCard title="每日缓存命中率" dense>
          <LineChart :labels="dayLabels" :series="cacheSeries" :height="210" format="percent" area />
        </SectionCard>
      </div>

      <div class="grid grid-side">
        <SectionCard title="按日明细">
          <DataTable
            :columns="dayCols"
            :rows="dayRows"
            :sort="daySort.key"
            :dir="daySort.dir"
            :sortable="['day', 'cost', 'tokens', 'steps', 'turns', 'cacheHitRate']"
            empty-text="区间内没有用量记录"
            @sort="toggleDaySort"
          />
        </SectionCard>
        <SectionCard title="模型花费占比" dense>
          <HBars :items="modelItems" format="money" :limit="8" />
          <div class="divider" style="margin: 14px 0" />
          <div class="small muted">单步均价 {{ fmtMoney(d.avg?.costPerStep, 4) }} · 单轮均价 {{ fmtMoney(d.avg?.costPerTurn, 3) }}</div>
        </SectionCard>
      </div>

      <SectionCard title="按会话拆分">
        <DataTable
          :columns="convCols"
          :rows="convRows"
          :sort="convSort.key"
          :dir="convSort.dir"
          :sortable="['name', 'cost', 'tokens', 'steps', 'turns']"
          empty-text="没有会话用量"
          @sort="toggleConvSort"
        >
          <template #cell-name="{ row }">
            <div class="conv-cell">
              <div class="row" style="gap: 6px; min-width: 0">
                <span class="conv-name truncate" :title="row.name">{{ row.name }}</span>
                <span v-if="row.isOwner" class="tag">主人</span>
                <span v-else-if="row.kind === 'group'" class="tag">群</span>
                <span v-else-if="row.kind === 'private'" class="tag">私聊</span>
                <span v-else-if="row.kind === 'internal'" class="tag">内部</span>
              </div>
              <span class="conv-key mono truncate" :title="row.key">{{ row.key }}</span>
            </div>
          </template>
          <template #cell-lastAt="{ value }">{{ fmtTs(value) }}</template>
        </DataTable>
      </SectionCard>
    </template>
  </div>
</template>

<style scoped>
.data-table :deep(td) { white-space: nowrap; }
.conv-cell { display: flex; flex-direction: column; gap: 1px; min-width: 0; max-width: 250px; }
.conv-name { font-weight: 600; color: var(--text); font-size: var(--fs-12); max-width: 190px; }
.conv-key { font-size: 10.5px; color: var(--faint); max-width: 240px; }
</style>
