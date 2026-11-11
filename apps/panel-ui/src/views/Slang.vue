<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import SectionCard from '../components/SectionCard.vue';
import EmptyState from '../components/EmptyState.vue';
import Icon from '../components/Icon.vue';
import { api, fmtNum, fmtTime } from '../api/client.js';
import { toast } from '../composables/useToast.js';

const loading = ref(false);
const savingCfg = ref(false);
const busy = ref(false);
const data = ref(null);
const q = ref('');
const status = ref('');
const selected = ref(new Set());
const edits = reactive({});
const cfg = reactive({ enabled: true, autoResearch: true, autoConfirm: true, injectMax: 8, extractMinMessages: 10 });

async function load() {
  loading.value = true;
  try {
    const d = await api.slangGet(q.value, status.value);
    data.value = d;
    if (d.config) {
      cfg.enabled = d.config.enabled !== false;
      cfg.autoResearch = d.config.autoResearch !== false;
      cfg.autoConfirm = d.config.autoConfirm !== false;
      cfg.injectMax = Number(d.config.injectMax ?? 8);
      cfg.extractMinMessages = Number(d.config.extractMinMessages ?? 10);
    }
    selected.value = new Set();
    for (const e of d.entries || []) edits[e.id] = { meaning: e.meaning || '', usage: e.usage || '' };
  } catch (e) {
    toast('读取黑话库失败：' + (e?.message || e), 'bad');
  } finally {
    loading.value = false;
  }
}

const entries = computed(() => data.value?.entries || []);
const stats = computed(() => data.value?.stats || { total: 0, candidate: 0, confirmed: 0, rejected: 0 });
const filteredCount = computed(() => entries.value.length);

function toggle(id) {
  const s = new Set(selected.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selected.value = s;
}
function selectAll() {
  selected.value = new Set(entries.value.map((e) => e.id));
}
function clearSel() { selected.value = new Set(); }

async function saveOne(id, field) {
  const e = edits[id];
  if (!e) return;
  try {
    await api.slangUpdate(id, { [field]: e[field] });
  } catch (err) { toast('保存失败：' + (err?.message || err), 'bad'); }
}

async function confirmIds(ids) {
  if (!ids.length) return;
  busy.value = true;
  try {
    const r = await api.slangConfirm(ids);
    const skipped = Number(r.skippedCount) || 0;
    toast(`已确认 ${r.confirmedCount ?? 0} 条${skipped ? `，跳过 ${skipped} 条（缺含义）` : ''}`, skipped ? 'bad' : 'ok');
    await load();
  } catch (e) { toast('确认失败：' + (e?.message || e), 'bad'); }
  finally { busy.value = false; }
}
async function rejectIds(ids) {
  if (!ids.length) return;
  busy.value = true;
  try {
    const r = await api.slangReject(ids);
    toast(`已拒绝 ${r.rejectedCount ?? 0} 条`);
    await load();
  } catch (e) { toast('拒绝失败：' + (e?.message || e), 'bad'); }
  finally { busy.value = false; }
}

async function saveCfg() {
  savingCfg.value = true;
  try {
    const r = await api.settingsSave({ bridge: {
      'slang.enabled': cfg.enabled,
      'slang.autoResearch': cfg.autoResearch,
      'slang.autoConfirm': cfg.autoConfirm,
      'slang.injectMax': cfg.injectMax,
      'slang.extractMinMessages': cfg.extractMinMessages
    }, qzone: {} });
    toast(r.bridge?.ok ? '黑话配置已保存，桥接已重启' : '保存失败：' + (r.bridge?.error || ''), r.bridge?.ok ? 'ok' : 'bad');
    await load();
  } catch (e) { toast('保存失败：' + (e?.message || e), 'bad'); }
  finally { savingCfg.value = false; }
}

const statusLabel = (s) => s === 'confirmed' ? '已确认' : s === 'rejected' ? '已拒绝' : '候选';

onMounted(load);
</script>

<template>
  <div class="page">
    <SectionCard title="黑话学习配置" subtitle="候选达到阈值会自动调研；确认后的词条才会注入唤醒提示">
      <div class="grid">
        <label class="field"><span>启用黑话学习</span><input v-model="cfg.enabled" type="checkbox" /></label>
        <label class="field"><span>自动调研（联网查含义）</span><input v-model="cfg.autoResearch" type="checkbox" /></label>
        <label class="field"><span>调研确认后自动转已确认</span><input v-model="cfg.autoConfirm" type="checkbox" /></label>
        <label class="field"><span>提示词注入上限（条）</span><input v-model.number="cfg.injectMax" type="number" min="1" max="30" /></label>
        <label class="field"><span>每群提取最少消息数</span><input v-model.number="cfg.extractMinMessages" type="number" min="1" max="100" /></label>
      </div>
      <div class="row" style="justify-content: flex-end; margin-top: 8px">
        <button class="btn btn-primary" :disabled="savingCfg" @click="saveCfg">{{ savingCfg ? '保存中…' : '保存配置' }}</button>
      </div>
    </SectionCard>

    <SectionCard title="黑话库" subtitle="候选 → 确认（需含义）→ 才会进入【群聊黑话表】">
      <template #actions>
        <span class="pill">共 {{ stats.total }}</span>
        <span class="pill">候选 {{ stats.candidate }}</span>
        <span class="pill">已确认 {{ stats.confirmed }}</span>
        <span class="pill">已拒绝 {{ stats.rejected }}</span>
        <button class="btn btn-sm" :disabled="loading" @click="load"><Icon name="refresh" :size="12" />刷新</button>
      </template>

      <div class="toolbar">
        <input v-model="q" class="input" placeholder="搜索词条 / 含义 / 用法" style="max-width: 240px" @keyup.enter="load" />
        <select v-model="status" class="select" @change="load">
          <option value="">全部状态</option>
          <option value="candidate">候选</option>
          <option value="confirmed">已确认</option>
          <option value="rejected">已拒绝</option>
        </select>
        <button class="btn btn-sm" @click="load">查询</button>
        <span class="grow" />
        <span class="tiny faint">已选 {{ selected.size }} 条</span>
        <button class="btn btn-sm" :disabled="!selected.size" @click="selectAll">全选当前</button>
        <button class="btn btn-sm" :disabled="!selected.size" @click="clearSel">清空</button>
        <button class="btn btn-sm" :disabled="!selected.size || busy" @click="confirmIds([...selected])">批量确认</button>
        <button class="btn btn-sm" :disabled="!selected.size || busy" @click="rejectIds([...selected])">批量拒绝</button>
      </div>

      <div v-if="loading" class="sub">加载中…</div>
      <div v-else-if="entries.length" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th style="width: 32px"></th>
              <th style="width: 120px">词条</th>
              <th style="width: 70px">出现</th>
              <th style="width: 90px">状态</th>
              <th>含义（可编辑）</th>
              <th style="width: 160px">用法</th>
              <th style="width: 150px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in entries" :key="e.id">
              <td><input type="checkbox" :checked="selected.has(e.id)" @change="toggle(e.id)" /></td>
              <td class="mono">{{ e.content }}</td>
              <td class="num">{{ fmtNum(e.count) }}</td>
              <td><span class="pill" :class="e.status === 'confirmed' ? 'ok' : e.status === 'rejected' ? 'bad' : ''">{{ statusLabel(e.status) }}</span></td>
              <td>
                <input v-model="edits[e.id].meaning" class="input" placeholder="填含义后才能确认" @change="saveOne(e.id, 'meaning')" />
              </td>
              <td><input v-model="edits[e.id].usage" class="input" placeholder="用法/语气（可选）" @change="saveOne(e.id, 'usage')" /></td>
              <td class="row">
                <button class="btn btn-sm" :disabled="busy" @click="confirmIds([e.id])">确认</button>
                <button class="btn btn-sm" :disabled="busy" @click="rejectIds([e.id])">拒绝</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else text="没有匹配的黑话" icon="memory" />
      <div class="tiny faint mt-2">提示：只有「已确认 + 有含义」的条目会被注入唤醒提示（最多 {{ cfg.injectMax }} 条）；自动确认开启时，调研成功会自动转已确认。</div>
    </SectionCard>
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px 16px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-12); color: var(--faint); }
.field input[type="number"] { padding: 5px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--card2); color: var(--fg); }
.field input[type="checkbox"] {
  appearance: none; -webkit-appearance: none;
  width: 38px; height: 22px; margin: 3px 0; border-radius: 999px;
  border: 1px solid var(--border-strong, var(--border)); background: var(--card2);
  position: relative; cursor: pointer; transition: background .18s ease, border-color .18s ease;
}
.field input[type="checkbox"]::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: var(--faint); transition: transform .18s ease, background .18s ease;
}
.field input[type="checkbox"]:checked {
  background: color-mix(in srgb, var(--accent, #38bdf8) 28%, var(--card2));
  border-color: var(--accent, #38bdf8);
}
.field input[type="checkbox"]:checked::after { transform: translateX(16px); background: var(--accent, #38bdf8); }
.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.table-wrap { overflow: auto; }
</style>
