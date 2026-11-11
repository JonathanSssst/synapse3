<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppSidebar from './components/AppSidebar.vue';
import AppTopbar from './components/AppTopbar.vue';
import ToastHost from './components/ToastHost.vue';
import { ui, startAuto } from './composables/useRefresh.js';
import { pollLatest, markSeen } from './composables/useUnread.js';
import { api } from './api/client.js';
import { TYPE_TAB } from './router.js';

const route = useRoute();
let timer = 0;
let claimTimer = 0;
const claim = ref(null);

async function refreshClaim() {
  try { claim.value = await api.breezeClaimGet(); } catch { /* 静默 */ }
}
async function refreshClaimForce() {
  try { claim.value = await api.breezeClaimCheck(); } catch { /* 静默 */ }
}
async function markClaimed() {
  try { claim.value = await api.breezeClaimMark(); } catch { /* 静默 */ }
}

function currentTab() {
  if (route.name === 'detail') return TYPE_TAB[route.params.type] || '';
  return route.meta?.tab || '';
}

function markCurrentSeen() {
  const tab = currentTab();
  if (tab) markSeen(tab);
}

onMounted(async () => {
  startAuto();
  try {
    ui.health = await api.health();
    ui.version = ui.health?.version || '';
  } catch {
    ui.health = null;
  }
  await pollLatest();
  markCurrentSeen();
  await refreshClaim();
  claimTimer = setInterval(refreshClaim, 5 * 60 * 1000);
  timer = setInterval(async () => {
    await pollLatest();
    markCurrentSeen();
    try { ui.health = await api.health(); } catch { ui.health = null; }
  }, 45000);
});

onBeforeUnmount(() => { if (timer) clearInterval(timer); if (claimTimer) clearInterval(claimTimer); });

watch(
  () => route.fullPath,
  () => {
    ui.mobileOpen = false;
    if (route.name === 'detail') return;
    markCurrentSeen();
  }
);
</script>

<template>
  <div class="shell">
    <AppSidebar />
    <div class="main">
      <AppTopbar />
      <main class="content">
        <div v-if="!ui.health" class="backend-banner">
          <span class="grow">后端连接异常：请确认 127.0.0.1:3120 正在运行（可启动面板 exe 或运行 restart.ps1）</span>
        </div>
        <div v-if="claim && !claim.claimed" class="breeze-banner">
          <span class="grow">
            💰 Breeze 今日签到未完成：余额 {{ claim.balance ?? '—' }} credits（基线 {{ claim.baseline ?? '—' }}）<span v-if="claim.error" class="faint"> · {{ claim.error }}</span>
          </span>
          <a class="btn btn-sm" :href="claim.link" target="_blank" rel="noreferrer">去签到</a>
          <button class="btn btn-sm" @click="markClaimed">已签到</button>
          <button class="btn btn-sm" @click="refreshClaimForce">刷新余额</button>
        </div>
        <RouterView v-slot="{ Component }">
          <component :is="Component" />
        </RouterView>
      </main>
    </div>
    <ToastHost />
  </div>
</template>

<style scoped>
.shell { display: flex; min-height: 100vh; align-items: flex-start; }
.main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; min-height: 100vh; }
.content { flex: 1 1 auto; padding: 18px 20px 40px; min-width: 0; }
.backend-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--fs-12);
}
.breeze-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, #f59e0b 14%, var(--card));
  border: 1px solid color-mix(in srgb, #f59e0b 35%, var(--border));
  color: var(--fg);
  font-size: var(--fs-12);
}
.breeze-banner.done {
  background: color-mix(in srgb, var(--ok, #3ecf8e) 12%, var(--card));
  border-color: color-mix(in srgb, var(--ok, #3ecf8e) 30%, var(--border));
}
@media (max-width: 900px) {
  .content { padding: 12px 12px 32px; }
}
</style>
