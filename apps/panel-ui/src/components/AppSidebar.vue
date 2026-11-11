<script setup>
import { computed, onMounted, watch, ref } from 'vue';
import { useRoute } from 'vue-router';
import Icon from './Icon.vue';
import { ui, setMini } from '../composables/useRefresh.js';
import { isUnread } from '../composables/useUnread.js';
import { api } from '../api/client.js';
import { TYPE_TAB } from '../router.js';

const route = useRoute();

const NAV = [
  {
    group: '概览',
    items: [
      { path: '/overview', label: '总览', icon: 'overview', tab: 'overview' },
      { path: '/costs', label: '花费', icon: 'cost', tab: 'cost' },
      { path: '/audit', label: '审计', icon: 'audit', tab: 'audit' },
      { path: '/settings', label: '设置', icon: 'persona', tab: 'settings' },
      { path: '/messages', label: '消息', icon: 'audit', tab: 'messages' }
    ]
  },
  {
    group: '她的生活',
    items: [
      { path: '/bili', label: 'B站', icon: 'bili', tab: 'bili' },
      { path: '/qzone', label: 'QQ空间', icon: 'qzone', tab: 'qzone' },
      { path: '/douyin', label: '抖音', icon: 'douyin', tab: 'douyin' },
      { path: '/album', label: '相册', icon: 'album', tab: 'album' },
      { path: '/voice', label: '语音', icon: 'voice', tab: 'voice' },
      { path: '/pet', label: '桌宠', icon: 'pet', tab: 'pet' },
      { path: '/persona', label: '人设', icon: 'persona', tab: 'persona' },
      { path: '/vitals', label: '状态', icon: 'life', tab: 'vitals' },
      { path: '/life', label: '小生活', icon: 'life', tab: 'life' },
      { path: '/memory', label: '记忆星图', icon: 'memory', tab: 'memory' },
      { path: '/slang', label: '黑话', icon: 'life', tab: 'slang' }
    ]
  }
];

const activePath = computed(() => {
  if (route.name === 'detail') {
    const map = { audit: '/audit', bili: '/bili', douyin: '/douyin', qzone: '/qzone', album: '/album', persona: '/persona', memory: '/memory', life: '/life' };
    const tab = TYPE_TAB[route.params.type];
    return map[tab] || '';
  }
  return route.path;
});

const currentTab = computed(() => route.meta?.tab || TYPE_TAB[route.params?.type] || '');

function dot(item) {
  return isUnread(item.tab) && item.tab !== currentTab.value;
}

const persona = ref(null);
async function loadPersona() {
  try {
    const d = await api.records('persona', { page: 1, pageSize: 10 });
    persona.value = (d.items || []).find((p) => p.isCurrent) || (d.items || [])[0] || null;
  } catch { /* 后端未起时忽略 */ }
}
onMounted(loadPersona);
watch(() => route.fullPath, () => { if (!persona.value) loadPersona(); });

const version = computed(() => ui.version || '');
</script>

<template>
  <aside class="sidebar" :class="{ mini: ui.mini, open: ui.mobileOpen }">
    <div class="brand">
      <div class="brand-mark"><span class="glow" /></div>
      <div v-if="!ui.mini" class="brand-text">
        <div class="brand-name">Synapse 3</div>
        <div class="brand-sub">{{ version ? 'v' + version : '审计面板' }}</div>
      </div>
    </div>

    <nav class="nav">
      <div v-for="group in NAV" :key="group.group" class="nav-group">
        <div v-if="!ui.mini" class="nav-group-title">{{ group.group }}</div>
        <RouterLink
          v-for="item in group.items"
          :key="item.path"
          :to="item.path"
          class="nav-item"
          :class="{ active: activePath === item.path }"
          :title="ui.mini ? item.label : ''"
        >
          <span class="nav-icon"><Icon :name="item.icon" :size="17" /></span>
          <span v-if="!ui.mini" class="nav-label">{{ item.label }}</span>
          <span v-if="dot(item)" class="unread-dot" :title="'有新数据'" />
        </RouterLink>
      </div>
    </nav>

    <div class="sidebar-foot">
      <RouterLink to="/persona" class="persona-card" :title="persona ? persona.name : '人设'">
        <img
          v-if="persona && persona.hasAvatar"
          class="avatar"
          :src="api.avatarUrl(persona.name) + '&v=' + (persona.updatedAt || '')"
          alt=""
        />
        <span v-else class="avatar avatar-fallback">{{ persona ? String(persona.nickname || persona.name).slice(0, 1) : '?' }}</span>
        <span v-if="!ui.mini" class="persona-meta">
          <span class="persona-name truncate">{{ persona ? (persona.nickname || persona.displayName || persona.name) : '当前人设' }}</span>
          <span class="persona-role truncate">{{ persona ? persona.name : '未连接后端' }}</span>
        </span>
      </RouterLink>
      <button class="collapse-btn" :title="ui.mini ? '展开侧边栏' : '折叠侧边栏'" @click="setMini(!ui.mini)">
        <Icon :name="ui.mini ? 'expand' : 'collapse'" :size="16" />
        <span v-if="!ui.mini">折叠</span>
      </button>
    </div>
  </aside>
  <div v-if="ui.mobileOpen" class="sidebar-mask" @click="ui.mobileOpen = false" />
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-w);
  flex: 0 0 var(--sidebar-w);
  height: 100vh;
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 10px 10px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  transition: width var(--dur) var(--ease), flex-basis var(--dur) var(--ease);
  z-index: 30;
}
.sidebar.mini { width: var(--sidebar-w-mini); flex-basis: var(--sidebar-w-mini); padding-left: 8px; padding-right: 8px; }
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 6px 10px; }
.brand-mark { width: 30px; height: 30px; border-radius: 10px; background: var(--accent-soft); display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--accent) 26%, transparent); position: relative; flex: 0 0 auto; }
.glow { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 12px 3px var(--accent); animation: pulse 3.2s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 0.65; } 50% { opacity: 1; } }
.brand-name { font-size: var(--fs-14); font-weight: 700; letter-spacing: 0.02em; color: var(--text); line-height: 1.3; }
.brand-sub { font-size: var(--fs-11); color: var(--faint); }

.nav { flex: 1 1 auto; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding-bottom: 6px; }
.nav-group { display: flex; flex-direction: column; gap: 2px; }
.nav-group-title { font-size: 10px; letter-spacing: 0.14em; color: var(--faint); padding: 4px 10px 4px; text-transform: uppercase; }
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: var(--fs-13);
  position: relative;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.sidebar.mini .nav-item { justify-content: center; padding: 0; }
.nav-item:hover { background: var(--surface-2); color: var(--text); }
.nav-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.nav-item.active::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: var(--accent); }
.nav-icon { display: inline-flex; }
.unread-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-2); box-shadow: 0 0 8px var(--accent-2); margin-left: auto; }
.sidebar.mini .unread-dot { position: absolute; top: 6px; right: 8px; margin: 0; }

.sidebar-foot { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border); padding-top: 8px; }
.persona-card { display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: var(--radius-sm); border: 1px solid transparent; min-width: 0; }
.persona-card:hover { background: var(--surface-2); border-color: var(--border); }
.avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border-strong); flex: 0 0 auto; background: var(--surface-2); }
.avatar-fallback { display: grid; place-items: center; color: var(--accent); font-weight: 700; font-size: 14px; }
.persona-meta { display: flex; flex-direction: column; min-width: 0; }
.persona-name { font-size: var(--fs-12); color: var(--text); font-weight: 600; }
.persona-role { font-size: 10.5px; color: var(--faint); }
.sidebar.mini .persona-card { justify-content: center; padding: 6px 0; }
.collapse-btn { display: flex; align-items: center; justify-content: center; gap: 6px; height: 28px; border-radius: var(--radius-sm); color: var(--faint); font-size: var(--fs-11); }
.collapse-btn:hover { background: var(--surface-2); color: var(--muted); }
.sidebar-mask { display: none; }

@media (max-width: 900px) {
  .sidebar { position: fixed; left: 0; top: 0; transform: translateX(-100%); width: var(--sidebar-w); flex-basis: var(--sidebar-w); box-shadow: var(--shadow-pop); }
  .sidebar.open { transform: none; }
  .sidebar.mini { width: var(--sidebar-w); transform: translateX(-100%); }
  .sidebar.mini.open { transform: none; }
  .sidebar-mask { display: block; position: fixed; inset: 0; z-index: 29; background: var(--overlay); }
}
</style>
