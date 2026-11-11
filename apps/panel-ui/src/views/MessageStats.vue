<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import SectionCard from '../components/SectionCard.vue';
import EmptyState from '../components/EmptyState.vue';
import Icon from '../components/Icon.vue';
import { api, fmtNum } from '../api/client.js';
import { toast } from '../composables/useToast.js';

const day = ref(new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
const data = ref(null);
const loading = ref(false);
const expanded = ref(new Set());

async function load() {
  loading.value = true;
  try {
    data.value = await api.messageStats(day.value);
  } catch (e) {
    toast('读取消息统计失败：' + (e?.message || e), 'bad');
  } finally {
    loading.value = false;
  }
}
function toggle(key) {
  const s = new Set(expanded.value);
  if (s.has(key)) s.delete(key); else s.add(key);
  expanded.value = s;
}
const convs = computed(() => data.value?.conversations || []);
const totals = computed(() => data.value?.totals || { received: 0, sent: 0, total: 0 });
const groupCount = computed(() => convs.value.filter((c) => c.kind === 'group').length);
const privateCount = computed(() => convs.value.filter((c) => c.kind === 'private').length);

watch(day, load);
onMounted(load);
</script>

<template>
  <div class="page">
    <SectionCard title="消息统计" subtitle="收到 = 别人发的；发出 = 她发的；群聊成员只统计别人，她自己单独算在发出">
      <template #actions>
        <input v-model="day" type="date" class="input" style="width: 150px" @change="load" />
        <button class="btn btn-sm" :disabled="loading" @click="load"><Icon name="refresh" :size="12" />刷新</button>
      </template>

      <div class="kpis">
        <div class="kpi"><div class="k-label">收到</div><div class="k-value">{{ fmtNum(totals.received) }}</div></div>
        <div class="kpi"><div class="k-label">发出</div><div class="k-value">{{ fmtNum(totals.sent) }}</div></div>
        <div class="kpi"><div class="k-label">总消息</div><div class="k-value">{{ fmtNum(totals.total) }}</div></div>
        <div class="kpi"><div class="k-label">会话</div><div class="k-value">{{ convs.length }} <span class="tiny faint">群 {{ groupCount }} / 私 {{ privateCount }}</span></div></div>
      </div>

      <div v-if="loading" class="sub">加载中…</div>
      <div v-else-if="convs.length" class="table-wrap">
        <table class="table">
          <thead>
            <tr><th style="width: 240px">会话</th><th style="width: 90px">类型</th><th style="width: 100px" class="align-right">收到</th><th style="width: 100px" class="align-right">发出</th><th style="width: 100px" class="align-right">群友数</th><th>活跃成员</th></tr>
          </thead>
          <tbody>
            <template v-for="c in convs" :key="c.key">
              <tr>
                <td class="mono">{{ c.key }}</td>
                <td>{{ c.kind === 'group' ? '群' : '私聊' }}</td>
                <td class="align-right num">{{ fmtNum(c.received) }}</td>
                <td class="align-right num">{{ fmtNum(c.sent) }}</td>
                <td class="align-right num">{{ c.kind === 'group' ? c.memberCount : '—' }}</td>
                <td>
                  <template v-if="c.members.length">
                    <button class="btn btn-sm" @click="toggle(c.key)">{{ expanded.has(c.key) ? '收起' : '展开' }}</button>
                  </template>
                  <span v-else class="faint tiny">—</span>
                </td>
              </tr>
              <tr v-if="expanded.has(c.key)" class="detail-row">
                <td colspan="6">
                  <div class="members">
                    <span v-for="m in c.members" :key="m.id" class="member">
                      <span class="member-name">{{ m.name }}</span>
                      <span class="member-id mono">{{ m.id }}</span>
                      <span class="member-count num">{{ m.count }}</span>
                    </span>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <EmptyState v-else text="这一天还没有消息统计" hint="桥接升级后开始累计；当天的数据每秒落盘一次" icon="audit" />
      <div class="tiny faint mt-2">统计口径：收到 = 今天该会话里别人发的消息；发出 = 她发的消息（分层/分条每一条都算）；群友数 = 当天发过言的群友数。</div>
    </SectionCard>
  </div>
</template>

<style scoped>
.kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
.kpi { padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--card2); }
.k-label { font-size: var(--fs-12); color: var(--faint); }
.k-value { font-size: var(--fs-20); font-weight: 650; margin-top: 2px; }
.table-wrap { overflow: auto; }
.detail-row td { background: var(--card2); }
.members { display: flex; flex-wrap: wrap; gap: 6px; }
.member { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 999px; background: var(--card); border: 1px solid var(--border); font-size: var(--fs-12); }
.member-id { color: var(--faint); font-size: 10px; }
.member-count { font-weight: 600; }
</style>
