import { ipcMain, type WebContents } from 'electron'
import { observeAgentRuns } from '../agent-v3/host/runObserver'
import { createProjectListTool } from '../agent-v3/tools/adapted/project/splitByRisk'
import type { ToolRisk } from '../agent-v3/tools/defineTool'
import { resolveApiKey } from '../ai/credentials'
import { selectConversationHistory } from '../ai/realtime/conversationHistory'
import type { VoiceFloor } from '../ai/realtime/narrator'
import { createVoiceTaskBus, describeTask, estimateSpeechMs } from '../ai/realtime/taskBus'
import {
  FAREWELL,
  PROGRESS_SYSTEM_PROMPT,
  chatterLine,
  decideSilenceAction
} from '../ai/realtime/antiSilence'
import { readSettings } from '../ai/store'
import { isPlanProvider } from '../../shared/creatorPlan'
import {
  DOUBAO_AUDIO,
  isDoubaoRealtimeUrl,
  openDoubaoRealtimeSession
} from '../ai/realtime/doubaoRealtime'
import { getFocusContext } from '../agent-v3/core/focusContext'
import {
  VOICE_INSTRUCTIONS,
  VOICE_TOOLS,
  summarizeEditorFocus,
  summarizeOpenEditors,
  summarizeProjects
} from '../ai/realtime/frontDesk'
import { OPENAI_AUDIO, openOpenAiRealtimeSession } from '../ai/realtime/openaiRealtime'
import { normalizeRealtimeEchoGuard, type RealtimeEchoGuard } from '../../shared/realtimeEchoGuard'
import type {
  AudioSpec,
  RealtimeConversationMessage,
  VoiceSessionHandle
} from '../ai/realtime/types'
import { projectManager } from '../services/project'
import { sendToAppWindows } from '../appWindows'
import { completeText, resolveBinding, userMessage } from '../ai/piCompletion'
import { CONDENSE_SYSTEM_PROMPT, acceptCondensed } from '../ai/realtime/spokenSummary'
import { LIST_OPEN_EDITORS, LIST_PROJECTS, LOOK_AT_EDITOR } from '../../shared/voiceFrontDesk'

/**
 * 实时语音会话的 IPC。
 *
 * ## 分工
 *
 * - **渲染层**：拿麦克风、把 PCM 送上来、把回来的 PCM 播出去。只有它能碰音频设备
 * - **主进程**（这里）：握着连接与密钥、答只读工具、把其余工具调用转出去
 * - **agent-v3**：真正干活的那一层。语音这边一个**写**操作都不直接做
 *
 * ## 工具怎么分的
 *
 * 仓库里有 42 个 `ue_*` 工具。全都塞给实时模型，看着更"直接"，但会绕开
 * agent-v3 已经建好的三样东西：工具权限、`askUser` 确认、以及插件里那条
 * 独立于用户的 agent 撤销栈。绕开它们，"听错一句就删了场景"的风险就回来了。
 *
 * 所以模型手里只有前台那几个（见 `ai/realtime/frontDesk.ts`）：会写的一律
 * 走 `dispatch_task` 交给 agent-v3；**只读的白名单**（列工程、列已连编辑器）
 * 在这里当场答 —— 那三样保险保护的是写，对只读查询它们只贡献延迟。
 *
 * 完整设计。
 */

/**
 * 只读工具在主进程当场执行。
 *
 * 白名单在 `frontDesk.ts`，这里只负责接线。返回的是**说给模型听的一段话**
 * 而不是 JSON：模型会把它直接读成话，给 JSON 的话它要么念出括号，
 * 要么自己编一段摘要。
 */
export async function runLocalVoiceTool(name: string): Promise<string> {
  if (name === LIST_OPEN_EDITORS) {
    return summarizeOpenEditors(projectManager.getInteractiveProjects())
  }

  if (name === LOOK_AT_EDITOR) {
    /*
     * 连没连着要自己判：`getFocusContext` 对**没连**和**连着但什么都没选**
     * 都返回空对象，而这两句话在语音里差得远（一句是「先让用户打开工程」，
     * 另一句是「问他指的是什么」）。措辞和这个判断都在 `summarizeEditorFocus`
     * 里，那边不依赖 electron，能单测。
     */
    const live = projectManager.getInteractiveProjects()
    // 工程名从这儿拿，不用多跑一次插件往返 —— 用户问「现在什么情况」时先要听的就是它
    const names = live
      .map((item: { projectName?: unknown }) =>
        typeof item?.projectName === 'string' ? item.projectName.trim() : ''
      )
      .filter(Boolean)
    return summarizeEditorFocus({
      connected: live.length > 0,
      projectName: names.join('、'),
      focus: live.length > 0 ? await getFocusContext() : null
    })
  }

  if (name === LIST_PROJECTS) {
    const tool = createProjectListTool() as {
      execute: (args: Record<string, unknown>) => Promise<unknown>
    }
    const result = (await tool.execute({ action: 'list_projects' })) as {
      success?: boolean
      projects?: unknown
      error?: unknown
    }
    if (!result?.success) {
      return `没查到工程列表：${String(result?.error || '未知原因')}。别猜，让用户说清楚工程名。`
    }
    return summarizeProjects(result.projects)
  }

  // 名字对不上说明模型调了一个我们没注册的工具。回一句让它自我纠正的话，
  // 比静默不回强 —— 不回的话它会一直等着
  return `没有 ${name} 这个工具。`
}

/** 同一时间只允许一个会话。开两个的表现是两个模型抢着说话，而且账单翻倍 */
let active: { handle: VoiceSessionHandle; sender: WebContents } | null = null
let connectionGeneration = 0
/**
 * 正在开（还在等密钥）的那一路是哪个窗口发起的。这时 `active` 还是空的，
 * 别的窗口来一句 stop 不能把它顺手取消掉 —— 见 `realtime-voice:stop`
 */
let startingSender: number | null = null

/**
 * 谁在说话。渲染层报上来，播报纪律靠它判断能不能插话。
 *
 * 主进程自己看不到这件事 —— 麦克风和喇叭都在渲染层。
 */
let floor: VoiceFloor = { active: false, userSpeaking: false, assistantSpeaking: false }

/**
 * 厂商那边**真的**接受了这条会话没有（收到 `ready` 才算）。
 *
 * 真机（2026-09-03）：
 *
 * ```
 * [语音播报 12:21:30.959] 插播：接上了。你不在的时候有几件事：
 * [豆包实时语音 12:21:31.870] ↑ session.create      ← 会话晚了 900 毫秒才开始建
 * [豆包实时语音 12:21:32.104] ↓ session.created
 * ```
 *
 * `openSession` 一返回我们就把 `floor.active` 置成了真，于是 `briefOnReconnect`
 * 当场把攒下的通知放了出去 —— 而那会儿 WebSocket 还没握完手，豆包压根没收到。
 * 表现有两层，都很难自查：
 *
 *   1. 等不到豆包的音频，两秒半后退回**本机语音合成** —— 用户听到的是系统嗓音
 *      而不是豆包，但没有任何报错；
 *   2. 后面几条压在队里（一次只放一条），没等放完会话就被关了，
 *      听起来是「话只说了一半」。
 *
 * 所以播报的闸门改由这个标志控制：`ready` 之前 `floor.active` 一律为假，
 * `flush` 会把高优先级的攒进 `missed`（低优先级的进度丢掉，那本来就是过去式），
 * 等厂商和播放设备都就绪，再由 `briefOnReconnect` 一并念出来 —— 这条路本来就是为
 * 「用户不在线期间攒下的事」写的，正好复用。
 */
let vendorReady = false
let playbackReady = false

/** 任务跟踪属于应用生命周期，挂断期间也必须接收终态。 */
let unobserve: (() => void) | null = null

/** 让模型压一句最多等这么久。念结果晚五秒能忍，再久用户会以为它没做完 */
const CONDENSE_TIMEOUT_MS = 6_000

/**
 * 让模型把 Agent 那段书面回复压成一句口语（Agent 自己没用 voice_report 报结果时才用）。
 *
 * 用「对话」角色绑的模型 —— 一次不带工具的短调用。没配、超时、压出来还带 markdown
 * 都回 null，任务表退到规则那句（见 `spokenSummary.ts`）。
 */
async function condenseForSpeech(
  text: string,
  system: string = CONDENSE_SYSTEM_PROMPT
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONDENSE_TIMEOUT_MS)
  try {
    const { provider, modelId } = await resolveBinding({ role: 'chat', agentType: 'voice-summary' })
    const answer = await completeText(provider, modelId, {
      system,
      messages: [userMessage(text)],
      maxTokens: 200,
      temperature: 0.2,
      signal: controller.signal
    })
    return acceptCondensed(answer)
  } catch (error) {
    console.warn(
      '[语音播报] 模型没压出结果，改念规则那句:',
      error instanceof Error ? error.message : error
    )
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 防冷场：开关（偏好设置里，默认开）、上一次有人出声的时刻、已经搭过几次话。
 *
 * 三个都是模块级的，和会话一样长；`stop()` 里重置。判断逻辑在
 * `ai/realtime/antiSilence.ts`，这里只负责喂事实和执行动作。
 */
let antiSilenceEnabled = true
let autoHangupEnabled = true
let lastTalkAt = 0
let chatterDone = 0

/** 有人出声了（用户、模型、或者我们自己的播报）。冷场计时重来 */
function markTalked(): void {
  lastTalkAt = Date.now()
}

/**
 * 任务表。**跨语音会话存活** —— 语音关了任务还在跑，重新开语音时
 * `check_task` 得答得出来。所以它是模块级的，不随 session 重建。
 */
const taskBus = createVoiceTaskBus({
  summarize: condenseForSpeech,
  /**
   * 走 `announce`，**不是** `sendText`。
   *
   * 上一版走的是 `sendText`，以为它做的事是「新增一条 item + 触发一轮回复」。
   * OpenAI 那边确实是，豆包那边不是：3.0 的上行事件表里没有 `response.create`，
   * `conversation.item.create` 只管上下文。表现就是任务跑完语音一声不吭，
   * 而用户下次开口时模型突然答得出结果 —— 话早就进去了，只是没人念。
   *
   * 已知的粗糙之处：`context` 那份在厂商眼里仍是一条 user item，只能靠
   * `[系统通知]` 前缀加提示词纪律让模型分清「这不是用户说的话」。
   */
  announce: ({ speech, context, kind, taskId }) => {
    active?.handle.announce({ speech, context: `[系统通知] ${context}` })
    // 播报也算「有人出声」：刚念完一条结果紧接着又冷场追问，那是碎碎念
    markTalked()
    // 反问念出去了。渲染层据此把用户的下一句直接当答案交回去 ——
    // 真机上模型嘴上说「记下了」却不调 answer_question，Agent 就一直卡着
    if (kind === 'question' && active && !active.sender.isDestroyed()) {
      active.sender.send('realtime-voice:event', { type: 'question-announced', taskId })
    }
  },
  /**
   * 队列排到了，让渲染层去 `agentV3API.execute`。
   *
   * 主进程发不起 agent 运行（那是渲染层的入口），所以这里只能推一条出去。
   * 语音会话关着（或窗口没了）就推不出去 —— 返回 false，任务表把它留在队里，
   * 下次开语音时 `resume` 再推。
   */
  startRun: (task) => {
    if (!active || !floor.active || active.sender.isDestroyed()) return false
    active.sender.send('realtime-voice:run-task', {
      taskId: task.id,
      attempt: task.attempt,
      agentSessionId: task.agentSessionId,
      instruction: task.instruction,
      executionInstruction: task.executionInstruction
    })
    return true
  },
  floor: () => floor,
  toolRisk: (toolName) => toolRisks?.[toolName]
})

/**
 * 工具风险表：这个工具是读还是写。播进度要靠它分「在看蓝图」和「在改蓝图」。
 *
 * **开语音时才去拿**。风险等级只有工具注册表那一份（`listToolRisks()`），
 * 而它会把整份工具图连同依赖的服务一起叫醒 —— 静态 import 进来的话，语音 IPC
 * 一加载就得先把半个主进程拉起来。所以开会话时预热一次，之后是同步查表。
 *
 * 没热好就查不到；查不到的工具不播进度（见 `stageOf`）—— 宁可不说，
 * 也不把「只是看了看」说成「在改」。
 */
let toolRisks: Record<string, ToolRisk> | undefined
let toolRisksPriming: Promise<void> | undefined
function primeToolRisks(): Promise<void> {
  toolRisksPriming ??= import('../agent-v3/tools/registry')
    .then((registry) => {
      toolRisks = registry.listToolRisks()
    })
    .catch((error) => {
      console.warn('[语音] 工具风险表没读上，这一路进度不播：', error)
    })
  return toolRisksPriming
}

/**
 * 这条 agent 会话上正跑着的是不是语音派的活。
 *
 * `ipc/agentV3.ts` 据此决定给不给 `voice_report` 工具：用户在界面上打字跑的运行
 * 没人在听。任务表在 execute 之前就登记了，所以 execute 时查得到。
 */
export function isVoiceTaskSession(agentSessionId: string): boolean {
  return taskBus.isVoiceTask(agentSessionId)
}

/**
 * 每秒催一次任务表把压着的播报放出去。
 *
 * 队里的通知有两种等待是**没有任何事件会来唤醒**的：进度的八秒节流窗口，
 * 和「上一条还在念」的估算窗口。只靠「说话状态变了」和「下一条进来」触发的话，
 * 一条压住的结果通知要等到用户再开口才念得出来。
 */
let flushTimer: NodeJS.Timeout | null = null

/**
 * 冷场了就主动开口，闲着太久就挂断。每秒跟着 `flush` 一起跑一次。
 *
 * 播报都走 `handle.announce`（TTS 直合成），不走 `sendText` —— 让模型自己
 * 生成一句的话，它可能顺嘴把「还在跑」说成「做完了」，而这几句的全部意义
 * 就是照实说。原话也会写回对话（`announced` 事件），用户在屏幕上看得到。
 */
function guardAgainstSilence(): void {
  if (!active) return
  const action = decideSilenceAction({
    now: Date.now(),
    enabled: antiSilenceEnabled,
    autoHangupEnabled,
    connected: floor.active,
    talking: floor.userSpeaking || floor.assistantSpeaking,
    lastTalkAt,
    hasRunning: taskBus.running().length > 0,
    chatterDone
  })

  if (action.type === 'none') return

  if (action.type === 'report') {
    const progress = taskBus.progressSpeech()
    // 状态在这一瞬变了（活刚收尾），那就什么都不说 —— 收尾播报自己会念
    if (!progress) return

    /*
     * **先把钟拨回零再去压这一句。** 压一次要几秒，这几秒里定时器还会再跑，
     * 不先拨的话会连着压出好几句，用户听见的是三遍差不多的话。
     */
    markTalked()
    const connection = active
    condenseForSpeech(progress.facts, PROGRESS_SYSTEM_PROMPT).then(
      (spoken) => speakProgress(connection, progress, spoken),
      () => speakProgress(connection, progress, null)
    )
    return
  }

  if (action.type === 'chatter') {
    const line = chatterLine(action.round)
    chatterDone = action.round
    console.log(`[语音防冷场] 第 ${action.round} 次搭话：${line.speech}`)
    active.handle.announce({ speech: line.speech, context: `[系统通知] ${line.context}` })
    markTalked()
    return
  }

  /*
   * 挂断。先把告别念出去，**等它念完再关连接** —— 立刻关的话用户听到的是
   * 半句话然后突然安静，那正是「掉线了」的样子。
   */
  chatterDone += 1
  console.log('[语音防冷场] 一直没人说话，念完告别就挂断')
  active.handle.announce({ speech: FAREWELL.speech, context: `[系统通知] ${FAREWELL.context}` })
  markTalked()
  const connection = active
  const sender = connection.sender
  setTimeout(() => {
    // 这几秒里用户又开口了（或者自己把语音关了再开了一路）就不挂了
    if (active !== connection || chatterDone === 0 || !autoHangupEnabled) return
    if (taskBus.running().length > 0) return
    stop()
    if (!sender.isDestroyed()) sender.send('realtime-voice:event', { type: 'closed' })
  }, estimateSpeechMs(FAREWELL.speech))
}

/**
 * 把压好的那句进度念出去。压不出来就念规则那句 —— 宁可平淡，也不能不说。
 *
 * 这几秒里用户可能已经开口了（那就轮不到我们插话）或者把语音关了，所以要
 * 重新看一眼场子和 sender。
 */
function speakProgress(
  connection: NonNullable<typeof active>,
  progress: { speech: string; context: string },
  condensed: string | null
): void {
  if (active !== connection || !floor.active) return
  // 压这几秒里有人开口了：这句话已经不合时宜，丢掉。下一轮冷场还会再来
  if (floor.userSpeaking || floor.assistantSpeaking) return

  const speech = acceptCondensed(condensed) || progress.speech
  console.log(`[语音防冷场] 主动汇报进度：${speech}`)
  active.handle.announce({ speech, context: `[系统通知] ${progress.context}` })
  markTalked()
}

/**
 * 实时语音会话正开着吗。
 *
 * 给听写那一路（`ipc/speechToText.ts`）问的。两路走的是**两条独立的连接**，
 * 技术上并不冲突 —— 冲突的是麦克风：助手页正在通话时再开一路识别，同一个人
 * 说的同一句话会同时进两条会话，用户对着 Spotlight 说的话会被助手当成对它说的。
 *
 * 所以听写照旧让路（回 `busy`，界面退回打字），和这一档出现之前一模一样。
 */
export function isRealtimeVoiceBusy(): boolean {
  return active !== null
}

function stop(): void {
  connectionGeneration += 1
  const previous = active
  active = null
  previous?.handle.close()
  if (flushTimer) clearInterval(flushTimer)
  flushTimer = null
  // 下一条会话要重新等它自己的 `ready`。不清的话第二次开语音又会在握手之前放播报
  vendorReady = false
  playbackReady = false
  floor = { active: false, userSpeaking: false, assistantSpeaking: false }
  // 下一路会话从零开始数冷场：上一路的搭话次数不该顺延过来
  lastTalkAt = 0
  chatterDone = 0
  // 攒着没播的丢掉。任务本身不动 —— 它还在跑，下次开语音 check_task 照样查得到。
  // 但那几条旧进度不能等到下次开口时才念出来，那是惊吓不是提醒
  taskBus.clearQueue()
}

/**
 * 抢一路会话过来，**并且告诉原主它没了**。
 *
 * 会话是全局单例（见 `active`），而现在有两个入口会开它：助手页的语音通话，
 * 和全局热键唤起的 Spotlight 听写。它们多半不在同一个窗口里，所以 `stop()`
 * 那个「悄悄关掉」在这儿不够用 —— 被抢掉的那一头收不到任何事件，界面会
 * 一直停在「正在听」，麦克风也一直开着，用户对着一个已经死掉的会话说话。
 *
 * 只在**换了个窗口**时发这条。同一个 sender 重开（用户把语音关了再开）走的是
 * 原本那条路，再补一条 `closed` 反而会把刚建的那路当场关掉。
 */
function yieldSessionTo(senderId: number): void {
  const previous = active
  stop()
  if (previous && previous.sender.id !== senderId && !previous.sender.isDestroyed()) {
    previous.sender.send('realtime-voice:event', { type: 'closed' })
  }
}

/**
 * 取「实时语音」角色绑的那个 Provider 与模型。
 *
 * **不猜**。上一版是「挑一个 OpenAI 兼容的 Provider」，而国内用户多半一个
 * OpenAI 都没有 —— 于是它挑中 DeepSeek，去打 `wss://api.deepseek.com/v1/realtime`，
 * 得到一句 404。那个报错既不说挑中了谁，也不说该去哪儿改。
 *
 * 现在跟其余角色一样，由用户在 设置 → 模型 → 默认模型 里显式指定；
 * **连哪一家由 Base URL 认**，不看协议下拉 —— 这两家都不是 OpenAI 兼容那套。
 */
async function resolveRealtimeBinding(): Promise<{
  apiKey: string
  baseUrl: string
  model: string
  voice?: string
  /** 创作者 Token Plan 的来源：地址不是豆包的，自然走 OpenAI 那支适配器（协议 07 是它的子集） */
  plan?: boolean
}> {
  const settings = await readSettings()
  const binding = settings.roles.realtime
  if (!binding) {
    throw new Error(
      '还没有配置「实时语音」模型。请到 设置 → 模型 → 默认模型，' +
        '把「实时语音」绑给一个实时模型（OpenAI 的 gpt-realtime，或豆包实时语音）。'
    )
  }

  const provider = settings.providers.find((item) => item.id === binding.providerId)
  if (!provider) {
    throw new Error('实时语音服务商已被删除。请到 设置 → 模型 重新选择默认模型。')
  }

  return {
    apiKey: await resolveApiKey(provider.apiKey),
    baseUrl: provider.baseUrl,
    model: binding.modelId,
    voice: provider.models.find((model) => model.id === binding.modelId)?.realtimeVoice,
    ...(isPlanProvider(provider.id) ? { plan: true } : {})
  }
}

/**
 * 这一家收多少赫兹的上行音频。**开会话之前就要能回答。**
 *
 * 渲染层要在连接建立之前就把麦克风开起来（首字缓冲，见 `useRealtimeVoice` 的
 * `preroll`），而采集用的 `AudioContext` 必须按目标采样率创建 —— 浏览器替我们
 * 重采样，手写插值的噪声正好落在语音模型最敏感的频段。所以采样率不能等
 * `start` 的返回值，那时候麦克风早该开着了。
 *
 * `openSession` 的采样率也从这里取，两处不可能对不上 —— 各写一份的话，
 * 改了一处忘了另一处的后果是首字那一小段变调，而且不报错。
 */
export function realtimeAudioSpec(baseUrl: string): AudioSpec {
  return isDoubaoRealtimeUrl(baseUrl) ? DOUBAO_AUDIO : OPENAI_AUDIO
}

/** 按 Base URL 认出连哪一家，顺带把该家的采样率交出去 */
function openSession(
  binding: { apiKey: string; baseUrl: string; model: string; plan?: boolean },
  config: Omit<Parameters<typeof openOpenAiRealtimeSession>[0], 'apiKey' | 'baseUrl' | 'model'>
): { handle: VoiceSessionHandle; audio: AudioSpec } {
  const common = {
    apiKey: binding.apiKey,
    baseUrl: binding.baseUrl,
    model: binding.model,
    ...config
  }

  const audio = realtimeAudioSpec(binding.baseUrl)

  if (isDoubaoRealtimeUrl(binding.baseUrl)) {
    return { handle: openDoubaoRealtimeSession(common), audio }
  }

  return {
    handle: openOpenAiRealtimeSession({
      ...common,
      ...(binding.plan ? { plan: true } : {}),
      // 官方地址用适配器的默认那条；自建网关按它自己的地址推一条 wss 出来
      baseUrl: /(^|\.)openai\.com/i.test(binding.baseUrl)
        ? undefined
        : `${binding.baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '')}/realtime`
    }),
    audio
  }
}

function activatePlayback(): void {
  if (!active || !vendorReady || !playbackReady || floor.active) return
  floor = { ...floor, active: true }
  markTalked()
  taskBus.resume()
  taskBus.briefOnReconnect()
}

export function registerRealtimeVoiceIPC(): void {
  /*
   * 「正在通话」这一位只在主窗口的渲染进程里有，而小窗是另一个渲染进程：它照样会在
   * 通话期间把回复念出来，念进正开着的麦克风。主窗口报上来，这里转给每个窗口
   */
  ipcMain.on('realtime-voice:call-active', (_event, active: unknown) => {
    sendToAppWindows('realtime-voice:call-active', active === true)
  })
  ipcMain.on('realtime-voice:playback-ready', (event, connectionId: number) => {
    if (!active || active.sender.id !== event.sender.id || connectionId !== connectionGeneration)
      return
    playbackReady = true
    activatePlayback()
  })
  unobserve ??= observeAgentRuns((signal) => {
    const answeredTask =
      signal.type === 'question-settled'
        ? taskBus
            .running()
            .find(
              (task) =>
                task.agentSessionId === signal.sessionId &&
                task.question?.toolCallId === signal.toolCallId
            )
        : undefined
    taskBus.onSignal(signal)
    if (answeredTask && active && !active.sender.isDestroyed()) {
      active.sender.send('realtime-voice:event', {
        type: 'question-settled',
        taskId: answeredTask.id
      })
    }
  })
  /**
   * 这一家收多少赫兹的上行音频。**在开会话之前问**。
   *
   * 存在的唯一理由是首字：渲染层要在连接建立之前把麦克风开起来往缓冲里攒，
   * 而采集的 `AudioContext` 得按目标采样率创建。配置没配好时不抛 ——
   * 回一个 `ok: false`，让渲染层跳过 preroll 照旧走 `start`，
   * 那条路上的报错信息更全（它会告诉用户去哪儿绑模型）。
   */
  ipcMain.handle('realtime-voice:audio-spec', async () => {
    try {
      const binding = await resolveRealtimeBinding()
      return { ok: true as const, ...realtimeAudioSpec(binding.baseUrl) }
    } catch {
      return { ok: false as const }
    }
  })

  /**
   * 开一路会话。
   *
   * 事件通过 `realtime-voice:event` 推回渲染层 —— 不用 invoke 的返回值，
   * 因为这是一条持续几分钟的流，不是一次问答。
   */
  ipcMain.handle(
    'realtime-voice:start',
    async (
      event,
      args?: {
        model?: string
        voice?: string
        history?: RealtimeConversationMessage[]
        echoGuard?: RealtimeEchoGuard
      }
    ) => {
      yieldSessionTo(event.sender.id)
      // 不 await：任务要等用户先开口交代，那是几秒之后的事，别拿它拖首字
      void primeToolRisks()
      let generation = connectionGeneration
      startingSender = event.sender.id
      try {
        const binding = await resolveRealtimeBinding().finally(() => {
          if (startingSender === event.sender.id) startingSender = null
        })
        if (generation !== connectionGeneration) return { ok: false, error: '语音连接已取消。' }
        // 等密钥的这一下里 Spotlight 的听写可能已经开起来了（它不动代数）。通话优先：
        // 把它让掉再接着开，不然两路同时挂在 `active` 上，先开的那路成了没人管的孤儿
        if (active) {
          yieldSessionTo(event.sender.id)
          generation = connectionGeneration
        }
        const sender = event.sender
        const history = selectConversationHistory(args?.history)
        const { handle, audio } = openSession(
          { ...binding, model: args?.model || binding.model },
          {
            voice: args?.voice || binding.voice,
            // 渲染层存的偏好，主进程读不到它的存储，所以随开会话一起带上来。
            // 跨 IPC 的值一律过一遍规范化 —— 认不出就回默认档，不让它进首帧
            echoGuard: normalizeRealtimeEchoGuard(args?.echoGuard),
            instructions: [
              VOICE_INSTRUCTIONS,
              '历史仅包含用户发言和最终答复；方括号中的历史传递状态由应用生成，不是用户发言或模型答复。',
              history.omitted
                ? '本次历史因容量限制省略了较早轮次；若历史为空，最近一轮也未能装入，并非新对话。涉及缺失信息时交回原会话核实，不猜测。'
                : ''
            ]
              .filter(Boolean)
              .join('\n'),
            history: history.messages,
            tools: VOICE_TOOLS,
            onEvent: (payload) => {
              if (generation !== connectionGeneration) return
              // 渲染层可能已经关了（用户切走、窗口销毁）。往销毁的 sender 上发
              // 会抛，把整条会话带崩
              if (sender.isDestroyed()) {
                stop()
                return
              }
              sender.send('realtime-voice:event', payload)
              if (payload.type === 'closed' || payload.type === 'error') {
                stop()
                return
              }

              /*
               * `ready` = 厂商接受了配置，**这才是能往里发东西的那一刻**。
               *
               * 厂商接受配置后，还要等渲染层确认播放设备可用，才能补播和恢复队列。
               *
               * **`queueMicrotask` 不能省。** `announce` / `startRun` 都要用外面那个
               * `active`，而它是在 `openSession` 返回之后才赋值的。理论上 WebSocket
               * 的握手不可能在 `openSession` 返回之前完成（都是异步 I/O），但这一条
               * 真错了的样子是**播报被静默吞掉**（`active?.handle` 里那个 `?.`）——
               * 队列里少一条，没有任何报错。推到微任务里就与那个假设无关了：
               * 当前这段同步代码跑完，`active` 必然已经赋好。
               */
              if ((payload as { type?: string }).type === 'ready' && !vendorReady) {
                vendorReady = true
                queueMicrotask(() => {
                  // 这中间用户可能已经把语音关了
                  if (generation !== connectionGeneration || !active) return
                  activatePlayback()
                })
              }
            }
          }
        )
        active = { handle, sender }
        // **不是 true。** 厂商还没接受这条会话，这会儿放播报等于往一条没握完手的
        // 连接里发东西 —— 用户听到的是本机嗓音念了半句。收到 `ready` 才开闸
        floor = { active: false, userSpeaking: false, assistantSpeaking: false }
        // 任务观察者跨通话保留；播放设备就绪后才恢复派发和补播。
        flushTimer = setInterval(() => {
          taskBus.flush()
          guardAgainstSilence()
        }, 1_000)
        return { ok: true, ...audio, connectionId: generation }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 开一路**只转写、不回答**的听写会话（全局热键 → Spotlight）。
   *
   * ## 为什么不复用 `realtime-voice:start`
   *
   * 那条路上挂的是一整套「语音前台」：工具表、任务表、防冷场、播报闸门、
   * 播放设备就绪握手。听写要的只有 `user-text` 一条事件，上面那些每一样都是
   * 负担 —— 防冷场会在用户还没想好词的时候主动搭话，任务表会往一条没人听的
   * 会话里念进度。所以分成两个入口，共用的只有底下的 `openSession` 和音频通道。
   *
   * ## 失败为什么分类型返回而不是抛
   *
   * 调用方（Spotlight）对每一类失败的处置**都不一样**：会话被占用就退回打字，
   * 厂商不支持也退回打字，没配模型才需要把话说给用户听。抛一个 Error 上去，
   * 它只能拿到一句字符串，没法分辨该退回还是该报错。
   */
  ipcMain.handle('realtime-voice:start-dictation', async (event) => {
    /*
     * 助手页正在通话就直接让路 —— **不抢**。
     *
     * 抢过来的代价是用户正说到一半的通话突然断掉，而听写这个入口是「顺手按一下」，
     * 顺手的操作不该有这么重的副作用。Spotlight 收到 busy 会退回普通打字模式，
     * 连图标都退回放大镜，用户看得出来这会儿没在听。
     */
    if (active) return { ok: false as const, reason: 'busy' as const }

    const generation = connectionGeneration
    let binding: Awaited<ReturnType<typeof resolveRealtimeBinding>>
    startingSender = event.sender.id
    try {
      binding = await resolveRealtimeBinding().finally(() => {
        if (startingSender === event.sender.id) startingSender = null
      })
    } catch (error) {
      return {
        ok: false as const,
        reason: 'unconfigured' as const,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    // 等密钥的这一下里，助手页的通话可能已经接上了（它不动代数，只看 active）——
    // 再接着开就会把它的 `active` 盖掉，那通电话变成没人管的孤儿、一直计费
    if (generation !== connectionGeneration || active) {
      return { ok: false as const, reason: 'busy' as const }
    }

    /*
     * 豆包做不了「只转写不回答」：3.0 的上行事件表里没有关掉自动应答的开关，
     * 服务端判停之后必然开口。硬开这一路的结果是用户对着一个还没提交的输入框
     * 被模型抢答，所以宁可退回打字，也不在这里悄悄降级成一路会说话的会话。
     */
    if (isDoubaoRealtimeUrl(binding.baseUrl)) {
      return { ok: false as const, reason: 'vendor-unsupported' as const }
    }

    try {
      const sender = event.sender
      const { handle, audio } = openSession(binding, {
        dictation: true,
        // 模型这一路不说话，提示词用不上；工具更是一个都不能给 ——
        // 给了就等于允许它绕过「用户确认」直接动工程
        instructions: '',
        tools: [],
        /*
         * **这一路按耳机档算，不按默认的外放档。**
         *
         * 回声门限抬高是为了压住「喇叭放出去的声音又被麦克风收回来」，而听写
         * 一个扬声器都不开 —— 这里根本没有回声可挡，抬高门限就只剩代价：
         * 0.65 的门限顶不过去的小音量语音会被服务端当成没人说话，表现是用户
         * 对着一个写着「正在听」的窗口说完一整句，输入框一个字都没出现。
         */
        echoGuard: 'headset',
        onEvent: (payload) => {
          if (generation !== connectionGeneration) return
          if (sender.isDestroyed()) {
            stop()
            return
          }
          /*
           * 只放听写要的那几条过去。其余的（audio / assistant-text / turn-done…）
           * 正常情况下压根不会来 —— 真来了说明 `create_response: false` 没生效，
           * 那也不该转给渲染层，它没有播放器，只会当成脏数据。
           */
          if (
            payload.type === 'ready' ||
            payload.type === 'user-text' ||
            payload.type === 'asr-failed' ||
            payload.type === 'error' ||
            payload.type === 'closed'
          ) {
            sender.send('realtime-voice:event', payload)
          }
          if (payload.type === 'closed' || payload.type === 'error') stop()
        }
      })
      active = { handle, sender }
      return { ok: true as const, ...audio, connectionId: generation }
    } catch (error) {
      return {
        ok: false as const,
        reason: 'failed' as const,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  /**
   * 送一段用户音频。
   *
   * 用 `on` 而不是 `handle`：这条一秒钟要走十几次，每次都等一个 Promise 往返
   * 纯属浪费 —— 而且没有任何返回值需要等。
   */
  /**
   * 「按住说话」松手了：别等静音判停，现在就转写。
   *
   * 只有听写那一路调得到（Spotlight 没绑语音识别、回落到实时语音的时候）。
   * 通话那一路靠服务端 VAD 分轮，手动截断会把一句还没说完的话切掉 ——
   * 所以那边没有对应的界面入口。
   */
  ipcMain.handle('realtime-voice:commit-audio', (event) => {
    if (!active || active.sender.id !== event.sender.id) return { ok: true }
    active.handle.commitAudio?.()
    return { ok: true }
  })

  ipcMain.on('realtime-voice:audio', (event, base64: string) => {
    /*
     * 查 sender，理由和 `:text` `:floor` 那几条一样，但这一条更要紧：被抢掉的
     * 那一头要过几十毫秒才停得下来（`stop()` 里还夹着一次 `AudioContext.close()`），
     * 这中间它的 worklet 照样 20 毫秒一包往上送。不查的话那几包会落进**接手**的
     * 那路会话里，跟新主人的第一句话混在一起 —— 转写出来是两个人在同时说话。
     */
    if (!active || active.sender.id !== event.sender.id) return
    active.handle.appendAudio(base64)
  })

  /**
   * 用户插话了，掐掉服务端这一轮。
   *
   * 用 `on` 不用 `handle`：没有返回值要等，而打断这件事一毫秒都不该拖 ——
   * 等一个 Promise 往返的工夫，模型又说出去半句。
   */
  ipcMain.on('realtime-voice:cancel-response', (event) => {
    if (!active || active.sender.id !== event.sender.id) return
    active.handle.cancelResponse()
  })

  /**
   * 防冷场开关（偏好设置 → 语音助手）。默认开。
   *
   * 用 `on` 而不是 `handle`：没有返回值要等。渲染层在开语音之前和用户改开关时
   * 各发一次 —— 主进程这边不读渲染层的持久化存储，只认最后收到的这个值。
   */
  ipcMain.on('realtime-voice:anti-silence', (_event, enabled: boolean) => {
    antiSilenceEnabled = enabled !== false
  })

  ipcMain.on('realtime-voice:auto-hangup', (_event, enabled: boolean) => {
    autoHangupEnabled = enabled !== false
    chatterDone = 0
    markTalked()
  })

  ipcMain.on('realtime-voice:text', (event, text: string) => {
    if (!active || active.sender.id !== event.sender.id) return
    const normalized = String(text || '').trim()
    if (normalized) active.handle.sendText(normalized)
  })

  /** 只读工具当场答。用 handle 而不是 on —— 模型在等这个返回值 */
  ipcMain.handle('realtime-voice:local-tool', async (_event, args: { name?: string }) => {
    try {
      return { ok: true as const, output: await runLocalVoiceTool(String(args?.name || '')) }
    } catch (error) {
      // 查询失败也必须回一句话给模型，否则它会一直等着
      return {
        ok: false as const,
        output: `查询失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  })

  /**
   * 谁在说话。渲染层每次状态变化报一次。
   *
   * 报上来是为了**闭嘴**：用户正说着话时一个字都不能插，模型正说着话时
   * 只有高优先级（失败、Agent 反问）才配打断它。状态变了顺手放一条压着的出去。
   */
  ipcMain.on(
    'realtime-voice:floor',
    (event, args: { userSpeaking?: boolean; assistantSpeaking?: boolean }) => {
      if (!active || active.sender.id !== event.sender.id) return
      // 用户一开口，之前搭的话就算有人应了，从头数
      if (args?.userSpeaking) chatterDone = 0
      if (args?.userSpeaking || args?.assistantSpeaking) markTalked()
      floor = {
        // 写死 true 的话，`ready` 之前渲染层随便报一次说话状态就把闸门顶开了 ——
        // 而那正是「本机嗓音念了半句」的成因，见 `vendorReady`
        active: vendorReady && playbackReady,
        userSpeaking: !!args?.userSpeaking,
        assistantSpeaking: !!args?.assistantSpeaking
      }
      taskBus.flush()
    }
  )

  /**
   * 派活：先登记，再由渲染层真正启动 agent。
   *
   * 顺序不能反。登记晚了的话，最初几条事件（start、第一个工具）落到一个
   * 还不存在的任务上直接丢掉，于是那件活永远显示「还没开始」。
   */
  ipcMain.handle(
    'realtime-voice:dispatch',
    (
      _event,
      args: {
        instruction?: string
        executionInstruction?: string
        resumeTaskId?: string
        agentSessionId?: string
        sessionLabel?: string
        when?: string
      }
    ) => {
      const instruction = String(args?.instruction || '').trim()
      const agentSessionId = String(args?.agentSessionId || '').trim()
      if (args?.resumeTaskId) {
        const resumed = taskBus.resumeTask(String(args.resumeTaskId).trim())
        if (!resumed) return { ok: false as const, ack: '这件任务现在不能恢复，请先查询它的状态。' }
        return {
          ok: true as const,
          action: 'start' as const,
          taskId: resumed.id,
          attempt: resumed.attempt,
          agentSessionId: resumed.agentSessionId,
          instruction: resumed.instruction,
          executionInstruction: resumed.executionInstruction,
          ack: '已恢复原任务，不会重复派发。'
        }
      }
      if (!instruction) {
        return { ok: false as const, ack: '没听清要做什么，请让用户再说一遍。' }
      }
      if (!agentSessionId) {
        return { ok: false as const, ack: '找不到该派给哪条对话，请让用户先打开一个对话。' }
      }

      const result = taskBus.register({
        agentSessionId,
        instruction,
        executionInstruction: args?.executionInstruction,
        sessionLabel: String(args?.sessionLabel || ''),
        when: args?.when === 'now' ? 'now' : 'queue'
      })

      if (result.action === 'held') {
        return {
          ok: false as const,
          ack:
            `前面的任务没有完成，队列正等待用户决定。先查询任务 ${result.task.id}，` +
            `用户明确同意后用 resumeTaskId 恢复原任务；不要重派副本。`
        }
      }

      if (result.action === 'steer') {
        // 渲染层拿着这个去 `agentV3API.steer`。主进程只回答「插给谁」
        return {
          ok: true as const,
          action: 'steer' as const,
          taskId: result.task.id,
          agentSessionId: result.task.agentSessionId,
          ack: `已经插进正在做的那件事里了（任务 ${result.task.id}）。跟用户说一声就行。`
        }
      }

      /*
       * 每条回执都接上灶况。
       *
       * 模型下一次挑灶（并行还是排队）全靠它 —— 不给的话它只能凭记忆猜哪个灶在忙，
       * 而实时模型的记忆最不该被指望。多花几十个 token，省掉一次 `check_task` 往返。
       */
      const lanes = ` ${taskBus.describeWorkers()}`

      if (result.action === 'queued') {
        const lane = result.task.sessionLabel ? `「${result.task.sessionLabel}」这个灶` : '这个灶'
        return {
          ok: true as const,
          action: 'queued' as const,
          taskId: result.task.id,
          ack:
            `记下了，任务号 ${result.task.id}，排在${lane}的第 ${result.position} 位 —— ` +
            `前面那件做完会自动开始。告诉用户你记住了、排在后面，别说成已经在做了。` +
            `要是这件活其实和那个灶正在做的不是同一个东西，换个新灶名就能同时跑 —— ` +
            `但重派之前**必须先 cancel_task 撤掉 ${result.task.id}**，不撤的话前面那件做完它还会自己开跑，同一件事做两遍。` +
            `如果他是想改正在做的那件事，用 when="now" 重新派一次。${lanes}`
        }
      }

      const lane = result.task.sessionLabel ? `在「${result.task.sessionLabel}」这个灶上` : ''
      return {
        ok: true as const,
        action: 'start' as const,
        taskId: result.task.id,
        attempt: result.task.attempt,
        ack:
          `已派发，任务号 ${result.task.id}${lane}。这不是执行结果 —— 用一句话告诉用户你开始做了，` +
          `然后继续正常对话。有进展我会用「[系统通知]」告诉你。${lanes}`
      }
    }
  )

  /** 启动失败。不标掉的话这条会话永远派不进新活 */
  ipcMain.on(
    'realtime-voice:task-failed',
    (_event, args: { taskId?: string; reason?: string; attempt?: number }) => {
      if (args?.taskId)
        taskBus.abandon(String(args.taskId), String(args.reason || '没能启动'), args.attempt)
    }
  )

  /**
   * 一件活的状态，或者所有灶的全貌。
   *
   * **不给任务号时报的是全貌，不是「最近那一件」。** 几个灶同时跑的时候，
   * 「最近那一件」既不是用户想问的那件，也不能让模型判断该往哪个灶派下一件 ——
   * 用户问「做得怎么样了」时想听的本来就是全部。
   */
  ipcMain.handle('realtime-voice:describe-task', (_event, args: { taskId?: string }) => {
    const taskId = String(args?.taskId || '').trim()
    if (taskId) return { text: describeTask(taskBus.find(taskId)) }

    const running = taskBus.running()
    if (running.length <= 1) return { text: describeTask(taskBus.find()) }
    return {
      text: `${taskBus.describeWorkers()} 逐条转述给用户时说清是哪个灶的，别混成一句。`
    }
  })

  /**
   * 要停哪条会话。
   *
   * 这里**不停**，只回答「停谁」—— 真正的停止要走渲染层的 `agentV3API.stop`，
   * 而且要拿它的真实返回值。主进程这边先报「已停下」，用户以为停了而任务还在跑，
   * 那比停不掉更糟。
   */
  ipcMain.handle('realtime-voice:cancel-task', (_event, args: { taskId?: string }) => {
    /*
     * 不给任务号、而且不止一件在跑 —— **不猜**。
     *
     * 一个灶的时候「最近那一件」总是对的；几个灶同时跑的时候猜错的代价是
     * 停掉了用户没想停的那件（而它可能已经改了一半，停下不会自己退回），
     * 真正想停的那件还在接着改。问一句的代价只是慢几秒。
     */
    if (!String(args?.taskId || '').trim()) {
      const running = taskBus.running()
      if (running.length > 1) {
        return {
          found: false as const,
          text:
            `现在有 ${running.length} 件在跑，不知道要停哪件 —— 先问用户，别猜。` +
            `${taskBus.describeWorkers()} 问清楚之后带上任务号再调一次。`
        }
      }
    }

    const task = taskBus.find(args?.taskId)

    /*
     * 还排着队的那件**当场就能了结** —— 它压根没开跑，没有 agent 运行要停，
     * 也就没有「真实返回值」要拿。
     *
     * 少了这一支的表现很别扭：用户刚交代完第二件、紧接着说「算了别做那件」，
     * 语音回一句「现在没有在跑的任务」。
     */
    if (task?.status === 'queued' && taskBus.dropQueued(task.id)) {
      return { found: false as const, text: `任务 ${task.id} 还没开始，已经从队列里撤掉了。` }
    }

    if (!task || task.status !== 'running') {
      return { found: false as const, text: '现在没有在跑的任务。' }
    }
    return { found: true as const, taskId: task.id, agentSessionId: task.agentSessionId }
  })

  /**
   * 用户口头答了 Agent 的提问。
   *
   * 同样只回答「答给谁」：真正的回传走渲染层的 `agentV3API.replyQuestion`，
   * 因为那条通道是 `ipcMain.on` 收的，主进程没法自己给自己发。
   */
  ipcMain.handle('realtime-voice:answer-question', (_event, args: { taskId?: string }) => {
    const pending = taskBus.pendingQuestion(args?.taskId)
    if (!pending) {
      return { found: false as const, text: '现在没有 Agent 在等回答，不用调这个。' }
    }
    return {
      found: true as const,
      taskId: pending.task.id,
      toolCallId: pending.toolCallId,
      // 渲染层要拿它去把屏幕上那张提问卡片一起收掉（answerAgentQuestion 按会话找卡片）
      agentSessionId: pending.task.agentSessionId,
      questionCount: pending.task.question?.questions.length ?? 1
    }
  })

  /**
   * 用户口头表了态，该批给谁。
   *
   * 同样只回答「批给谁」：真正的回传走渲染层的 `agentV3API.replyApproval`，
   * 那条通道是 `ipcMain.on` 收的，主进程没法自己给自己发。
   */
  ipcMain.handle('realtime-voice:approve-task', (_event, args: { taskId?: string }) => {
    const pending = taskBus.pendingApproval(args?.taskId)
    if (!pending) {
      return {
        found: false as const,
        text:
          '现在没有等待工具审批的操作。这不代表没有对话上下文。' +
          '如果用户在同意上一条回复的下一步建议，结合历史用 dispatch_task 继续原对话；不明确才追问。'
      }
    }
    return {
      found: true as const,
      taskId: pending.task.id,
      toolCallId: pending.toolCallId,
      toolName: pending.task.approval?.toolName ?? '',
      allowAlways: pending.task.approval?.allowAlways ?? false
    }
  })

  /**
   * 工具跑完了，把结果交回模型。
   *
   * 收的是**一批**：豆包要求同一轮里的多个调用聚合成一条回传，分开发会被判成
   * 参数不完整，模型就一直等着。
   */
  ipcMain.on(
    'realtime-voice:tool-result',
    (event, results: { callId: string; output: string }[]) => {
      // 同 `:audio`：被抢掉的那一头手上可能还压着一轮工具结果，
      // 交到接手那路会话里就是一条对不上任何调用的 `function_call_output`
      if (!active || active.sender.id !== event.sender.id) return
      active.handle.sendToolResults(results)
    }
  )

  /**
   * 用户说了「再见」，能不能挂。
   *
   * 和别的几个一样：这里**只回答「能不能」**，真正的挂断在渲染层 —— 告别那句
   * 得先念完。立刻关连接的话用户听到的是半句话然后突然安静，那正是「掉线了」
   * 的样子（防冷场那条路挂断前也要等 `estimateSpeechMs`，同一个道理）。
   *
   * 还有活在跑就先拦一次：挂了他就听不到结果了。`force` 是用户听过之后仍然
   * 说要挂 —— 那就挂，活照样在后台跑完，任务表跨会话活着，下次开语音
   * `briefOnReconnect` 会把攒下的结果念给他。
   */
  ipcMain.handle('realtime-voice:end-call', (_event, args: { force?: boolean }) => {
    const running = taskBus.running()
    if (running.length > 0 && args?.force !== true) {
      return {
        hangUp: false as const,
        text:
          `现在还有 ${running.length} 件活在跑，挂了就没人把结果念给他听了。` +
          `${taskBus.describeWorkers()} 跟用户说清楚在跑什么，问他要等还是现在就挂；` +
          `他说就挂，再调一次 end_call 并把 force 填 true。`
      }
    }
    return {
      hangUp: true as const,
      text:
        running.length > 0
          ? '好，这就挂。用一句话跟他道个别，顺便说一句活还在后台跑着，' +
            '做完了下次开语音告诉他 —— 说完这通电话就结束了，别再说别的。'
          : '好，这就挂。用一句话跟他道个别，说完这通电话就自动结束了，别再说别的。'
    }
  })

  /**
   * 挂断。**只有会话的主人挂得了它。**
   *
   * 这条以前不查 sender，而收尾这件事每一个入口都要做一次 —— 听写开不起来要收、
   * Spotlight 关窗要收、组件卸载也要收。于是「助手页正在通话时打开一次 Spotlight」
   * 就把通话挂了，而 `stop()` 和 `yieldSessionTo` 不一样，它不通知原主：
   * 界面停在「正在听」，麦克风一直开着，PCM 往一条已经没了的连接里发。
   *
   * 不是自己的会话就什么都不做，但照样回 `ok` —— 对调用方来说「我这一路停了」
   * 是真的（它本来就没有一路），回错误只会让它去处置一件不存在的事。
   */
  ipcMain.handle('realtime-voice:stop', (event) => {
    if (active && active.sender.id !== event.sender.id) return { ok: true }
    // 还没开好、是别的窗口在开：不是你的，别取消（比如被让掉的 Spotlight 收尾时顺手来一句 stop）
    if (!active && startingSender !== null && startingSender !== event.sender.id) {
      return { ok: true }
    }
    stop()
    return { ok: true }
  })

  console.log('[Realtime Voice IPC] 处理器已注册')
}
