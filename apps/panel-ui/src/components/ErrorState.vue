<script setup>
import Icon from './Icon.vue';

defineProps({
  message: { type: String, default: '加载失败' },
  retryText: { type: String, default: '重试' }
});
defineEmits(['retry']);
</script>

<template>
  <div class="error-state">
    <div class="glyph"><Icon name="warning" :size="20" /></div>
    <div class="title">{{ message }}</div>
    <div class="small faint">检查后端是否在 127.0.0.1:3120 运行，或稍后再试</div>
    <button class="btn btn-sm mt-2" @click="$emit('retry')">{{ retryText }}</button>
  </div>
</template>

<style scoped>
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 40px 20px;
  text-align: center;
  color: var(--danger);
}
.error-state .glyph {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--danger-soft);
  color: var(--danger);
}
.error-state .title { font-size: var(--fs-13); font-weight: 600; color: var(--danger); }
</style>
