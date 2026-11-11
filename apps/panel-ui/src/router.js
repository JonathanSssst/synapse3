import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', redirect: '/overview' },
  {
    path: '/overview',
    name: 'overview',
    component: () => import('./views/Overview.vue'),
    meta: { title: '总览', group: '概览', tab: 'overview' }
  },
  {
    path: '/costs',
    name: 'costs',
    component: () => import('./views/Costs.vue'),
    meta: { title: '花费与用量', group: '概览', tab: 'cost' }
  },
  {
    path: '/audit',
    name: 'audit',
    component: () => import('./views/Audit.vue'),
    meta: { title: '审计日志', group: '概览', tab: 'audit' }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('./views/Settings.vue'),
    meta: { title: '设置', group: '概览', tab: 'settings' }
  },
  {
    path: '/messages',
    name: 'messages',
    component: () => import('./views/MessageStats.vue'),
    meta: { title: '消息统计', group: '概览', tab: 'messages' }
  },
  {
    path: '/bili',
    name: 'bili',
    component: () => import('./views/Bili.vue'),
    meta: { title: 'B 站', group: '她的生活', tab: 'bili' }
  },
  {
    path: '/qzone',
    name: 'qzone',
    component: () => import('./views/Qzone.vue'),
    meta: { title: 'QQ 空间', group: '她的生活', tab: 'qzone' }
  },
  {
    path: '/douyin',
    name: 'douyin',
    component: () => import('./views/Douyin.vue'),
    meta: { title: '抖音', group: '她的生活', tab: 'douyin' }
  },
  {
    path: '/album',
    name: 'album',
    component: () => import('./views/Album.vue'),
    meta: { title: '相册', group: '她的生活', tab: 'album' }
  },
  {
    path: '/voice',
    name: 'voice',
    component: () => import('./views/Voice.vue'),
    meta: { title: '语音', group: '她的生活', tab: 'voice' }
  },
  {
    path: '/pet',
    name: 'pet',
    component: () => import('./views/Pet.vue'),
    meta: { title: '桌宠', group: '她的生活', tab: 'pet' }
  },
  {
    path: '/persona',
    name: 'persona',
    component: () => import('./views/Persona.vue'),
    meta: { title: '人设', group: '她的生活', tab: 'persona' }
  },
  {
    path: '/life',
    name: 'life',
    component: () => import('./views/Life.vue'),
    meta: { title: '小生活', group: '她的生活', tab: 'life' }
  },
  {
    path: '/memory',
    name: 'memory',
    component: () => import('./views/MemoryMap.vue'),
    meta: { title: '记忆星图', group: '她的生活', tab: 'memory' }
  },
  {
    path: '/vitals',
    name: 'vitals',
    component: () => import('./views/Vitals.vue'),
    meta: { title: '状态', group: '她的生活', tab: 'vitals' }
  },
  {
    path: '/slang',
    name: 'slang',
    component: () => import('./views/Slang.vue'),
    meta: { title: '黑话', group: '她的生活', tab: 'slang' }
  },
  {
    path: '/detail/:type/:id',
    name: 'detail',
    component: () => import('./views/Detail.vue'),
    meta: { title: '记录详情', group: '明细', tab: '' }
  },
  { path: '/:pathMatch(.*)*', redirect: '/overview' }
];

export const router = createRouter({
  history: createWebHistory('/ui/'),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition;
    return { top: 0 };
  }
});

// 详情页类型 -> 所属列表页（侧边栏高亮 + 返回路径）
export const TYPE_TAB = {
  tool_call: 'audit',
  audit_event: 'audit',
  bili_event: 'bili',
  bili_note: 'bili',
  douyin_event: 'douyin',
  qzone_action: 'qzone',
  gen_image: 'album',
  sticker: 'album',
  persona: 'persona',
  memory_doc: 'memory',
  fs_event: 'life',
  free_time: 'life',
  activity: 'audit'
};

export const TYPE_LIST_PATH = {
  tool_call: '/audit',
  audit_event: '/audit',
  bili_event: '/bili',
  bili_note: '/bili',
  douyin_event: '/douyin',
  qzone_action: '/qzone',
  gen_image: '/album',
  sticker: '/album',
  persona: '/persona',
  memory_doc: '/memory',
  fs_event: '/life',
  free_time: '/life',
  activity: '/audit'
};

export default router;
