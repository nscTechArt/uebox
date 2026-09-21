<script setup lang="ts">
import AppTooltip from '@renderer/components/AppTooltip.vue'
import {
  PhArrowClockwise,
  PhBooks,
  PhChatCircle,
  PhCubeTransparent,
  PhDownloadSimple,
  PhGear,
  PhCube,
  PhHardDrives,
  PhSphere,
  PhHouse,
  PhFolders,
  PhPlus,
  PhPushPin,
  PhSparkle,
  PhStorefront,
  PhGraph,
  PhUser,
  PhX
} from '@phosphor-icons/vue'
import type { Component } from 'vue'
import { computed, watch, ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useTabsStore, DEFAULT_TAB_KEY } from '@renderer/store/modules/tabs'
import { formatUpdateVersion, useUpdateStore } from '@renderer/store/modules/updateStore'
import { useUpdateInstall } from '@renderer/composables/useUpdateInstall'
import { message } from '@renderer/utils/messageManager'
import { useI18n } from '@renderer/hooks/useI18n'
import ContextMenu from '@renderer/components/ContextMenu/ContextMenu.vue'
import type { MenuItem } from '@renderer/components/ContextMenu/types'
import collapseIcon from '@renderer/assets/icon/ic_collapse.png'

const isMac = window.api?.platform === 'darwin'
const router = useRouter()
const route = useRoute()
const tabsStore = useTabsStore()
const { t } = useI18n()

interface Props {
  collapsed?: boolean
  /** 没有侧边栏的页面（如全屏编辑器）不需要这个开关 */
  showSidebarToggle?: boolean
}

interface Emits {
  (e: 'active-tab-change', key: string): void
  (e: 'toggle-collapsed'): void
  /** 悬停这枚按钮就把收起的侧边栏浮出来，移开再收回去 */
  (e: 'peek-enter'): void
  (e: 'peek-leave'): void
}

defineProps<Props>()
const emit = defineEmits<Emits>()

// 拖拽相关状态
const draggedTab = ref<string | null>(null)
const dragOverTab = ref<string | null>(null)

// Tabs滚动容器与渐隐显示状态
const tabsScrollRef = ref<HTMLElement | null>(null)
const showLeftFade = ref(false)
const showRightFade = ref(false)

// 标题截断检测
const truncatedMap = ref<Record<string, boolean>>({})
const titleElMap = new Map<string, HTMLElement>()

/**
 * 记录标题元素引用
 */
const registerTitleEl = (el: HTMLElement | null, key: string) => {
  if (el) {
    titleElMap.set(key, el)
  } else {
    titleElMap.delete(key)
  }
}

/**
 * 检测某个标签标题是否发生截断
 */
const checkTruncation = (key: string) => {
  const el = titleElMap.get(key)
  truncatedMap.value[key] = !!el && el.scrollWidth > el.clientWidth
}

// 计算属性：使用store中的排序标签页
const sortedTabs = computed(() => {
  return tabsStore.sortedTabs
})

/**
 * 根据标签页路径获取对应的图标组件
 * 与左侧菜单栏保持一致
 * @param path 标签页路径
 * @returns 对应的图标组件
 */
const getTabIcon = (path: string): Component => {
  // 项目库
  if (path === '' || path === '/' || path.startsWith('/home')) {
    return PhFolders
  }
  // 共创市场
  if (path.includes('co-create-market')) {
    return PhStorefront
  }
  // 资产库 (与 routeUtils.ts 保持一致)
  if (path.includes('asset-management')) {
    return PhCube
  }
  // 蓝图库
  if (path.includes('blueprint-library')) {
    return PhGraph
  }
  // 材质库 (与 routeUtils.ts 保持一致)
  if (path.includes('material-library')) {
    return PhSphere
  }
  // 3D工作室
  if (path.includes('model-3d-studio')) {
    return PhCubeTransparent
  }
  // 知识库 (与 routeUtils.ts 保持一致)
  if (path.includes('notebooks')) {
    return PhBooks
  }
  // AI 创作 (AIGC Studio) (与 routeUtils.ts 保持一致)
  if (path.includes('aigc-studio')) {
    return PhSparkle
  }
  // AI 助手
  if (path.includes('dev-assistant') || path.includes('assistant')) {
    return PhChatCircle
  }
  // 个人中心
  if (path.includes('profile') || path.includes('user')) {
    return PhUser
  }
  // 设置/偏好
  if (path.includes('setting') || path.includes('preferences')) {
    return PhGear
  }
  // 服务器管理
  if (path.includes('server-management')) {
    return PhHardDrives
  }
  // 默认图标
  return PhHouse
}

// 设置当前激活的tab
/**
 * 设置激活标签并通知父组件
 */
const setActiveTab = (key: string) => {
  tabsStore.setActiveTab(key)
  emit('active-tab-change', key)
}

const handleTabClick = (key: string) => {
  const hasDedicatedTabInstance = (tabKey: string) => tabKey.includes('_tab_id=')

  // 实时检测并修正被污染的嵌套路由 tab key
  // Notebooks 的详情页 isShowInTab=false，tab key 应该只是基础路径
  let sanitizedKey = key
  const nestedRoutePatterns = [{ base: '/notebooks', pattern: /^\/notebooks\/[^/?]+/ }]

  for (const { base, pattern } of nestedRoutePatterns) {
    if (pattern.test(key) && key !== base && !hasDedicatedTabInstance(key)) {
      console.log(`[TabsHeader] 检测到污染的 tab key: ${key}，修正为: ${base}`)
      sanitizedKey = base

      // 同时更新 tabs store 中的 key
      const tab = tabsStore.historyTabs.find((t) => t.key === key)
      if (tab) {
        tab.key = base
        tab.path = base
      }
      break
    }
  }

  // 立即更新UI状态，不等待路由完成
  setActiveTab(sanitizedKey)
  // 使用nextTick确保UI更新在路由跳转之前完成
  nextTick(() => {
    router.push(sanitizedKey).catch(() => {
      // 忽略路由错误（如重复导航）
    })
  })
}

const handleTabRemove = (targetKey: string, event: Event) => {
  event.stopPropagation()

  const newActiveTabKey = tabsStore.removeTab(targetKey)

  // 如果需要切换到新的激活标签页
  if (newActiveTabKey) {
    setActiveTab(newActiveTabKey)
    router.push(newActiveTabKey)
  } else if (tabsStore.historyTabs.length === 0) {
    // 关掉了最后一个标签页。项目库现在也能关，所以这里会真的空掉 ——
    // 不接管的话标签栏空了、内容区还留着上一页，落回项目库
    router.push(DEFAULT_TAB_KEY)
  }
  triggerWidthFreeze()
}

/**
 * 鼠标中键点击关闭标签页（类似 Chrome）
 */
const handleMiddleClick = (event: MouseEvent, tabKey: string) => {
  // button === 1 代表鼠标中键
  if (event.button !== 1) return
  event.preventDefault()
  event.stopPropagation()

  // 检查标签页是否可关闭
  const tab = tabsStore.historyTabs.find((t) => t.key === tabKey)
  if (!tab || tab.isCanDelete === false || tab.fixed) return

  handleTabRemove(tabKey, event)
}

// 拖拽事件处理
/**
 * 开始拖拽标签
 */
const handleDragStart = (event: DragEvent, tabKey: string) => {
  const tab = tabsStore.historyTabs.find((t) => t.key === tabKey)

  // 固定标签页不允许拖拽
  if (tab?.fixed) {
    event.preventDefault()
    return
  }

  draggedTab.value = tabKey
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', tabKey)
  }
}

const handleDragOver = (event: DragEvent, tabKey: string) => {
  event.preventDefault()
  const tab = tabsStore.historyTabs.find((t) => t.key === tabKey)
  // 固定标签页不允许作为拖拽目标
  if (tab?.fixed) {
    return
  }

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  dragOverTab.value = tabKey
}

const handleDragLeave = () => {
  dragOverTab.value = null
}

const handleDrop = (event: DragEvent, targetTabKey: string) => {
  event.preventDefault()

  const sourceTabKey = draggedTab.value
  if (!sourceTabKey || sourceTabKey === targetTabKey) {
    resetDragState()
    return
  }

  // 使用store的重排序方法
  tabsStore.reorderTabs(sourceTabKey, targetTabKey)
  resetDragState()
}

const handleDragEnd = () => {
  resetDragState()
}

const resetDragState = () => {
  draggedTab.value = null
  dragOverTab.value = null
}

/**
 * 更新渐隐显示状态（使用防抖优化性能）
 */
let fadeUpdateTimer: number | null = null
const updateFade = () => {
  if (fadeUpdateTimer) {
    cancelAnimationFrame(fadeUpdateTimer)
  }
  fadeUpdateTimer = requestAnimationFrame(() => {
    const el = tabsScrollRef.value
    if (!el) return
    const scrollLeft = el.scrollLeft
    const maxScroll = el.scrollWidth - el.clientWidth
    showLeftFade.value = scrollLeft > 0
    showRightFade.value = scrollLeft < maxScroll
    fadeUpdateTimer = null
  })
}

/**
 * 处理Tabs滚动事件（使用节流优化性能）
 */
let scrollTimer: number | null = null
const onTabsScroll = () => {
  if (scrollTimer) {
    cancelAnimationFrame(scrollTimer)
  }
  scrollTimer = requestAnimationFrame(() => {
    updateFade()
    scrollTimer = null
  })
}

/**
 * 选择“更多标签”中的某一项
 */
const handleSelectMoreTab = (key: string) => {
  setActiveTab(key)
  router.push(key)
}

// 监听路由变化，自动添加和激活tab
watch(
  () => route.fullPath,
  () => {
    const tabKey = tabsStore.addTab(route)
    if (tabKey) {
      tabsStore.setActiveTab(tabKey)
      emit('active-tab-change', tabKey)
    }
    // 使用requestAnimationFrame优化DOM更新
    requestAnimationFrame(() => {
      updateFade()
    })
  },
  { immediate: true }
)

// 初始化渐隐显示
/**
 * 初始化滚动渐隐状态
 */
watch(
  () => tabsStore.historyTabs,
  () => {
    // 使用requestAnimationFrame优化DOM更新
    requestAnimationFrame(() => {
      updateFade()
    })
  },
  { deep: true }
)

// 右键菜单相关
const contextMenuRef = ref<InstanceType<typeof ContextMenu> | null>(null)
const contextMenuTabKey = ref<string>('')

// 右键菜单项配置
const getContextMenuItems = (tabKey: string): MenuItem[] => {
  const tab = tabsStore.historyTabs.find((t) => t.key === tabKey)
  if (!tab) return []

  const sortedTabsList = [...tabsStore.sortedTabs]
  const currentIndex = sortedTabsList.findIndex((t) => t.key === tabKey)
  const hasRightTabs = currentIndex < sortedTabsList.length - 1
  const hasOtherTabs = tabsStore.historyTabs.length > 1

  // 被路由钉死的标签页：固定且不可删除，固定状态也不许取消
  const isLockedTab = tab.fixed && !tab.isCanDelete

  return [
    {
      key: 'close',
      label: t('tabs.close'),
      icon: PhX,
      disabled: !tab.isCanDelete || tab.fixed
    },
    {
      key: 'close-other',
      label: t('tabs.closeOther'),
      icon: PhX,
      disabled: !hasOtherTabs
    },
    {
      key: 'close-right',
      label: t('tabs.closeRight'),
      icon: PhX,
      disabled: !hasRightTabs
    },
    {
      type: 'divider'
    },
    // TODO: 暂时隐藏复制选项
    // {
    //   key: 'copy',
    //   label: t('tabs.copy'),
    //   icon: CopyOutlined,
    //   disabled: isLockedTab // 钉死的标签页不允许复制
    // },
    {
      key: 'pin',
      label: tab.fixed ? t('tabs.unpin') : t('tabs.pin'),
      icon: PhPushPin,
      disabled: isLockedTab
    }
  ]
}

// 处理右键点击
const handleContextMenu = (event: MouseEvent, tabKey: string) => {
  event.preventDefault()
  event.stopPropagation()
  contextMenuTabKey.value = tabKey
  contextMenuRef.value?.show(event.clientX, event.clientY)
}

// 处理菜单项点击
const handleMenuClick = (key: string) => {
  const tabKey = contextMenuTabKey.value
  if (!tabKey) return

  switch (key) {
    case 'close':
      handleTabRemove(tabKey, new Event('click'))
      break
    case 'close-other': {
      const newActiveTabKey = tabsStore.closeOtherTabs(tabKey)
      if (newActiveTabKey) {
        setActiveTab(newActiveTabKey)
        router.push(newActiveTabKey)
      }
      triggerWidthFreeze()
      break
    }
    case 'close-right': {
      const newActiveTabKey = tabsStore.closeRightTabs(tabKey)
      if (newActiveTabKey) {
        setActiveTab(newActiveTabKey)
        router.push(newActiveTabKey)
      }
      triggerWidthFreeze()
      break
    }
    case 'copy': {
      // 复制标签页：创建新的标签页实例并切换到新标签页
      const tab = tabsStore.historyTabs.find((t) => t.key === tabKey)
      if (tab) {
        // 从被复制的标签页的key中提取tabId
        let sourceTabId = 'default'
        try {
          const url = new URL(tabKey, 'http://dummy')
          const tabIdParam = url.searchParams.get('_tab_id')
          if (tabIdParam) {
            sourceTabId = tabIdParam
          }
        } catch {
          // 如果解析失败，尝试手动解析
          const match = tabKey.match(/[?&]_tab_id=([^&]+)/)
          if (match && match[1]) {
            sourceTabId = match[1]
          }
        }

        // 在复制前，先保存被复制标签页的所有状态
        // 这样可以确保状态被正确复制
        Promise.all([
          import('@renderer/store/modules/assetViewStore')
            .then(({ useAssetViewStore }) => {
              const assetViewStore = useAssetViewStore()
              // 切换到被复制的标签页状态，确保状态已保存
              assetViewStore.setTabId(sourceTabId)
              // 触发状态保存
              assetViewStore.setMode(assetViewStore.mode)
            })
            .catch(() => {}),

          import('@renderer/store/modules/assetNavigationStore')
            .then(({ useAssetNavigationStore }) => {
              const navStore = useAssetNavigationStore()
              // 切换到被复制的标签页状态，确保状态已保存
              navStore.setTabId(sourceTabId)
              // 触发状态保存（通过 push 当前路径）
              if (navStore.current) {
                navStore.push(navStore.current)
              }
            })
            .catch(() => {}),

          import('@renderer/store/modules/assetSelectionStore')
            .then(({ useAssetSelectionStore }) => {
              const selectionStore = useAssetSelectionStore()
              // 切换到被复制的标签页状态，确保状态已保存
              selectionStore.setTabId(sourceTabId)
              // 触发状态保存
              if (selectionStore.selectedShortcut) {
                selectionStore.setShortcut(selectionStore.selectedShortcut)
              } else if (selectionStore.selectedTreeKey) {
                selectionStore.setTreeKey(selectionStore.selectedTreeKey)
              }
            })
            .catch(() => {}),

          // 保存树状态（如果被复制的标签页当前是激活的）
          import('@renderer/views/AssetManagement/utils/tabStateManager')
            .then(() => {
              // 注意：这里无法直接访问组件状态，状态会在组件内部自动保存
              // 但我们可以确保在复制时，如果被复制的标签页是激活的，状态会被保存
            })
            .catch(() => {})
        ])
          .then(() => {
            // 状态保存完成后，创建新的标签页
            const newTabKey = tabsStore.duplicateTab(tabKey)
            if (newTabKey) {
              // 切换到新创建的标签页
              setActiveTab(newTabKey)
              router.push(newTabKey).then(() => {
                // 导航完成后，确保激活新创建的标签页
                setActiveTab(newTabKey)
                emit('active-tab-change', newTabKey)
              })
              triggerWidthFreeze()
            }
          })
          .catch(() => {
            // 即使保存失败，也继续复制标签页
            const newTabKey = tabsStore.duplicateTab(tabKey)
            if (newTabKey) {
              setActiveTab(newTabKey)
              router.push(newTabKey).then(() => {
                setActiveTab(newTabKey)
                emit('active-tab-change', newTabKey)
              })
              triggerWidthFreeze()
            }
          })
      }
      break
    }
    case 'pin':
      tabsStore.toggleTabFixed(tabKey)
      break
  }
}

/**
 * 生成唯一的会话ID
 */
function generateSessionId(): string {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return `${t}${r}`
}

/**
 * 创建新的对话会话
 */
const createNewChat = (): void => {
  const sid = generateSessionId()
  router.push({ name: 'AssistantWelcome', query: { sid } })
}

// 暴露方法给父组件
defineExpose({
  setActiveTab: (key: string) => {
    tabsStore.setActiveTab(key)
    emit('active-tab-change', key)
  },
  getActiveTab: () => tabsStore.activeTab,
  getHistoryTabs: () => tabsStore.historyTabs
})

/**
 * 最小化窗口
 */
const minimizeWindow = () => {
  window.api.window.minimize()
}

/**
 * 最大化或还原窗口
 */
const maximizeWindow = () => {
  window.api.window.maximize()
}

/**
 * 关闭窗口（隐藏到托盘）
 */
const closeWindow = () => {
  window.api.window.close()
}

// 统一的标签宽度与延迟重排逻辑
const tabWidth = ref<number>(180)
const widthFreeze = ref<boolean>(false)
const freezeTimer = ref<number | null>(null)

/**
 * 计算并设置统一的标签宽度
 */
const recalcTabWidth = () => {
  if (widthFreeze.value) return
  const container = tabsScrollRef.value
  const count = sortedTabs.value.length
  if (!container || count === 0) return
  // 预留 + 号按钮的宽度 (36px + margin)
  const available = container.clientWidth - 40
  const min = 60
  const max = 180
  const target = Math.max(min, Math.min(max, Math.floor(available / count)))
  tabWidth.value = target
}

/**
 * 触发宽度冻结，并在2秒无进一步关闭后统一重排
 */
const triggerWidthFreeze = () => {
  widthFreeze.value = true
  if (freezeTimer.value) {
    clearTimeout(freezeTimer.value)
  }
  freezeTimer.value = window.setTimeout(() => {
    widthFreeze.value = false
    recalcTabWidth()
    updateFade()
    freezeTimer.value = null
  }, 2000)
}

/**
 * 窗口尺寸变化时，非冻结状态下重算宽度
 */
const handleResize = () => {
  if (!widthFreeze.value) {
    recalcTabWidth()
    updateFade()
  }
}

/**
 * 监听标签数量变化：新增时立即重算，关闭时由冻结逻辑处理
 */
watch(
  () => sortedTabs.value.length,
  (newLen, oldLen) => {
    if (newLen > oldLen && !widthFreeze.value) {
      recalcTabWidth()
      updateFade()
    }
  }
)

/**
 * 更新角标。
 *
 * 状态本身在全局 Store 里（store/modules/updateStore.ts），这里只负责画和点。
 * 以前这块是自己挂三个监听、只认「已下载」一种状态 —— 而下载只能从
 * 「设置 → 关于」手动发起，于是这个按钮在真实使用中几乎永远不出现。
 */
const updateStore = useUpdateStore()
const { confirmInstall } = useUpdateInstall()
const {
  phase: updatePhase,
  latestVersion: updateVersion,
  downloadPercent
} = storeToRefs(updateStore)

const showUpdateButton = computed(() => updateStore.hasUpdateNews)

const updateVersionLabel = computed(() => formatUpdateVersion(updateVersion.value))

const updateButtonText = computed(() => {
  if (updatePhase.value === 'downloading') {
    return t('update.downloadingPercent', { percent: downloadPercent.value })
  }
  if (updatePhase.value === 'downloaded') return t('update.restartToUpdate')
  return updateVersionLabel.value
    ? t('update.updateTo', { version: updateVersionLabel.value })
    : t('update.newVersionAvailable')
})

const updateButtonTooltip = computed(() => {
  if (updatePhase.value === 'downloading') {
    return t('update.downloadingHint', { version: updateVersionLabel.value })
  }
  if (updatePhase.value === 'downloaded') return t('update.readyToInstall')
  return t('update.downloadHint', { version: updateVersionLabel.value })
})

const updateButtonIcon = computed(() => {
  if (updatePhase.value === 'downloaded') return PhArrowClockwise
  return PhDownloadSimple
})

/**
 * 点角标。三种阶段三件事：可更新 → 开始下载；下载中 → 不响应；已下载 → 问一句再重启。
 */
const handleUpdateClick = (): void => {
  if (updatePhase.value === 'downloading') return

  if (updatePhase.value === 'downloaded') {
    // 弹窗和失败提示都在 useUpdateInstall 里 —— 关于页用的是同一份，
    // 免得同一个动作按入口不同给两种反馈（原来这里失败是一声不吭的）
    confirmInstall()
    return
  }

  // 下载几百 MB，不能 await 着它画 loading —— 进度走 downloadPercent
  message.info(t('update.downloadStarted'))
  void startDownload()
}

/**
 * 下载的失败分两种，只有一种会自己报。
 *
 * 主进程真跑起来之后出的错走 update-error 事件，App.vue 统一报一次，这里不用管。
 * 但「压根没开始」（没配更新源、没有可用更新、已有下载在跑）是主进程静默返回成功、
 * 由 Store 自己判出来的 —— 没有任何事件会推过来。不在这儿报的话，用户刚被告知
 * 「开始下载」，角标却悄悄退回「有新版本」，没有一个字的解释，而且每次点都一样。
 */
async function startDownload(): Promise<void> {
  const result = await updateStore.download()
  if (result.success) return
  message.error(result.errorKey ? t(result.errorKey) : result.error || t('update.unavailable'))
}

onMounted(() => {
  nextTick(() => {
    recalcTabWidth()
    updateFade()
  })
  window.addEventListener('resize', handleResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  if (freezeTimer.value) {
    clearTimeout(freezeTimer.value)
    freezeTimer.value = null
  }
  if (fadeUpdateTimer) {
    cancelAnimationFrame(fadeUpdateTimer)
    fadeUpdateTimer = null
  }
  if (scrollTimer) {
    cancelAnimationFrame(scrollTimer)
    scrollTimer = null
  }
})
</script>

<template>
  <div class="header" :class="{ 'mac-controls-inset': isMac && (collapsed || !showSidebarToggle) }">
    <!-- 只在侧边栏收起时出现的展开按钮。展开时这枚开关在侧边栏 logo 右边，
         收起后侧边栏整块不见了，才由标签栏这头接手。
         不挂 Tooltip：悬停它本来就会把侧边栏浮出来，再弹一条提示是重复的干扰 -->
    <button
      v-if="showSidebarToggle && collapsed"
      class="sidebar-toggle"
      :aria-label="t('layout.showSidebar')"
      @click="emit('toggle-collapsed')"
      @mouseenter="emit('peek-enter')"
      @mouseleave="emit('peek-leave')"
    >
      <span
        class="mono-icon sidebar-toggle-icon"
        role="img"
        :aria-label="t('layout.toggleSidebar')"
        :style="{ '--mono-icon': `url(${collapseIcon})` }"
      />
    </button>

    <!-- 历史标签页 -->
    <div
      class="tabs-container"
      :class="{ 'show-left-fade': showLeftFade, 'show-right-fade': showRightFade }"
    >
      <div
        ref="tabsScrollRef"
        class="custom-tabs"
        :style="{ '--tab-width': tabWidth + 'px' }"
        @scroll="onTabsScroll"
      >
        <div
          v-for="tab in sortedTabs"
          :key="tab.key"
          class="tab-item"
          :class="{
            'tab-active': tab.key === tabsStore.activeTab,
            'tab-dragging': draggedTab === tab.key,
            'tab-drag-over': dragOverTab === tab.key,
            'tab-fixed': tab.fixed,
            draggable: !tab.fixed
          }"
          :draggable="!tab.fixed"
          @click="handleTabClick(tab.key)"
          @mousedown.middle="handleMiddleClick($event, tab.key)"
          @contextmenu="handleContextMenu($event, tab.key)"
          @dragstart="handleDragStart($event, tab.key)"
          @dragover="handleDragOver($event, tab.key)"
          @dragleave="handleDragLeave"
          @drop="handleDrop($event, tab.key)"
          @dragend="handleDragEnd"
        >
          <component :is="getTabIcon(tab.path)" class="tab-icon" />
          <AppTooltip v-if="truncatedMap[tab.key]" :title="t(tab.title)">
            <span
              :ref="(el) => registerTitleEl(el as HTMLElement, tab.key)"
              class="tab-title"
              @mouseenter="checkTruncation(tab.key)"
            >
              {{ t(tab.title) }}
            </span>
          </AppTooltip>
          <span
            v-else
            :ref="(el) => registerTitleEl(el as HTMLElement, tab.key)"
            class="tab-title"
            @mouseenter="checkTruncation(tab.key)"
          >
            {{ t(tab.title) }}
          </span>
          <PhX
            v-if="tab.isCanDelete !== false"
            class="tab-close"
            @click="handleTabRemove(tab.key, $event)"
          />
        </div>
        <AppTooltip placement="bottom" :title="t('tabs.newChat')">
          <div class="add-tab-btn" @click="createNewChat">
            <PhPlus />
          </div>
        </AppTooltip>
      </div>
    </div>
    <!-- 可拖动空间（确保标签页很多时仍有拖动区域） -->
    <div class="header-spacer"></div>
    <!-- 更新角标：可更新 / 下载中 / 待重启三态共用一枚按钮 -->
    <AppTooltip v-if="showUpdateButton" placement="bottom" :title="updateButtonTooltip">
      <button
        class="update-button"
        :class="`is-${updatePhase}`"
        :aria-disabled="updatePhase === 'downloading'"
        @click="handleUpdateClick"
      >
        <!-- 下载进度直接铺在按钮底色上，不另占一条进度条的位置 -->
        <span
          v-if="updatePhase === 'downloading'"
          class="update-progress"
          :style="{ width: `${downloadPercent}%` }"
        />
        <span class="update-body">
          <span v-if="updatePhase === 'available'" class="update-dot" aria-hidden="true" />
          <component :is="updateButtonIcon" v-else class="update-icon" weight="bold" />
          <span class="update-text">{{ updateButtonText }}</span>
        </span>
      </button>
    </AppTooltip>
    <div v-if="!isMac" class="window-controls">
      <button class="window-button" @click="minimizeWindow">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <rect x="2" y="5" width="8" height="2" fill="currentColor" />
        </svg>
      </button>
      <button class="window-button" @click="maximizeWindow">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <rect
            x="2"
            y="2"
            width="8"
            height="8"
            stroke="currentColor"
            stroke-width="1"
            fill="none"
          />
        </svg>
      </button>
      <button class="window-button close" @click="closeWindow">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path
            d="M2 2L10 10M10 2L2 10"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>
    <!-- 右键菜单 -->
    <ContextMenu
      ref="contextMenuRef"
      :menu-items="getContextMenuItems(contextMenuTabKey)"
      @click="handleMenuClick"
    />
  </div>
</template>

<style scoped lang="less">
.header {
  padding: 0;
  display: flex;
  align-items: center;

  height: 100%;
  transition: all 0.15s ease;
  background: var(--color-bg-page);
  backdrop-filter: blur(var(--blur-lg));
  -webkit-app-region: drag;
}

.mac-controls-inset {
  padding-left: var(--space-20);
}

/* 侧边栏开关：标签栏最左边那枚常驻按钮，收起和展开都用它 */
.sidebar-toggle {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: 0 var(--space-1) 0 var(--space-2);
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  opacity: 0.75;
  transition:
    opacity 0.2s ease,
    background-color 0.2s ease;
  /* 标签栏整条是窗口拖拽区，按钮得挖出来才点得到 */
  -webkit-app-region: no-drag;

  &:hover {
    opacity: 1;
    background: var(--color-bg-surface-hover);
  }
}

.sidebar-toggle-icon {
  width: 20px;
  height: 20px;
  display: block;
  /* 图标本身是「往左收」，这里的语义反过来是「拉出来」，翻个面 */
  transform: scaleX(-1);
}

.tabs-container {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.custom-tabs {
  display: flex;
  height: 100%;
  align-items: center;
  overflow: hidden;
  width: 100%;
  gap: 0;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.add-tab-btn {
  flex: 0 0 36px;
  width: 36px;
  height: 36px;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 0;
  cursor: pointer;
  color: var(--color-text-secondary);
  background: transparent;
  border-radius: 2px;
  transition:
    background 0.15s ease,
    color 0.15s ease;
  -webkit-app-region: no-drag;
  margin-left: 4px;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
}

.custom-tabs::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.tab-item {
  display: flex;
  align-items: center;
  padding: 0 10px;
  min-width: 0;
  width: var(--tab-width);
  flex: 0 0 var(--tab-width);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition:
    width 0.15s ease,
    background 0.15s cubic-bezier(0.4, 0, 0.2, 1),
    color 0.15s ease,
    transform 0.15s ease;
  position: relative;
  border-radius: 2px;
  border-right: 1px solid var(--color-border-subtle);
  height: 36px;
  margin-right: 0;
  will-change: background, color, transform;

  -webkit-app-region: no-drag;

  /* 四个状态以前抢同一个底色：悬停、激活、固定、拖放目标全是
     --color-accent-bg，激活态另外糊了一层写死的浅灰渐变（18% 的
     rgb(215 215 215)）—— 那个值只对深色底成立，浅色主题下它压在浅灰
     标签栏上等于没有，「我现在在哪个标签」当场看不出来。

     现在分开：悬停是中性的（悬停不是一种状态，只是「鼠标在这」），
     激活用卡片色从标签栏上浮起来、底下再加一道强调色横杠，
     固定用强调色竖杠当标记。悬停不许盖掉激活。 */
  &:hover:not(.tab-active) {
    background: var(--color-bg-selected);
    color: var(--color-text-primary);
  }

  &.tab-active {
    background: var(--color-bg-surface);
    color: var(--color-text-primary);
    z-index: 2;

    /* 底下这道横杠才是「当前标签」真正的信号 ——
       底色差一档在浅色主题下只有 1.07:1，不能只靠它 */
    &::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 2px;
      background: var(--color-accent-solid);
    }
  }

  &.tab-drag-over {
    background: var(--color-accent-bg);
    border: 1px dashed var(--color-border-focus);
  }

  &.tab-fixed {
    border-left: 3px solid var(--color-accent-solid);
    flex: 0 0 var(--tab-width);
    min-width: 0;

    .tab-title {
      font-weight: 600;
    }
  }

  &.tab-dragging {
    opacity: 0.5;
    transform: rotate(2deg);
    z-index: 10;
    cursor: grabbing;
  }

  &:first-child {
    border-left: none;
    margin-left: 0;

    &.tab-fixed {
      border-left: 1px solid var(--color-border);
    }
  }

  &:last-child {
    border-right: none;
    margin-right: 6px;
  }
}

.tab-icon {
  margin-right: 6px;
  font-size: 14px;
  line-height: 1;
  flex-shrink: 0;
}

.tab-title {
  flex: 1;
  font-size: 13px;
  font-weight: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-right: 6px;
  line-height: 1.5;
  transition: color 0.15s ease;
  min-width: 0;
  text-align: left;
}

.tab-pin {
  font-size: 12px;
  color: var(--color-accent-text);
  margin-right: 4px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.tab-close {
  font-size: 11px;
  color: var(--color-text-primary);
  opacity: 0;
  transition: all 0.15s ease;
  padding: 2px;
  border-radius: 4px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  -webkit-app-region: no-drag;

  &:hover {
    opacity: 1;
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
    transform: scale(1.1);
  }
}

.tab-item:hover .tab-close {
  opacity: 1;
}

/* 渐隐遮罩 */
.tabs-container::before,
.tabs-container::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  pointer-events: none;
  transition: opacity var(--motion-fast) var(--easing-standard);
  opacity: 0;
}

/* 往标签栏自己的底色上渐隐，不是往黑上渐隐 ——
   写死的半透明黑只对深色底成立，浅色主题下是一道脏灰边 */
.tabs-container::before {
  left: 0;
  background: linear-gradient(to right, var(--color-bg-page), transparent);
}

.tabs-container::after {
  right: 0;
  background: linear-gradient(to left, var(--color-bg-page), transparent);
}

.tabs-container.show-left-fade::before {
  opacity: 1;
}
.tabs-container.show-right-fade::after {
  opacity: 1;
}

.more-button {
  -webkit-app-region: no-drag;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  padding: 0 6px;
  height: 32px;
  border-radius: 6px;
  transition:
    background 0.15s ease,
    color 0.15s ease;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
}

.update-button {
  -webkit-app-region: no-drag;
  position: relative;
  display: flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  margin-right: 8px;
  border: 1px solid var(--color-accent-border);
  border-radius: var(--radius-full);
  background: var(--color-accent-bg);
  color: var(--color-accent-text);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  overflow: hidden;
  transition:
    background var(--motion-fast) var(--easing-standard),
    border-color var(--motion-fast) var(--easing-standard),
    transform var(--motion-fast) var(--easing-standard);

  /* 内容压在进度条之上 */
  .update-body {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .update-icon {
    font-size: 13px;
    flex-shrink: 0;
  }

  .update-text {
    white-space: nowrap;
    /* 下载中数字每秒都在跳，等宽数字能防止按钮宽度抖动 */
    font-variant-numeric: tabular-nums;
  }

  /* 「有新版本」用一颗呼吸的小圆点，比图标更像通知，也更安静。
     呼吸 8 次（约 16 秒）就停：这个阶段会一直挂到用户点下载为止，也就是
     基本等于整个会话。`infinite` 的话标题栏里就永远有一个合成动画在跑，
     GPU 进程再也不进空闲 —— 只是开着窗口也在掉电。吸引注意本来也只需要
     开头那几下，之后圆点静静留着就够了 */
  .update-dot {
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    border-radius: 50%;
    background: currentColor;
    animation: update-dot-pulse 2s var(--easing-standard) 8;
  }

  /* 进度条不能用 --color-accent-bg-hover：浅色下它是 #ededed，压在 #f7f7f7 的
     按钮底色上对比度只有 1.1:1，等于看不见；而且那正是 hover 的底色，
     真看见了也会被当成鼠标划过。改用强调实色压低透明度 —— 两套主题下都能
     看出来，又不会盖掉上面那行字 */
  .update-progress {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 0;
    background: var(--color-accent-solid);
    opacity: 0.28;
    transition: width var(--motion-normal) var(--easing-standard);
  }

  &:not([aria-disabled='true']):hover {
    background: var(--color-accent-bg-hover);
    border-color: var(--color-accent-solid);
  }

  &:not([aria-disabled='true']):active {
    transform: scale(0.97);
  }

  /* 下载中用 aria-disabled 而不是 disabled：原生 disabled 会连鼠标事件一起吞掉，
     外面那层 Tooltip 就再也弹不出来了。点击本身在处理函数里已经挡住 */
  &[aria-disabled='true'] {
    cursor: default;
  }

  /* 已下载：这一步是唯一会重启应用的动作，给它实心底色区别开 */
  &.is-downloaded {
    background: var(--color-accent-solid);
    border-color: var(--color-accent-solid);
    color: var(--color-text-on-solid);

    &:not([aria-disabled='true']):hover {
      background: var(--color-accent-solid-hover);
      border-color: var(--color-accent-solid-hover);
    }
  }
}

@keyframes update-dot-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.8);
  }
}

@media (prefers-reduced-motion: reduce) {
  .update-button .update-dot {
    animation: none;
  }
}

.header-spacer {
  flex: 0 0 auto;
  min-width: 60px;
  height: 100%;
  -webkit-app-region: drag;
}

.window-controls {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}

.window-button {
  width: 36px;
  height: 32px;
  border: none;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all var(--motion-fast) var(--easing-standard);
  border-radius: 0;

  // 12 而不是原来的 10：Phosphor 的墨迹占框比 antd 小约一成七，照搬 px 会变虚
  svg {
    width: 12px;
    height: 12px;
    opacity: 0.7;
    transition: opacity var(--motion-fast) var(--easing-standard);
  }

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);

    svg {
      opacity: 1;
    }
  }

  &:active {
    background: var(--color-bg-surface-hover);
  }

  &.close:hover {
    background: var(--color-danger-solid);
    color: var(--color-text-on-solid);

    svg {
      opacity: 1;
    }
  }

  &.close:active {
    background: var(--color-danger-solid);
  }
}

/* 当标签页很多时的响应式处理 */
@media (max-width: 1200px) {
  .tab-item {
    padding: 0 6px;
    margin-right: 2px;

    .tab-title {
      font-size: 12px;
      margin-right: 2px;
    }

    .tab-close {
      width: 14px;
      height: 14px;
      font-size: 12px;
      padding: 1px;
    }
  }
  .tab-home-icon {
    margin-right: 4px;
  }
}

@media (max-width: 900px) {
  .tab-item {
    padding: 0 4px;
    margin-right: 1px;
    min-width: 30px;

    .tab-title {
      font-size: 11px;
      margin-right: 1px;
    }

    .tab-close {
      width: 12px;
      height: 12px;
      font-size: 9px;
      padding: 1px;
    }
  }
  .tab-home-icon {
    margin-right: 3px;
  }
}

@media (max-width: 600px) {
  .tab-item {
    padding: 0 2px;
    margin-right: 0;
    min-width: 24px;

    .tab-title {
      font-size: 12px;
      margin-right: 0;
    }

    .tab-close {
      width: 10px;
      height: 10px;
      font-size: 8px;
      padding: 0;
    }
  }
  .tab-home-icon {
    margin-right: 2px;
  }
}
</style>
