<script setup>
import { watch, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  wide: { type: Boolean, default: false },
  full: { type: Boolean, default: false },
  closable: { type: Boolean, default: true }
});
const emit = defineEmits(['close']);

function onKey(ev) {
  if (ev.key === 'Escape') emit('close');
}

watch(
  () => props.open,
  (v) => {
    if (v) document.addEventListener('keydown', onKey);
    else document.removeEventListener('keydown', onKey);
    document.body.style.overflow = v ? 'hidden' : '';
  }
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <Transition name="overlay">
      <div v-if="open" class="overlay" @click.self="closable && emit('close')">
        <div class="dialog" :class="{ wide, full }" role="dialog" aria-modal="true">
          <header class="dialog-head">
            <div class="dialog-title truncate">{{ title }}</div>
            <div class="row">
              <slot name="actions" />
              <button v-if="closable" class="icon-btn" title="关闭 (Esc)" @click="emit('close')">
                <Icon name="close" :size="16" />
              </button>
            </div>
          </header>
          <div class="dialog-body"><slot /></div>
          <footer v-if="$slots.footer" class="dialog-foot"><slot name="footer" /></footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay-enter-active, .overlay-leave-active { transition: opacity var(--dur) var(--ease); }
.overlay-enter-from, .overlay-leave-to { opacity: 0; }
</style>
