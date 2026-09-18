import { nextTick, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useRoute } from 'vue-router'
import { useTabsStore } from '@renderer/store/modules/tabs'
import type { AIPanelMode } from '../types'

/**
 * 库类编辑器壳（BlueprintEditor / MaterialEditor 的同构交互层）。
 *
 * 覆盖：AI 面板形态（docked/collapsed/overlay）+ localStorage 持久化、
 * focus mode 进入/退出/切换、F/Tab/Ctrl+/ 全局快捷键、左侧栏显示与拖宽。
 *
 * 领域差异通过配置注入：
 * - 存储键（两库互不干扰）
 * - 默认侧栏宽度
 * - onEnterFocusMode：进入 focus mode 时的额外联动（蓝图库用来折叠全局侧栏菜单）
 *
 * 不覆盖（由组件自持）：
 * - 生命周期绑定（组件在 onMounted/onActivated/onDeactivated/onBeforeUnmount 中
 *   调用 startKeyboardListening/stopListening，保持 keep-alive 语义）
 * - 蓝图库重激活时"若仍在 focus mode 则再次请求折叠全局侧栏菜单"的联动
 *   （ensureSideMenuCollapsedForFocusMode，蓝图独有）
 * - isEditorActive 等领域编辑器自身的激活标记
 */
export interface LibraryEditorShell {
  aiPanelMode: Ref<AIPanelMode>
  savedAiPanelMode: Ref<AIPanelMode>
  isFocusMode: Ref<boolean>
  isLeftSidebarVisible: Ref<boolean>
  sidebarWidth: Ref<number>
  enterFocusMode: () => void
  exitFocusMode: () => void
  toggleFocusMode: () => void
  toggleAiPanel: () => void
  restoreAiPanel: () => void
  handleAiPanelModeUpdate: (mode: AIPanelMode) => void
  onSidebarResizeStart: (e: MouseEvent) => void
  startKeyboardListening: () => void
  stopKeyboardListening: () => void
}

export function useLibraryEditorShell(options: {
  panelModeStorageKey: string
  sidebarVisibleStorageKey: string
  defaultSidebarWidth: number
  sidebarMinWidth?: number
  sidebarMaxWidth?: number
  onEnterFocusMode?: () => void
}): LibraryEditorShell {
  const {
    panelModeStorageKey,
    sidebarVisibleStorageKey,
    defaultSidebarWidth,
    sidebarMinWidth = 180,
    sidebarMaxWidth = 500,
    onEnterFocusMode
  } = options

  const aiPanelMode = ref<AIPanelMode>(
    (localStorage.getItem(panelModeStorageKey) as AIPanelMode) || 'docked'
  )
  watch(aiPanelMode, (newVal) => localStorage.setItem(panelModeStorageKey, newVal))

  const savedAiPanelMode = ref<AIPanelMode>('docked')
  const isFocusMode = ref(false)
  const isLeftSidebarVisible = ref(localStorage.getItem(sidebarVisibleStorageKey) !== 'false')
  watch(isLeftSidebarVisible, (newVal) =>
    localStorage.setItem(sidebarVisibleStorageKey, String(newVal))
  )

  function enterFocusMode(): void {
    if (isFocusMode.value) return
    isFocusMode.value = true
    isLeftSidebarVisible.value = false
    savedAiPanelMode.value = aiPanelMode.value
    aiPanelMode.value = 'collapsed'
    onEnterFocusMode?.()
  }

  function exitFocusMode(): void {
    if (!isFocusMode.value) return
    isFocusMode.value = false
    isLeftSidebarVisible.value = true
    aiPanelMode.value = 'docked'
  }

  function toggleFocusMode(): void {
    if (isFocusMode.value) {
      exitFocusMode()
    } else {
      enterFocusMode()
    }
  }

  function restoreAiPanel(): void {
    aiPanelMode.value = savedAiPanelMode.value === 'collapsed' ? 'docked' : savedAiPanelMode.value
  }

  function handleAiPanelModeUpdate(mode: AIPanelMode): void {
    if (mode === 'collapsed') {
      if (aiPanelMode.value !== 'collapsed') {
        savedAiPanelMode.value = aiPanelMode.value
      }
      aiPanelMode.value = 'collapsed'
      return
    }
    aiPanelMode.value = mode
    savedAiPanelMode.value = mode
  }

  function toggleAiPanel(): void {
    if (aiPanelMode.value === 'collapsed') {
      restoreAiPanel()
    } else {
      savedAiPanelMode.value = aiPanelMode.value
      aiPanelMode.value = 'collapsed'
    }
  }

  /** 左侧栏拖宽（鼠标按下后向右拖 = 增宽） */
  const sidebarWidth = ref(defaultSidebarWidth)

  function onSidebarResizeStart(e: MouseEvent): void {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth.value

    const onMove = (ev: MouseEvent): void => {
      const delta = ev.clientX - startX
      sidebarWidth.value = Math.min(sidebarMaxWidth, Math.max(sidebarMinWidth, startW + delta))
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  /** 全局快捷键：F 切换 focus mode，Tab 切换左侧栏，Ctrl/Cmd+/ 切换 AI 面板 */
  function handleGlobalKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement
    if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return

    if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      toggleFocusMode()
    } else if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      if (isFocusMode.value) {
        exitFocusMode()
      } else {
        isLeftSidebarVisible.value = !isLeftSidebarVisible.value
      }
    } else if (e.key === '/' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      toggleAiPanel()
    }
  }

  let isListening = false
  function startKeyboardListening(): void {
    if (isListening) return
    document.addEventListener('keydown', handleGlobalKeydown)
    isListening = true
  }
  function stopKeyboardListening(): void {
    if (!isListening) return
    document.removeEventListener('keydown', handleGlobalKeydown)
    isListening = false
  }

  return {
    aiPanelMode,
    savedAiPanelMode,
    isFocusMode,
    isLeftSidebarVisible,
    sidebarWidth,
    enterFocusMode,
    exitFocusMode,
    toggleFocusMode,
    toggleAiPanel,
    restoreAiPanel,
    handleAiPanelModeUpdate,
    onSidebarResizeStart,
    startKeyboardListening,
    stopKeyboardListening
  }
}

/**
 * 编辑器"专用 tab"标题同步（`_tab_id` 存在时把 tab 标题改成条目名）。
 *
 * 两库逐行同构：updateTabTitleByPath 立即尝试一次，失败（tab 尚未创建）则
 * nextTick 后重试一次。getTitle 由领域侧提供（蓝图取 blueprint.name，材质取 entry.name）。
 */
export interface LibraryTabTitleSync {
  hasDedicatedTab: () => boolean
  getCurrentTabKey: () => string | null
  syncTabTitle: () => void
}

export function useLibraryTabTitleSync(getTitle: () => string | undefined): LibraryTabTitleSync {
  const route = useRoute()
  const tabsStore = useTabsStore()

  function hasDedicatedTab(): boolean {
    const tabId = route.query._tab_id
    return typeof tabId === 'string' && tabId.trim().length > 0
  }

  function getCurrentTabKey(): string | null {
    if (!hasDedicatedTab()) return null
    return route.fullPath
  }

  function syncTabTitle(): void {
    const title = getTitle()?.trim()
    if (!title) return
    const currentTabKey = getCurrentTabKey()
    if (!currentTabKey) return

    const updated = tabsStore.updateTabTitleByPath(currentTabKey, title)
    if (updated) return

    void nextTick(() => {
      tabsStore.updateTabTitleByPath(currentTabKey, title)
    })
  }

  return { hasDedicatedTab, getCurrentTabKey, syncTabTitle }
}
