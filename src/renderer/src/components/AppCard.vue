<script setup lang="ts">
/**
 * 卡片。接替 ant-design-vue 的 `<a-card>`（7 处）。
 *
 * 大部分用法就是「带描边和内边距的容器 + 可选标题」，个别再加一张封面图
 * （资产卡、模板卡）。
 *
 * ## hoverable 的卡片必须是可聚焦的
 *
 * a-card 的 hoverable 只是加个投影，仍然是个 div —— 键盘 Tab 根本到不了，
 * 而那几处卡片是**可以点的**（双击打开工程、点选模板）。这里 hoverable 时
 * 渲染成 `<button>`：能聚焦、能回车触发、读屏软件会念「按钮」。
 */
import { computed, useSlots } from 'vue'

interface Props {
  title?: string
  /** 可悬停 = 可点击。会渲染成按钮而不是 div */
  hoverable?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  title: undefined,
  hoverable: false
})

const slots = useSlots()
const tag = computed(() => (props.hoverable ? 'button' : 'div'))
const hasHeader = computed(() => Boolean(props.title || slots.title))
</script>

<template>
  <component
    :is="tag"
    :type="hoverable ? 'button' : undefined"
    :class="['app-card', { 'app-card--hoverable': hoverable }]"
  >
    <div v-if="$slots.cover" class="app-card__cover">
      <slot name="cover" />
    </div>
    <div v-if="hasHeader" class="app-card__header">
      <slot name="title">{{ title }}</slot>
    </div>
    <div class="app-card__body">
      <slot />
    </div>
  </component>
</template>

<style scoped>
.app-card {
  display: block;
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
  font: inherit;
  text-align: inherit;
  overflow: hidden;
}

.app-card--hoverable {
  cursor: pointer;
  transition:
    border-color var(--motion-fast) var(--easing-standard),
    background-color var(--motion-fast) var(--easing-standard);
}

.app-card--hoverable:hover {
  border-color: var(--color-border-strong);
  background: var(--color-bg-surface-hover);
}

.app-card--hoverable:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

.app-card__cover {
  display: block;
  overflow: hidden;
}

.app-card__cover :deep(img) {
  display: block;
  width: 100%;
}

.app-card__header {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border);
  font-size: var(--font-size-base);
  font-weight: 600;
}

.app-card__body {
  padding: 0;
}

@media (prefers-reduced-motion: reduce) {
  .app-card--hoverable {
    transition: none;
  }
}
</style>
