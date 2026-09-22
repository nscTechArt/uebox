<template>
  <div class="mini-chat-window">
    <!-- 标题栏 -->
    <div class="title-bar">
      <div class="title-left">
        <BrandMark class="title-logo" />
      </div>
      <div class="window-controls">
        <PhPlus class="control-btn" @click="startNewSession" />
        <PhPause v-if="isGenerating" class="control-btn warning" @click="handleStopGenerating" />
        <PhPushPin :class="['control-btn', { pinned: isPinned }]" @click="togglePin" />
        <PhMinus class="control-btn" @click="minimize" />
        <PhX class="control-btn close" @click="closeWindow" />
      </div>
    </div>

    <!--
      承接了主对话的上下文时说清楚三件事：借了多少、是不是快照、这边动不了工程。
      不说的话用户会以为这个小窗口在实时跟着主对话，或者以为在这儿也能让它干活
    -->
    <div v-if="sideContext" class="side-context-banner">
      <span class="side-context-text" :title="sideContext.sourceTitle">{{ sideContextLabel }}</span>
      <span class="side-context-tag">{{ t('miniChatWindow.sideContext.readOnly') }}</span>
    </div>

    <!-- 消息列表 -->
    <div ref="messageListRef" class="message-list">
      <div v-if="messages.length === 0" class="empty-state">
        <span>{{ sideContext ? t('miniChatWindow.sideContext.empty') : emptyStateText }}</span>
      </div>
      <MiniMessage
        v-for="msg in messages"
        :key="msg.id"
        :message="msg"
        @copy="handleAssistantCopy"
        @retry="handleBubbleRetry"
        @user-copy="handleUserBubbleCopy"
        @user-confirm-edit="handleUserConfirmEdit"
      />
      <!-- MiniChat 专用简化版敏感操作确认组件 -->
      <MiniSensitiveConfirm />
    </div>

    <!-- 输入区域 -->
    <div class="input-area">
      <!-- 图片预览行 -->
      <div v-if="pendingImages.length > 0" class="image-preview-row">
        <div v-for="(img, index) in pendingImages" :key="index" class="image-preview-item">
          <img :src="img.preview" alt="preview" class="preview-img" />
          <div v-if="img.uploading" class="upload-overlay">
            <PhCircleNotch class="icon-spin" />
          </div>
          <PhXCircle weight="fill" class="remove-btn" @click="removeImage(index)" />
        </div>
      </div>
      <!-- 输入行 -->
      <div class="input-row">
        <PhPaperclip class="attach-btn" @click="triggerFileInput" />
        <input
          ref="fileInputRef"
          type="file"
          accept="image/bmp,image/jpeg,image/png,image/webp"
          multiple
          hidden
          @change="handleFileSelect"
        />
        <textarea
          ref="inputRef"
          v-model="inputText"
          class="input-box"
          :placeholder="inputPlaceholder"
          rows="1"
          @keydown.enter.exact.prevent="sendMessage"
          @input="adjustInputHeight"
          @paste="handlePaste"
        />
        <AppButton
          variant="primary"
          size="small"
          :disabled="isSendDisabled"
          :loading="isGenerating || isUploading"
          @click="sendMessage"
        >
          {{ $t('miniChatWindow.sendButton') }}
        </AppButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { MINI_CHAT_SETTINGS_ENABLED } from '../../../../shared/miniChatPreferences'
import AppButton from '@renderer/components/AppButton.vue'
/**
 * Mini Chat 独立窗口主组件
 * 极简 AI 对话界面，支持多轮对话和 Agent 模式
 */
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  PhCircleNotch,
  PhMinus,
  PhPaperclip,
  PhPause,
  PhPlus,
  PhPushPin,
  PhX,
  PhXCircle
} from '@phosphor-icons/vue'
import MiniMessage from './components/MiniMessage.vue'
import MiniSensitiveConfirm from './components/MiniSensitiveConfirm.vue'
import BrandMark from '@renderer/components/BrandMark.vue'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { usePendingApprovalsStore } from '@renderer/store/modules/pendingApprovals'
import { useAgentMode } from '@renderer/views/Assistant/composables/useAgentMode'
import { useAutoReadAloud } from '@renderer/views/Assistant/composables/autoReadAloud'
import { stopReadAloud } from '@renderer/views/Assistant/composables/useReadAloud'
import { useMiniVoiceAutoPlay } from './composables/miniVoiceAutoPlay'
import {
  countUserTurnsBefore,
  rewindTranscript
} from '@renderer/views/Assistant/composables/transcriptRewind'
import { agentV3API } from '@renderer/api/agentV3'
import {
  isImageFile,
  isFileSizeValid,
  extractImagesFromPaste,
  fileToBase64,
  uploadImage
} from '@renderer/utils/imageUpload'
import { message } from '@/utils/messageManager'
import type {
  ChatMessageContent,
  MultimodalContentItem
} from '@renderer/store/modules/chatMessages'
import type { AgentProcessItem } from '@renderer/views/Assistant/components/AgentProcessLog.types'
import type { SideChatContext } from '@core/shared/sideChat'
import type { EditorSnapshot, MiniChatInitialMessage } from '@core/shared/editorSnapshot'

/**
 * 待上传的图片信息
 */
interface PendingImage {
  id: string
  file: File
  preview: string
  url?: string
  uploading: boolean
  error?: string
}

/**
 * 生成唯一会话 ID
 * 每次 MiniChat 窗口创建时使用新的会话 ID，避免历史消息累积
 */
function generateSessionId(): string {
  return `mini-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// 动态会话 ID - 每次窗口创建时生成新 ID
const SESSION_ID = ref(generateSessionId())

// Stores
const chatMsgStore = useChatMessagesStore()
const chatSessionStore = useChatSessionsStore()
const aiConfigStore = useAIConfigStore()
const tabsStore = useTabsStore()
const pendingApprovals = usePendingApprovalsStore()
const route = useRoute()
const { t } = useI18n()

// 状态
const inputText = ref('')
const inputRef = ref<HTMLTextAreaElement | null>(null)
const messageListRef = ref<HTMLDivElement | null>(null)
const isPinned = ref(true)
const currentTypingId = ref<string | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const pendingImages = ref<PendingImage[]>([])
const currentAgentProcess = ref<AgentProcessItem[]>([])
const MAX_IMAGES = 5 // Gemini 3 Flash 最多 5 张图片

// 计算消息列表
const messages = computed(() => chatMsgStore.getMessages(SESSION_ID.value))

/*
 * 回复落定后自动朗读。主窗口这件事挂在常驻布局上；小窗不走那套布局，自己挂一份。
 * 开关不读本窗口的 store —— 它是启动时抄的旧账，理由见 `miniVoiceAutoPlay`。
 */
const voiceAutoPlayEnabled = useMiniVoiceAutoPlay()
useAutoReadAloud(() => voiceAutoPlayEnabled.value)

function scrollToBottomIfNeeded(): void {
  scrollToBottom()
}

function pushUser(content: ChatMessageContent): void {
  chatMsgStore.pushUser(SESSION_ID.value, content)
  scrollToBottom()
}

function pushAssistantTyping(startTime?: number): string {
  const id = chatMsgStore.pushAssistantTyping(SESSION_ID.value, startTime)
  scrollToBottom()
  return id
}

const { askModeRef, fullConversationHistory, restoreAgentModeState, executeAgent, stopAgent } =
  useAgentMode({
    sid: SESSION_ID,
    messages,
    chatStore: chatSessionStore,
    chatMsgStore,
    tabsStore,
    route,
    scrollToBottomIfNeeded,
    pushUser,
    pushAssistantTyping,
    currentAgentProcess
  })

// 计算属性
const isUploading = computed(() => pendingImages.value.some((img) => img.uploading))
const isGenerating = computed(() =>
  messages.value.some((msg) => msg.role === 'assistant' && msg.status === 'typing')
)
/** 只剩 Agent 一种模式：老的一问一答链路整条删了，能力是 Agent 的子集 */
const emptyStateText = computed(() => t('miniChatWindow.emptyState.agent'))
const inputPlaceholder = computed(() => t('miniChatWindow.placeholder.agent'))
const isSendDisabled = computed(() => {
  const hasContent = inputText.value.trim().length > 0
  const hasImages = pendingImages.value.length > 0
  return (!hasContent && !hasImages) || isGenerating.value || isUploading.value
})

function applyMiniChatOpacity(opacity: number): void {
  const normalized = Math.min(1, Math.max(0.4, opacity))
  window.api.miniChat.setOpacity(normalized)
}

function extractTextFromContent(content: ChatMessageContent): string {
  if (typeof content === 'string') return content
  return content
    .filter(
      (item): item is MultimodalContentItem & { type: 'text'; text: string } =>
        item.type === 'text' && !!item.text
    )
    .map((item) => item.text)
    .join('\n')
}

function buildUserContent(text: string, imageUrls: string[]): ChatMessageContent {
  if (imageUrls.length === 0) {
    return text
  }

  const content: MultimodalContentItem[] = []
  if (text) {
    content.push({ type: 'text', text })
  }
  for (const url of imageUrls) {
    content.push({
      type: 'image_url',
      image_url: {
        url,
        detail: 'auto'
      }
    })
  }
  return content
}

function getSessionPreview(content: ChatMessageContent): string {
  const text = extractTextFromContent(content).trim()
  if (text) {
    return text
  }
  if (Array.isArray(content)) {
    const imageCount = content.filter((item) => item.type === 'image_url').length
    if (imageCount > 0) {
      return t('miniChatWindow.imageCountPreview', { count: imageCount })
    }
  }
  return ''
}

/**
 * 初始化会话
 */
function initSession(): void {
  chatSessionStore.ensureSession(SESSION_ID.value, t('miniChatWindow.defaultSessionTitle'))
  chatSessionStore.setAgentMode(SESSION_ID.value, true)
  chatSessionStore.setAgentHistory(SESSION_ID.value, [])
  chatSessionStore.setAgentCurrentText(SESSION_ID.value, '')
  chatSessionStore.setAgentSessionId(SESSION_ID.value, '')
}

function buildAgentHistoryUntil(endIndexInclusive: number): Array<{
  role: 'user' | 'assistant'
  content: ChatMessageContent | string
}> {
  const nextHistory: Array<{
    role: 'user' | 'assistant'
    content: ChatMessageContent | string
  }> = []
  for (let i = 0; i <= endIndexInclusive; i++) {
    const msg = messages.value[i]
    if (!msg) continue
    if (msg.role === 'user') {
      nextHistory.push({
        role: 'user',
        content: msg.content
      })
    } else {
      nextHistory.push({
        role: 'assistant',
        content: extractTextFromContent(msg.content)
      })
    }
  }
  return nextHistory
}

// ==================== 图片上传相关函数 ====================

/**
 * 触发文件选择器
 */
function triggerFileInput(): void {
  fileInputRef.value?.click()
}

/**
 * 处理文件选择
 */
async function handleFileSelect(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = input.files
  if (!files || files.length === 0) return

  const imageFiles: File[] = []
  for (let i = 0; i < files.length; i++) {
    if (isImageFile(files[i])) {
      imageFiles.push(files[i])
    }
  }

  if (imageFiles.length > 0) {
    await addImages(imageFiles)
  }

  // 清空 input 以便重复选择相同文件
  input.value = ''
}

/**
 * 处理粘贴事件
 */
async function handlePaste(event: ClipboardEvent): Promise<void> {
  const images = extractImagesFromPaste(event)
  if (images.length > 0) {
    event.preventDefault()
    await addImages(images)
  }
}

/**
 * 添加图片到待发送队列
 * 直接使用 Base64 内嵌，Gemini 3 Flash 支持最大 100MB 内嵌图片
 */
async function addImages(files: File[]): Promise<void> {
  for (const file of files) {
    const pendingImageId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    // 检查数量限制
    if (pendingImages.value.length >= MAX_IMAGES) {
      message.warning(t('miniChatWindow.maxImagesWarning', { max: MAX_IMAGES }))
      break
    }

    // 检查文件大小（Gemini 支持 100MB，但保守起见限制 20MB）
    if (!isFileSizeValid(file)) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(2)
      message.error(t('miniChatWindow.imageSizeExceeded', { name: file.name, size: sizeMB }))
      continue
    }

    // 先生成本地预览，再异步上传到对象存储
    try {
      const base64Data = await fileToBase64(file)
      const pendingImage: PendingImage = {
        id: pendingImageId,
        file,
        preview: base64Data,
        url: base64Data, // 直接使用 base64 作为 URL
        uploading: true
      }
      pendingImages.value.push(pendingImage)

      const uploadResult = await uploadImage(file)
      const currentImage = pendingImages.value.find((img) => img.id === pendingImageId)
      if (!currentImage) {
        continue
      }

      if (uploadResult.success && uploadResult.url) {
        currentImage.url = uploadResult.url
        currentImage.uploading = false
        currentImage.error = undefined
      } else {
        currentImage.uploading = false
        currentImage.error = uploadResult.error || t('miniChatWindow.imageUploadFailed')
        message.error(currentImage.error)
      }
    } catch (error) {
      const currentImage = pendingImages.value.find((img) => img.id === pendingImageId)
      if (currentImage) {
        currentImage.uploading = false
        currentImage.error =
          error instanceof Error ? error.message : t('miniChatWindow.imageReadFailed')
      }
      message.error(t('miniChatWindow.imageReadFailedWithName', { name: file.name }))
    }
  }
}

/**
 * 移除图片
 */
function removeImage(index: number): void {
  pendingImages.value.splice(index, 1)
}

/**
 * 发送消息
 */
async function sendMessage(): Promise<void> {
  const text = inputText.value.trim()
  const hasImages = pendingImages.value.length > 0
  if ((!text && !hasImages) || isGenerating.value || isUploading.value) return

  const imageUrls = pendingImages.value
    .filter((img) => img.url && !img.error)
    .map((img) => img.url!)

  const userContent = buildUserContent(text, imageUrls)

  inputText.value = ''
  pendingImages.value = []
  adjustInputHeight()

  await dispatchUserMessage(userContent)
}

/**
 * @param submitted 已经在提交那一刻定好的闪存（Spotlight 那条路）。
 *   给了就原样用，不重抓 —— 它是用户按回车时的状态，比现在准。
 */
async function dispatchUserMessage(
  content: ChatMessageContent,
  submitted?: {
    editorSnapshot?: EditorSnapshot | null
    sessionProject?: { projectName: string; projectPath?: string } | null
  }
): Promise<void> {
  /*
   * 会话号在**提交那一刻**定死。
   *
   * 下面要 await 一次闪存抓取（最多 2 秒），而这期间还没进入生成态 ——
   * 用户完全可以点标题栏那个「+」把会话重置掉。等抓取回来再读 `SESSION_ID.value`
   * 的话，这条**旧对话的消息**就在**新对话**里跑起来了：用户刚清空，屏幕上却冒出
   * 一句他以为已经丢掉的话，还带着旧会话的上下文。
   */
  const submittedSessionId = SESSION_ID.value

  const preview = getSessionPreview(content)
  chatSessionStore.ensureSession(submittedSessionId, t('miniChatWindow.defaultSessionTitle'))
  if (preview) {
    chatSessionStore.appendMessage(submittedSessionId, preview)
  }

  pushUser(content)
  await nextTick()
  scrollToBottom()

  /*
   * 用户按下发送那一刻抓闪存 —— 小窗口是快捷键拉起来的，用户多半正对着引擎，
   * 「这个」指什么全靠这一份。
   */
  let snapshot = submitted?.editorSnapshot
  let sessionProject = submitted?.sessionProject
  if (!submitted) {
    const captured = await agentV3API.captureEditorSnapshot({
      sessionProject: chatSessionStore.getProject?.(submittedSessionId) ?? null
    })
    snapshot = captured.ok ? captured.snapshot : null
    if (captured.ok) {
      sessionProject = {
        projectName: captured.snapshot.project.projectName,
        ...(captured.snapshot.project.projectPath
          ? { projectPath: captured.snapshot.project.projectPath }
          : {})
      }
    }
  }

  /*
   * 抓取期间用户把会话重置了 —— 这条话属于那条已经被清掉的对话，就此作废。
   *
   * 不能改投到新会话上：用户点「+」的意思是「刚才那些不算了」，把他刚打的那句
   * 挪过来等于替他决定。也不能硬发到旧会话上：那条对话界面上已经不存在了，
   * 消息发出去没有任何地方显示，模型却在后台照着它动手。
   */
  if (SESSION_ID.value !== submittedSessionId) {
    console.log('[MiniChat] 会话在发送途中被重置，丢弃这条消息')
    return
  }

  await executeAgent(content, undefined, {
    editorSnapshot: snapshot ?? null,
    ...(sessionProject ? { sessionProject } : {})
  })
}

/**
 * 处理初始消息（从 Spotlight 传入）
 */
async function handleInitialMessage(initialMsg: MiniChatInitialMessage): Promise<void> {
  console.log('[MiniChat] 收到初始消息:', initialMsg?.text)
  // 闪存在主进程、用户按回车那一刻就抓好了 —— 这里当**已提交**用，不再抓。
  // 到这一步已经隔了建窗口 + 页面加载 + 500ms 挂载，早不是「那一刻」了
  await dispatchUserMessage(initialMsg.text, {
    editorSnapshot: initialMsg.editorSnapshot ?? null,
    sessionProject: initialMsg.sessionProject ?? null
  })
}

/**
 * 接住主窗口递过来的上下文 —— 「侧边问一句」落地的那一步。
 *
 * 上下文本体是主进程里复制好的一份 transcript，这里只把新的内核 sessionId
 * 挂到当前这条界面会话上：下一句话发出去时，`useAgentMode` 会拿着它去
 * `agent-v3:execute`，主进程按 sessionId 恢复历史（见 ipc/agentV3.ts），
 * 模型于是带着主对话的全部来龙去脉开口。
 *
 * **界面消息不复制。** 400 像素宽的小窗口里堆二十轮历史，用户要找的那句话
 * 反而被埋了。横幅说清「承接了多少条上下文」就够 —— 他要看历史，主窗口就在旁边。
 *
 * 锁成只读（`askModeRef`）：主对话可能正跑着，让第二个 agent 同时去改同一个
 * 工程等于两个人抢一支笔。这个窗口能看能查能解释，动不了工程。
 */
function handleInitialContext(context: SideChatContext): void {
  if (!context?.agentSessionId) return

  console.log('[MiniChat] 收到侧边上下文:', context.agentSessionId, context.messageCount)

  sideContext.value = context
  // sessionId 要先落进 store：下一句话发出去时 useAgentMode 拿的就是它
  chatSessionStore.setAgentSessionId(SESSION_ID.value, context.agentSessionId)
  askModeRef.value = true
}

/** 当前这条会话借来的上下文。没借就是 null，横幅不显示 */
const sideContext = ref<SideChatContext | null>(null)

const sideContextLabel = computed(() => {
  const context = sideContext.value
  if (!context) return ''
  return context.live
    ? t('miniChatWindow.sideContext.live', { count: context.messageCount })
    : t('miniChatWindow.sideContext.snapshot', { count: context.messageCount })
})

async function stopCurrentResponse(): Promise<void> {
  await stopAgent()
  currentTypingId.value = null
}

async function handleStopGenerating(): Promise<void> {
  if (!isGenerating.value) return
  await stopCurrentResponse()
}

async function startNewSession(): Promise<void> {
  // 正在念的是上一场对话的话，别让它跟进新会话
  stopReadAloud()
  if (isGenerating.value) {
    await stopCurrentResponse()
  }
  handleResetSession()
}

async function handleAssistantCopy(payload: { id: string; content: string }): Promise<void> {
  try {
    await navigator.clipboard.writeText(payload.content)
    message.success(t('miniChatWindow.copied'))
  } catch (error) {
    console.error('[MiniChat] 复制失败:', error)
    message.error(t('miniChatWindow.copyFailed'))
  }
}

async function handleUserBubbleCopy(payload: { id: string; content: string }): Promise<void> {
  await handleAssistantCopy(payload)
}

async function handleBubbleRetry(payload: { id: string; content: string }): Promise<void> {
  const msgIndex = messages.value.findIndex((msg) => msg.id === payload.id)
  if (msgIndex < 0) {
    message.error(t('miniChatWindow.retryMessageNotFound'))
    return
  }

  const currentMsg = messages.value[msgIndex]
  if (currentMsg.role !== 'assistant') {
    message.error(t('miniChatWindow.canOnlyRetryAssistant'))
    return
  }

  let userMsgIndex = -1
  for (let i = msgIndex - 1; i >= 0; i--) {
    if (messages.value[i].role === 'user') {
      userMsgIndex = i
      break
    }
  }

  if (userMsgIndex < 0) {
    message.error(t('miniChatWindow.correspondingUserMessageNotFound'))
    return
  }

  const userMsg = messages.value[userMsgIndex]

  chatMsgStore.deleteMessagesFromIndex(SESSION_ID.value, msgIndex)

  // 这里原来还去删一次后端 SQLite 的对话历史。Agent 压根不往那张表写，
  // 这个调用一直是空转；那套存储已经整体移除。
  fullConversationHistory.value = buildAgentHistoryUntil(userMsgIndex)
  chatSessionStore.setAgentHistory(SESSION_ID.value, fullConversationHistory.value)

  // 内核那份历史也得倒回去，否则模型看着刚被丢掉的答案再答一遍同一个问题
  await rewindTranscript(
    chatSessionStore.getAgentSessionId(SESSION_ID.value),
    countUserTurnsBefore(messages.value, userMsgIndex),
    agentV3API.truncateSession
  )

  await executeAgent(userMsg.content, undefined, { isRetry: true })
}

async function handleUserConfirmEdit(payload: {
  id: string
  newContent: string
  originalContent: ChatMessageContent
}): Promise<void> {
  const msgIndex = messages.value.findIndex((msg) => msg.id === payload.id)
  if (msgIndex < 0) {
    message.error(t('miniChatWindow.editMessageNotFound'))
    return
  }

  const currentMsg = messages.value[msgIndex]
  if (currentMsg.role !== 'user') {
    message.error(t('miniChatWindow.canOnlyEditUser'))
    return
  }

  let nextContent: ChatMessageContent
  if (typeof payload.originalContent === 'string') {
    nextContent = payload.newContent
  } else {
    const imageItems = payload.originalContent.filter((item) => item.type === 'image_url')
    nextContent =
      imageItems.length > 0
        ? [{ type: 'text', text: payload.newContent }, ...imageItems]
        : payload.newContent
  }

  chatMsgStore.deleteMessagesFromIndex(SESSION_ID.value, msgIndex)

  fullConversationHistory.value = buildAgentHistoryUntil(msgIndex - 1)
  chatSessionStore.setAgentHistory(SESSION_ID.value, fullConversationHistory.value)

  // 同 handleBubbleRetry：内核那份历史跟着倒回这条消息之前，
  // 不倒的话模型手上还留着原话，改完再问等于追加而不是替换
  await rewindTranscript(
    chatSessionStore.getAgentSessionId(SESSION_ID.value),
    countUserTurnsBefore(messages.value, msgIndex),
    agentV3API.truncateSession
  )

  await dispatchUserMessage(nextContent)
}

/**
 * 切换置顶状态
 */
function togglePin(): void {
  window.api.miniChat.togglePin()
}

/**
 * 处理置顶状态变化
 */
function handlePinChanged(pinned: boolean): void {
  isPinned.value = pinned
}

/**
 * 最小化窗口
 */
function minimize(): void {
  window.api.miniChat.minimize()
}

/**
 * 关闭窗口
 * 边界情况：如果有待处理的敏感操作确认，自动拒绝以防止 Agent 挂起
 */
function closeWindow(): void {
  // 还等着的敏感操作确认一律按拒绝回传，否则主进程要干等到超时
  pendingApprovals.rejectAll()
  if (isGenerating.value) {
    void stopCurrentResponse()
  }
  // 窗口都收起来了，声音也该停：小窗没有主窗口那条常驻播放条，不停就没处掐
  stopReadAloud()
  window.api.miniChat.close()
}

/**
 * 调整输入框高度
 */
function adjustInputHeight(): void {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 80)}px`
}

/**
 * 滚动到底部
 */
function scrollToBottom(): void {
  nextTick(() => {
    if (messageListRef.value) {
      messageListRef.value.scrollTop = messageListRef.value.scrollHeight
    }
  })
}

/**
 * 处理会话重置（关闭窗口时）
 * 根据设置决定是否保存对话到主界面历史，然后清除本地消息并创建新会话
 */
function handleResetSession(): void {
  console.log('[MiniChat] 重置会话:', SESSION_ID.value)

  // 同上：会话都重置了，没人会再来点那个确认框
  pendingApprovals.rejectAll()

  // 直接从 localStorage 读取设置（因为独立窗口的 Pinia store 可能不会同步）
  let miniChatPersistEnabled = false
  try {
    const aiConfigStr = localStorage.getItem('ai-config-store')
    if (aiConfigStr) {
      const aiConfig = JSON.parse(aiConfigStr)
      miniChatPersistEnabled = aiConfig?.config?.miniChatPersistEnabled ?? false
    }
  } catch (e) {
    console.warn('[MiniChat] 读取设置失败:', e)
  }
  console.log('[MiniChat] miniChatPersistEnabled:', miniChatPersistEnabled)

  // 如果开启了持久会话，先检查是否有实际内容需要保存
  if (!MINI_CHAT_SETTINGS_ENABLED || miniChatPersistEnabled) {
    const msgs = chatMsgStore.getMessages(SESSION_ID.value)
    // 只保存有实际内容的对话（用户消息+AI回复）
    const hasContent = msgs.some((m) => m.role === 'assistant' && m.status === 'done')
    console.log('[MiniChat] hasContent:', hasContent, 'msgs count:', msgs.length)
    if (hasContent) {
      // 基于首条用户消息生成标题
      const firstUserMsg = msgs.find((m) => m.role === 'user')
      const content = typeof firstUserMsg?.content === 'string' ? firstUserMsg.content : ''
      const title = content.slice(0, 20) + (content.length > 20 ? '...' : '')
      chatSessionStore.updateTitle(
        SESSION_ID.value,
        title || t('miniChatWindow.defaultSessionTitle')
      )
      console.log('[MiniChat] 对话已保存到历史, 标题:', title)

      // 通知主窗口刷新会话列表
      console.log('[MiniChat] 发送 IPC 事件: mini-chat:session-saved')
      window.api.miniChat.sessionSaved({
        id: SESSION_ID.value,
        title: title || t('miniChatWindow.defaultSessionTitle'),
        // 主窗口靠这一份把消息同步进自己的 store（SideMenu 的 chat-sessions:refresh），
        // 少传的话侧边栏会多出一条点开是空的会话
        messages: JSON.parse(JSON.stringify(msgs))
      })

      // 注意：不清除消息，让它们保留在 store 中供主界面历史访问
    } else {
      // 没有内容的对话直接清除
      chatMsgStore.clearSessionMessages(SESSION_ID.value)
    }
  } else {
    // 临时会话模式：直接清除所有消息
    chatMsgStore.clearSessionMessages(SESSION_ID.value)
  }

  // 重置 Agent 会话 ID
  chatSessionStore.setAgentSessionId(SESSION_ID.value, '')

  // 借来的上下文跟着这条会话一起作废。留着的话，用户点「新对话」之后
  // 横幅还挂着「承接了 42 条」，而新会话的内核 sessionId 已经换了 —— 那句话是假的
  sideContext.value = null
  askModeRef.value = false

  currentTypingId.value = null
  currentAgentProcess.value = []
  fullConversationHistory.value = []

  // 生成新的会话 ID，确保下次打开是全新对话
  SESSION_ID.value = generateSessionId()
  initSession()
  nextTick(() => {
    inputRef.value?.focus()
  })
}

watch(
  () => {
    const lastMessage = messages.value[messages.value.length - 1]
    if (!lastMessage) return ''
    return [
      messages.value.length,
      lastMessage.id,
      lastMessage.status || '',
      extractTextFromContent(lastMessage.content).length,
      lastMessage.thinking?.length || 0,
      lastMessage.agentProcess?.length || 0
    ].join(':')
  },
  () => {
    scrollToBottom()
  }
)

watch(
  () => aiConfigStore.miniChatOpacity,
  (opacity) => {
    applyMiniChatOpacity(opacity)
  },
  { immediate: true }
)

/** IPC 订阅的取消函数。preload 的 on* 一律返回一个，卸载时挨个调 */
let ipcDisposers: Array<() => void> = []

onMounted(() => {
  console.log('[MiniChat] onMounted 开始, SESSION_ID:', SESSION_ID.value)
  restoreAgentModeState(true)
  initSession()
  inputRef.value?.focus()

  ipcDisposers = [
    window.api.miniChat.onInitialMessage(handleInitialMessage),
    window.api.miniChat.onInitialContext(handleInitialContext),
    window.api.miniChat.onPinChanged(handlePinChanged),
    window.api.miniChat.onResetSession(handleResetSession)
  ]

  // 主动要一次（备用机制，防止投递早于挂载）
  window.api.miniChat.requestInitialMessage()
  window.api.miniChat.requestInitialContext()
})

onUnmounted(() => {
  for (const dispose of ipcDisposers) dispose()
  ipcDisposers = []
})
</script>

<style scoped lang="less">
.mini-chat-window {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
  width: 100%;
  min-width: 0;
}

.title-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--color-bg-page);
  border-bottom: 1px solid var(--color-border-subtle);
  -webkit-app-region: drag;
}

.title-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.title-logo {
  width: 18px;
  height: 18px;
  flex: none;
}

.window-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: no-drag;
}

.control-btn {
  color: var(--color-text-primary);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s;

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }

  &.pinned {
    color: var(--color-accent-solid);
  }

  &.close:hover {
    background: var(--color-danger-solid);
  }

  &.warning {
    color: var(--color-warning-text);
  }
}

/* 承接主对话上下文时的横幅。窄窗口里只有一行的位置，说最要紧的两件事 */
.side-context-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.side-context-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side-context-tag {
  flex: none;
  padding: 0 6px;
  border-radius: var(--radius-xs);
  background: var(--color-bg-surface);
  color: var(--color-text-muted);
}

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  font-size: 13px;
}

.input-area {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--color-border-subtle);

  :deep(.app-button) {
    height: 36px;
    min-width: 60px;
    border-radius: 8px;
    background: var(--color-accent-solid);
    border-color: var(--color-accent-border);
    font-size: 13px;

    &:hover:not(:disabled) {
      background: var(--color-accent-solid);
      border-color: var(--color-accent-border);
    }

    &:disabled {
      background: var(--color-accent-solid);
      border-color: transparent;
      color: var(--color-text-on-solid);
    }
  }
}

.image-preview-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.image-preview-item {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--color-bg-surface-hover);

  .preview-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .upload-overlay {
    position: absolute;
    inset: 0;
    background: var(--color-bg-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-primary);
    font-size: 14px;
  }

  .remove-btn {
    position: absolute;
    top: -4px;
    right: -4px;
    font-size: 14px;
    color: var(--color-text-primary);
    cursor: pointer;
    transition: color 0.15s;
    background: var(--color-bg-surface);
    border-radius: 50%;

    &:hover {
      color: var(--color-danger-text);
    }
  }
}

.input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.attach-btn {
  font-size: 18px;
  color: var(--color-text-primary);
  cursor: pointer;
  padding: 8px 4px;
  /*
   * 全局是 border-box，而 Phosphor 图标把 1em 写在 svg 的 width/height 属性上：
   * 18px 的盒子扣掉上下 8px 内边距，画图的地方只剩 2px 高，回形针就缩成一个点。
   */
  box-sizing: content-box;
  flex: none;
  transition: color 0.15s;

  &:hover {
    color: var(--color-text-primary);
  }
}

.input-box {
  flex: 1;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--color-text-primary);
  font-size: 13px;
  resize: none;
  outline: none;
  min-height: 36px;
  max-height: 80px;

  &::placeholder {
    color: var(--color-text-disabled);
  }
}
</style>
