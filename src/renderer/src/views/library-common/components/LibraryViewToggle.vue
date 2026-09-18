<script setup lang="ts">
/** 网格 / 列表视图切换。 */
defineProps<{
  modelValue: 'grid' | 'list'
  gridTitle: string
  listTitle: string
}>()

const emit = defineEmits<{ 'update:modelValue': [mode: 'grid' | 'list'] }>()
</script>

<template>
  <div class="view-toggle">
    <button
      class="toggle-btn"
      :class="{ active: modelValue === 'grid' }"
      :title="gridTitle"
      :aria-label="gridTitle"
      :aria-pressed="modelValue === 'grid'"
      @click="emit('update:modelValue', 'grid')"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1" y="1" width="6" height="6" rx="1.5" fill="currentColor" />
        <rect x="9" y="1" width="6" height="6" rx="1.5" fill="currentColor" />
        <rect x="1" y="9" width="6" height="6" rx="1.5" fill="currentColor" />
        <rect x="9" y="9" width="6" height="6" rx="1.5" fill="currentColor" />
      </svg>
    </button>
    <button
      class="toggle-btn"
      :class="{ active: modelValue === 'list' }"
      :title="listTitle"
      :aria-label="listTitle"
      :aria-pressed="modelValue === 'list'"
      @click="emit('update:modelValue', 'list')"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1" y="2" width="14" height="2.5" rx="1" fill="currentColor" />
        <rect x="1" y="6.75" width="14" height="2.5" rx="1" fill="currentColor" />
        <rect x="1" y="11.5" width="14" height="2.5" rx="1" fill="currentColor" />
      </svg>
    </button>
  </div>
</template>

<style scoped lang="less">
.view-toggle {
  display: flex;
  gap: 2px;
}

.toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);

  &:hover {
    color: var(--color-text-secondary);
    background: var(--color-bg-surface-hover);
  }

  &.active {
    color: var(--color-text-primary);
    background: var(--color-bg-raised);
  }
}
</style>
