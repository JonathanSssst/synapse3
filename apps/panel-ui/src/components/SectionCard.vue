<script setup>
defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  dense: { type: Boolean, default: false }
});
</script>

<template>
  <section class="card">
    <header v-if="title || $slots.actions" class="card-head">
      <div class="grow">
        <div class="card-title">{{ title }}</div>
        <div v-if="subtitle" class="small faint" style="margin-left: 11px">{{ subtitle }}</div>
      </div>
      <div v-if="$slots.actions" class="row"><slot name="actions" /></div>
    </header>
    <div :class="dense ? 'card-body tight' : 'card-body'">
      <slot />
    </div>
  </section>
</template>
