// 列表页状态：URL query 是唯一来源（page/pageSize/q/from/to/sort/dir）
import { reactive, ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client.js';
import { refreshTick, touchRefresh } from './useRefresh.js';

const DEFAULTS = { page: 1, pageSize: 25, q: '', from: '', to: '', sort: '', dir: 'desc' };
const dateOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

function fromQuery(query) {
  const q = query || {};
  const pageSize = Number(q.pageSize);
  return {
    page: Math.max(1, Number(q.page) || 1),
    pageSize: Number.isFinite(pageSize) && pageSize >= 5 && pageSize <= 200 ? pageSize : DEFAULTS.pageSize,
    q: String(q.q || ''),
    from: dateOk(q.from) ? String(q.from) : '',
    to: dateOk(q.to) ? String(q.to) : '',
    sort: String(q.sort || ''),
    dir: q.dir === 'asc' ? 'asc' : 'desc'
  };
}
function toQuery(s) {
  const out = {};
  if (s.page > 1) out.page = String(s.page);
  if (s.pageSize !== DEFAULTS.pageSize) out.pageSize = String(s.pageSize);
  if (s.q) out.q = s.q;
  if (s.from) out.from = s.from;
  if (s.to) out.to = s.to;
  if (s.sort) { out.sort = s.sort; out.dir = s.dir; }
  return out;
}
function sig(obj) {
  return Object.keys(obj || {}).sort().map((k) => `${k}=${obj[k]}`).join('&');
}
function ymd(offsetDays = 0) {
  return new Date(Date.now() - offsetDays * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

export function useTable(type) {
  const route = useRoute();
  const router = useRouter();
  const state = reactive(fromQuery(route.query));
  const data = ref(null);
  const loading = ref(false);
  const error = ref('');
  const ready = ref(false);
  let seq = 0;

  const columns = computed(() => data.value?.columns || []);
  const rows = computed(() => data.value?.items || []);
  const total = computed(() => data.value?.total || 0);
  const totalPages = computed(() => data.value?.totalPages || 1);
  const sortable = computed(() => data.value?.sortable || []);
  const hasRange = computed(() => Boolean(state.from || state.to));

  async function load({ silent = false } = {}) {
    const my = ++seq;
    if (!silent) loading.value = true;
    error.value = '';
    try {
      const res = await api.records(type, {
        page: state.page,
        pageSize: state.pageSize,
        q: state.q,
        from: state.from,
        to: state.to,
        sort: state.sort || undefined,
        dir: state.dir
      });
      if (my !== seq) return;
      data.value = res;
      if (res.page && res.page !== state.page) state.page = res.page;
      ready.value = true;
      touchRefresh();
      try { sessionStorage.setItem('panel.list.' + type, JSON.stringify({ path: route.path, query: toQuery(state) })); } catch {}
    } catch (e) {
      if (my !== seq) return;
      error.value = e?.message || String(e);
      ready.value = true;
    } finally {
      if (my === seq) loading.value = false;
    }
  }

  function syncFromRoute() {
    const next = fromQuery(route.query);
    if (sig(toQuery(next)) === sig(toQuery(state))) return;
    Object.assign(state, next);
    load();
  }

  watch(() => route.query, () => syncFromRoute(), { deep: true });
  watch(refreshTick, () => load({ silent: true }));

  function apply(patch = {}, { resetPage = true } = {}) {
    const p = { ...patch };
    if (resetPage && !('page' in p)) p.page = 1;
    Object.assign(state, p);
    const q = toQuery(state);
    if (sig(q) !== sig(route.query)) router.replace({ path: route.path, query: q });
    load();
  }

  function toggleSort(field) {
    const allowed = sortable.value;
    if (allowed.length && !allowed.includes(field)) return;
    if (state.sort === field) apply({ sort: field, dir: state.dir === 'asc' ? 'desc' : 'asc', page: 1 });
    else apply({ sort: field, dir: 'desc', page: 1 });
  }

  function setPage(p) { apply({ page: Math.max(1, Number(p) || 1) }, { resetPage: false }); }
  function setPageSize(n) { apply({ pageSize: Number(n) || 25, page: 1 }); }

  function quickRange(kind) {
    if (kind === 'today') apply({ from: ymd(0), to: ymd(0) });
    else if (kind === '7') apply({ from: ymd(6), to: ymd(0) });
    else if (kind === '30') apply({ from: ymd(29), to: ymd(0) });
    else apply({ from: '', to: '' });
  }

  function resetFilters() {
    apply({ q: '', from: '', to: '', sort: '', dir: 'desc', page: 1, pageSize: DEFAULTS.pageSize });
  }

  function rememberList() {
    try { sessionStorage.setItem('panel.list.' + type, JSON.stringify({ path: route.path, query: toQuery(state) })); } catch {}
  }

  function goDetail(id) {
    rememberList();
    router.push({ name: 'detail', params: { type, id: String(id) } });
  }

  // 首次加载
  load();

  return {
    state, data, loading, error, ready, columns, rows, total, totalPages, sortable, hasRange,
    load, apply, toggleSort, setPage, setPageSize, quickRange, resetFilters, goDetail, rememberList
  };
}

export function listStateFor(type) {
  try {
    const raw = sessionStorage.getItem('panel.list.' + type);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.path) return null;
    return parsed;
  } catch { return null; }
}
