<script setup lang="ts">
/**
 * 全局开关。整个应用只有这一个开关长相。
 *
 * 在这之前有 11 套手写实现 + antd 原生，轨道从 32×18 到 44×24 五种尺寸，
 * 开启态分成两派（一派实心蓝轨 + 白钮，一派淡蓝轨 + 蓝钮），
 * 同一个偏好设置页里上下两行的开关都不一样。
 *
 * 配色约定（每个 token 都用在它自己的角色上，不借值）：
 *   关：轨道 = 表面悬停色 + 一圈 border-strong 描边（描边负责 WCAG 1.4.11 的 3:1
 *       控件边界），滑块 = text-muted 的灰点
 *   开：轨道 = switch-checked-solid 蓝色实心，滑块 = text-on-solid 的白点
 * 开关态不是只靠颜色区分 —— 滑块位置 + 轨道明暗 + 滑块明暗三重信号。
 */
import { computed } from 'vue'

interface Props {
  /** 与 ant-design-vue 的 a-switch 同名，方便直接替换 */
  checked?: boolean
  disabled?: boolean
  size?: 'small' | 'middle'
  /** 无可见文字标签时必填，否则读屏软件念不出这个开关是干什么的 */
  ariaLabel?: string
  /**
   * 「管着一批东西，而它们此刻有开有关」。滑块停在中间，轨道保持关闭态配色。
   *
   * **只改长相，不改 `aria-checked`**：ARIA 1.2 里 `switch` 没有 `mixed` 这一档
   * （那是 `checkbox` 才有的），硬写上去读屏软件只会念出一个它不认识的值。
   * 读屏那边靠的是调用方在 `ariaLabel` 里带上「已开 3 / 12」这种数字。
   */
  indeterminate?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  checked: false,
  disabled: false,
  size: 'middle',
  ariaLabel: undefined,
  indeterminate: false
})

const emit = defineEmits<{
  (e: 'update:checked', value: boolean): void
  (e: 'change', value: boolean): void
}>()

const classes = computed(() => [
  'app-switch',
  `app-switch--${props.size}`,
  {
    'app-switch--checked': props.checked,
    'app-switch--indeterminate': props.indeterminate && !props.checked
  }
])

function toggle(): void {
  if (props.disabled) return
  const next = !props.checked
  emit('update:checked', next)
  emit('change', next)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :class="classes"
    :aria-checked="checked"
    :aria-label="ariaLabel"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="app-switch__thumb" />
  </button>
</template>

<style scoped>
.app-switch {
  position: relative;
  flex-shrink: 0;
  display: inline-block;
  box-sizing: border-box;
  padding: 0;
  border: 1px solid var(--color-border-strong);
  border-radius: 9999px;
  background: var(--color-bg-surface-hover);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) var(--easing-standard),
    border-color var(--motion-fast) var(--easing-standard);
}

/* 滑块的定位基准是轨道的 padding box（描边**以内**），不是外框。
   所以纵向别去写 top: 3px 算差值 —— 少算那 1px 描边，滑块就会偏下。
   直接 50% 居中，高度怎么改都不会歪。
   横向同理：滑行距离由「内宽 − 两端留白 − 滑块」算出来，不手写常数。 */
.app-switch__thumb {
  --switch-travel: calc(var(--switch-width) - 2px - var(--switch-inset) * 2 - var(--switch-thumb));

  position: absolute;
  top: 50%;
  left: var(--switch-inset);
  width: var(--switch-thumb);
  height: var(--switch-thumb);
  border-radius: 50%;
  background: var(--color-text-muted);
  transform: translateY(-50%);
  transition:
    transform var(--motion-fast) var(--easing-standard),
    background-color var(--motion-fast) var(--easing-standard);
}

.app-switch--middle {
  --switch-width: 40px;
  --switch-inset: 2px;
  --switch-thumb: 16px;

  width: var(--switch-width);
  height: 22px;
}

.app-switch--small {
  --switch-width: 30px;
  --switch-inset: 2px;
  --switch-thumb: 12px;

  width: var(--switch-width);
  height: 18px;
}

.app-switch:hover:not(:disabled) {
  border-color: var(--color-text-muted);
}

.app-switch:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

.app-switch--checked {
  background: var(--color-switch-checked-solid);
  border-color: var(--color-switch-checked-solid);
}

.app-switch--checked:hover:not(:disabled) {
  background: var(--color-switch-checked-solid-hover);
  border-color: var(--color-switch-checked-solid-hover);
}

.app-switch--checked .app-switch__thumb {
  transform: translate(var(--switch-travel), -50%);
  background: var(--color-text-on-solid);
}

/* 半开：滑块停在行程正中。轨道仍是关闭态那身配色 —— 它管的东西没有全开，
   画成开启态的蓝色就是在撒谎 */
.app-switch--indeterminate .app-switch__thumb {
  transform: translate(calc(var(--switch-travel) / 2), -50%);
  background: var(--color-switch-checked-solid);
}

.app-switch:disabled {
  cursor: not-allowed;
  color: var(--color-text-disabled);
}
</style>
