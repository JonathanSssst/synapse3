<script setup>
import Icon from './Icon.vue';

defineProps({
  text: { type: String, default: '暂无数据' },
  hint: { type: String, default: '' },
  icon: { type: String, default: 'box' }
});
</script>

<template>
  <div class="empty-state">
    <div class="glyph"><Icon :name="icon" :size="20" /></div>
    <div class="title">{{ text }}</div>
    <div v-if="hint" class="small faint">{{ hint }}</div>
    <div v-if="$slots.default" class="mt-2"><slot /></div>
  </div>
</template>
