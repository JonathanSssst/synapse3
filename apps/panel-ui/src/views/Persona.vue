<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorState from '../components/ErrorState.vue';
import MarkdownView from '../components/MarkdownView.vue';
import Modal from '../components/Modal.vue';
import SectionCard from '../components/SectionCard.vue';
import Icon from '../components/Icon.vue';
import { api, fmtBytes, fmtNum } from '../api/client.js';
import { useResource } from '../composables/useResource.js';
import { toast } from '../composables/useToast.js';

// api client 暂无 meta()，直接取同源 /api/meta（只读）
async function fetchMeta() {
  const res = await fetch('/api/meta', { cache: 'no-store' });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d?.error || `HTTP ${res.status}`);
  return d?.meta || {};
}

const { data, loading, error, load } = useResource(async () => {
  const [list, meta] = await Promise.all([
    api.records('persona', { pageSize: 20 }),
    fetchMeta()
  ]);
  return { list, meta };
});

const items = computed(() => data.value?.list?.items || []);
const total = computed(() => data.value?.list?.total ?? items.value.length);
const meta = computed(() => data.value?.meta || {});
const ownerQQ = computed(() => meta.value.ownerQQ || '');
const privateKey = computed(() => (ownerQQ.value ? 'private:' + ownerQQ.value : ''));
const current = computed(() => items.value.find((p) => p.isCurrent) || null);
const currentName = computed(() => current.value?.name || meta.value.role || '未设置');

// 各卡片自己的忙碌状态
const busy = reactive({});      // name -> 'default' | 'private'
const applying = reactive({});  // name -> true（应用头像昵称，最长 60s）
const avatarBroken = reactive({});

const initialOf = (p) => {
  const raw = String((p && (p.nickname || p.displayName || p.name)) || '?').trim();
  return raw.slice(0, 1) || '?';
};

async function switchPersona(p, key = '') {
  if (busy[p.name] || applying[p.name]) return;
  busy[p.name] = key ? 'private' : 'default';
  try {
    await api.personaSwitch(p.name, key);
    toast(key ? `已把「${p.name}」设为私聊人设` : `已把「${p.name}」设为默认人设`);
    await load(true);
  } catch (e) {
    toast((key ? '设为私聊失败：' : '设为默认失败：') + (e?.message || e), 'bad');
  } finally {
    busy[p.name] = '';
  }
}

async function applyPersona(p) {
  if (applying[p.name]) return;
  applying[p.name] = true;
  const at = Date.now();
  try {
    await api.personaApply(p.name);
    toast(`已应用「${p.name}」的头像与昵称（${Math.round((Date.now() - at) / 1000)}s）`);
  } catch (e) {
    toast('应用头像昵称失败：' + (e?.message || e), 'bad');
  } finally {
    applying[p.name] = false;
  }
}

// ---------- 编辑资料 ----------
const edit = reactive({
  open: false,
  name: '',
  nickname: '',
  note: '',
  avatarBase64: '',
  preview: '',
  broken: false,
  saving: false,
  error: ''
});

function openEdit(p) {
  edit.open = true;
  edit.name = p.name;
  edit.nickname = p.nickname || '';
  edit.note = p.note || '';
  edit.avatarBase64 = '';
  edit.preview = p.hasAvatar ? p.avatarUrl : '';
  edit.broken = false;
  edit.saving = false;
  edit.error = '';
}

function onFile(ev) {
  const input = ev.target;
  const file = input.files && input.files[0];
  if (!file) return;
  if (!/^image\//i.test(file.type)) {
    edit.error = '只能选图片文件（jpg / png / webp）';
    input.value = '';
    return;
  }
  if (file.size > 6 * 1024 * 1024) {
    edit.error = '图片太大（上限 6 MB）';
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    edit.preview = String(reader.result || '');
    edit.avatarBase64 = String(reader.result || '');
    edit.broken = false;
    edit.error = '';
  };
  reader.onerror = () => { edit.error = '读取图片失败，换一张试试'; };
  reader.readAsDataURL(file);
  input.value = '';
}

async function saveEdit() {
  if (edit.saving || !edit.name) return;
  edit.saving = true;
  edit.error = '';
  try {
    const body = {
      role: edit.name,
      name: edit.name,
      nickname: String(edit.nickname || '').slice(0, 24),
      note: String(edit.note || '').slice(0, 60)
    };
    if (edit.avatarBase64) body.avatarBase64 = edit.avatarBase64;
    await api.personaSave(body);
    toast('资料已保存');
    edit.open = false;
    await load(true);
  } catch (e) {
    edit.error = e?.message || String(e);
    toast('保存资料失败：' + edit.error, 'bad');
  } finally {
    edit.saving = false;
  }
}

// ---------- 查看角色卡 ----------
const card = reactive({ open: false, name: '', content: '', loading: false, error: '' });

async function openCard(p) {
  card.open = true;
  card.name = p.name;
  card.content = '';
  card.error = '';
  card.loading = true;
  try {
    const d = await api.record('persona', p.name);
    card.content = d?.content || '';
  } catch (e) {
    card.error = e?.message || String(e);
  } finally {
    card.loading = false;
  }
}

// ---------- 添加人设 / 删除人设 ----------
const MAX_CONTENT_BYTES = 200 * 1024;
const NAME_RE = /^[\u4e00-\u9fffA-Za-z0-9_-]{1,24}$/;

const createForm = reactive({
  open: false,
  name: '',
  nickname: '',
  note: '',
  content: '',
  avatarBase64: '',
  avatarPreview: '',
  avatarBroken: false,
  activate: 'none',
  submitting: false,
  error: ''
});

const nameError = computed(() => {
  const n = String(createForm.name || '').trim();
  if (!n) return '';
  if ([...n].length > 24) return '名称需要 1~24 个字符';
  if (!NAME_RE.test(n)) return '只允许中文 / 字母 / 数字 / 下划线 / 短横线';
  return '';
});
const nameValid = computed(() => Boolean(String(createForm.name || '').trim()) && !nameError.value);
const contentBytes = computed(() => new TextEncoder().encode(String(createForm.content || '')).length);
const contentChars = computed(() => [...(createForm.content || '')].length);
const contentError = computed(() => {
  if (!String(createForm.content || '').trim()) return '';
  if (contentBytes.value > MAX_CONTENT_BYTES) return `正文太大（${(contentBytes.value / 1024).toFixed(1)} KB，上限 200 KB）`;
  return '';
});
const canSubmit = computed(() => nameValid.value && Boolean(String(createForm.content || '').trim()) && !contentError.value);

function openCreate() {
  Object.assign(createForm, {
    open: true,
    name: '',
    nickname: '',
    note: '',
    content: '',
    avatarBase64: '',
    avatarPreview: '',
    avatarBroken: false,
    activate: 'none',
    submitting: false,
    error: ''
  });
}
function closeCreate() {
  if (!createForm.submitting) createForm.open = false;
}

async function fillTemplate() {
  try {
    const d = await api.personaTemplate();
    createForm.content = d?.template || '';
    if (!String(createForm.name || '').trim()) createForm.name = '新角色';
    toast('已填入默认模板，按需修改');
  } catch (e) {
    toast('加载模板失败：' + (e?.message || e), 'bad');
  }
}

function readTextFile(ev) {
  const input = ev.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  if (!/\.(md|txt|markdown)$/i.test(file.name) && !/^text\//i.test(file.type)) {
    createForm.error = '只支持 .md / .txt 文本文件';
    return;
  }
  if (file.size > MAX_CONTENT_BYTES) {
    createForm.error = `文件太大（${(file.size / 1024).toFixed(1)} KB，上限 200 KB）`;
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    createForm.content = String(reader.result || '').replace(/^\uFEFF/, '');
    createForm.error = '';
  };
  reader.onerror = () => { createForm.error = '读取文件失败'; };
  reader.readAsText(file, 'utf-8');
}

function onCreateAvatar(ev) {
  const input = ev.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  if (!/^image\//i.test(file.type)) { createForm.error = '只能选图片文件（jpg / png / webp）'; return; }
  if (file.size > 6 * 1024 * 1024) { createForm.error = '图片太大（上限 6 MB）'; return; }
  const reader = new FileReader();
  reader.onload = () => {
    createForm.avatarPreview = String(reader.result || '');
    createForm.avatarBase64 = String(reader.result || '');
    createForm.avatarBroken = false;
    createForm.error = '';
  };
  reader.onerror = () => { createForm.error = '读取图片失败'; };
  reader.readAsDataURL(file);
}

async function submitCreate() {
  if (!canSubmit.value || createForm.submitting) return;
  createForm.submitting = true;
  createForm.error = '';
  try {
    const r = await api.personaCreate({
      name: String(createForm.name || '').trim(),
      nickname: String(createForm.nickname || '').trim(),
      note: String(createForm.note || '').trim(),
      content: createForm.content,
      avatarBase64: createForm.avatarBase64 || undefined,
      activate: createForm.activate
    });
    const act = r.activated === 'default' ? '，并设为默认' : r.activated === 'private' ? '，并设为主人私聊' : '';
    toast(`人设「${r.name}」已创建${act}`);
    createForm.open = false;
    await load(true);
  } catch (e) {
    createForm.error = e?.message || String(e);
  } finally {
    createForm.submitting = false;
  }
}

const del = reactive({ open: false, name: '', display: '', busy: false, error: '' });
function openDelete(p) {
  Object.assign(del, { open: true, name: p.name, display: p.displayName || p.name, busy: false, error: '' });
}
async function confirmDelete() {
  if (del.busy) return;
  del.busy = true;
  del.error = '';
  try {
    await api.personaDelete({ name: del.name, confirm: true });
    toast(`已删除人设「${del.name}」`);
    del.open = false;
    await load(true);
  } catch (e) {
    del.error = e?.message || String(e);
  } finally {
    del.busy = false;
  }
}

// ---------- 白名单配置 ----------
const wl = reactive({
  loading: true,
  saving: false,
  error: '',
  groupsText: '',
  privatesText: '',
  counts: { groups: 0, privates: 0 },
  meta: null,
  result: null
});

// ---------- 跨群记忆共享 ----------
const ms = reactive({
  loading: true,
  saving: false,
  error: '',
  groupsText: '',
  includePrivate: false,
  role: '',
  global: '',
  savedGroups: 0,
  result: null
});

function msLines(text) {
  return String(text || '')
    .split(/[\s,，]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,12}$/.test(s));
}

// global.md 每行形如「- [群906069729] 内容」：拆成「群标签 + 正文」，长文本正常换行而不是被裁掉
const msPreviewLines = computed(() => {
  const raw = String(ms.global || '').trim();
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const g = /^[-*]\s*\[群\s*(\d+)\]\s*(.*)$/.exec(line);
      if (g) return { tag: `群 ${g[1]}`, text: g[2] };
      const p = /^[-*]\s*\[(\d+)\]\s*(.*)$/.exec(line);
      if (p) return { tag: p[1], text: p[2] };
      return { tag: '', text: line.replace(/^[-*]\s*/, '') };
    });
});

async function loadMemoryShare() {
  ms.loading = true;
  ms.error = '';
  try {
    const d = await api.memoryShareGet();
    ms.groupsText = (d.groups || []).join('\n');
    ms.includePrivate = d.includePrivate === true;
    ms.role = d.role || '';
    ms.global = d.global || '';
    ms.savedGroups = (d.groups || []).length;
  } catch (e) {
    ms.error = e?.message || String(e);
  } finally {
    ms.loading = false;
  }
}

async function saveMemoryShare() {
  if (ms.saving) return;
  ms.saving = true;
  ms.result = null;
  try {
    const d = await api.memoryShareSave({ enabled: true, groups: msLines(ms.groupsText), includePrivate: ms.includePrivate });
    ms.groupsText = (d.groups || []).join('\n');
    ms.savedGroups = (d.groups || []).length;
    ms.result = { ok: true, message: d.message || '共享记忆配置已保存（桥接热读，无需重启）' };
    toast('共享记忆配置已保存');
    await loadMemoryShare();
  } catch (e) {
    ms.result = { ok: false, message: e?.message || String(e) };
    toast('保存共享记忆失败：' + (e?.message || e), 'bad');
  } finally {
    ms.saving = false;
  }
}

function wlLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
const wlPreview = computed(() => ({
  groups: wlLines(wl.groupsText).length,
  privates: wlLines(wl.privatesText).length
}));

async function loadWhitelist() {
  wl.loading = true;
  wl.error = '';
  try {
    const d = await api.whitelistGet();
    wl.groupsText = (d.groups || []).join('\n');
    wl.privatesText = (d.privates || []).join('\n');
    wl.counts = d.counts || { groups: (d.groups || []).length, privates: (d.privates || []).length };
    wl.meta = {
      sources: d.sources || {},
      configPath: d.configPath || '',
      backupPath: d.backupPath || '',
      maxCount: d.maxCount || 200
    };
  } catch (e) {
    wl.error = e?.message || String(e);
  } finally {
    wl.loading = false;
  }
}

async function saveWhitelist() {
  if (wl.saving) return;
  wl.saving = true;
  wl.result = null;
  try {
    const d = await api.whitelistSave({
      groups: wlLines(wl.groupsText),
      privates: wlLines(wl.privatesText)
    });
    wl.groupsText = (d.groups || []).join('\n');
    wl.privatesText = (d.privates || []).join('\n');
    wl.counts = d.counts || wlPreview.value;
    wl.result = { ok: true, message: d.message || '白名单已保存，桥接已重启' };
    toast('白名单已保存，桥接已重启');
  } catch (e) {
    wl.result = { ok: false, message: e?.message || String(e) };
    toast('保存白名单失败：' + (e?.message || e), 'bad');
  } finally {
    wl.saving = false;
  }
}

onMounted(() => {
  loadWhitelist();
  loadMemoryShare();
});
</script>

<template>
  <div class="page">
    <!-- 顶部提示条：当前默认人设 / 私聊映射 -->
    <div v-if="data" class="notice-bar">
      <span class="notice-ico"><Icon name="persona" :size="14" /></span>
      <span class="pill accent">默认人设 · {{ currentName }}</span>
      <span class="pill plain">私聊 <span class="mono">{{ privateKey || '未配置' }}</span></span>
      <span class="small faint">「设为私聊」只覆盖这个会话，未单独指定时跟随默认人设。</span>
      <span class="grow" />
      <span class="tiny faint">{{ meta.mode || '—' }} · {{ fmtNum(total) }} 个人设</span>
      <button class="btn btn-sm btn-primary" @click="openCreate"><Icon name="persona" :size="13" />＋ 添加人设</button>
      <button class="btn btn-sm" :disabled="loading" @click="load(true)">
        <span v-if="loading" class="spinner" /><Icon v-else name="refresh" :size="13" />刷新
      </button>
    </div>

    <!-- 首屏骨架 -->
    <div v-if="!data && loading" class="persona-grid">
      <div v-for="i in 3" :key="i" class="card skeleton-card">
        <div class="sk-head">
          <div class="skeleton av-sk" />
          <div class="grow stack-2">
            <div class="skeleton sk-line" style="width: 46%" />
            <div class="skeleton sk-line" style="width: 72%" />
            <div class="skeleton sk-line" style="width: 38%" />
          </div>
        </div>
        <div class="sk-kv">
          <div v-for="j in 4" :key="j" class="sk-kv-row">
            <div class="skeleton sk-line" style="width: 54px" />
            <div class="skeleton sk-line" style="width: 116px" />
          </div>
        </div>
        <div class="skeleton" style="height: 62px; margin-top: 2px" />
      </div>
    </div>

    <ErrorState v-else-if="error && !data" :message="error" @retry="load(false)" />

    <template v-else-if="data">
      <EmptyState
        v-if="!items.length"
        text="还没有人设"
        hint="桥接的 personas 目录里还没有人设，先在 qq-bridge 里建一个吧"
        icon="persona"
      />

      <div v-else class="persona-grid">
        <article v-for="p in items" :key="p.name" class="card persona-card" :class="{ current: p.isCurrent }">
          <header class="p-head">
            <div class="avatar">
              <span class="avatar-ph">{{ initialOf(p) }}</span>
              <img
                v-if="p.hasAvatar && !avatarBroken[p.name]"
                :src="p.avatarUrl"
                :alt="p.name"
                @error="avatarBroken[p.name] = true"
              />
            </div>
            <div class="grow" style="min-width: 0">
              <div class="row" style="gap: 6px">
                <span class="p-name truncate" :title="p.name">{{ p.name }}</span>
                <span v-if="p.isCurrent" class="pill accent">当前人设</span>
              </div>
              <div class="small muted truncate">显示名 {{ p.displayName || '—' }}</div>
              <div class="tiny faint clamp-2" :title="p.note || ''">{{ p.note || '（无备注）' }}</div>
            </div>
          </header>

          <dl class="kv p-kv">
            <dt>昵称</dt>
            <dd class="truncate" :title="p.nickname || ''">{{ p.nickname || '—' }}</dd>
            <dt>专属表情</dt>
            <dd class="num">{{ fmtNum(p.stickers) }} 个</dd>
            <dt>角色卡</dt>
            <dd>{{ p.personaBytes ? fmtBytes(p.personaBytes) : '无 persona.md' }}</dd>
            <dt>更新时间</dt>
            <dd class="num">{{ p.tLocal || '—' }}</dd>
          </dl>

          <div class="p-actions">
            <button class="btn btn-sm" :disabled="Boolean(busy[p.name]) || Boolean(applying[p.name])" @click="switchPersona(p)">
              <span v-if="busy[p.name] === 'default'" class="spinner" />{{ busy[p.name] === 'default' ? '设置中…' : '设为默认' }}
            </button>
            <button
              class="btn btn-sm"
              :disabled="!privateKey || Boolean(busy[p.name]) || Boolean(applying[p.name])"
              :title="privateKey ? `只把「${p.name}」用于 ${privateKey} 这个会话` : 'meta 里没有 ownerQQ，无法设置私聊人设'"
              @click="switchPersona(p, privateKey)"
            >
              <span v-if="busy[p.name] === 'private'" class="spinner" />{{ busy[p.name] === 'private' ? '设置中…' : '设为私聊' }}
            </button>
            <button
              class="btn btn-sm"
              :disabled="Boolean(applying[p.name])"
              title="调用桥接把头像与昵称应用到 QQ，最长约 60 秒"
              @click="applyPersona(p)"
            >
              <span v-if="applying[p.name]" class="spinner" />{{ applying[p.name] ? '应用中…' : '应用头像昵称' }}
            </button>
            <button class="btn btn-sm" @click="openEdit(p)"><Icon name="persona" :size="12" />编辑资料</button>
            <button class="btn btn-sm" @click="openCard(p)"><Icon name="memory" :size="12" />查看角色卡</button>
            <button
              class="btn btn-sm btn-danger"
              :disabled="p.isCurrent"
              :title="p.isCurrent ? '当前使用中的人设不能删除，请先把默认切到其它人设' : '删除人设（含 memory 目录，不可恢复）'"
              @click="openDelete(p)"
            ><Icon name="close" :size="12" />删除</button>
          </div>
        </article>
      </div>
    </template>

    <!-- 白名单配置（写 qq-bridge/config.json，保存后重启桥接） -->
    <SectionCard title="白名单配置" subtitle="同步写入 allow.groups/allow.private 与 socialV2.allowGroups/allowPrivate；保存后自动重启桥接">
      <template #actions>
        <span class="pill plain">群 {{ wl.counts.groups }} 个</span>
        <span class="pill plain">QQ {{ wl.counts.privates }} 个</span>
        <button class="btn btn-sm" :disabled="wl.loading || wl.saving" @click="loadWhitelist">
          <span v-if="wl.loading" class="spinner" /><Icon v-else name="refresh" :size="12" />重新载入
        </button>
      </template>

      <div v-if="wl.error" class="error-banner">{{ wl.error }}</div>

      <div class="wl-grid">
        <label class="wl-field">
          <span class="lbl">群号（每行一个）</span>
          <textarea
            v-model="wl.groupsText"
            class="input wl-area"
            rows="8"
            spellcheck="false"
            placeholder="1085417739&#10;1109175200"
            :disabled="wl.saving"
          />
          <span class="tiny faint">已保存 {{ wl.counts.groups }} 个 · 当前输入 {{ wlPreview.groups }} 行</span>
        </label>
        <label class="wl-field">
          <span class="lbl">QQ 号（每行一个）</span>
          <textarea
            v-model="wl.privatesText"
            class="input wl-area"
            rows="8"
            spellcheck="false"
            placeholder="主人 QQ"
            :disabled="wl.saving"
          />
          <span class="tiny faint">已保存 {{ wl.counts.privates }} 个 · 当前输入 {{ wlPreview.privates }} 行</span>
        </label>
      </div>

      <div class="wl-foot">
        <span v-if="wl.result" class="wl-result" :class="wl.result.ok ? 'ok' : 'bad'">{{ wl.result.message }}</span>
        <span v-else class="tiny faint">纯数字 · 自动去重 · 每类上限 {{ wl.meta?.maxCount || 200 }} 个；保存前备份 config.json.bak，桥接重启最长等待 30s。</span>
        <button class="btn btn-primary" :disabled="wl.saving || wl.loading" @click="saveWhitelist">
          <span v-if="wl.saving" class="spinner" />{{ wl.saving ? '保存并重启桥接…' : '保存' }}
        </button>
      </div>

      <div v-if="wl.meta" class="tiny faint wl-meta">
        来源：{{ wl.meta.sources.groups || '—' }} / {{ wl.meta.sources.privates || '—' }} · {{ wl.meta.configPath }}
      </div>
    </SectionCard>

    <!-- 跨群记忆共享（写 qq-bridge/state/memory-sharing.json，桥接每条消息热读，无需重启） -->
    <SectionCard title="跨群记忆共享" subtitle="勾选的群会把自己的轻量记忆写入当前人设的 global.md，并在这些群之间共用；只在列表内的群生效">
      <template #actions>
        <span class="pill plain">已共享 {{ ms.savedGroups }} 个群</span>
        <button class="btn btn-sm" :disabled="ms.loading || ms.saving" @click="loadMemoryShare">
          <span v-if="ms.loading" class="spinner" /><Icon v-else name="refresh" :size="12" />重新载入
        </button>
      </template>

      <div v-if="ms.error" class="error-banner">{{ ms.error }}</div>

      <div class="wl-grid">
        <label class="wl-field">
          <span class="lbl">允许共享记忆的群号（每行一个）</span>
          <textarea
            v-model="ms.groupsText"
            class="input wl-area"
            rows="7"
            spellcheck="false"
            placeholder="906069729"
            :disabled="ms.saving"
          />
          <span class="tiny faint">已保存 {{ ms.savedGroups }} 个 · 当前输入 {{ msLines(ms.groupsText).length }} 个 · 仅纯数字</span>
        </label>
        <div class="wl-field">
          <span class="lbl">global.md 预览</span>
          <div class="input wl-area ms-preview">
            <template v-if="msPreviewLines.length">
              <div v-for="(line, i) in msPreviewLines" :key="i" class="ms-line">
                <span v-if="line.tag" class="ms-tag">{{ line.tag }}</span>
                <span class="ms-text">{{ line.text }}</span>
              </div>
            </template>
            <span v-else class="ms-empty">（还没有共享记忆；共享群里的 activeTopic / 群友印象会自动写入）</span>
          </div>
          <span class="tiny faint">当前人设：{{ ms.role || '—' }} · 只追加不删除，超过 30KB 自动裁剪旧内容</span>
        </div>
      </div>

      <div class="wl-foot">
        <label class="tiny" style="display: flex; align-items: center; gap: 6px">
          <input v-model="ms.includePrivate" type="checkbox" :disabled="ms.saving" />
          主人私聊也读写共享记忆
        </label>
        <span v-if="ms.result" class="wl-result" :class="ms.result.ok ? 'ok' : 'bad'">{{ ms.result.message }}</span>
        <span v-else class="tiny faint">保存后立即生效（桥接热读），不影响其它未勾选的群</span>
        <button class="btn btn-primary" :disabled="ms.saving || ms.loading" @click="saveMemoryShare">
          <span v-if="ms.saving" class="spinner" />{{ ms.saving ? '保存中…' : '保存共享配置' }}
        </button>
      </div>
    </SectionCard>

    <!-- 编辑资料 -->
    <Modal :open="edit.open" :title="`编辑资料 · ${edit.name}`" @close="edit.open = false">
      <div class="form-stack">
        <div class="field">
          <span class="lbl">头像</span>
          <div class="avatar-edit">
            <div class="avatar lg">
              <img v-if="edit.preview && !edit.broken" :src="edit.preview" alt="" @error="edit.broken = true" />
              <span v-else class="avatar-ph">{{ initialOf({ name: edit.name }) }}</span>
            </div>
            <div class="stack-2" style="gap: 6px; min-width: 0">
              <input class="file-input" type="file" accept="image/*" @change="onFile" />
              <span class="tiny faint">jpg / png / webp，≤ 6 MB；选择后转成 dataURL 提交给 /api/persona/save</span>
            </div>
          </div>
        </div>

        <label class="field">
          <span class="lbl">昵称 <span class="faint">（{{ (edit.nickname || '').length }}/24）</span></span>
          <input v-model="edit.nickname" class="input" maxlength="24" placeholder="她在 QQ 上显示的昵称" />
        </label>

        <label class="field">
          <span class="lbl">备注 <span class="faint">（{{ (edit.note || '').length }}/60）</span></span>
          <input v-model="edit.note" class="input" maxlength="60" placeholder="这一版人设的用途 / 和其它版本的区别" />
        </label>

        <div class="field">
          <span class="lbl">人设目录</span>
          <span class="small mono truncate" :title="edit.name">{{ edit.name }}</span>
        </div>

        <div v-if="edit.error" class="error-banner">{{ edit.error }}</div>
      </div>

      <template #footer>
        <button class="btn" @click="edit.open = false">取消</button>
        <button class="btn btn-primary" :disabled="edit.saving" @click="saveEdit">
          <span v-if="edit.saving" class="spinner" />{{ edit.saving ? '保存中…' : '保存资料' }}
        </button>
      </template>
    </Modal>

    <!-- 查看角色卡 -->
    <Modal :open="card.open" :title="`角色卡 · ${card.name}`" wide @close="card.open = false">
      <div v-if="card.loading" class="row" style="justify-content: center; gap: var(--sp-2); padding: var(--sp-8)">
        <span class="spinner" /><span class="small muted">正在读取角色卡…</span>
      </div>
      <div v-else-if="card.error" class="error-banner">{{ card.error }}</div>
      <EmptyState
        v-else-if="!card.content"
        text="这个人设没有 persona.md 角色卡"
        hint="角色卡文件位于 qq-bridge/personas/<人设名>/persona.md"
        icon="memory"
      />
      <div v-else class="md-scroll"><MarkdownView :source="card.content" /></div>
    </Modal>

    <!-- 添加人设 -->
    <Modal :open="createForm.open" title="添加新人设" wide @close="closeCreate">
      <div class="form-stack">
        <div class="create-grid">
          <label class="field">
            <span class="lbl">名称（目录名，必填 *）</span>
            <input v-model="createForm.name" class="input" maxlength="24" placeholder="例如：流萤-夏日版" @input="createForm.error = ''" />
            <span class="tiny" :class="nameError ? 'bad-text' : nameValid ? 'ok-text' : 'faint'">
              {{ nameError || (nameValid ? '可用 · qq-bridge/personas/' + createForm.name.trim() + '/' : '1~24 字：中文 / 字母 / 数字 / 下划线 / 短横线') }}
            </span>
          </label>
          <label class="field">
            <span class="lbl">显示昵称（可选，≤24）</span>
            <input v-model="createForm.nickname" class="input" maxlength="24" placeholder="QQ 上显示的昵称，留空用名称" />
          </label>
        </div>

        <label class="field">
          <span class="lbl">备注（可选，≤60）</span>
          <input v-model="createForm.note" class="input" maxlength="60" placeholder="例如：女友版 / 群友版 / 私聊专用" />
        </label>

        <div class="field">
          <span class="lbl">人设正文（必填 *）</span>
          <div class="row wrap" style="gap: 8px">
            <button class="btn btn-sm" type="button" @click="fillTemplate">填充默认模板</button>
            <label class="btn btn-sm file-btn">
              导入 .md / .txt
              <input type="file" accept=".md,.txt,text/markdown,text/plain" hidden @change="readTextFile" />
            </label>
            <span class="tiny faint num">{{ contentChars }} 字 · {{ (contentBytes / 1024).toFixed(1) }} KB / 200 KB</span>
          </div>
          <textarea
            v-model="createForm.content"
            class="input create-content"
            rows="10"
            placeholder="# 角色名&#10;## 身份&#10;你是……&#10;## 说话方式&#10;……"
            @input="createForm.error = ''"
          />
          <span v-if="contentError" class="tiny bad-text">{{ contentError }}</span>
        </div>

        <div class="field">
          <span class="lbl">头像（可选，≤6 MB）</span>
          <div class="avatar-edit">
            <div class="avatar lg">
              <img
                v-if="createForm.avatarPreview && !createForm.avatarBroken"
                :src="createForm.avatarPreview"
                alt=""
                @error="createForm.avatarBroken = true"
              />
              <span v-else class="avatar-ph">{{ createForm.name ? createForm.name.trim().slice(0, 1) : '?' }}</span>
            </div>
            <div class="stack-2" style="gap: 6px; min-width: 0">
              <input class="file-input" type="file" accept="image/*" @change="onCreateAvatar" />
              <span class="tiny faint">jpg / png / webp，选择后转 dataURL 交给后端写 avatar.jpg</span>
            </div>
          </div>
        </div>

        <div class="field">
          <span class="lbl">创建后</span>
          <div class="radio-row">
            <label><input v-model="createForm.activate" type="radio" value="none" /> 不切换（只建文件）</label>
            <label><input v-model="createForm.activate" type="radio" value="default" /> 设为默认人设</label>
            <label :class="{ disabled: !privateKey }">
              <input v-model="createForm.activate" type="radio" value="private" :disabled="!privateKey" />
              设为主人私聊（{{ privateKey || '无 ownerQQ' }}）
            </label>
          </div>
        </div>

        <div v-if="createForm.error" class="error-banner">{{ createForm.error }}</div>
        <div class="tiny faint">创建只新增 personas/&lt;名称&gt;/ 目录（persona.md + meta.json + 可选 avatar.jpg）；桥接人设热读，无需重启。</div>
      </div>

      <template #footer>
        <button class="btn" :disabled="createForm.submitting" @click="closeCreate">取消</button>
        <button class="btn btn-primary" :disabled="!canSubmit || createForm.submitting" @click="submitCreate">
          <span v-if="createForm.submitting" class="spinner" />{{ createForm.submitting ? '创建中…' : '创建人设' }}
        </button>
      </template>
    </Modal>

    <!-- 删除人设（二次确认） -->
    <Modal :open="del.open" title="删除人设" @close="del.busy || (del.open = false)">
      <div class="stack">
        <div class="notice-warn">
          确定删除人设「{{ del.display }}」（目录 <span class="mono">{{ del.name }}</span>）？<br />
          persona.md、meta.json、头像和 memory/ 会一起删除，且<strong>不可恢复</strong>。
        </div>
        <div class="tiny faint">当前默认 / 私聊映射 / 桥接运行中的人设不允许删除，后端会给出具体原因。</div>
        <div v-if="del.error" class="error-banner">{{ del.error }}</div>
      </div>
      <template #footer>
        <button class="btn" :disabled="del.busy" @click="del.open = false">取消</button>
        <button class="btn btn-danger" :disabled="del.busy" @click="confirmDelete">
          <span v-if="del.busy" class="spinner" />{{ del.busy ? '删除中…' : '确认删除' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
/* ---------- 顶部提示条 ---------- */
.notice-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
}
.notice-ico {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
}

/* ---------- 卡片网格 ---------- */
.persona-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--sp-4);
}
.persona-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  min-width: 0;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.persona-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-2); }
.persona-card.current {
  border-color: var(--accent);
  box-shadow: var(--shadow-1), inset 0 0 0 1px var(--accent-soft);
}

.p-head { display: flex; align-items: flex-start; gap: var(--sp-3); min-width: 0; }
.p-name { font-size: var(--fs-14); font-weight: 650; color: var(--text); }
.p-kv { grid-template-columns: 70px minmax(0, 1fr); font-size: var(--fs-12); }

.avatar {
  position: relative;
  width: 52px;
  height: 52px;
  flex: 0 0 auto;
  border-radius: 50%;
  overflow: hidden;
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.avatar.lg { width: 72px; height: 72px; }
.avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.avatar-ph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: var(--fs-20);
  font-weight: 650;
  color: var(--accent);
  background: var(--accent-soft);
}

.p-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin-top: auto;
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}
.p-actions .btn { width: 100%; height: 28px; }
.p-actions .btn > svg { margin-right: 1px; }

/* ---------- 编辑弹层 ---------- */
.form-stack { display: flex; flex-direction: column; gap: var(--sp-4); }
.field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.field .lbl { font-size: var(--fs-11); color: var(--faint); }
.avatar-edit { display: flex; align-items: center; gap: var(--sp-3); min-width: 0; }
.file-input { font-size: var(--fs-11); color: var(--muted); max-width: 100%; }
.file-input::file-selector-button {
  margin-right: var(--sp-2);
  padding: 5px 10px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-11);
  cursor: pointer;
}
.file-input::file-selector-button:hover { background: var(--surface-hover); border-color: var(--border-strong); color: var(--text); }

.md-scroll { max-height: 62vh; overflow: auto; padding-right: var(--sp-2); }

/* ---------- 骨架 ---------- */
.skeleton-card { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
.sk-head { display: flex; align-items: flex-start; gap: var(--sp-3); }
.sk-kv { display: flex; flex-direction: column; gap: 7px; }
.sk-kv-row { display: flex; gap: var(--sp-3); }
.av-sk { width: 52px; height: 52px; border-radius: 50%; flex: 0 0 auto; }
.sk-line { height: 10px; }

/* ---------- 白名单配置 ---------- */
.wl-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4); }
.wl-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.wl-area {
  height: auto;
  min-height: 168px;
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  line-height: 1.8;
  resize: vertical;
}
.wl-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
.wl-result { font-size: var(--fs-12); }
.wl-result.ok { color: var(--success); }
.wl-result.bad { color: var(--danger); }
.wl-meta { margin-top: var(--sp-2); word-break: break-all; }

/* ---------- global.md 预览：长文本换行，群标签单独成块 ---------- */
.ms-preview {
  display: flex;
  flex-direction: column;
  gap: 7px;
  height: auto;
  min-height: 168px;
  max-height: 264px;
  overflow: auto;
  padding: 10px 12px;
  font-family: var(--font-sans);
  font-size: var(--fs-12);
  line-height: 1.75;
  resize: none;
}
.ms-line { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.ms-tag {
  flex: 0 0 auto;
  margin-top: 1px;
  padding: 0 6px;
  border-radius: var(--radius-xs);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10.5px;
  line-height: 18px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ms-text { min-width: 0; color: var(--text-2); word-break: break-word; overflow-wrap: anywhere; white-space: pre-wrap; }
.ms-empty { color: var(--faint); font-size: var(--fs-12); }
@media (max-width: 860px) {
  .wl-grid { grid-template-columns: minmax(0, 1fr); }
}

/* ---------- 添加 / 删除人设 ---------- */
.create-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); }
@media (max-width: 720px) { .create-grid { grid-template-columns: minmax(0, 1fr); } }
.create-content {
  height: auto;
  min-height: 210px;
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  line-height: 1.8;
  resize: vertical;
}
.file-btn { cursor: pointer; display: inline-flex; align-items: center; }
.radio-row { display: flex; flex-wrap: wrap; gap: var(--sp-4); font-size: var(--fs-12); color: var(--text-2); }
.radio-row label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.radio-row label.disabled { opacity: 0.5; cursor: not-allowed; }
.radio-row input { accent-color: var(--accent); }
.ok-text { color: var(--success); }
.bad-text { color: var(--danger); }
.notice-warn {
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--danger-soft);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--fs-12);
  line-height: 1.8;
}
.notice-warn strong { font-weight: 700; }
</style>
