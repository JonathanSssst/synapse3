<script setup>
// 手写 SVG 图标（无外部图标库）
defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 18 }
});

const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  cost: '<circle cx="12" cy="12" r="9"/><path d="M12 6.5v11M8.5 9.5h6.2a2 2 0 0 1 0 4H9.3a2 2 0 0 0 0 4h6.2"/>',
  audit: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.6" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.6" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.6" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
  bili: '<rect x="3" y="6" width="18" height="13" rx="4"/><path d="M8 3l2 3M16 3l-2 3M10.5 10.4l4.5 2.6-4.5 2.6z"/>',
  qzone: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/>',
  douyin: '<path d="M9 17.5V6.2l9-1.8v10.9"/><circle cx="6.4" cy="17.6" r="2.9"/><circle cx="15.4" cy="15.4" r="2.9"/>',
  album: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.4" cy="9.4" r="1.6"/><path d="M4 17.4l5-5 3.6 3.6 2.8-2.8L20 18"/>',
  voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3M9 21h6"/>',
  pet: '<path d="M5 10.5 4 6l4.2 2.2A8.5 8.5 0 0 1 12 7.2c1.4 0 2.7.4 3.8 1L20 6l-1 4.5a6.5 6.5 0 0 1-1 8.2 7.5 7.5 0 0 1-12 0 6.5 6.5 0 0 1-1-8.2z"/><circle cx="9.4" cy="12.2" r="1" fill="currentColor" stroke="none"/><circle cx="14.6" cy="12.2" r="1" fill="currentColor" stroke="none"/><path d="M10.4 15.2c1 .7 2.2.7 3.2 0"/>',
  persona: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20c1.4-3.9 4.3-5.9 7.5-5.9s6.1 2 7.5 5.9"/>',
  life: '<path d="M4 8.5h11.5v5.8A4.2 4.2 0 0 1 11.3 18.5H8.2A4.2 4.2 0 0 1 4 14.3z"/><path d="M15.6 9.6h1.7a2.4 2.4 0 0 1 0 4.8h-1.7"/><path d="M7 3.5v2.2M10.5 3.5v2.2"/>',
  memory: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5z"/><path d="M8 7.5h7M8 11.5h5"/>',
  refresh: '<path d="M20 11.5A8 8 0 1 0 18.1 17"/><path d="M20.5 4.5v7h-7"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4L19 19M19 5l-1.6 1.6M6.6 17.4L5 19"/>',
  moon: '<path d="M20.5 14.2A8.6 8.6 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="M15.8 15.8l4.2 4.2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  collapse: '<path d="M14 6l-6 6 6 6"/>',
  expand: '<path d="M10 6l6 6-6 6"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 13.5V19a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10"/>',
  back: '<path d="M10 6l-6 6 6 6"/><path d="M4 12h16"/>',
  filter: '<path d="M4 5h16l-6.2 7.4V19l-3.6-2v-4.6z"/>',
  download: '<path d="M12 4v10M8 10.5l4 4 4-4"/><path d="M5 18.5h14"/>',
  warning: '<path d="M12 4l9 15.5H3z"/><path d="M12 9.5v4M12 16.6v.2"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  box: '<path d="M3.5 7.5L12 3l8.5 4.5L12 12z"/><path d="M3.5 7.5V16l8.5 4.5L20.5 16V7.5"/><path d="M12 12v8.5"/>',
  chart: '<path d="M4 19.5V13M9.4 19.5V8M14.8 19.5V4.5M20.2 19.5V10.5"/>',
  pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1"/>',
  play: '<path d="M7 4.5l12 7.5-12 7.5z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.4l3.4 2"/>'
};
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="ICONS[name] || ''"
  />
</template>

<style scoped>
.icon { display: inline-block; flex: 0 0 auto; vertical-align: middle; }
</style>
