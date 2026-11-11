<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import SectionCard from '../components/SectionCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorState from '../components/ErrorState.vue';
import ImageViewer from '../components/ImageViewer.vue';
import Icon from '../components/Icon.vue';
import { api, fmtBytes, fmtNum } from '../api/client.js';
import { useResource } from '../composables/useResource.js';
import { toast } from '../composables/useToast.js';

const router = useRouter();

const TABS = [
  { key: 'gen', label: '生成图', icon: 'album' },
  { key: 'refs', label: '参考图', icon: 'persona' },
  { key: 'sticker', label: '表情库', icon: 'box' }
];
const tab = ref('gen');

// 生成图 / 参考图 / 表情库三块并行加载；单块失败不影响另外两块
const { data, loading, error, load } = useResource(async () => {
  const [g, r, s, p] = await Promise.allSettled([
    api.records('gen_image', { pageSize: 100 }),
    api.refsGet(),
    api.records('sticker', { pageSize: 200 }),
    api.records('persona', { pageSize: 50 })
  ]);
  const val = (x) => (x.status === 'fulfilled' ? x.value : null);
  const msg = (x) => (x.status === 'rejected' ? x.reason?.message || String(x.reason) : '');
  return {
    gen: val(g) || { items: [], total: 0 },
    refs: val(r)?.refs || { files: [], config: {} },
    stickers: val(s) || { items: [], total: 0 },
    personas: val(p)?.items || [],
    errors: { gen: msg(g), refs: msg(r), sticker: msg(s) }
  };
});

const errs = computed(() => data.value?.errors || {});
const allFailed = computed(() => Boolean(errs.value.gen && errs.value.refs && errs.value.sticker));
const tabError = computed(() => (data.value ? errs.value[tab.value] || '' : ''));

// ---------- 生成图 ----------
const genItems = computed(() => data.value?.gen?.items || []);
const genTotal = computed(() => data.value?.gen?.total ?? genItems.value.length);
const genBytes = computed(() => genItems.value.reduce((n, g) => n + (Number(g.bytes) || 0), 0));
const genUrl = (name) => api.genImageUrl(name);

const resending = reactive({});
const deleting = reactive({});

async function resend(g) {
  if (resending[g.name]) return;
  resending[g.name] = true;
  try {
    await api.genResend(g.name);
    toast('已让流萤把这张图重新发到 QQ');
  } catch (e) {
    toast('重发失败：' + (e?.message || e), 'bad');
  } finally {
    resending[g.name] = false;
  }
}

async function removeGen(g) {
  if (deleting[g.name]) return;
  if (!window.confirm(`确定删除这张生成图？\n${g.name}\n文件会从 E:\\BOT\\imagegen 移除。`)) return;
  deleting[g.name] = true;
  try {
    await api.genDelete(g.name);
    toast('已删除生成图');
    await load(true);
  } catch (e) {
    toast('删除失败：' + (e?.message || e), 'bad');
  } finally {
    deleting[g.name] = false;
  }
}

// ---------- 参考图 ----------
const refFiles = computed(() => data.value?.refs?.files || []);
const refUrl = (name) => api.refImageUrl(name);
const refBusy = reactive({});

async function toggleSafe(f) {
  if (refBusy[f.name]) return;
  refBusy[f.name] = true;
  const next = !f.policySafe;
  try {
    const res = await api.refNote(f.name, next);
    if (data.value && res?.refs) data.value.refs = res.refs;
    else f.policySafe = next;
    toast(next ? '已标记为「可过审」' : '已取消「可过审」标记');
  } catch (e) {
    toast('保存安全标记失败：' + (e?.message || e), 'bad');
  } finally {
    refBusy[f.name] = false;
  }
}

// ---------- 表情库 ----------
const stickerItems = computed(() => data.value?.stickers?.items || []);
const stickerTotal = computed(() => data.value?.stickers?.total ?? stickerItems.value.length);
const stFilter = ref('');

const personaOptions = computed(() => {
  const set = new Set();
  for (const p of data.value?.personas || []) if (p?.name) set.add(p.name);
  for (const s of stickerItems.value) for (const n of s.personas || []) set.add(n);
  return [...set];
});

const filteredStickers = computed(() => {
  const list = stickerItems.value;
  if (!stFilter.value) return list;
  if (stFilter.value === '__none__') return list.filter((s) => !(s.personas || []).length);
  return list.filter((s) => (s.personas || []).includes(stFilter.value));
});

const stickerUrl = (s) => s.imgUrl || s.url || '';
const personaFull = (s) => ((s.personas || []).length ? s.personas.join('、') : '未关联人设');
const personaText = (s) => {
  const arr = s.personas || [];
  if (!arr.length) return '未关联人设';
  return arr.length > 1 ? `${arr[0]} +${arr.length - 1}` : arr[0];
};

// ---------- 图片失败占位（QQ CDN 外链拿不到时不能整页崩） ----------
const imgFailed = reactive(new Set());

// ---------- 预览 ----------
const viewer = ref({ open: false, src: '', title: '', caption: '' });
function openViewer(src, title, caption = '') {
  if (!src) return;
  viewer.value = { open: true, src, title, caption };
}

// ---------- 详情 ----------
function goDetail(type, id) {
  router.push({ name: 'detail', params: { type, id: String(id) } });
}

// ---------- 生图设置 ----------
const MODELS = [
  { value: 'doubao-seedream-5-0-flash-260915', label: 'doubao-seedream-5-0-flash-260915 · 快 / 点名生成' },
  { value: 'doubao-seedream-5-0-pro-260628', label: 'doubao-seedream-5-0-pro-260628 · 稳 / 参考图模式' }
];
const SIZES = ['1K', '1.5K', '2K', '4K'];

const cfg = computed(() => data.value?.refs?.config || {});
const cfgForm = reactive({ model: MODELS[0].value, size: '2K', refsCount: 0 });
const cfgDirty = ref(false);
const cfgSaving = ref(false);
const cfgError = ref('');

watch(
  cfg,
  (c) => {
    if (!c || cfgDirty.value) return;
    cfgForm.model = c.model || MODELS[0].value;
    cfgForm.size = c.size || '2K';
    cfgForm.refsCount = Number.isFinite(Number(c.refsCount)) ? Number(c.refsCount) : 0;
  },
  { immediate: true, deep: true }
);

async function saveConfig() {
  if (cfgSaving.value) return;
  cfgSaving.value = true;
  cfgError.value = '';
  try {
    await api.refsSave({ model: cfgForm.model, size: cfgForm.size, refsCount: Number(cfgForm.refsCount) || 0 });
    cfgDirty.value = false;
    toast('生图设置已保存并生效');
    await load(true);
  } catch (e) {
    cfgError.value = e?.message || String(e);
    toast('保存失败：' + cfgError.value, 'bad');
  } finally {
    cfgSaving.value = false;
  }
}

const countText = (n, failed) => (!data.value || failed ? '—' : fmtNum(n));
</script>

<template>
  <div class="page">
    <div class="row wrap" style="justify-content: space-between">
      <div class="seg">
        <button v-for="t in TABS" :key="t.key" class="seg-btn" :class="{ on: tab === t.key }" @click="tab = t.key">
          <Icon :name="t.icon" :size="13" />{{ t.label }}
        </button>
      </div>
      <div class="row wrap" style="gap: var(--sp-2)">
        <span class="small faint">
          生成图 <b class="num">{{ countText(genTotal, errs.gen) }}</b> ·
          参考图 <b class="num">{{ countText(refFiles.length, errs.refs) }}</b> ·
          表情 <b class="num">{{ countText(stickerTotal, errs.sticker) }}</b>
        </span>
        <button class="btn btn-sm" :disabled="loading" @click="load(true)">
          <span v-if="loading" class="spinner" /><Icon v-else name="refresh" :size="13" />刷新
        </button>
      </div>
    </div>

    <!-- 首屏加载骨架 -->
    <div v-if="!data && loading" class="photo-grid">
      <div v-for="i in 8" :key="i" class="photo-card">
        <div class="thumb skeleton" />
      </div>
    </div>

    <ErrorState v-else-if="error && !data" :message="error" @retry="load(false)" />

    <template v-else-if="data">
      <ErrorState v-if="allFailed" :message="errs.gen" @retry="load(false)" />

      <template v-else>
        <ErrorState v-if="tabError" :message="tabError" @retry="load(true)" />

        <!-- ============ 生成图 ============ -->
        <template v-else-if="tab === 'gen'">
          <EmptyState
            v-if="!genItems.length"
            text="还没有生成图"
            hint="她在聊天里画一张之后，这里就会出现"
            icon="album"
          />
          <template v-else>
            <div class="tab-note">
              <span class="small muted">共 <b class="num">{{ fmtNum(genItems.length) }}</b> 张</span>
              <span class="tiny faint">合计 {{ fmtBytes(genBytes) }} · 悬停卡片显示操作</span>
            </div>
            <div class="photo-grid">
              <article
                v-for="g in genItems"
                :key="g.id || g.name"
                class="photo-card"
                @click="goDetail('gen_image', g.id || g.name)"
              >
                <div class="thumb">
                  <img
                    v-if="!imgFailed.has(genUrl(g.name))"
                    :src="genUrl(g.name)"
                    :alt="g.name"
                    loading="lazy"
                    class="zoomable"
                    @click.stop="openViewer(genUrl(g.name), '生成图预览', g.name)"
                    @error="imgFailed.add(genUrl(g.name))"
                  />
                  <div v-else class="thumb-ph"><Icon name="album" :size="20" /><span>图片读取失败</span></div>
                  <div class="ops">
                    <div class="ops-grid">
                      <button class="btn btn-sm" @click.stop="openViewer(genUrl(g.name), '生成图预览', g.name)">预览</button>
                      <button class="btn btn-sm" :disabled="resending[g.name]" @click.stop="resend(g)">
                        <span v-if="resending[g.name]" class="spinner" />{{ resending[g.name] ? '重发中…' : '重发' }}
                      </button>
                      <button class="btn btn-sm" @click.stop="goDetail('gen_image', g.id || g.name)">详情</button>
                      <button class="btn btn-sm btn-danger" :disabled="deleting[g.name]" @click.stop="removeGen(g)">
                        {{ deleting[g.name] ? '删除中…' : '删除' }}
                      </button>
                    </div>
                  </div>
                </div>
                <div class="meta">
                  <div class="tiny truncate" :title="g.name">{{ g.name }}</div>
                  <div class="row-between tiny faint">
                    <span class="num">{{ fmtBytes(g.bytes) }}</span>
                    <span class="num">{{ g.tLocal }}</span>
                  </div>
                </div>
              </article>
            </div>
          </template>
        </template>

        <!-- ============ 参考图 ============ -->
        <template v-else-if="tab === 'refs'">
          <EmptyState
            v-if="!refFiles.length"
            text="参考图目录为空"
            hint="把参考图放进 E:\BOT\imagegen\refs（png / jpg / webp）"
            icon="persona"
          />
          <template v-else>
            <div class="tab-note">
              <span class="small muted">共 <b class="num">{{ refFiles.length }}</b> 张参考图</span>
              <span class="tiny faint">标记「可过审」的图在生图审核时更稳</span>
            </div>
            <div class="photo-grid">
              <article v-for="f in refFiles" :key="f.name" class="photo-card ref-card">
                <div class="thumb ref-thumb">
                  <img
                    v-if="!imgFailed.has(refUrl(f.name))"
                    :src="refUrl(f.name)"
                    :alt="f.name"
                    class="zoomable"
                    @click="openViewer(refUrl(f.name), f.title || f.name, String(f.impression || '').slice(0, 140))"
                    @error="imgFailed.add(refUrl(f.name))"
                  />
                  <div v-else class="thumb-ph"><Icon name="persona" :size="20" /><span>图片读取失败</span></div>
                  <span class="safe-badge" :class="{ on: f.policySafe }">{{ f.policySafe ? '可过审' : '未标记' }}</span>
                </div>
                <div class="meta">
                  <div class="tiny truncate" :title="f.name">{{ f.name }}</div>
                  <div v-if="f.title" class="small truncate" :title="f.title">{{ f.title }}</div>
                  <div v-if="f.impression" class="tiny faint clamp-2" :title="f.impression">{{ f.impression }}</div>
                  <div v-if="(f.tags || []).length" class="tag-row">
                    <span v-for="t in f.tags" :key="t" class="tag">{{ t }}</span>
                  </div>
                  <div class="safe-row">
                    <span class="tiny muted">安全标记</span>
                    <button
                      class="switch"
                      :class="{ on: f.policySafe }"
                      role="switch"
                      :aria-checked="Boolean(f.policySafe)"
                      :disabled="refBusy[f.name]"
                      :title="f.policySafe ? '点击取消「可过审」' : '点击标记「可过审」'"
                      @click="toggleSafe(f)"
                    >
                      <span class="knob" />
                    </button>
                    <span class="tiny" :class="f.policySafe ? 'ok-text' : 'faint'">{{ f.policySafe ? '开' : '关' }}</span>
                    <span v-if="refBusy[f.name]" class="spinner" />
                    <span class="grow" />
                    <button class="btn btn-sm" @click="openViewer(refUrl(f.name), f.title || f.name, String(f.impression || '').slice(0, 140))">预览</button>
                  </div>
                </div>
              </article>
            </div>
          </template>
        </template>

        <!-- ============ 表情库 ============ -->
        <template v-else>
          <div class="row wrap" style="justify-content: space-between">
            <div class="row wrap" style="gap: var(--sp-2)">
              <span class="small muted">共 <b class="num">{{ fmtNum(stickerTotal) }}</b> 个收藏表情</span>
              <span v-if="stickerItems.length < stickerTotal" class="tiny faint">已加载最近 {{ stickerItems.length }} 个</span>
              <span class="tiny faint">当前显示 {{ filteredStickers.length }} 个</span>
            </div>
            <label class="row" style="gap: 6px">
              <span class="tiny faint">按人设筛选</span>
              <select v-model="stFilter" class="select filter-select">
                <option value="">全部人设</option>
                <option v-for="n in personaOptions" :key="n" :value="n">{{ n }}</option>
                <option value="__none__">未关联人设</option>
              </select>
            </label>
          </div>

          <EmptyState
            v-if="!filteredStickers.length"
            :text="stFilter ? '没有符合筛选的表情' : '还没有收藏表情'"
            :hint="stFilter ? '换一个人设筛选试试' : '她在聊天里偷图之后会出现在这里'"
            icon="box"
          />
          <div v-else class="photo-grid sticker-grid">
            <article
              v-for="s in filteredStickers"
              :key="s.id"
              class="photo-card sticker-card"
              tabindex="0"
              :title="s.desc || s.localNote || ''"
              @click="goDetail('sticker', s.id)"
              @keydown.enter="goDetail('sticker', s.id)"
            >
              <div class="thumb sticker-thumb">
                <img
                  v-if="s.imgUrl && !imgFailed.has(stickerUrl(s))"
                  :src="stickerUrl(s)"
                  :alt="s.desc || s.localNote || '表情'"
                  loading="lazy"
                  @error="imgFailed.add(stickerUrl(s))"
                />
                <div v-else class="thumb-ph"><Icon name="box" :size="20" /><span>{{ s.imgUrl ? 'QQ CDN 图片不可达' : '没有图片地址' }}</span></div>
              </div>
              <div class="meta">
                <div class="small truncate">{{ s.desc || s.localNote || '(无备注)' }}</div>
                <div class="row-between tiny faint">
                  <span class="num">用 {{ fmtNum(s.useCount || 0) }} 次</span>
                  <span class="truncate persona-of" :title="personaFull(s)">{{ personaText(s) }}</span>
                </div>
              </div>
            </article>
          </div>
        </template>

        <!-- ============ 生图设置 ============ -->
        <SectionCard title="生图设置" subtitle="三栏共用 · 立即生效">
          <div class="cfg-row">
            <label class="field">
              <span class="lbl">模型</span>
              <select v-model="cfgForm.model" class="select cfg-select" title="生图模型" @change="cfgDirty = true">
                <option v-for="m in MODELS" :key="m.value" :value="m.value">{{ m.label }}</option>
              </select>
            </label>
            <label class="field">
              <span class="lbl">尺寸</span>
              <select v-model="cfgForm.size" class="select cfg-select" title="生成图片尺寸" @change="cfgDirty = true">
                <option v-for="s in SIZES" :key="s" :value="s">{{ s }}</option>
              </select>
            </label>
            <label class="field">
              <span class="lbl">参考图数量</span>
              <select v-model="cfgForm.refsCount" class="select cfg-select" title="0 = 不用参考图（点名生成）" @change="cfgDirty = true">
                <option v-for="n in 6" :key="n - 1" :value="n - 1">{{ n - 1 }} 张</option>
              </select>
            </label>
            <div class="field">
              <span class="lbl">&nbsp;</span>
              <button class="btn btn-primary" :disabled="cfgSaving" @click="saveConfig">
                <span v-if="cfgSaving" class="spinner" />{{ cfgSaving ? '保存中…' : '保存设置' }}
              </button>
            </div>
          </div>

          <div class="cfg-effective">
            <span class="pill plain">当前生效</span>
            <span class="small">模型 <b class="mono">{{ cfg.model || '—' }}</b></span>
            <span class="small">尺寸 <b>{{ cfg.size || '—' }}</b></span>
            <span class="small">参考图 <b class="num">{{ cfg.refsCount ?? 0 }}</b> 张</span>
            <span v-if="cfg.provider" class="tiny faint">provider {{ cfg.provider }}</span>
            <span v-if="cfgDirty" class="pill warn">有未保存修改</span>
          </div>

          <div v-if="cfgError" class="error-banner" style="margin-top: var(--sp-3)">{{ cfgError }}</div>

          <p class="tiny faint cfg-hint">
            只读提示：上面显示的是当前生效值，配置文件是
            <span class="mono">E:\BOT\imagegen\config.json</span>；改完表单点「保存设置」会写入该文件并立即生效。
          </p>
        </SectionCard>
      </template>
    </template>

    <ImageViewer
      :open="viewer.open"
      :src="viewer.src"
      :title="viewer.title"
      :caption="viewer.caption"
      @close="viewer.open = false"
    />
  </div>
</template>

<style scoped>
/* ---------- 分段 ---------- */
.seg {
  display: inline-flex;
  gap: 2px;
  background: var(--surface-2);
  padding: 3px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}
.seg-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 14px;
  border-radius: var(--radius-xs);
  color: var(--muted);
  font-size: var(--fs-12);
}
.seg-btn:hover { color: var(--text); }
.seg-btn.on { background: var(--surface); color: var(--accent); box-shadow: var(--shadow-1); font-weight: 600; }

/* ---------- 图片网格 ---------- */
.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--sp-3);
}
.photo-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--shadow-1);
  overflow: hidden;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.photo-card:hover,
.photo-card:focus-within {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-2);
  transform: translateY(-1px);
}
.thumb {
  position: relative;
  aspect-ratio: 1 / 1;
  background: var(--surface-2);
  overflow: hidden;
}
.thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.sticker-thumb img { object-fit: contain; }
.thumb .zoomable { cursor: zoom-in; }
.ref-thumb { aspect-ratio: 4 / 5; }
.thumb-ph {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px;
  text-align: center;
  color: var(--faint);
  font-size: var(--fs-11);
  background: var(--surface-2);
}

/* 悬停操作层（覆盖整张缩略图） */
.ops {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: var(--sp-3);
  background: var(--overlay);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur) var(--ease);
}
.photo-card:hover .ops,
.photo-card:focus-within .ops { opacity: 1; pointer-events: auto; }
.ops-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  width: 100%;
  max-width: 150px;
}
.ops .btn {
  width: 100%;
  height: 26px;
  padding: 0 6px;
  font-size: var(--fs-11);
  background: var(--surface);
  border-color: var(--border-strong);
  box-shadow: var(--shadow-1);
  white-space: nowrap;
}
.ops .btn-danger { background: var(--danger-soft); border-color: var(--danger-soft); color: var(--danger); }

/* ---------- 卡片文字区 ---------- */
.meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: var(--sp-2) 10px 10px;
  min-width: 0;
}
.meta .row-between { gap: var(--sp-2); }
.persona-of { max-width: 60%; text-align: right; }
.tag-row { display: flex; flex-wrap: wrap; gap: 3px; }

/* ---------- 参考图安全标记 ---------- */
.safe-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  height: 19px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-pill);
  font-size: var(--fs-11);
  font-weight: 600;
  background: var(--overlay);
  color: var(--text-2);
  border: 1px solid var(--border-strong);
  backdrop-filter: blur(2px);
}
.safe-badge.on { background: var(--success-soft); color: var(--success); border-color: var(--success); }
.safe-row { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
.ok-text { color: var(--success); }
.switch {
  width: 34px;
  height: 20px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
  background: var(--surface-3);
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.switch .knob {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--muted);
  transition: transform var(--dur) var(--ease), background var(--dur) var(--ease);
}
.switch.on { background: var(--success-soft); border-color: var(--success); }
.switch.on .knob { transform: translateX(14px); background: var(--success); }
.switch[disabled] { opacity: 0.5; cursor: progress; }

/* ---------- 顶部说明 ---------- */
.tab-note { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; }

/* ---------- 表情筛选 ---------- */
.filter-select { height: 28px; font-size: var(--fs-11); }

/* ---------- 生图设置 ---------- */
.cfg-row { display: flex; align-items: flex-end; flex-wrap: wrap; gap: var(--sp-3); }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.field .lbl { font-size: var(--fs-11); color: var(--faint); }
.cfg-select { height: 32px; font-size: var(--fs-12); min-width: 180px; max-width: 100%; }
.field:first-child .cfg-select { min-width: 300px; }
.cfg-effective {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2) var(--sp-3);
  margin-top: var(--sp-4);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}
.cfg-hint { margin: var(--sp-2) 0 0; }
</style>
