<script setup lang="ts">
/**
 * 头部的搜索岛：放大镜 + 输入框 + 有内容时才出现的清除按钮。
 *
 * 宽度是响应式的（`min(320px, 28vw)`，下限 220px）—— 死宽在窄窗口下
 * 会把整排岛屿挤到换行。
 */
defineProps<{
  modelValue: string
  placeholder: string
  /** 清除按钮的 title */
  clearTitle: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <div class="action-island search-island">
    <span class="search-icon" aria-hidden="true">⌕</span>
    <input
      class="gallery-search-input"
      type="search"
      :value="modelValue"
      :placeholder="placeholder"
      :aria-label="placeholder"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button
      v-if="modelValue"
      class="clear-filter-btn"
      :title="clearTitle"
      :aria-label="clearTitle"
      @click="emit('update:modelValue', '')"
    >
      ×
    </button>
  </div>
</template>

<style scoped lang="less">
.search-island {
  width: min(320px, 28vw);
  min-width: 220px;
  padding: 0 8px 0 10px;
  gap: 8px;
}

.search-icon {
  color: var(--color-text-muted);
  font-size: var(--font-size-base);
  line-height: 1;
}

.gallery-search-input {
  flex: 1;
  min-width: 0;
  height: 30px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text-primary);
  font-size: 13px;

  &::placeholder {
    color: var(--color-text-disabled);
  }

  // 去掉 Chromium 给 type=search 加的原生清除叉，我们有自己的
  &::-webkit-search-cancel-button {
    appearance: none;
  }
}

.clear-filter-btn {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  background: var(--color-bg-raised);
  color: var(--color-text-secondary);
  font-size: var(--font-size-md);
  line-height: 20px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: var(--color-bg-raised);
    color: var(--color-text-primary);
  }
}
</style>
