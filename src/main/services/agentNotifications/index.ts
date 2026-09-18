/**
 * 把 agent 的运行状态变成系统通知。
 *
 * ## 为什么需要它
 *
 * 盒子干的是长活，用户派完就切回虚幻里接着做自己的事。而这套 agent 有两处
 * **会停下来等人**：审批（超时五分钟按拒绝算）和反问（不设超时，一直等）。
 * 用户不在屏幕前的时候，这两件事都没有任何外部表现 —— 他回来看到的是
 * 「agent 卡住不动」或者「这一步被拒绝了」，而他从头到尾没被问过。
 *
 * ## 为什么挂在 runObserver 上
 *
 * `host/runObserver.ts` 已经把「值得别人知道的事」收敛成一组信号了（语音前台
 * 是第一个订户）。通知是第二个订户，没有理由再从 agent 核心里拉一条新线出来 ——
 * agent-v3 不该知道有「通知」这回事，正如它不该知道有语音。
 *
 * 判定逻辑在 `decide.ts`（纯函数，可测），这里只负责它测不了的那部分：
 * 读设置、问窗口焦点、造 Electron 通知、点开跳回窗口。
 */

import { ipcMain, Notification } from 'electron'
import type { BrowserWindow } from 'electron'

import {
  NOTIFICATION_ACTIVATE_CHANNEL,
  NOTIFICATION_ACTIVATION_RESULT_CHANNEL,
  NOTIFICATION_PENDING_TTL_MS,
  NOTIFICATION_TAKE_PENDING_CHANNEL,
  type NotificationActivatePayload,
  type NotificationActivationResult
} from '../../../shared/agentNotificationActivation'
import { observeAgentRuns } from '../../agent-v3/host/runObserver'
import { runOwnerWebContentsId } from '../../agent-v3/host/runOwners'
import { findMainWindow, getAppWindows } from '../../appWindows'
import { appSettingsManager } from '../../appSettingsManager'
import { showOrCreateMainWindow } from '../../mainWindowLifecycle'

import { decideNotification, settledKey, TextBuffer, type NotificationPrefs } from './decide'

/**
 * 还挂在通知中心里的那些，按 `key` 存着好收掉。
 *
 * 收掉这件事是必须的：用户在界面上点完了审批，右下角还留着一条
 * 「等你点头」——他会再点一次，跳回来发现没有东西可点。
 */
const live = new Map<string, Notification>()

/** 盒子自己的窗口有没有一个在前台。MiniChat 也算 —— 用户在那儿就是在盒子里 */
function isAnyAppWindowFocused(): boolean {
  return getAppWindows().some((window) => !window.isDestroyed() && window.isFocused())
}

function readPrefs(): NotificationPrefs {
  return {
    turnComplete: appSettingsManager.getNotifyTurnComplete(),
    approvalRequired: appSettingsManager.getNotifyApprovalRequired(),
    questionRequired: appSettingsManager.getNotifyQuestionRequired()
  }
}

/**
 * 还没送到界面手里的那条激活。
 *
 * 推送是投出去就不管的：`MainLayout` 没挂载的时候（`/404`、首启语言门、渲染
 * 进程正在重载、`app.mount` 还在等 `chatHistoryStorage.preload()`）那条消息直接
 * 蒸发，而通知已经被点掉了 —— 用户看到窗口弹出来停在原地，和这个功能没做一样。
 * 所以再存一份，界面挂上来自己来拿。同样的问题 MiniChat 早就是这么解的
 * （`miniChatManager` 的 `pendingMessage` + `mini-chat:request-initial-message`）。
 */
let pending: (NotificationActivatePayload & { at: number }) | null = null

/** 主窗口没了要怎么建回来。由 `startAgentNotifications` 注入，见那里的注释 */
let createMainWindow: () => void = () => {}

/**
 * 已经点开、还在等界面回话的那些，**按 `live` 的 key 存**（一条通知一格）。
 *
 * 主进程只能确认「窗口拉起来了」，认不认得这条会话是界面才知道的事
 * （MiniChat 建的会话主窗口就不认得）。所以点开之后先不收，等回话：
 * 认出来了才收，没认出来就重新弹一条。
 *
 * **存 `Notification` 本身，不是回头去 `live` 里查。** 回话到达时那个 key 多半
 * 已经不在 `live` 里了 —— 用户点下去系统就把 toast 摘走，`close` 事件跟着把
 * 表项删了。回头查等于查了个空，重弹会安静地什么都不做。
 *
 * **按通知存，不是按会话存。** 一条会话可以同时挂着两条通知（上一轮的
 * 「任务失败」还留在通知中心，这一轮又卡在审批上）。按会话认的话，后点的
 * 那条会把先点的顶掉，先点的既收不掉也重弹不出来。
 *
 * 带上时间戳是为了封顶：回话可能永远不来（界面把 IPC 的错咽掉了、渲染进程
 * 崩了、窗口关了），不清的话每一次这样的点击都在这儿钉住一个 Notification。
 */
const awaiting = new Map<string, { notification: Notification; at: number }>()

/** 记一条待回话的，顺手把过期的清掉。用和 `pending` 同一个时限 —— 都是「等界面」 */
function rememberAwaiting(key: string, notification: Notification): void {
  const now = Date.now()
  for (const [id, entry] of awaiting) {
    if (now - entry.at > NOTIFICATION_PENDING_TTL_MS) awaiting.delete(id)
  }
  awaiting.set(key, { notification, at: now })
}

/**
 * 这一下点开的结果。
 *
 * `awaiting-ui` 是「消息发给界面了，等它回话」；`done` 是「已经办完，没有下文」
 * （MiniChat 那种一个窗口一条会话的，拉到前台就是全部）；`failed` 是「一个窗口
 * 都拉不起来」。分三态而不是布尔：`done` 也当成要等回话的话，那条通知会永远
 * 挂在 `awaiting` 里等一个不会来的消息。
 */
type RevealOutcome = 'awaiting-ui' | 'done' | 'failed'

/** 拉到前台。最小化过要先还原，否则 `show()` 出来还是那个最小化的壳 */
function raise(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/** 发起这条会话的那个窗口。不是主窗口的话（MiniChat），拉的就该是它 */
function ownerWindow(sessionId: string): BrowserWindow | undefined {
  const webContentsId = runOwnerWebContentsId(sessionId)
  if (webContentsId === undefined) return undefined
  return getAppWindows().find(
    (window) => !window.isDestroyed() && window.webContents.id === webContentsId
  )
}

/**
 * 点通知 = 「我这就回来处理**这件事**」。
 *
 * 只把窗口拉到前台是不够的：用户回来看到的是他离开时那个页面（可能是素材库，
 * 也可能是另一条对话），而通知说的那条会话还在侧边栏里排着。他得自己想起来
 * 是哪一条、翻到它、点开 —— 通知等于只帮他按了一下任务栏。
 *
 * 所以除了拉窗口，还要告诉界面跳到哪条会话。带的是**内核**会话 id，
 * 界面那边按 `agentSessionId` 反查自己的那条（两个 id 的关系见 chatSessions store）。
 *
 * 返回这一下的结果，调用方据此决定收、等、还是重弹。审批和反问是挡着活的，
 * 收错了用户就再也找不回那张卡片了。
 */
function revealSession(payload: NotificationActivatePayload): RevealOutcome {
  /*
   * 会话是在别的窗口里跑的（MiniChat）：把那个窗口拉到前台就够了 —— 它一个
   * 窗口只有一条会话，没有「跳去哪」可言。
   *
   * 这条路**没有下文**：什么都没发出去，而 MiniChat 那种独立窗口根本不挂
   * `MainLayout`，不会有人回话。当成 `awaiting` 等下去的话，那条通知就永远
   * 收不掉了。
   */
  const owner = ownerWindow(payload.sessionId)
  if (owner && owner !== findMainWindow()) {
    raise(owner)
    return 'done'
  }

  // 窗口可能已经被关进托盘了（`window-all-closed` 是空实现，应用照跑）。
  // 这个 helper 会连带把它建回来 —— 自己写一遍 restore/show/focus 就会漏掉这一支
  const hadWindow = Boolean(findMainWindow())
  showOrCreateMainWindow(findMainWindow, createMainWindow)

  const mainWindow = findMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return 'failed'

  /*
   * 刚建出来的窗口是 `show: false` 的，helper 的「新建」分支只 `createWindow()`
   * 就返回了，不管显示。真正显示它的是 `createWindow` 里的 `ready-to-show` ——
   * 但那个回调在开机自启动（argv 带 `--hidden`）时直接 return，而那个判据是
   * 进程级常量，这个进程活多久它就为真多久。于是窗口永远不出来。
   *
   * 所以排在它**后面**再兜一手：它先按存下来的状态恢复（包括最大化），
   * 轮到我们时窗口已经该显示的显示了，只有它撒手不管的那一支才真的由我们拉起来。
   * 抢在它前面 `show()` 的话，它那句 `if (!isVisible())` 会把整段恢复跳过去。
   */
  if (!hadWindow) {
    mainWindow.once('ready-to-show', () => {
      if (!mainWindow.isDestroyed()) raise(mainWindow)
    })
  }

  /*
   * 只留最后点的那一条。
   *
   * 界面补跳的时候只能落到一个地方，存一串的话它会连跳几次，最后一次盖掉前面
   * 的，而前面那几条还会各自回一句「跳到了」—— 主进程据此收掉通知，可用户根本
   * 没在那儿。没送到的那几条不收也不重弹，就留在通知中心里，这是对的。
   */
  pending = { ...payload, at: Date.now() }
  mainWindow.webContents.send(NOTIFICATION_ACTIVATE_CHANNEL, payload)
  return 'awaiting-ui'
}

function dismiss(key: string): void {
  /*
   * 主动收掉了，就别再等它的回话。
   *
   * 不清这一下的话：审批超时落定 → `dismiss` 把它关了，可 `awaiting` 里还留着，
   * 晚到的一句「没认出来」会把它重新弹出来 —— 用户收到一条「等你点头」，
   * 而那次审批五分钟前就按拒绝算完了。
   *
   * **必须排在下面那个 early return 前面。** 这两张表不同步：用户点一下系统就把
   * toast 摘走并发 `close`，`live` 里那格随即没了，而这条通知还活着、还等着回话。
   * 放在后面的话，「点过、然后落定」这条最常见的路径根本走不到这一句。
   *
   * 也不能改挂在 `close` 上：那一下正是重弹要救的场面。只有主动收掉才算「不必再等」。
   */
  awaiting.delete(key)

  const existing = live.get(key)
  if (!existing) return
  live.delete(key)
  existing.close()
}

/**
 * 重新弹一条。
 *
 * 要把 `live` 里那格补回来：它在用户点下去那会儿就被 `close` 事件删掉了，
 * 不补的话这条通知从此收不掉 —— 审批落定时 `dismiss` 查无此人，那张
 * 「等你点头」会一直留在通知中心里，用户再点它也没有任何反应。
 */
function reshow(key: string, notification: Notification): void {
  live.set(key, notification)
  notification.show()
}

/**
 * 开始把运行状态变成通知。返回退订函数（测试和热重载用）。
 *
 * `createWindow` 是主窗口的建法：用户可以把窗口关进托盘让 agent 接着跑，
 * 那时点通知必须能把窗口建回来，否则这一下什么都不会发生。注入而不是直接
 * import，是因为它长在 `main/index.ts` 里，反向依赖会绕成一个环。
 *
 * 系统不支持通知时直接不订阅：`Notification.isSupported()` 为 false 的机器上
 * 造出来的通知不会报错，只是永远不显示 —— 那还不如省下这条旁路。
 */
export function startAgentNotifications(createWindow: () => void = () => {}): () => void {
  createMainWindow = createWindow

  /*
   * 界面挂上来时主动取一次。取走即清 —— 推送已经送到的那条会在界面那边
   * 顺手清掉，所以正常情况下这里返回 null，只有推送落空时才真的取到东西。
   */
  // 先摘再挂：`ipcMain.handle` 对已经注册过的通道是**抛异常**的，
  // 而这个函数的退订是给测试和热重载用的，重来一次不该把启动打崩
  ipcMain.removeHandler(NOTIFICATION_TAKE_PENDING_CHANNEL)
  ipcMain.handle(NOTIFICATION_TAKE_PENDING_CHANNEL, () => {
    const taken = pending
    pending = null
    if (!taken) return null
    if (Date.now() - taken.at > NOTIFICATION_PENDING_TTL_MS) return null
    return {
      notificationKey: taken.notificationKey,
      sessionId: taken.sessionId,
      toolCallId: taken.toolCallId
    }
  })

  /*
   * 界面回话：认出来了就收掉通知，没认出来就重新弹一条。
   *
   * 重弹不是多此一举 —— Windows 在用户点下去那一刻就把 toast 从通知中心
   * 摘走了（`click` 事件正是因此才发出来的）。不主动 `close()` 只是没有雪上
   * 加霜，救不回用户手上那个入口；只有再弹一条才救得回。
   */
  ipcMain.removeHandler(NOTIFICATION_ACTIVATION_RESULT_CHANNEL)
  ipcMain.handle(NOTIFICATION_ACTIVATION_RESULT_CHANNEL, (_event, result?: unknown) => {
    const report = result as NotificationActivationResult | undefined
    if (!report?.notificationKey) return
    const entry = awaiting.get(report.notificationKey)
    if (!entry) return
    awaiting.delete(report.notificationKey)

    // 收掉。`live` 那张表由 close 事件自己清（见下面注册的 close 处理）
    if (report.handled) {
      entry.notification.close()
      return
    }
    reshow(report.notificationKey, entry.notification)
  })

  if (!Notification.isSupported()) {
    console.info('[AgentNotifications] 系统不支持通知，已跳过')
    return () => {
      ipcMain.removeHandler(NOTIFICATION_TAKE_PENDING_CHANNEL)
      ipcMain.removeHandler(NOTIFICATION_ACTIVATION_RESULT_CHANNEL)
    }
  }

  const buffer = new TextBuffer()

  const unsubscribe = observeAgentRuns((signal) => {
    // 助手正文攒着，跑完当通知正文用。一条只写「完成了」的通知，
    // 用户还是得切回来才知道它到底干了什么
    if (signal.type === 'text') {
      buffer.append(signal.sessionId, signal.text)
      return
    }

    // 审批/反问落定了（用户点了、语音口头批了、整轮取消了）：收掉那条通知
    const settled = settledKey(signal)
    if (settled) {
      dismiss(settled)
      return
    }

    // 会话真的空出来了，攒的正文没有下一个用处了
    if (signal.type === 'released') {
      buffer.clear(signal.sessionId)
      return
    }

    const plan = decideNotification({
      signal,
      prefs: readPrefs(),
      windowFocused: isAnyAppWindowFocused(),
      text: buffer.take(signal.sessionId),
      language: appSettingsManager.getLanguage()
    })
    if (!plan) return

    // 同一个 key 重来一次（比如同一条会话连着跑两轮）：先收掉旧的，
    // 否则通知中心里会堆出一列内容过期的「任务完成」
    dismiss(plan.key)

    // 审批带上号，用户点了才能把他要答的那条挑到确认框上。
    // 反问不带：那张卡片长在时间线上、跟着会话走，跳到会话就已经到位了
    const toolCallId = signal.type === 'approval' ? signal.toolCallId : undefined

    const notification = new Notification({
      title: plan.title,
      body: plan.body,
      silent: plan.silent,
      // 挡着活的那两种（审批、反问）不自动消失：用户回来必须看见。
      // Windows / Linux 认这个字段，macOS 忽略它
      timeoutType: plan.requireInteraction ? 'never' : 'default'
    })
    notification.on('click', () => {
      /*
       * 点下去那一刻系统就把 toast 摘走了 —— `click` 正是因此才发出来的。
       * 所以「没跳成就别收」是不够的，救不回用户手上那个入口；跳不成必须**重弹**。
       * 审批尤其：它是 `timeoutType: 'never'` 特意钉住的，丢了就只能等五分钟
       * 超时按拒绝算，而用户从头到尾没被问过。
       */
      const outcome = revealSession({
        notificationKey: plan.key,
        sessionId: signal.sessionId,
        toolCallId
      })
      if (outcome === 'failed') {
        reshow(plan.key, notification)
        return
      }
      // 拉到那个窗口就是全部了（MiniChat），不会有回话，别等
      if (outcome === 'done') {
        dismiss(plan.key)
        return
      }
      /*
       * 窗口是拉起来了，但界面认不认得这条会话只有界面知道 —— MiniChat 建的
       * 会话主窗口就不认得。等它回话再决定收还是重弹（见上面那个 result 通道）。
       */
      rememberAwaiting(plan.key, notification)
    })
    notification.on('close', () => {
      // 用户自己划掉了。留在表里的话，下次 dismiss 会对一个已经没了的通知
      // 调 close()（无害但没意义），而且这张表会一直长
      if (live.get(plan.key) === notification) live.delete(plan.key)
    })

    live.set(plan.key, notification)
    notification.show()
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(NOTIFICATION_TAKE_PENDING_CHANNEL)
    ipcMain.removeHandler(NOTIFICATION_ACTIVATION_RESULT_CHANNEL)
    pending = null
    awaiting.clear()
    for (const key of [...live.keys()]) dismiss(key)
  }
}
