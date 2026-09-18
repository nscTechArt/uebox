<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter, useRoute } from 'vue-router'
import { Layout } from 'ant-design-vue'
import { message } from '@renderer/utils/messageManager'
import { useI18n } from 'vue-i18n'
import SideMenu from './components/SideMenu.vue'
import TabsHeader from './components/TabsHeader.vue'
import AppPageLoading from '@renderer/components/AppPageLoading.vue'
import { pendingPage } from '@renderer/router/pageLoading'
import GlobalAudioPlayer from '@renderer/components/GlobalAudioPlayer.vue'
import ScreenshotMode from '@renderer/components/ScreenshotMode.vue'
import BridgeUnavailableBanner from '@renderer/components/BridgeUnavailableBanner.vue'
import AssetLockIndicator from '@renderer/components/AssetLockIndicator.vue'
import ImportProgressWidget from '@renderer/components/ImportProgressWidget.vue'
import ImportToProjectModal from '@renderer/views/AssetManagement/components/modals/ImportToProjectModal.vue'
import { checkImportCompatibility } from '@renderer/api/projectImport'
import ImportResultModal from '@renderer/components/ImportResultModal.vue'
import SensitiveActionConfirm from '@renderer/components/SensitiveActionConfirm.vue'
import { useImportTasksStore } from '@renderer/store/modules/importTasks'
import { isCleanImportReport } from '@core/shared/projectImport'
import { useAssetViewStore } from '@renderer/store/modules/assetViewStore'
import { useLayoutUiStore } from '@renderer/store/modules/layoutUiStore'
import { useVaultStore } from '@renderer/store/modules/vaultStore'
import { notifyPluginUpgradeFailure } from '@renderer/hooks/usePluginInstallNotice'
import { resolveTabRoute } from '@renderer/common/tabRoute'
import { useAppAgentRunner } from '@renderer/views/Assistant/composables/appAgentRunner'
import { useFollowUpDelivery } from '@renderer/views/Assistant/composables/followUpDelivery'
import { useSessionProjectSync } from '@renderer/views/Assistant/composables/sessionProjectSync'
import { useAutoReadAloud } from '@renderer/views/Assistant/composables/autoReadAloud'
import { hasVisibleSidebarFloatingOverlay, useSidebarPeek } from './composables/sidebarPeek'
import { useNotificationActivation } from './composables/notificationActivation'
// StatusBar 已移至 AssetManagement 专用，只在资产库页面显示

const { Content } = Layout

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const assetViewStore = useAssetViewStore()
const layoutUiStore = useLayoutUiStore()
const importTasksStore = useImportTasksStore()

/*
 * 导入进度挂件也挂在这一层，理由和资产锁指示器一样：正在导入这件事该看到的是人，
 * 而人此刻很可能正在别的页面上。挂在资产库页面里的时候，那个页面一失活 DOM 就被
 * keep-alive 卸掉，三十个 G 的导入在跑，界面上一点痕迹都没有。
 */
const runningImportTasks = computed(() =>
  importTasksStore.runningTasks(useVaultStore().currentVault?.id)
)

/** 点任务卡片 → 回资产库并定位到那个文件夹（`?folderKey=` 是页面已支持的入口） */
const handleImportTaskNavigate = (folderKey: string): void => {
  void router.push({ path: '/asset-management', query: { folderKey: folderKey || 'ALL' } })
}

/**
 * 挂件上的中止按钮。
 *
 * 真正会停的是发起这次导入的那一方（工程导入在 ImportToProjectModal 里监听 window 事件），
 * 这里只把「用户点了停」这件事广播出去。
 */
const handleImportTaskCancel = (taskId: string): void => {
  const task = importTasksStore.tasks.get(taskId)
  if (task?.taskType !== 'project-import') {
    window.dispatchEvent(new CustomEvent('vault-import:cancel', { detail: { id: taskId } }))
    return
  }
  window.dispatchEvent(new CustomEvent('project-import:cancel', { detail: { id: taskId } }))
}

/**
 * 导入失败之后的那一层。
 *
 * 挂在这里而不是发起导入的那个页面里，理由和 SensitiveActionConfirm 一样：
 * 导入是后台跑的，出结果时用户很可能已经在别的页面上了。
 */
const inspectingTaskId = ref('')
const retrying = ref(false)
const compatibleProjectOpen = ref(false)
const compatibleProjectSource = ref<{
  type: string
  children: Array<{ assetKey?: string; assetName?: string; fileExtension: string }>
}>()
const hasVersionConflict = computed(() =>
  inspectingTask.value?.report?.planErrors.some(
    (row) => row.code === 'engine-version' || (!row.code && row.error.includes('高于目标项目版本'))
  )
)
const chooseCompatibleProject = (): void => {
  const retry = inspectingTask.value?.retry
  if (!retry) return
  compatibleProjectSource.value = {
    type: 'batch',
    children: retry.sources.map((source) => ({ ...source, fileExtension: 'uasset' }))
  }
  inspectingTaskId.value = ''
  compatibleProjectOpen.value = true
}
const inspectingTask = computed(() =>
  inspectingTaskId.value ? importTasksStore.tasks.get(inspectingTaskId.value) : undefined
)

const handleImportTaskInspect = (taskId: string): void => {
  if (importTasksStore.tasks.get(taskId)?.vaultResult) {
    void router.push('/asset-management')
    window.dispatchEvent(new CustomEvent('vault-import:inspect', { detail: { id: taskId } }))
    return
  }
  inspectingTaskId.value = taskId
}

/** 用户看过了，把这条失败任务收掉 */
const handleImportTaskDismiss = (taskId: string): void => {
  if (inspectingTaskId.value === taskId) inspectingTaskId.value = ''
  importTasksStore.removeTask(taskId)
}

/**
 * 重试。
 *
 * 安全的动作：导入是增量的，已经在的文件一个字节都不会重搬，缺的会补上
 * ——所以它配得上主按钮的位置。
 */
const handleImportRetry = async (): Promise<void> => {
  const task = inspectingTask.value
  const retry = task?.retry
  if (!task || !retry || retrying.value) return

  if (hasVersionConflict.value) {
    chooseCompatibleProject()
    return
  }
  retrying.value = true
  try {
    const check = await checkImportCompatibility(retry.project, retry.sources)
    if (check.blocked.length > 0) {
      chooseCompatibleProject()
      return
    }
  } catch (error) {
    message.error(String(error))
    return
  } finally {
    retrying.value = false
  }

  // 带上 requestId，重试这一轮才登记得进主进程的取消表、进度也才发得回来。
  // 没有它的话，重试一批 30G 的素材在界面上只是按钮上转个圈：停不掉、也看不见进展
  const requestId = `import-retry-${task.id}-${Date.now()}`
  const unsubscribe = window.api.projectImport.onImportUAssetsBatchProgress((payload) => {
    if (payload.requestId !== requestId) return
    const planShare = payload.total > 0 ? Math.round((payload.processed / payload.total) * 50) : 0
    const copyShare =
      payload.filesQueued > 0 ? Math.round((payload.filesCopied / payload.filesQueued) * 49) : 0
    importTasksStore.updateTask(task.id, {
      status: 'running',
      progress: Math.min(99, planShare + copyShare),
      stageText: t('importResultModal.retrying')
    })
  })

  const onCancel = (event: Event): void => {
    if ((event as CustomEvent).detail?.id === task.id) {
      void window.api.projectImport.cancelImportUAssetsBatch(requestId)
    }
  }
  window.addEventListener('project-import:cancel', onCancel)
  importTasksStore.updateTask(task.id, {
    status: 'running',
    progress: 0,
    stageText: t('importResultModal.retrying')
  })
  retrying.value = true
  try {
    const result = await window.api.projectImport.importUAssetsBatch(retry.project, retry.sources, {
      requestId
    })
    if (result?.success && !result.cancelled) {
      message.success(t('importResultModal.retrySucceeded'))
      /*
       * 只有「这批本来就只有 .uasset」时才敢把整条任务收掉。
       *
       * retry.sources 只装了 .uasset 那一半（外部文件得过引擎的导入 API，没法重试），
       * 所以一批 10 个模型 + 2 个 FBX 里 FBX 失败的场景，重试成功不代表 FBX 好了 ——
       * 直接 dismiss 等于把还没解决的那两个连同证据一起抹掉。
       */
      if (task.retryCoversAll) {
        handleImportTaskDismiss(task.id)
      } else {
        importTasksStore.updateTask(task.id, {
          status: 'error',
          progress: 100,
          stageText: t('importResultModal.retryPartial')
        })
        message.warning(t('importResultModal.retryPartial'))
      }
    } else {
      // 还是没好 —— 用新的报告把旧的换掉，别让用户对着上一轮的清单看。
      // 报告可能是「干净」的（比如整批路径无效），那种情况下留着旧的更有信息量
      const next = isCleanImportReport(result?.report) ? task.report : result?.report
      importTasksStore.updateTask(task.id, {
        report: next,
        status: 'error',
        progress: 100,
        stageText: t(
          result?.cancelled
            ? 'assetManagement.import.cancelled'
            : 'importResultModal.retryStillFailing'
        )
      })
      message.warning(
        t(
          result?.cancelled
            ? 'assetManagement.import.cancelled'
            : 'importResultModal.retryStillFailing'
        )
      )
    }
  } catch (error) {
    importTasksStore.updateTask(task.id, { status: 'error', progress: 100 })
    message.error(String((error as Error)?.message || error))
  } finally {
    unsubscribe()
    window.removeEventListener('project-import:cancel', onCancel)
    retrying.value = false
  }
}

/** 在资产库里找这条缺失的依赖 —— 复用资产库已有的搜索入口，不另开页面 */
const handleImportSearch = (keyword: string): void => {
  inspectingTaskId.value = ''
  void router.push({ path: '/asset-management', query: { search: keyword } })
}

const { sideMenuCollapseRequestVersion } = storeToRefs(layoutUiStore)

/*
 * 后台跑活的五样东西，都挂在这里 —— 常驻布局比任何一个页面活得久。
 *
 * 助手路由没开 keepAlive，用户切去看素材库那一刻它就卸载了，而 agent 照样在跑。
 * 「谁来发起一轮」（appAgentRunner，跟进队列和语音派活共用）、「什么时候该发下
 * 一条」（followUpDelivery）、「点了系统通知跳去哪」（notificationActivation）、
 * 「模型把这条对话改挂到别的工程下了」（sessionProjectSync）和「回复落定了念出
 * 来」（autoReadAloud）都不能拴在页面寿命上，否则用户切个页面就静默失效 ——
 * 通知那条尤其：他正是因为切走了才会收到那条通知；归属那条同理，模型改归属时
 * 用户多半正在别处等结果；朗读那条也一样，他就是因为要等才切走的。
 *
 * 顺序有讲究：投递会用到运行器，运行器要先装上。
 */
useAppAgentRunner()
useFollowUpDelivery()
useNotificationActivation()
useSessionProjectSync()
useAutoReadAloud()

// 基于路由meta控制组件显示
const showMenu = computed(() => route.meta.showMenu !== false)
const showTab = computed(() => route.meta.showTab !== false)
/**
 * macOS 的红绿灯浮在内容上，得有人给它让位并提供拖拽区。
 * 平时侧边栏顶栏或标签栏已经担着这件事（见各自的 mac-controls-inset）；
 * 两个都不显示的路由（比如 /404）才补这一条 —— 不能反过来强开标签栏，
 * 那会把明确写了 showTab: false 的路由一起覆盖掉。
 */
const showMacTitlebarInset = computed(
  () => window.api?.platform === 'darwin' && !showTab.value && !showMenu.value
)
const getRouteCacheKey = (currentRoute: typeof route): string => {
  return resolveTabRoute(currentRoute)?.key || currentRoute.fullPath
}

// 侧边栏收折状态 - 持久化到 localStorage
const SIDEBAR_COLLAPSED_KEY = 'sidebar-collapsed'
const getInitialCollapsedState = (): boolean => {
  const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY)
  return saved === 'true'
}
const collapsed = ref(getInitialCollapsedState())

watch(sideMenuCollapseRequestVersion, () => {
  if (!collapsed.value) {
    collapsed.value = true
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'true')
  }
})

// TabsHeader组件引用
const tabsHeaderRef = ref()

// 动态获取当前打开的标签页作为缓存列表
// const tabsStore = useTabsStore()

// 已移除未使用的缓存视图计算属性，避免类型检查告警
// 切换侧边栏收折状态
const toggleCollapsed = () => {
  collapsed.value = !collapsed.value
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed.value))
}

/**
 * 收起后的浮出面板。
 *
 * 触发点在标签栏那枚按钮上（TabsHeader），面板本身是 SideMenu，
 * 两边都不是对方的父级，所以这份状态放在它们共同的父级这里。
 */
/**
 * 还该不该留着浮层。
 *
 * 一是鼠标其实还压在按钮或面板上（划得快时 mouseleave 会漏发，直接问 DOM 更准），
 * 二是右键菜单、重命名弹窗这些挂在 body 上的浮层还开着 —— 这时候收面板等于把上下文抽走。
 */
const shouldStayOpen = (): boolean => {
  if (document.querySelector('.side-menu:hover, .sidebar-toggle:hover')) return true
  return hasVisibleSidebarFloatingOverlay()
}

const sidebarPeek = useSidebarPeek({ collapsed: () => collapsed.value, shouldStayOpen })
const { peeking } = sidebarPeek

/** Esc 关掉浮出的侧边栏，和它盖住内容这件事对应 */
const handleGlobalKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape' && peeking.value) sidebarPeek.close()
}

// 菜单点击事件
const handleMenuClick = (key: string) => {
  const target = String(key || '').trim()
  console.log('[MainLayout] navigating from side menu:', target)
  if (!target) return
  router.push(target).catch((error) => {
    console.warn('[MainLayout] side menu navigation failed:', error)
  })
}

// 处理TabsHeader组件的激活tab变化事件
const handleActiveTabChange = (key: string) => {
  // 可以在这里添加一些全局的tab切换逻辑，比如记录用户行为等
  console.log('Active tab changed to:', key)
}

/**
 * 全局监听 Agent 创建文件夹的事件
 * 当用户不在资产库页面时，AssetManagement 组件可能被缓存，
 * 此时事件监听器虽然存在但可能无法正确触发刷新
 * 通过在 MainLayout 层面监听事件并设置 Store 标记，
 * 确保 AssetManagement 在 onActivated 时能正确刷新
 */
const handleAssetTreeRefresh = (
  _event: unknown,
  payload: { parentKey: string; createdCount: number }
) => {
  console.log('[MainLayout] 收到 Agent 创建文件夹事件，标记树需要刷新:', payload)
  assetViewStore.markTreeNeedsRefresh(payload)
}

/**
 * 虚幻那边点「导入到盒子」后立刻给个回执。
 *
 * 插件是单向发事件、不显示任何提示，导入大目录又要跑一会儿 ——
 * 盒子这边不吭声，用户只会以为没点上，然后连点好几次。
 * 放在 MainLayout 是因为他当时未必停在资产库页面。
 *
 * 一句 toast 3 秒就没了，而导入要跑几十秒 —— 所以这里还要在进度挂件上开一条任务。
 * 挂件本来就挂在 MainLayout 上（应用级），进度和完成由下面两个处理器推着走；
 * 资产库页面挂着时它自己也会收到同样的事件去刷新列表，两边写的是同一个 store，
 * 值也一样，重复写没有副作用。
 */
const handleUnrealImportStarted = (
  _event: unknown,
  payload: { taskId?: string; count: number; projectName?: string }
): void => {
  message.info(t('assetManagement.import.unrealImportStarted', { count: payload?.count ?? 0 }))
  if (!payload?.taskId) return
  importTasksStore.addTask({
    id: payload.taskId,
    type: 'folder',
    name: payload.projectName || t('assetManagement.import.unrealImportTaskName'),
    progress: 0,
    total: payload.count,
    done: 0,
    stageText: t('assetManagement.import.stagePreparing'),
    status: 'running',
    taskType: 'vault-import',
    vaultId: useVaultStore().currentVault?.id
  })
}

/** 虚幻发起的那条导入任务（由主进程造 id），和界面自己发起的导入区分开 */
const isUnrealImportTask = (taskId?: string): boolean => Boolean(taskId?.startsWith('ue-import-'))

const handleUnrealImportProgress = (
  _event: unknown,
  payload: { taskId?: string; percent?: number; total?: number; done?: number }
): void => {
  if (!isUnrealImportTask(payload?.taskId)) return
  importTasksStore.updateTask(payload.taskId!, {
    progress: Math.round(payload.percent ?? 0),
    total: payload.total,
    done: payload.done
  })
}

const handleUnrealImportCompleted = (
  _event: unknown,
  payload: { taskId?: string; done?: number }
): void => {
  if (!isUnrealImportTask(payload?.taskId)) return
  importTasksStore.updateTask(payload.taskId!, {
    progress: 100,
    status: 'completed',
    stageText: t('assetManagement.import.unrealImportTaskDone', { count: payload.done ?? 0 })
  })
  // 完成的卡片留 3 秒让人看见，然后收掉；失败的不自动收，见下面
  const finishedId = payload.taskId!
  setTimeout(() => importTasksStore.removeTask(finishedId), 3000)
}

const handleUnrealImportError = (
  _event: unknown,
  payload: { taskId?: string; error?: string }
): void => {
  if (!isUnrealImportTask(payload?.taskId)) return
  // 失败的卡片不自动消失 —— 这是用户唯一能看到「导入没成」的地方
  importTasksStore.updateTask(payload.taskId!, {
    status: 'error',
    stageText: t('assetManagement.import.unrealImportTaskFailed', {
      error: payload.error || t('assetManagement.import.unknownError')
    })
  })
}

/**
 * 活跃保管库被主进程换掉了（agent 的 switch_vault、网络库迁移）。
 *
 * 必须让界面跟上：用户看着 A 库、应用实际在 B 库上读写，
 * 这种不一致比切不过去糟糕得多 —— 他会以为自己的素材没了。
 * 所以还要明着说一声切到哪儿了，切库不能悄悄发生。
 */
const handleVaultSwitched = (_event: unknown, payload: { vaultId: string; name: string }): void => {
  if (!payload?.vaultId) return
  const vaultStore = useVaultStore()
  if (vaultStore.currentVault?.id === payload.vaultId) return

  vaultStore.applyExternalVaultSwitch(payload.vaultId)
  message.info(t('assetManagement.vault.switchedByAgent', { name: payload.name }))
}

/**
 * 开机后台升级插件失败的提示，退订函数。
 *
 * 挂在常驻布局上而不是首页：这条通知在**开机后几秒**就到，那时用户可能停在任何
 * 一个标签页。挂首页的话，没开着首页的人永远收不到 —— 而他正是最需要知道
 * 「你还在用旧版插件」的那个人。
 */
let offPluginUpgradeFailed: (() => void) | null = null

onMounted(() => {
  // 监听 Agent 创建文件夹事件
  window.electron.ipcRenderer.on('asset-tree:refresh', handleAssetTreeRefresh)
  window.electron.ipcRenderer.on('asset:unrealImportStarted', handleUnrealImportStarted)
  window.electron.ipcRenderer.on('asset:folderImportProgress', handleUnrealImportProgress)
  window.electron.ipcRenderer.on('asset:folderImportCompleted', handleUnrealImportCompleted)
  window.electron.ipcRenderer.on('asset:folderImportError', handleUnrealImportError)
  window.electron.ipcRenderer.on('vault:switched', handleVaultSwitched)
  document.addEventListener('keydown', handleGlobalKeydown)
  offPluginUpgradeFailed =
    window.api.database.project.onPluginUpgradeFailed?.(notifyPluginUpgradeFailure) ?? null
})

onUnmounted(() => {
  window.electron.ipcRenderer.removeListener('asset-tree:refresh', handleAssetTreeRefresh)
  window.electron.ipcRenderer.removeListener('asset:unrealImportStarted', handleUnrealImportStarted)
  window.electron.ipcRenderer.removeListener(
    'asset:folderImportProgress',
    handleUnrealImportProgress
  )
  window.electron.ipcRenderer.removeListener(
    'asset:folderImportCompleted',
    handleUnrealImportCompleted
  )
  window.electron.ipcRenderer.removeListener('asset:folderImportError', handleUnrealImportError)
  window.electron.ipcRenderer.removeListener('vault:switched', handleVaultSwitched)
  document.removeEventListener('keydown', handleGlobalKeydown)
  offPluginUpgradeFailed?.()
  offPluginUpgradeFailed = null
})
</script>

<template>
  <Layout class="main-layout">
    <!-- 左侧菜单 -->
    <SideMenu
      v-if="showMenu"
      :collapsed="collapsed"
      :peeking="peeking"
      @menu-click="handleMenuClick"
      @toggle-collapsed="toggleCollapsed"
      @peek-enter="sidebarPeek.open()"
      @peek-leave="sidebarPeek.scheduleClose()"
      @peek-close="sidebarPeek.close()"
    />
    <Layout
      :class="[showMenu ? '' : 'no-menu', showMenu && collapsed ? 'sidebar-hidden' : '']"
      class="layout-container"
    >
      <!-- 没有标签栏也没有侧边栏时，替红绿灯留出的那条 -->
      <div v-if="showMacTitlebarInset" class="mac-titlebar-inset"></div>

      <!-- 顶部基础信息区域 -->
      <div v-if="showTab" class="tabs-header-wrapper">
        <TabsHeader
          ref="tabsHeaderRef"
          :collapsed="collapsed"
          :show-sidebar-toggle="showMenu"
          @active-tab-change="handleActiveTabChange"
          @toggle-collapsed="toggleCollapsed"
          @peek-enter="sidebarPeek.open()"
          @peek-leave="sidebarPeek.scheduleClose()"
        />
      </div>

      <!-- 内容区域 -->
      <Content class="content glass" :class="!showMenu && !showTab ? 'full-content' : ''">
        <AppPageLoading v-if="pendingPage" class="pending-page" :path="pendingPage.path" />
        <div v-show="!pendingPage" class="route-content">
          <router-view v-slot="{ Component, route: pageRoute }">
            <keep-alive :max="50">
              <component
                :is="Component"
                v-if="pageRoute.meta.keepAlive"
                :key="getRouteCacheKey(pageRoute)"
              />
            </keep-alive>
            <component :is="Component" v-if="!pageRoute.meta.keepAlive" :key="pageRoute.fullPath" />
          </router-view>
        </div>
      </Content>
    </Layout>

    <!-- 全局音频播放器 -->
    <GlobalAudioPlayer />

    <!--
      引擎桥接没起来时的横幅。挂在这里而不是某一页：桥接是整个应用的能力，
      而主进程写好的那句原因（端口被谁占了、怎么办）以前根本没有出口
    -->
    <BridgeUnavailableBanner />

    <!-- 截图模式组件 -->
    <ScreenshotMode />

    <!--
      资产锁指示器 + 逃生口。挂在全局而不是助手页里：被挡住的是某条会话，
      而该看到这件事的是人，人此刻很可能正在别的页面上。
    -->
    <AssetLockIndicator />

    <!-- 后台导入进度挂件：任何页面都看得到 -->
    <ImportProgressWidget
      :tasks="runningImportTasks"
      @navigate="handleImportTaskNavigate"
      @cancel="handleImportTaskCancel"
      @inspect="handleImportTaskInspect"
      @dismiss="handleImportTaskDismiss"
    />

    <!-- 导入没导全时的详情。和挂件同一层：该看到这件事的是人，人可能在别的页面 -->
    <ImportResultModal
      :open="Boolean(inspectingTask)"
      :task-name="inspectingTask?.name"
      :project-name="inspectingTask?.projectName"
      :report="inspectingTask?.report"
      :retryable="Boolean(inspectingTask?.retry)"
      :retrying="retrying"
      :retry-label="
        hasVersionConflict ? t('importToProjectModal.chooseCompatibleProject') : undefined
      "
      @update:open="inspectingTaskId = $event ? inspectingTaskId : ''"
      @retry="handleImportRetry"
      @search="handleImportSearch"
    />

    <ImportToProjectModal
      v-if="compatibleProjectOpen"
      v-model:open="compatibleProjectOpen"
      :source="compatibleProjectSource"
    />

    <!--
      敏感操作确认框。

      这里原来挂在 `Assistant/components/ChatLog.vue` 里，注释写着「全局单例」，
      实际是助手页的子组件 —— 而助手页没有 keepAlive，切走就卸载。
      于是从别的页面（比如库详情页点「放进当前工程」）发起的操作，
      审批框根本不会出现，用户只会在 `APPROVAL_TIMEOUT_MS`（5 分钟）之后
      收到一句「失败」，还不知道自己曾被问过。

      挂在这里和 AssetLockIndicator 是同一个理由：该看到这件事的是人，
      而人此刻很可能正在别的页面上。
    -->
    <SensitiveActionConfirm />

    <!-- 订阅到期覆盖层 -->
  </Layout>
</template>

<style scoped lang="less">
.main-layout {
  /* 侧边栏的感应条要避开这条标签栏，两边共用同一个高度 */
  --app-tabs-height: 36px;

  flex: 1;
  display: flex;
  gap: 0;
  background: transparent;
  /* 侧边栏是绝对定位的浮层（收起时整块推到窗口外），这里当它的定位参照 */
  position: relative;
  overflow: hidden;

  :deep(.ant-layout) {
    background: transparent;
  }

  :deep(.ant-layout-content) {
    background: transparent;
  }
}

.layout-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.tabs-header-wrapper {
  flex-shrink: 0;
  height: var(--app-tabs-height);
  background: var(--color-bg-surface-hover) !important;
  overflow: hidden;
  /* 顶部区域上移后可以作为窗口拖拽区域 */
  -webkit-app-region: drag;
}

/* 红绿灯专用的那一条：和标签栏同高，只负责让位和拖拽，不放任何内容 */
.mac-titlebar-inset {
  flex-shrink: 0;
  height: var(--app-tabs-height);
  -webkit-app-region: drag;
}

.route-content {
  height: 100%;
}

.content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  margin-top: 0;
  background: transparent;
  position: relative;

  /* 自定义滚动条 */
  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-track {
    background: var(--color-bg-surface-hover);
    border-radius: 3px;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 3px;

    &:hover {
      background: var(--color-bg-surface-hover);
    }
  }
}

.no-menu {
  margin-left: 0 !important;
}

/* 没有侧边栏、或侧边栏已收起时关闭左缘遮罩：那条渐隐是给贴着内容的侧边栏做过渡的，
   侧边栏不在了它就只是窗口左缘的一道黑边 */
.layout-container.no-menu .content::before,
.layout-container.sidebar-hidden .content::before {
  display: none;
}

.full-content {
  padding: 0;
  height: 100vh;
  margin: 0;
  border-radius: 0;
  border: none;
  box-shadow: none;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>
.content.glass { --glass-bg: var(--color-bg-surface-hover); background:
var(--color-bg-surface-hover) !important; } :deep(.ant-layout-content.content.glass) { background:
var(--color-bg-surface-hover) !important; }
