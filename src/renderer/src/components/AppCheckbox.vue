<script setup lang="ts">
/**
 * 全局复选框。接替 ant-design-vue 的 `<a-checkbox>`（33 处）。
 *
 * ## 未选中态全靠一圈描边被看见
 *
 * 这是这个控件唯一容易做砸的地方，之前 antd 那版就砸过：
 * 全局 `colorBorder` 走 `--color-border`，在深色卡片上只有 2.1:1 的对比度，
 * 达不到 WCAG 1.4.11 对「控件边界」要求的 3:1 —— 方框直接看不见了。
 * 所以这里描边固定用 `--color-border-strong`，不跟全局边框色。
 *
 * 选中态保留蓝色（`--color-switch-checked-solid`，和 [AppSwitch.vue] 同一个）。
 * 黑白灰主题里如果把勾选也做成灰的，勾上了会看着像禁用。
 *
 * ## 三种状态都不能只靠颜色区分
 *
 * 未选中 = 空框 + 描边；选中 = 蓝底 + 白勾；半选 = 蓝底 + 白横杠。
 * 形状本身就分得开，色觉障碍用户不靠颜色也能读。
 */
import { computed, useId } from 'vue'

interface Props {
  checked?: boolean
  /** 半选：一组里选了一部分。视觉上是横杠不是勾 */
  indeterminate?: boolean
  disabled?: boolean
  /** 没有可见文字时必填，否则读屏软件念不出这个框是干什么的 */
  ariaLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
  checked: false,
  indeterminate: false,
  disabled: false,
  ariaLabel: undefined
})

const emit = defineEmits<{
  (e: 'update:checked', value: boolean): void
  (e: 'change', value: boolean): void
}>()

const classes = computed(() => [
  'app-checkbox',
  {
    'app-checkbox--checked': props.checked,
    'app-checkbox--indeterminate': props.indeterminate,
    'app-checkbox--disabled': props.disabled
  }
])

/**
 * 半选时读屏软件要念「mixed」而不是「已勾选」——
 * 念成已勾选的话，用户以为一组全选上了。
 */
const ariaChecked = computed<'true' | 'false' | 'mixed'>(() => {
  if (props.indeterminate) return 'mixed'
  return props.checked ? 'true' : 'false'
})

const labelId = `app-checkbox-label-${useId()}`

function toggle(): void {
  if (props.disabled) return
  // 半选点一下是「全选」，不是取反 —— 取反的话点半选会变成全不选，很反直觉
  const next = props.indeterminate ? true : !props.checked
  emit('update:checked', next)
  emit('change', next)
}
</script>

<template>
  <!--
    外层刻意**不用** <label>：<button> 是 labelable 元素，<label> 会把点击
    转发给它 —— 点文字会先触发这里的 toggle、再被转发触发按钮的 toggle，
    连点两次等于没动，复选框看着像坏了。改成普通 span + aria-labelledby，
    无障碍关联照样成立，点击只走一条路。
  -->
  <span :class="classes">
    <button
      type="button"
      role="checkbox"
      class="app-checkbox__box"
      :aria-checked="ariaChecked"
      :aria-label="ariaLabel"
      :aria-labelledby="$slots.default ? labelId : undefined"
      :disabled="disabled"
      @click="toggle"
    >
      <!-- 勾和横杠都用 SVG 画：字体图标在小尺寸下会被 hinting 挪半个像素 -->
      <svg v-if="indeterminate" class="app-checkbox__mark" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 8h9" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      <svg v-else-if="checked" class="app-checkbox__mark" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3.5 8.5l3 3 6-6.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <span v-if="$slots.default" :id="labelId" class="app-checkbox__label" @click="toggle">
      <slot />
    </span>
  </span>
</template>

<style scoped>
.app-checkbox {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  line-height: 1.5;
}

.app-checkbox--disabled {
  cursor: not-allowed;
  color: var(--color-text-disabled);
}

.app-checkbox__box {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  padding: 0;
  /* 描边必须够重：全局 --color-border 在深色卡片上只有 2.1:1，方框会消失 */
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-on-solid);
  cursor: inherit;
  transition:
    background-color var(--motion-fast) var(--easing-standard),
    border-color var(--motion-fast) var(--easing-standard);
}

.app-checkbox__mark {
  width: 100%;
  height: 100%;
}

.app-checkbox:not(.app-checkbox--disabled):hover .app-checkbox__box {
  border-color: var(--color-switch-checked-solid);
}

.app-checkbox__box:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

.app-checkbox--checked .app-checkbox__box,
.app-checkbox--indeterminate .app-checkbox__box {
  background: var(--color-switch-checked-solid);
  border-color: var(--color-switch-checked-solid);
}

.app-checkbox--checked:not(.app-checkbox--disabled):hover .app-checkbox__box,
.app-checkbox--indeterminate:not(.app-checkbox--disabled):hover .app-checkbox__box {
  background: var(--color-switch-checked-solid-hover);
  border-color: var(--color-switch-checked-solid-hover);
}

/* 禁用换实色而不是降透明度：opacity 会把控件拖到背景上，浅色主题下直接看不见 */
.app-checkbox--disabled .app-checkbox__box {
  background: var(--color-bg-surface-hover);
  border-color: var(--color-border-subtle);
  color: var(--color-text-disabled);
}

.app-checkbox__label {
  min-width: 0;
}
</style>
