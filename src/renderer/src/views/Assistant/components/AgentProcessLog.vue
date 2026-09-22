<template>
  <div v-if="shouldRenderProcessLog" class="agent-process-log" :class="{ compact: props.compact }">
    <button
      type="button"
      class="process-header"
      :aria-expanded="!isCollapsed"
      @click="toggleCollapse"
    >
      <div class="header-left">
        <span class="status-icon" :class="{ spinning: isThinking }">
          <PhCircleNotch v-if="isThinking" />
          <PhCheckCircle v-else />
        </span>
        <span class="header-title">{{ headerDisplayTitle }}</span>
      </div>
      <div class="header-right">
        <span v-if="duration" class="duration">{{ duration }}s</span>
        <PhCaretDown class="collapse-icon" :class="{ expanded: !isCollapsed }" />
      </div>
    </button>

    <div
      v-show="!isCollapsed"
      ref="processBodyRef"
      class="process-body"
      @scroll="handleProcessBodyScroll"
    >
      <!-- 进度气泡区：紧凑显示 progress/success，可展开查看详情 -->
      <div
        v-if="reportItems.length > 0"
        ref="reportListRef"
        class="report-list"
        @scroll="handleReportListScroll"
      >
        <div ref="reportListInnerRef" class="report-list-inner">
          <template v-for="item in reportItems" :key="item.key">
            <!--
            一路子任务一张卡：并行派出去的几路各占一张，用户一眼看得出有几路在跑、
            各自跑到哪。扁平成日志行的话它们的进度文本一模一样，分不开。
          -->
            <div v-if="item.subtask" class="subtask-card" :class="`subtask-${item.subtask.status}`">
              <!--
                整张卡是一个开关：合着看一行标题，点开看派出去的完整任务书。
                模型写的 prompt 常常是一整段（约束、验收标准、不许动什么），
                只显示一行的话，用户没办法核对到底派了什么出去。
              -->
              <button
                type="button"
                class="subtask-head"
                :aria-expanded="expandedSubtasks.has(item.subtask.callId)"
                @click="toggleSubtaskPrompt(item.subtask)"
              >
                <PhCircleNotch v-if="item.subtask.status === 'running'" class="subtask-icon live" />
                <PhCheckCircle v-else-if="item.subtask.status === 'success'" class="subtask-icon" />
                <PhWarningCircle v-else class="subtask-icon" />
                <span class="subtask-label">{{
                  t('assistant.agentProcess.subtask.label', { index: item.subtask.index })
                }}</span>
                <span class="subtask-status">{{ subtaskStatusText(item.subtask) }}</span>
                <span class="subtask-elapsed">{{ subtaskElapsed(item.subtask) }}s</span>
                <PhCaretDown
                  class="subtask-caret"
                  :class="{ expanded: expandedSubtasks.has(item.subtask.callId) }"
                />
              </button>
              <p class="subtask-title">
                {{ item.subtask.title || t('assistant.agentProcess.subtask.untitled') }}
              </p>
              <p v-if="expandedSubtasks.has(item.subtask.callId)" class="subtask-prompt">
                {{ item.subtask.prompt || t('assistant.agentProcess.subtask.untitled') }}
              </p>
              <p v-if="subtaskDetail(item.subtask)" class="subtask-detail">
                <span class="subtask-detail-text">{{ subtaskDetail(item.subtask) }}</span>
                <span v-if="item.subtask.steps > 0" class="subtask-steps">{{
                  t('assistant.agentProcess.subtask.steps', { count: item.subtask.steps })
                }}</span>
              </p>
            </div>
            <div v-else class="report-item" :class="`report-${item.type}`">
              <span class="report-icon">{{ item.icon }}</span>
              <div class="report-body">
                <span class="report-text">{{ item.text }}</span>
                <FileChangeCard v-if="item.fileChange" :change="item.fileChange" />
                <p v-if="item.fileChangeUnavailable">{{ t('assistant.fileDiff.unavailable') }}</p>
                <!-- 截图 / 预览 / 生图类工具产出的图，点开看大图 -->
                <div v-if="visibleImages(item).length > 0" class="report-images">
                  <img
                    v-for="image in visibleImages(item)"
                    :key="image"
                    class="report-image"
                    :src="image"
                    :alt="t('assistant.agentProcess.resultImageAlt')"
                    :title="t('assistant.agentProcess.resultImageHint')"
                    loading="lazy"
                    @click="openReportImage(image)"
                    @error="markImageBroken(image)"
                    @load="onReportImageLoad"
                  />
                </div>
                <!--
                agent 看过的图。收起时只是一行按钮 —— 它的输入可能一轮十几张，
                全铺开会把过程日志淹掉；但人得有办法看见它到底在看什么。
              -->
                <div v-if="item.peekImages?.length" class="report-peek">
                  <button type="button" class="peek-toggle" @click="togglePeekImages(item)">
                    <PhImage />
                    <span>{{
                      expandedPeeks.has(item.key)
                        ? t('assistant.agentProcess.peekImageHide')
                        : t('assistant.agentProcess.peekImageShow', {
                            count: item.peekImages.length
                          })
                    }}</span>
                  </button>
                  <div v-if="visiblePeekImages(item).length > 0" class="report-images">
                    <img
                      v-for="image in visiblePeekImages(item)"
                      :key="image"
                      class="report-image"
                      :src="image"
                      :alt="t('assistant.agentProcess.resultImageAlt')"
                      :title="t('assistant.agentProcess.resultImageHint')"
                      @click="openReportImage(image)"
                      @error="markImageBroken(image)"
                      @load="onReportImageLoad"
                    />
                  </div>
                </div>
                <!--
                生成的视频原地播放。
                · 不自动播放：过程日志会一路往下滚，突然出声很唐突
                · preload=metadata：只取首帧和时长，不为一条可能没人点的视频拉几十兆
              -->
                <div v-if="item.videos?.length" class="report-videos">
                  <video
                    v-for="video in item.videos"
                    :key="video"
                    class="report-video"
                    :src="video"
                    controls
                    preload="metadata"
                    playsinline
                  />
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>

      <div v-if="reportItems.length === 0 && progressBubbles.length > 0" class="progress-bubbles">
        <AppTooltip
          v-for="(bubble, index) in progressBubbles"
          :key="index"
          placement="top"
          :title="bubble.message"
        >
          <div class="bubble" :class="`bubble-${bubble.type}`">
            <span class="bubble-icon">{{ bubble.icon }}</span>
            <span class="bubble-text">{{ bubble.shortText }}</span>
          </div>
        </AppTooltip>
      </div>

      <!-- Thinking 主体区：AI 的思考过程，淡化显示 -->
      <!-- 使用 v-show 避免 DOM 元素被移除导致的闪动 -->
      <div v-show="displayThinking" class="thinking-section">
        <div class="thinking-header">
          <PhCircleNotch v-if="isThinking" class="thinking-icon is-live" />
          <PhLightning v-else class="thinking-icon" />
          <span>{{ t('assistant.agentProcess.thinking') }}</span>
        </div>
        <div class="thinking-content">
          <!-- 面板收起时不挂载重型 Markdown 渲染器，避免隐藏内容持续抢主线程。 -->
          <MarkdownRenderer
            v-if="!isCollapsed"
            :content="displayThinking"
            :streaming="isThinking"
          />
        </div>
      </div>

      <!-- 工具调用详情：折叠显示 -->
      <details v-if="reportItems.length === 0 && toolItems.length > 0" class="tool-details">
        <summary class="tool-summary">
          <PhWrench />
          <span>{{ t('assistant.agentProcess.toolCalls') }} ({{ toolItems.length }})</span>
        </summary>
        <div class="tool-list">
          <div v-for="(item, index) in toolItems" :key="index" class="tool-item">
            <div v-if="item.type === 'tool-call'" class="tool-call-compact">
              <span class="tool-name">{{ formatToolName(getToolName(item.data)) }}</span>
              <span class="tool-args">{{
                formatArgsCompact(getToolArgs(item.data), getToolName(item.data))
              }}</span>
            </div>
            <div v-else-if="item.type === 'tool-result'" class="tool-result-compact">
              <component
                :is="getResultIcon(item.data.result)"
                class="result-icon"
                :class="getResultClass(item.data.result)"
              />
              <span class="result-text">{{
                formatResultCompact(item.data.result, item.data.toolName)
              }}</span>
            </div>
          </div>
        </div>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppTooltip from '@renderer/components/AppTooltip.vue'
import FileChangeCard from './FileChangeCard.vue'
import { readFileChange, type FileChange } from '../../../../../shared/fileChange'
import {
  ref,
  computed,
  watch,
  nextTick,
  onUnmounted,
  onMounted,
  onActivated,
  onDeactivated,
  shallowRef,
  watchEffect
} from 'vue'
import {
  PhCaretDown,
  PhCheck,
  PhCheckCircle,
  PhCircleNotch,
  PhImage,
  PhLightning,
  PhWarningCircle,
  PhWrench,
  PhXCircle
} from '@phosphor-icons/vue'
import { useI18n } from 'vue-i18n'
import MarkdownRenderer from './MarkdownRenderer.vue'
import { openSingleImage } from '@renderer/services/imageViewer'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import { isPreviewableImageRef } from './markdownMediaPreview'
import type { AgentProcessItem } from './AgentProcessLog.types'
import { buildSubtaskView, countRunningLanes, type SubtaskLane } from './agentSubtasks'
import {
  getToolArgs,
  getToolName,
  normalizeToolName,
  parseStructuredValue
} from './agentToolCallData'

const { t } = useI18n()

const props = defineProps<{
  items: AgentProcessItem[]
  isThinking: boolean
  startTime?: number // 从用户发送消息时开始的时间戳
  compact?: boolean
  /**
   * 外部塞进来的推理正文（模型的 reasoning）。
   * 小窗把原本独立的那个「思考过程」框折进这里：运行中只留一条单行状态，
   * 推理和工具步骤一起躲在同一个折叠里，点开才看。
   */
  thinking?: string
}>()

// 执行步骤默认只露出摘要；需要细节时用户再展开，避免流式期间同时更新大块 DOM。
const isCollapsed = ref(true)
const startTime = ref<number>(props.startTime || Date.now())
const duration = ref<string>('')
/**
 * 每秒走一格的「现在」。
 *
 * 跑着的子任务卡片要显示各自的实时耗时，而它们的起点各不相同（并行派出的
 * 几路差几秒），不能共用表头那一个 `duration`。计时器是同一个，多一个 ref 而已。
 */
const nowTick = ref<number>(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
const hasThinking = ref(false)
const reportListRef = ref<HTMLElement | null>(null)
const reportListInnerRef = ref<HTMLElement | null>(null)
const shouldAutoScrollReports = ref(true)
const processBodyRef = ref<HTMLElement | null>(null)
const shouldAutoScrollBody = ref(true)

function isNearBottom(element: HTMLElement, threshold = 24): boolean {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - threshold
}

function handleReportListScroll(): void {
  const element = reportListRef.value
  if (!element) return
  shouldAutoScrollReports.value = isNearBottom(element)
}

function handleProcessBodyScroll(): void {
  const element = processBodyRef.value
  if (!element) return
  shouldAutoScrollBody.value = isNearBottom(element)
}

async function scrollProcessBodyToBottom(force = false): Promise<void> {
  await nextTick()
  const element = processBodyRef.value
  if (!element) return
  if (!force && !shouldAutoScrollBody.value) return
  element.scrollTop = element.scrollHeight
}

async function scrollReportListToBottom(force = false): Promise<void> {
  await nextTick()
  const element = reportListRef.value
  if (!element) return
  if (!force && !shouldAutoScrollReports.value) return
  element.scrollTop = element.scrollHeight
}

/**
 * 懒加载图片在条目数不变的情况下撑高内容，把已滚到底的列表又顶离底部；
 * 加载完成后再贴一次底。
 */
function onReportImageLoad(): void {
  void scrollReportListToBottom()
}

/**
 * 监听思考状态变化：思考时展开并启动计时器，完成后折叠并计算最终时长
 */
// 监听 startTime prop 变化
watch(
  () => props.startTime,
  (newVal) => {
    if (newVal) {
      startTime.value = newVal
    }
  },
  { immediate: true }
)

watch(
  () => props.isThinking,
  (newVal) => {
    if (newVal) {
      // AI开始思考时，不自动展开，只启动计时器
      hasThinking.value = true
      // 优先使用传入的startTime，如果没有则使用第一条过程条目的时间，最后使用当前时间
      if (props.startTime) {
        startTime.value = props.startTime
      } else if (props.items.length > 0) {
        startTime.value = props.items[0].timestamp
      } else {
        startTime.value = Date.now()
      }
      // 启动计时器实时更新
      if (timer) clearInterval(timer)
      timer = setInterval(updateDuration, 1000)
    } else {
      // AI完成回复后，停止计时器但不自动折叠，保持展开状态让用户查看工具调用情况
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      // 计算最终时长：若刚结束思考，做最后一次更新；否则按历史消息计算
      if (hasThinking.value) {
        updateDuration()
      } else {
        calculateDurationFromItems()
      }
      // 小窗优先显示最终回复；过程仍可从摘要行重新展开。
      if (props.compact) {
        isCollapsed.value = true
      }
    }
  },
  { immediate: true }
)

/**
 * 组件激活时：
 * 1. 如果处于思考状态且没有计时器（刚从后台恢复），重启计时器
 * 2. 如果不处于思考状态但有计时器（后台任务结束），清理计时器
 */
onActivated(() => {
  if (props.isThinking) {
    if (!timer) {
      // 恢复由于后台运行而停止的计时器
      timer = setInterval(updateDuration, 1000)
    }
    // 立即更新一次显示
    updateDuration()
  } else if (timer) {
    // 任务在后台已完成，停止计时器
    clearInterval(timer)
    timer = null
    // 确保最终时长正确
    if (hasThinking.value) {
      updateDuration()
    } else {
      calculateDurationFromItems()
    }
  }
})

/**
 * 组件失活时：
 * 暂停计时器以节省资源，反正用户看不见
 * 状态恢复由 onActivated 接管
 */
onDeactivated(() => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
})

/**
 * 内容高度变化（图片加载、Markdown 渲染完成）时重新贴底。
 * 观察的是 report-list 的内层包裹元素：滚动容器本身高度封顶后不再变化，
 * 真正变高的是里面的内容。
 */
let stickToBottomObserver: ResizeObserver | null = null

onMounted(() => {
  // jsdom（单测环境）没有 ResizeObserver
  if (typeof ResizeObserver === 'undefined') return
  stickToBottomObserver = new ResizeObserver(() => {
    if (isCollapsed.value) return
    void scrollReportListToBottom()
    void scrollProcessBodyToBottom()
  })
  if (reportListInnerRef.value) {
    stickToBottomObserver.observe(reportListInnerRef.value)
  }
  if (processBodyRef.value) {
    stickToBottomObserver.observe(processBodyRef.value)
  }
})

// report-list 是 v-if 的，首条日志到达时再补挂观察
watch(reportListInnerRef, (element) => {
  if (element && stickToBottomObserver) {
    stickToBottomObserver.observe(element)
  }
})

/**
 * 组件卸载时清理
 */
onUnmounted(() => {
  if (timer) clearInterval(timer)
  stickToBottomObserver?.disconnect()
  stickToBottomObserver = null
})

/**
 * 切换折叠状态
 */
function toggleCollapse(): void {
  isCollapsed.value = !isCollapsed.value
}

/**
 * 进度气泡类型定义
 */
interface ProgressBubble {
  type: string
  icon: string
  shortText: string
  message: string
}

interface ReportItem {
  fileChange?: FileChange
  fileChangeUnavailable?: boolean
  key: string
  type: 'progress' | 'success' | 'warning' | 'info'
  icon: string
  text: string
  /** 这一步产出的图片（已经是渲染进程能直接加载的 URL）。生图一次可能出好几张 */
  images?: string[]
  /**
   * 这一步**看过**的图（不是产出的）。默认收起，点一下才加载。
   *
   * 和 `images` 分开：产出的图是这一步的结果，人当然要立刻看见；看过的图是
   * agent 的输入，一轮里可能连着看十几张，全铺开会把过程日志淹掉。收起时
   * `<img>` 根本不挂载，也就不会为没人点的图去读一遍盘。
   */
  peekImages?: string[]
  /**
   * 这一步产出的视频。
   *
   * 与图分开而不是合成一个 media 数组：`<img>` 和 `<video>` 是两种标签、
   * 两套交互（图点开看大图，视频原地播放），合在一起每处都要再判一次类型。
   */
  videos?: string[]
  /**
   * 这一条是一路子任务（`task`）的泳道卡片，不是普通的一行日志。
   *
   * 卡片长在「派出去的那一刻」，之后这一路的进度和结论都写回同一张卡 ——
   * 并行的几路因此各占一张，用户一眼看得出有几路在跑（见 `agentSubtasks.ts`）。
   */
  subtask?: SubtaskLane
}

/**
 * 加载不出来的图（文件被移动或删掉了）。记下来就不再占位，
 * 不然会留一个碎图图标在过程日志里。
 */
const brokenImages = ref(new Set<string>())

function markImageBroken(src: string): void {
  const next = new Set(brokenImages.value)
  next.add(src)
  brokenImages.value = next
}

function openReportImage(src: string): void {
  void openSingleImage(src, t('assistant.agentProcess.resultImageAlt'))
}

/** 这一步还能显示出来的图。加载失败的那些直接不占位 */
function visibleImages(item: ReportItem): string[] {
  return (item.images ?? []).filter((image) => !brokenImages.value.has(image))
}

/**
 * 已经展开的「看过的图」，按条目 key 记。
 *
 * 记 key 不记路径：同一张图 agent 可能在一轮里看两次，用户展开的是**那一步**，
 * 不是"这张图从此都展开"。
 */
const expandedPeeks = ref(new Set<string>())

function togglePeekImages(item: ReportItem): void {
  const next = new Set(expandedPeeks.value)
  if (next.has(item.key)) next.delete(item.key)
  else next.add(item.key)
  expandedPeeks.value = next
}

/** 这一步「看过的图」里还能显示出来的。展开之前不算 —— 收起时不该去读盘 */
function visiblePeekImages(item: ReportItem): string[] {
  if (!expandedPeeks.value.has(item.key)) return []
  return (item.peekImages ?? []).filter((image) => !brokenImages.value.has(image))
}

/**
 * 缓存上一次非空的进度气泡列表，用于防止闪烁
 */
const cachedProgressBubbles = shallowRef<ProgressBubble[]>([])

/**
 * 进度气泡：将 progress/success 类型的通知转换为紧凑的气泡（原始计算）
 */
const rawProgressBubbles = computed(() => {
  const bubbles: ProgressBubble[] = []

  for (const item of props.items) {
    if (item.type === 'notify-users') {
      const notifyType = item.data.notifyType
      if (notifyType === 'progress' || notifyType === 'success' || notifyType === 'warning') {
        const message = item.data.message || ''
        // 提取简短文本（第一行或前30字符）
        const shortText = message.split('\n')[0].slice(0, 40) + (message.length > 40 ? '...' : '')
        const icon = notifyType === 'success' ? '✅' : notifyType === 'warning' ? '⚠️' : '🔧'
        bubbles.push({
          type: notifyType,
          icon,
          shortText,
          message
        })
      }
    }
  }

  return bubbles
})

/**
 * 使用 watchEffect 管理进度气泡缓存更新
 * 防止在 items 更新导致短暂空数组时 UI 闪烁
 */
watchEffect(() => {
  const current = rawProgressBubbles.value

  if (current.length > 0) {
    // 有新的气泡数据，更新缓存
    cachedProgressBubbles.value = [...current]
  } else if (!props.isThinking) {
    // 思考已结束且没有新内容，清空缓存
    cachedProgressBubbles.value = []
  }
  // 如果当前为空但仍在思考中，保持缓存不变
})

/**
 * 最终的进度气泡（带防闪烁缓存）
 * - 如果当前有有效内容，返回当前内容
 * - 如果当前为空但仍在思考中，返回缓存内容
 * - 如果已完成思考，返回当前（可能为空）
 */
const progressBubbles = computed(() => {
  const current = rawProgressBubbles.value

  if (current.length > 0) {
    return current
  }

  // 当前为空，如果还在思考中，返回缓存内容防止闪烁
  if (props.isThinking && cachedProgressBubbles.value.length > 0) {
    return cachedProgressBubbles.value
  }

  return current
})

function trimReportText(text: string, maxLength = 96): string {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (!normalized) return ''
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized
}

function normalizeReportText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function normalizeDedupKey(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[。．，,！!？?；;:：.…]+$/g, '')
}

/**
 * 过程通知**原样显示**，不做二次编辑。
 *
 * 这里原本有一整张改写表：把 V2 官方网关发来的英文状态
 * （`X started the task.`、`Success: ...`、`The agent is adjusting its
 * execution strategy.`）翻成第一人称中文（「我发现当前方案不理想，正在调整
 * 执行策略。」）。V3 直连内核，那些英文状态一条都不会再出现，整张表是死的。
 *
 * 还有一条更糟的：短的 progress 消息会被套上「正在处理：」前缀 ——
 * 界面上那句「正在处理: 匹配合适的专家」就是这么来的，凭空给别人的文本
 * 加了一层它自己都不知道对不对的解释。
 *
 * 现在能走到这里的只有真实发生的事：工具的流式进度、上下文压缩提示、
 * 用户插话、知识库命中。它们在发出的地方就已经写清楚了，这里不该再插一手。
 */
function formatNotifyReportText(message: string): string {
  return message.trim()
}

function formatToolCallReport(toolName: string, toolArgs: unknown): string {
  if (isDoneToolName(toolName)) {
    return formatDoneToolCall(toolArgs)
  }

  if (toolName === 'load_skill') {
    return formatLoadSkillCall(toolArgs)
  }

  const displayName = formatToolName(toolName)
  const args = props.compact ? formatArgsCompact(toolArgs, toolName) : formatArgsFull(toolArgs)

  if (props.compact) {
    return args ? `${displayName} · ${args}` : displayName
  }

  if (args) {
    return `正在调用「${displayName}」：${args}`
  }

  return `正在调用「${displayName}」`
}

function formatToolResultReport(
  toolName: string,
  result: unknown,
  isError = false
): { type: ReportItem['type']; text: string } {
  if (isDoneToolName(toolName)) {
    return formatDoneToolResult(result)
  }

  if (toolName === 'load_skill') {
    return formatLoadSkillResult(result)
  }

  const displayName = formatToolName(toolName)
  const summary = props.compact ? formatResultCompact(result, toolName) : formatResultFull(result)
  const resultObject = parseStructuredValue(result)
  const failed = isError || (!!resultObject && resultObject.success === false)
  const compactStatusLabels = [
    t('assistant.agentProcess.compactComplete'),
    t('assistant.agentProcess.compactSuccess'),
    t('assistant.agentProcess.compactFailed')
  ]
  const compactDetail = props.compact && !compactStatusLabels.includes(summary) ? summary : ''

  if (failed) {
    return {
      type: 'warning',
      text: props.compact
        ? `${displayName} · ${t('assistant.agentProcess.compactFailed')}${compactDetail ? ` · ${compactDetail}` : ''}`
        : summary
          ? `「${displayName}」执行失败：${summary}`
          : `「${displayName}」执行失败`
    }
  }

  return {
    type: 'success',
    text: props.compact
      ? `${displayName} · ${t('assistant.agentProcess.compactComplete')}${compactDetail ? ` · ${compactDetail}` : ''}`
      : summary
        ? `「${displayName}」已完成：${summary}`
        : `「${displayName}」已完成`
  }
}

/**
 * 工具返回值里存图片路径的字段。
 *
 * `screenshot_path` 是视口截图 / Widget 预览 / PIE 试玩，`path` 是老一些的截图工具。
 * 只认这两个字段还不够 —— `path` 这个名字太泛（一堆工具用它指资产路径），
 * 所以还要过一遍 `isPreviewableImageRef`：必须是绝对路径且以图片扩展名结尾。
 */
const RESULT_IMAGE_FIELDS = ['screenshot_path', 'path'] as const

/**
 * 一次产出多张图的字段。生图、以及 PIE 试玩的时间轴拼图走它。
 *
 * 单独一个字段而不是把 `path` 改成数组：`path` 那条路上有一堆存量工具，
 * 而它们一次只出一张。
 *
 * 试玩那条路必须用它：模型收到的是几张拼图加收尾截图，界面只认单张
 * `screenshot_path` 的话，用户看到的是「跑了一下出了一张图」，而模型
 * 正照着四张拼图讲整段过程 —— 两边看的不是同一批画面，用户没法复核。
 */
const RESULT_IMAGE_LIST_FIELD = 'image_paths'

/**
 * 产出视频的字段。目前只有 generate_video。
 *
 * 视频一次只出一条 —— 各家的接口都是一次一个任务，而且贵，没有「一次出四条」
 * 这回事，所以这里是单值不是数组。
 */
const RESULT_VIDEO_FIELD = 'video_path'

/** 能在 <video> 里直接播的扩展名。本机资源服务对这几种都带 Range 响应 */
const VIDEO_EXTENSION = /\.(mp4|webm|mov|m4v)$/i

/**
 * 找出这一步产出的、能直接播放的视频。
 *
 * 与图同理走本机资源服务读磁盘上那份，而不是厂商那个临时地址 ——
 * 后者几小时后失效，聊天记录翻回来就是一个点不开的黑框。
 */
function findResultVideoUrls(result: unknown): string[] {
  const structured = parseStructuredValue(result)
  const value = structured?.[RESULT_VIDEO_FIELD]
  if (typeof value !== 'string' || !VIDEO_EXTENSION.test(value.split(/[?#]/)[0])) return []
  const url = toLocalResourceUrl(value)
  return url ? [url] : []
}

/**
 * 找出这一步产出的、能直接显示的图。
 *
 * 显示的是**磁盘上那张原图**，不是进模型上下文的那张压缩版：
 * 后者为了省 token 压到了 768px 宽的 JPEG，而且根本不发到渲染层
 * （base64 会随聊天记录写进 localStorage，把配额撑满 —— 见 adaptV2Tool 的说明）。
 * 读盘显示既清楚又不占存储，重开应用之后也还在。
 */
/**
 * agent **看过**的那张图（`read_local_file` 读到图片时挂在 details 上）。
 *
 * 单独一个字段而不是并进 `RESULT_IMAGE_FIELDS`：那些是工具产出的图，要立刻
 * 铺开给人看；这张是 agent 的输入，默认收起、点一下才加载。
 */
const RESULT_PEEK_IMAGE_FIELD = 'viewed_image_path'

function findResultPeekImageUrls(result: unknown): string[] {
  const structured = parseStructuredValue(result)
  const value = structured?.[RESULT_PEEK_IMAGE_FIELD]
  const paths = Array.isArray(value) ? value : [value]
  return paths
    .filter((item): item is string => typeof item === 'string' && isPreviewableImageRef(item))
    .map((item) => toLocalResourceUrl(item))
    .filter((url): url is string => Boolean(url))
}

function findResultImageUrls(result: unknown): string[] {
  const structured = parseStructuredValue(result)
  if (!structured) return []

  const list = structured[RESULT_IMAGE_LIST_FIELD]
  if (Array.isArray(list)) {
    const urls = list
      .filter((value): value is string => typeof value === 'string' && isPreviewableImageRef(value))
      .map((value) => toLocalResourceUrl(value))
      .filter((url): url is string => Boolean(url))
    if (urls.length > 0) return urls
  }

  for (const field of RESULT_IMAGE_FIELDS) {
    const value = structured[field]
    if (typeof value === 'string' && isPreviewableImageRef(value)) {
      const url = toLocalResourceUrl(value)
      if (url) return [url]
    }
  }
  return []
}

/**
 * 这一条时间线里的子任务泳道。
 *
 * 单独算一次而不是在 `reportItems` 里顺手收：折叠时的表头也要用它
 * （「2 路子任务并行中」），两处各收一遍等于同一份数据有两种说法。
 */
const subtaskView = computed(() => buildSubtaskView(props.items))

const runningSubtaskCount = computed(() => countRunningLanes(subtaskView.value.lanes))

const reportItems = computed<ReportItem[]>(() => {
  const items: ReportItem[] = []
  const { laneAt, absorbed } = subtaskView.value
  let lastKey = ''

  const pushReport = (
    type: ReportItem['type'],
    icon: string,
    text: string,
    keySeed: string,
    media?: {
      images?: string[]
      peekImages?: string[]
      videos?: string[]
      fileChange?: FileChange
      fileChangeUnavailable?: boolean
    }
  ): void => {
    const normalizedText = normalizeReportText(text)
    if (!normalizedText) return

    const dedupKey = `${type}:${normalizeDedupKey(normalizedText)}`
    if (dedupKey === lastKey && !media?.fileChange && !media?.fileChangeUnavailable) return

    lastKey = dedupKey
    const { images, peekImages, videos } = media ?? {}
    items.push({
      key: `${keySeed}:${items.length}`,
      type,
      icon,
      text: normalizedText,
      fileChange: media?.fileChange,
      fileChangeUnavailable: media?.fileChangeUnavailable,
      ...(images && images.length > 0 ? { images } : {}),
      ...(peekImages && peekImages.length > 0 ? { peekImages } : {}),
      ...(videos && videos.length > 0 ? { videos } : {})
    })
  }

  props.items.forEach((item, index) => {
    /**
     * 属于某一路子任务的条目不再单独成行 —— 它们已经写进那张泳道卡片里了。
     * 卡片长在这一路被派出去的位置上，时间线前后顺序因此保持不变。
     */
    const lane = laneAt.get(index)
    if (lane) {
      items.push({
        key: `subtask:${lane.callId}`,
        type:
          lane.status === 'failed' ? 'warning' : lane.status === 'success' ? 'success' : 'progress',
        icon: '',
        text: lane.title,
        subtask: lane
      })
      // 卡片不参与相邻去重：两路子任务的标题可能一模一样，那是两路，不是重复
      lastKey = ''
      return
    }
    if (absorbed.has(index)) return

    if (item.type === 'notify-users') {
      const notifyType = (item.data?.notifyType as string) || 'info'
      if (notifyType === 'thinking') {
        return
      }

      const formattedText = formatNotifyReportText(String(item.data?.message || ''))
      if (!formattedText) {
        return
      }

      const reportType =
        notifyType === 'success'
          ? 'success'
          : notifyType === 'warning'
            ? 'warning'
            : notifyType === 'progress'
              ? 'progress'
              : 'info'
      const icon =
        reportType === 'success'
          ? '✓'
          : reportType === 'warning'
            ? '!'
            : reportType === 'info'
              ? 'i'
              : '·'

      pushReport(reportType, icon, formattedText, `notify:${item.timestamp}`)
      return
    }

    if (item.type === 'tool-call') {
      const toolName = getToolName(item.data)
      const isDoneTool = isDoneToolName(toolName)
      pushReport(
        isDoneTool ? 'success' : 'progress',
        isDoneTool ? '✓' : '·',
        formatToolCallReport(toolName, getToolArgs(item.data)),
        `tool-call:${item.timestamp}:${toolName}`
      )
      return
    }

    if (item.type === 'tool-result') {
      const rawToolName =
        (item.data?.toolName as string | undefined) ||
        getToolName((item.data || {}) as Record<string, unknown>)
      const report = formatToolResultReport(
        rawToolName,
        item.data?.result,
        item.data?.isError === true
      )
      // 解一次就够。`reportItems` 是 computed，流式输出期间每来一段就把整份
      // 日志重走一遍 —— 解两次等于每条工具结果白付一次 JSON.parse
      const structured = parseStructuredValue(item.data?.result)
      pushReport(
        report.type,
        report.type === 'success' ? '✓' : '!',
        report.text,
        `tool-result:${item.timestamp}:${rawToolName}`,
        {
          images: findResultImageUrls(item.data?.result),
          fileChange: readFileChange(structured?.fileChange),
          fileChangeUnavailable: !!structured?.fileChangeUnavailable,
          peekImages: findResultPeekImageUrls(item.data?.result),
          videos: findResultVideoUrls(item.data?.result)
        }
      )
      return
    }

    /**
     * `step` 不出现在过程日志里。
     *
     * 它对应内核的 `turn_end`（一轮模型往返结束），是真实事件，但**没有总数**：
     * V3 不设步数上限（V2 那个 12/10 步硬限恰恰是它做不了复杂任务的原因）。
     * 这里原本显示「正在执行第 1/999 步」，那个 999 是界面为了凑出分母
     * 自己编的常量 —— 看上去像个进度，其实什么也没告诉用户。
     *
     * 而且它还会顶掉表头：表头显示的是最后一条日志，一旦步数行排在工具调用
     * 后面，用户就看不到"正在调什么工具"了。真正在发生的事都有各自的条目。
     */
  })

  return items
})

/**
 * 短消息阈值：小于此长度的消息被视为状态通知（如"思考已完成"），不作为思考内容显示
 * 这样可以防止状态通知覆盖之前的详细思考内容导致闪烁
 */
watch(
  () => reportItems.value.length,
  (newLength, oldLength) => {
    if (newLength <= 0) return
    void scrollReportListToBottom(oldLength === 0)
  }
)

watch(
  () => isCollapsed.value,
  (collapsed) => {
    if (!collapsed) {
      if (reportItems.value.length > 0) {
        void scrollReportListToBottom(true)
      }
      void scrollProcessBodyToBottom(true)
    }
  }
)

const SHORT_MESSAGE_THRESHOLD = 48

/**
 * Short status lines should not be rendered as full thinking content.
 */
const STATUS_PATTERNS = [
  /思考已完成/,
  /思考结束/,
  /正在思考/,
  /正在深度思考/,
  /正在搜索/,
  /^thinking\.{0,3}$/i,
  /^done thinking\.?$/i,
  /^thinking complete\.?$/i,
  /^searching\.{0,3}$/i,
  /^processing\.{0,3}$/i
]

/**
 * 判断消息是否是短状态通知（应被过滤）
 */
function isStatusNotification(message: string): boolean {
  const trimmed = message.trim()

  if (!trimmed) {
    return true
  }

  // Short messages that only describe transient status should be filtered out.
  if (trimmed.length < SHORT_MESSAGE_THRESHOLD) {
    return STATUS_PATTERNS.some((pattern) => pattern.test(trimmed))
  }

  return false
}

/**
 * 缓存上一次非空的思考内容，用于防止闪烁
 */
const cachedThinking = shallowRef<string>('')

/**
 * 获取当前的思考内容（按专家分组显示）
 * 后端发送的 thinking 消息是累积的（每条包含之前所有内容），
 * 所以每个专家只取其最后一条即可获得该专家的完整思考历史。
 * 不同专家之间用分隔线分开，实现增量显示效果。
 *
 * 【防闪烁机制】：
 * 1. 过滤掉短状态通知消息（如"思考已完成"）
 * 2. 如果过滤后内容为空，使用缓存的上一次非空内容
 */
const rawThinking = computed(() => {
  // 按专家分组，收集每个专家的最后一条有效 thinking（排除状态通知）
  const specialistThinking = new Map<string, string>()
  const specialistOrder: string[] = []

  for (const item of props.items) {
    if (item.type === 'notify-users' && item.data.notifyType === 'thinking') {
      const message = item.data.message || ''
      const specialist = item.data.specialist || 'default'

      // 只处理非状态通知的消息
      if (message.trim() && !isStatusNotification(message)) {
        // 记录专家出现顺序（只记录首次出现）
        if (!specialistThinking.has(specialist)) {
          specialistOrder.push(specialist)
        }
        // 用最新的消息覆盖（因为后端发送的是累积文本）
        specialistThinking.set(specialist, message)
      }
    }
  }

  // 按专家出现顺序连接所有思考内容
  const results: string[] = []
  for (const specialist of specialistOrder) {
    const content = specialistThinking.get(specialist)
    if (content) {
      results.push(content)
    }
  }

  // 用分隔线连接不同专家的思考内容
  return results.join('\n\n---\n\n')
})

/**
 * 使用 watchEffect 来管理缓存更新
 * 这样可以避免在 computed 中产生副作用
 */
watchEffect(() => {
  const current = rawThinking.value

  if (current) {
    // 有新的有效内容，更新缓存
    cachedThinking.value = current
  } else if (!props.isThinking) {
    // 思考已结束且没有新内容，清空缓存
    cachedThinking.value = ''
  }
  // 如果当前为空但仍在思考中，保持缓存不变
})

/**
 * 最终的思考内容（带防闪烁缓存）
 * - 如果当前有有效内容，返回当前内容
 * - 如果当前为空但仍在思考中，返回缓存内容
 * - 如果已完成思考，返回空
 */
const currentThinking = computed(() => {
  const current = rawThinking.value

  if (current) {
    return current
  }

  // 当前为空，如果还在思考中，返回缓存内容防止闪烁
  if (props.isThinking && cachedThinking.value) {
    return cachedThinking.value
  }

  return ''
})

/**
 * 对话框里的 process-body 是独立滚动容器：内容增长时贴底跟随，
 * 用户手动上滚翻历史时不打扰。思考流式文本和条目数都算内容增长。
 */
watch(
  () => [currentThinking.value.length, props.items.length] as const,
  () => {
    if (isCollapsed.value) return
    void scrollProcessBodyToBottom()
  }
)

/**
 * 缓存上一次非空的工具调用列表，用于防止闪烁
 */
const cachedToolItems = shallowRef<AgentProcessItem[]>([])

/**
 * 工具调用项（tool-call 和 tool-result）- 原始计算
 */
const rawToolItems = computed(() => {
  return props.items.filter((item) => item.type === 'tool-call' || item.type === 'tool-result')
})

/**
 * 使用 watchEffect 管理工具调用缓存更新
 * 防止在 items 更新导致短暂空数组时 UI 闪烁
 */
watchEffect(() => {
  const current = rawToolItems.value

  if (current.length > 0) {
    // 有新的工具调用数据，更新缓存
    cachedToolItems.value = [...current]
  } else if (!props.isThinking) {
    // 思考已结束且没有新内容，清空缓存
    cachedToolItems.value = []
  }
  // 如果当前为空但仍在思考中，保持缓存不变
})

/**
 * 最终的工具调用项（带防闪烁缓存）
 * - 如果当前有有效内容，返回当前内容
 * - 如果当前为空但仍在思考中，返回缓存内容
 * - 如果已完成思考，返回当前（可能为空）
 */
const toolItems = computed(() => {
  const current = rawToolItems.value

  if (current.length > 0) {
    return current
  }

  // 当前为空，如果还在思考中，返回缓存内容防止闪烁
  if (props.isThinking && cachedToolItems.value.length > 0) {
    return cachedToolItems.value
  }

  return current
})

/**
 * Only render the process log when there is real process content to show.
 * A plain typing state with an empty process array should not surface a
 * misleading "thinking" block.
 */
/**
 * 面板里显示的推理正文：外部折进来的优先，没有才用过程条目里推出来的那份。
 * 两份同时存在时，外部那份是完整的 reasoning，过程里的只是零星 notify。
 *
 * 判空用正则而**不是** `.trim()`：`props.thinking` 是流式增长的，每来一批增量都
 * 要重算一次这个 computed，而 `.trim()` 每次都复制一整份 —— 一段两万字的推理
 * 摊下来就是几百 KB/秒的临时字符串。`/\S/` 只扫到第一个非空白字符就停。
 */
const displayThinking = computed(() =>
  props.thinking && /\S/.test(props.thinking) ? props.thinking : currentThinking.value
)

const shouldRenderProcessLog = computed(() => {
  return (
    // `displayThinking` 兜底就是 `currentThinking`，所以它真时这条已经覆盖了那一支
    !!displayThinking.value ||
    reportItems.value.length > 0 ||
    progressBubbles.value.length > 0 ||
    toolItems.value.length > 0
  )
})

/**
 * 计算是否有正在执行的工具调用
 * （有 tool-call 但没有对应的 tool-result）
 */
const hasOngoingToolCall = computed(() => {
  const toolCalls = props.items.filter((item) => item.type === 'tool-call')
  const toolResults = props.items.filter((item) => item.type === 'tool-result')
  // 如果 tool-call 数量 > tool-result 数量，说明有工具正在执行
  return toolCalls.length > toolResults.length
})

const headerTitle = computed(() => {
  if (props.isThinking) {
    // 优先级: 有工具在执行 > 有思考内容 > 默认处理中
    if (hasOngoingToolCall.value) {
      return t('assistant.agentProcess.executing') // "执行中"
    }
    if (currentThinking.value) {
      return t('assistant.agentProcess.thinking') // "处理中"
    }
    return t('assistant.agentProcess.thinking') // "处理中"
  }
  return t('assistant.agentProcess.thoughtFinished') // "处理完成"
})

/**
 * 实时更新思考时长（秒，保留一位小数）
 */
const headerDisplayTitle = computed(() => {
  /**
   * 有好几路子任务同时在跑时，这是收起状态下最该说的一句话。
   * 显示「最后一条日志」的话，两路交替推进度，表头就在两边来回跳，
   * 看上去像是一路活干了两遍。
   */
  if (runningSubtaskCount.value > 1) {
    return t('assistant.agentProcess.subtask.parallelRunning', {
      count: runningSubtaskCount.value
    })
  }

  if (props.compact) {
    if (!props.isThinking) return t('assistant.agentProcess.processFinished')
    /**
     * 框里装的是一条条工具调用，表头就不能只写「思考中」—— 说的和里面摆着的对不上，
     * 用户看到的是「思考中」底下列着 ue_get_actor 跑完了。收起时这一行也才有信息量。
     * 小窗比主聊天页窄得多，截得更短。
     */
    // 判的是截出来那句话，不是条目在不在：子任务那一路直接往 `reportItems` 里塞
    // `{ text: lane.title }`，绕开了 `pushReport` 的空串过滤，所以 `latest` 有
    // 而 `latest.text` 是空串是真会发生的 —— 那时候表头会是一片空白
    const latest = trimReportText(reportItems.value[reportItems.value.length - 1]?.text ?? '', 24)
    return latest || headerTitle.value
  }

  const latestReport = trimReportText(
    reportItems.value[reportItems.value.length - 1]?.text ?? '',
    72
  )
  return latestReport || headerTitle.value
})

function updateDuration(): void {
  const end = Date.now()
  nowTick.value = end
  const diff = Math.max(0, (end - startTime.value) / 1000)
  duration.value = diff.toFixed(1)
}

/**
 * 这一路跑了多久。
 *
 * 还没结束、而且整轮也已经停了（翻历史消息、或者被用户按停）时，拿时间线上
 * 最后一条的时刻当终点 —— 用「现在」的话，一条三天前的记录会显示成跑了三天。
 */
function subtaskElapsed(lane: SubtaskLane): string {
  const fallbackEnd = props.items[props.items.length - 1]?.timestamp ?? lane.startedAt
  const end = lane.endedAt ?? (props.isThinking ? nowTick.value : fallbackEnd)
  return (Math.max(0, end - lane.startedAt) / 1000).toFixed(1)
}

/**
 * 点开了完整任务书的那几路，按 callId 记。
 *
 * 默认收着：并行三路各贴一整段 prompt 会把过程日志淹掉。但得有办法看 ——
 * 「派出去的到底是什么」是用户判断这一路跑得对不对的唯一依据。
 */
const expandedSubtasks = ref(new Set<string>())

function toggleSubtaskPrompt(lane: SubtaskLane): void {
  const next = new Set(expandedSubtasks.value)
  if (next.has(lane.callId)) next.delete(lane.callId)
  else next.add(lane.callId)
  expandedSubtasks.value = next
}

function subtaskStatusText(lane: SubtaskLane): string {
  if (lane.status === 'success') return t('assistant.agentProcess.subtask.success')
  if (lane.status === 'failed') return t('assistant.agentProcess.subtask.failed')
  return t('assistant.agentProcess.subtask.running')
}

/** 卡片底下那行：跑着的时候是它此刻在干什么，跑完是一句结论 */
function subtaskDetail(lane: SubtaskLane): string {
  if (lane.status === 'running') return lane.latest
  return lane.summary || lane.latest
}

/**
 * 基于思考过程条目的时间戳计算历史消息的时长
 */
function calculateDurationFromItems(): void {
  if (props.items && props.items.length > 0) {
    const start = props.items[0].timestamp
    const end = props.items[props.items.length - 1].timestamp
    const diff = Math.max(0, (end - start) / 1000)
    duration.value = diff.toFixed(1)
  } else {
    duration.value = '0.0'
  }
}

function formatToolName(name: string): string {
  if (!name) return t('assistant.agentProcess.unknownTool')
  const normalizedName = normalizeToolName(name)
  const map: Record<string, string> = {
    // 技能。键名必须和注册表里的一致（`load_skill` 而不是 `loadSkill`）——
    // 对不上的话这里不匹配，界面就显示原始工具名
    load_skill: '加载 Skill',
    read_skill_resource: '读取 Skill 资源',
    // AIGC 工具
    generate_image: t('assistant.agentProcess.tools.generate_image'),
    generate_3d_model: t('assistant.agentProcess.tools.generate_3d_model'),
    generate_video: t('assistant.agentProcess.tools.generate_video'),
    prepare_task_video: t('assistant.agentProcess.tools.prepare_task_video'),
    read_task_video_context: t('assistant.agentProcess.tools.read_task_video_context'),
    generate_task_music: t('assistant.agentProcess.tools.generate_task_music'),
    render_task_video: t('assistant.agentProcess.tools.render_task_video'),
    analyze_video: t('assistant.agentProcess.tools.analyze_video'),
    aigc: t('assistant.agentProcess.tools.aigc'),
    // 资产管理工具
    'asset-manager': t('assistant.agentProcess.tools.asset_library_manager'),
    search_assets: t('assistant.agentProcess.tools.search_assets'),
    open_folder: t('assistant.agentProcess.tools.open_folder'),
    add_tag: '添加标签',
    add_remark: '添加备注',
    // UE Actor 工具
    spawn_actor: '创建 Actor',
    destroy_actor: '删除 Actor'
  }
  return map[normalizedName] || normalizedName
}

function isDoneToolName(name: string): boolean {
  return normalizeToolName(name) === 'done'
}

function formatDoneToolCall(args: unknown): string {
  void args
  return '已整理好最终回复'
}

function formatSkillSourceLabel(source: unknown): string {
  if (source === 'user') return '用户 Skill'
  if (source === 'builtin') return '内置 Skill'
  return 'Skill'
}

function formatLoadSkillCall(args: unknown): string {
  const parsed = parseStructuredValue(args)
  const skillName = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
  if (skillName) {
    return `正在加载 Skill「${skillName}」`
  }
  return '正在加载 Skill'
}

function formatDoneToolResult(result: unknown): { type: ReportItem['type']; text: string } {
  const structured = parseStructuredValue(result)
  const failureReason =
    typeof structured?.error === 'string'
      ? trimReportText(structured.error, 96)
      : typeof structured?.message === 'string'
        ? trimReportText(structured.message, 96)
        : ''

  if (structured?.success === false) {
    return {
      type: 'warning',
      text: failureReason ? `最终回复整理失败：${failureReason}` : '最终回复整理失败'
    }
  }

  return {
    type: 'success',
    text: '已整理好最终回复'
  }
}

function formatLoadSkillResult(result: unknown): { type: ReportItem['type']; text: string } {
  const structured = parseStructuredValue(result)
  const skillName =
    typeof structured?.skillName === 'string'
      ? structured.skillName.trim()
      : typeof structured?.name === 'string'
        ? structured.name.trim()
        : ''
  const sourceLabel = formatSkillSourceLabel(structured?.skillSource)
  const skillDirectory =
    typeof structured?.skillDirectory === 'string' ? structured.skillDirectory.trim() : ''
  const failureReason =
    typeof structured?.error === 'string'
      ? trimReportText(structured.error, 96)
      : typeof structured?.message === 'string'
        ? trimReportText(structured.message, 96)
        : ''

  if (structured?.success === false) {
    return {
      type: 'warning',
      text: failureReason
        ? `Skill 加载失败：${failureReason}`
        : skillName
          ? `Skill「${skillName}」加载失败`
          : 'Skill 加载失败'
    }
  }

  const lines: string[] = []
  if (skillName) {
    lines.push(`已加载${sourceLabel}「${skillName}」`)
  } else {
    lines.push(`已加载${sourceLabel}`)
  }
  if (skillDirectory) {
    lines.push(`目录：${skillDirectory}`)
  }

  return {
    type: 'success',
    text: lines.join('\n')
  }
}

function formatArgsFull(args: unknown): string {
  if (args === null || args === undefined) {
    return ''
  }

  const parsed = parseStructuredValue(args)
  if (parsed) {
    return JSON.stringify(parsed, null, 2)
  }

  return String(args)
}

/**
 * 紧凑格式化参数（用于工具详情折叠区）
 * 支持多种数据结构：
 * 1. JSON 字符串格式（旧版 OpenAI 工具调用）
 * 2. 对象格式（新版 SDK 工具调用）
 */
function formatArgsCompact(args: unknown, toolName?: string): string {
  try {
    if (toolName && isDoneToolName(toolName)) {
      return '准备向用户发送最终回复'
    }

    if (toolName === 'loadSkill') {
      const parsed = parseStructuredValue(args)
      if (typeof parsed?.name === 'string' && parsed.name.trim()) {
        return parsed.name.trim()
      }
      return '加载技能'
    }

    // 处理 null/undefined
    if (args === null || args === undefined) {
      return ''
    }

    let parsed: Record<string, unknown>

    if (typeof args === 'string') {
      // 空字符串
      if (!args.trim()) return ''
      // 尝试解析 JSON 字符串
      parsed = JSON.parse(args)
    } else if (typeof args === 'object') {
      parsed = args as Record<string, unknown>
    } else {
      return String(args).slice(0, 60)
    }

    // 空对象检查
    if (!parsed || Object.keys(parsed).length === 0) {
      return ''
    }

    // 提取关键信息（按优先级）
    if (parsed.task && typeof parsed.task === 'string') {
      return parsed.task.slice(0, 50) + (parsed.task.length > 50 ? '...' : '')
    }
    if (parsed.action && typeof parsed.action === 'string') {
      return parsed.action
    }
    if (parsed.input_text && typeof parsed.input_text === 'string') {
      return parsed.input_text.slice(0, 50) + (parsed.input_text.length > 50 ? '...' : '')
    }
    if (parsed.prompt && typeof parsed.prompt === 'string') {
      return parsed.prompt.slice(0, 50) + (parsed.prompt.length > 50 ? '...' : '')
    }
    if (parsed.query && typeof parsed.query === 'string') {
      return parsed.query.slice(0, 50) + (parsed.query.length > 50 ? '...' : '')
    }
    if (parsed.url && typeof parsed.url === 'string') {
      return formatUrlCompact(parsed.url)
    }
    if (parsed.path && typeof parsed.path === 'string') {
      return parsed.path
    }

    // 回退到 JSON 字符串
    const str = JSON.stringify(parsed)
    return str.slice(0, 60) + (str.length > 60 ? '...' : '')
  } catch {
    return String(args).slice(0, 60)
  }
}

function formatUrlCompact(value: string): string {
  try {
    const url = new URL(value)
    const readable = `${url.hostname}${url.pathname}`.replace(/\/$/, '')
    return trimReportText(readable || url.hostname, 64)
  } catch {
    return trimReportText(value, 64)
  }
}

/**
 * 获取工具结果对应的图标组件
 */
function getResultIcon(result: unknown): unknown {
  try {
    const r = result as Record<string, unknown>
    if (r && r.success === true) return PhCheckCircle
    if (r && r.success === false) return PhXCircle
  } catch {
    // ignore
  }
  return PhCheck
}

/**
 * 获取工具结果图标的样式类
 */
function getResultClass(result: unknown): string {
  try {
    const r = result as Record<string, unknown>
    if (r && r.success === true) return 'success'
    if (r && r.success === false) return 'failed'
  } catch {
    // ignore
  }
  return ''
}

/**
 * 紧凑格式化结果（用于工具详情折叠区）
 */
function formatResultCompact(result: unknown, toolName?: string): string {
  try {
    if (toolName && isDoneToolName(toolName)) {
      const structured = parseStructuredValue(result)
      if (structured?.success === false && typeof structured.error === 'string') {
        return structured.error.slice(0, 50) + (structured.error.length > 50 ? '...' : '')
      }
      return '已整理最终回复'
    }

    if (toolName === 'loadSkill') {
      const structured = parseStructuredValue(result)
      if (structured?.success === false && typeof structured?.error === 'string') {
        return structured.error.slice(0, 50) + (structured.error.length > 50 ? '...' : '')
      }
      if (typeof structured?.skillName === 'string' && structured.skillName.trim()) {
        return `${formatSkillSourceLabel(structured.skillSource)} ${structured.skillName.trim()}`
      }
      return '已加载 Skill'
    }

    if (!result) return t('assistant.agentProcess.compactComplete')
    const r = parseStructuredValue(result) || (result as Record<string, unknown>)

    // 优先显示错误信息，帮助用户Debug
    if (r.error && typeof r.error === 'string') {
      return r.error.slice(0, 50) + (r.error.length > 50 ? '...' : '')
    }

    // 提取常见的结果字段
    if (r.message && typeof r.message === 'string') {
      return r.message.slice(0, 50) + (r.message.length > 50 ? '...' : '')
    }
    if (r.url && typeof r.url === 'string') {
      return formatUrlCompact(r.url)
    }
    if (r.success === true) return t('assistant.agentProcess.compactSuccess')
    if (r.success === false) return t('assistant.agentProcess.compactFailed')
    if (r.count !== undefined) return `共 ${r.count} 个`
    const str = JSON.stringify(result)
    return str.slice(0, 50) + (str.length > 50 ? '...' : '')
  } catch {
    return String(result).slice(0, 50)
  }
}

function formatResultFull(result: unknown): string {
  try {
    if (!result) return '完成'

    const structured = parseStructuredValue(result)
    if (!structured) {
      return String(result)
    }

    if (structured.error && typeof structured.error === 'string') {
      return structured.error
    }

    if (structured.message && typeof structured.message === 'string') {
      return structured.message
    }

    if (structured.success === true) return '成功'
    if (structured.success === false) return '失败'
    if (structured.count !== undefined) return `共 ${structured.count} 项`

    return JSON.stringify(structured, null, 2)
  } catch {
    return String(result)
  }
}
</script>

<style scoped lang="less">
.agent-process-log {
  width: 100%;
  margin-bottom: 8px;
}

.process-header {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px;
  border: 0;
  cursor: pointer;
  background: var(--color-bg-surface-hover);
  color: inherit;
  font: inherit;
  text-align: left;
  transition: background 0.2s;
  border-radius: 4px 4px 0 0;

  &:hover {
    opacity: 0.8;
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }
}

.header-left {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.header-title {
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-icon {
  display: flex;
  align-items: center;
  color: var(--color-text-secondary);

  // 旋转动画自己定义，不依赖全局的 .icon-spin；
  // 放大 + 强调色，长思考时这行状态才肉眼可见地在动。
  &.spinning {
    color: var(--color-accent-text);
    font-size: 14px;
    animation: thinking-spin 1s linear infinite;
  }
}

@keyframes thinking-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

.header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.collapse-icon {
  transition: transform 0.2s;
  font-size: 12px;

  &.expanded {
    transform: rotate(180deg);
  }
}

.process-body {
  padding: 8px 12px 12px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 0 0 4px 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 320px;
  overflow-y: auto;
}

// 排队状态区
@keyframes fadeInMessage {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes vipFlash {
  0% {
    background: var(--color-warning-bg);
  }
  50% {
    background: var(--color-warning-bg);
  }
  100% {
    background: var(--color-warning-bg);
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

@keyframes hourglass {
  0% {
    transform: rotate(0deg);
  }
  50% {
    transform: rotate(180deg);
  }
  100% {
    transform: rotate(180deg);
  }
}

// 进度气泡区 - 简化为一行紧凑显示
.report-list {
  max-height: 250px;
  overflow-y: auto;
  padding-right: 4px;
}

.report-list-inner {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.report-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
}

.report-icon {
  width: 16px;
  flex: 0 0 16px;
  text-align: center;
  line-height: 1.5;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.report-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.report-text {
  flex: 1;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 一次出好几张时并排放，不然四张图能把时间线撑成一本图册 */
.report-videos {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

.report-video {
  max-width: 100%;
  /* 与 report-image 同一个上限：过程日志是配角，一条片子不该占满整屏 */
  max-height: 240px;
  border-radius: 8px;
  background: var(--color-bg-sunken);
}

.report-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 「看它看的图」。收起时只是一行淡色小字，不跟工具结果抢注意力 */
.report-peek {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.peek-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
}

.report-image {
  align-self: flex-start;
  max-width: 100%;
  /* 过程日志是条时间线，缩略图不能把它挤成图册；看细节点开大图 */
  max-height: 180px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  object-fit: contain;
  cursor: zoom-in;
}

/*
 * 子任务泳道卡片。
 *
 * 刻意和普通日志行同一套底：并行不是一个需要装饰的特性，它只是需要被看清。
 * 区别只有三处 —— 左边一条状态色的竖线、标题一行、脚注一行。
 */
.subtask-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--color-border-subtle);
  border-left: 2px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-surface-hover);
}

.subtask-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;

  &:hover .subtask-caret {
    opacity: 1;
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }
}

/* 平时淡着，指上去才明显 —— 卡片的主角是任务本身，不是这个开关 */
.subtask-caret {
  flex: 0 0 auto;
  font-size: 11px;
  opacity: 0.5;
  transition:
    transform 0.2s,
    opacity 0.2s;

  &.expanded {
    transform: rotate(180deg);
    opacity: 1;
  }
}

.subtask-icon {
  font-size: 13px;
  color: var(--color-text-secondary);

  &.live {
    color: var(--color-accent-text);
    animation: thinking-spin 1s linear infinite;
  }
}

.subtask-label {
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

.subtask-status {
  &::before {
    content: '·';
    margin-right: 6px;
  }
}

/* 耗时靠右对齐，几路并排时能直接比出谁慢 */
.subtask-elapsed {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.subtask-title {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
}

/* 派出去的原文，按原样换行显示；缩进一格表示它属于上面那行标题 */
.subtask-prompt {
  margin: 0;
  padding-left: 8px;
  border-left: 1px solid var(--color-border-subtle);
  font-size: 11px;
  line-height: 1.6;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.subtask-detail {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-muted);
}

.subtask-detail-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subtask-steps {
  flex: 0 0 auto;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.subtask-running {
  border-left-color: var(--color-accent-text);
}

.subtask-success {
  border-left-color: var(--color-success-text);

  .subtask-icon {
    color: var(--color-success-text);
  }
}

.subtask-failed {
  border-left-color: var(--color-warning-text);

  .subtask-icon {
    color: var(--color-warning-text);
  }
}

.report-progress {
  .report-icon {
    color: var(--color-accent-text);
  }
}

.report-success {
  background: var(--color-success-bg);
  border-color: var(--color-success-border);

  .report-icon {
    color: var(--color-success-text);
  }
}

.report-warning {
  background: var(--color-warning-bg);
  border-color: var(--color-warning-border);

  .report-icon {
    color: var(--color-warning-text);
  }
}

.report-info {
  .report-icon {
    color: var(--color-text-secondary);
  }
}

.agent-process-log.compact {
  margin-bottom: 4px;
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);

  .process-header {
    padding: 7px 9px;
    border-radius: 0;
  }

  .header-left {
    gap: 5px;
    font-size: 12px;
  }

  .header-right {
    gap: 5px;
    font-size: var(--font-size-xs);
  }

  .process-body {
    gap: 6px;
    padding: 4px 8px 6px;
    border: 0;
    border-top: 1px solid var(--color-border-subtle);
    border-radius: 0;
    max-height: 220px;
  }

  .report-list {
    max-height: 168px;
    margin-left: 7px;
    padding: 2px 0 2px 7px;
    border-left: 1px solid var(--color-border-subtle);
  }

  .report-list-inner {
    gap: 0;
  }

  .report-item {
    gap: 6px;
    margin-left: -15px;
    padding: 5px 2px 5px 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .report-icon {
    border-radius: var(--radius-full);
    background: var(--color-bg-surface);
    line-height: 1.45;
  }

  .report-body {
    gap: 4px;
  }

  .report-text {
    font-size: 12px;
    line-height: 1.45;
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
    word-break: normal;
  }

  .report-success,
  .report-warning {
    background: transparent;
    border-color: transparent;
  }

  /*
   * 小窗里别的行都退成竖线上的一串文字，卡片仍然保留边框 ——
   * 「有几路在并行」是这里唯一需要占地方说清的事。
   */
  .subtask-card {
    margin: 3px 0;
    padding: 6px 8px;
    background: var(--color-bg-surface);
  }

  .subtask-title {
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .report-image {
    max-height: 120px;
  }
}

.progress-bubbles {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 0;
}

.bubble {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-secondary);
  cursor: default;

  .bubble-icon {
    font-size: 12px;
  }

  .bubble-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &.bubble-success {
    color: var(--color-success-text);
  }

  &.bubble-warning {
    color: var(--color-warning-text);
  }

  &.bubble-progress {
    color: var(--color-text-secondary);
  }
}

// Thinking 主体区 - 淡化视觉效果，Markdown渲染
.thinking-section {
  padding: 0;
  opacity: 0.6;
  transition: opacity 0.2s;

  &:hover {
    opacity: 0.85;
  }
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--color-text-muted);
  font-size: 11px;
  margin-bottom: 4px;

  .thinking-icon {
    font-size: 12px;

    &.is-live {
      color: var(--color-accent-text);
      animation: thinking-spin 1s linear infinite;
    }
  }
}

.thinking-content {
  padding-left: 15px;

  :deep(.markdown-body) {
    font-size: 11px !important;
    line-height: 1.5;
    color: var(--color-text-muted) !important;

    p {
      margin-bottom: 6px !important;
    }

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      font-size: 12px !important;
      margin-top: 8px !important;
      margin-bottom: 4px !important;
      color: var(--color-text-secondary) !important;
      border: none !important;
      padding: 0 !important;
    }

    ul,
    ol {
      margin-bottom: 6px !important;
      padding-left: 1.5em !important;
    }

    li {
      margin: 2px 0 !important;
    }

    code {
      font-size: 10px !important;
      background: var(--color-bg-surface-hover) !important;
      padding: 1px 4px !important;
    }

    .code-block {
      margin: 6px 0 !important;

      .code-header {
        padding: 4px 8px !important;
        font-size: 10px !important;
      }

      pre {
        padding: 8px !important;
        font-size: 10px !important;
      }
    }

    blockquote {
      margin: 4px 0 !important;
      padding: 0 0.8em !important;
      font-size: 11px !important;
    }
  }
}

// 工具详情折叠区 - 极简
.tool-details {
  font-size: 11px;
  color: var(--color-text-muted);

  .tool-summary {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    padding: 4px 0;
    user-select: none;
    opacity: 0.6;
    transition: opacity 0.2s;

    &:hover {
      opacity: 1;
    }
  }

  .tool-list {
    padding-left: 16px;
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .tool-item {
    font-size: 11px;
  }

  .tool-call-compact {
    display: flex;
    gap: 6px;

    .tool-name {
      color: var(--color-text-secondary);
    }

    .tool-args {
      color: var(--color-text-muted);
    }
  }

  .tool-result-compact {
    display: flex;
    align-items: center;
    gap: 3px;
    color: var(--color-text-muted);

    .result-icon {
      color: var(--color-success-text);
      font-size: 12px;

      &.failed {
        color: var(--color-danger-text);
      }
    }

    .result-text {
      opacity: 0.8;
    }
  }
}
</style>
