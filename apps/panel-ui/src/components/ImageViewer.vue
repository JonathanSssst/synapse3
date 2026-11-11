<script setup>
import { watch, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  src: { type: String, default: '' },
  title: { type: String, default: '' },
  caption: { type: String, default: '' }
});
const emit = defineEmits(['close']);

function onKey(ev) { if (ev.key === 'Escape') emit('close'); }
watch(() => props.open, (v) => {
  if (v) document.addEventListener('keydown', onKey);
  else document.removeEventListener('keydown', onKey);
  document.body.style.overflow = v ? 'hidden' : '';
});
onBeforeUnmount(() => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; });
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="open" class="viewer" @click.self="emit('close')">
        <div class="viewer-inner" @click.stop>
          <div class="viewer-bar">
            <div class="truncate grow">{{ title || '图片预览' }}</div>
            <a v-if="src" class="icon-btn" :href="src" target="_blank" rel="noopener" title="新窗口打开"><Icon name="external" :size="16" /></a>
            <button class="icon-btn" title="关闭 (Esc)" @click="emit('close')"><Icon name="close" :size="17" /></button>
          </div>
          <img v-if="src" :src="src" :alt="title" />
          <div v-if="caption" class="viewer-cap">{{ caption }}</div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  z-index: 95;
  background: var(--overlay);
  backdrop-filter: blur(4px);
  display: grid;
  place-items: center;
  padding: 28px;
}
.viewer-inner {
  max-width: min(1100px, 94vw);
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  padding: 12px;
  overflow: hidden;
}
.viewer-bar { display: flex; align-items: center; gap: 8px; font-size: var(--fs-12); color: var(--muted); }
.viewer-inner img { max-width: 100%; max-height: 76vh; object-fit: contain; border-radius: var(--radius-sm); margin: 0 auto; }
.viewer-cap { font-size: var(--fs-12); color: var(--muted); padding: 0 4px 4px; }
.fade-enter-active, .fade-leave-active { transition: opacity var(--dur) var(--ease); }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
