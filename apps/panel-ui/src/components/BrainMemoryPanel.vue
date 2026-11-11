<script setup>
import { computed, onMounted, ref } from 'vue';
import SectionCard from '../components/SectionCard.vue';
import EmptyState from '../components/EmptyState.vue';
import Icon from '../components/Icon.vue';
import { api, fmtNum, fmtTime } from '../api/client.js';
import { toast } from '../composables/useToast.js';

const roles = ref([]);
const role = ref('');
const data = ref(null);
const loading = ref(false);
const busy = ref(false);

const KIND_LABEL = { fact: '事实', preference: '偏好', event: '事件', emotion: '情绪', promise: '约定', relationship: '关系', boundary: '边界' };
const kindLabel = (k) => KIND_LABEL[k] || k || '记忆';

async function loadRoles() {
  try {
    const d = await api.records('persona', { page: 1, pageSize: 50 });
    roles.value = (d.items || []).map((p) => ({ role: p.role || p.id, label: p.displayName || p.name || p.role }))
      .filter((x) => x.role);
    if (!role.value && roles.value.length) role.value = roles.value[0].role;
  } catch {}
}
async function load() {
  if (!role.value) return;
  loading.value = true;
  try { data.value = await api.brainMemory(role.value); }
  catch (e) { toast('读取长期记忆失败：' + (e?.message || e), 'bad'); }
  finally { loading.value = false; }
}
async function act(action, entry) {
  if (busy.value) return;
  busy.value = true;
  try {
    if (action === 'forget' && !window.confirm(`遗忘「${String(entry.content).slice(0, 40)}…」？\n只标记遗忘，不删原文，之后可以恢复。`)) return;
    await api.brainAction({ action, role: role.value, id: entry.id, pinned: action === 'pin' ? !entry.pin : undefined });
    await load();
  } catch (e) { toast('操作失败：' + (e?.message || e), 'bad'); }
  finally { busy.value = false; }
}

const entries = computed(() => data.value?.entries || []);
const stats = computed(() => data.value?.stats || {});
function retentionPct(e) { return Math.round((Number(e.retention) || 0) * 100); }

onMounted(async () => { await loadRoles(); await load(); });
</script>

<template>
  <div>
    <div class="row wrap" style="justify-content: space-between; margin-bottom: 10px">
      <div class="row wrap" style="gap: 8px">
        <span class="pill accent">长期事实记忆</span>
        <span class="pill plain">共 {{ stats.total ?? entries.length }}</span>
        <span class="pill plain">活跃 {{ stats.active ?? '—' }}</span>
        <span class="pill plain">已遗忘 {{ stats.forgotten ?? '—' }}</span>
        <span class="pill plain">钉住 {{ stats.pinned ?? '—' }}</span>
        <span class="pill plain">共享 {{ stats.shared ?? '—' }}</span>
      </div>
      <div class="row" style="gap: 8px">
        <select v-model="role" class="select" @change="load">
          <option v-for="r in roles" :key="r.role" :value="r.role">{{ r.label }}</option>
        </select>
        <button class="btn btn-sm" :disabled="loading" @click="load"><Icon name="refresh" :size="12" />刷新</button>
      </div>
    </div>

    <SectionCard title="记忆列表" subtitle="强度会按遗忘曲线衰减；回忆会强化；钉住不衰减，最多 12 条">
      <div v-if="loading" class="sub">加载中…</div>
      <div v-else-if="entries.length" class="table-wrap">
        <table class="table">
          <thead><tr><th>内容</th><th style="width:80px">类型</th><th style="width:70px" class="align-right">重要度</th><th style="width:70px" class="align-right">强度</th><th style="width:80px" class="align-right">保持率</th><th style="width:130px">状态</th><th style="width:150px">操作</th></tr></thead>
          <tbody>
            <tr v-for="e in entries" :key="e.id">
              <td><div class="truncate" :title="e.content">{{ e.content }}</div><div class="tiny faint">{{ fmtTime(e.createdAt) }}<span v-if="e.tags?.length"> · {{ e.tags.join(' / ') }}</span></div></td>
              <td>{{ kindLabel(e.kind) }}</td>
              <td class="align-right num">{{ Math.round((Number(e.importance) || 0) * 100) }}%</td>
              <td class="align-right num">{{ (Number(e.strength) || 1).toFixed(2) }}</td>
              <td class="align-right num">{{ retentionPct(e) }}%</td>
              <td>
                <span v-if="e.forgotten" class="pill bad">已遗忘</span>
                <span v-else class="pill ok">活跃</span>
                <span v-if="e.pin" class="pill info">钉住</span>
              </td>
              <td class="row" style="gap: 6px">
                <button class="btn btn-sm" :disabled="busy" @click="act('pin', e)">{{ e.pin ? '取消钉' : '钉住' }}</button>
                <button v-if="!e.forgotten" class="btn btn-sm" :disabled="busy" @click="act('forget', e)">遗忘</button>
                <button v-else class="btn btn-sm" :disabled="busy" @click="act('restore', e)">恢复</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else text="这个人设还没有长期事实记忆" hint="她通过 qq_brain_remember 写入，或等自动抽取开启" icon="memory" />
      <div class="tiny faint mt-2">注入规则：未遗忘 + 可见 → 按钉住/权重排序，最多 8 条、900 字；主人私聊永远可见，群聊按共享配置。</div>
    </SectionCard>
  </div>
</template>

<style scoped>
.table-wrap { overflow: auto; }
</style>
