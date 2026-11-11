<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SectionCard from '../components/SectionCard.vue';
import StatusPill from '../components/StatusPill.vue';
import Icon from '../components/Icon.vue';
import ErrorState from '../components/ErrorState.vue';
import EmptyState from '../components/EmptyState.vue';
import MarkdownView from '../components/MarkdownView.vue';
import ImageViewer from '../components/ImageViewer.vue';
import Modal from '../components/Modal.vue';
import { api, fmtTime, fmtBytes } from '../api/client.js';
import { FIELD_LABELS, HIDDEN_FIELDS, fmtField, fieldLabel } from '../api/fields.js';
import { TYPE_LIST_PATH } from '../router.js';
import { refreshTick } from '../composables/useRefresh.js';
import { toast } from '../composables/useToast.js';

const route = useRoute();
const router = useRouter();
const type = computed(() => String(route.params.type || ''));
const id = computed(() => String(route.params.id || ''));

const data = ref(null);
const loading = ref(true);
const error = ref('');
const viewer = ref({ open: false, src: '', title: '', caption: '' });
const filePreview = ref({ open: false, title: '', text: '', loading: false });

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.record(type.value, id.value);
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(() => route.fullPath, load);
watch(refreshTick, load);

const backPath = computed(() => {
  try {
    const raw = sessionStorage.getItem('panel.list.' + type.value);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.path) return { path: p.path, query: p.query || {} };
    }
  } catch {}
  return { path: TYPE_LIST_PATH[type.value] || '/overview', query: {} };
});
function goBack() { router.push(backPath.value); }

const item = computed(() => data.value?.item || {});
const columns = computed(() => data.value?.columns || []);
const colKeys = computed(() => new Set(columns.value.map((c) => c.key)));

const rows = computed(() => {
  const out = [];
  const seen = new Set();
  for (const col of columns.value) {
    if (HIDDEN_FIELDS.has(col.key)) continue;
    out.push({ key: col.key, label: col.label, value: item.value[col.key], type: col.type });
    seen.add(col.key);
  }
  for (const [key, value] of Object.entries(item.value)) {
    if (seen.has(key) || HIDDEN_FIELDS.has(key) || key.startsWith('_')) continue;
    if (key === 't' && item.value.tLocal) continue;
    if (key === 'at' && item.value.tLocal) continue;
    if (key === 'mtime' && item.value.tLocal) continue;
    if (value == null || value === '') continue;
    out.push({ key, label: fieldLabel(key), value, type: '' });
  }
  return out;
});

const rawJson = computed(() => {
  if (!data.value) return '';
  try { return JSON.stringify(data.value.raw, null, 2); } catch { return String(data.value.raw); }
});
const rawLines = computed(() => rawJson.value.split('\n').length);

const related = computed(() => data.value?.related || []);
const files = computed(() => data.value?.files || []);

const biliUrl = computed(() => (item.value.bvid ? `https://www.bilibili.com/video/${item.value.bvid}` : ''));
const douyinUrl = computed(() => (item.value.awemeId ? `https://www.douyin.com/video/${item.value.awemeId}` : ''));
const qzoneUrl = computed(() => (item.value.tid ? `https://user.qzone.qq.com/` : ''));

function openImage(src, title, caption = '') {
  viewer.value = { open: true, src, title, caption };
}
async function previewFile(f) {
  if (!f.path) return;
  filePreview.value = { open: true, title: f.label || '文件预览', text: '', loading: true };
  try {
    filePreview.value.text = await api.previewText(f.path);
  } catch (e) {
    filePreview.value.text = '预览失败：' + (e?.message || e);
  } finally {
    filePreview.value.loading = false;
  }
}
async function copyId() {
  try {
    await navigator.clipboard.writeText(id.value);
    toast('已复制记录 ID');
  } catch { toast('复制失败，请手动选择', 'bad'); }
}
async function resend() {
  try {
    await api.genResend(item.value.name);
    toast('已让流萤重新发送这张图');
  } catch (e) { toast('重发失败：' + (e?.message || e), 'bad'); }
}
async function removeImage() {
  if (!window.confirm('确定删除这张生成图？文件会从 E:\\BOT\\imagegen 移除。')) return;
  try {
    await api.genDelete(item.value.name);
    toast('已删除');
    goBack();
  } catch (e) { toast('删除失败：' + (e?.message || e), 'bad'); }
}
</script>

<template>
  <div class="page">
    <div class="detail-head">
      <button class="btn btn-sm" @click="goBack"><Icon name="back" :size="14" />返回列表</button>
      <span class="pill accent">{{ data?.label || type }}</span>
      <span class="mono small faint truncate">{{ id }}</span>
      <button class="btn btn-sm btn-ghost" @click="copyId">复制 ID</button>
      <div class="grow" />
      <a v-if="biliUrl" class="btn btn-sm" :href="biliUrl" target="_blank" rel="noopener"><Icon name="external" :size="13" />打开 B 站</a>
      <a v-if="douyinUrl" class="btn btn-sm" :href="douyinUrl" target="_blank" rel="noopener"><Icon name="external" :size="13" />打开抖音</a>
    </div>

    <ErrorState v-if="error && !data" :message="error" @retry="load" />
    <div v-else-if="!data && loading" class="grid grid-side">
      <div class="card" style="height: 300px; padding: 20px"><div class="skeleton" style="height: 100%" /></div>
      <div class="card" style="height: 300px; padding: 20px"><div class="skeleton" style="height: 100%" /></div>
    </div>

    <template v-else-if="data">
      <div class="grid grid-side">
        <div class="stack">
          <SectionCard title="基本信息">
            <div v-if="item.url || item.imgUrl" class="hero-image">
              <img :src="item.imgUrl || item.url" alt="" @click="openImage(item.imgUrl || item.url, data.label)" />
            </div>
            <dl class="kv detail-kv">
              <template v-for="row in rows" :key="row.key">
                <dt>{{ row.label }}</dt>
                <dd :class="{ mono: row.type === 'mono' }">
                  <template v-if="row.key === 'ok' || row.key === 'isCurrent' || row.key === 'exists' || row.key === 'hit'">
                    <StatusPill :ok="Boolean(row.value)" :label="row.value ? '是' : '否'" />
                  </template>
                  <template v-else-if="row.value && typeof row.value === 'object'">
                    <pre class="code-block mini">{{ JSON.stringify(row.value, null, 2) }}</pre>
                  </template>
                  <template v-else-if="row.key === 'error' && row.value">
                    <span class="danger-text">{{ row.value }}</span>
                  </template>
                  <template v-else>{{ fmtField(row.key, row.value) }}</template>
                </dd>
              </template>
            </dl>
          </SectionCard>

          <SectionCard v-if="data.content" :title="type === 'persona' ? '角色卡（persona.md）' : '文档内容'" dense>
            <div class="md-wrap"><MarkdownView :source="data.content" /></div>
          </SectionCard>

          <SectionCard v-else-if="item.note" title="她的感受">
            <blockquote class="note-quote">{{ item.note }}</blockquote>
          </SectionCard>

          <SectionCard title="原始 JSON" dense>
            <div class="row-between" style="padding: 2px 4px 8px">
              <span class="tiny faint">{{ rawLines }} 行</span>
              <span class="tiny faint">来自审计库 / 数据文件，只读</span>
            </div>
            <pre class="code-block">{{ rawJson }}</pre>
          </SectionCard>
        </div>

        <div class="stack">
          <SectionCard title="操作">
            <div class="stack-2">
              <button v-if="type === 'gen_image'" class="btn" @click="resend">重发到 QQ</button>
              <button v-if="type === 'gen_image'" class="btn btn-danger" @click="removeImage">删除图片</button>
              <button v-if="type === 'persona'" class="btn" @click="router.push('/persona')">去人设页编辑</button>
              <button v-if="item.name && type === 'gen_image'" class="btn" @click="openImage(api.genImageUrl(item.name), item.name)">查看原图</button>
              <button v-if="item.imgUrl" class="btn" @click="openImage(item.imgUrl, item.desc || '表情')">查看表情</button>
              <span v-if="!['gen_image', 'persona', 'sticker'].includes(type)" class="small faint">该类型记录为只读</span>
            </div>
          </SectionCard>

          <SectionCard title="关联信息">
            <div v-if="related.length" class="related">
              <RouterLink
                v-for="(r, i) in related"
                :key="i"
                :to="r.id ? `/detail/${r.type}/${encodeURIComponent(r.id)}` : ''"
                class="related-row"
                :class="{ static: !r.id }"
              >
                <span class="pill plain">{{ r.label }}</span>
                <span class="grow truncate">{{ r.title || r.extra || '—' }}</span>
                <span class="tiny faint num">{{ r.tLocal || '' }}</span>
              </RouterLink>
            </div>
            <EmptyState v-else text="没有关联记录" icon="box" />
          </SectionCard>

          <SectionCard title="相关文件">
            <div v-if="files.length" class="file-list">
              <div v-for="(f, i) in files" :key="i" class="file-row">
                <Icon :name="f.kind === 'image' ? 'album' : 'memory'" :size="14" />
                <span class="grow truncate mono small" :title="f.path">{{ f.label || f.path }}</span>
                <span v-if="f.bytes" class="tiny faint">{{ fmtBytes(f.bytes) }}</span>
                <button v-if="f.url" class="btn btn-sm" @click="openImage(f.url, f.label)">查看</button>
                <button v-else-if="f.path" class="btn btn-sm" @click="previewFile(f)">预览</button>
              </div>
            </div>
            <EmptyState v-else text="没有关联文件" icon="box" />
          </SectionCard>
        </div>
      </div>
    </template>

    <ImageViewer :open="viewer.open" :src="viewer.src" :title="viewer.title" :caption="viewer.caption" @close="viewer.open = false" />
    <Modal :open="filePreview.open" :title="filePreview.title" wide @close="filePreview.open = false">
      <div v-if="filePreview.loading" class="row"><span class="spinner" /> 读取中…</div>
      <pre v-else class="code-block">{{ filePreview.text }}</pre>
    </Modal>
  </div>
</template>

<style scoped>
.detail-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.detail-kv { grid-template-columns: 110px minmax(0, 1fr); }
.detail-kv dd { white-space: pre-wrap; }
.hero-image { margin-bottom: 14px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border); max-width: 360px; }
.hero-image img { width: 100%; cursor: zoom-in; }
.md-wrap { padding: 14px 16px; max-height: 560px; overflow: auto; }
.code-block.mini { max-height: 220px; font-size: 11px; }
.note-quote {
  margin: 0;
  padding: 12px 16px;
  border-left: 3px solid var(--accent);
  background: var(--surface-2);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--text-2);
  font-size: var(--fs-13);
  line-height: 1.9;
  white-space: pre-wrap;
}
.related { display: flex; flex-direction: column; gap: 2px; }
.related-row { display: flex; align-items: center; gap: 8px; padding: 7px 6px; border-radius: var(--radius-xs); font-size: var(--fs-12); color: var(--text-2); }
.related-row:hover { background: var(--surface-2); }
.related-row.static { cursor: default; }
.file-list { display: flex; flex-direction: column; gap: 4px; }
.file-row { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-radius: var(--radius-xs); font-size: var(--fs-12); }
.file-row:hover { background: var(--surface-2); }
.danger-text { color: var(--danger); }
</style>
