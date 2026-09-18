<script setup lang="ts">
/**
 * 操作岛里的极简下拉：看得见的是「当前选项 + 箭头」，真正接事件的是压在上面的原生 select。
 *
 * 用原生 select 而不是自绘浮层，是因为它自带键盘操作、屏幕阅读器支持
 * 和「点开后跟随窗口滚动」这些行为，自己写一份只会更差。
 *
 * 原生 select 的宽度跟着**最长的选项**走，选项一长，文字和箭头之间就空出一大截，
 * 几个并排的下拉各自一个间距。所以把它做成透明层，宽度交给显示用的那行字。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue?: string
    options: ReadonlyArray<{ value: string; label: string }>
    /** 给屏幕阅读器用，界面上不显示。不叫 ariaLabel 是因为那会和原生属性撞名 */
    label: string
  }>(),
  { modelValue: '' }
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const currentLabel = computed(() => {
  const hit = props.options.find((option) => option.value === props.modelValue)
  return hit?.label ?? props.options[0]?.label ?? props.label
})
</script>

<template>
  <div class="library-select">
    <span class="select-label" aria-hidden="true">{{ currentLabel }}</span>
    <svg
      class="select-arrow"
      width="10"
      height="6"
      viewBox="0 0 10 6"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M1 1L5 5L9 1"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <select
      class="minimal-select"
      :value="modelValue"
      :aria-label="label"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
  </div>
</template>

<style scoped lang="less">
.library-select {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  transition: color 0.2s;

  &:hover,
  &:focus-within {
    color: var(--color-text-primary);
  }
}

.select-label {
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  line-height: 1.2;
  white-space: nowrap;
}

.select-arrow {
  flex: 0 0 auto;
  color: var(--color-text-muted);
  transition: color 0.2s;
}

.library-select:hover .select-arrow,
.library-select:focus-within .select-arrow {
  color: var(--color-text-secondary);
}

// 透明地铺满整块，点哪都是点它；键盘焦点环画在外层
.minimal-select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  appearance: none;
  border: none;
  outline: none;

  // 原生下拉面板由系统绘制，只能给到背景与文字色
  option {
    background: var(--color-bg-raised);
    color: var(--color-text-secondary);
  }
}

.library-select:has(.minimal-select:focus-visible) {
  box-shadow: 0 0 0 2px var(--color-border-focus);
}
</style>
