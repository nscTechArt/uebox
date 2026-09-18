import type { AgentQuestion } from '../../../shared/agentQuestion'
import { APPROVE_TASK } from '../../../shared/voiceFrontDesk'
import type { AgentRunSignal } from '../../agent-v3/host/runObserver'
import type { ToolRisk } from '../../agent-v3/tools/defineTool'

import { drainNotices, enqueueNotice, stageOf, type VoiceFloor, type VoiceNotice } from './narrator'
import { shortenInstruction } from './antiSilence'
import { clipToSentences, summarizeByRules } from './spokenSummary'

/**
 * 语音前台的任务表（主进程这一份）。
 *
 * ## 为什么在主进程
 *
 * 上一版这张表在 `useRealtimeVoice` 里，也就是挂在一个 Vue 组件上。
 * 那样有三件事做不了：跨会话派发、界面切走之后继续播报、以及知道
 * 「Agent 现在正卡在问用户」—— 后两者的信息压根不经过那个组件。
 *
 * 搬到这里之后，任务的真相来自 agent 自己的事件流（`host/runObserver`），
 * 不再来自渲染层的一个 Promise。语音关了又开、界面切到别的会话，
 * 任务照跑，跑完照样播报。
 *
 * ## 结果文本从哪来
 *
 * 攒 `text` 增量。上一版是渲染层把 `AgentRunOutcome` 转成一句话回传 ——
 * 那句话是**界面文案**（「执行完成」），不是 Agent 真正说的内容。
 * 现在直接用 Agent 的最终回答，用户听到的和屏幕上写的是同一句。
 *
 * ## 并发的规矩
 *
 * **一条 agent 会话同时只能有一件活。** 这不是我们加的限制 ——
 * `agent-v3:execute` 本来就会拒掉并发（「会话 X 正在执行中」）。
 * 但不同会话可以同时跑：这既是跨会话派发的意义，也是一通电话能开好几个
 * 「灶」的前提（`bySession`、`waiting` 本来就是按会话分的 Map，一个灶一条会话）。
 *
 * 挑哪个灶在渲染层（`voiceAssistant.ensureVoiceWorker`），这里只认会话号。
 * 这一层要管的是**几个灶同时跑之后才出现的那些歧义**：不给任务号时答案该
 * 交给谁（`findPending`）、播报要不要报灶名（`withLane`）、以及给模型看的
 * 灶况（`describeWorkers`）。设计。
 */

/**
 * `queued` = 已经收下，但前面那件还在跑。
 *
 * 之所以要有这个状态而不是直接回绝：真实场景里用户会连着交代好几件事，
 * 「这条对话上一件还没做完，等会儿再说」听着像它没听懂。
 */
export type VoiceTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'stopped'

export interface VoiceTask {
  id: string
  /** 每次明确恢复递增，隔离上次运行迟到的失败回调。 */
  attempt?: number
  held?: boolean
  /** 跑在哪条 agent 会话上 */
  agentSessionId: string
  /** 会话在界面上叫什么。派到别的会话时用来说人话，没有就退回会话号 */
  sessionLabel: string
  instruction: string
  /** 登记时已经包含原始对白，排队后不得重新读取当前通话。 */
  executionInstruction?: string
  status: VoiceTaskStatus
  /** 什么时候登记的。防冷场汇报要说「做了多久」，那是两次汇报之间唯一的新信息 */
  startedAt: number
  /** 最近在做什么。空串表示还没有值得一说的动作 */
  stage: string
  /** Agent 说的话，攒着的。跑完就是结果 */
  outcome: string
  /** 正卡着等人答的那一问 */
  question?: { toolCallId: string; questions: AgentQuestion[] }
  /** 正卡着等人点头的那一次审批 */
  approval?: { toolCallId: string; toolName: string; risk: string; allowAlways: boolean }
  /**
   * Agent 自己最近一次口头汇报（`voice_report` 工具）。
   *
   * 有了它之后机械的「在改蓝图」进度就闭嘴：干活的模型自己会说做到哪了。
   * 收尾时 status 是 done/blocked 的那一句已经念过，不再补念一遍。
   */
  report?: { status: 'running' | 'done' | 'blocked'; message: string }
}

/**
 * 新活来了，怎么处置。
 *
 * **默认排队。** 代价不对称：插队插错了，会把一件不相干的活塞进正在跑的那一轮，
 * Agent 可能半途改道做出个四不像，而且已经改过的东西不会自动退回；
 * 排队排错了只是慢一点。所以只有明确是在修正当前这件事时才插队。
 */
export type VoiceDispatchWhen = 'queue' | 'now'

export type VoiceDispatchOutcome =
  | { action: 'held'; task: VoiceTask }
  /** 会话空着，直接开跑 */
  | { action: 'start'; task: VoiceTask }
  /** 插进正在跑的那一轮（agent-v3 的 steer）。`task` 是正在跑的那件 */
  | { action: 'steer'; task: VoiceTask }
  /** 排上了。`position` 是前面还有几件 */
  | { action: 'queued'; task: VoiceTask; position: number }

export interface VoiceTaskBusDeps {
  /**
   * 播报一条。`speech` 是说给用户听的原话，`context` 进模型上下文。
   * `kind`/`taskId` 让宿主认得出「这条是在替 Agent 问用户」—— 渲染层据此
   * 把用户的下一句直接当答案交回去（模型漏调 answer_question 的保险）
   */
  announce: (notice: {
    speech: string
    context: string
    kind?: VoiceNotice['kind']
    taskId: string
  }) => void
  /**
   * 排到的那件活该开跑了。
   *
   * 真正的启动在**渲染层**（`agentV3API.execute`），主进程发不起 —— 所以这里
   * 只是把它推出去。返回**推没推到**：语音会话关着的时候没人收，返回 false，
   * 那件活就留在队里，等下次开语音时 `resume` 再推。
   */
  startRun: (task: VoiceTask) => boolean
  /** 此刻谁在说话 */
  floor: () => VoiceFloor
  /**
   * 这个工具是读还是写（`listToolRisks()` 那一份）。
   *
   * 播进度要靠它分「在看蓝图」和「在改蓝图」—— 用户最在意的就是这条界线。
   * 查不到的工具不播进度，不猜。
   */
  toolRisk: (toolName: string) => ToolRisk | undefined
  /**
   * 让模型把 Agent 那段书面回复压成一句口语（Agent 自己没用 voice_report 报结果时才用）。
   * 回 null 或抛错都退到规则那句（`summarizeByRules`）。省略就只用规则。
   */
  summarize?: (text: string) => Promise<string | null>
  now?: () => number
}

export interface VoiceTaskBus {
  register(input: {
    agentSessionId: string
    instruction: string
    executionInstruction?: string
    sessionLabel?: string
    when?: VoiceDispatchWhen
  }): VoiceDispatchOutcome
  abandon: (taskId: string, reason: string, attempt?: number) => void
  /** 这条 agent 会话上正跑着的是不是语音派的活（宿主据此决定给不给 voice_report 工具） */
  isVoiceTask: (agentSessionId: string) => boolean
  /** 还没轮到就被用户叫停的那件。没有 agent 运行要停，主进程自己了结就行 */
  dropQueued: (taskId: string) => boolean
  /** 语音重新开了。上次关掉时没推出去的活，现在有人收了 */
  resume: () => void
  /** 用户明确同意继续时恢复原任务，不创建副本。 */
  resumeTask: (taskId: string) => VoiceTask | undefined
  onSignal: (signal: AgentRunSignal) => void
  find: (taskId?: string) => VoiceTask | undefined
  pendingQuestion: (taskId?: string) => { task: VoiceTask; toolCallId: string } | undefined
  pendingApproval: (taskId?: string) => { task: VoiceTask; toolCallId: string } | undefined
  /**
   * 现在几个灶各在干什么，一句话。
   *
   * 每次派活的回执都接上它 —— 模型下一次挑灶靠的就是这个。没有它，
   * 它只能凭记忆猜哪个灶在忙，而实时模型的记忆最不该被指望。
   */
  describeWorkers: () => string
  /** 正在跑的那几件。用户说「停下」而不止一件在跑时，得先问清楚要停哪个 */
  running: () => VoiceTask[]
  /**
   * 「现在做到哪了」，防冷场主动开口时用（见 `antiSilence.ts`）。
   *
   * 和 `describeWorkers` 分开，因为那份是给模型看的：带「灶」这个只有我们内部
   * 才懂的词、带任务号。用户听见「现在开着 1 个灶」只会觉得莫名其妙。
   * 一件在跑的都没有就返回 null —— 没什么可报的时候开口是打扰。
   *
   * 三份各有各的去处：`speech` 是**兜底**那句（模型压不出来时逐字念的），
   * `facts` 交给模型压一句人话，`context` 进实时模型的上下文。
   */
  progressSpeech: () => { speech: string; context: string; facts: string } | null
  flush: () => void
  /** 语音会话关了。高优先级的攒起来（`briefOnReconnect` 再念），进度丢掉 */
  clearQueue: () => void
  /**
   * 语音重新接上了，把用户不在线期间的事交代一遍：攒下的结果 / 反问 / 审批、
   * 还挂着没人答的问题、还在跑的活。没有就什么都不说。
   */
  briefOnReconnect: () => void
  snapshot: () => VoiceTask[]
}

/**
 * 一条播报大约要念多久。
 *
 * 豆包那条链路是 TTS 直合成，**没有文字增量**，渲染层的「模型在说话」看不见它 ——
 * 只能按字数估。中文 TTS 大约每秒四个字。估得偏长没关系，下一条只是晚一点；
 * 估短了两段话会叠在一起念。
 */
export const SPEECH_MS_PER_CHAR = 250
export const SPEECH_OVERHEAD_MS = 1_000
/**
 * 上限跟着**收尾那句**的字数走（`spokenSummary.MAX_SPOKEN_CHARS` 160 字 ≈ 41 秒）。
 *
 * 原先是 20 秒，那时候收尾最多 140 字也已经估短了。估短的后果是下一条压着它开口，
 * 两段话叠在一起念；估长只是下一条晚几秒，所以这个数宁可往大了给。
 */
export const SPEECH_MAX_MS = 45_000

export function estimateSpeechMs(speech: string): number {
  return Math.min(SPEECH_MAX_MS, SPEECH_OVERHEAD_MS + speech.length * SPEECH_MS_PER_CHAR)
}

/** 念出来的上限内截到句子边界。硬截在半个词上（「SampleP……」）是上一版的毛病 */
function forSpeech(text: string): string {
  return clipToSentences(text)
}

const STATUS_TEXT: Record<Exclude<VoiceTaskStatus, 'running' | 'queued'>, string> = {
  done: '已完成',
  failed: '失败了',
  blocked: '需要用户帮助，尚未完成',
  stopped: '被停下了'
}

/** 任务当前状态的口播文案。纯函数 —— 这几句话错了不报错，只是听着不对 */
export function describeTask(task: VoiceTask | undefined): string {
  if (!task) return '现在没有任务在跑。'

  const where = task.sessionLabel ? `（灶：${task.sessionLabel}）` : ''
  if (task.status === 'queued' && task.held) {
    return `任务 ${task.id}${where}：${task.instruction} —— 已挂起，等待用户明确同意后用 resumeTaskId 恢复。`
  }
  if (task.status === 'queued') {
    return `任务 ${task.id}${where}：${task.instruction} —— 还排着队，前面那件做完就开始。`
  }
  if (task.status === 'running') {
    const doing = task.approval
      ? `正卡着等用户点头才能执行 ${task.approval.toolName}`
      : task.question
        ? '正卡着等你问用户一个问题'
        : task.report?.message || task.stage || '还在跑'
    return `任务 ${task.id}${where}：${task.instruction} —— ${doing}。`
  }
  const outcome = task.outcome ? `：${forSpeech(task.outcome)}` : '。'
  return `任务 ${task.id}${where} ${STATUS_TEXT[task.status]}${outcome}`
}

/**
 * 同一件事，说给用户听的那句。
 *
 * 和 `describeTask` 分开，因为两句话的听众不一样。`describeTask` 是给模型看的：
 * 带任务号，后面 `check_task` 才对得上。而豆包那条链路会把播报的文字
 * **逐字念出来**（3.0 没有 `response.create`，主动出声只能走 TTS 直合成），
 * 念一句「任务 t1 在未命名对话 已完成」等于在念日志。
 *
 * 纯函数，措辞错了不报错，只是听着不像人话。
 */
export function speakTask(task: VoiceTask, options: { withLane?: boolean } = {}): string {
  /*
   * 只有**同时开着不止一个灶**的时候才报灶名。
   *
   * 一个灶的时候「灯光那边做完了」是废话；几个灶同时跑的时候不报就是灾难 ——
   * 用户听见一句「做完了」，完全不知道是刚才交代的哪一件。
   */
  const where = options.withLane && task.sessionLabel ? `${task.sessionLabel}那边，` : ''
  const outcome = task.outcome ? forSpeech(task.outcome) : ''

  switch (task.status) {
    case 'done':
      return outcome ? `${where}${outcome}` : `${where}做完了。`
    case 'failed':
      // 失败必须说得明白。含糊过去比冷场危险 —— 用户会以为事情办成了
      return outcome ? `${where}没做成：${outcome}` : `${where}没做成。`
    case 'blocked':
      return `${where}还没做完：${outcome || '需要你帮忙才能继续'}。`
    case 'stopped':
      return `${where}刚才那件事停下了。`
    case 'queued':
      return `${where}这件先记下了，前面那件做完就开始。`
    default:
      return `${where}${task.stage || '还在跑'}。`
  }
}

/** 一问念成一句话。选项也要念 —— 不念的话用户不知道有哪些出路 */
export function describeQuestion(questions: AgentQuestion[]): string {
  return questions
    .map((item) => {
      const options = item.options.map((option) => option.label).filter(Boolean)
      return options.length > 0 ? `${item.question}（可选：${options.join('、')}）` : item.question
    })
    .join('；')
}

export function createVoiceTaskBus(deps: VoiceTaskBusDeps): VoiceTaskBus {
  const now = deps.now || (() => Date.now())

  const tasks = new Map<string, VoiceTask>()
  /** agent 会话 → 它当前那件活。一条会话同时只能有一件 */
  const bySession = new Map<string, string>()
  /** agent 会话 → 排着队还没开跑的那几件（先进先出） */
  const waiting = new Map<string, string[]>()
  const heldSessions = new Set<string>()
  const occupiedSessions = new Set<string>()
  let seq = 0
  let queue: VoiceNotice[] = []
  let lastSpokenAt = 0
  /** 上一条播报预计念到什么时候。念完之前不放下一条，见 `estimateSpeechMs` */
  let busyUntil = 0
  /**
   * 用户不在线（语音关着）期间攒下的高优先级通知：结果、反问、审批、卡住。
   *
   * 上一版直接丢：「没人听，攒着也没意义」。真机上的反面是用户挂了语音去干别的，
   * 回来再开语音，刚才派的活做完了却没人告诉他，Agent 问的话也没人再念 ——
   * 他只能自己想起来问「刚才那个好了没」。进度（低优先级）照旧丢，那是过去式。
   */
  let missed: VoiceNotice[] = []

  /** 同一件活同一类只留最新一条：做完又失败、问了又问，念旧的那条是在骗人 */
  function stash(notice: VoiceNotice): void {
    missed = [
      ...missed.filter((item) => !(item.taskId === notice.taskId && item.kind === notice.kind)),
      notice
    ]
  }

  function notify(notice: VoiceNotice): void {
    queue = enqueueNotice(queue, notice)
    flush()
  }

  /** 语音关着：高优先级攒起来等接上再念，进度丢掉 */
  function stashQueueWhileOff(): void {
    for (const notice of queue) if (notice.priority === 'high') stash(notice)
    queue = []
  }

  /**
   * 把攒着的通知按纪律放出去。
   *
   * 一次只放一条 —— 连着放两条模型会把它们揉成一大段念，
   * 而这几条本来就是分开的事。剩下的等下一次 flush：说话状态变了、下一条通知进来，
   * 或者主进程那个每秒一次的定时器（节流窗口和「上一条还在念」这两种等待
   * 没有任何事件会来唤醒，只能靠它）。
   */
  function flush(): void {
    const at = now()
    if (at < busyUntil) return
    if (!deps.floor().active) {
      stashQueueWhileOff()
      return
    }
    const [ready, rest] = drainNotices(queue, deps.floor(), lastSpokenAt, at)
    queue = rest
    if (!ready) return
    lastSpokenAt = at
    busyUntil = at + estimateSpeechMs(ready.speech)
    // 记下刚念的是谁的哪一类 —— 用户接下来的回答该交给它，见 `findPending`
    if (ready.kind && ready.taskId) lastAnnounced = { taskId: ready.taskId, kind: ready.kind }
    // 这一层出问题的样子是「安静」：该念的没念出来。留一行，排查时才知道到底放没放
    console.log(
      `[语音播报 ${new Date().toISOString().slice(11, 23)}] ${ready.priority === 'high' ? '插播' : '进度'}：${ready.speech}`
    )
    deps.announce({
      speech: ready.speech,
      context: ready.context,
      kind: ready.kind,
      taskId: ready.taskId
    })
  }

  /**
   * 这件活还压在队里没念的**进度**作废。落终态时调。
   *
   * 进度说的是「现在在做什么」，而它现在已经做完了。结果那条是高优先级、不受节流，
   * 会越过还在节流窗口里的进度先念出去；剩下那条进度等窗口过去照样会被念，
   * 于是用户先听见「三十个分组全删完了」，过一会儿又听见「找到了那三十个，
   * 现在开始一个个删」—— 真机 2026-09-16 录到的就是这一幕，而且那会儿用户
   * 已经道过别了，听起来像是同一件事又被做了一遍。
   *
   * 只丢低优先级的：高优先级那几条（结果、失败、反问、审批）各是各的事，
   * 而且正是用户在等的答案。
   */
  function dropProgress(taskId: string): void {
    queue = queue.filter((item) => !(item.priority === 'low' && item.taskId === taskId))
  }

  /** 用户在界面上把那一问/那一次审批答掉了。还压在队里（或攒着等接上）没念的那条作废 */
  function dropPending(taskId: string, kind: NonNullable<VoiceNotice['kind']>): void {
    const stale = (item: VoiceNotice): boolean => item.taskId === taskId && item.kind === kind
    queue = queue.filter((item) => !stale(item))
    missed = missed.filter((item) => !stale(item))
  }

  /** 「Agent 在问你」那一条。接上时要能原样再念一遍，所以单独拎出来 */
  function questionNotice(task: VoiceTask, questions: AgentQuestion[]): VoiceNotice {
    return {
      taskId: task.id,
      speech: `有个问题要问你：${describeQuestion(questions)}。`,
      context:
        `任务 ${task.id} 需要你问用户：${describeQuestion(questions)}。` +
        `用户接下来说的那句就是答案，**立刻**用 answer_question 交回来 —— ` +
        `只口头说「记下了」没有任何用，Agent 会一直卡着等。`,
      priority: 'high',
      kind: 'question'
    }
  }

  /** 「Agent 要你点头」那一条。念工具名而不是「一个高风险操作」—— 用户要凭它判断该不该点头 */
  function approvalNotice(
    task: VoiceTask,
    approval: NonNullable<VoiceTask['approval']>
  ): VoiceNotice {
    const what = `要执行 ${approval.toolName}（风险等级 ${approval.risk}）`
    return {
      taskId: task.id,
      speech: `${what}，需要你点头才能往下做。同意还是不做？`,
      context:
        `任务 ${task.id} ${what}，正卡着等用户确认。问用户同不同意，` +
        `再用 ${APPROVE_TASK} 把结果交回来。**别替用户决定**。` +
        (approval.allowAlways ? '用户说「以后都行」就交 always。' : ''),
      priority: 'high',
      kind: 'approval'
    }
  }

  function current(agentSessionId: string): VoiceTask | undefined {
    const id = bySession.get(agentSessionId)
    return id ? tasks.get(id) : undefined
  }

  /**
   * 同时有几个灶开着（还没落终态的活分布在几条 agent 会话上）。
   *
   * 播报要不要报灶名就看它：一个灶的时候报灶名是废话，几个灶的时候不报是灾难。
   */
  function activeLanes(): number {
    const lanes = new Set<string>()
    for (const task of tasks.values()) {
      if (task.status === 'running' || task.status === 'queued') lanes.add(task.agentSessionId)
    }
    return lanes.size
  }

  /** 播报这一刻该不该报灶名 */
  function withLane(): boolean {
    return activeLanes() > 1
  }

  /**
   * 现在几个灶各在干什么，一句话。
   *
   * 每次派活都把它接在回执后面：模型下一次挑灶靠的就是这个 —— 没有它，
   * 它只能凭记忆猜哪个灶在忙，而实时模型的记忆最不该被指望。
   */
  function describeWorkers(): string {
    const lanes = new Map<string, { label: string; running?: VoiceTask; queued: number }>()
    for (const task of tasks.values()) {
      if (task.status !== 'running' && task.status !== 'queued') continue
      const lane = lanes.get(task.agentSessionId) || {
        label: task.sessionLabel || '任务',
        queued: 0
      }
      if (task.status === 'running') lane.running = task
      else lane.queued += 1
      lanes.set(task.agentSessionId, lane)
    }

    if (lanes.size === 0) return '现在所有灶都空着。'
    const lines = [...lanes.values()].map((lane) => {
      const doing = lane.running
        ? lane.running.report?.message || lane.running.stage || lane.running.instruction
        : '空着'
      const queued = lane.queued > 0 ? `，后面还排着 ${lane.queued} 件` : ''
      return `${lane.label}：${doing}${queued}`
    })
    return `现在开着 ${lanes.size} 个灶 —— ${lines.join('；')}。`
  }

  /**
   * 不给任务号时的默认那一件。
   *
   * **先挑正在跑的，再挑排着队的，最后才是最近登记的。** 只按登记顺序取的话，
   * 用户在第一件还跑着时交代了第二件、紧接着说「停下」—— 拿到的是排队的第二件，
   * 撤掉的是它，正在跑的第一件照跑不误；再说一次「停下」，回的是「没有在跑的任务」。
   */
  function latest(): VoiceTask | undefined {
    let running: VoiceTask | undefined
    let queued: VoiceTask | undefined
    let any: VoiceTask | undefined
    for (const task of tasks.values()) {
      any = task
      if (task.status === 'running') running = task
      else if (task.status === 'queued') queued = task
    }
    return running || queued || any
  }

  function findTask(taskId?: string): VoiceTask | undefined {
    const trimmed = (taskId || '').trim()
    return trimmed ? tasks.get(trimmed) : latest()
  }

  /** 刚念出去的那条通知是哪件活的哪一类。不给任务号时的首选，见 `findPending` */
  let lastAnnounced: { taskId: string; kind: NonNullable<VoiceNotice['kind']> } | undefined

  /**
   * 「还挂着的那一问 / 那次审批」是谁的。
   *
   * **不能退回 `latest()`。** 一个灶的时候它恰好总是对的；几个灶同时跑的时候，
   * 最近登记的那件很可能根本没在问人 —— 而 `latest()` 会把它交出去，于是用户的
   * 口头回答被送给一个没在等答案的 Agent，真正卡着的那个继续卡着。
   * 这不会报错，表现是「我明明答了，它还在问」。
   *
   * 所以不给任务号时：先挑**刚念出去的那条**（用户回答的必然是他刚听见的那句），
   * 再挑任何一件确实挂着这一类的活。一件都没有就是 undefined，调用方照实回。
   */
  function findPending(
    kind: NonNullable<VoiceNotice['kind']>,
    taskId?: string
  ): VoiceTask | undefined {
    const trimmed = (taskId || '').trim()
    if (trimmed) return tasks.get(trimmed)

    const has = (task: VoiceTask | undefined): boolean =>
      !!(kind === 'question' ? task?.question : task?.approval)

    if (lastAnnounced?.kind === kind) {
      const announced = tasks.get(lastAnnounced.taskId)
      if (has(announced)) return announced
    }
    for (const task of tasks.values()) if (has(task)) return task
    return undefined
  }

  function newTask(input: {
    agentSessionId: string
    instruction: string
    executionInstruction?: string
    sessionLabel?: string
    status: VoiceTaskStatus
  }): VoiceTask {
    seq += 1
    const task: VoiceTask = {
      id: `t${seq}`,
      attempt: 1,
      agentSessionId: input.agentSessionId,
      sessionLabel: input.sessionLabel || '',
      instruction: input.instruction,
      executionInstruction: input.executionInstruction,
      status: input.status,
      startedAt: now(),
      stage: '',
      outcome: ''
    }
    tasks.set(task.id, task)
    return task
  }

  /**
   * 前面那件腾出来了，把队里下一件推出去跑。
   *
   * 只推**一件**：一条 agent 会话同时只能有一件活（`agent-v3:execute` 本来就拒并发）。
   * 剩下的等这一件也结束。
   *
   * **只在 `released` 之后调**（或者压根没跑起来的时候）。`done` 不算 ——
   * 它发出来时主进程还没把会话从 activeAgents 摘掉，这会儿派下一件会被
   * 「正在执行中」顶回来，那件活就莫名其妙地失败了。
   */
  function startNextWaiting(agentSessionId: string): void {
    if (
      heldSessions.has(agentSessionId) ||
      occupiedSessions.has(agentSessionId) ||
      current(agentSessionId)
    )
      return
    const line = waiting.get(agentSessionId)
    if (!line || line.length === 0) return

    const nextId = line.shift() as string
    const next = tasks.get(nextId)
    // 排队期间被取消掉的，跳过它接着找下一件
    if (!next || next.status !== 'queued') {
      if (line.length === 0) waiting.delete(agentSessionId)
      startNextWaiting(agentSessionId)
      return
    }

    next.status = 'running'
    bySession.set(agentSessionId, next.id)
    if (deps.startRun(next)) {
      if (line.length === 0) waiting.delete(agentSessionId)
      return
    }

    /*
     * 没人收（语音会话关着、窗口没了）。退回队头，别让它顶着 running 占住会话 ——
     * 那样下次开语音派活会排在一件永远不会开始的活后面，check_task 也一直说「还在跑」。
     * 等下次开语音，`resume` 会再推一次。
     */
    next.status = 'queued'
    bySession.delete(agentSessionId)
    line.unshift(next.id)
  }

  /**
   * 每条会话上一件活是怎么收场的。`released` 到的时候要凭它决定推不推下一件。
   *
   * 不能在 `released` 里现看那件活的状态：那会儿它已经从 `bySession` 摘掉了
   * （`settle` 干的），`current()` 拿到的是 undefined。
   */
  const lastSettled = new Map<string, VoiceTaskStatus>()

  /**
   * 一件活收场之后，队里的下一件该开跑还是先挂着。
   *
   * **前一件是砸了的，不许自动接着跑。** 真机（2026-09-03）：搬资产那件把编辑器
   * 搞崩了，紧接着排在后面的「做个材质」自己开跑了 —— 而那会儿编辑器已经没了。
   * 用户听到的是「刚才那件失败了」，然后盒子若无其事地开始做下一件。
   *
   * 这和 §6.6「用户叫停时把队里的一起撤」是同一条道理，当时只写进了 `stopped`
   * 那一支：**事情不对劲的时候，最不该做的就是接着改工程**。崩溃比用户叫停更
   * 「不对劲」—— 叫停至少还是他自己的决定。
   *
   * `stopped` 不走这儿的挂起分支：那条路已经在 `dropWaiting` 里把队清空了。
   */
  function pumpAfterSettle(agentSessionId: string): void {
    const settled = lastSettled.get(agentSessionId)
    if (
      (settled === 'failed' || settled === 'blocked') &&
      (waiting.get(agentSessionId)?.length ?? 0) > 0
    ) {
      holdQueue(agentSessionId)
      return
    }
    startNextWaiting(agentSessionId)
  }

  /**
   * 前一件砸了，队里的先挂着，问用户要不要接着做。
   *
   * **挂起而不是撤掉**：撤了用户就得把那件事从头再说一遍，而他多半只是想
   * 「先把编辑器救回来再说」。挂着的活留在 `waiting` 里，用户说「接着做」时
   * 模型用原任务号明确恢复，不复制任务。
   */
  function holdQueue(agentSessionId: string): void {
    const line = waiting.get(agentSessionId) || []
    const held = line.map((id) => tasks.get(id)).filter((task) => task?.status === 'queued')
    if (held.length === 0) return
    heldSessions.add(agentSessionId)
    for (const task of held) if (task) task.held = true

    const what = held
      .map((task) => task?.instruction || '')
      .filter(Boolean)
      .join('、')
    notify({
      taskId: held[0]?.id || '',
      speech: `刚才那件没完成，后面还排着 ${held.length} 件（${what}），我先没动 —— 还要接着做吗？`,
      context:
        `刚才那件没完成，${agentSessionId} 这个灶的队里还排着 ${held.length} 件：${what}。` +
        `**没有自动开跑** —— 前一件出事的时候接着改工程是最危险的。问用户还要不要做：` +
        `用户明确说继续哪件，才用 dispatch_task 的 resumeTaskId 恢复原任务；不要重新派副本。` +
        `待选任务：${held.map((task) => `${task?.id}：${task?.instruction}`).join('；')}。` +
        `说不要就用 cancel_task 逐个撤掉。`,
      priority: 'high'
    })
  }

  /**
   * 用户说了「停下」，把这条会话队里还没开始的也一起撤掉。返回撤了几件。
   *
   * 不撤的话，停下的那一刻紧接着自动开跑下一件，用户会以为「停下」没生效 ——
   * 他叫停多半是因为事情不对劲，这时候最不该做的就是接着改工程。
   * 撤错了大不了再说一遍；开错了改掉的东西不会自己退回。
   */
  function dropWaiting(agentSessionId: string): number {
    const line = waiting.get(agentSessionId) || []
    waiting.delete(agentSessionId)
    heldSessions.delete(agentSessionId)
    let dropped = 0
    for (const id of line) {
      const task = tasks.get(id)
      if (task?.status !== 'queued') continue
      task.status = 'stopped'
      dropped += 1
    }
    return dropped
  }

  /**
   * 落终态并播报。**不推队里下一件** —— 那要等主进程的 `released`，
   * 见 `startNextWaiting`。
   *
   * `announce: false` 用在 Agent 自己已经用 voice_report 报过结果的时候：
   * 那句念过了，收尾再念一遍「做完了」是同一件事说两遍。
   */
  function settle(
    task: VoiceTask,
    status: Exclude<VoiceTaskStatus, 'running' | 'queued'>,
    options: { outcome?: string; suffix?: string; announce?: boolean } = {}
  ): void {
    // 先到的那个终态说了算。`error` 之后 pi 照样会发 `agent_end`，
    // 不挡的话「失败了」会被随后的「已完成」盖掉 —— 那是最坏的一种谎
    if (task.status !== 'running' && task.status !== 'queued') return

    task.status = status
    if (options.outcome !== undefined) task.outcome = options.outcome
    task.question = undefined
    task.approval = undefined
    // `released` 到的时候这件活已经从 bySession 摘掉了，得留一份「怎么收场的」
    // 给它看 —— 砸了就别自动推下一件（见 `holdQueue`）
    lastSettled.set(task.agentSessionId, status)
    if (bySession.get(task.agentSessionId) === task.id) bySession.delete(task.agentSessionId)
    // 已经做完了，还压着没念的进度就是假话（见 `dropProgress`）。
    // 在 `announce === false` 之前做：Agent 自己报过结果的那条路也要清
    dropProgress(task.id)
    if (options.announce === false) return
    const suffix = options.suffix ?? ''
    notify({
      taskId: task.id,
      speech: `${speakTask(task, { withLane: withLane() })}${suffix}`,
      context: `${describeTask(task)}${suffix}`,
      priority: 'high'
    })
  }

  return {
    /**
     * 派活之前先登记。
     *
     * **必须在真正启动 agent 之前调用** —— 晚了的话最初几条事件
     * （start、第一个工具）落到一个还不存在的任务上，直接丢掉。
     */
    register(input: {
      agentSessionId: string
      instruction: string
      executionInstruction?: string
      sessionLabel?: string
      when?: VoiceDispatchWhen
    }): VoiceDispatchOutcome {
      const running = current(input.agentSessionId)

      if (!running && !occupiedSessions.has(input.agentSessionId)) {
        const held = (waiting.get(input.agentSessionId) || [])
          .map((id) => tasks.get(id))
          .find((task) => task?.status === 'queued')
        if (heldSessions.has(input.agentSessionId) && held) return { action: 'held', task: held }
        const task = newTask({ ...input, status: 'running' })
        bySession.set(task.agentSessionId, task.id)
        return { action: 'start', task }
      }

      /*
       * 会话忙着。插队还是排队。
       *
       * 插队走 agent-v3 的 `steer`，不新开一件活 —— 那句话是对**正在跑的这件**
       * 的修正，单独记成一件的话，用户问「刚才那个好了没」会被引到一件
       * 根本不存在独立结果的活上。
       */
      if (input.when === 'now' && running) return { action: 'steer', task: running }

      const task = newTask({ ...input, status: 'queued' })
      const line = waiting.get(input.agentSessionId) || []
      line.push(task.id)
      waiting.set(input.agentSessionId, line)
      return { action: 'queued', task, position: line.length }
    },

    /**
     * 启动失败（IPC 报错、会话被占）。不标掉的话这条会话永远派不进新活。
     *
     * 已经落了终态的（主进程那边先报了 error）这里不再动 —— 渲染层的失败回调
     * 比旁路信号晚到是常态，不挡的话队里下一件会被推两次。
     */
    abandon(taskId: string, reason: string, attempt = 1): void {
      const task = tasks.get(taskId)
      if (
        !task ||
        (task.attempt ?? 1) !== attempt ||
        (task.status !== 'running' && task.status !== 'queued')
      )
        return
      settle(task, 'failed', { outcome: reason })
      // 压根没跑起来，主进程不会有 `released` —— 队里下一件只能在这儿推。
      // 同样按「前一件砸了就先挂着」处理：起不来多半是会话还占着或者环境有问题，
      // 这时候接着推下一件只会连着失败一串
      pumpAfterSettle(task.agentSessionId)
    },

    isVoiceTask(agentSessionId: string): boolean {
      return bySession.has(agentSessionId)
    },

    /**
     * 用户对一件**还排着队**的活说「别做了」。
     *
     * 和停正在跑的那件是两回事：这件压根还没开跑，没有 agent 运行要停，
     * 也就不需要绕到渲染层去拿真实返回值 —— 主进程把它标掉、从队里摘掉就完了。
     * 返回有没有摘到，调用方据此决定说什么。
     *
     * **不播报。** 这件活没开始过，「刚才那件事停下了」念出来是错的；
     * 而且调用方拿着返回值本来就会让模型告诉用户，再播一遍就是同一句说两遍。
     */
    dropQueued(taskId: string): boolean {
      const task = tasks.get(taskId)
      if (!task || task.status !== 'queued') return false

      const line = waiting.get(task.agentSessionId)
      if (line) {
        const at = line.indexOf(task.id)
        if (at >= 0) line.splice(at, 1)
        if (line.length === 0) waiting.delete(task.agentSessionId)
        if (line.length === 0) heldSessions.delete(task.agentSessionId)
      }
      task.status = 'stopped'
      return true
    },

    /**
     * 语音重新开了，把上次关掉时没推出去的活推出去。
     *
     * 只推会话空着的：正在跑的那条（用户在界面上自己派的）结束时会有 `released`，
     * 到时候再推。
     */
    resume(): void {
      for (const agentSessionId of [...waiting.keys()]) {
        if (!current(agentSessionId)) startNextWaiting(agentSessionId)
      }
    },

    resumeTask(taskId: string): VoiceTask | undefined {
      const task = tasks.get(taskId)
      if (
        !task ||
        !['queued', 'blocked', 'failed'].includes(task.status) ||
        current(task.agentSessionId) ||
        occupiedSessions.has(task.agentSessionId)
      )
        return undefined
      const line = waiting.get(task.agentSessionId)
      if (line) {
        const index = line.indexOf(task.id)
        if (index >= 0) line.splice(index, 1)
        if (line.length === 0) waiting.delete(task.agentSessionId)
      }
      if (!waiting.get(task.agentSessionId)?.length) heldSessions.delete(task.agentSessionId)
      task.held = false
      task.attempt = (task.attempt ?? 1) + 1
      task.status = 'running'
      task.report = undefined
      task.outcome = ''
      task.stage = ''
      task.startedAt = now()
      bySession.set(task.agentSessionId, task.id)
      return task
    },

    onSignal(signal: AgentRunSignal): void {
      if (signal.type === 'started') occupiedSessions.add(signal.sessionId)
      if (signal.type === 'released') {
        occupiedSessions.delete(signal.sessionId)
        /*
         * 会话真的空出来了，这才是推队里下一件的时机（见 `startNextWaiting`）。
         *
         * 顺手兜个底：整轮结束了却一个终态都没收到（异常从 prompt() 抛穿、
         * pi 没来得及发那条消息），不标掉的话这件活永远「还在跑」，后面的全排在它后面。
         */
        const stuck = current(signal.sessionId)
        if (stuck) settle(stuck, 'failed', { outcome: '运行结束了，但没有拿到结果。' })

        pumpAfterSettle(signal.sessionId)
        return
      }

      const task = current(signal.sessionId)
      // 用户自己在界面上打字跑的那些运行也会经过这里。没登记过就不是我们的事
      if (!task) return
      if (signal.type === 'done' || signal.type === 'error' || signal.type === 'stopped')
        occupiedSessions.add(signal.sessionId)

      switch (signal.type) {
        case 'started':
          // 同一条会话续跑时可能再来一次 start，把上一轮攒的正文清掉，
          // 否则结果里会带着上一轮的话
          task.outcome = ''
          break
        case 'text':
          task.outcome += signal.text
          break
        case 'tool': {
          /*
           * 正文只留**最后那段**：每调一次工具就把前面攒的清掉，跑完时剩下的
           * 就是最后那段回答。不清的话念出来的是 Agent 一路的碎碎念
           * （「我先找一下…」「这两个地方都没有…」），真正的答案反而被截掉 ——
           * 真机上就念了半分钟的过程。
           */
          task.outcome = ''
          // Agent 自己开口汇报过的，机械进度就闭嘴 —— 它比「在改蓝图」说得准
          if (task.report) break
          const stage = stageOf(signal.toolName, deps.toolRisk(signal.toolName))
          // 只在**换了阶段**时播。同一阶段里十次工具调用说十遍「在改蓝图」
          // 就是碎碎念，而这正是要治的毛病
          if (!stage || stage === task.stage) break
          task.stage = stage
          notify({
            taskId: task.id,
            speech: speakTask(task, { withLane: withLane() }),
            context: `任务 ${task.id} ${stage}。`,
            priority: 'low'
          })
          break
        }
        case 'question':
          task.question = { toolCallId: signal.toolCallId, questions: signal.questions }
          // 用户听见的是问题本身，模型收到的是「答完交回来」那条指令 ——
          // 混成一句的话，用户会听见一段对着模型说的话
          notify(questionNotice(task, signal.questions))
          break
        case 'question-settled':
          if (task.question?.toolCallId === signal.toolCallId) {
            task.question = undefined
            dropPending(task.id, 'question')
          }
          break
        case 'approval': {
          task.approval = {
            toolCallId: signal.toolCallId,
            toolName: signal.toolName,
            risk: signal.risk,
            allowAlways: signal.allowAlways
          }
          // 含糊地问「要不要继续」，用户只能盲批，那这道保险就白设了 —— 见 approvalNotice
          notify(approvalNotice(task, task.approval))
          break
        }
        case 'approval-settled':
          if (task.approval?.toolCallId === signal.toolCallId) task.approval = undefined
          // 用户在界面上点了。还没念出去的那条不能再念
          dropPending(task.id, 'approval')
          break
        case 'report':
          /*
           * Agent 自己开口了（voice_report）。这是 Codex 那套「后台模型先产出一句
           * 适合口头说的结果」的落地：说什么由干活的模型定，它最清楚做到哪了。
           *
           * 中途（running）按低优先级：受节流、同一件活只留最新一条 —— 它报得太密
           * 也不至于变成实况解说。做完 / 卡住是用户在等的答案，高优先级。
           */
          task.report = { status: signal.status, message: signal.message }
          notify({
            taskId: task.id,
            // Agent 自己写的那句里不会有灶名（它不知道有灶这回事），几个灶同时跑时
            // 得由我们补上，否则用户听见一句「三个插件都搬完了」不知道是哪件活
            speech:
              withLane() && task.sessionLabel
                ? `${task.sessionLabel}那边，${signal.message}`
                : signal.message,
            context:
              signal.status === 'running'
                ? `任务 ${task.id} 汇报进度：${signal.message}`
                : signal.status === 'done'
                  ? `任务 ${task.id} 做完了：${signal.message}`
                  : `任务 ${task.id} 卡住了，需要用户：${signal.message}`,
            priority: signal.status === 'running' ? 'low' : 'high'
          })
          break
        case 'done': {
          /*
           * Agent 自己用 voice_report 报过 done/blocked 的，那句已经念过（或排在队里等念），
           * 收尾不再补一句「做完了」—— 同一件事说两遍。
           */
          const reported = task.report && task.report.status !== 'running' ? task.report : null
          if (reported) {
            settle(task, reported.status === 'blocked' ? 'blocked' : 'done', {
              outcome: forSpeech(reported.message),
              announce: false
            })
            break
          }

          /*
           * 它没报。屏幕上那段回复是给眼睛的：先按规则收拾成能念的（去 markdown、截到
           * 句子边界），再让模型压一句更像人话的；模型没配或调不通就念规则那句。
           * 播报要等压缩回来才放，所以 settle 先不播。真机上没这一步的样子：
           * 星号、路径、PID 逐字念，还在「SampleP」处硬截。
           */
          const raw = task.outcome
          const byRules = summarizeByRules(raw) || '做完了，没有更多说明。'
          settle(task, 'done', { outcome: byRules, announce: false })
          const speakFinal = (speech: string): void => {
            task.outcome = speech
            notify({
              taskId: task.id,
              speech: speakTask(task, { withLane: withLane() }),
              context: describeTask(task),
              priority: 'high'
            })
          }
          if (!deps.summarize || !raw.trim()) {
            speakFinal(byRules)
            break
          }
          deps.summarize(raw).then(
            (condensed) => speakFinal(condensed || byRules),
            () => speakFinal(byRules)
          )
          break
        }
        case 'stopped': {
          // 用户说了「停下」，队里还没开始的也一起撤 —— 理由见 `dropWaiting`
          const dropped = dropWaiting(task.agentSessionId)
          settle(task, 'stopped', {
            suffix: dropped > 0 ? `后面排着的 ${dropped} 件也一起撤了。` : ''
          })
          break
        }
        case 'error':
          settle(task, 'failed', { outcome: signal.message })
          break
      }
    },

    find: findTask,

    /** 还等着答的那一问。答完由 `question-settled` 自己清掉 */
    pendingQuestion(taskId?: string): { task: VoiceTask; toolCallId: string } | undefined {
      const task = findPending('question', taskId)
      return task?.question ? { task, toolCallId: task.question.toolCallId } : undefined
    },

    /** 还等着点头的那一次审批。点完由 `approval-settled` 自己清掉 */
    pendingApproval(taskId?: string): { task: VoiceTask; toolCallId: string } | undefined {
      const task = findPending('approval', taskId)
      return task?.approval ? { task, toolCallId: task.approval.toolCallId } : undefined
    },

    describeWorkers,

    running(): VoiceTask[] {
      return [...tasks.values()].filter((task) => task.status === 'running')
    },

    progressSpeech(): { speech: string; context: string; facts: string } | null {
      const live = [...tasks.values()].filter((task) => task.status === 'running')
      if (live.length === 0) return null

      /*
       * 卡着等人的那几件要**说成卡着**，不能报成「还在跑」—— 报错了用户以为不用
       * 管它，而实际上整件事就停在他这儿。
       */
      const doingOf = (task: VoiceTask): string =>
        task.approval
          ? '停在一个要你点头的操作上'
          : task.question
            ? '停在一个要问你的问题上'
            : task.report?.message || task.stage || '还在做'

      // 兜底那句：短指令 + 现在在干嘛。模型压不出来时逐字念的就是它
      const lines = live.map((task) => {
        const where = live.length > 1 && task.sessionLabel ? `${task.sessionLabel}那边，` : ''
        return `${where}「${shortenInstruction(task.instruction)}」${doingOf(task)}`
      })

      /*
       * 给模型的那份带上**用户的原话和已经做了多久**。
       *
       * 原话是它挑简称的依据（「游轮那边」得从「把关卡里的游轮改成泰坦尼克号风格」
       * 里来）；时长是这句话唯一的新信息 —— 第二次汇报和第一次之间，往往只有
       * 「又过了一分钟」这一点变化，不给它就只能把上一句原样再说一遍。
       */
      const facts = live
        .map((task, at) => {
          const minutes = Math.max(1, Math.round((now() - task.startedAt) / 60_000))
          const lane = task.sessionLabel ? `（${task.sessionLabel}那一路）` : ''
          return (
            `${at + 1}. 用户交代的原话${lane}：「${task.instruction}」；` +
            `现在：${doingOf(task)}；已经做了大约 ${minutes} 分钟。`
          )
        })
        .join('\n')

      return {
        speech: `跟你说一声，${lines.join('；')}。`,
        facts:
          `手上还有 ${live.length} 件事没做完，都还在做：\n${facts}\n` +
          '按上面的规矩，主动跟用户搭一句话。',
        context:
          `已经安静一会儿了，主动跟用户报了一下进度：${lines.join('；')}。` +
          '这是盒子自己开口，不是用户问的。'
      }
    },

    /** 说话状态变了（用户开口、模型说完），把压着的通知放出去 */
    flush,

    /**
     * 语音会话关了。进度丢掉（下次开语音再念旧进度是惊吓不是提醒）；
     * 结果、反问、审批攒起来，接上时 `briefOnReconnect` 交代
     */
    clearQueue(): void {
      stashQueueWhileOff()
    },

    briefOnReconnect(): void {
      /*
       * 三类东西，按「用户最需要先知道」排：
       *   1. 不在线期间攒下的结果 / 卡住 / 反问 / 审批（missed）
       *   2. 挂断之前就问过、到现在还没人答的反问和审批 —— 再念一遍，顺便把渲染层那条
       *      「下一句当答案」的保险重新架起来
       *   3. 还在跑的活，提一句，让用户和模型都知道有东西在后台
       * 一条都没有就一个字不说：什么事都没发生，开口就是打扰。
       */
      const pendingIds = new Set(missed.map((item) => `${item.taskId}:${item.kind ?? ''}`))
      const catchUp: VoiceNotice[] = [...missed]
      missed = []

      for (const task of tasks.values()) {
        if (task.status !== 'running') continue
        if (task.question && !pendingIds.has(`${task.id}:question`)) {
          catchUp.push(questionNotice(task, task.question.questions))
        } else if (task.approval && !pendingIds.has(`${task.id}:approval`)) {
          catchUp.push(approvalNotice(task, task.approval))
        } else if (!task.question && !task.approval) {
          const where = task.sessionLabel ? `${task.sessionLabel}那边，` : ''
          const doing = task.report?.message || task.stage
          catchUp.push({
            taskId: task.id,
            speech: `${where}「${task.instruction}」还在跑${doing ? `：${doing}` : ''}。`,
            context: `任务 ${task.id} 还在跑${doing ? `：${doing}` : ''}。`,
            priority: 'high'
          })
        }
      }

      if (catchUp.length === 0) return
      notify({
        taskId: '',
        speech: '接上了。你不在的时候有几件事：',
        context: '语音重新接上了。下面几条是用户不在线期间攒下的，逐条转述给他。',
        priority: 'high'
      })
      for (const notice of catchUp) notify(notice)
    },

    /** 只给测试和排查用 */
    snapshot(): VoiceTask[] {
      return [...tasks.values()]
    }
  }
}
