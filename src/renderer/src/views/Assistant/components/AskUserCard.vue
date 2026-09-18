<template>
  <div class="ask-user-card" :class="{ answered: !pending }">
    <div class="ask-user-head">
      <span class="ask-user-title">{{ t('assistant.askUser.title') }}</span>
      <!-- 多问时才显示进度。只有一问还标个「1 / 1」是在制造不存在的步骤感 -->
      <span v-if="pending && questions.length > 1" class="ask-user-step">
        {{ t('assistant.askUser.step', { current: step + 1, total: questions.length }) }}
      </span>
      <span class="ask-user-state" :class="stateClass">{{ stateLabel }}</span>
    </div>

    <!--
      答完之后**留在原地**变成只读：只列出被选中的那条，其余收起。
      卡片消失的话，用户回头就看不到自己当初选了什么 —— 而那正是他后来
      想确认「为什么做成这样」时唯一的凭据。
    -->
    <!--
      **一次只画一问。** 模型一次最多能问三问，三问全铺开是九个选项加三个输入框，
      用户面对的是一堵墙而不是一个问题 —— 而这个功能的全部意义就是让他快速定一件事。
    -->
    <template v-if="pending">
      <div class="ask-user-question">
        <div class="ask-user-question-head">
          <span class="ask-user-header">{{ current.header }}</span>
          <span class="ask-user-text">{{ current.question }}</span>
        </div>

        <button
          v-for="(option, oi) in current.options"
          :key="oi"
          type="button"
          class="ask-user-option"
          :class="{ selected: isSelected(step, option.label) }"
          @click="selectOption(step, option.label, current.multiSelect)"
        >
          <span class="ask-user-option-label">{{ option.label }}</span>
          <span class="ask-user-option-desc">{{ option.description }}</span>
        </button>

        <!--
          「其他」恒定提供，不由模型放进选项里 —— 写进 schema 的话它会忘了给，
          而这个出口必须永远在：选项列全了也不代表用户想要的就在里面。
        -->
        <div class="ask-user-option ask-user-other" :class="{ selected: isOtherActive(step) }">
          <span class="ask-user-option-label">{{ t('assistant.askUser.other') }}</span>
          <input
            v-model="custom[step]"
            class="ask-user-other-input"
            type="text"
            :placeholder="t('assistant.askUser.otherPlaceholder')"
            @keydown.enter.prevent="advance"
          />
        </div>
      </div>

      <div class="ask-user-actions">
        <button type="button" class="ask-user-btn ghost" @click="decline">
          {{ t('assistant.askUser.decline') }}
        </button>
        <button v-if="step > 0" type="button" class="ask-user-btn ghost" @click="back">
          {{ t('assistant.askUser.back') }}
        </button>
        <button type="button" class="ask-user-btn primary" @click="advance">
          {{ isLast ? t('assistant.askUser.submit') : t('assistant.askUser.next') }}
        </button>
      </div>
      <div class="ask-user-hint">{{ t('assistant.askUser.declineHint') }}</div>
    </template>

    <template v-else>
      <div v-for="(q, qi) in questions" :key="qi" class="ask-user-answered">
        <span class="ask-user-header">{{ q.header }}</span>
        <span class="ask-user-answer">{{ answerLabel(qi) }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * Agent 反问用户的选项卡片。
 *
 * ## 为什么是卡片不是弹窗
 *
 * 审批用模态是对的（阻断性、危险动作，用户必须当场处理）。提问不是：它是
 * 对话的一部分，滚上去还应该能看到「当时问了什么、我选了什么」。做成模态
 * 之后这段历史无处可去，而它恰恰是最该留下的那一段 —— agent 后面做的每一步
 * 都建立在这个回答上。
 *
 * ## 一次只问一问
 *
 * 模型一次最多能问三问（`ask_user` 的 schema 上限）。三问全铺开是九个选项
 * 加三个输入框，用户面对的是一堵墙 —— 真机上第一次触发就长这样。分步之后
 * 屏幕上永远只有一个问题和它的选项。
 *
 * **单选选中即自动进入下一问，但最后一问不自动提交。** 中间几步只是换页，
 * 用户选完没必要再点一次「下一步」；选错了可以点「上一步」回来改。真正
 * 提交是不可逆的一步（会触发 IPC 回传给模型），所以留给最后一问的按钮，
 * 不因为选中就自动带走。多选题没有「选完」这个信号，不自动前进。
 * 不选任何东西直接点下一步 = 跳过这一问，不需要单独的跳过按钮。
 *
 * ## 没有 1/2/3/4 数字快捷键
 *
 * 参考实现（Claude Code、Cline）都在终端里，那儿没有别的东西抢键盘。这里
 * 底下就是输入框，绑全局数字键会让用户没法打字 —— 而运行途中插话是这个
 * 应用里第一等重要的交互。只保留「其他」输入框里按回车走下一步。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { AgentQuestionItem } from '@core/shared/agentQuestion'

const props = defineProps<{ question: AgentQuestionItem }>()

const emit = defineEmits<{
  (e: 'answer', action: 'accept' | 'decline', answers?: string[]): void
}>()

const { t } = useI18n()

const questions = computed(() => props.question.questions ?? [])

/** 还没答的卡片才可点。答过的（含被取消的）一律只读 */
const pending = computed(() => !props.question.action)

/** 每一问选中的标签。多选时可以有好几个 */
const picked = ref<string[][]>(questions.value.map(() => []))
/** 每一问「其他」里填的字 */
const custom = ref<string[]>(questions.value.map(() => ''))

/** 现在停在第几问（0 起）。分步只影响显示，答案照样按下标存满整份 */
const step = ref(0)

const current = computed(() => questions.value[step.value])
const isLast = computed(() => step.value >= questions.value.length - 1)

function isSelected(qi: number, label: string): boolean {
  return (picked.value[qi] ?? []).includes(label)
}

/** 「其他」里写了字就算它生效 —— 不需要用户再点一下那一行 */
function isOtherActive(qi: number): boolean {
  return Boolean(custom.value[qi]?.trim())
}

function toggle(qi: number, label: string, multiSelect: boolean): void {
  const current = picked.value[qi] ?? []

  if (!multiSelect) {
    // 单选再点一次就是取消 —— 否则选错了没法退回「什么都没选」
    picked.value[qi] = current.includes(label) ? [] : [label]
    return
  }

  picked.value[qi] = current.includes(label)
    ? current.filter((item) => item !== label)
    : [...current, label]
}

/**
 * 点选项。单选且不是最后一问时，选中就自动翻到下一问；多选或最后一问
 * 只更新选中状态，翻页/提交仍交给下面的「下一步」/「提交」按钮。
 */
function selectOption(qi: number, label: string, multiSelect: boolean): void {
  toggle(qi, label, multiSelect)
  if (multiSelect || isLast.value || !isSelected(qi, label)) return
  advance()
}

/**
 * 一问的最终答案。
 *
 * 「其他」和选项**可以同时有**（多选时用户既想要 A 又有补充），拼在一起给模型；
 * 空串表示这一问没答，主进程那边会照实说「用户跳过了这一问」。
 */
function answerFor(qi: number): string {
  const parts = [...(picked.value[qi] ?? [])]
  const extra = custom.value[qi]?.trim()
  if (extra) parts.push(extra)
  return parts.join('、')
}

/**
 * 「下一步」/「提交」。
 *
 * 走到最后一问才真正回传，中间几步只是换页 —— 主进程那边是一次往返，
 * 分几步答完是纯界面的事，不该变成三次 IPC。
 *
 * 什么都没选就点下一步 = 跳过这一问，不需要单独的跳过按钮。
 */
function advance(): void {
  if (!isLast.value) {
    step.value += 1
    return
  }

  emit(
    'answer',
    'accept',
    questions.value.map((_, qi) => answerFor(qi))
  )
}

function back(): void {
  if (step.value > 0) step.value -= 1
}

function decline(): void {
  emit('answer', 'decline')
}

const stateLabel = computed(() => {
  const action = props.question.action
  if (!action) return t('assistant.askUser.waiting')
  if (action === 'decline') return t('assistant.askUser.declined')
  if (action === 'cancel') return t('assistant.askUser.cancelled')
  return t('assistant.askUser.answered')
})

const stateClass = computed(() => {
  const action = props.question.action
  if (!action) return 'waiting'
  return action === 'accept' ? 'done' : 'muted'
})

/** 只读态下这一问显示什么。没选的明说「没选」，别留一片空白让人以为界面坏了 */
function answerLabel(qi: number): string {
  const answer = props.question.answers?.[qi]?.trim()
  return answer || t('assistant.askUser.skippedOne')
}
</script>

<style scoped lang="less">
.ask-user-card {
  margin-bottom: 10px;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-surface);

  &.answered {
    background: transparent;
    border-color: var(--color-border-subtle);
  }
}

.ask-user-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.ask-user-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

// 进度只是辅助信息，不该和标题抢注意力 —— 靠右挤在状态字左边
.ask-user-step {
  margin-left: auto;
  margin-right: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-family: var(--font-family-numeric);
}

.ask-user-state {
  font-size: var(--font-size-xs);

  &.waiting {
    color: var(--color-accent-text);
  }

  &.done {
    color: var(--color-success-text);
  }

  &.muted {
    color: var(--color-text-muted);
  }
}

.ask-user-question + .ask-user-question {
  margin-top: var(--space-3);
}

.ask-user-question-head {
  margin-bottom: var(--space-2);
}

.ask-user-header {
  display: inline-block;
  margin-right: var(--space-2);
  padding: 0 var(--space-1);
  border-radius: var(--radius-xs);
  background: var(--color-bg-sunken);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.ask-user-text {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.ask-user-option {
  display: block;
  width: 100%;
  margin-bottom: var(--space-1);
  padding: var(--space-2);
  border: 1px solid var(--color-border-option);
  border-radius: var(--radius-md);
  background: var(--color-bg-option);
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast) var(--easing-standard);

  &:hover {
    background: var(--color-bg-option-hover);
  }

  &.selected {
    background: var(--color-bg-option-selected);
    border-color: var(--color-accent-border);
  }
}

.ask-user-option-label {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
}

.ask-user-option-desc {
  display: block;
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: var(--line-height-normal);
}

// 「其他」那一行不是按钮：里面有输入框，整行可点会让点输入框也触发选中
.ask-user-other {
  cursor: default;
}

.ask-user-other-input {
  width: 100%;
  margin-top: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-page);
  color: var(--color-text-primary);
  font-size: var(--font-size-xs);
  outline: none;

  &:focus {
    border-color: var(--color-border-focus);
  }
}

.ask-user-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.ask-user-btn {
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  cursor: pointer;

  &.ghost {
    border: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-text-secondary);

    &:hover {
      background: var(--color-bg-surface-hover);
    }
  }

  &.primary {
    border: 1px solid var(--color-accent-solid);
    background: var(--color-accent-solid);
    color: var(--color-text-on-solid);

    &:hover {
      background: var(--color-accent-solid-hover);
    }
  }
}

.ask-user-hint {
  margin-top: var(--space-1);
  text-align: right;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.ask-user-answered {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);

  & + & {
    margin-top: var(--space-1);
  }
}

.ask-user-answer {
  color: var(--color-text-primary);
  word-break: break-word;
}
</style>
