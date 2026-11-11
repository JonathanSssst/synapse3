<script setup>
// 通用记录表格：筛选 + 分页 + 排序 + 详情跳转（可覆盖单元格）
import FilterBar from './FilterBar.vue';
import DataTable from './DataTable.vue';
import Pagination from './Pagination.vue';
import { useTable } from '../composables/useTable.js';

const props = defineProps({
  type: { type: String, required: true },
  placeholder: { type: String, default: '搜索关键词…' },
  emptyText: { type: String, default: '暂无记录' },
  emptyHint: { type: String, default: '' },
  clickable: { type: Boolean, default: true },
  showFilter: { type: Boolean, default: true },
  maxHeight: { type: String, default: '' }
});

const { state, loading, error, columns, rows, total, totalPages, sortable, hasRange, load, apply, toggleSort, setPage, setPageSize, quickRange, resetFilters, goDetail } = useTable(props.type);
</script>

<template>
  <div class="stack">
    <FilterBar
      v-if="showFilter"
      :q="state.q"
      :from="state.from"
      :to="state.to"
      :has-range="hasRange"
      :placeholder="placeholder"
      @update:q="(v) => apply({ q: v })"
      @update:from="(v) => apply({ from: v })"
      @update:to="(v) => apply({ to: v })"
      @quick="quickRange"
      @clear="resetFilters"
    >
      <template #actions><slot name="actions" /></template>
    </FilterBar>

    <DataTable
      :style="maxHeight ? { '--table-max-h': maxHeight } : {}"
      :columns="columns"
      :rows="rows"
      :loading="loading"
      :error="error"
      :sort="state.sort"
      :dir="state.dir"
      :sortable="sortable"
      :clickable="clickable"
      :empty-text="emptyText"
      :empty-hint="emptyHint"
      @sort="toggleSort"
      @retry="load(false)"
      @row-click="(row) => goDetail(row.id)"
    >
      <template v-for="(_, name) in $slots" #[name]="slotProps">
        <slot :name="name" v-bind="slotProps || {}" />
      </template>
      <template #footer>
        <Pagination
          :page="state.page"
          :total-pages="totalPages"
          :total="total"
          :page-size="state.pageSize"
          @page="setPage"
          @page-size="setPageSize"
        />
      </template>
    </DataTable>
  </div>
</template>
