/**
 * 托盘菜单 ↔ 界面之间的桥。
 *
 * 两个方向，都挂在常驻布局上（和 `notificationActivation` 同一个理由：
 * 用户切去看素材库时助手页就卸载了，托盘菜单照样会点）。
 *
 * **上报**：最近活跃的三条对话推给主进程，托盘菜单里就有得点。
 * 活跃按 `updatedAt` 算（只在新建对话、来新消息时盖一次），取自对话
 * store 的 `displayableSessions`（归档和内嵌对话已摘出去）。刻意不跟
 * 侧边栏的排列序：托盘是「回到我刚才那条对话」的入口，而默认按工程
 * 分组的侧边栏里纯对话排在最后 —— 跟渲染序的话，从托盘新开的对话
 * 反而永远进不了「最近对话」。置顶同理只是侧边栏的整理手段，不算最近。
 * 序列化没变不重发：对话里的每条消息都会动 `updatedAt`，而主进程一次
 * 重建就要重读引擎的最近名单，没必要跟着抖。
 *
 * **下发**：菜单点了什么，主进程把窗口拉到前台、存下动作，再发一句
 * `tray:action` 提醒（不带负载）。动作本体只有 `tray:take-pending`
 * 一条送达路径 —— 取走即清，所以提醒那一下和挂载补取不会把同一条
 * 执行两次；提醒落空（布局没挂载、渲染进程在重载）也不要紧，存着的
 * 那份由挂载补取救回来。
 */

import { onScopeDispose, watch } from 'vue'
import { useRouter } from 'vue-router'

import { trayAPI } from '@renderer/api/tray'
import { chatSessionRoute, generateChatSessionId } from '@renderer/common/chatRoute'
import { notifyPluginInstallFailure } from '@renderer/hooks/usePluginInstallNotice'
import i18n from '@renderer/i18n'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { confirmDialog, errorDialog } from '@renderer/utils/dialog'
import {
  TRAY_RECENT_LIMIT,
  type TrayAction,
  type TrayRecentSession
} from '@core/shared/trayActions'

/** 退出确认框开着时再点托盘「退出」（或再点一次安装更新）不叠第二个 */
let quitDialogOpen = false

/**
 * 托盘「退出」、`app-quit`、安装更新时，只要还有操作没收摊，都弹这一个框；
 * 安装更新只换标题和确认按钮。确认后主进程按发起的那条路退
 */
function confirmTrayQuit(count: number, reason?: 'update'): void {
  if (quitDialogOpen) return
  quitDialogOpen = true
  const { t } = i18n.global
  const isUpdate = reason === 'update'
  confirmDialog({
    title: t(isUpdate ? 'layout.updateQuitTitle' : 'layout.trayQuitTitle'),
    content: t('layout.trayQuitContent', { count }),
    okText: t(isUpdate ? 'layout.updateQuitOk' : 'layout.trayQuitOk'),
    cancelText: t('common.cancel'),
    danger: true,
    centered: true,
    // 默认停在「取消」：误按回车不该把跑着的任务一起带走
    focusCancel: true,
    onOk: () =>
      trayAPI.confirmQuit().catch((error) => {
        console.error('[TrayBridge] 通知主进程退出失败', error)
      }),
    afterClose: () => {
      quitDialogOpen = false
    }
  })
}

export function useTrayBridge(): void {
  const router = useRouter()
  const tabsStore = useTabsStore()
  const chatStore = useChatSessionsStore()

  watch(
    () =>
      JSON.stringify(
        chatStore.displayableSessions
          .slice(0, TRAY_RECENT_LIMIT)
          .map((session) => ({ id: session.id, title: session.title }))
      ),
    (serialized) => {
      void trayAPI
        .setRecentSessions(JSON.parse(serialized) as TrayRecentSession[])
        .catch((error) => {
          console.warn('[TrayBridge] 上报最近对话失败', error)
        })
    },
    // 挂上来就先报一次，让菜单启动时就有最近对话
    { immediate: true }
  )

  function handleAction(action: TrayAction): void {
    if (action.type === 'open-session') {
      // 查不到就什么都不做：窗口已经在前台了，硬跳一条猜的对话更糟
      if (!chatStore.sessionById(action.sessionId)) return
      void router
        .push(
          chatSessionRoute(
            action.sessionId,
            tabsStore.historyTabs.map((tab) => tab.path)
          )
        )
        .catch((error) => {
          console.error('[TrayBridge] 跳转对话失败', error)
        })
      return
    }

    if (action.type === 'new-session') {
      void router
        .push({ name: 'AssistantWelcome', query: { sid: generateChatSessionId() } })
        .catch((error) => {
          console.error('[TrayBridge] 新建对话跳转失败', error)
        })
      return
    }

    if (action.type === 'confirm-quit') {
      confirmTrayQuit(action.count, action.reason)
      return
    }

    // 系统通知弹不出来时，打开工程的失败原因只能在这里让用户看到
    if (action.type === 'open-failed') {
      errorDialog({ title: action.title, content: action.body, centered: true })
      return
    }

    // 工程打开了但插件没装上 —— 首页那张「让 AI 看看」的对话框原样复用
    notifyPluginInstallFailure({
      pluginFailure: action.pluginFailure,
      data: { originPath: action.originPath, projectName: action.projectName }
    })
  }

  /*
   * 收到提醒就去取，取回失败（处理器还没挂上）不该变成没人管的
   * promise rejection —— 咽掉记一行。
   */
  function drainPending(): void {
    void trayAPI
      .takePending()
      .then((action) => {
        if (action) handleAction(action)
      })
      .catch((error) => {
        console.warn('[TrayBridge] 取回待处理的托盘动作失败', error)
      })
  }

  /*
   * 先注册监听再补取：落在两步之间的提醒有监听接着，
   * 取走即清保证同一条不执行两次。
   */
  const dispose = trayAPI.onActionPending(drainPending)
  drainPending()

  onScopeDispose(dispose)
}
