<script setup lang="ts">
/**
 * 加载指示。接替 ant-design-vue 的 `<a-spin>`（16 处）。
 *
 * 两种用法，和 a-spin 一致：
 *   - 自己站着：`<AppSpin />`，就一个转圈
 *   - 包着内容：`<AppSpin :spinning="loading"><列表 /></AppSpin>`，
 *     加载时把内容压暗并挡住点击，转圈浮在正中
 *
 * 包着内容那种要挡点击 —— 不挡的话用户能点到底下正在被替换的列表项，
 * 点中的还是旧数据。
 */
interface Props {
  /** 只在「包着内容」时有意义；单独用时它一直转 */
  spinning?: boolean
  size?: 'small' | 'medium' | 'large'
  /** 转圈下面的一行说明 */
  tip?: string
}

withDefaults(defineProps<Props>(), {
  spinning: true,
  size: 'medium',
  tip: undefined
})

const slots = defineSlots<{ default?: () => unknown }>()
const hasContent = Boolean(slots.default)
</script>

<template>
  <!-- 包着内容 -->
  <div v-if="hasContent" class="app-spin-wrap">
    <div :class="['app-spin-content', { 'app-spin-content--blurred': spinning }]">
      <slot />
    </div>
    <div v-if="spinning" class="app-spin-overlay">
      <span :class="['app-spin__dot', `app-spin__dot--${size}`]" role="status" :aria-label="tip" />
      <span v-if="tip" class="app-spin__tip">{{ tip }}</span>
    </div>
  </div>

  <!-- 自己站着 -->
  <span v-else class="app-spin">
    <span :class="['app-spin__dot', `app-spin__dot--${size}`]" role="status" :aria-label="tip" />
    <span v-if="tip" class="app-spin__tip">{{ tip }}</span>
  </span>
</template>

<style scoped>
.app-spin {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-accent-text);
}

.app-spin__dot {
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: var(--radius-full);
  animation: spin 0.8s linear infinite;
}

.app-spin__dot--small {
  width: 14px;
  height: 14px;
  border-width: 2px;
}

.app-spin__dot--medium {
  width: 20px;
  height: 20px;
}

.app-spin__dot--large {
  width: 28px;
  height: 28px;
  border-width: 3px;
}

.app-spin__tip {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.app-spin-wrap {
  position: relative;
}

/* 压暗 + 挡住点击：不挡的话用户能点到底下正在被替换的内容 */
.app-spin-content--blurred {
  opacity: 0.4;
  pointer-events: none;
  user-select: none;
}

.app-spin-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-accent-text);
}

@media (prefers-reduced-motion: reduce) {
  .app-spin__dot {
    animation-duration: 2.4s;
  }
}
</style>
