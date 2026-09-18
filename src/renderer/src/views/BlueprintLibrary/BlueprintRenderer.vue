<template>
  <div
    ref="containerRef"
    :class="{ 'is-restoring': isRestoringViewState }"
    class="blueprint-renderer"
  >
    <div v-if="loading" class="renderer-loading">
      <div class="loading-spinner" />
      <div class="loading-text">{{ $t('blueprintLibraryRenderer.loadingText') }}</div>
    </div>
    <div v-if="error" class="renderer-error">
      <div class="error-icon">⚠️</div>
      <div class="error-text">{{ error }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBlueprintLibraryStore } from '@renderer/store/modules/blueprintLibraryStore'
import type { BlueprintElementType } from '@renderer/views/BlueprintLibrary/types/blueprint'
import type { ExtractedVariable } from '@renderer/views/BlueprintLibrary/utils/blueprintCodeParser'
import {
  createCommentNodeClipboardText,
  createVariableNodeClipboardText,
  createFunctionNodeClipboardText,
  type VariableNodeAccessType
} from '@renderer/views/BlueprintLibrary/utils/variableNodeFactory'
import type { FunctionParam } from '@renderer/views/BlueprintLibrary/types/blueprint'

const props = defineProps<{
  /** UE 蓝图导出代码（Begin Object … End Object） */
  code: string
  /** 图表名称，用于调试 */
  name?: string
  /** 持久化：蓝图 ID */
  blueprintId?: string
  /** 持久化：当前元素 ID */
  elementId?: string
  /** 持久化：当前元素类型 */
  elementType?: BlueprintElementType
}>()

const emit = defineEmits<{
  (event: 'content-change', code: string): void
}>()

const { t } = useI18n()
const store = useBlueprintLibraryStore()
const containerRef = ref<HTMLDivElement>()
const loading = ref(true)
const error = ref('')

let cssLoaded = false
let jsLoaded = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let isSelfUpdate = false // 防止自身保存触发重新渲染
let hasHydratedCurrentBlueprint = false
let lastStableSerializedCode = ''
const isRestoringViewState = ref(false)
let restoreSequence = 0

interface BlueprintRendererViewState {
  zoom: number
  scrollX: number
  scrollY: number
  translateX: number | null
  translateY: number | null
  centerX: number | null
  centerY: number | null
  selectedNodeNames: string[]
}

/**
 * 获取静态资源的正确路径
 * 开发模式 (http) 使用绝对路径 /，打包后 (file://) 相对于 HTML 文件目录
 */
function getResourceUrl(relativePath: string): string {
  if (window.location.protocol === 'file:') {
    // 先去掉 hash 部分（#/xxx），再去掉文件名，保留目录
    const hrefWithoutHash = window.location.href.split('#')[0]
    const base = hrefWithoutHash.replace(/[^/]*$/, '')
    return base + relativePath
  }
  return '/' + relativePath
}

// ========== CSS 加载 ==========
function ensureCSS(): void {
  if (cssLoaded) return
  const id = 'ueblueprint-css'
  if (document.getElementById(id)) {
    cssLoaded = true
    return
  }
  const link = document.createElement('link')
  link.id = id
  link.rel = 'stylesheet'
  link.href = getResourceUrl('ueblueprint/css/ueb-style.min.css')
  document.head.appendChild(link)
  cssLoaded = true
}

// ========== JS 模块加载 ==========
function ensureJS(): Promise<void> {
  if (jsLoaded) return Promise.resolve()
  const id = 'ueblueprint-js'
  const existing = document.getElementById(id) as HTMLScriptElement | null
  if (existing) {
    jsLoaded = true
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.id = id
    script.src = getResourceUrl('ueblueprint/ueblueprint.js')
    script.onload = () => {
      jsLoaded = true
      resolve()
    }
    script.onerror = (e) => {
      console.error('[BlueprintRenderer] 加载 ueblueprint.js 失败:', e)
      reject(new Error('ueblueprint.js 加载失败'))
    }
    document.head.appendChild(script)
  })
}

// ========== 渲染核心 ==========
function renderBlueprint(): void {
  const container = containerRef.value
  if (!container) return
  hasHydratedCurrentBlueprint = !props.code?.trim()
  lastStableSerializedCode = props.code || ''
  const pendingViewState = getPersistedViewState()
  const currentRestoreSequence = ++restoreSequence
  isRestoringViewState.value = pendingViewState !== null
  cleanupCanvasShortcutTracking()

  // 清除已有的渲染器
  const existingWrapper = container.querySelector('ueb-blueprint')?.parentElement
  if (existingWrapper && existingWrapper !== container) {
    existingWrapper.remove()
  }

  // 构建 innerHTML — 无论 code 是否为空都创建 ueb-blueprint（空画布也要显示网格）
  const codeContent = props.code?.trim() ? `<template>${props.code}</template>` : ''
  const wrapper = document.createElement('div')
  wrapper.style.width = '100%'
  wrapper.style.height = '100%'
  wrapper.innerHTML = `<ueb-blueprint style="--ueb-height: 100%">${codeContent}</ueb-blueprint>`
  container.appendChild(wrapper)
  patchInitialAutoCenter(pendingViewState)

  // 渲染完成后延迟打补丁（等待 Web Component 初始化）
  requestAnimationFrame(() => {
    patchInitialAutoCenter(pendingViewState)
    patchSetFocused()
    patchBlueprint()
    setupMutationObserver()
    void setupCanvasShortcutTrackingSoon(currentRestoreSequence)
    markBlueprintHydratedSoon()
    void restoreViewState(pendingViewState, currentRestoreSequence)
  })
}

// ========== 阻止外部点击导致取消选中 ==========
/**
 * Monkey-patch ueb-blueprint 的 setFocused 方法：
 * 原始实现在 setFocused(false) 时会调用 this.unselectAll()，
 * 导致点击 AI 面板等外部区域时节点被取消选中。
 * 补丁后仅跳过 unselectAll，其他行为（事件分发、focusEventName）不变。
 * 画布内空白区域点击取消选中依然有效（走的是 Select.unclicked() -> unselectAll()）。
 */
function patchSetFocused(): void {
  const ueb = getUebBlueprint() as any
  if (!ueb || ueb.__selectionPatched) return
  ueb.__selectionPatched = true
  ueb.setFocused = function (value = true) {
    if (this.focused === value) return
    const eventName = value ? 'blueprint-focus' : 'blueprint-unfocus'
    this.focused = value
    // 关键：移除原始的 if (!this.focused) this.unselectAll()
    this.dispatchEvent(new CustomEvent(eventName))
  }
}

// ========== Monkey-patch: getFullSerializedText ==========
/**
 * ueblueprint 组件自身只有 getSerializedText（选中节点），
 * 我们需要序列化所有节点，所以在元素上挂载 getFullSerializedText。
 */
function patchBlueprint(): void {
  const ueb = getUebBlueprint() as any
  if (!ueb || ueb.getFullSerializedText) return
  ueb.getFullSerializedText = function (): string {
    const allNodes = this.getNodes?.(false) ?? []
    return allNodes
      .map((n: any) => n.entity?.serialize?.() ?? '')
      .filter(Boolean)
      .join('')
  }
}

// ========== 持久化：监听画布变化 ==========
function getUebBlueprint(): HTMLElement | null {
  return containerRef.value?.querySelector('ueb-blueprint') ?? null
}

let mutationObserver: MutationObserver | null = null

function getSerializedCode(): string | null {
  const ueb = getUebBlueprint() as any
  if (!ueb) return null
  return ueb.getFullSerializedText?.() ?? null
}

function markBlueprintHydratedSoon(): void {
  const ueb = getUebBlueprint() as any
  if (!ueb) return

  Promise.resolve(ueb.updateComplete)
    .catch(() => undefined)
    .finally(() => {
      const nodeCount = ueb.getNodes?.(false)?.length ?? 0
      if (props.code?.trim()) {
        hasHydratedCurrentBlueprint = nodeCount > 0
      } else {
        hasHydratedCurrentBlueprint = true
      }
    })
}

function persistSerializedCode(serialized: string): void {
  hasHydratedCurrentBlueprint = true
  lastStableSerializedCode = serialized
  isSelfUpdate = true
  emit('content-change', serialized)
  if (props.blueprintId && props.elementId && props.elementType) {
    console.debug('[BlueprintRenderer] 保存画布变更，长度:', serialized.length)
    store.updateElementCode(props.blueprintId, props.elementId, props.elementType, serialized)
  }
  nextTick(() => {
    isSelfUpdate = false
  })
}

function getPersistedViewState(): BlueprintRendererViewState | null {
  if (!props.blueprintId || !props.elementId || !props.elementType) {
    return null
  }
  return store.getEditorViewState(props.blueprintId, props.elementId, props.elementType)
}

function getCurrentViewState(): BlueprintRendererViewState | null {
  const ueb = getUebBlueprint() as any
  if (!ueb) return null

  const viewportElement = ueb.template?.viewportElement as HTMLElement | undefined
  const selectedNodeNames = getSelectedNodesInfo()
    .map((node) => node.nodeName)
    .filter((nodeName) => nodeName.length > 0)

  return {
    zoom: typeof ueb.getZoom === 'function' ? ueb.getZoom() : Number(ueb.zoom ?? 0),
    scrollX: Number(ueb.scrollX ?? viewportElement?.scrollLeft ?? 0),
    scrollY: Number(ueb.scrollY ?? viewportElement?.scrollTop ?? 0),
    translateX: typeof ueb.translateX === 'number' ? ueb.translateX : null,
    translateY: typeof ueb.translateY === 'number' ? ueb.translateY : null,
    centerX:
      typeof ueb.template?.gridLeftVisibilityBoundary === 'function' &&
      viewportElement &&
      typeof ueb.scaleCorrect === 'function'
        ? ueb.template.gridLeftVisibilityBoundary() +
          ueb.scaleCorrect(viewportElement.clientWidth / 2)
        : null,
    centerY:
      typeof ueb.template?.gridTopVisibilityBoundary === 'function' &&
      viewportElement &&
      typeof ueb.scaleCorrect === 'function'
        ? ueb.template.gridTopVisibilityBoundary() +
          ueb.scaleCorrect(viewportElement.clientHeight / 2)
        : null,
    selectedNodeNames
  }
}

async function waitForViewportLayout(viewportElement: HTMLElement | undefined): Promise<void> {
  if (!viewportElement) return

  let previousWidth = -1
  let previousHeight = -1

  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const { clientWidth, clientHeight } = viewportElement
    if (clientWidth > 0 && clientHeight > 0) {
      if (clientWidth === previousWidth && clientHeight === previousHeight) {
        return
      }
      previousWidth = clientWidth
      previousHeight = clientHeight
    }
  }
}

function computeScrollFromWorldCenter(
  ueb: any,
  viewportElement: HTMLElement,
  centerX: number,
  centerY: number
): { scrollX: number; scrollY: number } | null {
  if (typeof ueb.getScale !== 'function') {
    return null
  }

  const scale = ueb.getScale()
  const translateX = Number(ueb.translateX ?? 0)
  const translateY = Number(ueb.translateY ?? 0)

  return {
    scrollX: scale * (centerX + translateX) - viewportElement.clientWidth / 2,
    scrollY: scale * (centerY + translateY) - viewportElement.clientHeight / 2
  }
}

function persistViewState(): boolean {
  if (!props.blueprintId || !props.elementId || !props.elementType) {
    return false
  }

  const viewState = getCurrentViewState()
  if (!viewState) {
    return false
  }

  store.saveEditorViewState(props.blueprintId, props.elementId, props.elementType, viewState)
  return true
}

function patchInitialAutoCenter(viewState: BlueprintRendererViewState | null): void {
  if (!viewState) return

  const ueb = getUebBlueprint() as any
  const template = ueb?.template as
    | { centerContentInViewport?: (smooth?: boolean) => void }
    | undefined
  if (!template || typeof template.centerContentInViewport !== 'function') {
    return
  }
  if ((template as { __skipInitialAutoCenterPatched?: boolean }).__skipInitialAutoCenterPatched) {
    return
  }

  const originalCenterContentInViewport = template.centerContentInViewport.bind(template)
  let shouldSkipNextAutoCenter = true

  template.centerContentInViewport = (smooth = true): void => {
    if (shouldSkipNextAutoCenter) {
      shouldSkipNextAutoCenter = false
      return
    }
    originalCenterContentInViewport(smooth)
  }
  ;(template as { __skipInitialAutoCenterPatched?: boolean }).__skipInitialAutoCenterPatched = true
}

async function restoreViewState(
  viewState: BlueprintRendererViewState | null,
  currentSequence: number
): Promise<void> {
  if (!viewState) {
    if (currentSequence === restoreSequence) {
      isRestoringViewState.value = false
    }
    return
  }

  const ueb = getUebBlueprint() as any
  if (!ueb) {
    if (currentSequence === restoreSequence) {
      isRestoringViewState.value = false
    }
    return
  }

  await Promise.resolve(ueb.updateComplete).catch(() => undefined)

  if (currentSequence !== restoreSequence) {
    return
  }

  ueb.zoom = viewState.zoom
  ueb.requestUpdate?.()

  await Promise.resolve(ueb.updateComplete).catch(() => undefined)

  if (currentSequence !== restoreSequence) {
    return
  }

  const viewportElement = ueb.template?.viewportElement as HTMLElement | undefined
  await waitForViewportLayout(viewportElement)

  const hasNativeViewportState =
    typeof viewState.translateX === 'number' &&
    typeof viewState.translateY === 'number' &&
    !!viewportElement

  if (hasNativeViewportState) {
    ueb.translateX = viewState.translateX
    ueb.translateY = viewState.translateY
    ueb.scrollX = viewState.scrollX
    ueb.scrollY = viewState.scrollY
    ueb.requestUpdate?.()
    await Promise.resolve(ueb.updateComplete).catch(() => undefined)
    viewportElement?.scroll?.(viewState.scrollX, viewState.scrollY)
  } else {
    if (
      viewportElement &&
      typeof viewState.centerX === 'number' &&
      typeof viewState.centerY === 'number'
    ) {
      const centerX: number = viewState.centerX
      const centerY: number = viewState.centerY
      const nextScroll = computeScrollFromWorldCenter(ueb, viewportElement, centerX, centerY)
      if (nextScroll) {
        ueb.scrollX = nextScroll.scrollX
        ueb.scrollY = nextScroll.scrollY
        ueb.requestUpdate?.()
        await Promise.resolve(ueb.updateComplete).catch(() => undefined)
        viewportElement.scroll(nextScroll.scrollX, nextScroll.scrollY)
      }
      await Promise.resolve(ueb.updateComplete).catch(() => undefined)
    } else {
      ueb.scrollX = viewState.scrollX
      ueb.scrollY = viewState.scrollY
      ueb.requestUpdate?.()
      await Promise.resolve(ueb.updateComplete).catch(() => undefined)
      viewportElement?.scroll?.(viewState.scrollX, viewState.scrollY)
    }
  }

  restoreSelection(viewState.selectedNodeNames)

  requestAnimationFrame(() => {
    if (currentSequence === restoreSequence) {
      isRestoringViewState.value = false
    }
  })
}

/**
 * 用 MutationObserver 检测画布 DOM 变化（节点增删、连线变化）
 * ueblueprint 不提供 content-changed 事件，只能观测 DOM
 */
function setupMutationObserver(): void {
  cleanupMutationObserver()
  const ueb = getUebBlueprint()
  if (!ueb) return

  mutationObserver = new MutationObserver(() => {
    handleContentChanged()
  })

  // 观测子元素增删（paste/delete）和子树属性变化（连线、引脚编辑等）
  mutationObserver.observe(ueb, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true
  })
}

function cleanupMutationObserver(): void {
  if (mutationObserver) {
    mutationObserver.disconnect()
    mutationObserver = null
  }
}

function handleContentChanged(): void {
  // 防抖 500ms
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    if (!hasHydratedCurrentBlueprint && props.code?.trim()) {
      return
    }
    const serialized = getSerializedCode()
    if (serialized != null) {
      persistSerializedCode(serialized)
    }
  }, 500)
}

function flushSerializedCode(): boolean {
  persistViewState()
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  const serialized = getSerializedCode()
  if (serialized == null) {
    return false
  }
  if (!hasHydratedCurrentBlueprint && props.code?.trim()) {
    return false
  }
  const fallbackSerialized =
    !serialized.trim() && lastStableSerializedCode.trim() ? lastStableSerializedCode : serialized
  persistSerializedCode(fallbackSerialized)
  return true
}

// ========== 生命周期 ==========
onMounted(async () => {
  startCommentShortcutListening()
  try {
    ensureCSS()
    await ensureJS()
    loading.value = false
    await nextTick()
    renderBlueprint()
  } catch (e: unknown) {
    loading.value = false
    error.value = t('blueprintLibraryRenderer.loadError', {
      message: e instanceof Error ? e.message : String(e)
    })
  }
})

/**
 * keep-alive 激活：从缓存恢复时重新渲染蓝图
 * <ueb-blueprint> Web Component 在 DOM 被 keep-alive 取出/放回后
 * 内部状态（SVG 连线、事件绑定等）会丢失，必须重建
 */
onActivated(async () => {
  startCommentShortcutListening()
  if (!jsLoaded) return
  await nextTick()
  renderBlueprint()
})

/**
 * keep-alive 失活：断开 MutationObserver，防止在缓存状态下触发不必要的回调
 */
onDeactivated(() => {
  stopCommentShortcutListening()
  flushSerializedCode()
  cleanupCanvasShortcutTracking()
  cleanupMutationObserver()
  if (debounceTimer) clearTimeout(debounceTimer)
  isRestoringViewState.value = false
})

onBeforeUnmount(() => {
  stopCommentShortcutListening()
  flushSerializedCode()
  cleanupCanvasShortcutTracking()
  // 清理 MutationObserver
  cleanupMutationObserver()
  if (debounceTimer) clearTimeout(debounceTimer)
  isRestoringViewState.value = false
  // 清理 DOM
  const container = containerRef.value
  if (container) {
    const wrapper = container.querySelector('ueb-blueprint')?.parentElement
    if (wrapper && wrapper !== container) wrapper.remove()
  }
})

// ========== 选中节点查询与恢复 ==========
export interface SelectedNodeInfo {
  /** 节点内部名称（唯一标识，如 K2Node_CallFunction_0） */
  nodeName: string
  /** 节点显示名称（如 Set Intensity） */
  displayName: string
  /** 节点序列化文本 */
  serializedText: string
}

export interface InsertVariableNodeOptions {
  variable: ExtractedVariable
  accessType: VariableNodeAccessType
  clientX: number
  clientY: number
}

export interface InsertFunctionNodeOptions {
  fn: {
    name: string
    inputs: FunctionParam[]
    outputs: FunctionParam[]
    isPure: boolean
  }
  clientX: number
  clientY: number
}

type GraphPosition = [number, number]

let canvasShortcutCleanup: (() => void) | null = null
let isPointerInsideCanvas = false
let isEditingCanvasText = false
let lastPointerGraphPosition: GraphPosition | null = null

/** 获取当前选中的节点信息列表 */
function getSelectedNodesInfo(): SelectedNodeInfo[] {
  const ueb = getUebBlueprint() as any
  if (!ueb) return []
  const selectedNodes = ueb.getNodes?.(true) ?? []
  return selectedNodes.map((node: any) => ({
    nodeName: node.getNodeName?.() || '',
    displayName: node.nodeDisplayName || node.getNodeName?.() || 'Unknown',
    serializedText: node.entity?.serialize?.() || ''
  }))
}

/** 根据节点名称列表恢复选中状态 */
function restoreSelection(nodeNames: string[]): void {
  const ueb = getUebBlueprint() as any
  if (!ueb || nodeNames.length === 0) return
  const allNodes = ueb.getNodes?.(false) ?? []
  const nameSet = new Set(nodeNames)
  for (const node of allNodes) {
    const name = node.getNodeName?.() || ''
    if (nameSet.has(name)) {
      node.setSelected?.(true)
    }
  }
}

// ========== 变量节点聚焦（点一下换下一个） ==========
/** 上次聚焦的变量名和索引，用于循环 */
let lastFocusVarName = ''
let lastFocusIndex = -1
let lastFocusNodeMatcherKey = ''
let lastFocusNodeIndex = -1

/**
 * 聚焦到使用指定变量的节点，多次调用会逐个循环
 * @returns 当前第几个 / 共几个匹配，-1 表示无匹配
 */
function focusOnVariableNode(varName: string): { current: number; total: number } | null {
  const ueb = getUebBlueprint() as any
  if (!ueb) return null

  // 找到所有引用该变量的节点（VariableGet / VariableSet）
  const allNodes = ueb.getNodes?.(false) ?? []
  const matchedNodes = allNodes.filter((node: any) => {
    const memberName = node.entity?.VariableReference?.MemberName?.value
    return memberName === varName
  })

  if (matchedNodes.length === 0) return null

  // 循环索引
  if (lastFocusVarName === varName) {
    lastFocusIndex = (lastFocusIndex + 1) % matchedNodes.length
  } else {
    lastFocusVarName = varName
    lastFocusIndex = 0
  }

  const targetNode = matchedNodes[lastFocusIndex]

  // 取消所有选中，选中目标节点
  ueb.unselectAll?.()
  targetNode.setSelected?.(true)

  // 平滑滚动到节点位置
  targetNode.template?.centerInViewport?.()

  return { current: lastFocusIndex + 1, total: matchedNodes.length }
}

function focusOnNodeByMatchers(matchers: string[]): { current: number; total: number } | null {
  const ueb = getUebBlueprint() as any
  if (!ueb) return null

  const normalizedMatchers = matchers.map((matcher) => matcher.trim()).filter(Boolean)
  if (normalizedMatchers.length === 0) return null

  const allNodes = ueb.getNodes?.(false) ?? []
  const matchedNodes = allNodes.filter((node: any) => {
    const serializedText = node.entity?.serialize?.() || ''
    const searchText = [
      node.getNodeName?.() || '',
      node.nodeDisplayName || '',
      serializedText
    ].join('\n')
    return normalizedMatchers.some((matcher) => searchText.includes(matcher))
  })

  if (matchedNodes.length === 0) return null

  const matcherKey = normalizedMatchers.join('\n')
  if (lastFocusNodeMatcherKey === matcherKey) {
    lastFocusNodeIndex = (lastFocusNodeIndex + 1) % matchedNodes.length
  } else {
    lastFocusNodeMatcherKey = matcherKey
    lastFocusNodeIndex = 0
  }

  const targetNode = matchedNodes[lastFocusNodeIndex]
  ueb.unselectAll?.()
  targetNode.setSelected?.(true)
  targetNode.template?.centerInViewport?.()

  return { current: lastFocusNodeIndex + 1, total: matchedNodes.length }
}

function snapGraphPosition(ueb: any, graphX: number, graphY: number): GraphPosition {
  const [snappedX, snappedY] = ueb.snapToGrid?.(graphX, graphY) ?? [graphX, graphY]
  return [Math.round(snappedX), Math.round(snappedY)]
}

function getGraphPositionFromViewportPoint(
  relativeX: number,
  relativeY: number
): GraphPosition | null {
  const ueb = getUebBlueprint() as any
  const viewport = ueb?.template?.viewportElement as HTMLElement | undefined
  if (!ueb || !viewport) return null

  if (typeof ueb.scaleCorrect !== 'function') {
    return null
  }

  const leftBoundary = ueb.template?.gridLeftVisibilityBoundary?.() ?? 0
  const topBoundary = ueb.template?.gridTopVisibilityBoundary?.() ?? 0
  const graphX = leftBoundary + ueb.scaleCorrect(relativeX)
  const graphY = topBoundary + ueb.scaleCorrect(relativeY)
  return snapGraphPosition(ueb, graphX, graphY)
}

function getGraphPositionFromClientPoint(clientX: number, clientY: number): GraphPosition | null {
  const ueb = getUebBlueprint() as any
  const viewport = ueb?.template?.viewportElement as HTMLElement | undefined
  if (!ueb || !viewport) return null

  const rect = viewport.getBoundingClientRect()
  const relativeX = clientX - rect.left
  const relativeY = clientY - rect.top
  if (relativeX < 0 || relativeY < 0 || relativeX > rect.width || relativeY > rect.height) {
    return null
  }

  return getGraphPositionFromViewportPoint(relativeX, relativeY)
}

function setMousePosition(position: GraphPosition): boolean {
  const ueb = getUebBlueprint() as any
  if (!ueb) return false
  ueb.mousePosition = position
  return true
}

function setMousePositionFromClientPoint(clientX: number, clientY: number): boolean {
  const graphPosition = getGraphPositionFromClientPoint(clientX, clientY)
  if (!graphPosition) return false
  return setMousePosition(graphPosition)
}

function persistInsertedNodeCode(ueb: any): void {
  const serialized: string | undefined = ueb.getFullSerializedText?.()
  if (serialized != null) {
    if (debounceTimer) clearTimeout(debounceTimer)
    persistSerializedCode(serialized)
  }
}

function cleanupCanvasShortcutTracking(): void {
  canvasShortcutCleanup?.()
  canvasShortcutCleanup = null
  isPointerInsideCanvas = false
  isEditingCanvasText = false
  lastPointerGraphPosition = null
}

async function setupCanvasShortcutTrackingSoon(currentSequence: number): Promise<void> {
  const ueb = getUebBlueprint() as any
  if (!ueb) return

  await Promise.resolve(ueb.updateComplete).catch(() => undefined)
  if (currentSequence !== restoreSequence) return
  cleanupCanvasShortcutTracking()

  const viewport = ueb.template?.viewportElement as HTMLElement | undefined
  if (!viewport) return

  const rememberPointerPosition = (event: PointerEvent): void => {
    const graphPosition = getGraphPositionFromClientPoint(event.clientX, event.clientY)
    if (!graphPosition) return
    isPointerInsideCanvas = true
    lastPointerGraphPosition = graphPosition
    ueb.mousePosition = graphPosition
  }
  const handlePointerLeave = (): void => {
    isPointerInsideCanvas = false
  }
  const handleEditBegin = (): void => {
    isEditingCanvasText = true
  }
  const handleEditEnd = (): void => {
    isEditingCanvasText = false
  }

  viewport.addEventListener('pointerenter', rememberPointerPosition)
  viewport.addEventListener('pointermove', rememberPointerPosition)
  viewport.addEventListener('pointerdown', rememberPointerPosition)
  viewport.addEventListener('pointerleave', handlePointerLeave)
  ueb.addEventListener('ueb-edit-text-begin', handleEditBegin)
  ueb.addEventListener('ueb-edit-text-end', handleEditEnd)

  canvasShortcutCleanup = () => {
    viewport.removeEventListener('pointerenter', rememberPointerPosition)
    viewport.removeEventListener('pointermove', rememberPointerPosition)
    viewport.removeEventListener('pointerdown', rememberPointerPosition)
    viewport.removeEventListener('pointerleave', handlePointerLeave)
    ueb.removeEventListener('ueb-edit-text-begin', handleEditBegin)
    ueb.removeEventListener('ueb-edit-text-end', handleEditEnd)
  }
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function insertCommentNode(): boolean {
  const ueb = getUebBlueprint() as any
  const pasteInput = ueb?.template?.getPasteInputObject?.()
  if (!ueb || !pasteInput) return false

  if (!lastPointerGraphPosition || !setMousePosition(lastPointerGraphPosition)) {
    return false
  }

  const serializedText = createCommentNodeClipboardText({
    nodePosX: lastPointerGraphPosition[0],
    nodePosY: lastPointerGraphPosition[1]
  })
  const insertedNodes = pasteInput.pasted(serializedText)
  if (!Array.isArray(insertedNodes) || insertedNodes.length === 0) {
    return false
  }

  persistInsertedNodeCode(ueb)
  return true
}

function handleCommentShortcutKeydown(event: KeyboardEvent): void {
  if (event.key.toLowerCase() !== 'c') return
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return
  if (isEditableShortcutTarget(event.target)) return

  const ueb = getUebBlueprint() as any
  const rect = containerRef.value?.getBoundingClientRect()
  if (
    !ueb ||
    !rect ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    loading.value ||
    error.value ||
    isRestoringViewState.value ||
    isEditingCanvasText ||
    !isPointerInsideCanvas ||
    !lastPointerGraphPosition
  ) {
    return
  }

  event.preventDefault()
  insertCommentNode()
}

let isCommentShortcutListening = false

function startCommentShortcutListening(): void {
  if (isCommentShortcutListening) return
  document.addEventListener('keydown', handleCommentShortcutKeydown)
  isCommentShortcutListening = true
}

function stopCommentShortcutListening(): void {
  if (!isCommentShortcutListening) return
  document.removeEventListener('keydown', handleCommentShortcutKeydown)
  isCommentShortcutListening = false
}

function insertVariableNode(options: InsertVariableNodeOptions): boolean {
  const ueb = getUebBlueprint() as any
  const pasteInput = ueb?.template?.getPasteInputObject?.()
  if (!ueb || !pasteInput) return false
  if (!setMousePositionFromClientPoint(options.clientX, options.clientY)) {
    return false
  }

  const serializedText = createVariableNodeClipboardText(options.variable, options.accessType)
  const insertedNodes = pasteInput.pasted(serializedText)
  if (!Array.isArray(insertedNodes) || insertedNodes.length === 0) {
    return false
  }

  persistInsertedNodeCode(ueb)
  return true
}

function insertFunctionNode(options: InsertFunctionNodeOptions): boolean {
  const ueb = getUebBlueprint() as any
  const pasteInput = ueb?.template?.getPasteInputObject?.()
  if (!ueb || !pasteInput) return false
  if (!setMousePositionFromClientPoint(options.clientX, options.clientY)) {
    return false
  }

  const serializedText = createFunctionNodeClipboardText(options.fn)
  const insertedNodes = pasteInput.pasted(serializedText)
  if (!Array.isArray(insertedNodes) || insertedNodes.length === 0) {
    return false
  }

  persistInsertedNodeCode(ueb)
  return true
}

defineExpose({
  getSelectedNodesInfo,
  restoreSelection,
  focusOnVariableNode,
  focusOnNodeByMatchers,
  insertVariableNode,
  insertFunctionNode,
  insertCommentNode,
  flushSerializedCode,
  persistViewState
})

// Rebuild the canvas when the active logic target changes, even if serialized code is identical.
watch(
  () => [props.code, props.elementId, props.elementType, props.name],
  async (nextValues, previousValues) => {
    if (!jsLoaded) return
    const [, nextElementId, nextElementType, nextName] = nextValues
    const [, previousElementId, previousElementType, previousName] = previousValues
    const isOnlySerializedCodeEcho =
      nextElementId === previousElementId &&
      nextElementType === previousElementType &&
      nextName === previousName
    if (isSelfUpdate && isOnlySerializedCodeEcho) return
    await nextTick()
    renderBlueprint()
  }
)
</script>

<style scoped>
.blueprint-renderer {
  width: 100%;
  height: 100%;
  --ueb-height: 100vh;
  position: relative;
  overflow: hidden;
  background: var(--color-bg-surface);
  border-radius: 6px;
}

.blueprint-renderer.is-restoring {
  opacity: 0;
  pointer-events: none;
}

.blueprint-renderer :deep(ueb-blueprint) {
  display: block;
  width: 100%;
  height: 100%;
}

.blueprint-renderer :deep(ueb-viewport-about) {
  display: none !important;
}

/* ueblueprint 自带的缩放读数是 20px 粗体、写死的深灰，深底上像水印；收成右下角一枚小胶囊 */
.blueprint-renderer :deep(.ueb-viewport-zoom) {
  position: absolute;
  right: 10px;
  bottom: 10px;
  margin: 0;
  padding: 2px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: var(--font-weight-medium);
  letter-spacing: 0;
}

.renderer-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: var(--color-text-secondary);
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--color-border-subtle);
  border-top-color: var(--color-accent-border);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.loading-text {
  font-size: 13px;
}

.renderer-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: var(--color-danger-text);
}

.error-icon {
  font-size: 28px;
}

.error-text {
  font-size: 13px;
  max-width: 300px;
  text-align: center;
  line-height: 1.5;
}
</style>
