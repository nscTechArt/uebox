<template>
  <div :class="['mini-message', message.role]">
    <UserBubble
      v-if="message.role === 'user'"
      :id="message.id"
      :content="message.content"
      @copy="emit('user-copy', $event)"
      @confirm-edit="emit('user-confirm-edit', $event)"
    />

    <div v-else class="assistant-shell">
      <!--
        没在时间线上记推理位置的老消息：推理整段一个框。运行中它折进那一组步骤里，
        小窗一屏只留一行状态；跑完之后变回独立的「思考过程」。
      -->
      <ThinkingProcess
        v-if="message.thinking && !foldThinkingIntoProcess && !timelineHasThinking"
        class="thinking-block"
        :content="message.thinking"
        :is-thinking="message.status === 'typing' && !textContent.trim()"
      />
      <!--
        过程与正文按发生顺序交替，和主对话页同一套排法：相邻的推理和工具调用并成一组，
        默认一行摘要；整轮做完之后，最后一段正文之前的东西收成「用时 · 步数」一行。
      -->
      <template v-if="message.agentProcess !== undefined">
        <RunFoldButton
          v-if="runFold"
          :label="runFold.label"
          :expanded="runExpanded"
          @toggle="toggleRunFold"
        />
        <template v-for="block in visibleBlocks" :key="block.key">
          <AgentStepGroup
            v-if="block.kind === 'steps'"
            :parts="stepParts(block)"
            :live="block.key === liveStepsKey"
            :start-time="blockStartTime(block)"
          />
          <!-- agent 反问用户。和主对话页同一张卡片，答完就地变只读 -->
          <AskUserCard
            v-else-if="block.kind === 'question'"
            :question="block.question"
            @answer="(action, answers) => onQuestionAnswer(block.question, action, answers)"
          />
          <div v-else-if="block.kind === 'text'" class="assistant-text">
            <MarkdownRenderer :content="block.text" :streaming="message.status === 'typing'" />
          </div>
        </template>
        <StepMediaStrip
          v-if="runFold && !runExpanded"
          :images="runFold.images"
          :videos="runFold.videos"
        />
      </template>
      <div v-if="showTrailingCard" class="assistant-text">
        <MarkdownRenderer
          v-if="showMarkdown"
          :content="trailingContent"
          :is-thinking-placeholder="isThinkingPlaceholder"
          :streaming="message.status === 'typing'"
        />
        <div v-else class="typing-indicator">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
      </div>
      <MessageSources
        v-if="message.status === 'done' && message.citations && message.citations.length > 0"
        class="sources"
        :sources="message.citations"
      />
      <div v-if="message.status === 'done'" class="assistant-tools">
        <PhCheck v-if="isCopied" class="tool copied" />
        <PhCopy v-else class="tool" @click="handleAssistantCopy" />
        <PhArrowClockwise
          class="tool"
          @click="emit('retry', { id: message.id, content: textContent })"
        />
        <!-- 朗读。念的和主对话页、自动朗读是同一份：最终答复那一段 -->
        <AppTooltip :title="readAloud.label.value">
          <AppButton
            variant="text"
            class="tool read-aloud-tool"
            :aria-label="readAloud.label.value"
            :aria-pressed="readAloud.active.value"
            :class="{ 'read-aloud-active': readAloud.active.value }"
            @click="readAloud.toggle(readableReply)"
          >
            <PhStop v-if="readAloud.active.value" />
            <PhSpeakerHigh v-else />
          </AppButton>
        </AppTooltip>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Mini Chat 消息气泡组件
 * 复用主对话页的用户气泡与 Agent 思考展示，但保留更紧凑的小窗布局
 */
import { computed, ref, shallowRef, watch } from 'vue'
import { PhArrowClockwise, PhCheck, PhCopy, PhSpeakerHigh, PhStop } from '@phosphor-icons/vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'
import MarkdownRenderer from '@renderer/views/Assistant/components/MarkdownRenderer.vue'
import ThinkingProcess from '@renderer/views/Assistant/components/ThinkingProcess.vue'
import AgentStepGroup from '@renderer/views/Assistant/components/AgentStepGroup.vue'
import RunFoldButton from '@renderer/views/Assistant/components/RunFoldButton.vue'
import StepMediaStrip from '@renderer/views/Assistant/components/StepMediaStrip.vue'
import type { StepPart } from '@renderer/views/Assistant/components/agentSteps'
import MessageSources from '@renderer/views/Assistant/components/MessageSources.vue'
import UserBubble from '@renderer/views/Assistant/components/UserBubble.vue'
import AskUserCard from '@renderer/views/Assistant/components/AskUserCard.vue'
import { answerAgentQuestion } from '@renderer/views/Assistant/composables/agentEventDispatcher'
import { AGENT_RESUME_ACTION } from '@renderer/views/Assistant/composables/agentHandlerShared'
import { finalReplyText } from '@renderer/views/Assistant/composables/finalReplyText'
import { useReadAloud } from '@renderer/views/Assistant/composables/useReadAloud'
import { readVoiceBriefingStyle } from '../composables/miniVoiceAutoPlay'
import type { AgentQuestionItem } from '@core/shared/agentQuestion'
import {
  groupTimelineSteps,
  joinTimelineText,
  reconcileAgentTimeline,
  resolveTrailingContent,
  hasTimelineThinking,
  type AgentDisplayBlock,
  type AgentTimelineBlock,
  type AgentTimelineStepsBlock
} from '@renderer/views/Assistant/composables/agentTimeline'
import { useRunFold } from '@renderer/views/Assistant/composables/useRunFold'
import type { ChatMessage, ChatMessageContent } from '@renderer/store/modules/chatMessages'
import { isTypingPlaceholder } from '@renderer/utils/typingPlaceholder'

const props = defineProps<{
  message: ChatMessage
}>()

const emit = defineEmits<{
  (e: 'retry', payload: { id: string; content: string }): void
  (e: 'copy', payload: { id: string; content: string }): void
  (e: 'user-copy', payload: { id: string; content: string }): void
  (
    e: 'user-confirm-edit',
    payload: { id: string; newContent: string; originalContent: ChatMessageContent }
  ): void
}>()

const isCopied = ref(false)
let copyTimeoutId: ReturnType<typeof setTimeout> | null = null

function extractText(content: ChatMessageContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((item) => item.type === 'text' && item.text)
    .map((item) => item.text)
    .join('\n')
}

const textContent = computed(() => extractText(props.message.content))

const isThinkingPlaceholder = computed(() => {
  return (
    props.message.status === 'typing' &&
    isTypingPlaceholder(textContent.value) &&
    props.message.agentProcess === undefined
  )
})

// ==================== 过程 / 正文交替时间线 ====================
const timelineBlocks = shallowRef<AgentTimelineBlock[]>([])
/** 画在界面上的块：相邻的推理和工具调用并成了步骤组 */
const displayBlocks = shallowRef<AgentDisplayBlock[]>([])

watch(
  () => [props.message.agentProcess, props.message.thinking] as const,
  ([items, thinking]) => {
    timelineBlocks.value = reconcileAgentTimeline(timelineBlocks.value, items || [], thinking)
    displayBlocks.value = groupTimelineSteps(timelineBlocks.value, displayBlocks.value)
  },
  { immediate: true }
)

const timelineHasThinking = computed(() => hasTimelineThinking(props.message.agentProcess))

/** 只有最后一组还在跑。末尾是插话或提问卡片时，前面那组照样算在跑 */
const liveStepsKey = computed<string | null>(() => {
  if (props.message.status !== 'typing') return null
  for (let i = displayBlocks.value.length - 1; i >= 0; i--) {
    const block = displayBlocks.value[i]
    if (block.kind === 'steer' || block.kind === 'question') continue
    return block.kind === 'steps' ? block.key : null
  }
  return null
})

/** 老消息运行中：推理正文折进那一组还在跑的步骤，小窗一屏只留一行状态 */
const foldThinkingIntoProcess = computed(
  () => Boolean(props.message.thinking) && !timelineHasThinking.value && liveStepsKey.value !== null
)

function stepParts(block: AgentTimelineStepsBlock): StepPart[] {
  if (!foldThinkingIntoProcess.value || block.key !== liveStepsKey.value) return block.parts
  return [
    { kind: 'thinking', key: 'legacy-thinking', text: props.message.thinking ?? '' },
    ...block.parts
  ]
}

/** 第一组从用户发消息算起，后面几组从各自第一条事件算起 */
function blockStartTime(block: AgentDisplayBlock): number | undefined {
  if (block.kind !== 'steps') return undefined
  if (displayBlocks.value[0]?.key === block.key) return props.message.startTime
  return undefined
}

const { runFold, runExpanded, visibleBlocks, toggleRunFold } = useRunFold({
  blocks: displayBlocks,
  done: () => props.message.status === 'done',
  items: () => props.message.agentProcess,
  startTime: () => props.message.startTime
})

/** 用户答完提问卡片。逻辑与主对话页一致，见 `AIBubble.vue` 里同名函数 */
function onQuestionAnswer(
  question: AgentQuestionItem,
  action: 'accept' | 'decline',
  answers?: string[]
): void {
  if (!question.sessionId) return
  answerAgentQuestion(question.sessionId, question.toolCallId, action, answers)
}

const timelineText = computed(() => joinTimelineText(props.message.agentProcess || []))

const hasTimelineText = computed(() => timelineText.value.trim().length > 0)

const trailingContent = computed(() =>
  props.message.agentProcess === undefined
    ? textContent.value
    : resolveTrailingContent(textContent.value, timelineText.value)
)

/**
 * 上面是不是已经有一条「这轮还在跑」的指示了 —— 思考框或过程条。
 * 小窗一列只有三百多像素宽，多一个框就是多一屏。
 */
const hasLiveIndicator = computed(
  () => Boolean(props.message.thinking) || displayBlocks.value.length > 0
)

/** 正文已经逐段显示过了就不再补一张空卡片 */
const showTrailingCard = computed(() => {
  // 已经有思考框/过程条在转了，就别再补一张只写着「思考中...」的卡片：
  // 三个框说同一件事，小窗里第一屏就被占满了。
  if (hasLiveIndicator.value && isTypingPlaceholder(trailingContent.value)) return false
  if (!hasTimelineText.value) return true
  return trailingContent.value.trim().length > 0
})

const showMarkdown = computed(() => {
  if (
    props.message.status === 'typing' &&
    !trailingContent.value.trim() &&
    props.message.agentProcess !== undefined
  ) {
    return false
  }
  return props.message.status === 'done' || trailingContent.value.length > 0
})

/*
 * 手动朗读。跟主对话页 `AIBubble` 一样的接法：以消息 id 为主人，于是自动朗读
 * （`autoReadAloud`，小窗里由 `MiniChatWindow` 挂上）念到这条时按钮会正确显示成「停止」。
 * 播报风格不读本窗口的 store —— 它是启动时抄的旧账，理由见 `miniVoiceAutoPlay`。
 * 只在开念那一刻读一次 localStorage，不给每条气泡都挂一个 storage 监听。
 */
const readAloud = useReadAloud(
  () => props.message.id,
  () => readVoiceBriefingStyle()
)
const readableReply = computed(() =>
  finalReplyText(
    textContent.value,
    props.message.agentProcess,
    props.message.actionButtons?.some((button) => button.action === AGENT_RESUME_ACTION)
  )
)
/* 这一条又开始重跑了（重试、续跑）：念的是上一版，掐掉。只认 done → typing 这一个方向 */
watch(
  () => props.message.status,
  (status, previous) => {
    if (status === 'typing' && previous === 'done') readAloud.stop()
  }
)

function handleAssistantCopy(): void {
  emit('copy', { id: props.message.id, content: textContent.value })

  isCopied.value = true
  if (copyTimeoutId) {
    clearTimeout(copyTimeoutId)
  }
  copyTimeoutId = setTimeout(() => {
    isCopied.value = false
    copyTimeoutId = null
  }, 2000)
}
</script>

<style scoped lang="less">
.mini-message {
  width: 100%;

  &.assistant {
    display: flex;
    justify-content: flex-start;
  }
}

.assistant-shell {
  width: 100%;
  max-width: 100%;
}

.thinking-block,
.sources {
  margin-bottom: 8px;
}

// 模型说的话不再套卡片：和主对话页一样直接铺在底上，层次靠字色深浅而不是框
.assistant-text {
  margin-bottom: var(--space-2);

  :deep(.markdown-body) {
    font-size: 13px;
    line-height: var(--line-height-relaxed);
    color: color-mix(in srgb, var(--color-text-primary) 88%, var(--color-bg-page));
  }
}

// 小窗只有三百多像素宽：步骤组和收起行贴得紧一点
.assistant-shell :deep(.step-group),
.assistant-shell :deep(.run-fold) {
  margin-bottom: var(--space-2);
}

// 主对话页 96px 高的缩略图在这里一行只放得下两张，四张就叠成一大块
.assistant-shell :deep(.step-thumb:not(.small)) {
  height: 64px;
}

.assistant-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-left: 4px;
}

.tool {
  font-size: 13px;
  color: var(--color-text-primary);
  cursor: pointer;
  transition: color 0.15s;

  &:hover {
    color: var(--color-text-primary);
  }

  &.copied {
    color: var(--color-success-text);
  }
}

/* 把 AppButton 的按钮外形抹掉，让它和旁边两个裸图标一般大 */
.read-aloud-tool {
  padding: 0;
  min-width: 0;
  height: auto;
  line-height: 1;
  font-size: 13px;
}

.read-aloud-active {
  color: var(--color-accent-text);
}

.typing-indicator {
  display: flex;
  gap: 4px;
  padding: 2px 0;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-bg-surface-hover);
  animation: pulse 1.4s infinite ease-in-out;

  &:nth-child(1) {
    animation-delay: -0.32s;
  }

  &:nth-child(2) {
    animation-delay: -0.16s;
  }
}

@keyframes pulse {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }

  40% {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
