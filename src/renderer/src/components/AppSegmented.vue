<script setup lang="ts" generic="T extends string | number">
/** 分段单选。沿用 AI 助手设置的 provider-tabs 外观，供设置页共用。 */
defineProps<{
  modelValue: T
  options: readonly T[]
  ariaLabel: string
}>()

defineEmits<{ 'update:modelValue': [value: T] }>()
defineSlots<{ default(props: { option: T }): unknown }>()
</script>

<template>
  <div class="app-segmented" role="group" :aria-label="ariaLabel">
    <button
      v-for="option in options"
      :key="option"
      type="button"
      class="app-segmented__item"
      :class="{ active: modelValue === option }"
      :aria-pressed="modelValue === option"
      @click="$emit('update:modelValue', option)"
    >
      <slot :option="option">{{ option }}</slot>
    </button>
  </div>
</template>

<style scoped>
.app-segmented {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: calc(var(--space-3) / 4);
  border-radius: var(--radius-full);
  background: var(--color-bg-surface-hover);
  flex-shrink: 0;
}

.app-segmented__item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  box-sizing: border-box;
  min-width: calc(var(--space-16) + var(--space-5) / 2);
  height: var(--space-7);
  padding: 0 calc(var(--space-7) / 2);
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.app-segmented__item.active {
  background: var(--color-bg-selected);
  color: var(--color-text-primary);
}

.app-segmented__item:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .app-segmented__item {
    transition: none;
  }
}
</style>
