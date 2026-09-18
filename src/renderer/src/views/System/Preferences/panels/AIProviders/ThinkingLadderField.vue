<script setup lang="ts">
/**
 * 思考档位阶梯编辑器。
 *
 * 只在**模型编辑弹窗**里出现，而且要用户主动展开 —— 绝大多数人一辈子不用碰
 * 它（内置数据已经对了），摆在模型列表里只会让人以为自己漏配了什么。
 *
 * 取值规则连同它的理由都在 thinkingLadder.ts 里，那边有测试守着。
 */
import {
  LADDER_STATES,
  THINKING_LEVELS,
  ladderState,
  ladderValue,
  setLadderState,
  setLadderValue,
  type LadderState,
  type ThinkingLadder
} from './thinkingLadder'

const props = defineProps<{ modelValue: ThinkingLadder }>()
const emit = defineEmits<{ 'update:modelValue': [value: ThinkingLadder] }>()

function pickState(level: string, state: LadderState): void {
  emit('update:modelValue', setLadderState(props.modelValue, level, state))
}

function typeValue(level: string, event: Event): void {
  const value = (event.target as HTMLInputElement).value
  emit('update:modelValue', setLadderValue(props.modelValue, level, value))
}
</script>

<template>
  <div class="ladder">
    <p class="ladder-hint">{{ $t('aiProvider.model.ladderHint') }}</p>

    <div v-for="level in THINKING_LEVELS" :key="level" class="ladder-row">
      <span class="ladder-level">{{ level }}</span>
      <div class="ladder-states">
        <button
          v-for="option in LADDER_STATES"
          :key="option"
          type="button"
          class="ladder-state-btn"
          :class="{
            active: ladderState(modelValue, level) === option,
            danger: option === 'absent'
          }"
          @click="pickState(level, option)"
        >
          {{ $t(`aiProvider.model.ladderState.${option}`) }}
        </button>
      </div>
      <!--
        输入框常驻、只是不选中时禁用，而不是随状态出现/消失 ——
        每行的宽度就固定了，六行扫下来是整齐的一列。
      -->
      <input
        type="text"
        class="ladder-input"
        :class="{ dim: ladderState(modelValue, level) !== 'custom' }"
        :disabled="ladderState(modelValue, level) !== 'custom'"
        :placeholder="level"
        :value="ladderValue(modelValue, level)"
        @input="typeValue(level, $event)"
      />
    </div>

    <button
      v-if="modelValue"
      type="button"
      class="ladder-reset"
      @click="emit('update:modelValue', undefined)"
    >
      {{ $t('aiProvider.model.ladderReset') }}
    </button>
  </div>
</template>

<style scoped>
.ladder {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ladder-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-muted);
}

.ladder-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 档位名是模型自己的原始词汇（low / xhigh），等宽才好对齐扫读 */
.ladder-level {
  flex: 0 0 60px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--color-text-secondary);
}

.ladder-states {
  display: inline-flex;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
}

.ladder-state-btn {
  padding: 4px 10px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.ladder-state-btn:hover {
  color: var(--color-text-secondary);
}

.ladder-state-btn.active {
  background: var(--color-bg-selected);
  color: var(--color-text-primary);
}

/* 「不可用」是从清单里去掉一档，和另外两档不是一类操作，得看得出来 */
.ladder-state-btn.danger.active {
  background: var(--color-danger-bg);
  color: var(--color-text-primary);
}

.ladder-input {
  flex: 0 0 120px;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-sunken);
  color: var(--color-text-primary);
  font-size: 12px;
}

/* 没选「自定义」时它只是个占位，别让它看着像能填 */
.ladder-input.dim {
  opacity: 0.4;
}

.ladder-reset {
  align-self: flex-start;
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
}
</style>
