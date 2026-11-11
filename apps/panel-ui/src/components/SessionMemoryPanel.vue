<script setup>
// 会话记忆面板：查看 qq_memory_append / qq_memory_update 写入的会话级记忆（只读）
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import EmptyState from './EmptyState.vue';
import ErrorState from './ErrorState.vue';
import Icon from './Icon.vue';
import { api, fmtTime } from '../api/client.js';
import { refreshTick } from '../composables/useRefresh.js';

const qInput = ref('');
const q = ref('');
const kind = ref('all');
const data = ref(null);
const loading = ref(false);
const error = ref('');
const expanded = ref([]);
let seq = 0;
let debounceTimer = 0;

watch(qInput, (v) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { q.value = String(v || '').trim(); }, 280);
});
onBeforeUnmount(() => clearTimeout(debounceTimer));

async function load(silent = false) {
  const my = ++seq;
  if (!silent) loading.value = true;
  error.value = '';
  try {
    const res = await api.sessionMemory({
      q: q.value || undefined,
      kind: kind.value === 'all' ? undefined : kind.value
    });
    if (my !== seq) return;
    data.value = res;
  } catch (e) {
    if (my !== seq) return;
    error.value = e?.message || String(e);
  } finally {
    if (my === seq) loading.value = false;
  }
}

watch(q, () => load(true));
watch(kind, () => load(true));
watch(refreshTick, () => load(true));
onMounted(() => load());

const sessions = computed(() => data.value?.sessions || []);
const counts = computed(() => data.value?.counts || { sessions: 0, topics: 0, thoughts: 0, impressions: 0 });
const totalMemories = computed(() => counts.value.topics + counts.value.thoughts + counts.value.impressions);
const kindLabel = (k) => (k === 'group' ? '群' : k === 'private' ? '私聊' : '其它');
const currentKind = computed(() => (kind.value === 'all' ? '全部会话' : kind.value === 'group' ? '群聊' : '私聊'));

function isOpen(key) { return expanded.value.includes(key); }
function toggle(key) {
  const i = expanded.value.indexOf(key);
  if (i >= 0) expanded.value.splice(i, 1);
  else expanded.value.push(key);
}
function expandAll() { expanded.value = sessions.value.map((s) => s.key); }
function collapseAll() { expanded.value = []; }

const KIND_OPTS = [
  { value: 'all', label: '全部' },
  { value: 'group', label: '群' },
  { value: 'private', label: '私聊' }
];
</script>

<template>
  <div class="stack">
    <!-- 工具栏：搜索 / 类型 / 刷新 -->
    <div class="filter-bar card">
      <div class="row wrap grow" style="gap: 8px">
        <label class="search">
          <Icon name="search" :size="15" />
          <input v-model="qInput" class="search-input" placeholder="搜索会话 / 话题 / 想法 / 群友…" />
          <button v-if="qInput" class="icon-btn" title="清空搜索" @click="qInput = ''"><Icon name="close" :size="13" /></button>
        </label>
        <div class="kind-seg">
          <button
            v-for="opt in KIND_OPTS"
            :key="opt.value"
            class="kind-btn"
            :class="{ on: kind === opt.value }"
            @click="kind = opt.value"
          >{{ opt.label }}</button>
        </div>
        <span v-if="data" class="pill info">{{ currentKind }} · {{ sessions.length }} 个</span>
      </div>
      <div class="row" style="gap: 10px">
        <span class="tiny faint">数据 {{ data?.generatedAt ? fmtTime(data.generatedAt) : '—' }}</span>
        <button class="btn btn-sm" :disabled="loading" @click="load(false)">
          <span v-if="loading" class="spinner" /><Icon v-else name="refresh" :size="13" />刷新
        </button>
      </div>
    </div>

    <!-- 统计 -->
    <div class="mem-stats">
      <div class="stat"><b class="num">{{ counts.sessions }}</b><span>会话</span></div>
      <div class="stat"><b class="num">{{ counts.topics }}</b><span>进行中话题</span></div>
      <div class="stat"><b class="num">{{ counts.thoughts }}</b><span>想说没说</span></div>
      <div class="stat"><b class="num">{{ counts.impressions }}</b><span>群友印象</span></div>
      <div class="grow" />
      <div class="row" style="gap: 6px">
        <button class="btn btn-sm btn-ghost" :disabled="!sessions.length" @click="expandAll">全部展开</button>
        <button class="btn btn-sm btn-ghost" :disabled="!expanded.length" @click="collapseAll">全部收起</button>
      </div>
    </div>

    <ErrorState v-if="error && !data" :message="error" @retry="load(false)" />

    <div v-if="!data && loading" class="session-list">
      <div v-for="i in 3" :key="i" class="card session-card" style="padding: 16px">
        <div class="skeleton" style="width: 38%; height: 14px" />
        <div class="skeleton" style="width: 62%; height: 11px; margin-top: 12px" />
      </div>
    </div>

    <template v-else-if="data">
      <div v-if="error" class="error-banner">
        <span class="grow">刷新失败：{{ error }}（显示上次数据）</span>
        <button class="btn btn-sm" @click="load(false)">重试</button>
      </div>

      <EmptyState
        v-if="!sessions.length"
        :text="q ? '没有匹配的会话' : '还没有任何会话记忆'"
        :hint="q ? '换个关键词，或清空搜索' : '等她用 qq_memory_append 记下话题 / 想法 / 群友印象后，这里会出现'"
        icon="memory"
      />

      <div v-else class="session-list">
        <article v-for="s in sessions" :key="s.key" class="card session-card" :class="{ open: isOpen(s.key) }">
          <button class="session-head" @click="toggle(s.key)">
            <div class="row" style="gap: 8px; min-width: 0">
              <span class="pill" :class="s.kind === 'group' ? 'info' : s.kind === 'private' ? 'accent' : 'plain'">{{ kindLabel(s.kind) }}</span>
              <span class="session-key mono truncate" :title="s.key">{{ s.key }}</span>
              <span v-if="s.role" class="tag" :title="'人设：' + s.role">{{ s.role }}</span>
            </div>
            <div class="session-meta">
              <span class="c-pill" :class="{ zero: !s.counts.topics }"><b>{{ s.counts.topics }}</b> 话题</span>
              <span class="c-pill" :class="{ zero: !s.counts.thoughts }"><b>{{ s.counts.thoughts }}</b> 想说</span>
              <span class="c-pill" :class="{ zero: !s.counts.impressions }"><b>{{ s.counts.impressions }}</b> 印象</span>
              <span class="tiny faint nowrap">{{ s.updatedAtLocal || '无更新时间' }}</span>
              <Icon name="chevron" :size="16" class="chev" />
            </div>
          </button>

          <div v-if="isOpen(s.key)" class="session-body">
            <EmptyState
              v-if="!s.hasMemory"
              text="这个会话还没有记忆"
              hint="她还没在这个会话里记下话题 / 想法 / 群友印象"
              icon="memory"
            />
            <div v-else class="mem-cols">
              <!-- 进行中话题 -->
              <section class="mem-col">
                <header class="col-head">
                  <span>进行中话题</span><span class="c-num">{{ s.counts.topics }}</span>
                </header>
                <div v-if="s.topics.length" class="col-list">
                  <div v-for="(t, i) in s.topics" :key="i" class="mem-item">
                    <div class="mem-text">{{ t.text }}</div>
                    <div class="mem-meta">
                      <span v-for="p in t.participants" :key="p" class="tag">{{ p }}</span>
                      <span v-if="t.pendingQuestion" class="tag pending" :title="t.pendingQuestion">待问 · {{ t.pendingQuestion }}</span>
                      <span class="tiny faint">{{ t.lastMentionAtLocal || '—' }}</span>
                    </div>
                  </div>
                </div>
                <div v-else class="col-empty">暂无进行中的话题</div>
              </section>

              <!-- 想说没说 -->
              <section class="mem-col">
                <header class="col-head">
                  <span>想说没说</span><span class="c-num">{{ s.counts.thoughts }}</span>
                </header>
                <div v-if="s.thoughts.length" class="col-list">
                  <div v-for="(t, i) in s.thoughts" :key="i" class="mem-item" :class="{ expired: t.isExpired }">
                    <div class="mem-text">{{ t.text }}</div>
                    <div class="mem-meta">
                      <span v-if="t.motivation" class="tag">{{ t.motivation }}</span>
                      <span v-if="t.isExpired" class="tag expired-tag">已过期</span>
                      <span class="tiny faint">创建 {{ t.createdAtLocal || '—' }}</span>
                      <span v-if="t.expiresAtLocal" class="tiny faint">· 过期 {{ t.expiresAtLocal }}</span>
                    </div>
                  </div>
                </div>
                <div v-else class="col-empty">没有待说的话</div>
              </section>

              <!-- 群友印象 -->
              <section class="mem-col">
                <header class="col-head">
                  <span>群友印象</span><span class="c-num">{{ s.counts.impressions }}</span>
                </header>
                <div v-if="s.impressions.length" class="col-list">
                  <div v-for="imp in s.impressions" :key="imp.name" class="mem-item">
                    <div class="imp-head">
                      <span class="imp-name">{{ imp.name }}</span>
                      <span v-if="imp.interactionCount != null" class="tiny faint">互动 {{ imp.interactionCount }} 次</span>
                    </div>
                    <div class="mem-text">{{ imp.summary || '（暂无摘要）' }}</div>
                    <div class="mem-meta">
                      <span v-for="tg in imp.tags" :key="tg" class="tag">{{ tg }}</span>
                      <span class="tiny faint">{{ imp.lastSeenAtLocal || '—' }}</span>
                    </div>
                  </div>
                </div>
                <div v-else class="col-empty">还没有群友印象</div>
              </section>
            </div>
          </div>
        </article>
      </div>
    </template>
  </div>
</template>

<style scoped>
.filter-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; flex-wrap: wrap; }
.search {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 10px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--muted);
  min-width: 240px;
}
.search:focus-within { border-color: var(--accent); background: var(--surface); }
.search-input { flex: 1 1 auto; min-width: 120px; height: 28px; border: 0; background: transparent; color: var(--text); font-size: var(--fs-12); }
.search-input:focus { outline: none; }
.search .icon-btn { width: 22px; height: 22px; }

.kind-seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border); }
.kind-btn { height: 24px; padding: 0 10px; border-radius: var(--radius-xs); color: var(--muted); font-size: var(--fs-12); }
.kind-btn:hover { color: var(--text); }
.kind-btn.on { background: var(--surface); color: var(--accent); font-weight: 600; box-shadow: var(--shadow-1); }

.mem-stats { display: flex; align-items: center; gap: var(--sp-4); flex-wrap: wrap; padding: 0 2px; }
.stat { display: flex; align-items: baseline; gap: 6px; }
.stat b { font-size: var(--fs-20); font-weight: 650; color: var(--text); }
.stat span { font-size: var(--fs-11); color: var(--muted); }

.session-list { display: flex; flex-direction: column; gap: 10px; }
.session-card { overflow: hidden; }
.session-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  text-align: left;
  color: inherit;
  flex-wrap: wrap;
}
.session-head:hover { background: var(--surface-2); }
.session-key { font-size: var(--fs-13); font-weight: 600; color: var(--text); max-width: 300px; }
.session-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.c-pill { font-size: var(--fs-11); color: var(--muted); background: var(--neutral-soft); border-radius: var(--radius-pill); padding: 2px 9px; }
.c-pill b { color: var(--text); font-weight: 650; }
.c-pill.zero { opacity: 0.55; }
.chev { color: var(--faint); transition: transform var(--dur) var(--ease); }
.session-card.open .chev { transform: rotate(90deg); }
.session-card.open .session-head { background: var(--surface-2); border-bottom: 1px solid var(--border); }

.session-body { padding: 12px 14px 14px; }
.mem-cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-3); }
@media (max-width: 1120px) { .mem-cols { grid-template-columns: minmax(0, 1fr); } }
.mem-col { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; min-width: 0; }
.col-head { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-11); color: var(--muted); margin-bottom: 8px; letter-spacing: 0.04em; }
.c-num { color: var(--faint); font-variant-numeric: tabular-nums; }
.col-list { display: flex; flex-direction: column; gap: 8px; max-height: 280px; overflow: auto; }
.mem-item { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 8px 10px; }
.mem-item.expired { opacity: 0.6; }
.mem-text { font-size: var(--fs-12); line-height: 1.7; color: var(--text-2); white-space: pre-wrap; word-break: break-word; }
.mem-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 5px; }
.tag.pending { background: var(--warn-soft); border-color: transparent; color: var(--warn); max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.tag.expired-tag { background: var(--neutral-soft); border-color: transparent; color: var(--muted); }
.col-empty { font-size: var(--fs-11); color: var(--faint); padding: 6px 2px; }
.imp-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 3px; }
.imp-name { font-size: var(--fs-12); font-weight: 650; color: var(--accent); }
</style>
