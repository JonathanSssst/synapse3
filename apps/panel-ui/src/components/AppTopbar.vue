<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import Icon from './Icon.vue';
import { ui, setAuto, manualRefresh } from '../composables/useRefresh.js';
import { theme, toggleTheme } from '../composables/useTheme.js';
import { api, fmtClock } from '../api/client.js';
import { toast } from '../composables/useToast.js';

const route = useRoute();
const title = computed(() => route.meta?.title || '面板');
const group = computed(() => route.meta?.group || '');
const lastClock = computed(() => (ui.lastRefresh ? fmtClock(ui.lastRefresh) : '—'));
const connected = computed(() => Boolean(ui.health && ui.health.ok));

const master = ref({ stopped: false, bridge: { running: false }, qzone: { running: false } });
const masterBusy = ref(false);
const restartingDsh = ref(false);
const reconnectingDsh = ref(false);
const reconnectPhase = ref('');

async function onRestartDsh() {
  if (restartingDsh.value) return;
  const ok = window.confirm('重启 DSH？\n\n- 当前对话会中断\n- DSH 窗口会关闭并重新打开\n- 面板本身不受影响\n\n确定继续吗？');
  if (!ok) return;
  restartingDsh.value = true;
  try {
    const d = await api.restartDsh();
    if (d?.accepted) {
      window.alert('已请求重启 DSH。\n约 20~40 秒后请查看新弹出的 DSH 窗口（这个旧页面会断开）。\n桥接会自动切到新端口。');
    } else {
      window.alert(d?.error || '重启请求没有受理（可能正在重启中）');
    }
  } catch (e) {
    window.alert('重启 DSH 请求失败：' + (e?.message || e) + '\n（如果页面随即断开，说明已经在重启）');
  } finally {
    restartingDsh.value = false;
  }
}
async function onReconnectDsh() {
  if (reconnectingDsh.value) return;
  const ok = window.confirm('重新接入 DSH 端口？\n\n- 不会重启 DSH，当前对话不会中断\n- 只重新发现 DSH 端口，并重启桥接让它连上新端口\n- 约 10~40 秒完成，期间 QQ 消息会短暂排队\n\n确定继续吗？');
  if (!ok) return;
  reconnectingDsh.value = true;
  reconnectPhase.value = '正在重新发现端口…';
  try {
    const d = await api.reconnectDsh();
    if (!d?.accepted) {
      window.alert(d?.error || '请求没有受理（可能正在接入中）');
      return;
    }
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 2500));
      let st = null;
      try { st = await api.reconnectDshStatus(); } catch { continue; }
      if (!st || st.status === 'running') {
        reconnectPhase.value = st?.phase === 'restart' || st?.phase === 'wait' ? '正在重启桥接…' : '正在重新发现端口…';
        continue;
      }
      if (st.status === 'done') {
        reconnectPhase.value = '';
        toast('已重新接入 DSH：' + (st.baseUrl || '端口已更新'), 'ok');
        window.alert('已重新接入 DSH。\n\n端口：' + (st.baseUrl || '未知') + '\n桥接已就绪，QQ 消息会继续处理。');
      } else {
        window.alert('桥接已重启，但 DSH 仍未就绪。\n\n' + (st.error || '请确认 DSH 窗口仍在运行，然后再试一次。'));
      }
      return;
    }
    window.alert('等待超时：桥接已重启，但还没确认 DSH 就绪。\n请稍后打开面板刷新状态，或再点一次。');
  } catch (e) {
    window.alert('重新接入 DSH 请求失败：' + (e?.message || e));
  } finally {
    reconnectingDsh.value = false;
    reconnectPhase.value = '';
  }
}

const masterRunning = computed(() => Boolean(master.value.bridge?.running || master.value.qzone?.running));

async function loadMaster() {
  try { master.value = await api.masterGet(); } catch {}
}
async function onMaster() {
  if (masterBusy.value) return;
  const stop = masterRunning.value;
  const tip = stop
    ? '确定临时停止桥接、QZone 和 SnowLuma 吗？\n停止期间她不会回复消息、不会发空间，#sl 命令也不会再响应；面板不断。'
    : '确定恢复桥接、QZone 和 SnowLuma 吗？';
  if (!window.confirm(tip)) return;
  masterBusy.value = true;
  try {
    const d = await api.masterSet(stop ? 'stop' : 'start');
    master.value = d.status || master.value;
    toast(stop ? '总开关：已停止（桥接 / QZone）' : '总开关：已恢复', stop ? 'bad' : 'ok');
  } catch (e) {
    toast('总开关操作失败：' + (e?.message || e), 'bad');
  } finally {
    masterBusy.value = false;
  }
}
onMounted(loadMaster);

function onAuto(ev) {
  const v = Number(ev.target.value);
  setAuto(v);
  toast(v > 0 ? `自动刷新：每 ${v} 秒` : '自动刷新已关闭');
}
function onRefresh() {
  manualRefresh();
  toast('已刷新');
}
</script>

<template>
  <header class="topbar">
    <button class="icon-btn menu-btn" title="目录" @click="ui.mobileOpen = true">
      <Icon name="audit" :size="17" />
    </button>
    <div class="titles">
      <div class="eyebrow">{{ group }}</div>
      <h1 class="page-title truncate">{{ title }}</h1>
    </div>
    <div class="spacer" />
    <button class="btn dsh-btn reconnect-btn" :disabled="reconnectingDsh" title="只重新发现 DSH 端口并重启桥接，不重启 DSH" @click="onReconnectDsh">
      <Icon name="refresh" :size="14" />{{ reconnectingDsh ? (reconnectPhase || '接入中…') : '重新接入 DSH' }}
    </button>
    <button class="btn dsh-btn" :disabled="restartingDsh" title="重启本机 DSH（对话会中断，面板不受影响）" @click="onRestartDsh">
      <Icon name="refresh" :size="14" />{{ restartingDsh ? '重启中…' : '重启 DSH' }}
    </button>
    <button
      class="btn master-btn"
      :class="masterRunning ? 'on' : 'off'"
      :disabled="masterBusy"
      :title="masterRunning ? '点击临时停止桥接 / QZone / SnowLuma（面板不停，她的 QQ 会离线）' : '点击恢复桥接 / QZone / SnowLuma'"
      @click="onMaster"
    >
      <span class="master-dot" />
      {{ masterBusy ? '处理中…' : (masterRunning ? '总开关·运行中' : '总开关·已停止') }}
    </button>
    <div class="conn" :title="connected ? '后端 127.0.0.1:3120 正常' : '后端连接异常'">
      <span class="conn-dot" :class="connected ? 'on' : 'off'" />
      <span class="conn-text">{{ connected ? '已连接' : '异常' }}</span>
    </div>
    <div class="updated" title="最近一次数据刷新时间">
      <Icon name="clock" :size="13" />
      <span class="num">{{ lastClock }}</span>
    </div>
    <label class="auto">
      <span class="label">自动</span>
      <select class="select" :value="ui.auto" @change="onAuto">
        <option :value="0">关</option>
        <option :value="5">5 秒</option>
        <option :value="15">15 秒</option>
        <option :value="60">60 秒</option>
      </select>
    </label>
    <button class="icon-btn" :title="theme === 'dark' ? '切换浅色' : '切换深色'" @click="toggleTheme">
      <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="17" />
    </button>
    <button class="btn" title="立即刷新（R）" @click="onRefresh">
      <Icon name="refresh" :size="15" />刷新
    </button>
  </header>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--topbar-h);
  padding: 0 20px;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}
.menu-btn { display: none; }
.titles { min-width: 0; display: flex; flex-direction: column; justify-content: center; }
.eyebrow { font-size: 10px; letter-spacing: 0.12em; color: var(--faint); text-transform: uppercase; line-height: 1.3; }
.page-title { font-size: var(--fs-20); font-weight: 650; letter-spacing: -0.02em; line-height: 1.25; }
.spacer { flex: 1 1 auto; }
.conn { display: flex; align-items: center; gap: 6px; font-size: var(--fs-11); color: var(--muted); }
.conn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); }
.conn-dot.on { background: var(--success); box-shadow: 0 0 7px var(--success); }
.updated { display: flex; align-items: center; gap: 5px; font-size: var(--fs-11); color: var(--faint); }
.auto { display: flex; align-items: center; gap: 6px; }
.auto .label { font-size: var(--fs-11); color: var(--faint); }
.auto .select { height: 30px; width: 84px; }
@media (max-width: 900px) {
  .menu-btn { display: inline-flex; }
  .topbar { padding: 0 12px; gap: 8px; }
  .updated, .conn-text, .auto .label { display: none; }
  .auto .select { width: 76px; }
  .page-title { font-size: var(--fs-16); }
}
.master-btn { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.master-btn .master-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok, #3ecf8e); box-shadow: 0 0 8px color-mix(in srgb, var(--ok, #3ecf8e) 70%, transparent); }
.master-btn.off { border-color: color-mix(in srgb, var(--bad, #f05252) 60%, var(--border)); color: var(--bad, #f05252); }
.master-btn.off .master-dot { background: var(--bad, #f05252); box-shadow: 0 0 8px color-mix(in srgb, var(--bad, #f05252) 70%, transparent); }
.reconnect-btn { border-color: color-mix(in srgb, var(--accent, #3ea6ff) 45%, var(--border)); }
.reconnect-btn:disabled { opacity: .7; }
</style>
