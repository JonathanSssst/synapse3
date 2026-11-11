<script setup>
defineProps({
  label: { type: String, default: '' },
  value: { type: [String, Number], default: '—' },
  hint: { type: String, default: '' },
  tone: { type: String, default: '' },
  delta: { type: String, default: '' },
  small: { type: Boolean, default: false }
});
</script>

<template>
  <div class="kpi card">
    <div class="kpi-label">{{ label }}</div>
    <div class="kpi-value num" :class="[tone, { small }]">{{ value }}</div>
    <div class="kpi-foot">
      <span v-if="hint" class="faint">{{ hint }}</span>
      <span v-if="delta" class="kpi-delta" :class="tone">{{ delta }}</span>
    </div>
  </div>
</template>

<style scoped>
.kpi {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  position: relative;
  overflow: hidden;
}
.kpi::after {
  content: "";
  position: absolute;
  inset: 0 0 auto auto;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-soft), transparent 70%);
  transform: translate(28px, -28px);
  pointer-events: none;
}
.kpi-label { font-size: var(--fs-11); color: var(--muted); letter-spacing: 0.08em; }
.kpi-value { font-size: 26px; font-weight: 650; line-height: 1.25; letter-spacing: -0.02em; color: var(--text); }
.kpi-value.small { font-size: 20px; }
.kpi-value.accent { color: var(--accent); }
.kpi-value.warn { color: var(--warn); }
.kpi-value.danger, .kpi-value.bad { color: var(--danger); }
.kpi-value.success, .kpi-value.ok { color: var(--success); }
.kpi-value.info { color: var(--info); }
.kpi-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--fs-11); min-height: 14px; }
.kpi-delta { color: var(--muted); font-variant-numeric: tabular-nums; }
</style>
