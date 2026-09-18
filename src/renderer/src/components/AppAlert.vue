<script setup lang="ts">
/**
 * 提示条。接替 ant-design-vue 的 `<a-alert>`（8 处）。
 *
 * ## 不只靠颜色分档
 *
 * 每档除了配色还带一个自己的图标：错误是叉、警告是感叹号、提示是 i、成功是勾。
 * 只靠颜色的话，红绿色觉障碍用户看到的「出错了」和「成功了」是同一个东西。
 *
 * `role` 也跟着分档：错误和警告用 `alert`（读屏软件会打断当前朗读念出来），
 * 提示和成功用 `status`（等当前这句念完再念）。都用 alert 的话，
 * 一个「已保存」会把用户正在听的内容打断。
 */
import { computed } from 'vue'
import { PhCheckCircle, PhInfo, PhWarning, PhWarningCircle, PhX } from '@phosphor-icons/vue'

interface Props {
  type?: 'info' | 'success' | 'warning' | 'error'
  /** 主文案。也可以用 #message 插槽放富文本 */
  message?: string
  /** 主文案下面的补充说明 */
  description?: string
  /** 显示左侧图标 */
  showIcon?: boolean
  /** 右侧给一个关闭叉 */
  closable?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  type: 'info',
  message: undefined,
  description: undefined,
  showIcon: false,
  closable: false
})

const emit = defineEmits<{ (e: 'close'): void }>()

const ICONS = {
  info: PhInfo,
  success: PhCheckCircle,
  warning: PhWarning,
  error: PhWarningCircle
}

const icon = computed(() => ICONS[props.type])

// 出错和警告要打断朗读，提示和成功等当前这句念完
const role = computed(() =>
  props.type === 'error' || props.type === 'warning' ? 'alert' : 'status'
)
</script>

<template>
  <div :class="['app-alert', `app-alert--${type}`]" :role="role">
    <component :is="icon" v-if="showIcon" class="app-alert__icon" aria-hidden="true" />
    <div class="app-alert__body">
      <div class="app-alert__message">
        <slot name="message">{{ message }}</slot>
      </div>
      <div v-if="description || $slots.description" class="app-alert__description">
        <slot name="description">{{ description }}</slot>
      </div>
    </div>
    <div v-if="$slots.action" class="app-alert__action">
      <slot name="action" />
    </div>
    <button
      v-if="closable"
      type="button"
      class="app-alert__close"
      :aria-label="$t('common.close')"
      @click="emit('close')"
    >
      <PhX />
    </button>
  </div>
</template>

<style scoped>
.app-alert {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-size: var(--font-size-base);
  line-height: 1.5;
}

.app-alert__icon {
  flex: none;
  margin-top: 2px;
  font-size: 16px;
}

.app-alert__body {
  flex: 1;
  min-width: 0;
}

.app-alert__message {
  font-weight: 500;
}

.app-alert__description {
  margin-top: var(--space-1);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.app-alert__action {
  flex: none;
}

.app-alert__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
}

.app-alert__close:hover {
  opacity: 1;
}

.app-alert__close:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 1px;
}

/* 每档：淡底 + 同色描边 + 同色标题，正文仍走 text-primary 保证可读 */
.app-alert--info {
  background: var(--color-accent-bg);
  border-color: var(--color-accent-border);
  color: var(--color-accent-text);
}

.app-alert--success {
  background: var(--color-success-bg);
  border-color: var(--color-success-border);
  color: var(--color-success-text);
}

.app-alert--warning {
  background: var(--color-warning-bg);
  border-color: var(--color-warning-border);
  color: var(--color-warning-text);
}

.app-alert--error {
  background: var(--color-danger-bg);
  border-color: var(--color-danger-border);
  color: var(--color-danger-text);
}
</style>
