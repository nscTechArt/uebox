<script setup lang="ts">
import { PhCaretDown } from '@phosphor-icons/vue'

interface Props {
  label: string
  expanded: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'toggle'): void
}>()

function handleToggle(): void {
  emit('toggle')
}
</script>

<template>
  <div class="sidebar-section-header">
    <button
      type="button"
      class="sidebar-section-toggle"
      :aria-expanded="props.expanded"
      @click="handleToggle"
    >
      <span class="sidebar-section-label">{{ props.label }}</span>
      <PhCaretDown
        weight="fill"
        :class="['sidebar-section-caret', { collapsed: !props.expanded }]"
      />
    </button>
    <span class="sidebar-section-actions">
      <slot name="actions" />
    </span>
  </div>
</template>

<style scoped lang="less">
// 不加底色：分区标题只是一行小字，压一层底反而把列表切碎了
.sidebar-section-header {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--sidebar-section-header-height);
  // 左边和下面的工程行同一个起点，右边和所有行尾按钮同一条竖线
  padding: 0 var(--space-1) 0 var(--sidebar-row-padding);
  background: transparent;
}

.sidebar-section-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  // 分区标题是「标题 + 小箭头」，下面的工程行不带箭头，靠这个区分层级
  justify-content: flex-start;
  gap: var(--space-1);
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--sidebar-text-muted);
  font-size: var(--sidebar-section-size);
  font-weight: var(--font-weight-medium);
  font-family: inherit;
  letter-spacing: 0.2px;
  cursor: pointer;
  user-select: none;
  transition: color 0.2s ease;

  &:hover {
    color: var(--sidebar-text);
  }

  &:focus-visible {
    outline: 2px solid var(--sidebar-focus-ring);
    outline-offset: 2px;
    border-radius: var(--sidebar-row-radius);
  }
}

.sidebar-section-caret {
  font-size: 10px;
  transition: transform 0.2s ease;
}

.sidebar-section-caret.collapsed {
  transform: rotate(-90deg);
}

.sidebar-section-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: none;
  font-size: var(--sidebar-label-size);
}

// 标题右侧的操作图标：平时不显示，鼠标移到这一行或键盘聚焦进来才出现
.sidebar-section-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

// :has(:focus-visible) 而不是 :focus-within：点击标题展开/折叠后焦点还留在按钮上，
// 用 :focus-within 会让行尾图标常驻；只有键盘聚焦才需要常驻
.sidebar-section-header:hover .sidebar-section-actions,
.sidebar-section-header:has(:focus-visible) .sidebar-section-actions {
  opacity: 1;
}
</style>
