<script setup>
// 语音设置 + 用量监控：读写 qq-bridge/config.json 的 socialV2.voice.breeze，只读展示用量/余额/历史
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import SectionCard from '../components/SectionCard.vue';
import LineChart from '../components/LineChart.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorState from '../components/ErrorState.vue';
import Icon from '../components/Icon.vue';
import { api, fmtNum, fmtTime } from '../api/client.js';
import { refreshTick } from '../composables/useRefresh.js';
import { toast } from '../composables/useToast.js';

const DEFAULT_TEST_TEXT = '测试一下，这是新音色的声音。';
const data = ref(null);
const loading = ref(false);
const error = ref('');
const saving = ref(false);
const testing = ref(false);
const testError = ref('');
const audioSrc = ref('');
const testText = ref(DEFAULT_TEST_TEXT);
const personaBusy = reactive({});
const personaForm = reactive({});

const form = reactive({ enabled: true, voiceId: '', speed: 1, volume: 1, instructions: '', dailyCreditLimit: 300 });
const snapshot = ref('');
let testTimer = 0;

function pick(f) {
  return {
    enabled: Boolean(f.enabled),
    voiceId: String(f.voiceId || ''),
    speed: Number(f.speed),
    volume: Number(f.volume),
    instructions: String(f.instructions || ''),
    dailyCreditLimit: Number(f.dailyCreditLimit)
  };
}
function applyData(d) {
  const s = d?.settings || {};
  form.enabled = d?.enabled !== false;
  form.voiceId = String(d?.voiceId || '');
  form.speed = Number(s.speed) || 1;
  form.volume = Number(s.volume) || 1;
  form.instructions = String(s.instructions || '');
  form.dailyCreditLimit = Number(s.dailyCreditLimit) || 300;
  snapshot.value = JSON.stringify(pick(form));
  // 人设覆盖表单
  for (const key of Object.keys(personaForm)) delete personaForm[key];
  for (const p of d?.personas || []) {
    personaForm[p.role] = {
      voiceId: String(p.voiceId || ''),
      instructions: String(p.instructions || ''),
      speed: p.speed == null ? '' : Number(p.speed)
    };
  }
}
const dirty = computed(() => Boolean(data.value) && snapshot.value !== JSON.stringify(pick(form)));

async function load(silent = false) {
  if (!silent) loading.value = true;
  error.value = '';
  try {
    const d = await api.voiceGet();
    data.value = d;
    applyData(d);
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(() => load());
watch(refreshTick, () => load(true));
onBeforeUnmount(() => clearTimeout(testTimer));

const voices = computed(() => data.value?.voices || []);
const usage = computed(() => data.value?.usage || { day: '', chars: 0, credits: 0, calls: 0, failed: 0 });
const balance = computed(() => data.value?.balance || {});
const personas = computed(() => data.value?.personas || []);
const history7 = computed(() => data.value?.history || []);
const recent = computed(() => data.value?.recent || []);
const keyConfigured = computed(() => Boolean(data.value?.keyConfigured));
const currentVoiceName = computed(() => voices.value.find((v) => v.id === form.voiceId)?.name || data.value?.voiceName || form.voiceId || '未设置');
const quotaDen = computed(() => Math.max(1, Number(form.dailyCreditLimit) || 1));
const quotaPct = computed(() => Math.min(1, Math.max(0, Number(usage.value.credits || 0) / quotaDen.value)));
const quotaTone = computed(() => (quotaPct.value >= 0.95 ? 'danger' : quotaPct.value >= 0.8 ? 'warn' : 'accent'));
const testChars = computed(() => [...(testText.value || '')].length);

async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    const r = await api.voiceSave(pick(form));
    toast(`语音设置已保存${r.backupPath ? '（已备份 config.json.bak）' : ''}`);
    await load(true);
  } catch (e) {
    toast('保存失败：' + (e?.message || e), 'bad');
  } finally {
    saving.value = false;
  }
}

async function testVoice() {
  if (testing.value) return;
  testing.value = true;
  testError.value = '';
  try {
    const r = await api.voiceTest({ text: testText.value.trim() || DEFAULT_TEST_TEXT });
    audioSrc.value = `${r.url}?t=${Date.now()}`;
    toast(`试听已生成（${r.credits} credits · ${r.voiceId}）`);
    clearTimeout(testTimer);
    testTimer = setTimeout(() => load(true), 1500);
  } catch (e) {
    testError.value = e?.message || String(e);
  } finally {
    testing.value = false;
  }
}

async function savePersona(p) {
  const f = personaForm[p.role] || {};
  personaBusy[p.role] = true;
  try {
    await api.voicePersona({
      role: p.role,
      voiceId: f.voiceId || '',
      instructions: f.instructions || '',
      speed: f.speed === '' || f.speed == null ? '' : Number(f.speed)
    });
    toast(`「${p.displayName || p.role}」的音色覆盖已保存`);
    await load(true);
  } catch (e) {
    toast('保存人设音色失败：' + (e?.message || e), 'bad');
  } finally {
    personaBusy[p.role] = false;
  }
}
function resetPersona(p) {
  personaForm[p.role] = { voiceId: '', instructions: '', speed: '' };
}

// 近 7 天折线图（请求数 + 消耗积分）
const chartLabels = computed(() => history7.value.map((d) => String(d.day || '').slice(5)));
const chartSeries = computed(() => [
  { name: '请求数', data: history7.value.map((d) => Number(d.calls) || 0), color: 'var(--chart-1)' },
  { name: '消耗积分', data: history7.value.map((d) => Number(d.credits) || 0), color: 'var(--chart-2)' }
]);
</script>

<template>
  <div class="page">
    <div class="row wrap" style="justify-content: space-between">
      <div class="row wrap" style="gap: 8px">
        <span class="pill" :class="data?.enabled ? 'ok' : 'plain'">Breeze {{ data?.enabled ? '已启用' : '已关闭' }}</span>
        <span class="pill" :class="keyConfigured ? 'accent' : 'bad'">API Key {{ keyConfigured ? '已配置' : '未配置' }}</span>
        <span class="pill plain">当前音色 · {{ currentVoiceName }}</span>
        <span v-if="balance.credits != null" class="pill info">余额 {{ fmtNum(balance.credits, 1) }} credits</span>
        <span v-if="dirty" class="pill warn">有未保存修改</span>
      </div>
      <span class="small faint">数据更新：{{ data?.generatedAt ? fmtTime(data.generatedAt) : '—' }}</span>
    </div>

    <ErrorState v-if="error && !data" :message="error" @retry="load(false)" />

    <div v-if="!data && loading" class="grid grid-2">
      <div v-for="i in 4" :key="i" class="card" style="height: 160px; padding: 16px">
        <div class="skeleton" style="width: 45%; height: 12px" />
        <div class="skeleton" style="width: 70%; height: 22px; margin-top: 14px" />
        <div class="skeleton" style="width: 90%; height: 12px; margin-top: 14px" />
      </div>
    </div>

    <template v-else-if="data">
      <div v-if="error" class="error-banner">
        <span class="grow">刷新失败：{{ error }}（显示上次数据）</span>
        <button class="btn btn-sm" @click="load(false)">重试</button>
      </div>

      <!-- 状态 + 音色 -->
      <div class="grid grid-2">
        <SectionCard title="当前状态">
          <div class="status-grid">
            <button class="switch" :class="{ on: form.enabled }" role="switch" :aria-checked="form.enabled" @click="form.enabled = !form.enabled">
              <span class="knob" />
            </button>
            <div class="grow">
              <div class="status-line">Breeze TTS {{ form.enabled ? '启用' : '关闭' }}</div>
              <div class="tiny faint">{{ form.enabled ? '失败时自动回落本机 SAPI（桥接逻辑）' : '关闭后 qq_tts_say 直接用本机 SAPI' }}</div>
            </div>
          </div>
          <dl class="kv voice-kv mt-3">
            <dt>当前音色</dt><dd>{{ currentVoiceName }}</dd>
            <dt>音色 ID</dt><dd class="mono">{{ form.voiceId || '—' }}</dd>
            <dt>API Key</dt>
            <dd><span class="pill" :class="keyConfigured ? 'ok' : 'bad'">{{ keyConfigured ? '已配置（不显示内容）' : '未配置' }}</span></dd>
            <dt>账户余额</dt>
            <dd>
              <b class="num">{{ balance.credits != null ? fmtNum(balance.credits, 1) + ' credits' : '—' }}</b>
              <span v-if="balance.error" class="tiny warn-text"> · {{ balance.error }}</span>
            </dd>
          </dl>
          <div class="tiny faint mt-2">1 credit ≈ 10 计费字符；中文每字算 2 字符。余额实时取自 Breeze，缓存 60 秒。</div>
        </SectionCard>

        <SectionCard title="音色与试听">
          <label class="field">
            <span class="lbl">音色（{{ voices.length }} 个可选）</span>
            <select v-model="form.voiceId" class="select">
              <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.name }}</option>
            </select>
            <span v-if="data.voicesError" class="tiny warn-text">{{ data.voicesError }}（显示内置音色）</span>
          </label>

          <label class="field mt-3">
            <span class="lbl">试听文本 <span class="faint">（{{ testChars }}/30 字）</span></span>
            <input v-model="testText" class="input" maxlength="30" placeholder="≤30 字，默认「测试一下，这是新音色的声音。」" />
          </label>

          <div class="row mt-3" style="gap: 8px">
            <button class="btn btn-primary" :disabled="testing || !keyConfigured" @click="testVoice">
              <span v-if="testing" class="spinner" /><Icon v-else name="play" :size="13" />{{ testing ? '生成中…' : '试听' }}
            </button>
            <span class="tiny faint">每 30 秒最多 1 次；试听会消耗 credits</span>
          </div>

          <div v-if="testError" class="error-banner mt-3">{{ testError }}</div>
          <audio v-if="audioSrc" :src="audioSrc" controls autoplay class="audio mt-3" />

          <div class="tiny faint mt-3">音色列表来自 Breeze（缓存 10 分钟）；音色名/描述仅用于展示。</div>
        </SectionCard>
      </div>

      <!-- 参数 -->
      <SectionCard title="参数设置">
        <template #actions>
          <span v-if="dirty" class="tiny warn-text">有未保存修改</span>
          <button class="btn btn-primary" :disabled="saving" @click="save">
            <span v-if="saving" class="spinner" />{{ saving ? '保存中…' : '保存设置' }}
          </button>
        </template>

        <div class="param-grid">
          <label class="field">
            <span class="lbl">语速 <b class="num">{{ Number(form.speed).toFixed(2) }}</b></span>
            <input v-model.number="form.speed" type="range" min="0.5" max="2" step="0.05" class="range" />
            <span class="tiny faint">0.5（慢）~ 2（快）</span>
          </label>
          <label class="field">
            <span class="lbl">音量 <b class="num">{{ Number(form.volume).toFixed(2) }}</b></span>
            <input v-model.number="form.volume" type="range" min="0.01" max="2" step="0.01" class="range" />
            <span class="tiny faint">0.01 ~ 2</span>
          </label>
          <label class="field">
            <span class="lbl">每日额度（credits）</span>
            <input v-model.number="form.dailyCreditLimit" type="number" min="1" max="2000" step="1" class="input" />
            <span class="tiny faint">1 ~ 2000，超出后当日不再走 Breeze</span>
          </label>
        </div>

        <label class="field mt-3">
          <span class="lbl">语气指令 <span class="faint">（{{ [...(form.instructions || '')].length }}/200 字）</span></span>
          <textarea v-model="form.instructions" class="input instr" maxlength="200" rows="3" placeholder="例如：语气轻一点，尾音自然，不要读得太快" />
        </label>
        <div class="tiny faint mt-2">保存会写入 qq-bridge/config.json 的 socialV2.voice.breeze（写前备份 config.json.bak），桥接下一条语音生效。</div>
      </SectionCard>

      <!-- 今日用量 -->
      <SectionCard title="今日用量" dense>
        <div class="usage-grid">
          <div class="u-item"><span class="u-label">计费字符</span><b class="num">{{ fmtNum(usage.chars) }}</b></div>
          <div class="u-item"><span class="u-label">Credits</span><b class="num">{{ fmtNum(usage.credits) }}</b></div>
          <div class="u-item"><span class="u-label">成功 / 失败</span><b class="num">{{ fmtNum(usage.calls) }} / {{ fmtNum(usage.failed) }}</b></div>
          <div class="u-item"><span class="u-label">Provider</span><b>{{ usage.provider || '—' }}</b></div>
          <div class="u-item"><span class="u-label">最近一次</span><b class="num">{{ usage.lastAtLocal || '—' }}</b></div>
        </div>
        <div class="quota">
          <div class="quota-bar"><i :class="quotaTone" :style="{ width: Math.round(quotaPct * 100) + '%' }" /></div>
          <span class="tiny faint num">{{ usage.credits }} / {{ quotaDen }} credits（{{ Math.round(quotaPct * 100) }}%）</span>
        </div>
        <div class="tiny faint mt-2">用量来自 qq-bridge/state/tts-usage.json（北京时间自然日，跨天归零）</div>
      </SectionCard>

      <!-- 近 7 天折线图 -->
      <SectionCard title="近 7 天语音用量" dense>
        <div class="chart-legend">
          <span class="lg"><i class="sw" style="background: var(--chart-1)" />请求数</span>
          <span class="lg"><i class="sw" style="background: var(--chart-2)" />消耗积分</span>
          <span class="grow" />
          <span class="tiny faint">悬浮查看当天数值</span>
        </div>
        <LineChart :labels="chartLabels" :series="chartSeries" :height="200" format="number" />
        <div v-if="!history7.some((d) => d.calls || d.credits)" class="tiny faint mt-2">近 7 天还没有语音用量；有调用后 tts-history.jsonl 会自动记录。</div>
      </SectionCard>

      <!-- 最近调用 -->
      <SectionCard title="最近调用" dense>
        <div v-if="recent.length" class="table-wrap">
          <table class="data-table">
            <thead>
              <tr><th style="width: 170px">时间</th><th style="width: 110px">Provider</th><th style="width: 110px" class="align-right">字符</th><th style="width: 100px" class="align-right">Credits</th><th style="width: 90px">结果</th><th>会话</th></tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in recent" :key="i">
                <td class="cell-time">{{ fmtTime(r.at) }}</td>
                <td>{{ r.provider || '—' }}</td>
                <td class="align-right num">{{ fmtNum(r.chars) }}</td>
                <td class="align-right num">{{ fmtNum(r.credits) }}</td>
                <td><span class="pill" :class="r.ok ? 'ok' : 'bad'">{{ r.ok ? '成功' : '失败' }}</span></td>
                <td class="mono tiny">{{ r.key || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <EmptyState v-else text="还没有语音调用记录" hint="等她用过 qq_tts_say，或这里点一次试听后，历史记录会出现在 tts-history.jsonl" icon="voice" />
      </SectionCard>

      <!-- 人设音色覆盖 -->
      <SectionCard title="人设音色覆盖" subtitle="留空表示跟随全局；保存写入 personas/<人设>/meta.json，桥接下一条语音生效">
        <div v-if="!personas.length" class="row"><EmptyState text="还没有人设" hint="qq-bridge/personas 为空" icon="persona" /></div>
        <div v-else class="persona-list">
          <div v-for="p in personas" :key="p.role" class="persona-row">
            <div class="p-info">
              <div class="p-name truncate" :title="p.role">{{ p.displayName || p.role }}</div>
              <div class="tiny faint">{{ p.role }}</div>
            </div>
            <select v-model="personaForm[p.role].voiceId" class="select p-select">
              <option value="">跟随全局（{{ currentVoiceName }}）</option>
              <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.name }}</option>
            </select>
            <input v-model="personaForm[p.role].instructions" class="input p-instr" maxlength="200" placeholder="语气指令（留空跟随全局）" />
            <input v-model="personaForm[p.role].speed" class="input p-speed" type="number" min="0.5" max="2" step="0.05" placeholder="语速" />
            <div class="row" style="gap: 4px">
              <button class="btn btn-sm" :disabled="Boolean(personaBusy[p.role])" @click="resetPersona(p)">清空</button>
              <button class="btn btn-sm btn-primary" :disabled="Boolean(personaBusy[p.role])" @click="savePersona(p)">
                <span v-if="personaBusy[p.role]" class="spinner" />{{ personaBusy[p.role] ? '保存中…' : '保存' }}
              </button>
            </div>
          </div>
        </div>
      </SectionCard>
    </template>
  </div>
</template>

<style scoped>
.status-grid { display: flex; align-items: center; gap: 12px; }
.switch {
  position: relative;
  width: 44px;
  height: 24px;
  flex: 0 0 auto;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.switch .knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--muted);
  transition: transform var(--dur) var(--ease), background var(--dur-fast) var(--ease);
}
.switch.on { background: var(--accent-soft); border-color: var(--accent); }
.switch.on .knob { transform: translateX(20px); background: var(--accent); }
.status-line { font-size: var(--fs-14); font-weight: 650; color: var(--text); }
.voice-kv { grid-template-columns: 86px minmax(0, 1fr); }
.warn-text { color: var(--warn); }
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.field .lbl { font-size: var(--fs-11); color: var(--faint); }
.range { width: 100%; accent-color: var(--accent); }
.instr { height: auto; padding: 8px 10px; line-height: 1.7; resize: vertical; }
.audio { width: 100%; height: 38px; }
.param-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-4); }
@media (max-width: 960px) { .param-grid { grid-template-columns: minmax(0, 1fr); } }
.usage-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--sp-3); padding: 4px 2px 12px; }
@media (max-width: 960px) { .usage-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.u-item { display: flex; flex-direction: column; gap: 3px; }
.u-label { font-size: var(--fs-11); color: var(--muted); }
.u-item b { font-size: var(--fs-16); font-weight: 650; color: var(--text); }
.quota { display: flex; align-items: center; gap: 12px; padding: 0 2px; }
.quota-bar { flex: 1 1 auto; height: 8px; border-radius: var(--radius-pill); background: var(--surface-2); border: 1px solid var(--border); overflow: hidden; }
.quota-bar i { display: block; height: 100%; border-radius: var(--radius-pill); background: var(--accent); transition: width var(--dur) var(--ease); }
.quota-bar i.warn { background: var(--warn); }
.quota-bar i.danger { background: var(--danger); }

.chart-legend { display: flex; align-items: center; gap: 14px; padding: 2px 2px 6px; }
.lg { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-11); color: var(--muted); }
.sw { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.sw.chars { background: var(--chart-1); }
.sw.credits { background: var(--chart-3); }
.chart-box { position: relative; height: 210px; }
.chart-box svg { width: 100%; height: 100%; display: block; }
.grid { stroke: var(--chart-grid); stroke-width: 1; stroke-dasharray: 3 4; }
.tick { fill: var(--chart-axis); font-size: 9.5px; font-family: var(--font-mono); }
.hit { fill: transparent; }
.bar-chars { fill: var(--chart-1); opacity: 0.85; transition: opacity var(--dur-fast) var(--ease); }
.bar-credits { fill: var(--chart-3); opacity: 0.85; transition: opacity var(--dur-fast) var(--ease); }
.bar-chars.dim, .bar-credits.dim { opacity: 0.35; }
.chart-tip {
  position: absolute;
  top: 4px;
  transform: translateX(-50%);
  min-width: 132px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  box-shadow: var(--shadow-2);
  pointer-events: none;
  z-index: 3;
}
.tip-day { font-size: 10.5px; color: var(--muted); margin-bottom: 4px; }
.tip-row { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-2); }
.tip-row b { margin-left: auto; color: var(--text); }
.persona-list { display: flex; flex-direction: column; gap: 8px; }
.persona-row {
  display: grid;
  grid-template-columns: 180px 220px minmax(0, 1fr) 92px auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
@media (max-width: 1120px) { .persona-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
.p-info { min-width: 0; }
.p-name { font-size: var(--fs-12); font-weight: 600; color: var(--text); }
.p-select, .p-instr, .p-speed { height: 30px; font-size: var(--fs-11); }
</style>
