<script setup>
// 小生活：睡眠计划 / 自主时间 / 冲浪笔记 / 书库 / 文件动态
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import SectionCard from '../components/SectionCard.vue';
import KpiCard from '../components/KpiCard.vue';
import RecordTable from '../components/RecordTable.vue';
import Modal from '../components/Modal.vue';
import MarkdownView from '../components/MarkdownView.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorState from '../components/ErrorState.vue';
import StatusPill from '../components/StatusPill.vue';
import Icon from '../components/Icon.vue';
import { api, fmtBytes, fmtClock, fmtNum, fmtPct, fmtTime } from '../api/client.js';
import { useResource } from '../composables/useResource.js';
import { toast } from '../composables/useToast.js';

const SURF_DIR = 'E:\\BOT\\学习';
const BOOKS_DIR = 'E:\\BOT\\books';

const { data, loading, error, load } = useResource(() => api.life());

const d = computed(() => data.value || {});
const byMtimeDesc = (a, b) => new Date(b.mtime || 0) - new Date(a.mtime || 0);
const books = computed(() => [...(d.value.books || [])].sort(byMtimeDesc));
const surfNotes = computed(() => [...(d.value.surfNotes || [])].sort(byMtimeDesc));
const surfLog = computed(() =>
  [...(d.value.surfLog || [])].sort((a, b) => new Date(b.t || 0) - new Date(a.t || 0)).slice(0, 5)
);
const fsEvents = computed(() =>
  [...(d.value.fsEvents || [])].sort((a, b) => new Date(b.t || 0) - new Date(a.t || 0)).slice(0, 30)
);
const sleepPlan = computed(() => d.value.sleepPlan || null);
const freeState = computed(() => d.value.freeTimeState || {});
const surfState = computed(() => d.value.surfState || {});
const lastRoll = computed(() => freeState.value.lastRoll || null);

// 1 秒倒计时：只驱动本地 tick，不重新请求数据
const nowTick = ref(Date.now());
let timer = 0;
onMounted(() => { timer = setInterval(() => { nowTick.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

function leftText(ts) {
  const t = Number(ts || 0);
  if (!t) return '—';
  const diff = t - nowTick.value;
  if (diff <= 0) return '已到时间';
  const s = Math.floor(diff / 1000);
  const day = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (day > 0) return `${day} 天 ${h} 小时 ${m} 分`;
  if (h > 0) return `${h} 小时 ${m} 分 ${sec} 秒`;
  if (m > 0) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}
const sleepLeft = computed(() => leftText(sleepPlan.value?.wakeAt));
const freeLeft = computed(() => leftText(freeState.value?.nextAt));
const sleepArrived = computed(() => Boolean(sleepPlan.value?.wakeAt) && Number(sleepPlan.value.wakeAt) <= nowTick.value);
const freeArrived = computed(() => Boolean(freeState.value?.nextAt) && Number(freeState.value.nextAt) <= nowTick.value);

const OP_LABEL = { write: '写入', append: '追加', delete: '删除', remove: '删除', unlink: '删除', rename: '重命名', mkdir: '建目录', copy: '复制', move: '移动' };
function opLabel(op) { return OP_LABEL[String(op || '')] || String(op || '—'); }
function opTone(op) {
  const k = String(op || '');
  if (k === 'delete' || k === 'remove' || k === 'unlink') return 'bad';
  if (k === 'write' || k === 'append') return 'ok';
  return 'plain';
}
function shortTime(iso) {
  const t = fmtTime(iso);
  return t && t !== '—' ? t.slice(5, 16) : '—';
}
const LOG_LABEL = { schedule: '排期', trigger: '触发', fire: '执行', surf: '冲浪', note: '记录', hit: '命中', miss: '未命中', manual: '手动' };
function logLabel(t) { return LOG_LABEL[String(t || '')] || String(t || '—'); }
function logTone(t) {
  const k = String(t || '');
  if (k === 'fire' || k === 'hit') return 'accent';
  if (k === 'trigger') return 'info';
  return 'plain';
}

const kpis = computed(() => [
  {
    label: '书库藏书',
    value: fmtNum(books.value.length),
    hint: books.value[0] ? `最近：${books.value[0].name}` : '还没有藏书',
    tone: 'accent'
  },
  {
    label: '冲浪笔记',
    value: fmtNum(surfNotes.value.length),
    hint: surfState.value.nextSurfAt ? `下次冲浪 ${fmtTime(surfState.value.nextSurfAt)}` : '冲浪未排期',
    tone: 'info'
  },
  {
    label: '文件动态',
    value: fmtNum((d.value.fsEvents || []).length),
    hint: fsEvents.value[0] ? `${opLabel(fsEvents.value[0].op)} · ${fmtTime(fsEvents.value[0].t)}` : '暂无文件写入',
    tone: 'success'
  },
  {
    label: '下次自主时间',
    value: freeLeft.value,
    hint: freeState.value.note || (freeState.value.nextAt ? fmtTime(freeState.value.nextAt) : '未排期'),
    tone: freeArrived.value ? 'warn' : 'accent',
    small: true
  }
]);

// 文件预览：E:\BOT 内 ≤300KB 文本；失败时 Modal 内提示 + toast
const preview = ref({ open: false, kind: 'surf', title: '', path: '', text: '', loading: false, error: '' });
async function openPreview(kind, name) {
  const dir = kind === 'surf' ? SURF_DIR : BOOKS_DIR;
  const path = dir + '\\' + name;
  preview.value = { open: true, kind, title: name, path, text: '', loading: true, error: '' };
  try {
    preview.value.text = await api.previewText(path);
  } catch (e) {
    const msg = e?.message || String(e);
    preview.value.error = msg;
    toast('预览失败：' + msg, 'bad');
  } finally {
    preview.value.loading = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="row wrap" style="justify-content: space-between">
      <div class="row wrap" style="gap: 8px">
        <span class="pill accent">小生活</span>
        <template v-if="data">
          <span class="pill plain">
            {{ sleepPlan ? (sleepPlan.used ? '睡眠计划已使用' : '睡眠待唤醒') : '无睡眠计划' }}
          </span>
          <span class="pill plain">自主时间 {{ freeState.nextAt ? fmtTime(freeState.nextAt) : '未排期' }}</span>
          <span class="pill plain">下次冲浪 {{ surfState.nextSurfAt ? fmtTime(surfState.nextSurfAt) : '未排期' }}</span>
        </template>
      </div>
      <span class="small faint">数据更新：{{ d.generatedAt ? fmtClock(Date.parse(d.generatedAt)) : '—' }}</span>
    </div>

    <ErrorState v-if="error && !data" :message="error" @retry="load(false)" />

    <div v-else-if="!data" class="grid grid-4">
      <div v-for="i in 4" :key="i" class="card" style="height: 96px; padding: 16px">
        <div class="skeleton" style="width: 42%; height: 10px" />
        <div class="skeleton" style="width: 62%; height: 26px; margin-top: 12px" />
      </div>
    </div>

    <div v-if="error && data" class="error-banner">
      <span class="grow">刷新失败：{{ error }}（显示上次数据）</span>
      <button class="btn btn-sm" @click="load(false)">重试</button>
    </div>

    <template v-if="data">
      <div class="grid grid-4">
        <KpiCard v-for="c in kpis" :key="c.label" v-bind="c" />
      </div>

      <div class="grid grid-2">
        <SectionCard title="睡眠计划" subtitle="她给自己定的醒来时间">          <template v-if="sleepPlan">
            <div class="hero">
              <div class="grow">
                <div class="hero-label">{{ sleepPlan.used ? '距离计划唤醒（已使用）' : '距离计划唤醒' }}</div>
                <div class="hero-value num" :class="{ arrived: sleepArrived && !sleepPlan.used }">{{ sleepLeft }}</div>
                <div class="tiny faint">计划唤醒 {{ fmtTime(sleepPlan.wakeAt) }}</div>
              </div>
              <div class="hero-badge">
                <span class="pill" :class="sleepPlan.used ? 'plain' : 'accent'">{{ sleepPlan.used ? '已使用' : '待唤醒' }}</span>
                <span class="tiny faint mono truncate" style="max-width: 150px" :title="sleepPlan.key">{{ sleepPlan.key }}</span>
              </div>
            </div>
            <div class="note-box">{{ sleepPlan.note || '没有备注' }}</div>
            <div class="meta-row">
              <Icon name="clock" :size="13" />
              <span class="tiny faint">创建于 {{ fmtTime(sleepPlan.createdAt) }}</span>
            </div>
          </template>
          <EmptyState v-else text="暂无睡眠计划" hint="她说「去睡了」时会排一个唤醒计划" icon="clock" />
        </SectionCard>

        <SectionCard title="自主时间" subtitle="随机摇到的自由活动时间">
          <template v-if="freeState.nextAt || lastRoll">
            <div class="hero">
              <div class="grow">
                <div class="hero-label">距离下次自主时间</div>
                <div class="hero-value num" :class="{ arrived: freeArrived }">{{ freeLeft }}</div>
                <div class="tiny faint">排期 {{ fmtTime(freeState.nextAt) }}</div>
              </div>
              <div class="hero-badge">
                <span class="pill" :class="lastRoll ? (lastRoll.hit ? 'ok' : 'plain') : 'plain'">
                  上次{{ lastRoll ? (lastRoll.hit ? '命中' : '未命中') : '无记录' }}
                </span>
                <span class="tiny faint">命中概率 {{ lastRoll ? fmtPct(lastRoll.prob, 0) : '—' }}</span>
              </div>
            </div>
            <div class="note-box">{{ freeState.note || '没有备注' }}</div>
            <div class="meta-row">
              <Icon name="clock" :size="13" />
              <span class="tiny faint">上次摇奖 {{ lastRoll ? fmtTime(lastRoll.at) : '—' }}</span>
              <span class="tiny faint">·</span>
              <span class="tiny faint">上次触发 {{ freeState.lastAt ? fmtTime(freeState.lastAt) : '—' }}</span>
            </div>
          </template>
          <EmptyState v-else text="暂无自主时间排期" hint="排期后会按概率随机触发" icon="clock" />
        </SectionCard>
      </div>

      <div class="life-mid">
        <SectionCard title="冲浪笔记" :subtitle="'来自 ' + SURF_DIR + ' · 点击预览'">
          <template v-if="surfNotes.length">
            <div class="doc-list">
              <button v-for="n in surfNotes" :key="n.name" class="doc-row" @click="openPreview('surf', n.name)">
                <Icon name="memory" :size="14" />
                <span class="grow truncate" :title="n.name">{{ n.name }}</span>
                <span class="tiny faint num nowrap">{{ fmtBytes(n.size) }}</span>
                <span class="tiny faint num nowrap">{{ fmtTime(n.mtime) }}</span>
                <Icon name="chevron" :size="13" class="row-chev" />
              </button>
            </div>
          </template>
          <EmptyState v-else text="还没有冲浪笔记" hint="她上网冲浪后会存成 Markdown" icon="memory" />

          <div class="divider" style="margin: 12px 0" />
          <div class="sub-head">最近冲浪动态</div>
          <div v-if="surfLog.length" class="log-list">
            <div v-for="(l, i) in surfLog" :key="i" class="log-row">
              <span class="log-type" :class="logTone(l.type)">{{ logLabel(l.type) }}</span>
              <span class="grow tiny faint num">{{ fmtTime(l.t) }}</span>
              <span v-if="l.nextAt" class="tiny faint num nowrap">下次 {{ fmtTime(l.nextAt) }}</span>
            </div>
          </div>
          <div v-else class="small faint">暂无冲浪动态</div>
        </SectionCard>

        <div class="stack">
          <SectionCard title="书库" :subtitle="'来自 ' + BOOKS_DIR + ' · 点击预览'">
            <template v-if="books.length">
              <div class="doc-list books">
                <button v-for="b in books" :key="b.name" class="doc-row" @click="openPreview('book', b.name)">
                  <Icon name="box" :size="14" />
                  <span class="grow truncate" :title="b.name">{{ b.name }}</span>
                  <span class="tiny faint num nowrap">{{ fmtBytes(b.size) }}</span>
                  <Icon name="chevron" :size="13" class="row-chev" />
                </button>
              </div>
              <div class="card-foot">
                <span>共 {{ books.length }} 本 · {{ fmtBytes(books.reduce((s, b) => s + (Number(b.size) || 0), 0)) }}</span>
                <span class="mono truncate" :title="BOOKS_DIR">{{ BOOKS_DIR }}</span>
              </div>
            </template>
            <EmptyState v-else text="书库还是空的" hint="她可以用 save_book 把长文存进书库" icon="box" />
          </SectionCard>

          <SectionCard title="文件动态" :subtitle="'共 ' + (d.fsEvents || []).length + ' 条 · 最近 ' + fsEvents.length + ' 条'">
            <div v-if="fsEvents.length" class="table-wrap fs-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th style="width: 86px">时间</th>
                    <th style="width: 56px">操作</th>
                    <th>路径</th>
                    <th style="width: 62px; text-align: right">大小</th>
                    <th style="width: 62px">结果</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(e, i) in fsEvents" :key="i">
                    <td class="cell-time">{{ shortTime(e.t) }}</td>
                    <td><span class="op-tag" :class="opTone(e.op)">{{ opLabel(e.op) }}</span></td>
                    <td class="cell-mono"><span class="cell-truncate" :title="e.path">{{ e.path }}</span></td>
                    <td class="align-right cell-number">{{ fmtBytes(e.bytes) }}</td>
                    <td><StatusPill :ok="Boolean(e.ok)" :label="e.ok ? '成功' : '失败'" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <EmptyState v-else text="还没有文件动态" hint="她写日记 / 存笔记时会留下记录" icon="box" />
          </SectionCard>
        </div>
      </div>

      <SectionCard title="自主时间记录" subtitle="每次摇奖都记一笔 · 点击行看详情" dense>
        <div class="rec-flat">
          <RecordTable
            type="free_time"
            placeholder="搜索目标会话…"
            empty-text="还没有自主时间记录"
            max-height="300px"
          >
            <template #cell-prob="{ value }">
              <span class="num">{{ fmtPct(value, 0) }}</span>
            </template>
          </RecordTable>
        </div>
      </SectionCard>
    </template>

    <Modal :open="preview.open" :title="preview.title" wide @close="preview.open = false">
      <div class="preview-meta">
        <Icon :name="preview.kind === 'surf' ? 'memory' : 'box'" :size="14" />
        <span class="mono tiny truncate" :title="preview.path">{{ preview.path }}</span>
      </div>
      <div v-if="preview.loading" class="row" style="padding: 18px 2px">
        <span class="spinner" />
        <span class="small faint">读取中…</span>
      </div>
      <div v-else-if="preview.error" class="preview-error">
        <div class="row" style="gap: 6px"><Icon name="warning" :size="15" />预览失败</div>
        <div class="small">{{ preview.error }}</div>
        <div class="tiny faint">只支持 E:\BOT 内 ≤300KB 的文本文件（.md / .txt 等）</div>
      </div>
      <MarkdownView v-else-if="preview.kind === 'surf'" :source="preview.text" />
      <pre v-else class="code-block">{{ preview.text }}</pre>
    </Modal>
  </div>
</template>

<style scoped>
.hero { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); }
.life-mid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: var(--sp-4); align-items: start; }
@media (max-width: 1360px) { .life-mid { grid-template-columns: minmax(0, 1fr); } }
.hero-label { font-size: var(--fs-11); color: var(--muted); letter-spacing: 0.08em; }
.hero-value {
  margin: 2px 0 2px;
  font-size: 28px;
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: -0.02em;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.hero-value.arrived { color: var(--warn); }
.hero-badge { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; text-align: right; flex: 0 0 auto; }

.note-box {
  margin-top: var(--sp-3);
  padding: 9px 12px;
  border-left: 3px solid var(--accent-2);
  background: var(--surface-2);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--text-2);
  font-size: var(--fs-12);
  line-height: 1.8;
  white-space: pre-wrap;
}
.meta-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 10px; color: var(--faint); }

.doc-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow: auto; margin: 0 -4px; }
.doc-list.books { max-height: 220px; }
.doc-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border-radius: var(--radius-xs);
  font-size: var(--fs-12);
  color: var(--text-2);
  text-align: left;
}
.doc-row:hover { background: var(--surface-2); color: var(--text); }
.doc-row > svg:first-child { color: var(--muted); flex: 0 0 auto; }
.doc-row:hover > svg:first-child { color: var(--accent); }
.row-chev { color: var(--faint); flex: 0 0 auto; transition: color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease); }
.doc-row:hover .row-chev { color: var(--accent); transform: translateX(1px); }

.sub-head { font-size: var(--fs-11); color: var(--muted); letter-spacing: 0.06em; margin-bottom: 6px; }
.log-list { display: flex; flex-direction: column; gap: 2px; }
.log-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: var(--radius-xs); }
.log-row:hover { background: var(--surface-2); }
.log-type {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: 10.5px;
  font-weight: 600;
  background: var(--surface-2);
  color: var(--muted);
}
.log-type.accent { background: var(--accent-soft); color: var(--accent); }
.log-type.info { background: var(--info-soft); color: var(--info); }

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: var(--fs-11);
  color: var(--faint);
}
.fs-wrap { max-height: 300px; }
.op-tag {
  display: inline-flex;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: 10.5px;
  font-weight: 600;
  background: var(--surface-2);
  color: var(--muted);
  white-space: nowrap;
}
.op-tag.ok { background: var(--success-soft); color: var(--success); }
.op-tag.bad { background: var(--danger-soft); color: var(--danger); }

/* 把 RecordTable 内层卡片压平，嵌进 SectionCard 里更像一块看板 */
.rec-flat :deep(.filter-bar) {
  border: 0;
  background: transparent;
  padding: 0 0 var(--sp-2);
  box-shadow: none;
}
.rec-flat :deep(.table-card) {
  border: 0;
  background: transparent;
  box-shadow: none;
}
.rec-flat :deep(.table-wrap) { border: 1px solid var(--border); border-radius: var(--radius-sm); }

.preview-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
  color: var(--faint);
}
.preview-error {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px;
  border: 1px solid var(--danger-soft);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
}
</style>
