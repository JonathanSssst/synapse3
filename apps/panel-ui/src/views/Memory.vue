<script setup>
// 记忆库：左侧文档目录（搜索/选中）+ 右侧 Markdown 正文与标题目录
import { computed, nextTick, ref, watch } from 'vue';
import SectionCard from '../components/SectionCard.vue';
import MarkdownView from '../components/MarkdownView.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorState from '../components/ErrorState.vue';
import Icon from '../components/Icon.vue';
import SessionMemoryPanel from '../components/SessionMemoryPanel.vue';
import BrainMemoryPanel from '../components/BrainMemoryPanel.vue';
import { api, fmtBytes, fmtClock, fmtTime } from '../api/client.js';
import { useResource } from '../composables/useResource.js';
import { refreshTick } from '../composables/useRefresh.js';

// 记忆库两个页签：文件记忆（原有 Markdown 文档）/ 会话记忆（social-v2.json 里的会话级记忆）
const tab = ref('files');

const { data, loading, error, load } = useResource(() => api.memory());

const d = computed(() => data.value || {});
const docs = computed(() => (d.value.docs || []).filter((x) => x.exists !== false));
const totalBytes = computed(() => docs.value.reduce((s, x) => s + (Number(x.bytes) || 0), 0));

const KIND_LABEL = { memory: '记忆', plan: '计划', rules: '规范', daily: '日报' };
const kindLabel = (k) => KIND_LABEL[String(k || '')] || String(k || '文档');

// 左栏搜索：按名称 / 摘要 / 路径过滤（本地过滤，不发请求）
const q = ref('');
const matched = computed(() => {
  const kw = q.value.trim().toLowerCase();
  if (!kw) return docs.value;
  return docs.value.filter((x) =>
    String(x.name || '').toLowerCase().includes(kw) ||
    String(x.preview || '').toLowerCase().includes(kw) ||
    String(x.path || '').toLowerCase().includes(kw)
  );
});

const selectedId = ref('');
watch(docs, (list) => {
  if (!list.length) { selectedId.value = ''; return; }
  if (selectedId.value && list.some((x) => x.id === selectedId.value)) return;
  selectedId.value = (list.find((x) => x.id === 'memory') || list[0]).id;
}, { immediate: true });
const selectedDoc = computed(() => docs.value.find((x) => x.id === selectedId.value) || null);

// 右栏正文
const doc = ref(null);
const recLoading = ref(false);
const recError = ref('');
let recSeq = 0;
async function loadDoc(id) {
  if (!id) { doc.value = null; return; }
  const my = ++recSeq;
  recLoading.value = true;
  recError.value = '';
  doc.value = null;
  try {
    const res = await api.record('memory_doc', id);
    if (my !== recSeq) return;
    doc.value = res;
  } catch (e) {
    if (my !== recSeq) return;
    recError.value = e?.message || String(e);
  } finally {
    if (my === recSeq) recLoading.value = false;
  }
}
watch(selectedId, (id) => loadDoc(id), { immediate: true });
watch(refreshTick, () => loadDoc(selectedId.value));

const content = computed(() => doc.value?.content || '');

// 标题（跳过 ``` 代码块，保证索引和渲染出来的标题一一对应）
const headings = computed(() => {
  const out = [];
  let inCode = false;
  for (const raw of content.value.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
});
const activeHeading = ref(-1);
const scrollBox = ref(null);

async function jumpTo(index) {
  await nextTick();
  const nodes = scrollBox.value?.querySelectorAll('.markdown h1, .markdown h2, .markdown h3') || [];
  const el = nodes[index];
  if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function onScroll() {
  const box = scrollBox.value;
  if (!box) return;
  const nodes = box.querySelectorAll('.markdown h1, .markdown h2, .markdown h3');
  if (!nodes.length) { activeHeading.value = -1; return; }
  const top = box.getBoundingClientRect().top + 12;
  let idx = -1;
  nodes.forEach((el, i) => { if (el.getBoundingClientRect().top <= top) idx = i; });
  activeHeading.value = idx;
}
watch(selectedId, async () => {
  activeHeading.value = -1;
  await nextTick();
  if (scrollBox.value) scrollBox.value.scrollTop = 0;
});

// 目录关键词高亮（正文不做高亮）
const kw = computed(() => q.value.trim());
function segments(text) {
  const k = kw.value;
  if (!k) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const kl = k.toLowerCase();
  const out = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(kl, i);
    if (idx < 0) { out.push({ text: text.slice(i), hit: false }); break; }
    if (idx > i) out.push({ text: text.slice(i, idx), hit: false });
    out.push({ text: text.slice(idx, idx + k.length), hit: true });
    i = idx + k.length;
  }
  return out;
}

const detailPath = computed(() =>
  selectedDoc.value ? `/detail/memory_doc/${encodeURIComponent(selectedDoc.value.id)}` : '/memory'
);
</script>

<template>
  <div class="page">
    <!-- 页签：文件记忆 / 会话记忆 -->
    <div class="mem-tabs">
      <button class="mem-tab" :class="{ on: tab === 'files' }" @click="tab = 'files'">
        <Icon name="memory" :size="14" />文件记忆
      </button>
      <button class="mem-tab" :class="{ on: tab === 'sessions' }" @click="tab = 'sessions'">
        <Icon name="clock" :size="14" />会话记忆
      </button>
      <button class="mem-tab" :class="{ on: tab === 'brain' }" @click="tab = 'brain'">
        <Icon name="memory" :size="14" />长期事实
      </button>
      <span class="grow" />
      <span class="tiny faint">只读 · 数据来自 qq-bridge 状态文件</span>
    </div>

    <template v-if="tab === 'files'">
    <div class="row wrap" style="justify-content: space-between">
      <div class="row wrap" style="gap: 8px">
        <span class="pill accent">记忆库</span>
        <template v-if="data">
          <span class="pill plain">{{ docs.length }} 篇文档</span>
          <span class="pill plain">{{ fmtBytes(totalBytes) }}</span>
          <span v-if="q.trim()" class="pill info">搜索：{{ matched.length }} 篇匹配</span>
        </template>
      </div>
      <span class="small faint">数据更新：{{ d.generatedAt ? fmtClock(Date.parse(d.generatedAt)) : '—' }}</span>
    </div>

    <ErrorState v-if="error && !data" :message="error" @retry="load(false)" />

    <div v-else-if="!data" class="mem-grid">
      <div class="card" style="height: 420px; padding: 16px">
        <div class="skeleton" style="width: 55%; height: 12px" />
        <div class="skeleton" style="width: 100%; height: 42px; margin-top: 14px" />
        <div v-for="i in 4" :key="i" class="skeleton" style="width: 100%; height: 44px; margin-top: 10px" />
      </div>
      <div class="card" style="height: 420px; padding: 20px">
        <div class="skeleton" style="width: 30%; height: 16px" />
        <div v-for="i in 7" :key="i" class="skeleton" style="width: 100%; height: 14px; margin-top: 14px" />
      </div>
    </div>

    <div v-if="error && data" class="error-banner">
      <span class="grow">刷新失败：{{ error }}（显示上次数据）</span>
      <button class="btn btn-sm" @click="load(false)">重试</button>
    </div>

    <div v-if="data" class="mem-grid">
      <SectionCard class="mem-pane" title="文档目录" :subtitle="matched.length + ' / ' + docs.length + ' 篇'">
        <div class="doc-search">
          <Icon name="search" :size="15" />
          <input v-model="q" class="doc-search-input" placeholder="按名称 / 摘要搜索…" />
          <button v-if="q" class="icon-btn" title="清空搜索" @click="q = ''"><Icon name="close" :size="14" /></button>
        </div>

        <div v-if="matched.length" class="doc-list">
          <button
            v-for="item in matched"
            :key="item.id"
            class="doc-item"
            :class="{ on: item.id === selectedId }"
            :title="item.preview || item.path"
            @click="selectedId = item.id"
          >
            <span class="row" style="gap: 6px">
              <span class="doc-name grow truncate">{{ item.name }}</span>
              <span class="kind-tag" :class="item.kind">{{ kindLabel(item.kind) }}</span>
            </span>
            <span class="doc-sub">
              <span>{{ fmtBytes(item.bytes) }}</span>
              <span class="faint">·</span>
              <span>{{ item.lines || 0 }} 行</span>
            </span>
            <span class="doc-sub num">{{ fmtTime(item.mtime) }}</span>
          </button>
        </div>
        <EmptyState v-else text="没有匹配的文档" hint="换个关键词试试，或点右侧清空" icon="memory" />

        <div class="pane-foot">
          <span>本地文件 · 只读</span>
          <span class="mono truncate" title="E:\BOT">E:\BOT</span>
        </div>
      </SectionCard>

      <SectionCard class="mem-pane mem-reader" :title="selectedDoc ? selectedDoc.name : '文档正文'">
        <template #actions>
          <RouterLink v-if="selectedDoc" class="btn btn-sm" :to="detailPath">
            在详情页打开<Icon name="external" :size="12" />
          </RouterLink>
        </template>

        <div class="reader-meta">
          <template v-if="selectedDoc">
            <span class="pill accent">{{ kindLabel(selectedDoc.kind) }}</span>
            <span class="mono tiny faint truncate grow" :title="selectedDoc.path">{{ selectedDoc.path }}</span>
            <span class="tiny faint nowrap">{{ fmtTime(selectedDoc.mtime) }}</span>
            <span class="tiny faint nowrap">{{ selectedDoc.lines || 0 }} 行 · {{ fmtBytes(selectedDoc.bytes) }}</span>
          </template>
          <span v-else class="small faint">未选择文档</span>
        </div>

        <div class="reader-body">
          <div ref="scrollBox" class="reader-scroll" @scroll.passive="onScroll">
            <div v-if="recLoading && !doc" class="stack">
              <div class="skeleton" style="width: 42%; height: 20px" />
              <div v-for="i in 8" :key="i" class="skeleton" :style="{ width: i % 3 === 0 ? '72%' : '100%', height: '13px' }" />
            </div>
            <ErrorState v-else-if="recError && !doc" :message="recError" @retry="loadDoc(selectedId)" />
            <EmptyState v-else-if="doc && !content" text="文档内容为空" hint="打开本地文件确认内容" icon="memory" />
            <MarkdownView v-else-if="doc" :source="content" />
            <EmptyState v-else text="从左侧选择一篇文档" hint="默认会选中记忆库" icon="memory" />
          </div>

          <aside class="reader-toc">
            <div class="toc-title">标题目录<span v-if="headings.length" class="faint"> · {{ headings.length }}</span></div>
            <div class="toc-list">
              <button
                v-for="(h, i) in headings"
                :key="i"
                class="toc-item"
                :class="['lv' + h.level, { on: activeHeading === i }]"
                :title="h.text"
                @click="jumpTo(i)"
              >
                <span v-for="(seg, j) in segments(h.text)" :key="j" :class="{ hl: seg.hit }">{{ seg.text }}</span>
              </button>
              <div v-if="!headings.length" class="small faint" style="padding: 4px 8px">
                {{ doc ? '本文没有一至三级标题' : '尚未加载' }}
              </div>
            </div>
          </aside>
        </div>
      </SectionCard>
    </div>
    </template>

    <BrainMemoryPanel v-else-if="tab === 'brain'" />
    <SessionMemoryPanel v-else />
  </div>
</template>

<style scoped>
.mem-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  width: fit-content;
  max-width: 100%;
}
.mem-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 14px;
  border-radius: var(--radius-xs);
  color: var(--muted);
  font-size: var(--fs-12);
  white-space: nowrap;
}
.mem-tab:hover { color: var(--text); background: var(--surface-2); }
.mem-tab.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }

.mem-grid {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: var(--sp-4);
  align-items: start;
}

.mem-pane {
  height: clamp(440px, calc(100vh - 196px), 860px);
  display: flex;
  flex-direction: column;
}
.mem-pane :deep(.card-head) { flex: 0 0 auto; }
.mem-pane :deep(.card-body) {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0;
}

.doc-search {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  margin: 10px 10px 6px;
  padding: 0 8px 0 10px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--muted);
}
.doc-search:focus-within { border-color: var(--accent); background: var(--surface); }
.doc-search-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: var(--fs-12);
}
.doc-search-input:focus { outline: none; }
.doc-search .icon-btn { width: 24px; height: 24px; }

.doc-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 8px 10px; }
.doc-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  color: var(--text-2);
  text-align: left;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.doc-item + .doc-item { margin-top: 2px; }
.doc-item:hover { background: var(--surface-2); }
.doc-item.on {
  background: var(--table-sel);
  border-color: var(--border);
  box-shadow: inset 2px 0 0 var(--accent);
}
.doc-item.on .doc-name { color: var(--accent); }
.doc-name { font-size: var(--fs-12); font-weight: 600; color: var(--text); }
.doc-sub { display: flex; align-items: center; gap: 5px; font-size: var(--fs-11); color: var(--faint); }
.kind-tag {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: var(--radius-xs);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  background: var(--neutral-soft);
  color: var(--muted);
}
.kind-tag.memory { background: var(--accent-soft); color: var(--accent); }
.kind-tag.plan { background: var(--info-soft); color: var(--info); }
.kind-tag.rules { background: var(--warn-soft); color: var(--warn); }
.kind-tag.daily { background: var(--surface-2); color: var(--muted); }
.pane-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  font-size: var(--fs-11);
  color: var(--faint);
}

.reader-meta {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}
.reader-body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 158px;
}
.reader-scroll { min-height: 0; overflow: auto; padding: 8px 18px 26px; }
.reader-scroll :deep(.markdown h1),
.reader-scroll :deep(.markdown h2),
.reader-scroll :deep(.markdown h3) { scroll-margin-top: 10px; }
.reader-scroll :deep(.markdown > :first-child) { margin-top: 8px; }

.reader-toc {
  min-height: 0;
  overflow: auto;
  border-left: 1px solid var(--border);
  padding: 10px 8px 14px;
}
.toc-title {
  padding: 2px 8px 8px;
  font-size: var(--fs-11);
  color: var(--muted);
  letter-spacing: 0.06em;
  white-space: nowrap;
}
.toc-list { display: flex; flex-direction: column; gap: 1px; }
.toc-item {
  display: block;
  width: 100%;
  padding: 4px 8px;
  border-radius: var(--radius-xs);
  font-size: var(--fs-11);
  line-height: 1.5;
  color: var(--muted);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toc-item:hover { background: var(--surface-2); color: var(--text); }
.toc-item.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.toc-item.lv2 { padding-left: 16px; }
.toc-item.lv3 { padding-left: 24px; font-size: 10.5px; }
.toc-item .hl {
  background: var(--accent-2-soft);
  color: var(--accent-2);
  border-radius: 3px;
  padding: 0 1px;
}

@media (max-width: 1120px) {
  .mem-grid { grid-template-columns: minmax(0, 1fr); }
  .mem-pane { height: auto; max-height: 72vh; }
  .mem-pane.mem-reader { height: 72vh; }
  .reader-body { grid-template-columns: minmax(0, 1fr); }
  .reader-toc { display: none; }
}
</style>
