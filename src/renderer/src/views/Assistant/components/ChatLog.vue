<template>
  <div
    ref="scrollerRef"
    class="chat-log"
    tabindex="0"
    @scroll="handleScroll"
    @wheel="handleWheel"
    @keydown="handleKeydown"
    @mousedown="handleMouseDown"
    @auxclick.prevent
  >
    <div class="messages-container">
      <div v-for="m in reversedMessages" :key="m.id" class="message-item-flipper">
        <div class="message-wrapper">
          <AIBubble
            v-if="m.role === 'assistant'"
            :id="m.id"
            :content="extractTextFromContent(m.content)"
            :status="m.status || 'done'"
            :outcome="m.outcome"
            :show-follow-ups="m.id === lastAssistantId && !isImageGenerationMessage(m.content)"
            :tools-mode="m.id === lastAssistantId ? 'always' : 'hover'"
            :external-suggestions="m.suggestions"
            :suggestions-loading="m.suggestionsLoading"
            :tool-results="m.toolResults"
            :action-buttons="m.actionButtons"
            :agent-process="m.agentProcess"
            :thinking="m.thinking"
            :start-time="m.startTime"
            :citations="m.citations"
            :response-metadata="m.responseMetadata"
            @retry="handleRetry"
            @stop="handleStop"
            @suggest="handleSuggest"
            @copy="handleCopy"
            @fork="handleFork"
            @followups-ready="handleFollowupsReady"
            @open-location="handleOpenLocation"
            @resize="handleItemResize"
            @source-click="handleSourceClick"
            @action="handleAction"
          />
          <UserBubble
            v-else
            :id="m.id"
            :content="m.content"
            :mentioned-sources="m.mentionedSources"
            :excel-files="m.excelFiles"
            @copy="handleUserCopy"
            @confirm-edit="handleUserConfirmEdit"
          />
        </div>
      </div>
    </div>
  </div>

  <!--
    敏感操作确认框已经移到 `layout/MainLayout.vue`。

    它以前挂在这里、注释还写着「全局单例」—— 但助手页没有 keepAlive，
    切走就卸载，从别的页面发起的审批根本弹不出来，只会在五分钟后按拒绝超时。
    别再往这里挪回来。
  -->
</template>

<script setup lang="ts">
import AIBubble from './AIBubble.vue'
import UserBubble from './UserBubble.vue'
import { computed, ref, nextTick } from 'vue'
import type { AgentProcessItem } from './AgentProcessLog.types'
import type {
  ChatMessageContent,
  MentionedSource,
  ResponseMetadata
} from '@renderer/store/modules/chatMessages'
import { useAutoScroll } from '@renderer/hooks/useAutoScroll'

export type ChatRole = 'user' | 'assistant'

/**
 * 工具调用结果
 */
export interface ToolResult {
  toolName: string
  result: any
}

/**
 * 上传的 Excel 文件信息
 */
export interface ExcelFileInfo {
  fileName: string
  rowCount?: number
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: ChatMessageContent
  status?: 'typing' | 'done'
  outcome?: 'error' | 'stopped'
  suggestions?: string[]
  suggestionsLoading?: boolean
  toolResults?: ToolResult[] // Agent 模式工具调用结果
  actionButtons?: Array<{ label: string; action: string; data?: any }> // 操作按钮
  agentProcess?: AgentProcessItem[] // Agent 思考过程
  thinking?: string // 思考过程内容
  startTime?: number // 消息开始时间（用于计算duration）
  citations?: Array<{
    id: string
    title: string
    url?: string
    filePath?: string
    content?: string
    sourceId: string
    type?: string
  }>
  /** @提及的来源列表 */
  mentionedSources?: MentionedSource[]
  /** 用户上传的 Excel 文件列表 */
  excelFiles?: ExcelFileInfo[]
  responseMetadata?: ResponseMetadata
}

/**
 * 聊天记录组件：
 * 接收消息列表，根据角色渲染不同气泡。
 * 采用 transform: scaleY(-1) 翻转方案，实现自动贴底和稳定的流式输出体验。
 */
const props = defineProps<{ messages: ChatMessage[] }>()
const emit = defineEmits<{
  (e: 'retry', payload: { id: string; content: string }): void
  (e: 'stop', payload: { id: string }): void
  (e: 'suggest', payload: { id: string; text: string }): void
  (e: 'copy', payload: { id: string; content: string }): void
  (e: 'fork', payload: { id: string }): void
  (e: 'followups-ready', payload: { id: string }): void
  (e: 'open-location', folderKey: string, assetKey?: string): void
  (e: 'content-resize'): void
  (e: 'user-copy', payload: { id: string; content: string }): void
  (
    e: 'user-confirm-edit',
    payload: { id: string; newContent: string; originalContent: ChatMessageContent }
  ): void
  (e: 'source-click', source: any): void
  (e: 'user-scrolled-away', isAway: boolean): void
  /** 消息自带的操作按钮被点了（续跑等）。open-location 走它自己的通路 */
  (e: 'action', payload: { id: string; action: string; data?: Record<string, unknown> }): void
}>()

function handleAction(payload: {
  id: string
  action: string
  data?: Record<string, unknown>
}): void {
  emit('action', payload)
}

const lastAssistantId = computed<string | null>(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    const m = props.messages[i]
    if (m.role === 'assistant') return m.id
  }
  return null
})

/**
 * 倒序消息列表，配合 scaleY(-1) 实现底部为起点的列表
 * 性能优化：computed 会自动缓存结果，仅在依赖变化时重新计算
 * 由于 Vue 的响应式系统会追踪数组长度变化，只有新增/删除消息时才会重新计算
 */
const reversedMessages = computed(() => {
  // 通过浅拷贝避免修改原数组，然后反转
  return [...props.messages].reverse()
})

/**
 * 从消息内容中提取纯文本
 * @param content 消息内容
 * @returns 纯文本
 */
function extractTextFromContent(content: ChatMessageContent): string {
  if (typeof content === 'string') {
    return content
  }
  return content
    .filter((item) => item.type === 'text' && item.text)
    .map((item) => item.text)
    .join('\n')
}

/**
 * 判断消息是否是图片生成消息。
 * 如果消息内容主要是图片Markdown格式（![...](...)），则认为是图片生成。
 * @param content 消息内容
 * @returns 是否是图片生成消息
 */
function isImageGenerationMessage(content: ChatMessageContent): boolean {
  const text = extractTextFromContent(content).trim()
  if (!text) return false

  // 匹配Markdown图片格式：![alt](url)
  const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g
  const imageMatches = text.match(imagePattern) || []

  // 移除所有图片标记后，检查剩余文本
  const textWithoutImages = text.replace(imagePattern, '').trim()

  // 如果内容主要是图片（图片标记数量 > 0 且剩余文本很少），则认为是图片生成
  return imageMatches.length > 0 && textWithoutImages.length < 50
}

/**
 * 上抛重试事件。
 * @param payload 包含气泡id与文本内容
 */
function handleRetry(payload: { id: string; content: string }): void {
  emit('retry', payload)
}

/**
 * 上抛停止事件。
 */
function handleStop(payload: { id: string }): void {
  emit('stop', payload)
}

/**
 * 上抛建议点击事件。
 */
function handleSuggest(payload: { id: string; text: string }): void {
  emit('suggest', payload)
}

/**
 * 上抛复制事件。
 */
function handleCopy(payload: { id: string; content: string }): void {
  emit('copy', payload)
}

/**
 * 上抛会话分支事件。
 */
function handleFork(payload: { id: string }): void {
  emit('fork', payload)
}

/**
 * 上抛跟进建议准备完毕事件。
 */
function handleFollowupsReady(payload: { id: string }): void {
  emit('followups-ready', payload)
}

/**
 * 上抛打开位置事件，支持可选的资产Key参数。
 */
function handleOpenLocation(folderKey: string, assetKey?: string): void {
  emit('open-location', folderKey, assetKey)
}

/**
 * 上抛用户消息复制事件。
 */
function handleUserCopy(payload: { id: string; content: string }): void {
  emit('user-copy', payload)
}

/**
 * 上抛用户消息编辑确认事件。
 */
function handleUserConfirmEdit(payload: {
  id: string
  newContent: string
  originalContent: ChatMessageContent
}): void {
  emit('user-confirm-edit', payload)
}

function handleSourceClick(source: any): void {
  emit('source-click', source)
}

const scrollerRef = ref<HTMLElement | null>(null)

// 用户手动上滑标志：当用户向上滚动时设置为 true
const userHasScrolledAway = ref(false)

/**
 * 设置用户是否手动滚动离开底部
 * @param value 是否滚动离开
 */
function setUserScrolledAway(value: boolean): void {
  userHasScrolledAway.value = value
}

/**
 * 滚动到底部。
 * 在 transform 方案中，scrollTop = 0 即为视觉底部
 */
function scrollToBottom(options?: { behavior?: ScrollBehavior }): void {
  if (scrollerRef.value) {
    scrollerRef.value.scrollTo({ top: 0, behavior: options?.behavior ?? 'smooth' })
    userHasScrolledAway.value = false
  }
}

/**
 * 停止自动滚动
 * 在 transform 方案中，浏览器原生滚动行为已足够，此方法主要用于兼容接口
 */
function stopAutoScroll(): void {
  // No-op
}

/**
 * 检查是否在底部附近
 * 在 transform 方案中，scrollTop 越小越接近视觉底部
 */
function isNearBottom(): boolean {
  if (!scrollerRef.value) return true
  // 阈值设为 100px
  return Math.abs(scrollerRef.value.scrollTop) <= 100
}

/**
 * 获取滚动容器元素
 */
function getScrollElement(): HTMLElement | null {
  return scrollerRef.value
}

/**
 * 处理滚动事件
 * 更新 userHasScrolledAway 状态
 */
function handleScroll(): void {
  if (!scrollerRef.value) return
  const scrollTop = Math.abs(scrollerRef.value.scrollTop)
  // 如果 scrollTop 大于阈值，说明用户往上看历史了
  if (scrollTop > 50) {
    userHasScrolledAway.value = true
    emit('user-scrolled-away', true)
  } else {
    userHasScrolledAway.value = false
    emit('user-scrolled-away', false)
  }
}

/**
 * 处理滚轮事件
 * 修正 transform: scaleY(-1) 导致的滚轮方向反转问题
 */
function handleWheel(e: WheelEvent): void {
  if (!scrollerRef.value) return
  // 阻止默认滚动
  e.preventDefault()
  // 反向滚动：滚轮向下(deltaY > 0) -> scrollTop 减小(向下看最新)
  // 滚轮向上(deltaY < 0) -> scrollTop 增加(向上看历史)
  scrollerRef.value.scrollTop -= e.deltaY
}

/**
 * 处理键盘事件
 * 修正 transform: scaleY(-1) 导致的键盘导航方向反转问题
 */
function handleKeydown(e: KeyboardEvent): void {
  if (!scrollerRef.value) return
  const SCROLL_STEP = 40

  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault()
      // 向上看历史 -> scrollTop 增加
      scrollerRef.value.scrollTop += SCROLL_STEP
      break
    case 'ArrowDown':
      e.preventDefault()
      // 向下看最新 -> scrollTop 减小
      scrollerRef.value.scrollTop -= SCROLL_STEP
      break
    case 'PageUp':
      e.preventDefault()
      scrollerRef.value.scrollTop += scrollerRef.value.clientHeight
      break
    case 'PageDown':
      e.preventDefault()
      scrollerRef.value.scrollTop -= scrollerRef.value.clientHeight
      break
    case 'Home':
      e.preventDefault()
      // 到顶部(历史最久远) -> scrollTop 最大
      scrollerRef.value.scrollTop = scrollerRef.value.scrollHeight
      break
    case 'End':
      e.preventDefault()
      // 到底部(最新) -> scrollTop 0
      scrollerRef.value.scrollTop = 0
      break
  }
}

/**
 * 处理内容尺寸变化
 * 在 transform 方案中，通常不需要手动处理，但为了通知父组件（如更新悬浮按钮）依然保留事件
 */
function handleItemResize(): void {
  emit('content-resize')
}

// ==================== 鼠标中键拖动滚动处理 ====================
// 使用自定义 hook 处理中键自动滚动
const { handleMouseDown } = useAutoScroll(scrollerRef)

// 暴露方法给父组件
defineExpose({
  scrollToBottom,
  stopAutoScroll,
  isNearBottom,
  getScrollElement,
  setUserScrolledAway,
  userHasScrolledAway
})
</script>

<style scoped lang="less">
.chat-log {
  width: 100%;
  height: 100%;
  // 核心翻转：容器垂直翻转
  transform: scaleY(-1);
  overflow-y: auto;
  overflow-x: hidden;
  // 启用 Scroll Anchoring，确保查看历史时新消息插入不会导致跳动
  overflow-anchor: auto;

  // 自定义滚动条样式，使其看起来更自然
  &::-webkit-scrollbar {
    width: 6px;
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background-color: var(--color-bg-surface-hover);
    border-radius: 3px;

    &:hover {
      background-color: var(--color-bg-surface-hover);
    }
  }
}

.messages-container {
  display: flex;
  flex-direction: column;
  // 底部留白（在翻转后变成顶部留白，即视觉上的列表底部）
  padding-top: 36px;
  // 顶部留白（在翻转后变成底部留白，即视觉上的列表顶部）
  padding-bottom: 20px;
  // 内容不满一屏时向翻转空间的末端（视觉上的顶部）对齐，
  // 避免短对话悬在窗口底部、上方留一大块空白；
  // 内容撑满后 min-height 不再生效，贴底滚动行为与原先完全一致
  min-height: 100%;
  justify-content: flex-end;
}

.message-item-flipper {
  // 内容二次翻转，恢复正常显示
  transform: scaleY(-1);
  width: 100%;
}

.message-wrapper {
  padding-bottom: 36px;
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
  padding-left: 19px;
  padding-right: 10px;
}
</style>
