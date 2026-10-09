/**
 * 托盘菜单的生命周期。
 *
 * ## Windows 和其他平台是两套做法
 *
 * 「最近项目」这东西点开菜单那一刻才算数 —— 引擎刚关掉一个工程，菜单里
 * 那条就不该还标着「运行中」。所以 **win32 不 `setContextMenu`**，改成
 * `right-click` 时现场查一遍再 `popUpContextMenu`：代价是每次右键多一次
 * 名单读取（读几个 ini），换来的是菜单永远新鲜。
 *
 * 这条「不」是硬约束，不只是省事：Electron 在 Windows 上收到右键时，
 * 只要 `setContextMenu` 设过菜单，就直接弹那份旧菜单，**不再发
 * `right-click` 事件**（`shell/browser/ui/win/notify_icon.cc` 的
 * `HandleClickEvent`：有 `menu_model_` 走 `PopUpContextMenu`，没有才
 * `NotifyRightClicked`）。在 win32 上调一次 `setContextMenu`，这里的
 * 现场查询就再也不会被触发 —— 菜单停在那一刻，「运行中」不再刷新，
 * 而且不报任何错。`rebuildMenu` 开头的 win32 判断守的就是这一条。
 *
 * 其他平台右键事件不可靠（macOS 的托盘菜单是系统自己弹的），退回
 * `setContextMenu`，靠几路信号做防抖重建：界面报上来的最近对话变了、
 * `projectManager` 的工程连接变了、项目库变了、语言变了；不做定时轮询 ——
 * 没信号的变化（盘上文件没了、没装插件的工程被 UE 打开改写了 ini）等
 * 下一次信号驱动的重建自然会读到；定时器则不管托盘用没用过，都在
 * 主线程上周期性跑同步 ini 读取 / 查库 / existsSync。
 *
 * ## 点了菜单项之后
 *
 * 菜单项本身只会把主窗口叫到前台、把动作存进 `pending`，再发一句不带
 * 负载的 `tray:action` 提醒 —— 界面走 `tray:take-pending` 取走本体
 * （取走即清）再处理，这是唯一的送达路径。跳到那条对话、开新对话、
 * 弹插件失败框全是界面的事（`layout/composables/trayBridge.ts`）。
 */
import { app, dialog, ipcMain, Menu, Notification, Tray } from 'electron'
import { existsSync } from 'fs'

import {
  TRAY_ACTION_CHANNEL,
  TRAY_CONFIRM_QUIT_CHANNEL,
  TRAY_PENDING_TTL_MS,
  TRAY_SET_RECENT_SESSIONS_CHANNEL,
  TRAY_TAKE_PENDING_CHANNEL,
  type TrayAction,
  type TrayRecentSession
} from '../../shared/trayActions'
import { findMainWindow, sendToWindow } from '../appWindows'
import { mt, onLanguageChanged } from '../i18n'
import { getRecentProjectsFromAllEngines } from '../ipc/epicProjects'
import { openUprojectFile } from '../services/project/openUproject'
import { onProjectLibraryChanged } from '../services/project/projectLibraryEvents'
import { projectManager } from '../services/project/projectManager'
import { logger } from '../services'
import { getPublicDatabase } from '../sqliteDataBase'
import { getProjectByPath } from '../sqliteDataBase/models/project'
import UnrealProcessDetector from '../utils/UnrealProcessDetector'

import { createLaunchTracker, withProjectState } from './launchTracker'
import { trayOpenOutcome } from './openOutcome'
import { createTrayProjectOpener } from './openTrayProject'
import { createPendingSlot } from './pendingSlot'
import {
  getTrayRecentCandidates,
  runningProjectKeys,
  type RunningProjectsDeps,
  type TrayProjectCandidate
} from './recentProjects'
import { sanitizeTrayRecentSessions } from './recentSessions'
import { confirmTrayQuit, setQuitGuard, type GuardedQuitReason } from './quitGuard'
import { buildTrayMenuTemplate, type TrayRecentProject } from './trayMenu'
import { createTtlCache } from './ttlCache'

export interface TrayControllerDeps {
  /**
   * 托盘「打开虚幻盒子」和非 darwin 左键共用的那个动作，含「窗口没了就地重建」
   * —— `createWindow` 是 index.ts 的局部函数，反向 import 会绕成环，只能注入
   */
  showMainWindow: () => void
  /** 退出前要看还有几项会话操作没收摊（`countActiveSessionOperations`，index 侧注入） */
  countActiveOperations: () => number
}

/**
 * 「候选名单」缓存：这一整段 IO（ini + 查库 + existsSync）摊进十秒一份 ——
 * 原来只有 ini 走缓存，查库的全表 SELECT / realpath 和 existsSync 每趟
 * 右键照跑，掉线的网络盘能把主进程卡上几秒。已知的变更（项目库动过、
 * 工程连接变了）直接作废它；没人通知的变化（盘上文件没了、ini 历史被
 * 别处改写）在 win32 由下一次右键现建兜底；其他平台不轮询，下一次
 * 信号驱动的重建自然会读到。「运行中」不在这份缓存里，每次建菜单现算。
 */
const RECENT_CANDIDATES_TTL_MS = 10_000

/**
 * 「查库 + 问插件谁在跑」这一组依赖：建菜单和点开旧菜单时的复查是同一份。
 * 抽成工厂是因为 `getPublicDatabase()` 抛错的含义两边不一样 ——
 * 建菜单是「这一组当空的」，复查是「按没跑放行」，各包各的 try。
 */
function projectQueryDeps(): RunningProjectsDeps {
  const db = getPublicDatabase()
  return {
    findRecord: (dir) => getProjectByPath(db, dir),
    interactiveProjectPaths: () =>
      projectManager.getInteractiveProjects().map((project) => project.projectPath)
  }
}

/** 非 win32 平台的菜单重建做 200ms 防抖 —— 工程连接变化是一串一串来的 */
const REBUILD_DEBOUNCE_MS = 200

/**
 * 退出确认先交给界面弹应用内的确认框；过了这么久还没被取走（窗口在重建、
 * 渲染进程卡死），退回系统原生框 —— Windows 上托盘「退出」几乎是唯一的退出入口，
 * 不能因为界面没响应就退不掉
 */
const QUIT_CONFIRM_PICKUP_MS = 8_000

/** 把托盘菜单挂到 `tray` 上。只调一次（托盘本来就只建一次）。 */
export function startTrayMenuController(tray: Tray, deps: TrayControllerDeps): void {
  /** 界面最近一次报上来的「最近对话」前三条 */
  let recentSessions: TrayRecentSession[] = []

  /** 还没送到界面手里的那条托盘动作。取走即清，理由见文件头 */
  const pendingSlot = createPendingSlot<TrayAction>({ ttlMs: TRAY_PENDING_TTL_MS })

  /*
   * 点了「最近项目」到插件连上来之间的过渡期。引擎起来要几十秒，这期间
   * `projectManager` 还报不出 running —— 不记一笔的话菜单那条还是活的，
   * 双击就是第二个编辑器进程。「等连接」的计时标记由 `withProjectState`
   * 在看到 running 时摘掉，或由 TTL 兜底。
   */
  const launchTracker = createLaunchTracker()

  const recentCandidatesCache = createTtlCache<TrayProjectCandidate[]>({
    ttlMs: RECENT_CANDIDATES_TTL_MS
  })

  /*
   * 还没落定的托盘通知。
   *
   * Windows 上 Electron 会把局部 `Notification` 提前 GC 掉 —— 用户点下去时
   * `click` 已经没人接了，通知等于白弹。所以从 `show()` 到 click / close /
   * failed 任一落定之前都得拿强引用钉着，和 agentNotifications 的 `live`
   * 同一个理由（见 `services/agentNotifications/index.ts`）。
   */
  const liveNotifications = new Set<Notification>()

  /** 「最近项目」候选名单走十秒缓存；查失败不拖垮整个菜单，这一组当空的处理 */
  async function loadRecentCandidates(): Promise<TrayProjectCandidate[]> {
    try {
      const queryDeps = projectQueryDeps()
      return await recentCandidatesCache.get(() =>
        getTrayRecentCandidates({
          listRecent: () => getRecentProjectsFromAllEngines(),
          findRecord: queryDeps.findRecord,
          fileExists: existsSync
        })
      )
    } catch (error) {
      logger.warn('[托盘] 取最近项目失败:', error)
      return []
    }
  }

  // 「运行中」不走候选缓存：菜单是弹出时刻的快照，每次建菜单现算
  function currentRunningKeys(): Set<string> {
    try {
      return runningProjectKeys(projectQueryDeps())
    } catch (error) {
      logger.warn('[托盘] 查运行状态失败:', error)
      return new Set()
    }
  }

  /*
   * 把一条动作送到界面：先把主窗口叫到前台，再存一份、发一句「来拿」。
   * 提醒是投出去就不管的，渲染进程没挂好就蒸发；存着的那份由界面收到
   * 提醒 / 挂上来时走 `tray:take-pending` 取走，取走即清。
   */
  function sendTrayAction(action: TrayAction): void {
    if (stopped) return
    deps.showMainWindow()
    pendingSlot.put(action)
    // sendToWindow 查的是窗口 + webContents 两个销毁标记：关窗过程中
    // webContents 先死、窗口还活着，单查窗口标记 send 照样抛（见 appWindows.ts）
    sendToWindow(findMainWindow(), TRAY_ACTION_CHANNEL)
  }

  /**
   * 弹系统通知。`onUnavailable` 是通知弹不出来时的退路（不传就和点了通知一样）——
   * 点通知只需把窗口叫回来，但通知压根没弹出来时，用户还没看到那句话
   */
  function showTrayNotification(
    title: string,
    body: string,
    onClick: () => void,
    onUnavailable: () => void = onClick
  ): void {
    if (stopped) return
    let activated = false
    const settle = (handler: () => void): void => {
      if (stopped || activated) return
      activated = true
      handler()
    }
    const activate = (): void => settle(onClick)
    const unavailable = (): void => settle(onUnavailable)

    if (!Notification.isSupported()) {
      // 系统连通知都没有：别让用户点了菜单什么都没发生
      unavailable()
      return
    }

    let notification: Notification
    try {
      notification = new Notification({ title, body })
    } catch (error) {
      logger.warn('[托盘] 建系统通知失败:', error)
      unavailable()
      return
    }
    const release = (): void => {
      liveNotifications.delete(notification)
    }
    notification.on('click', () => {
      release()
      activate()
    })
    notification.on('close', release)
    // native 通知造不出来/弹不出来。不释放的话这条就永远钉在表里
    notification.on('failed', (_event, error) => {
      release()
      logger.warn('[托盘] 系统通知弹不出来:', error)
      unavailable()
    })
    liveNotifications.add(notification)
    try {
      notification.show()
    } catch (error) {
      release()
      logger.warn('[托盘] 弹系统通知失败:', error)
      unavailable()
    }
  }

  let stopped = false
  let buildSeq = 0

  let rebuildTimer: NodeJS.Timeout | null = null
  const scheduleRebuild = (): void => {
    if (process.platform === 'win32' || stopped) return // win32 右键时现建，见文件头
    if (rebuildTimer) clearTimeout(rebuildTimer)
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null
      void rebuildMenu()
    }, REBUILD_DEBOUNCE_MS)
  }
  const rebuildMenu = async (): Promise<void> => {
    if (process.platform === 'win32' || stopped) return // win32 右键时现建，见文件头
    const seq = ++buildSeq
    try {
      const menu = await buildMenu()
      if (stopped || seq !== buildSeq) return
      tray.setContextMenu(menu)
      scheduleLaunchRevert()
    } catch (error) {
      logger.warn('[托盘] 重建菜单失败:', error)
    }
  }

  /*
   * 「等引擎连上」到 TTL 要自己退回可点：常驻菜单在最近的到期时刻重建一次。
   * 只有一颗定时器，tracker.nextExpiryDelay 每次现算最近的到期点 ——
   * 正在进行的打开不排期（不吃 TTL），失败的打开不留旧定时器，
   * 多个等连接的工程取最早的那个。win32 右键时才现建菜单，不用排。
   */
  let launchRevertTimer: NodeJS.Timeout | null = null
  const scheduleLaunchRevert = (): void => {
    if (launchRevertTimer) clearTimeout(launchRevertTimer)
    launchRevertTimer = null
    if (process.platform === 'win32' || stopped) return
    const delay = launchTracker.nextExpiryDelay()
    if (delay !== null) {
      launchRevertTimer = setTimeout(() => {
        launchRevertTimer = null
        scheduleRebuild()
      }, delay)
    }
  }

  const onLaunchStateChanged = (): void => {
    scheduleRebuild()
    scheduleLaunchRevert()
  }

  const openTrayProject = createTrayProjectOpener({
    tracker: launchTracker,
    // 菜单是弹出时刻的快照：挂着期间工程可能被别处拉起来，
    // 点下去现查一遍 running。查不出来按没跑放行 —— 真开不成，
    // 后面还有打开失败的通知兜着
    isRunning: (projectKey) => {
      try {
        return runningProjectKeys(projectQueryDeps()).has(projectKey)
      } catch (error) {
        logger.warn('[托盘] 复查运行状态失败:', error)
        return false
      }
    },
    // 「运行中」只认连上盒子的工程：没装插件的那份编辑器盒子看不见，
    // 不查进程的话「启动中」一过期再点就是第二个编辑器。只在点下去时查 —— 枚举进程不便宜
    openFile: async (path) => {
      const running = await UnrealProcessDetector.findRunningProjectByPath(path).catch(() => null)
      return running ? { success: true, alreadyRunning: true } : openUprojectFile(path)
    },
    report: (result, project) => {
      const outcome = trayOpenOutcome(result, project, mt)
      if (!outcome) return
      // 带动作的派给界面；不带的通知本身已经把话说完，点了只把窗口叫回来 ——
      // 通知弹不出来时才让界面把这句话弹出来
      const { action, title, body } = outcome
      showTrayNotification(
        title,
        body,
        action ? () => sendTrayAction(action) : () => deps.showMainWindow(),
        action ? undefined : () => sendTrayAction({ type: 'open-failed', title, body })
      )
    },
    onStateChanged: onLaunchStateChanged
  })

  /*
   * 退出确认：先交给界面弹应用里统一的确认框（确认了回 `tray:confirm-quit`）。
   * 到点还没被取走就说明界面接不住，退回系统原生框。界面那边自己防叠框；
   * 原生框这边也只留一个。
   *
   * 托盘以外的退出（安装更新、`app-quit`）经 `requestGuardedQuit` 也落到这里，
   * 确认之后该怎么退由发起方给（`proceed`）。只记最近一次 —— 框开着时又来一条，
   * 界面不叠框，确认的就是后来那条；两条反正都是退出
   */
  let nativeQuitDialogOpen = false
  let confirmedQuit: () => void = () => quit()
  function askQuitConfirm(count: number, reason: GuardedQuitReason, proceed: () => void): void {
    confirmedQuit = proceed
    const action: TrayAction =
      reason === 'update'
        ? { type: 'confirm-quit', count, reason }
        : { type: 'confirm-quit', count }
    sendTrayAction(action)
    setTimeout(() => {
      if (stopped || nativeQuitDialogOpen || !pendingSlot.discard(action)) return
      logger.warn('[托盘] 界面没接住退出确认，改用系统确认框')
      nativeQuitDialogOpen = true
      dialog
        .showMessageBox({
          type: 'warning',
          message: mt('tray.quitConfirm', { count }),
          buttons: [
            mt(reason === 'update' ? 'tray.updateConfirmOk' : 'tray.quitConfirmOk'),
            mt('tray.quitConfirmCancel')
          ],
          // 「仍然退出」是 0 号，但默认和取消都指到 1 号 —— 拍空格、按 Esc 都是取消
          defaultId: 1,
          cancelId: 1,
          noLink: true
        })
        .then(({ response }) => {
          if (response === 0 && !stopped) proceed()
        })
        .catch((error: unknown) => {
          // 框防的是「顺手退出」；框都弹不出来时把用户明确的退出也拦下更糟
          logger.warn('[托盘] 退出确认框弹不出来，按用户意图直接退出:', error)
          if (!stopped) proceed()
        })
        .finally(() => {
          nativeQuitDialogOpen = false
        })
    }, QUIT_CONFIRM_PICKUP_MS)
  }

  /** 要不要问、怎么问：托盘自己的「退出」和 `requestGuardedQuit` 进来的共用 */
  function guardQuit(proceed: () => void, reason: GuardedQuitReason): void {
    try {
      confirmTrayQuit({
        countActiveOperations: deps.countActiveOperations,
        askConfirm: (count) => askQuitConfirm(count, reason, proceed),
        quit: proceed
      })
    } catch (error) {
      logger.warn('[托盘] 退出确认失败:', error)
    }
  }
  setQuitGuard(guardQuit)

  // __forceQuit__ 不用在这里置：app.quit() 先触发 before-quit，index.ts 在那里设上
  const quit = (): void => {
    if (!stopped) app.quit()
  }

  const handlers = {
    openMainWindow: () => deps.showMainWindow(),
    newSession: () => sendTrayAction({ type: 'new-session' }),
    openSession: (sessionId: string) => sendTrayAction({ type: 'open-session', sessionId }),
    // 打开失败在函数里已经转成通知；真抛出来（通知 / 拉窗口挂了）也不能是
    // 没人管的 rejection —— 和下面 quit 一个待遇，记一行
    openProject: (project: TrayRecentProject) => {
      if (stopped) return
      void openTrayProject(project).catch((error) => logger.warn('[托盘] 打开最近工程失败:', error))
    },
    quit: () => guardQuit(quit, 'quit')
  }

  const buildMenu = async (): Promise<Menu> =>
    Menu.buildFromTemplate(
      buildTrayMenuTemplate(
        {
          recentSessions,
          // 「运行中 / 启动中」不是名单的属性，是建菜单那一刻叠上去的瞬时状态
          recentProjects: withProjectState(
            await loadRecentCandidates(),
            currentRunningKeys(),
            launchTracker
          )
        },
        handlers,
        mt
      )
    )

  const onTrayRightClick = (): void => {
    if (stopped) return
    const seq = ++buildSeq
    void buildMenu()
      .then((menu) => {
        if (stopped || seq !== buildSeq) return
        tray.popUpContextMenu(menu)
      })
      .catch((error) => logger.warn('[托盘] 弹出菜单失败:', error))
  }

  // 悬停提示和菜单一样是一次性交给操作系统的，语言变了要重设
  tray.setToolTip(mt('tray.tooltip'))
  if (process.platform === 'win32') {
    tray.on('right-click', onTrayRightClick)
  } else {
    void rebuildMenu()
  }

  onLanguageChanged(() => {
    if (stopped) return
    tray.setToolTip(mt('tray.tooltip'))
    scheduleRebuild()
  })

  const unsubscribeLibraryChanged = onProjectLibraryChanged(() => {
    recentCandidatesCache.invalidate()
    scheduleRebuild()
  })
  const unsubscribeProjectsChanged = projectManager.onProjectsChanged(() => {
    recentCandidatesCache.invalidate()
    scheduleRebuild()
  })

  app.once('will-quit', () => {
    stopped = true
    setQuitGuard(null)
    if (rebuildTimer) clearTimeout(rebuildTimer)
    if (launchRevertTimer) clearTimeout(launchRevertTimer)
    unsubscribeLibraryChanged()
    unsubscribeProjectsChanged()
  })

  // 界面报「最近对话」变了
  ipcMain.handle(TRAY_SET_RECENT_SESSIONS_CHANNEL, (_event, payload: unknown) => {
    recentSessions = sanitizeTrayRecentSessions(payload)
    scheduleRebuild()
    return { success: true }
  })

  /*
   * 唯一的送达路径：取走即清。`tray:action` 提醒和挂载补取可能各来
   * 一次，主进程串行处理 handle，第二次取到的是 null。
   */
  ipcMain.handle(TRAY_TAKE_PENDING_CHANNEL, () => pendingSlot.take())

  // 界面的确认框里选了「仍然退出」：按发起方给的路退（托盘是 app.quit，更新是装包重启）
  ipcMain.handle(TRAY_CONFIRM_QUIT_CHANNEL, () => {
    if (!stopped) confirmedQuit()
    return { success: true }
  })
}
