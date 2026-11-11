<script setup>
// B 站：观看足迹 / 她的感受（两条 RecordTable） + 概览条 + UP 主分布
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import RecordTable from '../components/RecordTable.vue';
import SectionCard from '../components/SectionCard.vue';
import KpiCard from '../components/KpiCard.vue';
import HBars from '../components/HBars.vue';
import ErrorState from '../components/ErrorState.vue';
import { api, fmtNum, fmtTime } from '../api/client.js';
import { useResource } from '../composables/useResource.js';

const RECENT = 200;

const { data, error, load } = useResource(async () => {
  const [ev, nt, ov] = await Promise.allSettled([
    api.records('bili_event', { page: 1, pageSize: RECENT }),
    api.records('bili_note', { page: 1, pageSize: RECENT }),
    api.overview({}, true)
  ]);
  if ([ev, nt, ov].every((r) => r.status === 'rejected')) throw ev.reason || new Error('B 站数据加载失败');
  const pick = (r) => (r.status === 'fulfilled' ? r.value : null);
  const e = pick(ev);
  const n = pick(nt);
  return {
    events: e?.items || [],
    eventTotal: Number(e?.total || 0),
    notes: n?.items || [],
    noteTotal: Number(n?.total || 0),
    ov: pick(ov) || null
  };
});

const d = computed(() => data.value || {});
const events = computed(() => d.value.events || []);
const eventTotal = computed(() => Number(d.value.eventTotal || 0));
const noteTotal = computed(() => Number(d.value.noteTotal || 0));

// UP 主分布（最近 200 条事件去重计数）
const upCounts = computed(() => {
  const m = new Map();
  for (const e of events.value) {
    const up = String(e.up || '').trim();
    if (!up) continue;
    m.set(up, (m.get(up) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
});
const upTotal = computed(() => upCounts.value.length);
const upItems = computed(() => upCounts.value.slice(0, 6).map(([label, value]) => ({ label, value })));

// 今日观看：优先用后端 KPI，缺失时从最近 200 条事件里按北京时间统计
const localToday = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const todayBili = computed(() => {
  const v = d.value.ov?.kpis?.biliToday;
  if (v != null && Number.isFinite(Number(v))) return Number(v);
  return events.value.filter((e) => String(e.tLocal || '').slice(0, 10) === localToday).length;
});

const latestAt = computed(() => events.value[0]?.tLocal || '');
const nextBili = computed(() => Number(d.value.ov?.next?.biliScheduleNext || 0));

// 1 秒倒计时（不阻塞主内容加载）
const nowTick = ref(Date.now());
let timer = 0;
onMounted(() => {
  timer = setInterval(() => { nowTick.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

function left(ts) {
  const t = Number(ts || 0);
  if (!t) return '—';
  const diff = t - nowTick.value;
  if (diff <= 0) return '已到时间';
  const s = Math.floor(diff / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}

const cards = computed(() => [
  { label: '累计观看', value: fmtNum(eventTotal.value), hint: `全部 ${fmtNum(eventTotal.value)} 条 B 站事件`, tone: 'accent' },
  { label: '今日观看', value: fmtNum(todayBili.value), hint: todayBili.value ? '北京时间今天已刷过' : '北京时间今天还没刷', tone: 'info' },
  { label: '她写下的感受', value: fmtNum(noteTotal.value), hint: '看完视频后的笔记', tone: 'success' },
  { label: '涉及 UP 主', value: fmtNum(upTotal.value), hint: `最近 ${fmtNum(events.value.length)} 条去重`, tone: 'accent' },
  { label: '下次刷 B 站', value: nextBili.value ? left(nextBili.value) : '未排期', hint: nextBili.value ? fmtTime(nextBili.value) : '等待调度', tone: 'info', small: true }
]);

// 分栏（?tab=note 可直接定位到「她的感受」）
const route = useRoute();
const tab = ref(String(route.query.tab) === 'note' ? 'note' : 'event');
const tabs = computed(() => [
  { key: 'event', label: '观看足迹', count: eventTotal.value },
  { key: 'note', label: '她的感受', count: noteTotal.value }
]);

const recentVideos = computed(() => {
  const seen = new Set();
  const out = [];
  for (const e of events.value) {
    if (!e.bvid || seen.has(e.bvid)) continue;
    seen.add(e.bvid);
    out.push({ id: e.id, title: e.title || e.bvid, up: e.up || '', tLocal: e.tLocal || '' });
    if (out.length >= 5) break;
  }
  return out;
});

const ACTION_LABELS = { browse_video: '观看', watch: '观看', browse_search: '搜索', browse_hot: '热门', favorite: '收藏' };
const ACTION_TONES = { browse_video: 'info', watch: 'info', browse_search: 'accent', browse_hot: 'warn', favorite: 'success' };
const actionLabel = (a) => ACTION_LABELS[a] || a || '—';
const actionTone = (a) => ACTION_TONES[a] || 'plain';
</script>

<template>
  <div class="page">
    <div class="row wrap" style="justify-content: space-between">
      <span class="small faint">足迹来自桥接审计库 · 点击任意行查看详情</span>
      <span v-if="latestAt" class="small faint">最近观看：{{ latestAt }}</span>
    </div>

    <ErrorState v-if="error && !data" :message="'B 站数据加载失败：' + error" @retry="load(false)" />
    <div v-else-if="error && data" class="error-banner">
      <span class="grow">概览刷新失败：{{ error }}（列表仍可查看上次数据）</span>
      <button class="btn btn-sm" @click="load(false)">重试</button>
    </div>

    <div v-if="!data && !error" class="grid grid-5">
      <div v-for="i in 5" :key="i" class="card" style="height: 96px; padding: 16px">
        <div class="skeleton" style="width: 40%; height: 10px" />
        <div class="skeleton" style="width: 62%; height: 26px; margin-top: 12px" />
      </div>
    </div>

    <div v-else-if="data" class="grid grid-5">
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

    <div class="row wrap" style="justify-content: space-between">
      <div class="seg">
        <button v-for="t in tabs" :key="t.key" class="seg-btn" :class="{ on: tab === t.key }" @click="tab = t.key">
          {{ t.label }}<span class="seg-count num">{{ fmtNum(t.count) }}</span>
        </button>
      </div>
      <span class="small faint">{{ tab === 'event' ? '搜索匹配标题 / UP 主 / BV 号' : '搜索匹配标题 / UP 主 / 感受' }}</span>
    </div>

    <RecordTable
      v-if="tab === 'event'"
      key="bili_event"
      type="bili_event"
      placeholder="搜索标题 / UP 主 / BV 号…"
      empty-text="她还没刷过 B 站"
      empty-hint="等她想看视频、搜内容或刷热门时，这里会出现足迹"
    >
      <template #cell-action="{ value }">
        <span class="pill" :class="actionTone(value)">{{ actionLabel(value) }}</span>
      </template>
      <template #cell-title="{ row }">
        <span class="cell-ellipsis" :title="[row.title, row.detail].filter(Boolean).join('\n')">{{ row.title || row.detail || '—' }}</span>
      </template>
      <template #cell-bvid="{ value }">
        <a
          v-if="value"
          class="ext-link mono"
          :href="`https://www.bilibili.com/video/${value}`"
          target="_blank"
          rel="noopener"
          :title="'在新窗口打开 B 站：' + value"
          @click.stop
        >{{ value }}</a>
        <span v-else class="faint">—</span>
      </template>
    </RecordTable>

    <RecordTable
      v-else
      key="bili_note"
      type="bili_note"
      placeholder="搜索标题 / UP 主 / 感受…"
      empty-text="她还没写下感受"
      empty-hint="看完视频有想法时，她会把感受记在这里"
    >
      <template #cell-title="{ row }">
        <span class="cell-ellipsis" :title="row.title">{{ row.title || '—' }}</span>
      </template>
      <template #cell-bvid="{ value }">
        <a
          v-if="value"
          class="ext-link mono"
          :href="`https://www.bilibili.com/video/${value}`"
          target="_blank"
          rel="noopener"
          :title="'在新窗口打开 B 站：' + value"
          @click.stop
        >{{ value }}</a>
        <span v-else class="faint">—</span>
      </template>
      <template #cell-note="{ value }">
        <span class="note-cell" :title="value">{{ value }}</span>
      </template>
    </RecordTable>

    <div v-if="data" class="grid grid-2">
      <SectionCard title="UP 主分布" :subtitle="`最近 ${fmtNum(events.length)} 条观看 · ${fmtNum(upTotal)} 位 UP 主`" dense>
        <HBars :items="upItems" :limit="6" />
      </SectionCard>
      <SectionCard title="最近看过" subtitle="按 BV 号去重" dense>
        <div class="feed">
          <RouterLink
            v-for="v in recentVideos"
            :key="v.id"
            class="feed-row"
            :to="{ name: 'detail', params: { type: 'bili_event', id: v.id } }"
          >
            <span class="feed-time num">{{ String(v.tLocal || '').slice(5, 16) }}</span>
            <span class="grow truncate" :title="v.title">{{ v.title }}</span>
            <span class="feed-up truncate" :title="v.up">{{ v.up || '—' }}</span>
          </RouterLink>
          <div v-if="!recentVideos.length" class="faint small">还没有观看记录</div>
        </div>
      </SectionCard>
    </div>
  </div>
</template>

<style scoped>
.seg { display: inline-flex; gap: 2px; background: var(--surface-2); padding: 3px; border-radius: var(--radius-sm); border: 1px solid var(--border); }
.seg-btn { height: 28px; padding: 0 14px; border-radius: var(--radius-xs); color: var(--muted); font-size: var(--fs-12); }
.seg-btn:hover { color: var(--text); }
.seg-btn.on { background: var(--surface); color: var(--accent); box-shadow: var(--shadow-1); font-weight: 600; }
.seg-count { margin-left: 6px; font-size: 10px; color: var(--faint); }
.seg-btn.on .seg-count { color: var(--accent); }

.cell-ellipsis { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ext-link { color: var(--accent); white-space: nowrap; }
.ext-link:hover { color: var(--accent-hover); text-decoration: underline; }
.note-cell {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-style: italic;
  color: var(--text-2);
  border-left: 2px solid var(--border-strong);
  padding-left: 8px;
  line-height: 1.55;
}

.feed { display: flex; flex-direction: column; gap: 2px; }
.feed-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  border-radius: var(--radius-xs);
  font-size: var(--fs-12);
  color: var(--text-2);
}
.feed-row:hover { background: var(--surface-2); color: var(--text); }
.feed-time { color: var(--faint); font-size: 10.5px; flex: 0 0 82px; }
.feed-up { color: var(--muted); font-size: 10.5px; flex: 0 0 auto; max-width: 96px; }
</style>
