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
      <ThinkingProcess
        v-if="message.thinking"
        class="thinking-block"
        :content="message.thinking"
        :is-thinking="message.status === 'typing' && !textContent.trim()"
      />
      <!-- 过程与正文按发生顺序交替，和主聊天页同一套排法 -->
      <template v-if="message.agentProcess !== undefined">
        <template v-for="block in timelineBlocks" :key="block.key">
          <AgentProcessLog
            v-if="block.kind === 'process'"
            class="agent-process"
            compact
            :items="block.items"
            :is-thinking="block.key === liveProcessBlockKey"
            :start-time="blockStartTime(block)"
          />
          <!-- agent 反问用户。和主聊天页同一张卡片，答完就地变只读 -->
          <AskUserCard
            v-else-if="block.kind === 'question'"
            :question="block.question"
            @answer="(action, answers) => onQuestionAnswer(block.question, action, answers)"
          />
          <div v-else class="assistant-card">
            <MarkdownRenderer :content="block.text" :streaming="message.status === 'typing'" />
          </div>
        </template>
      </template>
      <div v-if="showTrailingCard" class="assistant-card">
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
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Mini Chat 消息气泡组件
 * 复用主聊天页的用户气泡与 Agent 思考展示，但保留更紧凑的小窗布局
 */
import { computed, ref } from 'vue'
import { PhArrowClockwise, PhCheck, PhCopy } from '@phosphor-icons/vue'
import MarkdownRenderer from '@renderer/views/Assistant/components/MarkdownRenderer.vue'
import ThinkingProcess from '@renderer/views/Assistant/components/ThinkingProcess.vue'
import AgentProcessLog from '@renderer/views/Assistant/components/AgentProcessLog.vue'
import MessageSources from '@renderer/views/Assistant/components/MessageSources.vue'
import UserBubble from '@renderer/views/Assistant/components/UserBubble.vue'
import AskUserCard from '@renderer/views/Assistant/components/AskUserCard.vue'
import { answerAgentQuestion } from '@renderer/views/Assistant/composables/agentEventDispatcher'
import type { AgentQuestionItem } from '@core/shared/agentQuestion'
import {
  joinTimelineText,
  resolveTrailingContent,
  splitAgentTimeline,
  type AgentTimelineBlock
} from '@renderer/views/Assistant/composables/agentTimeline'
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
const timelineBlocks = computed(() => splitAgentTimeline(props.message.agentProcess || []))

/** 只有最后一段过程还在跑，前面那些已经结束了 */
const liveProcessBlockKey = computed<string | null>(() => {
  if (props.message.status !== 'typing') return null
  const last = timelineBlocks.value[timelineBlocks.value.length - 1]
  return last && last.kind === 'process' ? last.key : null
})

function blockStartTime(block: AgentTimelineBlock): number | undefined {
  if (block.kind !== 'process') return undefined
  if (timelineBlocks.value[0]?.key === block.key) return props.message.startTime
  return block.items[0]?.timestamp
}

/** 用户答完提问卡片。逻辑与主聊天页一致，见 `AIBubble.vue` 里同名函数 */
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

/** 正文已经逐段显示过了就不再补一张空卡片 */
const showTrailingCard = computed(() => {
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

.agent-process,
.thinking-block,
.assistant-card,
.sources {
  margin-bottom: 8px;
}

.assistant-card {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  color: var(--color-text-primary);

  :deep(.markdown-body) {
    font-size: 13px;
    line-height: 1.6;
  }
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
