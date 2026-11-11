<script setup>
import { ref, computed } from 'vue';
import RecordTable from '../components/RecordTable.vue';
import SectionCard from '../components/SectionCard.vue';
import Icon from '../components/Icon.vue';
import { api } from '../api/client.js';

const sub = ref('tool');
const TABS = [
  { key: 'tool', label: '工具调用', type: 'tool_call', hint: 'DSH 每次工具调用的参数、结果与错误' },
  { key: 'event', label: '审计事件', type: 'audit_event', hint: '桥接侧记录的空间 / 聊天审计动作' },
  { key: 'activity', label: '聊天活动', type: 'activity', hint: '入站消息与回复的原文' }
];
const active = computed(() => TABS.find((t) => t.key === sub.value) || TABS[0]);
</script>

<template>
  <div class="page">
    <div class="row wrap" style="justify-content: space-between">
      <div class="seg">
        <button v-for="t in TABS" :key="t.key" class="seg-btn" :class="{ on: sub === t.key }" @click="sub = t.key">{{ t.label }}</button>
      </div>
      <div class="row">
        <a class="btn" :href="api.exportUrl('tools')" download><Icon name="download" :size="14" />工具 CSV</a>
        <a class="btn" :href="api.exportUrl('audit')" download><Icon name="download" :size="14" />审计 CSV</a>
        <a class="btn" :href="api.exportUrl('activity')" download><Icon name="download" :size="14" />活动 CSV</a>
      </div>
    </div>

    <p class="small faint" style="margin-top: -6px">{{ active.hint }} · 点击行进入详情</p>

    <RecordTable
      :key="active.type"
      :type="active.type"
      :placeholder="active.type === 'tool_call' ? '搜索工具名 / 错误 / 会话…' : '搜索内容…'"
      empty-text="没有匹配的记录"
    />
  </div>
</template>

<style scoped>
.seg { display: inline-flex; gap: 2px; background: var(--surface-2); padding: 3px; border-radius: var(--radius-sm); border: 1px solid var(--border); }
.seg-btn { height: 28px; padding: 0 14px; border-radius: var(--radius-xs); color: var(--muted); font-size: var(--fs-12); }
.seg-btn:hover { color: var(--text); }
.seg-btn.on { background: var(--surface); color: var(--accent); box-shadow: var(--shadow-1); font-weight: 600; }
</style>
