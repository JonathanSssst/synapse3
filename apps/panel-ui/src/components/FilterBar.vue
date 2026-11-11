<script setup>
import { ref, watch, computed, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({
  q: { type: String, default: '' },
  from: { type: String, default: '' },
  to: { type: String, default: '' },
  hasRange: { type: Boolean, default: false },
  placeholder: { type: String, default: '搜索关键词…' },
  showSearch: { type: Boolean, default: true }
});
const emit = defineEmits(['update:q', 'update:from', 'update:to', 'quick', 'clear']);

const localQ = ref(props.q || '');
watch(() => props.q, (v) => { if (v !== localQ.value) localQ.value = v || ''; });
let timer = 0;
function onQ(ev) {
  localQ.value = ev.target.value;
  clearTimeout(timer);
  timer = setTimeout(() => emit('update:q', localQ.value.trim()), 320);
}
onBeforeUnmount(() => clearTimeout(timer));

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const ymd = (offset) => new Date(Date.now() - offset * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

const activeQuick = computed(() => {
  const t = today();
  if (props.from === t && props.to === t) return 'today';
  if (props.from === ymd(6) && props.to === t) return '7';
  if (props.from === ymd(29) && props.to === t) return '30';
  if (!props.from && !props.to) return 'all';
  return '';
});
const quicks = [
  { key: 'today', label: '今天' },
  { key: '7', label: '近 7 天' },
  { key: '30', label: '近 30 天' },
  { key: 'all', label: '全部' }
];
const dirty = computed(() => Boolean(props.q || props.hasRange));
</script>

<template>
  <div class="filter-bar card">
    <div class="row wrap grow" style="gap: 8px">
      <label v-if="showSearch" class="search">
        <Icon name="search" :size="15" />
        <input class="input search-input" :value="localQ" :placeholder="placeholder" @input="onQ" />
      </label>
      <div class="date-range">
        <input class="input date" type="date" :value="from" @change="emit('update:from', $event.target.value)" />
        <span class="dash">~</span>
        <input class="input date" type="date" :value="to" @change="emit('update:to', $event.target.value)" />
      </div>
      <div class="quicks">
        <button
          v-for="qq in quicks"
          :key="qq.key"
          class="btn btn-sm"
          :class="activeQuick === qq.key ? 'btn-primary' : ''"
          @click="emit('quick', qq.key)"
        >{{ qq.label }}</button>
      </div>
      <button v-if="dirty" class="btn btn-sm btn-ghost" title="清除搜索与日期筛选" @click="emit('clear')">
        <Icon name="close" :size="13" />清除
      </button>
    </div>
    <div v-if="$slots.actions" class="row"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.filter-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; flex-wrap: wrap; }
.search { display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; height: 32px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--muted); min-width: 200px; }
.search:focus-within { border-color: var(--accent); }
.search-input { height: 28px; border: 0; background: transparent; padding: 0; flex: 1; min-width: 120px; }
.search-input:focus { outline: none; background: transparent; }
.date-range { display: inline-flex; align-items: center; gap: 6px; }
.date { width: 132px; }
.dash { color: var(--faint); }
.quicks { display: inline-flex; gap: 4px; }
</style>
