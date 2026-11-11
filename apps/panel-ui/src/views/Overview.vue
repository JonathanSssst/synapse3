<script setup>
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SectionCard from '../components/SectionCard.vue';
import KpiCard from '../components/KpiCard.vue';
import LineChart from '../components/LineChart.vue';
import BarChart from '../components/BarChart.vue';
import HBars from '../components/HBars.vue';
import ErrorState from '../components/ErrorState.vue';
import StatusPill from '../components/StatusPill.vue';
import FilterBar from '../components/FilterBar.vue';
import { api, fmtMoney, fmtNum, fmtCompact, fmtPct, fmtTime, fmtClock } from '../api/client.js';
import { useResource } from '../composables/useResource.js';

const route = useRoute();
const router = useRouter();
const range = computed(() => ({ from: String(route.query.from || ''), to: String(route.query.to || '') }));
const { data, loading, error, load } = useResource(() => api.overview(range.value));
watch(() => route.query.from + '|' + route.query.to, () => load(true));

function setRange(patch) {
  const q = { ...route.query };
  for (const [k, v] of Object.entries(patch)) {
    if (v) q[k] = v;
    else delete q[k];
  }
  router.replace({ query: q });
}

const d = computed(() => data.value || {});
const k = computed(() => d.value.kpis || {});
const alerts = computed(() => d.value.alerts || []);
const trends = computed(() => d.value.trends || { days: [], toolTop: [], models: [] });

const cards = computed(() => [
  { label: '今日花费', value: fmtMoney(k.value.todayCost), hint: `阈值 ¥${fmtNum(d.value.alertsConfig?.dailyCostWarn ?? 0)}`, tone: Number(k.value.todayCost) > Number(d.value.alertsConfig?.dailyCostWarn ?? 0) ? 'warn' : 'accent' },
  { label: '本月花费', value: fmtMoney(k.value.monthCost, 2), hint: `预算 ¥${fmtNum(k.value.monthBudget)} · ${fmtPct((k.value.monthCost || 0) / Math.max(1, k.value.monthBudget || 1), 0)}`, tone: 'info' },
  { label: '账户余额', value: d.value.balance?.ok ? fmtMoney(d.value.balance.total, 2) : '—', hint: d.value.balance?.ok ? d.value.balance.currency : (d.value.balance?.error || '未获取'), tone: d.value.balance?.ok && Number(d.value.balance.total) <= 3 ? 'danger' : 'success' },
  { label: '今日 Tokens', value: fmtCompact(k.value.todayTokens), hint: `缓存命中 ${fmtPct(k.value.cacheHitRate, 1)}`, tone: 'accent' },
  { label: '今日工具错误', value: fmtNum(k.value.errorsToday), hint: `工具结果 ${fmtNum(k.value.toolResults)} 条`, tone: Number(k.value.errorsToday) > 0 ? 'danger' : 'success' }
]);

const dayLabels = computed(() => trends.value.days.map((x) => x.day.slice(5)));
const costSeries = computed(() => [{ name: '花费', color: 'var(--chart-1)', data: trends.value.days.map((x) => x.cost) }]);
const errValues = computed(() => trends.value.days.map((x) => x.error));
const modelItems = computed(() => trends.value.models.map((m) => ({ label: m.model, value: m.cost, share: m.share, color: 'var(--chart-3)' })));
const toolItems = computed(() => trends.value.toolTop.map((t) => ({ label: t.tool.replace(/^mcp__[^_]+__/, ''), value: t.calls, color: 'var(--chart-2)' })));
const activity = computed(() => d.value.activity || []);

// 倒计时（下一次 B 站 / 睡眠 / 自主时间）
const nowTick = ref(Date.now());
let timer = 0;
onMounted(() => { timer = setInterval(() => { nowTick.value = Date.now(); }, 1000); });
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
const nextBili = computed(() => d.value.next?.biliScheduleNext || 0);
const nextFree = computed(() => d.value.next?.freeTimeState?.nextAt || 0);
const sleepPlan = computed(() => d.value.next?.sleepPlan || null);

const convName = (key) => String(key || '').replace('private:', '私聊 ').replace('group:', '群 ');
</script>

<template>
  <div class="page">
    <div class="row wrap" style="justify-content: space-between">
      <div class="row wrap" style="gap: 8px">
        <span class="pill accent">运行中</span>
        <StatusPill :ok="d.status?.reachable" :label="d.status?.reachable ? '桥接在线' : '桥接离线'" />
        <span class="pill plain">{{ d.meta?.role || '未设置人设' }}</span>
        <span class="pill plain">{{ d.meta?.mode || '—' }}</span>
        <span v-if="d.meta?.paused" class="pill warn">已暂停</span>
        <span v-if="d.costGuard?.active" class="pill warn">成本守护</span>
      </div>
      <span class="small faint">数据更新：{{ d.generatedAt ? fmtClock(Date.parse(d.generatedAt)) : '—' }}</span>
    </div>

    <FilterBar
      :from="range.from"
      :to="range.to"
      :has-range="Boolean(range.from || range.to)"
      :show-search="false"
      @update:from="(v) => setRange({ from: v })"
      @update:to="(v) => setRange({ to: v })"
      @quick="(kind) => {
        const t = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        const ymd = (o) => new Date(Date.now() - o * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        if (kind === 'today') setRange({ from: t, to: t });
        else if (kind === '7') setRange({ from: ymd(6), to: t });
        else if (kind === '30') setRange({ from: ymd(29), to: t });
        else setRange({ from: '', to: '' });
      }"
      @clear="setRange({ from: '', to: '' })"
    />

    <div v-if="alerts.length" class="alerts">
      <div v-for="(a, i) in alerts" :key="i" class="alert" :class="a.level">
        <span class="alert-dot" />{{ a.text }}
      </div>
    </div>

    <ErrorState v-if="error && !data" :message="error" @retry="load(false)" />

    <div v-if="!data && loading" class="grid grid-5">
      <div v-for="i in 5" :key="i" class="card" style="height: 96px; padding: 16px">
        <div class="skeleton" style="width: 40%; height: 10px" />
        <div class="skeleton" style="width: 60%; height: 26px; margin-top: 12px" />
      </div>
    </div>

    <template v-if="data">
      <div class="grid grid-5">
        <KpiCard v-for="c in cards" :key="c.label" :label="c.label" :value="c.value" :hint="c.hint" :tone="c.tone" />
      </div>

      <div class="grid grid-side">
        <SectionCard title="近 7 日花费" dense>
          <LineChart :labels="dayLabels" :series="costSeries" :height="200" format="money" />
        </SectionCard>
        <SectionCard title="工具错误趋势" dense>
          <BarChart :labels="dayLabels" :values="errValues" :height="200" format="number" color="var(--chart-5)" />
        </SectionCard>
      </div>

      <div class="grid grid-3">
        <SectionCard title="模型花费占比" dense>
          <HBars :items="modelItems" format="money" :limit="5" />
        </SectionCard>
        <SectionCard title="工具调用 Top" dense>
          <HBars :items="toolItems" :limit="6" />
        </SectionCard>
        <SectionCard title="最近活动" dense>
          <div class="feed">
            <div v-for="(a, i) in activity.slice(0, 8)" :key="i" class="feed-row">
              <span class="feed-time num">{{ String(a.tLocal || '').slice(5, 16) }}</span>
              <span class="feed-tag">{{ convName(a.conv) }}</span>
              <span class="feed-text truncate" :title="a.text">{{ a.text }}</span>
            </div>
            <div v-if="!activity.length" class="faint small">暂无活动</div>
          </div>
        </SectionCard>
      </div>

      <div class="grid grid-2">
        <SectionCard title="她的下一步">
          <div class="next-list">
            <div class="next-row">
              <span class="next-icon"><span class="pulse" /></span>
              <div class="grow">
                <div class="small text">下一次刷 B 站</div>
                <div class="faint tiny">{{ nextBili ? fmtTime(nextBili) : '未排期' }}</div>
              </div>
              <span class="num next-left">{{ nextBili ? left(nextBili) : '—' }}</span>
            </div>
            <div class="next-row">
              <span class="next-icon info"><span class="pulse" /></span>
              <div class="grow">
                <div class="small text">下一次自主时间</div>
                <div class="faint tiny">{{ nextFree ? fmtTime(nextFree) : '未排期' }}</div>
              </div>
              <span class="num next-left">{{ nextFree ? left(nextFree) : '—' }}</span>
            </div>
            <div class="next-row">
              <span class="next-icon warn"><span class="pulse" /></span>
              <div class="grow">
                <div class="small text">睡眠计划</div>
                <div class="faint tiny">{{ sleepPlan?.note || '无' }}</div>
              </div>
              <span class="num next-left">{{ sleepPlan ? left(sleepPlan.wakeAt) : '—' }}</span>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="运行状态">
          <dl class="kv">
            <dt>对话数</dt><dd>{{ (d.meta?.conversations || []).length }} 个（{{ (d.meta?.conversations || []).join('、') }}）</dd>
            <dt>主人 QQ</dt><dd class="mono">{{ d.meta?.ownerQQ || '—' }}</dd>
            <dt>桥接状态</dt><dd><StatusPill :ok="d.status?.reachable" :label="d.status?.reachable ? '在线' : '离线'" /></dd>
            <dt>审计库</dt><dd>{{ d.meta?.db ? `${fmtNum(d.meta.db.tools)} 工具 / ${fmtNum(d.meta.db.tokens)} 用量 / ${fmtNum(d.meta.db.activity)} 活动` : '—' }}</dd>
            <dt>今日 B 站</dt><dd>{{ fmtNum(k.biliToday) }} 次 · 累计 {{ fmtNum(k.biliTotal) }} 次</dd>
            <dt>今日空间</dt><dd>{{ fmtNum(k.qzoneToday) }} 次 · 累计 {{ fmtNum(k.qzoneTotal) }} 次</dd>
            <dt>生成图</dt><dd>{{ fmtNum(k.genTotal) }} 张 · 表情 {{ fmtNum(k.stickersTotal) }} 个 · 人设 {{ fmtNum(k.personasTotal) }} 个</dd>
            <dt>健康自检</dt><dd><StatusPill :ok="d.health?.ok !== false" :label="d.health?.ok === false ? '异常' : '正常'" /></dd>
          </dl>
        </SectionCard>
      </div>
    </template>
  </div>
</template>

<style scoped>
.alerts { display: flex; flex-wrap: wrap; gap: 8px; }
.alert {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface);
  font-size: var(--fs-12);
  color: var(--text-2);
}
.alert.warn { border-color: color-mix(in srgb, var(--warn) 35%, transparent); background: var(--warn-soft); color: var(--warn); }
.alert.bad { border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: var(--danger-soft); color: var(--danger); }
.alert-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.feed { display: flex; flex-direction: column; gap: 2px; }
.feed-row { display: flex; align-items: center; gap: 8px; padding: 5px 4px; border-radius: var(--radius-xs); font-size: var(--fs-12); }
.feed-row:hover { background: var(--surface-2); }
.feed-time { color: var(--faint); font-size: 10.5px; flex: 0 0 88px; }
.feed-tag { color: var(--accent); font-size: 10.5px; flex: 0 0 auto; max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.feed-text { color: var(--text-2); flex: 1 1 auto; }

.next-list { display: flex; flex-direction: column; gap: 6px; }
.next-row { display: flex; align-items: center; gap: 12px; padding: 8px 6px; border-radius: var(--radius-sm); }
.next-row:hover { background: var(--surface-2); }
.next-icon { width: 26px; height: 26px; border-radius: 50%; background: var(--accent-soft); display: grid; place-items: center; flex: 0 0 auto; }
.next-icon.info { background: var(--info-soft); }
.next-icon.warn { background: var(--warn-soft); }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }
.next-icon.info .pulse { background: var(--info); box-shadow: 0 0 8px var(--info); }
.next-icon.warn .pulse { background: var(--warn); box-shadow: 0 0 8px var(--warn); }
.next-left { color: var(--accent); font-size: var(--fs-12); font-weight: 600; white-space: nowrap; }
</style>
