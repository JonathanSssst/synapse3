<script setup>
import { computed } from 'vue';

const props = defineProps({
  ok: { type: [Boolean, null], default: null },
  label: { type: String, default: '' },
  tone: { type: String, default: '' }
});
const cls = computed(() => (props.tone ? props.tone : props.ok === true ? 'ok' : props.ok === false ? 'bad' : 'plain'));
const text = computed(() => props.label || (props.ok === true ? '成功' : props.ok === false ? '失败' : '—'));
</script>

<template>
  <span class="pill" :class="cls">{{ text }}</span>
</template>
