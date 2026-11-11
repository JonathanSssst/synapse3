<script setup>
// QQ 空间：状态卡 + 动作时间线（qzone_action） + 最近说说 / 动作构成
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import RecordTable from '../components/RecordTable.vue';
import SectionCard from '../components/SectionCard.vue';
import HBars from '../components/HBars.vue';
import ErrorState from '../components/ErrorState.vue';
import Icon from '../components/Icon.vue';
import { api, fmtNum, fmtTime } from '../api/client.js';
import { useResource } from '../composables/useResource.js';

const { data, error, load } = useResource(() => api.qzone());

const d = computed(() => data.value || {});
const state = computed(() => d.value.state || {});
const paused = computed(() => Boolean(state.value.paused));
const events = computed(() => d.value.events || []);
const total = computed(() => Number(d.value.total || events.value.length || 0));
const postsToday = computed(() => Number(state.value.postsToday || 0));
const repliesToday = computed(() => Number(state.value.repliesToday || 0));
const likesToday = computed(() => Number(state.value.likesToday || 0));
const failStreak = computed(() => Number(state.value.qzFailStreak || 0));
const nextPostAt = computed(() => Number(state.value.nextPostAt || 0));
const lastPostAt = computed(() => Number(state.value.lastPostAt || 0));
const pauseAt = computed(() => Number(state.value.pauseAt || 0));
const pauseReason = computed(() => String(state.value.pauseReason || ''));

// 1 秒倒计时
const nowTick = ref(Date.now());
let timer = 0;
onMounted(() => {
  timer = setInterval(() => { nowTick.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

function left(ts) {
  const t = Number(ts || 0);
  if (!t) return '未排期';
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
const nextState = computed(() => {
  if (paused.value) return { text: '暂停中', tone: 'paused' };
  if (!nextPostAt.value) return { text: '未排期', tone: 'idle' };
  if (nextPostAt.value <= nowTick.value) return { text: '计划时间已过', tone: 'late' };
  return { text: left(nextPostAt.value), tone: 'ok' };
});

// 动作类型 → 语义 pill（ok=success / 进行中=info / 失败·暂停=danger / start=plain）
const TYPE_META = {
  post_ok: ['发帖成功', 'success'],
  post_posting: ['发帖中', 'info'],
  post_dry: ['演练发帖', 'info'],
  post_fail: ['发帖失败', 'danger'],
  post_compose_fail: ['文案生成失败', 'danger'],
  reply_ok: ['回复成功', 'success'],
  reply_fail: ['回复失败', 'danger'],
  like_ok: ['点赞成功', 'success'],
  image_ok: ['生成配图', 'success'],
  start: ['启动', 'plain'],
  pause: ['暂停', 'danger'],
  risk_pause: ['风控暂停', 'danger'],
  cycle_skip_paused: ['暂停跳过', 'danger'],
  comment_error: ['评论检查失败', 'danger'],
  comment_retry: ['空间接口超时重试', 'warn'],
  comment_list_fail: ['评论列表失败', 'danger'],
  once_done: ['单次完成', 'plain'],
  already_running: ['已在运行', 'warn']
};
function typeMeta(t) {
  const key = String(t || '');
  if (TYPE_META[key]) return TYPE_META[key];
  if (key.endsWith('_ok')) return [key, 'success'];
  if (/fail|error|pause|risk/.test(key)) return [key, 'danger'];
  if (/_dry$|posting/.test(key)) return [key, 'info'];
  if (key === 'start') return [key, 'plain'];
  return [key || '—', 'plain'];
}
const typeLabel = (t) => typeMeta(t)[0];
const typeTone = (t) => typeMeta(t)[1];

// 内容摘要：qzone_action 的 summary 对部分类型只是 tid，这里按类型补全
function summaryText(row) {
  const type = String(row.type || '');
  if (type === 'reply_ok') {
    const bits = [];
    if (row.author) bits.push('@' + row.author);
    if (row.comment) bits.push('「' + row.comment + '」');
    if (row.reply) bits.push('→ ' + row.reply);
    return bits.join(' ') || row.summary || '—';
  }
  if (row.file) {
    const name = String(row.file).split(/[\\/]/).pop();
    return [name, row.chars ? row.chars + ' 字' : ''].filter(Boolean).join(' · ');
  }
  if (row.error) return String(row.error);
  if (row.wording) return String(row.wording);
  if (row.reason) return String(row.reason);
  if (row.content) return row.mood ? `${row.content}（${row.mood}）` : String(row.content);
  if (row.version) return `v${row.version}${row.pid ? ' · PID ' + row.pid : ''}`;
  if (row.nickname) return row.nickname + (row.tid ? ` · 说说 ${row.tid}` : '');
  if (row.tid) return '说说 ' + row.tid;
  return row.summary || row.detail || row.text || '—';
}

// 最近说说
const recentPosts = computed(() =>
  events.value
    .filter((e) => e.type === 'post_ok' && e.content)
    .slice(0, 5)
    .map((e) => ({ id: e.id, time: fmtTime(e.at).slice(5, 16), content: String(e.content), mood: e.mood || '' }))
);

// 动作构成
const actionItems = computed(() => {
  const m = new Map();
  const add = (k) => m.set(k, (m.get(k) || 0) + 1);
  for (const e of events.value) {
    const t = String(e.type || '');
    if (t === 'post_ok') add('发帖成功');
    else if (t === 'post_fail' || t === 'post_compose_fail') add('发帖失败');
    else if (t === 'reply_ok') add('回复成功');
    else if (t === 'like_ok') add('点赞');
    else if (t === 'image_ok') add('生成配图');
    else if (t === 'start' || t === 'already_running') add('启动');
    else if (t.includes('comment') && /error|fail/.test(t)) add('评论异常');
    else if (t.includes('pause')) add('暂停 / 风控');
    else add('其它');
  }
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
});
</script>

<template>
  <div class="page">
    <div class="row wrap" style="justify-content: space-between">
      <span class="small faint">空间状态取自 state.json · 动作来自桥接审计库 · 点击行查看详情</span>
      <span v-if="lastPostAt" class="small faint">最近发帖：{{ fmtTime(lastPostAt) }}</span>
    </div>

    <ErrorState v-if="error && !data" :message="'QQ 空间数据加载失败：' + error" @retry="load(false)" />
    <div v-else-if="error && data" class="error-banner">
      <span class="grow">刷新失败：{{ error }}（显示上次数据）</span>
      <button class="btn btn-sm" @click="load(false)">重试</button>
    </div>

    <div v-if="!data && !error" class="card" style="padding: 18px">
      <div class="skeleton" style="width: 180px; height: 14px" />
      <div class="skeleton" style="width: 100%; height: 58px; margin-top: 16px" />
    </div>

    <SectionCard v-else-if="data" title="空间状态" dense>
      <div class="status-grid">
        <div class="status-main" :class="{ paused }">
          <div class="status-top">
            <span class="status-icon"><Icon :name="paused ? 'pause' : 'play'" :size="14" /></span>
            <span class="status-text">{{ paused ? '已暂停' : '运行中' }}</span>
            <span v-if="failStreak" class="pill warn">连续失败 {{ failStreak }} 次</span>
          </div>
          <div v-if="paused" class="status-desc">
            {{ pauseReason || '未填写暂停原因' }}<span v-if="pauseAt"> · 暂停于 {{ fmtTime(pauseAt) }}</span>
          </div>
          <div v-else class="status-desc">
            按计划自动发帖<span v-if="likesToday"> · 今日点赞 {{ fmtNum(likesToday) }}</span>
          </div>
        </div>
        <div class="status-stat">
          <div class="stat-label">今日发帖</div>
          <div class="stat-value num">{{ fmtNum(postsToday) }}</div>
          <div class="stat-hint">北京时间今日</div>
        </div>
        <div class="status-stat">
          <div class="stat-label">今日回复</div>
          <div class="stat-value num">{{ fmtNum(repliesToday) }}</div>
          <div class="stat-hint">评论回复</div>
        </div>
        <div class="status-stat">
          <div class="stat-label">动作总数</div>
          <div class="stat-value num">{{ fmtNum(total) }}</div>
          <div class="stat-hint">审计事件</div>
        </div>
        <div class="status-stat next" :class="nextState.tone">
          <div class="stat-label">下次发帖</div>
          <div class="stat-value num">{{ nextState.text }}</div>
          <div class="stat-hint">{{ nextPostAt ? fmtTime(nextPostAt) : '等待调度' }}</div>
        </div>
      </div>
    </SectionCard>

    <div class="row wrap" style="justify-content: space-between">
      <span class="card-title">动作时间线</span>
      <span class="small faint">共 {{ fmtNum(total) }} 条 · 支持关键词与日期筛选</span>
    </div>

    <RecordTable
      key="qzone_action"
      type="qzone_action"
      placeholder="搜索动作类型 / 内容 / 说说 ID…"
      empty-text="还没有空间动作"
      empty-hint="等她发第一条说说或回复评论时，这里会记录下来"
    >
      <template #cell-type="{ value }">
        <span class="pill" :class="typeTone(value)">{{ typeLabel(value) }}</span>
      </template>
      <template #cell-summary="{ row }">
        <span class="cell-ellipsis" :title="summaryText(row)">{{ summaryText(row) }}</span>
      </template>
    </RecordTable>

    <div v-if="data" class="grid grid-2">
      <SectionCard title="最近说说" subtitle="来自空间动作记录" dense>
        <div class="post-list">
          <div v-for="p in recentPosts" :key="p.id" class="post-row">
            <div class="row-between">
              <span class="tiny faint num">{{ p.time }}</span>
              <span v-if="p.mood" class="pill plain">{{ p.mood }}</span>
            </div>
            <div class="post-text clamp-2" :title="p.content">{{ p.content }}</div>
          </div>
          <div v-if="!recentPosts.length" class="faint small">最近还没有发过说说</div>
        </div>
      </SectionCard>
      <SectionCard title="动作构成" :subtitle="`最近 ${fmtNum(events.length)} 条动作`" dense>
        <HBars :items="actionItems" :limit="8" />
      </SectionCard>
    </div>
  </div>
</template>

<style scoped>
.status-grid {
  display: grid;
  grid-template-columns: minmax(240px, 1.5fr) repeat(4, minmax(110px, 1fr));
  gap: var(--sp-3);
  align-items: stretch;
}
.status-main {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface-2);
  min-width: 0;
}
.status-main.paused { border-color: var(--danger); background: var(--danger-soft); }
.status-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.status-icon { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--success-soft); color: var(--success); }
.status-main.paused .status-icon { background: var(--danger-soft); color: var(--danger); }
.status-text { font-size: var(--fs-14); font-weight: 650; color: var(--text); }
.status-main.paused .status-text { color: var(--danger); }
.status-desc { font-size: var(--fs-12); color: var(--muted); word-break: break-word; }
.status-main.paused .status-desc { color: var(--danger); }

.status-stat {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface-2);
  min-width: 0;
}
.stat-label { font-size: var(--fs-11); color: var(--muted); letter-spacing: 0.06em; }
.stat-value { font-size: var(--fs-20); font-weight: 650; color: var(--text); line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status-stat.paused .stat-value { color: var(--danger); }
.status-stat.late .stat-value { color: var(--warn); }
.status-stat.ok .stat-value { color: var(--accent); }
.status-stat.idle .stat-value { color: var(--muted); }
.stat-hint { font-size: 10.5px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.cell-ellipsis { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.post-list { display: flex; flex-direction: column; gap: 8px; }
.post-row { padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--surface-2); }
.post-text { margin-top: 4px; font-size: var(--fs-12); color: var(--text-2); line-height: 1.6; word-break: break-word; }

@media (max-width: 1120px) {
  .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .status-main { grid-column: 1 / -1; }
}
</style>
