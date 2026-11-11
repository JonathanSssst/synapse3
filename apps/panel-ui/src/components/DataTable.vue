<script setup>
import CellValue from './CellValue.vue';
import EmptyState from './EmptyState.vue';
import ErrorState from './ErrorState.vue';

const props = defineProps({
  columns: { type: Array, default: () => [] },
  rows: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  sort: { type: String, default: '' },
  dir: { type: String, default: 'desc' },
  sortable: { type: Array, default: () => [] },
  clickable: { type: Boolean, default: false },
  rowKey: { type: [String, Function], default: 'id' },
  emptyText: { type: String, default: '暂无数据' },
  emptyHint: { type: String, default: '' },
  loadingRows: { type: Number, default: 8 }
});
const emit = defineEmits(['sort', 'row-click', 'retry', 'preview']);

function keyOf(row, i) {
  if (typeof props.rowKey === 'function') return props.rowKey(row, i);
  return row[props.rowKey] ?? i;
}
function canSort(col) {
  return props.sortable.length ? props.sortable.includes(col.key) : false;
}
function onSort(col) {
  if (!canSort(col)) return;
  emit('sort', col.key);
}
function onRow(row) {
  if (props.clickable) emit('row-click', row);
}
</script>

<template>
  <div class="table-card card">
    <div v-if="loading && rows.length" class="loading-line" />
    <div v-if="error && rows.length" class="error-banner" style="margin: 12px 12px 0">
      <span class="grow">刷新失败：{{ error }}（显示上次数据）</span>
      <button class="btn btn-sm" @click="emit('retry')">重试</button>
    </div>

    <div v-if="!rows.length && loading" class="skeleton-table">
      <div v-for="r in loadingRows" :key="r" class="skeleton-row">
        <span v-for="c in columns" :key="c.key" class="skeleton" :style="{ flex: c.width ? `0 0 ${c.width}px` : '1 1 0' }" />
      </div>
    </div>

    <ErrorState v-else-if="!rows.length && error" :message="'加载失败：' + error" @retry="emit('retry')" />
    <EmptyState v-else-if="!rows.length" :text="emptyText" :hint="emptyHint">
      <slot name="empty" />
    </EmptyState>

    <div v-else class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th
              v-for="col in columns"
              :key="col.key"
              :style="{ width: col.width ? col.width + 'px' : undefined }"
              :class="[
                canSort(col) ? 'sortable' : '',
                sort === col.key ? 'active' : '',
                col.align === 'right' ? 'align-right' : '',
                col.align === 'center' ? 'align-center' : ''
              ]"
              :title="canSort(col) ? '点击排序' : ''"
              @click="onSort(col)"
            >
              {{ col.label }}<span v-if="canSort(col)" class="sort-mark">{{ sort === col.key ? (dir === 'asc' ? '▲' : '▼') : '↕' }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, i) in rows"
            :key="keyOf(row, i)"
            :class="[clickable ? 'clickable' : '', 'row-anim']"
            :tabindex="clickable ? 0 : undefined"
            @click="onRow(row)"
            @keydown.enter="onRow(row)"
          >
            <td
              v-for="col in columns"
              :key="col.key"
              :class="[
                col.align === 'right' || col.type === 'number' || col.type === 'bytes' || col.type === 'money' ? 'align-right' : '',
                col.type === 'number' || col.type === 'bytes' || col.type === 'money' ? 'cell-number' : '',
                col.type === 'time' ? 'cell-time' : '',
                col.type === 'mono' || col.type === 'json' ? 'cell-mono' : ''
              ]"
              :style="{ width: col.width ? col.width + 'px' : undefined }"
            >
              <slot v-if="$slots['cell-' + col.key]" :name="'cell-' + col.key" :row="row" :value="row[col.key]" :col="col" />
              <CellValue v-else :row="row" :col="col" @preview="(src) => emit('preview', src, col, row)" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <slot name="footer" />
  </div>
</template>

<style scoped>
.table-card { overflow: hidden; }
.loading-line {
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  background-size: 50% 100%;
  animation: slide 1.1s linear infinite;
}
@keyframes slide { from { background-position: -50% 0; } to { background-position: 150% 0; } }
.table-wrap { max-height: var(--table-max-h, 64vh); overflow: auto; }
.skeleton-table { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.skeleton-row { display: flex; gap: 12px; }
.skeleton-row .skeleton { height: 18px; }
</style>
