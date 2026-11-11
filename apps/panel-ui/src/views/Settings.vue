<script setup>
import { onMounted, reactive, ref } from 'vue';
import SectionCard from '../components/SectionCard.vue';
import EmptyState from '../components/EmptyState.vue';
import { api } from '../api/client.js';
import { toast } from '../composables/useToast.js';

const loading = ref(true);
const saving = ref(false);
const data = ref(null);
const form = reactive({ bridge: {}, qzone: {} });
const mins = reactive({ proactiveMin: 20, proactiveMax: 40, biliMin: 180, biliMax: 360, freeMin: 60, freeMax: 120, surfMin: 120, surfMax: 240, postMin: 480, postMax: 960 });

function loadFrom(d) {
  const b = d.bridge || {};
  const q = d.qzone || {};
  form.bridge = {
    proactiveEnabled: b['socialV2.proactive.enabled'] !== false,
    probability: Number(b['socialV2.proactive.probability'] ?? 0.5),
    weekdayProbability: Number(b['socialV2.proactive.weekdayProbability'] ?? 0.05),
    weekendProbability: Number(b['socialV2.proactive.weekendProbability'] ?? 0.3),
    holidayProbability: Number(b['socialV2.proactive.holidayProbability'] ?? 0.45),
    nonOwnerPrivateMultiplier: Number(b['socialV2.proactive.nonOwnerPrivateMultiplier'] ?? 0.15),
    idleThresholdMin: Math.round(Number(b['socialV2.proactive.idleThresholdMs'] ?? 900000) / 60000),
    biliEnabled: b['socialV2.biliSchedule.enabled'] !== false,
    biliTarget: b['socialV2.biliSchedule.targetKey'] || '',
    biliHourStart: Number(b['socialV2.biliSchedule.activeHourStart'] ?? 9),
    biliHourEnd: Number(b['socialV2.biliSchedule.activeHourEnd'] ?? 22),
    freeEnabled: b['socialV2.freeTime.enabled'] !== false,
    freeProbability: Number(b['socialV2.freeTime.probability'] ?? 0.35),
    freeTarget: b['socialV2.freeTime.targetKey'] || '',
    freeHourStart: Number(b['socialV2.freeTime.activeHourStart'] ?? 9),
    freeHourEnd: Number(b['socialV2.freeTime.activeHourEnd'] ?? 23),
    surfEnabled: b['socialV2.webSurf.enabled'] === true,
    surfTarget: b['socialV2.webSurf.targetKey'] || '',
    surfHourStart: Number(b['socialV2.webSurf.activeHourStart'] ?? 10),
    surfHourEnd: Number(b['socialV2.webSurf.activeHourEnd'] ?? 23),
    sleepEnabled: b['socialV2.sleepCheck.enabled'] !== false,
    sleepTimes: (b['socialV2.sleepCheck.times'] || []).join(', '),
    sleepTarget: b['socialV2.sleepCheck.targetKey'] || '',
    burstEnabled: b['socialV2.send.burstEnabled'] !== false,
    burstMaxMessages: Number(b['socialV2.send.burstMaxMessages'] ?? 8),
    maxSendPerMinute: Number(b['socialV2.send.maxSendPerMinute'] ?? 8),
    maxSendPerHour: Number(b['socialV2.send.maxSendPerHour'] ?? 60),
    maxMessageChars: Number(b['socialV2.send.maxMessageChars'] ?? 500),
    stickerEnabled: b['socialV2.sticker.enabled'] !== false,
    promptMaxStickers: Number(b['socialV2.sticker.promptMaxStickers'] ?? 8),
    maxListCount: Number(b['socialV2.sticker.maxListCount'] ?? 400),
    friendAutoAccept: b['socialV2.friendAutoAccept'] !== false,
    agentMaxTurns: Number(b['socialV2.agentMaxTurnsPerSession'] ?? 80)
  };
  mins.proactiveMin = Math.round(Number(b['socialV2.proactive.checkIntervalMinMs'] ?? 1200000) / 60000);
  mins.proactiveMax = Math.round(Number(b['socialV2.proactive.checkIntervalMaxMs'] ?? 2400000) / 60000);
  mins.biliMin = Math.round(Number(b['socialV2.biliSchedule.intervalMinMs'] ?? 10800000) / 60000);
  mins.biliMax = Math.round(Number(b['socialV2.biliSchedule.intervalMaxMs'] ?? 21600000) / 60000);
  mins.freeMin = Math.round(Number(b['socialV2.freeTime.intervalMinMs'] ?? 3600000) / 60000);
  mins.freeMax = Math.round(Number(b['socialV2.freeTime.intervalMaxMs'] ?? 7200000) / 60000);
  mins.surfMin = Math.round(Number(b['socialV2.webSurf.intervalMinMs'] ?? 7200000) / 60000);
  mins.surfMax = Math.round(Number(b['socialV2.webSurf.intervalMaxMs'] ?? 14400000) / 60000);
  form.qzone = {
    enabled: q.enabled !== false,
    hourStart: Number(q.activeHourStart ?? 8),
    hourEnd: Number(q.activeHourEnd ?? 23),
    maxPostsPerDay: Number(q.maxPostsPerDay ?? 1),
    maxRepliesPerDay: Number(q.maxRepliesPerDay ?? 20),
    imageChance: Number(q.imageChance ?? 0),
    requireImage: q.requireImage === true,
    ugcRight: Number(q.ugcRight ?? 4),
    likeEnabled: q.likeEnabled !== false,
    likeChance: Number(q.likeChance ?? 0.35),
    maxLikesPerDay: Number(q.maxLikesPerDay ?? 5)
  };
  mins.postMin = Math.round(Number(q.postGapMinMs ?? 28800000) / 60000);
  mins.postMax = Math.round(Number(q.postGapMaxMs ?? 57600000) / 60000);
}

async function load() {
  loading.value = true;
  try {
    const d = await api.settingsGet();
    data.value = d;
    loadFrom(d);
  } catch (e) {
    toast('读取配置失败：' + (e?.message || e), 'bad');
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    const bridge = {
      'socialV2.proactive.enabled': form.bridge.proactiveEnabled,
      'socialV2.proactive.probability': form.bridge.probability,
      'socialV2.proactive.weekdayProbability': form.bridge.weekdayProbability,
      'socialV2.proactive.weekendProbability': form.bridge.weekendProbability,
      'socialV2.proactive.holidayProbability': form.bridge.holidayProbability,
      'socialV2.proactive.nonOwnerPrivateMultiplier': form.bridge.nonOwnerPrivateMultiplier,
      'socialV2.proactive.idleThresholdMs': form.bridge.idleThresholdMin * 60000,
      'socialV2.proactive.checkIntervalMinMs': mins.proactiveMin * 60000,
      'socialV2.proactive.checkIntervalMaxMs': mins.proactiveMax * 60000,
      'socialV2.biliSchedule.enabled': form.bridge.biliEnabled,
      'socialV2.biliSchedule.intervalMinMs': mins.biliMin * 60000,
      'socialV2.biliSchedule.intervalMaxMs': mins.biliMax * 60000,
      'socialV2.biliSchedule.activeHourStart': form.bridge.biliHourStart,
      'socialV2.biliSchedule.activeHourEnd': form.bridge.biliHourEnd,
      'socialV2.biliSchedule.targetKey': form.bridge.biliTarget,
      'socialV2.freeTime.enabled': form.bridge.freeEnabled,
      'socialV2.freeTime.probability': form.bridge.freeProbability,
      'socialV2.freeTime.intervalMinMs': mins.freeMin * 60000,
      'socialV2.freeTime.intervalMaxMs': mins.freeMax * 60000,
      'socialV2.freeTime.activeHourStart': form.bridge.freeHourStart,
      'socialV2.freeTime.activeHourEnd': form.bridge.freeHourEnd,
      'socialV2.freeTime.targetKey': form.bridge.freeTarget,
      'socialV2.webSurf.enabled': form.bridge.surfEnabled,
      'socialV2.webSurf.intervalMinMs': mins.surfMin * 60000,
      'socialV2.webSurf.intervalMaxMs': mins.surfMax * 60000,
      'socialV2.webSurf.activeHourStart': form.bridge.surfHourStart,
      'socialV2.webSurf.activeHourEnd': form.bridge.surfHourEnd,
      'socialV2.sleepCheck.enabled': form.bridge.sleepEnabled,
      'socialV2.sleepCheck.times': form.bridge.sleepTimes,
      'socialV2.sleepCheck.targetKey': form.bridge.sleepTarget,
      'socialV2.send.burstEnabled': form.bridge.burstEnabled,
      'socialV2.send.burstMaxMessages': form.bridge.burstMaxMessages,
      'socialV2.send.maxSendPerMinute': form.bridge.maxSendPerMinute,
      'socialV2.send.maxSendPerHour': form.bridge.maxSendPerHour,
      'socialV2.send.maxMessageChars': form.bridge.maxMessageChars,
      'socialV2.sticker.enabled': form.bridge.stickerEnabled,
      'socialV2.sticker.promptMaxStickers': form.bridge.promptMaxStickers,
      'socialV2.sticker.maxListCount': form.bridge.maxListCount,
      'socialV2.friendAutoAccept': form.bridge.friendAutoAccept,
      'socialV2.agentMaxTurnsPerSession': form.bridge.agentMaxTurns
    };
    const qzone = {
      enabled: form.qzone.enabled,
      activeHourStart: form.qzone.hourStart,
      activeHourEnd: form.qzone.hourEnd,
      postGapMinMs: mins.postMin * 60000,
      postGapMaxMs: mins.postMax * 60000,
      maxPostsPerDay: form.qzone.maxPostsPerDay,
      maxRepliesPerDay: form.qzone.maxRepliesPerDay,
      imageChance: form.qzone.imageChance,
      requireImage: form.qzone.requireImage,
      ugcRight: form.qzone.ugcRight,
      likeEnabled: form.qzone.likeEnabled,
      likeChance: form.qzone.likeChance,
      maxLikesPerDay: form.qzone.maxLikesPerDay
    };
    const r = await api.settingsSave({ bridge, qzone });
    const parts = [];
    if (r.bridge) parts.push(r.bridge.ok ? `桥接已重启（${r.bridge.waitedMs ?? '?'}ms）` : `桥接重启失败：${r.bridge.error}`);
    if (r.qzone) parts.push(r.qzone.ok ? 'QZone 已重启' : `QZone 重启失败：${r.qzone.error}`);
    toast('已保存' + (parts.length ? ' · ' + parts.join(' · ') : ''));
    await load();
  } catch (e) {
    toast('保存失败：' + (e?.message || e), 'bad');
  } finally {
    saving.value = false;
  }
}

async function removeConv(c) {
  if (!window.confirm(`删除会话 ${c.key} 的全部桥接状态？\n会同时从白名单移除，并重启桥接。`)) return;
  try {
    const r = await api.conversationRemove(c.key);
    toast(r.bridge?.ok ? `已删除 ${c.key}，桥接已重启` : `已删除 ${c.key}，但桥接重启失败`, r.bridge?.ok ? 'ok' : 'bad');
    await load();
  } catch (e) {
    toast('删除失败：' + (e?.message || e), 'bad');
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div v-if="loading" class="sub">加载中…</div>
    <template v-else-if="data">
      <SectionCard title="主动机会" subtitle="她主动开口的频率（群聊与主人私聊用全局值，非主人私聊额外乘倍率）">
        <div class="grid">
          <label class="field"><span>启用</span><input v-model="form.bridge.proactiveEnabled" type="checkbox" /></label>
          <label class="field"><span>全局概率</span><input v-model.number="form.bridge.probability" type="number" step="0.01" min="0" max="1" /></label>
          <label class="field"><span>工作日</span><input v-model.number="form.bridge.weekdayProbability" type="number" step="0.01" min="0" max="1" /></label>
          <label class="field"><span>周末</span><input v-model.number="form.bridge.weekendProbability" type="number" step="0.01" min="0" max="1" /></label>
          <label class="field"><span>节假日</span><input v-model.number="form.bridge.holidayProbability" type="number" step="0.01" min="0" max="1" /></label>
          <label class="field"><span>非主人私聊倍率</span><input v-model.number="form.bridge.nonOwnerPrivateMultiplier" type="number" step="0.01" min="0" max="1" /></label>
          <label class="field"><span>判定间隔最小（分钟）</span><input v-model.number="mins.proactiveMin" type="number" min="5" /></label>
          <label class="field"><span>判定间隔最大（分钟）</span><input v-model.number="mins.proactiveMax" type="number" min="5" /></label>
          <label class="field"><span>空闲阈值（分钟）</span><input v-model.number="form.bridge.idleThresholdMin" type="number" min="1" /></label>
        </div>
      </SectionCard>

      <SectionCard title="B 站 / 自主时间 / 冲浪" subtitle="目标会话与时间窗口">
        <div class="grid">
          <label class="field"><span>B站启用</span><input v-model="form.bridge.biliEnabled" type="checkbox" /></label>
          <label class="field"><span>B站目标</span><select v-model="form.bridge.biliTarget"><option v-for="t in data.targets" :key="t.key" :value="t.key">{{ t.label }}</option></select></label>
          <label class="field"><span>B站间隔最小（分）</span><input v-model.number="mins.biliMin" type="number" min="10" /></label>
          <label class="field"><span>B站间隔最大（分）</span><input v-model.number="mins.biliMax" type="number" min="10" /></label>
          <label class="field"><span>B站时段</span><div class="row"><input v-model.number="form.bridge.biliHourStart" type="number" min="0" max="23" /><span>~</span><input v-model.number="form.bridge.biliHourEnd" type="number" min="0" max="23" /></div></label>
          <label class="field"><span>自主时间启用</span><input v-model="form.bridge.freeEnabled" type="checkbox" /></label>
          <label class="field"><span>自主时间目标</span><select v-model="form.bridge.freeTarget"><option v-for="t in data.targets" :key="t.key" :value="t.key">{{ t.label }}</option></select></label>
          <label class="field"><span>自主概率</span><input v-model.number="form.bridge.freeProbability" type="number" step="0.01" min="0" max="1" /></label>
          <label class="field"><span>自主间隔（分）</span><div class="row"><input v-model.number="mins.freeMin" type="number" min="5" /><span>~</span><input v-model.number="mins.freeMax" type="number" min="5" /></div></label>
          <label class="field"><span>自主时段</span><div class="row"><input v-model.number="form.bridge.freeHourStart" type="number" min="0" max="23" /><span>~</span><input v-model.number="form.bridge.freeHourEnd" type="number" min="0" max="23" /></div></label>
          <label class="field"><span>冲浪启用</span><input v-model="form.bridge.surfEnabled" type="checkbox" /></label>
          <label class="field"><span>冲浪目标</span><select v-model="form.bridge.surfTarget"><option v-for="t in data.targets" :key="t.key" :value="t.key">{{ t.label }}</option></select></label>
          <label class="field"><span>冲浪间隔（分）</span><div class="row"><input v-model.number="mins.surfMin" type="number" min="10" /><span>~</span><input v-model.number="mins.surfMax" type="number" min="10" /></div></label>
          <label class="field"><span>冲浪时段</span><div class="row"><input v-model.number="form.bridge.surfHourStart" type="number" min="0" max="23" /><span>~</span><input v-model.number="form.bridge.surfHourEnd" type="number" min="0" max="23" /></div></label>
          <label class="field"><span>睡眠检查启用</span><input v-model="form.bridge.sleepEnabled" type="checkbox" /></label>
          <label class="field"><span>睡眠检查时间</span><input v-model="form.bridge.sleepTimes" type="text" placeholder="22:30, 23:30, 00:30" /></label>
        </div>
      </SectionCard>

      <SectionCard title="聊天发送 / 表情" subtitle="分条、限速与表情注入">
        <div class="grid">
          <label class="field"><span>分条发送</span><input v-model="form.bridge.burstEnabled" type="checkbox" /></label>
          <label class="field"><span>单次最多条数</span><input v-model.number="form.bridge.burstMaxMessages" type="number" min="1" max="20" /></label>
          <label class="field"><span>每分钟上限</span><input v-model.number="form.bridge.maxSendPerMinute" type="number" min="1" max="60" /></label>
          <label class="field"><span>每小时上限</span><input v-model.number="form.bridge.maxSendPerHour" type="number" min="1" max="500" /></label>
          <label class="field"><span>单条最多字数</span><input v-model.number="form.bridge.maxMessageChars" type="number" min="50" max="3000" /></label>
          <label class="field"><span>表情启用</span><input v-model="form.bridge.stickerEnabled" type="checkbox" /></label>
          <label class="field"><span>提示词表情数</span><input v-model.number="form.bridge.promptMaxStickers" type="number" min="1" max="30" /></label>
          <label class="field"><span>表情列表上限</span><input v-model.number="form.bridge.maxListCount" type="number" min="10" max="500" /></label>
          <label class="field"><span>自动通过好友申请</span><input v-model="form.bridge.friendAutoAccept" type="checkbox" /></label>
          <label class="field"><span>DSH 会话轮换上限（轮）</span><input v-model.number="form.bridge.agentMaxTurns" type="number" min="10" max="500" /></label>
        </div>
      </SectionCard>

      <SectionCard title="QQ 空间（QZone Bot）" subtitle="发说说 / 回评 / 点赞频率与权限">
        <div class="grid">
          <label class="field"><span>启用</span><input v-model="form.qzone.enabled" type="checkbox" /></label>
          <label class="field"><span>活跃时段</span><div class="row"><input v-model.number="form.qzone.hourStart" type="number" min="0" max="23" /><span>~</span><input v-model.number="form.qzone.hourEnd" type="number" min="0" max="23" /></div></label>
          <label class="field"><span>发帖间隔（分）</span><div class="row"><input v-model.number="mins.postMin" type="number" min="60" /><span>~</span><input v-model.number="mins.postMax" type="number" min="60" /></div></label>
          <label class="field"><span>每天最多说说</span><input v-model.number="form.qzone.maxPostsPerDay" type="number" min="0" max="10" /></label>
          <label class="field"><span>每天最多回评</span><input v-model.number="form.qzone.maxRepliesPerDay" type="number" min="0" max="200" /></label>
          <label class="field"><span>自动配图概率</span><input v-model.number="form.qzone.imageChance" type="number" step="0.05" min="0" max="1" /></label>
          <label class="field"><span>强制配图</span><input v-model="form.qzone.requireImage" type="checkbox" /></label>
          <label class="field"><span>说说权限</span>
            <select v-model.number="form.qzone.ugcRight">
              <option :value="1">公开</option><option :value="4">好友</option><option :value="16">部分好友</option><option :value="64">仅自己</option><option :value="128">黑名单</option>
            </select>
          </label>
          <label class="field"><span>自动点赞</span><input v-model="form.qzone.likeEnabled" type="checkbox" /></label>
          <label class="field"><span>点赞概率</span><input v-model.number="form.qzone.likeChance" type="number" step="0.05" min="0" max="1" /></label>
          <label class="field"><span>每天最多点赞</span><input v-model.number="form.qzone.maxLikesPerDay" type="number" min="0" max="50" /></label>
        </div>
      </SectionCard>

      <div class="savebar">
        <span class="sub">保存会重写配置并重启桥接 / QZone</span>
        <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存全部' }}</button>
      </div>

      <SectionCard title="会话管理" subtitle="删除已退群/不用的会话状态，停止它的定期唤醒与 token 消耗">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>会话</th><th>类型</th><th>人设</th><th>白名单</th><th>话题/待说</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="c in data.conversations" :key="c.key">
                <td class="mono">{{ c.key }}</td>
                <td>{{ c.kind === 'group' ? '群' : '私聊' }}</td>
                <td>{{ c.role || '—' }}</td>
                <td>{{ c.inWhitelist ? '是' : '否' }}</td>
                <td>{{ c.topics }} / {{ c.thoughts }}</td>
                <td><button class="btn btn-sm" @click="removeConv(c)">删除</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <EmptyState v-if="!data.conversations.length" text="没有会话状态" />
      </SectionCard>
    </template>
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px 16px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-12); color: var(--faint); }
.field input[type="number"], .field input[type="text"], .field select {
  padding: 5px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--card2); color: var(--fg);
}
.row { display: flex; align-items: center; gap: 6px; }
.row input { width: 70px; }
/* 开关样式（替代原生 checkbox） */
.field input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 38px;
  height: 22px;
  margin: 3px 0;
  border-radius: 999px;
  border: 1px solid var(--border-strong, var(--border));
  background: var(--card2);
  position: relative;
  cursor: pointer;
  transition: background .18s ease, border-color .18s ease;
}
.field input[type="checkbox"]::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--faint);
  transition: transform .18s ease, background .18s ease;
}
.field input[type="checkbox"]:checked {
  background: color-mix(in srgb, var(--accent, #38bdf8) 28%, var(--card2));
  border-color: var(--accent, #38bdf8);
}
.field input[type="checkbox"]:checked::after {
  transform: translateX(16px);
  background: var(--accent, #38bdf8);
}
.savebar { display: flex; align-items: center; gap: 12px; justify-content: flex-end; margin: 6px 0 16px; }
.table-wrap { overflow: auto; }
</style>
