<script setup>
// 桌宠：状态 + 屏幕陪看配置 + 陪看 token 用量 + 活动记录
// 配置写 desktop-pet/data/settings.json，桌宠 1 秒内热重载；不需要重启进程。
import { computed, onMounted, reactive, ref, watch } from 'vue';
import SectionCard from '../components/SectionCard.vue';
import EmptyState from '../components/EmptyState.vue';
import KpiCard from '../components/KpiCard.vue';
import Icon from '../components/Icon.vue';
import { api, fmtCompact, fmtMoney, fmtNum } from '../api/client.js';
import { refreshTick } from '../composables/useRefresh.js';
import { toast } from '../composables/useToast.js';

const data = ref(null);
const loading = ref(false);
const error = ref('');
const saving = ref(false);
const snapshot = ref('');

const form = reactive({
  width: 320,
  height: 460,
  alwaysOnTop: true,
  clickThrough: false,
  idleSleepSec: 180,
  screenSense: {
    enabled: true,
    auto: true,
    intervalMs: 4000,
    threshold: 0.03,
    cooldownMs: 90000,
    maxWidth: 1280,
    maxPerHour: 12
  }
});

function pick() {
  return {
    width: Number(form.width) || 320,
    height: Number(form.height) || 460,
    alwaysOnTop: Boolean(form.alwaysOnTop),
    clickThrough: Boolean(form.clickThrough),
    idleSleepSec: Number(form.idleSleepSec) || 180,
    screenSense: {
      enabled: Boolean(form.screenSense.enabled),
      auto: Boolean(form.screenSense.auto),
      intervalMs: Number(form.screenSense.intervalMs) || 4000,
      threshold: Number(form.screenSense.threshold) || 0.03,
      cooldownMs: Number(form.screenSense.cooldownMs) || 90000,
      maxWidth: Number(form.screenSense.maxWidth) || 1280,
      maxPerHour: Number(form.screenSense.maxPerHour) || 12
    }
  };
}

function apply(d) {
  const s = d?.settings || {};
  const ss = s.screenSense || {};
  form.width = Number(s.width) || 320;
  form.height = Number(s.height) || 460;
  form.alwaysOnTop = s.alwaysOnTop !== false;
  form.clickThrough = Boolean(s.clickThrough);
  form.idleSleepSec = Number(s.idleSleepSec) || 180;
  Object.assign(form.screenSense, {
    enabled: ss.enabled !== false,
    auto: ss.auto !== false,
    intervalMs: Number(ss.intervalMs) || 4000,
    threshold: Number(ss.threshold) || 0.03,
    cooldownMs: Number(ss.cooldownMs) || 90000,
    maxWidth: Number(ss.maxWidth) || 1280,
    maxPerHour: Number(ss.maxPerHour) || 12
  });
  snapshot.value = JSON.stringify(pick());
}

async function load(silent = false) {
  if (!silent) loading.value = true;
  error.value = '';
  try {
    const d = await api.petGet();
    data.value = d;
    apply(d);
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => load());
watch(refreshTick, () => load(true));

const dirty = computed(() => Boolean(data.value) && snapshot.value !== JSON.stringify(pick()));
const settings = computed(() => data.value?.settings || {});
const status = computed(() => data.value?.status || {});
const sense = computed(() => status.value.sense || {});
const online = computed(() => Boolean(status.value.online));
const helperRunning = computed(() => sense.value.helper === 'running');
const activity = computed(() => data.value?.activity || []);
const token = computed(() => data.value?.tokens || {});
const total = computed(() => token.value.total || {});
const today = computed(() => token.value.today || {});
const days = computed(() => token.value.days || []);
const maxCost = computed(() => Math.max(0.0001, ...days.value.map((d) => Number(d.cost) || 0)));
const recent = computed(() => token.value.recent || []);
const windowPos = computed(() => data.value?.window || null);
const idleText = computed(() => {
  const sec = Number(status.value.pet?.ownerIdleSec);
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${Math.round(sec)} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
});
const lastActivity = computed(() => activity.value[0] || null);
const cooldownSec = computed({
  get: () => Math.round((Number(form.screenSense.cooldownMs) || 0) / 1000),
  set: (v) => { form.screenSense.cooldownMs = Math.max(10, Math.min(600, Math.round(Number(v) || 0))) * 1000; }
});

function barHeight(d) {
  return Math.max(2, (Number(d.cost) / maxCost.value) * 100).toFixed(1) + '%';
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    await api.petSave(pick());
    toast('桌宠设置已保存，1 秒内热重载');
    await load(true);
  } catch (e) {
    toast('保存失败：' + (e?.message || e), 'bad');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="row wrap" style="justify-content: space-between; margin-bottom: 12px">
      <div class="row wrap" style="gap: 8px">
        <span class="pill accent">桌宠陪看</span>
        <span class="pill" :class="online ? 'ok' : 'bad'">{{ online ? '运行中' : '未连接' }}</span>
        <span class="pill" :class="sense.asleep ? 'warn' : helperRunning ? 'ok' : 'warn'">屏幕感知 {{ sense.asleep ? '休眠中' : helperRunning ? '已启动' : '未启动' }}</span>
        <span class="pill">{{ settings.role || '大肥鱼女友版' }}</span>
      </div>
      <div class="row" style="gap: 8px">
        <span v-if="dirty" class="tiny warn-text">有未保存修改</span>
        <button class="btn btn-sm" :disabled="loading" @click="load()"><Icon name="refresh" :size="12" />刷新</button>
        <button class="btn btn-sm btn-primary" :disabled="saving || !dirty" @click="save">
          <Icon name="check" :size="12" />{{ saving ? '保存中…' : '保存配置' }}
        </button>
      </div>
    </div>

    <ErrorState v-if="error" :message="error" />
    <EmptyState v-else-if="loading && !data" text="读取桌宠状态…" icon="pet" />

    <template v-else-if="data">
      <div class="status-grid">
        <div class="status-card">
          <div class="sc-label">桌宠窗口</div>
          <div class="sc-value">{{ windowPos ? `${windowPos.x}, ${windowPos.y}` : '未记录位置' }}</div>
          <div class="sc-hint">{{ form.width }} × {{ form.height }} · {{ form.alwaysOnTop ? '置顶' : '不置顶' }} · {{ form.clickThrough ? '可穿透' : '可点击' }}</div>
        </div>
        <div class="status-card">
          <div class="sc-label">鼠标空闲</div>
          <div class="sc-value">{{ idleText }}</div>
          <div class="sc-hint">空闲 {{ form.idleSleepSec }} 秒闭眼并暂停陪看，有操作自动恢复</div>
        </div>
        <div class="status-card">
          <div class="sc-label">陪看状态</div>
          <div class="sc-value">{{ sense.asleep ? '休眠' : sense.busy ? '正在看' : sense.enabled === false ? '已关闭' : sense.auto ? '自动' : '仅手动' }}</div>
          <div class="sc-hint">最近 {{ sense.lastAt ? new Date(sense.lastAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—' }} · 本小时 {{ sense.recent || 0 }} 次</div>
        </div>
        <div class="status-card">
          <div class="sc-label">最近一次记录</div>
          <div class="sc-value small">{{ lastActivity ? lastActivity.title || '桌面' : '还没有' }}</div>
          <div class="sc-hint">{{ lastActivity ? lastActivity.time : '触发一次陪看后出现在这里' }}</div>
        </div>
      </div>

      <SectionCard title="陪看 Token 用量" subtitle="独立「桌宠陪看」DSH 会话的消耗；不含 QQ 聊天会话">
        <div class="kpis">
          <KpiCard label="今日 Tokens" :value="fmtCompact(today.tokens)" :hint="`${fmtNum(today.calls)} 次陪看`" tone="accent" />
          <KpiCard label="今日花费" :value="fmtMoney(today.cost)" hint="按当前模型价目折算" />
          <KpiCard label="累计 Tokens" :value="fmtCompact(total.tokens)" :hint="`${fmtNum(total.calls)} 次陪看`" />
          <KpiCard label="累计花费" :value="fmtMoney(total.cost)" :hint="total.turns ? `${fmtNum(total.turns)} 个回合` : ''" />
        </div>
        <div v-if="token.ok === false" class="tiny bad-text" style="margin-bottom: 8px">Token 账本暂时读不到：{{ token.error }}</div>
        <div v-if="days.some((d) => d.calls)" class="bars">
          <div v-for="d in days" :key="d.date" class="bar-col" :title="`${d.date} · ${fmtNum(d.tokens)} tokens · ${fmtMoney(d.cost)}`">
            <div class="bar-wrap"><i :style="{ height: barHeight(d) }" /></div>
            <div class="bar-label">{{ d.day }}</div>
          </div>
        </div>
        <div v-else class="tiny faint" style="margin-bottom: 8px">最近 7 天还没有陪看调用。</div>
        <div class="tiny faint" style="margin: -2px 0 10px">柱子为每日花费；悬停可看 tokens 与金额。{{ token.note || '' }}</div>

        <div v-if="recent.length" class="table-wrap">
          <table class="table">
            <thead><tr><th style="width:170px">时间</th><th style="width:90px">Tokens</th><th style="width:90px">花费</th><th style="width:110px">模型</th><th>回合</th></tr></thead>
            <tbody>
              <tr v-for="r in recent" :key="`${r.time}-${r.turn}`">
                <td class="mono tiny">{{ r.time }}</td>
                <td class="mono">{{ fmtNum(r.tokens) }}</td>
                <td class="mono">{{ fmtMoney(r.cost) }}</td>
                <td class="tiny faint">{{ r.model || '—' }}</td>
                <td class="tiny faint">#{{ r.turn }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <EmptyState v-else text="还没有陪看 token 记录" icon="cost" />
      </SectionCard>

      <SectionCard title="活动记录" subtitle="她每次看屏幕后写下的短记忆；主人私聊时会自动带最近 3 条">
        <div v-if="activity.length" class="table-wrap">
          <table class="table">
            <thead><tr><th style="width:170px">时间</th><th style="width:220px">窗口</th><th>她当时说</th><th style="width:90px">来源</th></tr></thead>
            <tbody>
              <tr v-for="a in activity" :key="a.ts + a.text">
                <td class="mono tiny">{{ a.time }}</td>
                <td class="tiny">{{ a.title || '桌面' }}</td>
                <td>{{ a.text || '—' }}</td>
                <td><span class="pill" :class="a.looked ? 'accent' : ''">{{ a.looked ? '手动' : '自动' }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <EmptyState v-else text="还没有活动记录；下次她看屏幕后会写入" icon="clock" />
      </SectionCard>

      <SectionCard title="桌宠配置" subtitle="保存后写 settings.json，桌宠 1 秒内热重载">
        <div class="config-grid">
          <div class="cfg-block">
            <div class="cfg-title">窗口</div>
            <label class="field"><span>宽度</span><input v-model.number="form.width" class="input" type="number" min="160" max="800" /></label>
            <label class="field"><span>高度</span><input v-model.number="form.height" class="input" type="number" min="220" max="1200" /></label>
            <label class="field"><span>空闲休眠（秒）</span><input v-model.number="form.idleSleepSec" class="input" type="number" min="10" max="3600" /></label>
            <label class="check"><input v-model="form.alwaysOnTop" type="checkbox" /><span>窗口置顶</span></label>
            <label class="check"><input v-model="form.clickThrough" type="checkbox" /><span>鼠标穿透</span></label>
          </div>

          <div class="cfg-block">
            <div class="cfg-title">屏幕陪看</div>
            <label class="check"><input v-model="form.screenSense.enabled" type="checkbox" /><span>启用屏幕陪看</span></label>
            <label class="check"><input v-model="form.screenSense.auto" type="checkbox" :disabled="!form.screenSense.enabled" /><span>画面变化时自动评论</span></label>
            <label class="field"><span>截图间隔（毫秒）</span><input v-model.number="form.screenSense.intervalMs" class="input" type="number" min="1000" max="60000" step="500" /></label>
            <label class="field"><span>变化阈值（0.005–0.5）</span><input v-model.number="form.screenSense.threshold" class="input" type="number" min="0.005" max="0.5" step="0.005" /></label>
            <label class="field"><span>冷却（秒）</span><input v-model.number="cooldownSec" class="input" type="number" min="10" max="600" step="5" /></label>
            <label class="field"><span>每小时最多</span><input v-model.number="form.screenSense.maxPerHour" class="input" type="number" min="1" max="120" /></label>
            <label class="field"><span>送图最大宽度</span><input v-model.number="form.screenSense.maxWidth" class="input" type="number" min="640" max="3840" step="80" /></label>
          </div>
        </div>
        <div class="tiny faint" style="margin-top: 10px">
          冷却单位是毫秒（90000 = 90 秒）；阈值越小越敏感。修改后点右上角「保存配置」，托盘菜单也会同步。
        </div>
      </SectionCard>
    </template>
  </div>
</template>

<style scoped>
.status-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; margin-bottom: 14px; }
.status-card { padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--card2); }
.sc-label { font-size: var(--fs-11); color: var(--muted); margin-bottom: 6px; }
.sc-value { font-size: 19px; font-weight: 600; color: var(--text); }
.sc-value.small { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-hint { margin-top: 5px; font-size: var(--fs-11); color: var(--faint); }
.warn-text { color: var(--warn); }
.bad-text { color: var(--danger); }
.kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
.bars { display: flex; align-items: flex-end; gap: 8px; height: 90px; padding: 6px 2px 0; margin-bottom: 4px; }
.bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 0; }
.bar-wrap { width: 100%; height: 66px; display: flex; align-items: flex-end; justify-content: center; }
.bar-wrap i { display: block; width: 70%; min-height: 2px; border-radius: 3px 3px 0 0; background: linear-gradient(180deg, var(--accent), var(--accent-soft)); }
.bar-label { font-size: 10px; color: var(--faint); }
.table-wrap { max-height: 360px; overflow: auto; }
.config-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; }
.cfg-block { display: flex; flex-direction: column; gap: 9px; }
.cfg-title { font-size: var(--fs-12); font-weight: 600; color: var(--text); padding-bottom: 4px; border-bottom: 1px solid var(--border); }
.field { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: var(--fs-12); color: var(--muted); }
.field .input { width: 150px; text-align: right; }
.check { display: flex; align-items: center; gap: 8px; font-size: var(--fs-12); color: var(--muted); cursor: pointer; }
.check input { accent-color: var(--accent); }
</style>
