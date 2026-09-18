<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhPictureInPicture, PhSidebarSimple } from '@phosphor-icons/vue'
import AssistantWelcome from '@renderer/views/Assistant/Welcome.vue'
import type { LibraryChatContext } from '@renderer/views/Assistant/composables/libraryChatContext'
import type { AIPanelMode } from '../types'

/**
 * 蓝图库 / 材质库详情页右边那块 AI 面板。
 *
 * ## 它只是个壳
 *
 * 里面嵌的是**主助手本身**（`Assistant/Welcome.vue`），和知识库详情页
 * 用的是同一个组件、同一套工具、同一个内核。这个文件只负责壳的那部分：
 * 停靠 / 悬浮 / 折叠三种形态、拖宽、悬浮窗拖拽与缩放、折叠条。
 *
 * ## 之前这里是什么
 *
 * `BaseAIChatPanel.vue`：一个自己另起炉灶的单轮聊天框 —— 硬编码中文系统
 * 提示词、直接调 `ipcRenderer`（绕过硬规则第 5 条）、自己一张聊天表。
 * 它没有工具、看不见引擎、不会用技能，所以在库里问「这段逻辑为什么每帧都跑」
 * 只能对着一段文本猜。整个换掉了，不留兼容层。
 *
 * ## 「用户正在看什么」怎么告诉助手
 *
 * `context` 这个 prop 每一轮请求前被读一次，拼成一条上下文消息塞在最前面
 * （见 `Assistant/composables/libraryChatContext.ts`）。它**不进会话历史**，
 * 所以带的永远是当下的选中节点，用户点了别的节点就跟着变。
 *
 * ## 为什么要 mousedown 捕获
 *
 * 用户在画布上框选几个节点，然后去输入框打字 —— 焦点一转移，画布的选中态
 * 就没了。所以在**捕获阶段**（比输入框自己的处理更早）通知页面去拍一张
 * 选中快照。这条是从旧面板继承下来的，旧面板把它挂在自己的输入区上；
 * 现在输入区在嵌进来的助手里面，挂在外层捕获阶段效果一样，而且不用去
 * 改助手的组件。
 */

const props = withDefaults(
  defineProps<{
    /** 会话 id。用 `library-chat-` 打头，这样它不会混进侧边栏的会话列表 */
    sessionId: string
    mode?: AIPanelMode
    /** 交给助手的上下文：当前条目 + 选中节点 */
    context: LibraryChatContext | null
    /** 悬浮窗尺寸持久化前缀（localStorage `${prefix}-w` / `-h`） */
    overlayStoragePrefix: string
  }>(),
  { mode: 'docked' }
)

const emit = defineEmits<{
  /** 焦点即将离开画布，请页面拍一张选中快照 */
  'snapshot-selection': []
  'update:mode': [mode: AIPanelMode]
  restore: []
}>()

const { t } = useI18n()

const selectedCount = computed(() => props.context?.selectedNodes?.length ?? 0)

/**
 * 焦点要进输入框了，先让页面拍一张画布选中快照。
 *
 * **只认落在输入类元素上的那一次**。挂在整块面板上无差别触发的话，用户在
 * 助手里点一下工具日志、滚一下列表都会去重新序列化一遍选中节点 ——
 * 选了十几个节点时那是一次实打实的开销，而且和「焦点转移」根本没关系。
 *
 * 捕获阶段触发：冒泡上来时焦点已经转移了，那时候再拍就晚了。
 */
function handleBodyMouseDown(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  if (!target?.closest?.('textarea, input, [contenteditable="true"]')) return
  emit('snapshot-selection')
}

/**
 * 空面板时的起手式。
 *
 * 通用那组（「帮我生成一张概念图」之类）在这个页面里是走神的，整组换掉。
 * 三张卡对应用户在库里真正会问的三件事：看懂它、判断它值不值得留、把它用起来。
 * 「放进工程」那张是**唯一会改用户工程**的一条，它走的是库的放回工具，
 * 有审批门兜着 —— 别让用户去手动复制粘贴。
 */
const suggestions = computed(() => {
  const name = props.context?.entryName ?? ''
  const isBlueprint = props.context?.library !== 'material'
  const subject = name ? `「${name}」` : isBlueprint ? '这个蓝图' : '这个材质'

  if (!isBlueprint) {
    return [
      {
        title: t('libraryAIPanel.suggestions.material.explain.title'),
        description: t('libraryAIPanel.suggestions.material.explain.desc'),
        prompt: t('libraryAIPanel.suggestions.material.explain.prompt', { subject })
      },
      {
        title: t('libraryAIPanel.suggestions.material.performance.title'),
        description: t('libraryAIPanel.suggestions.material.performance.desc'),
        prompt: t('libraryAIPanel.suggestions.material.performance.prompt', { subject })
      },
      {
        title: t('libraryAIPanel.suggestions.material.dependencies.title'),
        description: t('libraryAIPanel.suggestions.material.dependencies.desc'),
        prompt: t('libraryAIPanel.suggestions.material.dependencies.prompt', { subject })
      }
    ]
  }

  return [
    {
      title: t('libraryAIPanel.suggestions.blueprint.explain.title'),
      description: t('libraryAIPanel.suggestions.blueprint.explain.desc'),
      prompt: t('libraryAIPanel.suggestions.blueprint.explain.prompt', { subject })
    },
    {
      title: t('libraryAIPanel.suggestions.blueprint.review.title'),
      description: t('libraryAIPanel.suggestions.blueprint.review.desc'),
      prompt: t('libraryAIPanel.suggestions.blueprint.review.prompt', { subject })
    },
    {
      title: t('libraryAIPanel.suggestions.blueprint.apply.title'),
      description: t('libraryAIPanel.suggestions.blueprint.apply.desc'),
      prompt: t('libraryAIPanel.suggestions.blueprint.apply.prompt', { subject })
    }
  ]
})

// ========== 停靠模式：左缘拖宽 ==========
/*
 * 比旧面板宽不少（旧的默认 320 / 最小 240）。那时候里面只有一问一答的纯文本，
 * 现在是真助手：工具调用日志、审批卡、文件 diff —— 320px 下这些东西没法看。
 *
 * **但也没到助手原样铺开需要的那个宽度。** 输入区底下那排控件
 * （审批档 / 思考档 / 模型名）带着文字要 550px 才不换行，而 550 宽的面板
 * 会把蓝图画布挤没。解决办法在 `InputComposer.vue` 那边：窄容器下用容器查询
 * 把这排文字折成图标（折掉的字进 title）。两个数字是配套的，改这里的宽度
 * 前先看一眼那边的断点。
 */
const panelWidth = ref(420)
const isDragging = ref(false)
const MIN_WIDTH = 380
const MAX_WIDTH = 720

// ========== 悬浮模式：位置与尺寸（尺寸持久化） ==========
const overlayPos = ref({ x: -1, y: -1 })
const overlaySize = ref({
  width: Number(localStorage.getItem(`${props.overlayStoragePrefix}-w`)) || 520,
  height: Number(localStorage.getItem(`${props.overlayStoragePrefix}-h`)) || 640
})

watch(
  overlaySize,
  (newVal) => {
    localStorage.setItem(`${props.overlayStoragePrefix}-w`, String(newVal.width))
    localStorage.setItem(`${props.overlayStoragePrefix}-h`, String(newVal.height))
  },
  { deep: true }
)

const isDraggingOverlay = ref(false)
const isResizingOverlay = ref(false)

/** 悬浮窗最小尺寸。比停靠态再小就放不下助手的输入区了 */
const OVERLAY_MIN_WIDTH = 380
const OVERLAY_MIN_HEIGHT = 360

const panelStyle = computed(() => {
  if (props.mode === 'overlay') {
    const style: Record<string, string> = {
      width: `${overlaySize.value.width}px`,
      height: `${overlaySize.value.height}px`
    }
    if (overlayPos.value.x !== -1) {
      style.left = `${overlayPos.value.x}px`
      style.top = `${overlayPos.value.y}px`
      style.right = 'auto'
      style.bottom = 'auto'
    }
    return style
  }
  return {
    width: `${panelWidth.value}px`
  }
})

function initOverlayPos(panelEl: HTMLElement): void {
  if (overlayPos.value.x === -1) {
    const parentRect = panelEl.parentElement!.getBoundingClientRect()
    const rect = panelEl.getBoundingClientRect()
    overlayPos.value.x = rect.left - parentRect.left
    overlayPos.value.y = rect.top - parentRect.top
  }
}

function onOverlayDragStart(e: MouseEvent): void {
  if (props.mode !== 'overlay') return
  if ((e.target as HTMLElement).closest('button')) return

  e.preventDefault()
  const panelEl = (e.currentTarget as HTMLElement).closest('.lib-ai-panel') as HTMLElement
  if (!panelEl) return

  initOverlayPos(panelEl)

  isDraggingOverlay.value = true
  const startX = e.clientX
  const startY = e.clientY
  const initialX = overlayPos.value.x
  const initialY = overlayPos.value.y

  const parentRect = panelEl.parentElement!.getBoundingClientRect()
  const rect = panelEl.getBoundingClientRect()
  const maxX = Math.max(0, parentRect.width - rect.width)
  const maxY = Math.max(0, parentRect.height - rect.height)

  function onMouseMove(ev: MouseEvent): void {
    overlayPos.value.x = Math.max(0, Math.min(initialX + (ev.clientX - startX), maxX))
    overlayPos.value.y = Math.max(0, Math.min(initialY + (ev.clientY - startY), maxY))
  }

  function onMouseUp(): void {
    isDraggingOverlay.value = false
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

function onOverlayResizeStart(e: MouseEvent, dir: string): void {
  e.preventDefault()
  e.stopPropagation()
  const panelEl = (e.currentTarget as HTMLElement).closest('.lib-ai-panel') as HTMLElement
  if (!panelEl) return

  initOverlayPos(panelEl)

  isResizingOverlay.value = true
  const startX = e.clientX
  const startY = e.clientY
  const initialWidth = overlaySize.value.width
  const initialHeight = overlaySize.value.height
  const initialX = overlayPos.value.x
  const initialY = overlayPos.value.y

  const parentRect = panelEl.parentElement!.getBoundingClientRect()

  function onMouseMove(ev: MouseEvent): void {
    const deltaX = ev.clientX - startX
    const deltaY = ev.clientY - startY

    let newWidth = initialWidth
    let newHeight = initialHeight
    let newX = initialX
    let newY = initialY

    if (dir.includes('right')) {
      newWidth = Math.max(OVERLAY_MIN_WIDTH, initialWidth + deltaX)
      newWidth = Math.min(newWidth, parentRect.width - newX)
    }
    if (dir.includes('left')) {
      const maxDeltaX = initialWidth - OVERLAY_MIN_WIDTH
      const actualDeltaX = Math.max(-initialX, Math.min(deltaX, maxDeltaX))
      newWidth = initialWidth - actualDeltaX
      newX = initialX + actualDeltaX
    }
    if (dir.includes('bottom')) {
      newHeight = Math.max(OVERLAY_MIN_HEIGHT, initialHeight + deltaY)
      newHeight = Math.min(newHeight, parentRect.height - newY)
    }
    if (dir.includes('top')) {
      const maxDeltaY = initialHeight - OVERLAY_MIN_HEIGHT
      const actualDeltaY = Math.max(-initialY, Math.min(deltaY, maxDeltaY))
      newHeight = initialHeight - actualDeltaY
      newY = initialY + actualDeltaY
    }

    overlaySize.value.width = newWidth
    overlaySize.value.height = newHeight
    overlayPos.value.x = newX
    overlayPos.value.y = newY
  }

  function onMouseUp(): void {
    isResizingOverlay.value = false
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

function onResizeStart(e: MouseEvent): void {
  e.preventDefault()
  isDragging.value = true
  const startX = e.clientX
  const startWidth = panelWidth.value

  function onMouseMove(ev: MouseEvent): void {
    // 向左拖 = 宽度增大（因为面板在右侧）
    const delta = startX - ev.clientX
    panelWidth.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta))
  }

  function onMouseUp(): void {
    isDragging.value = false
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}
</script>

<template>
  <div
    v-if="mode === 'collapsed'"
    class="lib-ai-panel-collapsed"
    :title="t('libraryAIPanel.expandTooltip')"
    @click="emit('restore')"
  >
    <div class="collapsed-icon">
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <rect x="3" y="11" width="18" height="10" rx="2"></rect>
        <circle cx="12" cy="5" r="2"></circle>
        <path d="M12 7v4"></path>
        <line x1="8" y1="16" x2="8" y2="16"></line>
        <line x1="16" y1="16" x2="16" y2="16"></line>
      </svg>
    </div>
    <div class="collapsed-text">{{ t('libraryAIPanel.collapsedLabel') }}</div>
  </div>

  <div
    v-else
    class="lib-ai-panel"
    :class="{
      'is-dragging': isDragging || isDraggingOverlay || isResizingOverlay,
      'mode-overlay': mode === 'overlay'
    }"
    :style="panelStyle"
  >
    <!-- 悬浮模式缩放手柄 -->
    <template v-if="mode === 'overlay'">
      <div class="overlay-resize-handle n" @mousedown="onOverlayResizeStart($event, 'top')" />
      <div class="overlay-resize-handle e" @mousedown="onOverlayResizeStart($event, 'right')" />
      <div class="overlay-resize-handle s" @mousedown="onOverlayResizeStart($event, 'bottom')" />
      <div class="overlay-resize-handle w" @mousedown="onOverlayResizeStart($event, 'left')" />
      <div class="overlay-resize-handle nw" @mousedown="onOverlayResizeStart($event, 'top-left')" />
      <div
        class="overlay-resize-handle ne"
        @mousedown="onOverlayResizeStart($event, 'top-right')"
      />
      <div
        class="overlay-resize-handle sw"
        @mousedown="onOverlayResizeStart($event, 'bottom-left')"
      />
      <div
        class="overlay-resize-handle se"
        @mousedown="onOverlayResizeStart($event, 'bottom-right')"
      />
    </template>

    <!-- 停靠模式左缘拖宽手柄 -->
    <div v-show="mode !== 'overlay'" class="resize-handle" @mousedown="onResizeStart" />

    <!-- 头部：只有形态按钮。会话本身的操作（清空、导出、侧边问一句）在助手自己的顶栏里 -->
    <div
      class="panel-header"
      :style="mode === 'overlay' ? { cursor: 'move' } : {}"
      @mousedown="onOverlayDragStart"
    >
      <span class="header-title">{{ t('libraryAIPanel.title') }}</span>
      <div class="panel-controls">
        <button
          type="button"
          class="icon-btn"
          :class="{ active: mode === 'docked' }"
          :title="t('libraryAIPanel.dockTooltip')"
          @click="emit('update:mode', 'docked')"
        >
          <PhSidebarSimple :size="16" mirrored aria-hidden="true" />
        </button>
        <button
          type="button"
          class="icon-btn"
          :class="{ active: mode === 'overlay' }"
          :title="t('libraryAIPanel.overlayTooltip')"
          @click="emit('update:mode', 'overlay')"
        >
          <PhPictureInPicture :size="16" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="icon-btn"
          :title="t('libraryAIPanel.collapseTooltip')"
          @click="emit('update:mode', 'collapsed')"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="13 17 18 12 13 7"></polyline>
            <line x1="6" y1="17" x2="11" y2="12"></line>
            <line x1="6" y1="7" x2="11" y2="12"></line>
          </svg>
        </button>
      </div>
    </div>

    <!-- 选中节点提示：让用户看得见助手手上握着什么 -->
    <div v-if="selectedCount > 0" class="selected-nodes-bar">
      {{ t('libraryAIPanel.selectedNodes', { count: selectedCount }) }}
    </div>

    <!--
      捕获阶段拍快照：用户点进输入框那一刻，画布的选中态还在。
      等冒泡上来就晚了 —— 那时焦点已经转移，选中的节点没了。
    -->
    <div class="panel-body" @mousedown.capture="handleBodyMouseDown">
      <!--
        不加 :key。`Welcome.vue` 自己 watch 了 sessionId（注释写着「keep-alive
        下的关键」），换条目时它会自己切过去；加 key 会把整个助手连同内核连接
        一起重建，白白多一次卸载重挂。
      -->
      <AssistantWelcome
        :force-chat-view="true"
        :session-id="sessionId"
        :library-context="context"
        :custom-suggestions="suggestions"
      />
    </div>
  </div>
</template>

<style scoped lang="less">
.lib-ai-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  flex-shrink: 0;
  min-height: 0;

  &.is-dragging {
    user-select: none;
  }

  &.mode-overlay {
    position: absolute;
    right: 12px;
    top: 12px;
    z-index: 100;
    background: var(--color-bg-page);
    backdrop-filter: blur(12px);
    box-shadow: 0 8px 32px var(--shadow-color);
    border: 1px solid var(--color-border-subtle);
    border-radius: 10px;
    overflow: hidden;
  }
}

.panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  // 助手内部自己滚，别让它把面板撑破
  overflow: hidden;

  // 嵌进来的助手要把这块填满，它自己内部再分聊天区和输入区
  > * {
    flex: 1;
    min-height: 0;
  }

  /*
   * 助手是按**整页**写的：它的根上挂着 `min-height: calc(100vh - 64px)`，
   * 那是「填满窗口」的意思。塞进一块四百来宽、比窗口矮的面板里，
   * 这条会把它顶得比面板还高 —— 面板底下的输入框被挤出可视区，
   * 用户看得见对话却打不了字。
   *
   * 所以在**嵌入这一侧**把它改回「填满我给你的这块」。不去改助手本身：
   * 它在助手页和知识库那边都是对的，错的只是「被塞进一个更小的盒子」这件事。
   */
  :deep(.assistant-shell),
  :deep(.assistant-welcome) {
    min-height: 0;
    height: 100%;
  }
}

.lib-ai-panel-collapsed {
  width: 40px;
  background: var(--color-bg-surface-hover);
  border-left: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 14px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.2s;

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  .collapsed-icon {
    margin-bottom: 16px;
    color: var(--color-text-primary);
  }

  .collapsed-text {
    writing-mode: vertical-rl;
    font-size: 12px;
    color: var(--color-text-primary);
    letter-spacing: 2px;
    user-select: none;
  }
}

// ========== Overlay Resize Handles ==========
.overlay-resize-handle {
  position: absolute;
  z-index: 10;
  &.n {
    top: -4px;
    left: 6px;
    right: 6px;
    height: 8px;
    cursor: ns-resize;
  }
  &.s {
    bottom: -4px;
    left: 6px;
    right: 6px;
    height: 8px;
    cursor: ns-resize;
  }
  &.e {
    top: 6px;
    bottom: 6px;
    right: -4px;
    width: 8px;
    cursor: ew-resize;
  }
  &.w {
    top: 6px;
    bottom: 6px;
    left: -4px;
    width: 8px;
    cursor: ew-resize;
  }
  &.nw {
    top: -4px;
    left: -4px;
    width: 10px;
    height: 10px;
    cursor: nwse-resize;
    z-index: 11;
  }
  &.ne {
    top: -4px;
    right: -4px;
    width: 10px;
    height: 10px;
    cursor: nesw-resize;
    z-index: 11;
  }
  &.sw {
    bottom: -4px;
    left: -4px;
    width: 10px;
    height: 10px;
    cursor: nesw-resize;
    z-index: 11;
  }
  &.se {
    bottom: -4px;
    right: -4px;
    width: 10px;
    height: 10px;
    cursor: nwse-resize;
    z-index: 11;
  }
}

.resize-handle {
  position: absolute;
  top: 0;
  left: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;

  &::after {
    content: '';
    position: absolute;
    top: 0;
    left: 2px;
    width: 2px;
    height: 100%;
    background: transparent;
    transition: background 0.15s;
  }

  &:hover::after,
  .is-dragging &::after {
    background: var(--color-accent-solid);
  }
}

// ========== Header ==========
.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 14px;
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
}

.header-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.panel-controls {
  display: flex;
  align-items: center;
  gap: 2px;
}

.icon-btn {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;

  &:hover:not(:disabled) {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }

  &.active {
    color: var(--color-text-selected);
    background: var(--color-bg-selected);
  }
}

// ========== Selected Nodes Bar ==========
.selected-nodes-bar {
  padding: 5px 14px;
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
  font-size: 12px;
  color: var(--color-text-selected);
  background: var(--color-bg-selected);
}
</style>
