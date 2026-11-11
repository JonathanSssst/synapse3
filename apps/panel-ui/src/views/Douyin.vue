<script setup>
// 抖音：概览条 + 观看足迹（douyin_event）
import { computed } from 'vue';
import RecordTable from '../components/RecordTable.vue';
import SectionCard from '../components/SectionCard.vue';
import KpiCard from '../components/KpiCard.vue';
import HBars from '../components/HBars.vue';
import ErrorState from '../components/ErrorState.vue';
import { api, fmtNum } from '../api/client.js';
import { useResource } from '../composables/useResource.js';

const RECENT = 200;

const { data, error, load } = useResource(async () => {
  const ev = await api.records('douyin_event', { page: 1, pageSize: RECENT });
  return { items: ev?.items || [], total: Number(ev?.total || 0) };
});

const d = computed(() => data.value || {});
const items = computed(() => d.value.items || []);
const total = computed(() => Number(d.value.total || 0));

const latest = computed(() => items.value[0]?.tLocal || '');
const authors = computed(() => {
  const m = new Map();
  for (const it of items.value) {
    const a = String(it.author || '').trim();
    if (!a) continue;
    m.set(a, (m.get(a) || 0) + 1);
  }
  return m;
});
const authorCount = computed(() => authors.value.size);
const authorItems = computed(() =>
  [...authors.value.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({ label, value }))
);

const ACTION_LABELS = { watch: '观看内容', video: '视频详情', hot: '刷热点', search: '搜索' };
const ACTION_TONES = { watch: 'info', video: 'accent', hot: 'warn', search: 'accent' };
const actionLabel = (a) => ACTION_LABELS[a] || a || '—';
const actionTone = (a) => ACTION_TONES[a] || 'plain';

const actionKinds = computed(() => {
  const out = [];
  const seen = new Set();
  for (const it of items.value) {
    const a = String(it.action || '');
    if (!a || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
});
const actionItems = computed(() => {
  const m = new Map();
  for (const it of items.value) {
    const a = actionLabel(it.action);
    m.set(a, (m.get(a) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
});

const cards = computed(() => [
  { label: '累计刷抖音', value: fmtNum(total.value), hint: `最近 ${fmtNum(items.value.length)} 条记录`, tone: 'accent' },
  { label: '最近一次', value: latest.value ? latest.value.slice(5, 16) : '—', hint: latest.value || '还没有记录', tone: 'info', small: true },
  { label: '不同作者', value: fmtNum(authorCount.value), hint: '最近 200 条去重', tone: 'success' },
  {
    label: '动作种类',
    value: fmtNum(actionKinds.value.length),
    hint: actionKinds.value.length ? actionKinds.value.map(actionLabel).join(' / ') : '还没有动作',
    tone: 'info'
  }
]);
</script>

<template>
  <div class="page">
    <div class="row wrap" style="justify-content: space-between">
      <span class="small faint">足迹来自桥接审计库 · 点击任意行查看详情</span>
      <span v-if="latest" class="small faint">最近一次：{{ latest }}</span>
    </div>

    <ErrorState v-if="error && !data" :message="'抖音数据加载失败：' + error" @retry="load(false)" />
    <div v-else-if="error && data" class="error-banner">
      <span class="grow">刷新失败：{{ error }}（显示上次数据）</span>
      <button class="btn btn-sm" @click="load(false)">重试</button>
    </div>

    <div v-if="!data && !error" class="grid grid-4">
      <div v-for="i in 4" :key="i" class="card" style="height: 96px; padding: 16px">
        <div class="skeleton" style="width: 40%; height: 10px" />
        <div class="skeleton" style="width: 62%; height: 26px; margin-top: 12px" />
      </div>
    </div>

    <div v-else-if="data" class="grid grid-4">
      <KpiCard
        v-for="c in cards"
        :key="c.label"
        :label="c.label"
        :value="c.value"
        :hint="c.hint"
        :tone="c.tone"
        :small="Boolean(c.small)"
      />
    </div>

    <RecordTable
      key="douyin_event"
      type="douyin_event"
      placeholder="搜索标题 / 作者 / 视频 ID…"
      empty-text="她还没刷过抖音"
      empty-hint="等她想看视频或刷热点时，这里会出现足迹"
    >
      <template #cell-action="{ value }">
        <span class="pill" :class="actionTone(value)">{{ actionLabel(value) }}</span>
      </template>
      <template #cell-title="{ row }">
        <span class="cell-ellipsis" :title="[row.title, row.detail].filter(Boolean).join('\n')">{{ row.title || row.detail || '—' }}</span>
      </template>
      <template #cell-awemeId="{ value }">
        <a
          v-if="value"
          class="ext-link mono"
          :href="`https://www.douyin.com/video/${value}`"
          target="_blank"
          rel="noopener"
          :title="'在新窗口打开抖音：' + value"
          @click.stop
        >{{ value }}</a>
        <span v-else class="faint">—</span>
      </template>
    </RecordTable>

    <div v-if="data" class="grid grid-2">
      <SectionCard title="作者分布" :subtitle="`最近 ${fmtNum(items.length)} 条 · ${fmtNum(authorCount)} 位作者`" dense>
        <HBars :items="authorItems" :limit="6" />
      </SectionCard>
      <SectionCard title="动作分布" :subtitle="`${fmtNum(actionKinds.length)} 种动作`" dense>
        <HBars :items="actionItems" :limit="6" />
      </SectionCard>
    </div>
  </div>
</template>

<style scoped>
.cell-ellipsis { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ext-link { color: var(--accent); white-space: nowrap; }
.ext-link:hover { color: var(--accent-hover); text-decoration: underline; }
</style>
