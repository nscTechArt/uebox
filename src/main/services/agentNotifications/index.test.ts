import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NOTIFICATION_ACTIVATE_CHANNEL } from '../../../shared/agentNotificationActivation'

/**
 * 点了通知之后主进程该做两件事：把窗口拉到前台，**并且**告诉界面跳哪条会话。
 *
 * 少了第二件，用户回来落在他离开时那个页面上 —— 通知等于只帮他按了下任务栏。
 */

interface FakeNotification {
  handlers: Map<string, () => void>
  on(event: string, handler: () => void): void
  // 重弹 / 收掉都要断言调用次数，所以是 spy 而不是普通方法
  show: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

/**
 * `vi.mock` 的工厂会被提到文件最前面，直接闭包模块作用域的 `const` 是踩着
 * 暂时性死区过的 —— 现在只因为下面两个 import 是动态的才没炸。`vi.hoisted`
 * 跟着一起提升，谁把 import 改回静态都不会把整个文件变成 ReferenceError。
 */
const { created, ipcHandlers } = vi.hoisted(() => ({
  created: [] as FakeNotification[],
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => {
  class Notification {
    handlers = new Map<string, () => void>()
    constructor() {
      created.push(this as unknown as FakeNotification)
    }
    static isSupported = (): boolean => true
    on(event: string, handler: () => void): void {
      this.handlers.set(event, handler)
    }
    // 用例只关心「点了之后干什么」，弹和收本身没有可断言的东西
    show = vi.fn()
    close = vi.fn()
  }
  return {
    Notification,
    ipcMain: {
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
        ipcHandlers.set(channel, listener)
      },
      removeHandler: (channel: string) => {
        ipcHandlers.delete(channel)
      }
    }
  }
})

const send = vi.fn()
const mainWindow = {
  isDestroyed: () => false,
  isMinimized: () => false,
  // 窗口在前台就不弹通知 —— 用例里一律当作用户已经切走了
  isFocused: () => false,
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  /** 新建窗口那一支会挂 ready-to-show，存下来好在用例里手动触发 */
  once: vi.fn((event: string, handler: () => void) => {
    if (event === 'ready-to-show') readyToShow = handler
  }),
  webContents: { id: 1, send }
}

let readyToShow: (() => void) | null = null

/** 主窗口还在不在。托盘那一支要靠它 */
let mainWindowAlive = true

/** 主窗口之外还开着的盒子窗口（MiniChat 那种） */
const otherWindows: (typeof mainWindow)[] = []

vi.mock('../../appWindows', () => ({
  findMainWindow: () => (mainWindowAlive ? mainWindow : undefined),
  getAppWindows: () => [...(mainWindowAlive ? [mainWindow] : []), ...otherWindows]
}))

const createWindow = vi.fn(() => {
  mainWindowAlive = true
})

/*
 * 照抄真实实现的形状 —— 关键在「新建」那一支**只建不显示**（真的那个也是
 * `createWindow(); return`）。桩里顺手 show 一下的话，「新窗口可能永远不出来」
 * 这个洞在用例里就不成立了。
 */
vi.mock('../../mainWindowLifecycle', () => ({
  showOrCreateMainWindow: (find: () => unknown, create: () => void) => {
    const window = find() as typeof mainWindow | undefined
    if (!window) {
      create()
      return
    }
    window.show()
    window.focus()
  }
}))

vi.mock('../../appSettingsManager', () => ({
  appSettingsManager: {
    getNotifyTurnComplete: () => 'unfocused',
    getNotifyApprovalRequired: () => true,
    getNotifyQuestionRequired: () => true,
    getLanguage: () => 'zh-CN'
  }
}))

const { notifyAgentRun } = await import('../../agent-v3/host/runObserver')
const { rememberRunOwner, resetRunOwnersForTest } = await import('../../agent-v3/host/runOwners')
const { startAgentNotifications } = await import('./index')
const { NOTIFICATION_ACTIVATION_RESULT_CHANNEL, NOTIFICATION_TAKE_PENDING_CHANNEL } = await import(
  '../../../shared/agentNotificationActivation'
)

/** 界面回话：这条激活认没认出来。带的是通知的 key，不是会话号 */
function reportActivation(notificationKey: string, handled: boolean): void {
  ipcHandlers.get(NOTIFICATION_ACTIVATION_RESULT_CHANNEL)?.({}, { notificationKey, handled })
}

/**
 * 用户点一下 —— 系统在同一刻就把 toast 从通知中心摘走了，`close` 跟着发。
 *
 * 只调 click 不发 close 的话，`live` 里那格还在，而真机上它这会儿已经没了。
 * 这一带的 bug 全长在「两张表不同步」上，桩少发一个事件就全测不出来。
 */
function clickAndRetire(notification: FakeNotification): void {
  notification.handlers.get('click')?.()
  notification.handlers.get('close')?.()
}

let stop: () => void = () => {}

beforeEach(() => {
  created.length = 0
  send.mockClear()
  mainWindow.show.mockClear()
  mainWindow.focus.mockClear()
  createWindow.mockClear()
  mainWindow.once.mockClear()
  readyToShow = null
  mainWindowAlive = true
  otherWindows.length = 0
  resetRunOwnersForTest()
  stop = startAgentNotifications(createWindow)
})

afterEach(() => {
  stop()
})

describe('点通知', () => {
  it('把窗口拉到前台，并把发通知的那条会话告诉界面', () => {
    notifyAgentRun({ type: 'done', sessionId: 'agent-session-7' })
    expect(created).toHaveLength(1)

    created[0].handlers.get('click')?.()

    expect(mainWindow.show).toHaveBeenCalled()
    expect(mainWindow.focus).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(NOTIFICATION_ACTIVATE_CHANNEL, {
      notificationKey: 'turn:agent-session-7',
      sessionId: 'agent-session-7',
      toolCallId: undefined
    })
  })

  it('审批这类挡着活的通知带上审批号 —— 确认框要显示的是他来答的那一条', () => {
    notifyAgentRun({
      type: 'approval',
      sessionId: 'agent-session-9',
      toolCallId: 'call-1',
      toolName: 'delete_asset',
      risk: 'destructive',
      allowAlways: false
    })

    created[0].handlers.get('click')?.()

    expect(send).toHaveBeenCalledWith(NOTIFICATION_ACTIVATE_CHANNEL, {
      notificationKey: 'approval:agent-session-9:call-1',
      sessionId: 'agent-session-9',
      toolCallId: 'call-1'
    })
  })

  // 反问的卡片长在时间线上、跟着会话走，跳到会话就到位了。塞个号进来只会让
  // 读代码的人以为界面拿它做了什么，而待审批队列里根本不会有这个号
  it('反问不带审批号', () => {
    notifyAgentRun({
      type: 'question',
      sessionId: 'agent-session-q',
      toolCallId: 'call-q',
      questions: [{ header: '选材质', question: '用哪个？', multiSelect: false, options: [] }]
    })

    created[0].handlers.get('click')?.()

    expect(send).toHaveBeenCalledWith(NOTIFICATION_ACTIVATE_CHANNEL, {
      notificationKey: 'question:agent-session-q:call-q',
      sessionId: 'agent-session-q',
      toolCallId: undefined
    })
  })

  // 关进托盘之后 agent 照样在跑，通知照样会弹。这时点它必须能把窗口建回来，
  // 否则这一下什么都不会发生
  it('窗口关进托盘了就把它建回来，不是默默什么都不做', () => {
    notifyAgentRun({ type: 'done', sessionId: 'agent-session-7' })
    mainWindowAlive = false

    created[0].handlers.get('click')?.()

    expect(createWindow).toHaveBeenCalled()
  })

  /*
   * 新建的窗口先由 createWindow 里的 ready-to-show 按存下来的状态恢复
   * （含最大化）。抢在它前面 show() 会让它那句 `if (!isVisible())` 把整段
   * 恢复跳过去 —— 用户的最大化状态就丢了。
   */
  it('新建的窗口排在 ready-to-show 后面再拉，不抢在前面 show', () => {
    notifyAgentRun({ type: 'done', sessionId: 'agent-session-7' })
    mainWindowAlive = false
    mainWindow.show.mockClear()

    created[0].handlers.get('click')?.()
    expect(mainWindow.show).not.toHaveBeenCalled()

    readyToShow?.()
    expect(mainWindow.show).toHaveBeenCalled()
  })

  /*
   * 审批超时落定 → dismiss 把通知关了。这时 awaiting 里要是还留着它，
   * 晚到的一句「没认出来」会把它重新弹出来 —— 用户收到一条「等你点头」，
   * 而那次审批早就按拒绝算完了。
   */
  it('主动收掉之后，晚到的回话不会再把它弹出来', () => {
    notifyAgentRun({
      type: 'approval',
      sessionId: 'agent-session-9',
      toolCallId: 'call-1',
      toolName: 'delete_asset',
      risk: 'destructive',
      allowAlways: false
    })
    clickAndRetire(created[0])

    // 审批超时/被别处答掉了
    notifyAgentRun({ type: 'approval-settled', sessionId: 'agent-session-9', toolCallId: 'call-1' })
    created[0].show.mockClear()

    reportActivation('approval:agent-session-9:call-1', false)

    expect(created[0].show).not.toHaveBeenCalled()
  })

  /*
   * 重弹出来的那条还得能收掉。
   *
   * `live` 里那格在用户点下去时就被 close 事件删了，重弹不补回来的话，
   * 审批落定时 `dismiss` 查无此人 —— 那张「等你点头」会一直留在通知中心，
   * 而它对应的审批早就没了。
   */
  it('重弹出来的通知，落定时照样收得掉', () => {
    notifyAgentRun({
      type: 'approval',
      sessionId: 'agent-session-9',
      toolCallId: 'call-1',
      toolName: 'delete_asset',
      risk: 'destructive',
      allowAlways: false
    })
    clickAndRetire(created[0])

    // 界面没认出来 → 重弹
    reportActivation('approval:agent-session-9:call-1', false)
    expect(created[0].show).toHaveBeenCalled()

    // 然后这次审批落定了
    notifyAgentRun({ type: 'approval-settled', sessionId: 'agent-session-9', toolCallId: 'call-1' })

    expect(created[0].close).toHaveBeenCalled()
  })

  /*
   * `ready-to-show` 在开机自启动（argv 带 `--hidden`）那一支会直接 return，
   * 窗口就永远不出来了。所以还是得自己兜一手，只是要排在它后面 —— 见上一条。
   */
  it('ready-to-show 撒手不管时，兜底那一手把窗口拉起来', () => {
    notifyAgentRun({ type: 'done', sessionId: 'agent-session-7' })
    mainWindowAlive = false
    mainWindow.show.mockClear()
    mainWindow.focus.mockClear()

    created[0].handlers.get('click')?.()
    readyToShow?.()

    expect(mainWindow.show).toHaveBeenCalled()
    expect(mainWindow.focus).toHaveBeenCalled()
  })

  /*
   * 系统在用户点下去那一刻就把 toast 摘走了。所以「跳不成」不能只是不收 ——
   * 那救不回任何东西 —— 必须重新弹一条，否则审批五分钟后按拒绝算。
   */
  it('一个窗口都拉不起来就把通知重新弹一条', () => {
    notifyAgentRun({
      type: 'approval',
      sessionId: 'agent-session-9',
      toolCallId: 'call-1',
      toolName: 'delete_asset',
      risk: 'destructive',
      allowAlways: false
    })
    created[0].show.mockClear()
    // 窗口没了，而且建不回来
    mainWindowAlive = false
    createWindow.mockImplementationOnce(() => {})

    created[0].handlers.get('click')?.()

    expect(created[0].show).toHaveBeenCalled()
    expect(created[0].close).not.toHaveBeenCalled()
  })

  it('界面说认出来了才收掉通知', () => {
    notifyAgentRun({ type: 'done', sessionId: 'agent-session-7' })

    created[0].handlers.get('click')?.()
    // 还没回话，先不收 —— 认不认得这条会话只有界面知道
    expect(created[0].close).not.toHaveBeenCalled()

    reportActivation('turn:agent-session-7', true)
    expect(created[0].close).toHaveBeenCalled()
  })

  /*
   * MiniChat 建的会话主窗口不认得（跨窗口只同步了标题和气泡）。窗口拉起来了
   * 也没用，通知得重新弹一条，不能就这么没了。
   */
  it('界面说没认出来就把通知重新弹一条', () => {
    notifyAgentRun({ type: 'done', sessionId: 'agent-session-7' })
    created[0].handlers.get('click')?.()
    created[0].show.mockClear()

    reportActivation('turn:agent-session-7', false)

    expect(created[0].show).toHaveBeenCalled()
    expect(created[0].close).not.toHaveBeenCalled()
  })

  /*
   * 用户点下去系统就把 toast 摘走了，`close` 事件跟着把 live 表项删掉。
   * 重弹要是靠回头去 live 里按 key 查，这时候查到的是空 —— 安静地什么都不做。
   */
  it('close 事件先到也照样重弹得出来', () => {
    notifyAgentRun({ type: 'done', sessionId: 'agent-session-7' })
    created[0].handlers.get('click')?.()
    // 系统把 toast 摘走了
    created[0].handlers.get('close')?.()
    created[0].show.mockClear()

    reportActivation('turn:agent-session-7', false)

    expect(created[0].show).toHaveBeenCalled()
  })

  /*
   * **同一条会话**也能同时挂着两条通知：上一轮的「任务失败」还留在通知中心，
   * 这一轮又卡在审批上。按会话认的话，后点的会把先点的顶掉，先点的那条既
   * 收不掉也重弹不出来 —— 所以要按通知的 key 认。
   */
  it('同一条会话的两条通知各归各的', () => {
    notifyAgentRun({ type: 'error', sessionId: 'agent-session-7', message: '炸了' })
    notifyAgentRun({
      type: 'approval',
      sessionId: 'agent-session-7',
      toolCallId: 'call-1',
      toolName: 'delete_asset',
      risk: 'destructive',
      allowAlways: false
    })
    const [turnNotif, approvalNotif] = created

    turnNotif.handlers.get('click')?.()
    approvalNotif.handlers.get('click')?.()

    // 后点的那条不该把先点的挤掉
    turnNotif.show.mockClear()
    reportActivation('turn:agent-session-7', false)
    expect(turnNotif.show).toHaveBeenCalled()

    reportActivation('approval:agent-session-7:call-1', true)
    expect(approvalNotif.close).toHaveBeenCalled()
  })

  /*
   * 连着点两条：单槽的话第一条的回话会因为对不上被丢掉，那条通知既不收
   * 也不重弹。按通知存就各归各的。
   */
  it('连点两条通知，两条的回话各算各的', () => {
    notifyAgentRun({ type: 'done', sessionId: 'agent-session-a' })
    notifyAgentRun({ type: 'done', sessionId: 'agent-session-b' })
    const [first, second] = created

    first.handlers.get('click')?.()
    second.handlers.get('click')?.()

    reportActivation('turn:agent-session-a', true)
    expect(first.close).toHaveBeenCalled()

    second.show.mockClear()
    reportActivation('turn:agent-session-b', false)
    expect(second.show).toHaveBeenCalled()
  })

  // 退订是给测试和热重载用的，重来一次不该把启动打崩
  it('重复启动不炸 —— IPC 处理器先摘再挂', () => {
    expect(() => {
      const second = startAgentNotifications(createWindow)
      second()
    }).not.toThrow()
    expect(ipcHandlers.has(NOTIFICATION_TAKE_PENDING_CHANNEL)).toBe(false)
  })

  /*
   * MiniChat 是独立窗口，跑的是完整会话，但它的会话数据只活在它自己的渲染
   * 进程里。一律拉主窗口的话，用户点的审批按钮在小窗口里，弹出来的却是主窗口。
   */
  it('会话是别的窗口跑的就拉那个窗口，不给主窗口发跳转', () => {
    const miniChat = {
      ...mainWindow,
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { id: 42, send: vi.fn() }
    }
    otherWindows.push(miniChat)
    rememberRunOwner('agent-session-mini', 42)

    notifyAgentRun({ type: 'done', sessionId: 'agent-session-mini' })
    created[0].handlers.get('click')?.()

    expect(miniChat.focus).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    // 拉到那个窗口就是全部了，不会有人回话 —— 当场收掉，别挂在那儿等
    expect(created[0].close).toHaveBeenCalled()
  })
})
