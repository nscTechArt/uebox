/**
 * 闪存这条链上有几处「顺序对了才成立」的地方，断掉都**不会报错**：
 * 消息照发，模型照答，只是它看的是另一个时刻、甚至另一个工程的选区。
 *
 * 这类不变量没法靠单测一条条搭出来（要把整个助手页挂起来），但它们在源码里
 * 是看得见的形状。这里按 `agentV3.released.test.ts` 的路子盯住它们。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

const welcome = read('src/renderer/src/views/Assistant/Welcome.vue')
const chatFlow = read('src/renderer/src/views/Assistant/composables/useChatFlow.ts')
const miniChat = read('src/renderer/src/views/MiniChat/MiniChatWindow.vue')
const spotlight = read('src/main/spotlightManager.ts')
const agentV3Ipc = read('src/main/ipc/agentV3.ts')

describe('提交那一刻抓取', () => {
  /**
   * 抓取必须**先于**挂进提交链，而且不能 await。
   *
   * 反过来（先挂链再抓）的话，前一条的抓取要两秒，后一条就得两秒后才开始抓 ——
   * 抓到的已经不是它自己的发送时刻了，闪存的意义当场归零。
   */
  it('Welcome：抓取在挂进提交链之前发起，且没有 await', () => {
    const captureAt = welcome.indexOf('const capture = agentV3API.captureEditorSnapshot(')
    const enqueueAt = welcome.indexOf('enqueueSubmit(chatSid, async () => {')

    expect(captureAt).toBeGreaterThan(-1)
    expect(enqueueAt).toBeGreaterThan(-1)
    expect(captureAt).toBeLessThan(enqueueAt)
    // 抓取那一行前面不能有 await —— 有的话整条链又串行了
    expect(welcome).not.toContain('const capture = await agentV3API.captureEditorSnapshot(')
  })

  /**
   * 会话号要在抓取**之前**定死。
   *
   * 中间要 await 两秒，那期间用户完全可能切到别的对话去 —— 再读 `sid.value`
   * 就把这条话发到别人那儿了。
   */
  it('Welcome：chatSid 在抓取之前就定下来', () => {
    const sidAt = welcome.indexOf('const chatSid = sid.value')
    const captureAt = welcome.indexOf('const capture = agentV3API.captureEditorSnapshot(')

    expect(sidAt).toBeGreaterThan(-1)
    expect(sidAt).toBeLessThan(captureAt)
  })

  /**
   * 抓完要**重新判**一次忙不忙，而且判的是 `isBusy` 不是 `isGenerating`：
   * 这两秒里那一轮可能已经跑完（该直发却排了队），也可能刚发完 `done` 但后台
   * 还没释放（该排队却直发，会被顶回来）。
   */
  it('Welcome：排队/直发的判据是 isBusy，且在抓取之后', () => {
    const captureAt = welcome.indexOf('const capture = agentV3API.captureEditorSnapshot(')
    const decideAt = welcome.indexOf('if (agentStreamStore.isBusy(chatSid)) {', captureAt)

    expect(decideAt).toBeGreaterThan(captureAt)
    // 判定和入队之间不能有 await，否则中间又开了一道窗口
    const between = welcome.slice(decideAt, welcome.indexOf('enqueueFollowUp(', decideAt))
    expect(between).not.toContain('await')
  })

  /**
   * 「排队转插话」是三档不是两档。
   *
   * 中间那档（界面停了、后台还没放）必须什么都不做、留在队列里 —— 当新一轮
   * 发出去会被顶回来，而条目已经摘掉了，用户点了一下话就没了。
   */
  it('Welcome：排队转插话按 isBusy 分三档', () => {
    const handler = welcome.slice(
      welcome.indexOf('async function handleSteerQueuedFollowUp'),
      welcome.indexOf('async function handleComposerSteer')
    )

    // 按点下去那一刻所在的对话判、也按它摘 —— 插话要等上传，期间切走了 `sid` 就变了
    expect(handler).toContain('const chatSid = sid.value')
    expect(handler).toContain('agentStreamStore.isBusy(chatSid)')
    expect(handler).toContain('isGenerating.value')
    // 插话带的是**入队那一刻**的快照和图，不是现在的
    expect(handler).toContain('const queued = item.payload')
    // 用户真打的字，不是队列标签上那行（纯附件的条目标签是「（附件）」）
    expect(handler.replace(/\s+/g, ' ')).toContain(
      'steerAgent( queued.content, queued.editorSnapshot, queued.images, attachments, runningSessionId )'
    )
  })

  /** 插话注入的是正在跑的那一轮，快照必须来自它盯着的工程 */
  it('Welcome：插话抓取带 runningSessionId', () => {
    const handler = welcome.slice(welcome.indexOf('async function handleComposerSteer'))

    expect(handler.slice(0, 800)).toContain('runningSessionId')
  })

  /**
   * 插进哪一轮在开始等闪存之前就定下来：等的那一两秒里切了对话，`currentSessionId`
   * 就指向别人的那一轮了。插话没成时把输入框摘走的东西放回去。
   */
  it('Welcome：插话的目标在等之前定下，没插进去就放回输入框', () => {
    const handler = welcome.slice(welcome.indexOf('async function handleComposerSteer'))
    const body = handler.slice(0, handler.indexOf('\n}\n'))

    expect(body.indexOf('const runningSessionId')).toBeLessThan(body.indexOf('await '))
    expect(body.replace(/\s+/g, ' ')).toContain('payload.attachments, runningSessionId )')
    expect(body).toContain('if (!steered) payload.restore?.()')
  })

  /**
   * 从侧边栏工程 A 的「+」新建对话时，归属**还没进 store** —— 它只在路由参数
   * `?project=` 上，要等第一条消息发出去才由 `stampSessionProject` 盖戳。
   *
   * 只读会话戳的话这里拿到 null，于是按「当前连接」抓，抓到的是碰巧连着的 B，
   * 还把这一轮钉死在 B 上；稍后会话才被归入 A。用户从 A 下面点的「+」，
   * 第一句话却在 B 上执行 —— 而且全程不报错。
   */
  it('Welcome：会话还没盖戳时按路由上那个工程抓', () => {
    const submit = welcome.slice(
      welcome.indexOf('function handleComposerSend'),
      welcome.indexOf('enqueueSubmit(chatSid, async () => {')
    )

    expect(submit).toContain('pendingProjectName.value')
    // 抓取用的是算好的那份，不是直接读 store
    expect(submit).toContain('captureEditorSnapshot({\n    sessionProject,')
  })
})

describe('「键存在就是已定」这条规矩', () => {
  /**
   * 负载里有 `editorSnapshot` 键 = 提交那一刻已经定过了（排队投递、排队转直发、
   * Spotlight）。下游一律不许重抓 —— 重抓就是把用户当时指的东西换成现在的。
   */
  it('useChatFlow：有键就用，没键才抓', () => {
    expect(chatFlow).toContain("if (!('editorSnapshot' in payload))")
    expect(chatFlow).toContain('agentV3API.captureEditorSnapshot(')
  })

  /**
   * **闪存整条链不进界面。**
   *
   * 它是后台的潜规则：用户刚框选完，不需要每条消息下面再被告知一次「你当时选了
   * 什么」。哪天有人顺手把摘要接回气泡上，这条会红。
   */
  it('渲染层不把快照画到界面上', () => {
    for (const source of [welcome, chatFlow, miniChat]) {
      expect(source).not.toContain('setEditorSnapshot')
      expect(source).not.toContain('toEditorSnapshotSummary')
    }
  })

  it('MiniChat：Spotlight 递过来的当已提交用，不重抓', () => {
    const dispatch = miniChat.slice(
      miniChat.indexOf('async function dispatchUserMessage'),
      miniChat.indexOf('async function handleInitialMessage')
    )

    expect(dispatch).toContain('if (!submitted) {')
    expect(dispatch).toContain('agentV3API.captureEditorSnapshot(')
  })

  /**
   * 抓取要等最多 2 秒，而这期间小窗口还没进入生成态 —— 用户点得动标题栏那个「+」。
   *
   * 会话号不钉死的话，抓完再读 `SESSION_ID.value` 拿到的是**新**会话：
   * 用户刚清空，屏幕上却冒出一句他以为已经丢掉的话，还带着旧会话的上下文。
   */
  it('MiniChat：会话号在提交那一刻钉死，中途被重置就丢弃这条', () => {
    const dispatch = miniChat.slice(
      miniChat.indexOf('async function dispatchUserMessage'),
      miniChat.indexOf('async function handleInitialMessage')
    )

    expect(dispatch).toContain('const submittedSessionId = SESSION_ID.value')
    // 抓取用钉住的那个，不是当前值
    expect(dispatch).toContain('chatSessionStore.getProject?.(submittedSessionId)')
    // 回来发现变了就整条作废 —— 既不改投新会话，也不硬发到已经不存在的旧会话
    expect(dispatch).toContain('if (SESSION_ID.value !== submittedSessionId)')
    const guardAt = dispatch.indexOf('if (SESSION_ID.value !== submittedSessionId)')
    expect(guardAt).toBeLessThan(dispatch.indexOf('await executeAgent('))
  })
})

describe('等后台释放的保护要盖全三条起跑路径', () => {
  /**
   * `done` 到 `released` 之间界面看着停了、后台还没放。少标一处，那条路跑完之后
   * 就有一个「看起来空闲、实际会被顶回来」的空档 —— 排队投递在那里出队即丢。
   *
   * 三条路都会让一条会话在主进程那边占着位子：新一轮、从断点续跑、刷新后接回。
   */
  it('execute / resume / reattach 三处都标了 markAwaitingRelease', () => {
    const agentMode = read('src/renderer/src/views/Assistant/composables/useAgentMode.ts')
    const reattach = read('src/renderer/src/views/Assistant/composables/agentReattach.ts')

    // useAgentMode 里两处：executeAgent 和 resumeAgent
    expect((agentMode.match(/markAwaitingRelease\(/g) ?? []).length).toBe(2)
    expect(reattach).toContain('markAwaitingRelease(')
  })

  /** 起不来的那一轮主进程不会发 released —— 不摘的话这条对话永远显示「忙」 */
  it('两条启动失败路径都摘掉标记', () => {
    const agentMode = read('src/renderer/src/views/Assistant/composables/useAgentMode.ts')

    // executeAgent 的 onError、executeAgent 的外层 catch、resumeAgent 的 abandon
    expect((agentMode.match(/clearAwaitingRelease\(/g) ?? []).length).toBe(3)
  })
})

describe('Spotlight 在主进程按回车那一刻抓', () => {
  /**
   * 不能等小窗口起来再抓：建窗口 + 页面加载 + 500ms 等 Vue 挂载，加起来半秒多，
   * 这半秒里用户完全可能切回引擎换了选区。
   */
  it('spotlight:execute 里就抓，并和建窗口并行', () => {
    const handler = spotlight.slice(
      spotlight.indexOf("ipcMain.on('spotlight:execute'"),
      spotlight.indexOf("ipcMain.on('spotlight:execute'") + 2000
    )

    expect(handler).toContain('captureEditorSnapshotForSpotlight')
    // Promise.all：抓取不能把开窗口这件事拖慢
    expect(handler).toContain('Promise.all([')
  })

  it('抓取失败也照常把这句话送进小窗口', () => {
    const handler = spotlight.slice(spotlight.indexOf("ipcMain.on('spotlight:execute'"))

    expect(handler.slice(0, 2000)).toContain('.catch(')
  })
})

describe('主进程不兜底抓', () => {
  /**
   * 全仓只有两处调 `captureEditorSnapshot`：抓取那个 IPC，和 Spotlight 的专用入口。
   *
   * `execute` / `steer` / `continue` 里**一处都不能有** —— 那时早已不是「那一刻」，
   * 而且气泡上显示的就和模型收到的对不上了。
   */
  it('execute / steer / continue 里没有任何抓取调用', () => {
    const calls = agentV3Ipc.match(/captureEditorSnapshot\(/g) ?? []

    expect(calls.length).toBe(2)
    const executeBody = agentV3Ipc.slice(
      agentV3Ipc.indexOf('async function executeAgent('),
      agentV3Ipc.indexOf("ipcMain.handle('agent-v3:continue'")
    )
    expect(executeBody).not.toContain('captureEditorSnapshot(')
  })
})
