import { ref, type Ref } from 'vue'
import i18n from '@renderer/i18n'
import { mediaPermissionErrorKey } from '@renderer/utils/mediaPermissionError'
import {
  ANSWER_QUESTION,
  APPROVE_TASK,
  CANCEL_TASK,
  CHECK_TASK,
  DISPATCH_TASK,
  END_CALL,
  LIST_SESSIONS,
  isLocalVoiceTool
} from '@core/shared/voiceFrontDesk'
import workletUrl from './pcmCapture.worklet.js?url'

/**
 * 实时语音会话的渲染层这一半。
 *
 * 分工：**这里只碰音频设备**（麦克风、喇叭）和前台的任务表，
 * 连接与密钥都在主进程。音频两个方向都是 base64 的 PCM16 单声道，
 * 采样率由主进程在 start 时告知 —— 各家要的不一样（OpenAI 是 24k），
 * 写死会得到一段变调的快放。
 *
 * ## 与「按住说话」的区别
 *
 * 那一版是录完一整段再上传，这一版是**开着麦克风连续送**、由服务端判停与打断。
 * 所以没有「按住」这回事，只有开和关；用户随时可以插话打断模型。
 *
 * ## 语音模型是前台，不是执行者
 *
 * 要动 UE 时它调 `dispatch_task`。这里不执行，而是把那句指令交给
 * `onInstruction` —— 真正干活的是 agent-v3，它带着工具权限、确认框和撤销栈。
 * 语音层绕过去的话，那三样保险一条都不剩。
 *
 * ## 派发为什么不能 await
 *
 * 上一版在这儿一直等到 agent 跑完才回传工具结果，期间整条实时会话被挂着：
 * 不说话、不理插话。那就是冷场。
 *
 * 现在**立刻**回一句「已派发」，任务在后台跑。进度和结果由**主进程的任务表**
 * （`ai/realtime/taskBus.ts`）盯着 agent 的事件流，按播报纪律注入回会话。
 * 这边只负责一件事：报告谁在说话，好让那边知道什么时候该闭嘴。
 *
 * 完整设计。
 */

/** 主进程推过来的事件。与 `openaiRealtime.ts` 的 VoiceSessionEvent 同形 */
export type VoiceEvent =
  | { type: 'ready' }
  | { type: 'user-text'; text: string; final: boolean }
  | { type: 'asr-failed' }
  | { type: 'assistant-text'; text: string }
  | { type: 'audio'; base64: string }
  | { type: 'tool-call'; callId: string; name: string; args: string }
  | { type: 'interrupted' }
  /** 用户这句说完了（服务端判停），识别结果还没到。只有 OpenAI 那家发 */
  | { type: 'user-speech-done' }
  | { type: 'turn-done' }
  /** 主进程让这边**自己念**这段话（豆包等不到自己的音频时的退路，见 `speakLocally`） */
  | { type: 'speak'; text: string }
  /** 一条播报发出去了，原话写进「语音助手」对话 */
  | { type: 'announced'; text: string }
  /** 替 Agent 问用户的那句念出去了 / 用户在界面上答掉了（主进程任务表发的） */
  | { type: 'question-announced'; taskId: string }
  | { type: 'question-settled'; taskId?: string }
  | { type: 'error'; message: string }
  | { type: 'closed' }

/**
 * 用户能理解的会话阶段。
 *
 * `thinking` 是语音模型自己在组织回答；`executing` 是它正在调工具。
 * 两者分开，用户才能知道「没反应」和「正在查编辑器」不是一回事。
 */
export type RealtimeVoicePhase =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'executing'
  | 'speaking'

/** 纯状态转换单独导出，避免 UI 与厂商事件各自猜一套状态。 */
export function nextRealtimeVoicePhase(
  current: RealtimeVoicePhase,
  event: VoiceEvent
): RealtimeVoicePhase {
  switch (event.type) {
    /*
     * `ready` 只表示**厂商接受了配置**，麦克风这时候还没开。
     *
     * 所以这里仍然是 `connecting` —— 上一版在这儿就报「正在听」，
     * 而真正开麦还要经过 getUserMedia 和 worklet 加载。中间这段时间用户
     * 看着「正在听」对麦克风说话，说的话一个字都没被采到，
     * 而界面从头到尾没有任何异常。真正转 `listening` 的地方在 `start()` 末尾。
     */
    case 'ready':
      return 'connecting'
    case 'interrupted':
      return 'listening'
    // 没听清也是回到听 —— 会话没坏，再说一遍就好
    case 'asr-failed':
      return 'listening'
    case 'user-text':
      return event.final ? 'thinking' : 'listening'
    case 'assistant-text':
    case 'audio':
      return 'speaking'
    case 'tool-call':
      return 'executing'
    /*
     * 这一轮说完了 —— 语音这条线就是在听了。
     *
     * 上一版这里要判「是不是还在 executing」，因为那时派发是阻塞的，
     * 显示「正在听」就是撒谎。现在任务在后台跑、语音真的在听，所以判断去掉了。
     * 后台任务的进度用户在聊天界面的 Agent 过程里看得到，不靠这个球。
     */
    case 'turn-done':
      return 'listening'
    case 'error':
    case 'closed':
      return 'idle'
    default:
      return current
  }
}

/** 一条可以派活的对话，或者这通电话的一个「灶」 */
export interface VoiceSessionRef {
  /** agent 会话号。派活时原样传给主进程 */
  agentSessionId: string
  /** 说给用户听的名字：灶名（「灯光」），或者别的对话的标题 */
  label: string
  /**
   * 灶的归一键。派给**别的对话**时没有这个 —— 那不是这通电话的灶。
   *
   * 和 `label` 分开是因为模型不会每次给一模一样的写法（「灯光」/「灯光调整」/
   * 「Lighting」），匹配得按归一后的键来，念出来得按它原本给的那个写法。
   */
  key?: string
  /**
   * 挑灶时有话要对模型说，接在派活回执后面。
   *
   * 只在**没按它的意思来**的时候才有：它没给灶名（我们替它排了队）、
   * 或者灶开满了。这两种情况下模型以为自己开了新灶、会告诉用户「同时在做」，
   * 而实际是排队 —— 不说清楚就是让它对用户撒谎。
   */
  note?: string
}

/** 会话清单念成一段话。空列表也要说清楚，模型才不会接着猜 */
export function describeSessions(sessions: VoiceSessionRef[]): string {
  const lines = sessions
    .filter((item) => item.agentSessionId)
    .map((item) => `${item.label || '未命名对话'}（id ${item.agentSessionId}）`)
  if (lines.length === 0) return '现在只有当前这一条对话，派活不用填 session。'
  return `可以派活的对话有 ${lines.length} 条：\n${lines.join('\n')}`
}

export interface RealtimeVoiceState {
  muted: Ref<boolean>
  canInterruptByVoice: Ref<boolean>
  setMuted: (muted: boolean) => void
  /** 会话开着 */
  active: Ref<boolean>
  /** 正在连（点了开始、还没 ready） */
  connecting: Ref<boolean>
  /** 当前可展示的业务阶段 */
  phase: Ref<RealtimeVoicePhase>
  /** 用户最近说的那句（含中间态） */
  userText: Ref<string>
  /** 模型这一轮说的话，累积 */
  assistantText: Ref<string>
  /** 当前正在播放的真实 PCM 响度，0 到 1。只给球体动效用。 */
  outputLevel: Ref<number>
  /**
   * 麦克风正在采到的真实响度，0 到 1。只给球体动效用。
   *
   * 有了它界面才分得清「你在说」和「它在说」—— 以前只有输出这一路，
   * 用户说话时球体一动不动，看着像没在听。
   */
  inputLevel: Ref<number>
  error: Ref<string | null>
  start: () => Promise<void>
  stop: () => Promise<void>
  /** 保持语音连接，键盘输入成为同一条实时会话的下一轮。 */
  sendText: (text: string) => void
  /**
   * 打断它，**手动的那种**（点球体、按快捷键）。
   *
   * 全双工之后开口说话本身就能打断（服务端 VAD 听得到，见 `shouldMuteUplink`），
   * 所以这条不再是唯一入口。留着管三种场合：不方便出声、本机语音合成正念着
   * 长通知（那一路上行仍是闭的）、以及回环没建起来的机器上仍是半双工。
   * 没在说话时调它是安全的空操作。
   */
  interrupt: () => void
  /** 它此刻在出声吗。界面据此决定「打断」按不按得动 */
  speaking: Ref<boolean>
}

export interface RealtimeVoiceHistoryMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface RealtimeVoiceOptions {
  microphoneDeviceId?: () => string
  /**
   * 挑一个「灶」来干这件活。不传 sessionId 的派发都落到它给的那条上。
   *
   * `worker` 是模型给的灶名，空串表示它没挑 —— 挑灶的规矩（同名合并、新名并行、
   * 满了排队、不填就排最近用的那个）在实现方 `ensureVoiceWorker` 里，这一层不判断。
   *
   * **有副作用**：灶不存在时会现建一条对话和 agent 会话号。所以只在真要派活时调，
   * 不能拿它当查询用 —— 提前调的话，开了语音没派活也会在侧边栏留一条空对话。
   */
  resolveSession: (worker?: string) => VoiceSessionRef
  /** 这通电话现在有哪些灶。只读，不建东西 —— 和 `resolveSession` 的区别就在这儿 */
  listWorkers?: () => VoiceSessionRef[]
  /**
   * 启动一次 agent 运行。
   *
   * **别在这里等它跑完。** 任务的状态、进度和结果都由主进程的任务表负责，
   * 它直接看 agent 的事件流 —— 比在这儿 await 一个 Promise 准，也不会
   * 因为界面切走就断掉。
   *
   * 没启动起来有两种报法：当场抛异常，或者稍后调 `fail(reason)`。后者是给
   * 「发起是异步的、失败要晚一点才知道」的入口用的 —— 聊天界面那条路就是：
   * invoke 要等整轮跑完才返回，「会话正在执行中」这种拒绝是回调里才到的。
   * 两种都会把那件活标成失败；已经落了终态的活再报一次是安全的。
   */
  onDispatch: (
    instruction: string,
    agentSessionId: string,
    fail: (reason: string) => void,
    executionInstruction?: string
  ) => Promise<void> | void
  /** 能派活的对话清单。不给就只有当前这条 */
  listSessions?: () => VoiceSessionRef[]
  /**
   * 停掉某条会话上的 agent。
   *
   * 返回**真实结果**：停不掉就返回 false，我们会照实告诉用户「没能停下」。
   * 一律报成功的话，用户以为停了、任务还在跑，那比停不掉更糟。
   */
  onCancel?: (agentSessionId: string) => Promise<boolean> | boolean
  /**
   * 把用户的口头回答交回给挂起的 `ask_user`。
   *
   * `answers` 与 Agent 问的那几问同序，空串表示这一问没答。
   */
  onAnswerQuestion?: (toolCallId: string, answers: string[], agentSessionId: string) => void
  /**
   * 把一句话插进**正在跑的那一轮**（agent-v3 的 steer）。
   *
   * 返回**真实结果**：插不进去就返回 false。一律报成功的话，用户以为改过来了，
   * 而 Agent 还在照原样做完。
   */
  onSteer?: (agentSessionId: string, instruction: string) => Promise<boolean> | boolean
  /**
   * 把用户对一次高风险操作的表态交回给挂起的审批。
   *
   * 这道确认拦的是「听错一句就删了场景」，所以拿不准一律 `reject` ——
   * 批错了的代价不对称：拒了大不了重来一次，批了可能是不可逆的。
   */
  onApprove?: (toolCallId: string, verdict: 'approve' | 'always' | 'reject') => void
  /** 开语音时把普通聊天的最近历史交给实时模型。 */
  getHistory?: () => RealtimeVoiceHistoryMessage[]
  /** 同步拍下登记时的原话，排队执行和重连不得重新取当前对白。 */
  prepareInstruction?: (instruction: string) => string
  /** 最终用户文本（语音识别或键盘输入）进入普通消息列表。 */
  onUserText?: (text: string) => void
  /** AI 字幕流式更新普通助手气泡。参数是本轮完整累计文本。 */
  onAssistantText?: (text: string) => void
  /** 一轮播报完成或被用户打断时，把助手气泡和历史落定。 */
  onAssistantDone?: (text: string) => Promise<void> | void
  /**
   * 一条播报发出去了（豆包念或本机念），原话写进「语音助手」对话。
   * 念出来的每一句用户都该在屏幕上看得到 —— 不然他听到一句话，对话里却没有。
   */
  onAnnouncement?: (text: string) => void
  /** 厂商无视 PCM 配置、返回压缩音频时给用户的安全提示 */
  unsupportedAudioMessage: string
  /** 这一段没听清时显示的话 */
  asrFailedMessage: string
  connectionTimeoutMessage?: string
}

/**
 * 「丢弃残片」最多持续这么久。
 *
 * 三秒足够被打断那一轮的在途分片走完，又短到用户察觉不出。
 * 这是个**兜底**，正常路径由「用户这句识别完了」提前解除。
 */
export const DISCARD_FALLBACK_MS = 3_000

/**
 * 消不掉回声的那一路说完之后，麦克风还要多闭嘴这么久。
 *
 * 房间的混响拖在最后一个采样点之后。卡在「喇叭停了」那一刻就放行，尾音正好从
 * 这个缝里漏进去 —— 真机上表现为凭空多出一两个字的「用户发言」（「好」「怎么」
 * 这种），模型于是开始回应自己刚说完的半句话，一来一回停不下来。
 *
 * 只作用在**没有回声消除保护**的那一路（本机语音合成）。厂商音频走回环之后
 * 由 AEC 管，不需要也不该加这段窗口 —— 加了就是在全双工里挖 400 毫秒的聋点。
 */
export const ECHO_TAIL_MS = 400

/**
 * 这一刻要不要把上行麦克风掐成静音。
 *
 * ## 走过的两版，和为什么都不对
 *
 * 1. **比响度**：「麦克风要比喇叭响 1.4 倍才算用户真在说话」。音箱离麦克风近的
 *    桌面上无解 —— 回声进麦克风的响度已经不低于用户自己说话的响度，
 *    那就不存在一条能把两者分开的阈值。
 * 2. **它出声就全闭**：调不准的余地没了，代价是**半双工** —— 它说话期间用户
 *    说什么都听不见，打断只能手动点球体或按快捷键。
 *
 * 两版的共同前提是「回声消不掉」。而那个前提本身是错的：Chromium 的 AEC
 * 一直都在，只是**参考信号丢了** —— 我们用 Web Audio 播放，而它的 AEC 参考取自
 * WebRTC 的渲染路径。播放绕一条本地 `RTCPeerConnection` 回环再进 `<audio>`，
 * 参考就有了（见 `createAecLoopback`），回声由 AEC 当场消掉，上行不用再闭。
 *
 * ## 所以现在只剩一种情况要闭嘴
 *
 * **本机语音合成在念的时候**（`speechSynthesis`，豆包等不到自己音频时的退路）。
 * 那一路的声音不经过我们的音频图，塞不进回环，AEC 参考不到它 ——
 * 不闭的话它会一字不差地把自己念的通知听回去，当成用户在说话。
 *
 * 回环没建起来（环境不支持 `RTCPeerConnection`、协商失败）也照旧闭 ——
 * 那时候我们确实没有回声消除，硬开全双工就是让它自问自答。
 *
 * **掐掉不等于不发。** 调用方要改发一包静音：豆包全双工靠上行音频流保活，
 * 停发几秒服务端就按超时断开（45000003）。
 */
export function shouldMuteUplink(input: {
  /** 本机语音合成正在念 —— 这一路的回声消不掉 */
  localSpeaking: boolean
  /** 厂商的音频正在播 */
  vendorSpeaking: boolean
  /** 回环建起来了吗。没建起来就没有回声消除，退回半双工 */
  aecReady: boolean
  /** 距离「消不掉回声的那一路」最后一次出声过了多久 */
  sinceQuietMs: number
}): boolean {
  const unguarded = input.localSpeaking || (!input.aecReady && input.vendorSpeaking)
  return unguarded || input.sinceQuietMs < ECHO_TAIL_MS
}

/**
 * 「用户正在说话」最多算这么久。
 *
 * 这个状态由识别的中间态置位、由识别完成或没听清解除。可万一解除的那条永远不来
 * （服务端把这一段吞了、或者本来就是回声触发的假识别），它就永久卡在「用户在说」——
 * 而主进程的播报纪律是用户在说时一个字都不插。表现是**任务跑完了语音一声不吭**，
 * 没有任何报错。六秒是一句话的量级，超过它还没有结论就当这段作废。
 */
export const USER_SPEAKING_FALLBACK_MS = 6_000

/**
 * 「模型正在说话」最多算这么久。
 *
 * 由文字增量或工具调用置位，由回合结束解除。回合结束那条事件豆包偶尔不发
 * （尤其是只调了工具没说话的回合），卡住的后果同上：播报全被压着。
 * 二十秒够它把一段话说完；模型一口气说更久的情况，播报晚二十秒也无妨。
 */
export const ASSISTANT_SPEAKING_FALLBACK_MS = 20_000

/**
 * 本机念通知时球体的呼吸幅度。
 *
 * 本机合成的声音不经过我们的音频图，量不到真实响度，只能给个定值。
 * 它**不再参与回声判断** —— 本机念的期间上行是整个闭着的（`shouldMuteUplink`），
 * 没有门限可调。纯粹是为了让球体在那几秒里别死着不动。
 */
export const LOCAL_SPEECH_LEVEL = 0.15

/**
 * 连接还没建好时，麦克风采到的音频最多攒这么久。
 *
 * 三十秒盖得住任何一次正常的握手（一到两秒），也盖得住网络很差那次。
 * 24kHz 的 Int16 攒满三十秒是 1.4 MB —— 为了不丢用户的第一个字，这个价钱不用犹豫。
 */
export const PREROLL_MAX_MS = 30_000

/**
 * 认定「这一包里有人在说话」的均方根门限。
 *
 * 拿它挑的是**从哪儿开始补发**，不是判停 —— 判停是服务端的事。定得低一点更安全：
 * 挑早了无非多送几包环境音，挑晚了就是把用户的第一个辅音切掉，
 * 而「第一个字被吞」正是这一整套缓冲要解决的问题。
 */
export const PREROLL_VOICE_RMS = 0.003

/**
 * 补发时，在第一声之前多留这么久。
 *
 * 门限是按整包的均方根算的，而一个字的起头（尤其是 p/t/k 这种爆破音）常常只占
 * 一包里的几毫秒，整包的均方根还压在门限之下。多留 100 毫秒把这段起音带上。
 */
export const PREROLL_LEAD_MS = 100

/** 一包麦克风数据多少毫秒。和 `pcmCapture.worklet.js` 里的 `PACKET_MS` 必须一致 */
export const PACKET_MS = 20

/**
 * 回环最多花这么久建起来。
 *
 * 整个语音的启动都卡在这一步等它，所以必须有个头。两秒足够本地协商加起播
 * （实测几十毫秒），超了就当没有回声消除、退回半双工 —— 语音照常能用。
 */
export const LOOPBACK_READY_MS = 2_000
export const CONNECTION_TIMEOUT_MS = 20_000

/**
 * 缓冲里从第几包开始补发。
 *
 * 全是静音（用户点完球体没说话）时返回 `-1` —— 一包都不补，别把几秒钟的
 * 环境底噪送进去让服务端当成一段发言。
 */
export function firstVoicePacket(levels: number[]): number {
  const at = levels.findIndex((level) => level >= PREROLL_VOICE_RMS)
  if (at < 0) return -1
  return Math.max(0, at - Math.ceil(PREROLL_LEAD_MS / PACKET_MS))
}

/** 均方根。`measurePcmLevel` 是它 ×4 截到 1（给球体看的），门限判断要用原值 */
export function rootMeanSquare(samples: Float32Array | Int16Array): number {
  if (samples.length === 0) return 0
  const scale = samples instanceof Int16Array ? 1 / 0x8000 : 1
  let sum = 0
  for (const sample of samples) {
    const normalized = sample * scale
    sum += normalized * normalized
  }
  return Math.sqrt(sum / samples.length)
}

export function detectEncodedAudio(base64: string): 'ogg' | 'wav' | null {
  const header = atob(base64).slice(0, 4)
  if (header === 'OggS') return 'ogg'
  if (header === 'RIFF') return 'wav'
  return null
}

/** 豆包与 OpenAI 的 PCM 都是 16-bit little-endian；显式解码，不依赖宿主机字节序 */
export function decodePcm16Le(base64: string): Float32Array {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const sampleCount = Math.floor(bytes.byteLength / 2)
  const samples = new Float32Array(sampleCount)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < sampleCount; i += 1) samples[i] = view.getInt16(i * 2, true) / 0x8000
  return samples
}

/**
 * PCM 的均方根响度。用真实音频驱动球体，不拿「正在说」状态假装波形。
 *
 * 两个方向共用它：播放那一路是 Float32（解码完的），麦克风那一路是 Int16
 * （worklet 直接转好的）。Int16 先按 ±32768 归一化 —— 不归一化的话 RMS 直接
 * 顶到上限，球体会在有声无声之间硬跳，看着像坏了。
 */
export function measurePcmLevel(samples: Float32Array | Int16Array): number {
  return levelFromRms(rootMeanSquare(samples))
}

/**
 * 均方根 → 球体用的 0..1。
 *
 * ×4 是因为正常语速的语音均方根大多落在 0.05–0.15，直接画出来球体几乎不动。
 * 单独一个函数是为了让「量一次、既判门限又画球体」的地方不用把这个系数抄第二遍。
 */
export function levelFromRms(rms: number): number {
  return Math.min(1, rms * 4)
}

/**
 * 播放这一路绕一条本地 WebRTC 回环，**为的是让 Chromium 的回声消除看得见它**。
 *
 * AEC 要拿「正在播出去的声音」当参考信号，而 Chromium 的参考取自 **WebRTC 的
 * 渲染路径** —— 直接 `connect(audioContext.destination)` 播出去的声音不在那条路上，
 * AEC 就是聋的。真机上的表现是模型自己的话被麦克风收回去、当成用户在说话，
 * 然后它开始跟自己对话（设计文档 §5.5.3）。上一版为此把上行整个闭掉，
 * 代价是半双工：它说话时用户说什么都听不见。
 *
 * 回环的做法是把音频接到 `MediaStreamDestinationNode`，经一对本地
 * `RTCPeerConnection` 送一圈，再挂到 `<audio>` 元素上播。对用户来说声音一样，
 * 对 Chromium 来说这就成了一路正经的 WebRTC 远端音频，AEC 的参考于是有了。
 *
 * **代价说清楚**：音频会过一遍 Opus 编解码，模型的嗓音会损失一点点高频；
 * 回环本身再加二三十毫秒延迟。换来的是用户随时能插话，这笔账不用算。
 *
 * 建不起来返回 `null`，调用方退回直连并保持半双工 —— 没有回声消除还开全双工，
 * 就是让它自问自答。**「建起来」的判据是那个 `<audio>` 真的开始播了**，
 * 不是协商成功：只协商完就返回的话，自动播放一旦被拒，音频全进了回环、
 * 一个音都出不来，而那比没有回声消除严重得多。
 */
export async function createAecLoopback(
  context: AudioContext
): Promise<{ node: AudioNode; close: () => void } | null> {
  if (typeof RTCPeerConnection === 'undefined') return null

  const destination = context.createMediaStreamDestination()
  const outbound = new RTCPeerConnection()
  const inbound = new RTCPeerConnection()
  const element = new Audio()

  const close = (): void => {
    element.srcObject = null
    element.pause()
    outbound.close()
    inbound.close()
  }

  try {
    outbound.onicecandidate = (event) => {
      if (event.candidate) void inbound.addIceCandidate(event.candidate)
    }
    inbound.onicecandidate = (event) => {
      if (event.candidate) void outbound.addIceCandidate(event.candidate)
    }

    // 超时也算没建起来。整个语音的启动都卡在这一步，宁可退回半双工也不能干等
    const playing = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), LOOPBACK_READY_MS)
      const settle = (ok: boolean): void => {
        clearTimeout(timer)
        resolve(ok)
      }
      inbound.ontrack = (event) => {
        element.srcObject = event.streams[0]
        element.play().then(
          () => settle(true),
          () => settle(false)
        )
      }
    })

    for (const track of destination.stream.getTracks()) {
      outbound.addTrack(track, destination.stream)
    }

    const offer = await outbound.createOffer()
    await outbound.setLocalDescription(offer)
    await inbound.setRemoteDescription(offer)
    const answer = await inbound.createAnswer()
    await inbound.setLocalDescription(answer)
    await outbound.setRemoteDescription(answer)

    if (!(await playing)) {
      console.warn('[Realtime Voice] 回环那一路没能开始播放，退回半双工')
      close()
      return null
    }
    return { node: destination, close }
  } catch (error) {
    console.warn('[Realtime Voice] 回声消除回环没建起来，退回半双工:', error)
    close()
    return null
  }
}

export function useRealtimeVoice(options: RealtimeVoiceOptions): RealtimeVoiceState {
  const muted = ref(false)
  const canInterruptByVoice = ref(false)
  let connectionTimer: ReturnType<typeof setTimeout> | null = null
  const active = ref(false)
  const connecting = ref(false)
  const phase = ref<RealtimeVoicePhase>('idle')
  const userText = ref('')
  const assistantText = ref('')
  const outputLevel = ref(0)
  const inputLevel = ref(0)
  const error = ref<string | null>(null)
  /** 它此刻在出声吗。界面据此决定「打断」按不按得动 */
  const speaking = ref(false)

  let micContext: AudioContext | null = null
  let micStream: MediaStream | null = null
  let playContext: AudioContext | null = null
  let unsubscribe: (() => void) | null = null
  /** 退订「队列排到了」的推送。不退的话开第二路语音会有两个监听在收 */
  let unsubscribeRunTask: (() => void) | null = null
  let settleHandshake: ((ready: boolean) => void) | null = null
  /** 让停止或失败中的旧启动流程无法在稍后继续占用麦克风 */
  let generation = 0
  /** 下一段音频该从什么时候开始放。连着排，段与段之间不能有缝 */
  let playCursor = 0
  /**
   * 已经排进队列、还没播完的那些。
   *
   * 必须留着引用才停得掉 —— 打断时只把游标归零没用，
   * 之前 `start()` 过的那几段照样会响。
   */
  let scheduled: AudioBufferSourceNode[] = []
  /**
   * 量**喇叭此刻真正在响**的那个节点。所有播放都串过它再进 destination。
   *
   * 为什么不能拿「刚收到的那一包」的响度当输出响度：分片是**成批**到的 ——
   * OpenAI 常常半秒内把一整段五秒的回答推完，而喇叭要老老实实播五秒。
   * 按到达时间算的话，回声门限在最后一包到达后 140 毫秒就归零，
   * 剩下四秒多的播放里**门限是完全敞开的**，模型自己的声音被麦克风收回去、
   * 当成用户在说话，于是它开始跟自己对话。豆包按接近实时的节奏推，
   * 到达和播放差不多同步，所以同一份代码在那边看着是好的。
   *
   * 串一个分析节点不影响回声消除：输出仍然走默认输出通道，
   * Chromium 的 AEC 参考信号照样取得到。
   */
  let analyser: AnalyserNode | null = null
  // 泛型参数不能省：`getFloatTimeDomainData` 不收 SharedArrayBuffer 撑着的那种
  let analyserFrame: Float32Array<ArrayBuffer> | null = null
  /**
   * 让 Chromium 的回声消除看得见我们播的声音的那条回环（见 `createAecLoopback`）。
   *
   * `null` 表示没建起来 —— 那就没有回声消除，上行退回半双工。
   */
  let aecLoopback: { node: AudioNode; close: () => void } | null = null
  /**
   * 连接还没建好之前采到的音频，攒着（见 `PREROLL_MAX_MS`）。
   *
   * 上一版是**握手完成之后**才申请麦克风、加载 worklet，这中间说的话一个字都
   * 采不到。设计文档 §5.10 当时的解法是「让界面别撒谎」（`listening` 挪到
   * `start()` 末尾），但用户点完球体就开口是最自然的动作，
   * 撒不撒谎他都已经把第一句说掉了。
   */
  let preroll: { pcm: Int16Array; level: number }[] = []
  /**
   * 上行通了没有。没通的时候采到的音频进 `preroll`，不往外发。
   *
   * 和 `active` 分开：`active` 是「整条链路都好了」，会话建立到播放图搭好之间
   * 还有几步，那期间麦克风已经在采了。
   */
  let uplinkOpen = false
  let assistantTurnCommitted = false
  /**
   * 进出两个采样率**可能不一样** —— 豆包收 16k、出 24k。
   * 用一个数糊过去的话，要么模型听到变调的快放、要么用户听到变调的慢放，
   * 而两者都不报错。
   */
  let inputSampleRate = 24_000
  let outputSampleRate = 24_000

  /**
   * 谁在说话，上一次报给主进程的那份。
   *
   * 任务表在主进程，但「能不能插话」只有这边知道 —— 麦克风和喇叭都在渲染层。
   * 只在**变了**的时候报：这两个状态一秒钟要翻好几次，每次都发一条 IPC
   * 纯属浪费，而主进程收到相同的值也不会做任何事。
   */
  let reportedFloor = { userSpeaking: false, assistantSpeaking: false }

  /**
   * 用户刚插话，正在丢弃被打断那一轮的音频残片。
   *
   * 发了 `response.cancel` 也不够：网络上已经在途的分片照样会到，
   * 而 `stopPlayback()` 只清得掉**已经排进队列**的那些。不挡住后来的，
   * 表现就是「打断了一下，然后它接着说完」。
   *
   * 出口有两个，都对应「这一段用户输入有结论了、接下来是新一轮」：
   * 用户这句识别完成（`user-text` final），或者压根没听清（`asr-failed`）。
   * 不拿 `turn-done` 当出口 —— 被取消那一轮的收尾也会发它，会提前解除。
   */
  let discardingAudio = false
  let discardTimer: number | null = null

  /**
   * 开始/结束丢弃残片。
   *
   * **必须带兜底超时。** 出口靠的是「这一段用户输入有结论」，可万一那个结论
   * 永远不来（回声触发的假打断就是这样：识别到的是模型自己的声音，
   * 服务端未必给出终态），这个开关就永久卡在开着 —— 表现是**从此完全听不到
   * 任何回复**，而且没有任何报错。宁可多播一小段残片，也不能哑掉。
   */
  function setDiscardingAudio(on: boolean): void {
    discardingAudio = on
    if (discardTimer !== null) window.clearTimeout(discardTimer)
    discardTimer = null
    if (!on) return
    discardTimer = window.setTimeout(() => {
      discardingAudio = false
      discardTimer = null
    }, DISCARD_FALLBACK_MS)
  }

  let userSpeakingTimer: number | null = null
  let assistantSpeakingTimer: number | null = null
  /**
   * 模型点了工具、我们还没把结果交回去的那几次。
   *
   * 这期间模型的这一轮**没有结束**：它在等我们。回合结束事件可能在这中间到
   * （豆包对「只调了工具」的回合就发 response.done），不挡的话「模型在说话」
   * 会被清掉，播报就往一个正等着工具结果的模型里塞 —— 真机上那正是把会话弄哑的时刻。
   */
  let pendingToolCalls = 0

  /**
   * 替 Agent 问出去、还没答的那一问，以及用户在这之后说的那句。
   *
   * 真机上模型嘴上说「已经记下了」却**不调** answer_question，Agent 就一直卡着等。
   * 这条保险不经过模型：问题念出去之后，用户的下一句如果模型没拿去调任何工具，
   * 回合结束时由我们直接当答案交回去。模型自己调了工具（answer_question、cancel_task、
   * 别的都算）就不插手 —— 那说明它在按正常路走，或者用户说的是别的事。
   */
  let awaitingAnswer: { taskId: string; candidate: string } | null = null
  let toolCalledThisTurn = false

  async function forwardPendingAnswer(): Promise<void> {
    if (!awaitingAnswer || !awaitingAnswer.candidate || toolCalledThisTurn) return
    const answerGeneration = generation
    const { taskId, candidate } = awaitingAnswer
    awaitingAnswer = null
    const outcome = await answerQuestion([candidate], taskId)
    console.log(
      `[Realtime Voice ${new Date().toISOString().slice(11, 23)}] 模型没调 answer_question，把用户那句直接交回去了：`,
      candidate,
      outcome
    )
    if (answerGeneration !== generation || !active.value) return
    // 让模型知道交过了，别再调一次；豆包这条只进上下文，不会出声
    window.api.realtimeVoice.sendText(
      `[系统通知] 用户刚才那句「${candidate}」已经当作答案交给 Agent 了，不用再调 answer_question。`
    )
  }

  /**
   * 给两个「在说话」各配一条兜底。**每次上报都重新计时**，哪怕值没变 ——
   * 识别的中间态一秒钟来好几条，每条都是「用户还在说」的新证据。
   */
  function armFloorWatchdogs(userSpeaking: boolean, assistantSpeaking: boolean): void {
    if (userSpeakingTimer !== null) window.clearTimeout(userSpeakingTimer)
    userSpeakingTimer = null
    if (userSpeaking) {
      userSpeakingTimer = window.setTimeout(() => {
        userSpeakingTimer = null
        reportFloor(false, reportedFloor.assistantSpeaking)
      }, USER_SPEAKING_FALLBACK_MS)
    }

    if (assistantSpeakingTimer !== null) window.clearTimeout(assistantSpeakingTimer)
    assistantSpeakingTimer = null
    if (assistantSpeaking) {
      assistantSpeakingTimer = window.setTimeout(() => {
        assistantSpeakingTimer = null
        reportFloor(reportedFloor.userSpeaking, false)
      }, ASSISTANT_SPEAKING_FALLBACK_MS)
    }
  }

  function reportFloor(userSpeaking: boolean, assistantSpeaking: boolean): void {
    armFloorWatchdogs(userSpeaking, assistantSpeaking)
    if (
      reportedFloor.userSpeaking === userSpeaking &&
      reportedFloor.assistantSpeaking === assistantSpeaking
    ) {
      return
    }
    reportedFloor = { userSpeaking, assistantSpeaking }
    window.api.realtimeVoice.reportFloor(reportedFloor)
  }

  /**
   * 立刻掐掉正在播和已排队的音频。
   *
   * 游标要跟着归零，否则下一段会按"上一轮排到哪儿"接着排 ——
   * 表现是打断之后模型的新回答要等好几秒才出声。
   */
  function stopPlayback(): void {
    for (const source of scheduled) {
      try {
        source.stop()
      } catch {
        // 还没开始播的那些 stop 会抛，忽略即可
      }
    }
    scheduled = []
    playCursor = 0
    outputLevel.value = 0
    syncSpeaking()
  }

  /**
   * 喇叭此刻的真实响度，0 到 1。
   *
   * 本机语音合成那一路不经过我们的音频图，量不到，只能给个定值
   * （见 `LOCAL_SPEECH_LEVEL`）；其余一律现场量。
   */
  function measureSpeakerLevel(): number {
    if (localUtterance) return LOCAL_SPEECH_LEVEL
    if (!analyser || !analyserFrame) return 0
    analyser.getFloatTimeDomainData(analyserFrame)
    return measurePcmLevel(analyserFrame)
  }

  /**
   * **消不掉回声的那一路**上一次停下来的时刻。0 表示这通电话里它还没响过。
   *
   * 「还没响过」和「刚停」必须分开：混为一谈的话，通话最开始那 400 毫秒
   * 麦克风是闭着的，用户接通后立刻说的第一句会被吞掉。
   */
  let quietAt = 0
  let wasUnguarded = false

  /** 「它在出声」= 播放队列里还排着东西，或者本机语音合成正念着 */
  function syncSpeaking(): boolean {
    speaking.value = scheduled.length > 0 || localUtterance !== null
    return speaking.value
  }

  /**
   * 这一包麦克风数据要不要掐成静音。
   *
   * 全双工之后这里**大多数时候返回 false** —— 厂商音频走回环，回声由 AEC 消掉。
   * 只有本机语音合成在念、或者回环压根没建起来时才闭嘴，理由见 `shouldMuteUplink`。
   */
  function muteUplinkNow(): boolean {
    syncSpeaking()
    const localSpeaking = localUtterance !== null
    const vendorSpeaking = scheduled.length > 0
    const aecReady = aecLoopback !== null

    // 「没有 AEC 保护地在出声」的那一路停下时才起余响窗口。厂商音频走回环时
    // 不能起 —— 那等于在全双工里每说完一句就挖 400 毫秒聋点
    const unguarded = localSpeaking || (!aecReady && vendorSpeaking)
    const now = Date.now()
    if (wasUnguarded && !unguarded) quietAt = now
    wasUnguarded = unguarded

    return shouldMuteUplink({
      localSpeaking,
      vendorSpeaking,
      aecReady,
      sinceQuietMs: quietAt === 0 ? Number.POSITIVE_INFINITY : now - quietAt
    })
  }

  /**
   * 麦克风响度的发布节流。
   *
   * worklet 是 20ms 一包，每包都写一次响应式变量等于每秒 50 次重渲染，
   * 而 60ms 一次已经快过人眼能分辨的极限。中间那两包**取峰值**再发，
   * 所以一个短促的爆破音不会正好落在被跳过的那一包里。
   */
  const INPUT_PUBLISH_MS = 60
  let inputPeak = 0
  let inputPublishedAt = 0

  function publishInputLevel(level: number): void {
    inputPeak = Math.max(inputPeak, level)
    const now = Date.now()
    if (now - inputPublishedAt < INPUT_PUBLISH_MS) return
    inputPublishedAt = now
    inputLevel.value = inputPeak
    inputPeak = 0
  }

  /** 输出这一路同理，节流理由见 `publishInputLevel` */
  let outputPeak = 0
  let outputPublishedAt = 0

  function publishOutputLevel(level: number): void {
    outputPeak = Math.max(outputPeak, level)
    const now = Date.now()
    if (now - outputPublishedAt < INPUT_PUBLISH_MS) return
    outputPublishedAt = now
    outputLevel.value = outputPeak
    outputPeak = 0
  }

  let localUtterance: SpeechSynthesisUtterance | null = null

  /**
   * 用本机语音合成念一段话。
   *
   * 豆包没有「主动开口」的路（见主进程 `doubaoRealtime.ts` 的 `buildDoubaoAnnouncement`），
   * 任务的进度、结果、反问只能在这儿念。用的是系统自带的中文语音，和模型的嗓音不一样 ——
   * 这是已知代价，接厂商 TTS 是另一件事。OpenAI 那家不走这里，它的模型自己转述。
   *
   * 念的期间：算「模型在说」（播报纪律不叠第二条进来）、球体按定值呼吸、
   * 回声门限按 `LOCAL_SPEECH_LEVEL` 设防。用户插话（`interrupted`）或挂断时掐掉。
   */
  function speakLocally(text: string): void {
    const synth = window.speechSynthesis
    if (!synth) {
      console.warn('[Realtime Voice] 本机没有语音合成，这条播报只进了上下文:', text)
      return
    }
    stopLocalSpeech()

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    const voice = synth.getVoices().find((item) => item.lang.toLowerCase().startsWith('zh'))
    if (voice) utterance.voice = voice
    const finish = (): void => {
      if (localUtterance !== utterance) return
      localUtterance = null
      outputLevel.value = 0
      if (!active.value) return
      phase.value = 'listening'
      reportFloor(reportedFloor.userSpeaking, pendingToolCalls > 0)
      hangUpIfFarewellSpoken()
    }
    utterance.onend = finish
    utterance.onerror = finish

    localUtterance = utterance
    phase.value = 'speaking'
    outputLevel.value = LOCAL_SPEECH_LEVEL
    reportFloor(reportedFloor.userSpeaking, true)
    synth.speak(utterance)
  }

  function stopLocalSpeech(): void {
    if (!localUtterance) return
    localUtterance = null
    window.speechSynthesis?.cancel()
    outputLevel.value = 0
  }

  /**
   * 放掉麦克风这一路，连同攒着的首字。
   *
   * 攒的那段和采样率是绑死的 —— 换了采样率还留着它，补发过去就是一段变调的快放。
   */
  function releaseMicrophone(): void {
    preroll = []
    micStream?.getTracks().forEach((track) => track.stop())
    micStream = null
    void micContext?.close()
    micContext = null
  }

  function releaseAudio(): void {
    stopLocalSpeech()
    stopPlayback()
    inputLevel.value = 0
    inputPeak = 0
    outputPeak = 0
    // 余响窗口不能跨会话：下一通电话开头会莫名其妙听不见用户说话
    quietAt = 0
    wasUnguarded = false
    speaking.value = false
    canInterruptByVoice.value = false
    // 攒着的首字属于**这一通**。留到下一通会把上一次没说完的半句补发过去
    uplinkOpen = false
    releaseMicrophone()
    aecLoopback?.close()
    aecLoopback = null
    void playContext?.close()
    playContext = null
    analyser = null
    analyserFrame = null
    playCursor = 0
  }

  /**
   * 把一段 base64 的 PCM16 排进播放队列。
   *
   * 用「按游标依次排」而不是收到就播：分片是几十毫秒一个，各自 `start()` 的话
   * 段与段之间会有肉眼可见的调度抖动，听起来是持续的咔哒声。
   */
  function play(base64: string): void {
    if (!playContext) return
    // 压缩流当 PCM 播会产生满幅随机噪声。即使厂商回退格式，也绝不能送进扬声器。
    if (detectEncodedAudio(base64)) {
      error.value = options.unsupportedAudioMessage
      void stop()
      return
    }
    if (playContext.state === 'suspended') void playContext.resume()
    const samples = decodePcm16Le(base64)

    const buffer = playContext.createBuffer(1, samples.length, outputSampleRate)
    const channel = buffer.getChannelData(0)
    channel.set(samples)

    const source = playContext.createBufferSource()
    source.buffer = buffer
    // 串过分析节点，响度由它现场量（见 `analyser`）。没建起来就直连，宁可没门限也要有声音
    source.connect(analyser ?? playContext.destination)
    scheduled.push(source)
    syncSpeaking()
    source.onended = () => {
      scheduled = scheduled.filter((item) => item !== source)
      syncSpeaking()
      /*
       * 队列排空了才算真的说完。
       *
       * 分片是**成批**到的，最后一片到达时喇叭还有好几秒没播完 —— 那会儿
       * `turn-done` 早就来了。这时候主进程要是把攒着的播报放进来，就是抢话：
       * 用户同时听见两个声音，而且新那句还会被自己的回声打断。
       */
      if (scheduled.length === 0 && active.value) {
        reportFloor(reportedFloor.userSpeaking, pendingToolCalls > 0 || localUtterance !== null)
        // 告别的最后一片播完了 —— 这才是挂断的时机
        hangUpIfFarewellSpoken()
      }
    }
    // 留 40ms 抗网络抖动。紧贴 currentTime 起播会在每个来晚的分片之间产生断点，
    // 连续的断点听起来就是严重爆音；官方 Demo 也保留这一段缓冲。
    playCursor = Math.max(playCursor, playContext.currentTime + 0.04)
    source.start(playCursor)
    playCursor += buffer.duration
  }

  async function commitAssistantTurn(): Promise<void> {
    const text = assistantText.value.trim()
    if (!text || assistantTurnCommitted) return
    assistantTurnCommitted = true
    try {
      await options.onAssistantDone?.(text)
    } catch (error) {
      // 聊天历史落盘失败不能把正在进行的语音连接一起掐断。
      console.warn('[Realtime Voice] 助手字幕落盘失败:', error)
    }
  }

  /**
   * 把活派出去。
   *
   * 两步，顺序不能反：**先向主进程登记，再真正启动 agent**。
   * 反过来的话，最初几条事件（start、第一个工具调用）落到一个还不存在的任务上
   * 被直接丢掉，那件活就永远显示「还没开始」。
   *
   * 这里刻意不等 agent 跑完 —— 等就是上一版的冷场。返回的那句话是写给模型看的
   * 指令，不是给用户听的：它得知道「这不是结果、别等、先跟用户说一声」。
   */
  async function dispatchTask(
    instruction: string,
    sessionId: string,
    when: string,
    worker: string,
    resumeTaskId = ''
  ): Promise<string> {
    if (!instruction && !resumeTaskId) return '没听清要做什么，请让用户再说一遍。'

    /*
     * 派给别的对话时**不挑灶** —— 灶是这通电话内部的分工，别人那条对话有它
     * 自己的 agent 会话和自己的排队规矩。挑了反而会在这通电话下面凭空建一个
     * 用不上的灶。
     */
    const target = resumeTaskId
      ? undefined
      : sessionId
        ? resolveTarget(sessionId)
        : options.resolveSession(worker)
    if (!target && !resumeTaskId) {
      return `没有 id 是「${sessionId}」的对话。先用 ${LIST_SESSIONS} 看一眼，或者别填 session。`
    }

    const executionInstruction = options.prepareInstruction?.(instruction) || instruction
    const registered = await window.api.realtimeVoice.dispatchTask({
      instruction,
      executionInstruction,
      resumeTaskId,
      agentSessionId: target?.agentSessionId || '',
      sessionLabel: target?.label,
      when: when === 'now' ? 'now' : 'queue'
    })
    if (!registered.ok) return registered.ack

    // 挑灶时没按模型的意思来（它没给灶名、或者灶满了）就得说清楚，
    // 否则它会以为开了新灶、告诉用户「同时在做」，而实际是排队
    const note = target?.note ? ` ${target.note}` : ''

    // 排上队的这会儿什么都不用做 —— 前面那件结束时主进程会把它推回来（`run-task`）
    if (registered.action === 'queued') return `${registered.ack}${note}`

    if (registered.action === 'steer') {
      const steered = await options.onSteer?.(registered.agentSessionId, instruction)
      // 拿真实返回值。插不进去还说「已经插进去了」，用户会以为改过来了
      return steered === false
        ? '没能插进正在做的那件事里，请让用户等它做完再说，或者说「停下」。'
        : registered.ack
    }

    const ack = await startRun(
      registered.taskId,
      registered.instruction || instruction,
      registered.agentSessionId || target?.agentSessionId || '',
      registered.ack,
      registered.executionInstruction ||
        (resumeTaskId ? registered.instruction : executionInstruction),
      registered.attempt
    )
    return `${ack}${note}`
  }

  /**
   * 真正把一次运行发起出去。
   *
   * 两个入口共用：模型刚派下来的，和队列排到、主进程推回来的。
   * 起不来就当场把那件活标掉 —— 不标的话它在任务表里永远占着位子，
   * 后面所有派发都得排在它后面等一个永远不会结束的东西。
   */
  async function startRun(
    taskId: string,
    instruction: string,
    agentSessionId: string,
    ack: string,
    executionInstruction?: string,
    attempt = 1
  ): Promise<string> {
    const fail = (reason: string): void =>
      window.api.realtimeVoice.taskFailed({ taskId, reason, attempt })
    try {
      await options.onDispatch(instruction, agentSessionId, fail, executionInstruction)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      fail(reason)
      return `没能启动任务：${reason}`
    }
    return ack
  }

  /**
   * 按 id 找一条能派活的去处。找不到返回 undefined —— 不猜，猜错就派到别人的项目上了。
   *
   * **只查，不建。** 先在这通电话自己的灶里找，再找别的对话。
   * 上一版是拿 `resolveSession()` 的结果去比对，而它现在会**现开一个灶**
   * （建对话、发会话号）—— 于是模型每次把活派给别的对话，都会在侧边栏留下
   * 一条谁也用不上的空任务对话。
   */
  function resolveTarget(sessionId: string): VoiceSessionRef | undefined {
    const lane = options.listWorkers?.().find((item) => item.agentSessionId === sessionId)
    if (lane) return lane
    return options.listSessions?.().find((item) => item.agentSessionId === sessionId)
  }

  async function cancelTask(taskId: string): Promise<string> {
    const target = await window.api.realtimeVoice.cancelTask(taskId)
    if (!target.found) return target.text

    // 拿真实返回值。一律报「已停下」的话，用户以为停了而任务还在跑，
    // 那比停不掉更糟
    const stopped = await options.onCancel?.(target.agentSessionId)
    if (stopped === false) {
      return `没能停下任务 ${target.taskId}，请让用户在界面上手动停止。`
    }
    return `已经让任务 ${target.taskId} 停下了。`
  }

  /**
   * 模型说这通电话该结束了（用户道了别）。**先记下，念完告别才真挂。**
   *
   * 能不能挂由主进程答（任务表在它手上）；什么时候挂只有这一层知道 ——
   * `turn-done` 到的时候喇叭里往往还排着好几秒的音频。立刻关连接的话
   * 用户听到的是半句告别然后突然安静，那正是「掉线了」的样子。
   */
  let hangUpWhenDoneSpeaking = false

  async function endCall(force: boolean): Promise<string> {
    const verdict = await window.api.realtimeVoice.endCall(force)
    if (verdict.hangUp) hangUpWhenDoneSpeaking = true
    return verdict.text
  }

  /**
   * 告别念完了没有。念完就挂。
   *
   * 三处调用点各盯一种「还没说完」：`turn-done` 是模型这一轮生成完，
   * 播放队列排空是厂商音频真播完，本机合成结束是播报那一路念完。
   * 谁最后完事都行，条件只有一个 —— 此刻没人在出声。
   */
  function hangUpIfFarewellSpoken(): void {
    if (!hangUpWhenDoneSpeaking || !active.value) return
    if (pendingToolCalls > 0 || scheduled.length > 0 || localUtterance) return
    hangUpWhenDoneSpeaking = false
    console.log('[Realtime Voice] 用户说了再见，告别念完了，挂断')
    void stop()
  }

  /**
   * 把用户的口头回答交回给挂起的 `ask_user`。
   *
   * 全空表示用户说了「你看着办」—— 那对应 `decline`（让 Agent 自己定），
   * 不是 `accept` 一个空答案。两者在 agent 那边是不同的路：后者会让它
   * 拿着一个空字符串当成用户的选择继续做。
   */
  async function answerQuestion(answers: string[], taskId: string): Promise<string> {
    const answerGeneration = generation
    const target = await window.api.realtimeVoice.answerQuestion(taskId)
    if (!target.found) return target.text
    // 旧通话迟到的回答不能清掉新通话正在等的那一问。
    if (answerGeneration === generation) awaitingAnswer = null

    const aligned = Array.from(
      { length: Math.max(target.questionCount, answers.length) },
      (_, index) => answers[index] || ''
    )
    const empty = aligned.every((item) => !item.trim())
    options.onAnswerQuestion?.(target.toolCallId, empty ? [] : aligned, target.agentSessionId)
    return empty
      ? `已经告诉 Agent「你自己定」，任务 ${target.taskId} 继续往下做了。`
      : `答案已经交回去了，任务 ${target.taskId} 继续往下做。`
  }

  /**
   * 把用户对一次高风险操作的表态交回去。
   *
   * **拿不准一律 reject。** 代价不对称：拒了大不了让他再说一遍，
   * 批了可能是删场景那种不可逆的事。模型给了个我们不认的词也算拿不准。
   */
  async function approveTask(decision: string, taskId: string): Promise<string> {
    const target = await window.api.realtimeVoice.approveTask(taskId)
    if (!target.found) return target.text

    const wanted = decision.trim().toLowerCase()
    const verdict =
      wanted === 'approve' || wanted === 'reject' || (wanted === 'always' && target.allowAlways)
        ? (wanted as 'approve' | 'always' | 'reject')
        : wanted === 'always'
          ? 'approve' // 这个工具不给「以后都允许」，退回成只批这一次
          : 'reject'

    options.onApprove?.(target.toolCallId, verdict)
    if (verdict === 'reject') {
      return `已经回复「不做」，${target.toolName} 这一步被跳过了，任务 ${target.taskId} 继续。`
    }
    return verdict === 'always'
      ? `已经同意，而且这次对话里 ${target.toolName} 不用再问了。`
      : `已经同意，任务 ${target.taskId} 接着往下做。`
  }

  /**
   * 模型点了一个工具。
   *
   * 四类去向：派发（不等）、查/停/答/批任务（主进程任务表）、
   * 列对话（这里当场答，标题只有界面知道）、只读查询（主进程当场答）。
   * 每一条路都**必须**回一次 `sendToolResults` —— 漏掉一条，模型就在那儿
   * 永远等着，表现是「说完一句就再也不理人了」。
   */
  async function handleToolCall(event: Extract<VoiceEvent, { type: 'tool-call' }>): Promise<void> {
    const toolGeneration = generation

    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(event.args) || {}
    } catch {
      // 模型偶尔会吐出不合法的 JSON。当成空参数走下去，让工具自己回一句
      // 能让它纠正的话，比静默不回强
    }
    const taskId = String(args.taskId || '').trim()

    let output: string
    try {
      output = await runVoiceTool(event.name, args, taskId)
    } catch (err) {
      // 抛了也得回一句。不回的话模型永远等着 —— 这一层最坏的故障就是安静
      const reason = err instanceof Error ? err.message : String(err)
      output = `工具执行出错：${reason}。跟用户照实说，别假装做成了。`
    }

    // 用户可能在这期间主动结束语音。旧结果不能再投递给下一条会话
    if (toolGeneration !== generation || !active.value) return
    window.api.realtimeVoice.sendToolResults([{ callId: event.callId, output }])
  }

  async function runVoiceTool(
    name: string,
    args: Record<string, unknown>,
    taskId: string
  ): Promise<string> {
    if (name === DISPATCH_TASK) {
      return dispatchTask(
        String(args.instruction || '').trim(),
        String(args.session || '').trim(),
        String(args.when || '').trim(),
        String(args.worker || '').trim(),
        String(args.resumeTaskId || '').trim()
      )
    }
    if (name === CHECK_TASK) return (await window.api.realtimeVoice.describeTask(taskId)).text
    if (name === CANCEL_TASK) return cancelTask(taskId)
    if (name === END_CALL) return endCall(args.force === true)
    if (name === ANSWER_QUESTION) return answerQuestion(readAnswers(args), taskId)
    if (name === APPROVE_TASK) return approveTask(String(args.decision || ''), taskId)
    if (name === LIST_SESSIONS) {
      return describeSessions(options.listSessions?.() || [options.resolveSession()])
    }
    if (isLocalVoiceTool(name)) return (await window.api.realtimeVoice.runLocalTool(name)).output
    return `没有 ${name} 这个工具。`
  }

  /**
   * 从工具参数里取出答案数组。
   *
   * 模型给数组或单个字符串都认：schema 写的是 `answers: string[]`，
   * 但实时模型在只有一问时经常直接给字符串。为这个让 Agent 白等一轮不值得。
   */
  function readAnswers(args: Record<string, unknown>): string[] {
    const raw = args.answers ?? args.answer
    if (Array.isArray(raw)) return raw.map((item) => (typeof item === 'string' ? item : ''))
    return typeof raw === 'string' ? [raw] : []
  }

  async function handle(event: VoiceEvent): Promise<void> {
    const eventGeneration = generation
    phase.value = nextRealtimeVoicePhase(phase.value, event)
    switch (event.type) {
      case 'ready':
        // 只放行握手。`active` 要等麦克风真接上才置位，见 `start()` 末尾
        settleHandshake?.(true)
        settleHandshake = null
        break
      /*
       * 没听清。**不掐会话**，只把这一段作废，让用户知道该再说一遍。
       *
       * 以前这条事件掉进 default 里被静默丢掉，表现是用户说完话界面毫无动静 ——
       * 他没法判断是没听见、还是在想、还是坏了，只能一直重复说。
       */
      case 'asr-failed':
        userText.value = options.asrFailedMessage
        // 这一段没识别出来，下一轮不会来了 —— 再丢下去就把新回答也吞了
        setDiscardingAudio(false)
        reportFloor(false, false)
        break
      case 'user-text':
        userText.value = event.text
        /*
         * 他又说话了 —— 道别那句不算数了，别挂。
         *
         * 「再见」和「等一下，还有件事」之间可能只隔两秒，而告别正念着。
         * 挂错了他得重新接一通、重新说一遍上下文；不挂只是多开着一会儿，
         * 防冷场那条路自己会收场。
         */
        hangUpWhenDoneSpeaking = false
        // 中间态就是「用户还在说」。这期间主进程一个字都不许插播
        reportFloor(!event.final, false)
        if (event.final) {
          // 用户说完了，接下来的音频属于**新一轮**，不能再丢
          setDiscardingAudio(false)
          await commitAssistantTurn()
          if (eventGeneration !== generation) return
          assistantText.value = ''
          assistantTurnCommitted = false
          const text = event.text.trim()
          // 有问题挂着的话，这句就是候选答案；这一轮模型调没调工具从头数
          toolCalledThisTurn = false
          if (awaitingAnswer && text) awaitingAnswer.candidate = text
          if (text) options.onUserText?.(text)
        }
        break
      case 'assistant-text':
        if (assistantTurnCommitted) {
          assistantText.value = ''
          assistantTurnCommitted = false
        }
        assistantText.value += event.text
        reportFloor(false, true)
        options.onAssistantText?.(assistantText.value)
        break
      case 'audio':
        // 被打断那一轮的残片继续往这边到（发出 cancel 之后网络上还有在途的）。
        // 不挡的话它们会被排进播放队列，表现就是「打断了一下，然后它接着说完」
        if (discardingAudio) break
        play(event.base64)
        break
      case 'interrupted': {
        /*
         * **这是服务端自己发现的打断**（豆包是 `transcription.started`，OpenAI 是
         * `speech_started`）—— 也就是说，用户那句话它已经收到、并且开始转写了。
         *
         * 本地要做两件事：掐掉已排队的音频，丢掉随后到的在途残片。
         * 手动打断（点球体、按快捷键）走的是另一条路（`interrupt()`），那边多一件。
         *
         * ## 为什么这条路**不再**发 `response.cancel`
         *
         * 那一句是半双工时代的产物：当时模型说话期间上行整个闭着，服务端根本不知道
         * 用户开口了，只能由我们捅它一下。现在全双工接上了 —— 它自己听得见
         * （它都开始转写了），再捅一下既多余，又很可能正是**用户那句话被吞掉**的原因：
         *
         *   用户反馈：「打断好像是会打断，但他不会把我打断的话当成
         *   新输入……我再说一次，他才当成我的输入」。
         *
         * 时序完全对得上 —— 我们恰好在服务端转写那句话的当口发了「这一轮作废」，
         * 它连着把在途的输入一起丢了；用户再说一遍时模型没在出声，
         * `interrupt()` 那条路也不会触发，于是这次就正常了。
         *
         * **这是按时序推出来的，没有厂商文档佐证。** 判据在两处：
         * `↑ response.cancel` 之后还有没有 `↓ ...transcription.completed`；
         * 以及改完之后模型会不会在被打断后又接着说（那说明服务端并不自己停，
         * 得把这一句以别的形式加回来）。
         *
         * 本机正在念的通知一起掐：用户开口了就别跟他抢。
         */
        stopLocalSpeech()
        stopPlayback()
        setDiscardingAudio(true)
        // 他插话打断了告别，那就别挂了（理由同 `user-text` 里那一句）
        hangUpWhenDoneSpeaking = false
        // 打断意味着用户开口了。模型那半句已经作废，不能再算它在说话
        reportFloor(true, false)
        await commitAssistantTurn()
        break
      }
      /*
       * 用户停下来了 —— 接下来到的音频属于**新一轮**，不能再当残片丢掉。
       *
       * 和 `user-text` final 做的是同一件事，区别在于它**不依赖识别**。留着这条是因为
       * 出口全押在识别上出过一次事：OpenAI 那边转写是选填的，没配上就一条识别都不发，
       * 于是丢弃开关只能等三秒兜底 —— 而一句短回答的音频还不到三秒，
       * 表现是模型答了、字幕也有，就是一点声音都没有。
       */
      case 'user-speech-done':
        setDiscardingAudio(false)
        // 服务端说他停了，就别再压着播报。模型那半边维持原样
        reportFloor(false, reportedFloor.assistantSpeaking)
        break
      case 'tool-call':
        toolCalledThisTurn = true
        // 模型在等我们回结果，这一轮没完 —— 这期间不许往里插播（见 pendingToolCalls）
        pendingToolCalls += 1
        reportFloor(false, true)
        try {
          await handleToolCall(event)
        } finally {
          if (eventGeneration === generation) pendingToolCalls = Math.max(0, pendingToolCalls - 1)
        }
        break
      case 'turn-done':
        /*
         * 场子空出来了。压着的进度可以放一条出去了 —— 除非模型还在等我们的工具结果、
         * 本机正念着一条通知，**或者喇叭还没播完**。
         *
         * 最后那条不是多余的：分片成批到，这条事件到的时候队列里往往还排着好几秒。
         * 播完的那一刻由 `play()` 里的 `onended` 再报一次。
         */
        reportFloor(false, pendingToolCalls > 0 || localUtterance !== null || scheduled.length > 0)
        await commitAssistantTurn()
        // 模型这一轮只动了嘴没调工具，而用户刚才那句是在答 Agent 的问题 —— 我们替它交
        if (eventGeneration === generation) await forwardPendingAnswer()
        // 告别是这一轮说的。喇叭里还排着东西就等 `play` 的 onended 再挂
        if (eventGeneration === generation) hangUpIfFarewellSpoken()
        break
      case 'speak':
        speakLocally(event.text)
        break
      case 'announced':
        options.onAnnouncement?.(event.text)
        break
      case 'question-announced':
        awaitingAnswer = { taskId: event.taskId, candidate: '' }
        break
      case 'question-settled':
        if (!event.taskId || awaitingAnswer?.taskId === event.taskId) awaitingAnswer = null
        break
      case 'error':
        error.value = event.message
        settleHandshake?.(false)
        settleHandshake = null
        await stop()
        break
      case 'closed':
        await stop()
        break
      default:
        break
    }
  }

  /** 一包 PCM 送上去。base64 是两家协议共同的形状 */
  function sendPcm(pcm: Int16Array): void {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
    window.api.realtimeVoice.sendAudio(btoa(binary))
  }

  /**
   * 麦克风开起来，先往缓冲里攒。
   *
   * **在发起连接之前调。** 上一版是握手完成之后才申请麦克风、加载 worklet，
   * 而这两件事都是本地的、不依赖网络 —— 白等那一两秒的代价是用户点完球体
   * 立刻说的那句话一个字都没采到。
   *
   * 代价说清楚：连接失败时麦克风也已经开过几秒（`releaseAudio` 里放掉）。
   * 拿「失败连接不占用麦克风」换「不丢用户的第一个字」，这笔换得值。
   */
  async function openMicrophone(currentGeneration: number): Promise<void> {
    /*
     * 采集这一路**必须**用目标采样率创建，让浏览器替我们重采样。
     * 手写插值既要处理抗混叠又容易引入高频噪声，而噪声正好落在
     * 语音模型最敏感的频段。
     */
    const context = new AudioContext({ sampleRate: inputSampleRate })
    micContext = context

    const deviceId = options.microphoneDeviceId?.()
    const stream = await navigator.mediaDevices
      .getUserMedia({
        audio: {
          // 回声消除是刚需：不开的话模型会听见自己刚说的话，然后接着回应自己。
          // 光开它还不够 —— 参考信号得走 WebRTC 渲染路径，见 `createAecLoopback`
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      .catch((error: unknown) => {
        const key = mediaPermissionErrorKey(error, 'microphone', window.api.platform)
        if (key) throw new Error(i18n.global.t(key))
        throw error
      })
    if (generation !== currentGeneration) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    micStream = stream
    stream.getTracks().forEach((track) => {
      track.enabled = !muted.value
    })

    await context.audioWorklet.addModule(workletUrl)
    if (generation !== currentGeneration) return
    const node = new AudioWorkletNode(context, 'pcm-capture')
    node.port.onmessage = (message) => {
      if (generation !== currentGeneration) return
      const buffer = message.data as ArrayBuffer
      const samples = new Int16Array(buffer)
      // 顺手量一下响度：这一包已经在手上了，再开一条 AnalyserNode 纯属重复采集
      const rms = muted.value ? 0 : rootMeanSquare(samples)

      /*
       * 还没连上：攒着，不发。响度照常喂给球体 —— 用户看得见它在听，
       * 而不是对着一个死掉的球说话。
       */
      if (!uplinkOpen) {
        publishInputLevel(levelFromRms(rms))
        preroll.push({ pcm: muted.value ? new Int16Array(samples.length) : samples, level: rms })
        const maxPackets = Math.ceil(PREROLL_MAX_MS / PACKET_MS)
        if (preroll.length > maxPackets) preroll.splice(0, preroll.length - maxPackets)
        return
      }

      // 输出响度只喂给球体动效了；判不判静音**不看它**，见 `shouldMuteUplink`
      publishOutputLevel(measureSpeakerLevel())

      const uplinkMuted = muted.value || muteUplinkNow()
      /*
       * 闭嘴期间界面上的麦克风响度也得是 0：显示着波动、而那些声音一个字
       * 都没送上去，用户只会以为「它没听见我」。
       */
      publishInputLevel(uplinkMuted ? 0 : levelFromRms(rms))

      // 掐掉也要**照发一包静音**：豆包全双工靠上行音频流保活，
      // 停发几秒服务端就按超时把连接断了
      sendPcm(uplinkMuted ? new Int16Array(samples.length) : samples)
    }
    context.createMediaStreamSource(stream).connect(node)
    // 不接到 destination：接上等于把麦克风原样播出来，用户会听见自己的回声
  }

  /**
   * 把攒着的首字补发出去，然后开闸。
   *
   * 只补**第一声之前 100 毫秒**起的那一段（`firstVoicePacket`）：从头补的话，
   * 用户点完球体沉默的那几秒环境底噪也一起送过去，服务端会把它当成一段发言，
   * 判停和识别都会被带偏。一声都没有就一包不补。
   */
  function flushPreroll(): void {
    const packets = preroll
    preroll = []
    uplinkOpen = true

    const from = firstVoicePacket(packets.map((item) => item.level))
    if (from < 0) return
    for (const packet of packets.slice(from)) sendPcm(packet.pcm)
    console.log(
      `[Realtime Voice ${new Date().toISOString().slice(11, 23)}] 补发了连接期间的 ${
        packets.length - from
      } 包音频（约 ${(packets.length - from) * PACKET_MS} 毫秒）`
    )
  }

  async function start(): Promise<void> {
    if (active.value || connecting.value) return
    error.value = null
    userText.value = ''
    assistantText.value = ''
    // 上一路会话可能停在「正在丢弃残片」的状态。不清的话新会话开头是哑的
    setDiscardingAudio(false)
    connecting.value = true
    phase.value = 'connecting'
    const currentGeneration = ++generation
    assistantTurnCommitted = false
    connectionTimer = setTimeout(() => {
      if (generation !== currentGeneration) return
      error.value = options.connectionTimeoutMessage || 'Voice connection timed out. Please retry.'
      void stop()
    }, CONNECTION_TIMEOUT_MS)

    const handshake = new Promise<boolean>((resolve) => {
      settleHandshake = resolve
    })

    // 必须先监听再发起连接：服务端可能紧跟 session.create 返回错误，后监听会永久漏掉。
    unsubscribe = window.api.realtimeVoice.onEvent((payload) => {
      if (generation !== currentGeneration) return
      void handle(payload as VoiceEvent)
    })
    /*
     * 队列排到了，主进程把那件活推回来让这边跑。
     *
     * 这条**不经过模型** —— 排队的活轮到自己时不该再问它一次，
     * 它在派发的时候就已经决定好了。跑起来之后的进度和结果照常走播报。
     */
    unsubscribeRunTask = window.api.realtimeVoice.onRunTask((task) => {
      if (generation !== currentGeneration) return
      void startRun(
        task.taskId,
        task.instruction,
        task.agentSessionId,
        '',
        task.executionInstruction,
        task.attempt
      )
    })

    try {
      /*
       * 先问采样率、先开麦克风，**再**发起连接 —— 用户点完球体就说话的那一句
       * 于是有地方去（`preroll`）。采集的 AudioContext 必须按目标采样率创建
       * （浏览器替我们重采样），而各家要的不一样，所以采样率不能等 `start`
       * 的返回值：那时候麦克风早该开着了。
       *
       * **这一段失败了不算会话失败。** 它只是个提前量：配置没配好（`ok: false`）、
       * 麦克风一时申请不到，都退回「握手之后再开麦」那条老路，代价只是丢首字。
       * 真的开不了麦，后面那次 `openMicrophone` 会照样抛，报错落在同一个地方。
       */
      try {
        const spec = await window.api.realtimeVoice.audioSpec()
        if (generation !== currentGeneration) return
        if (spec.ok) {
          inputSampleRate = spec.inputSampleRate
          outputSampleRate = spec.outputSampleRate
          await openMicrophone(currentGeneration)
        }
      } catch (err) {
        if (generation !== currentGeneration) return
        console.warn('[Realtime Voice] 首字缓冲没开起来，退回握手之后再开麦：', err)
        releaseMicrophone()
      }
      if (generation !== currentGeneration) return

      const session = await window.api.realtimeVoice.start({
        history: options.getHistory?.() || []
      })
      if (generation !== currentGeneration) return
      if (!session.ok) {
        error.value = session.error
        await stop()
        return
      }

      /*
       * 采样率以真正开起来的这条会话为准。和 `audioSpec` 说的不一样时（用户在
       * 这两步之间改了绑定），攒的那段是按旧采样率采的 —— 补发过去就是一段变调的
       * 快放。丢掉重开麦克风，用户至多损失刚才那一句。
       */
      if (micContext && session.inputSampleRate !== inputSampleRate) {
        console.warn('[Realtime Voice] 采样率和开麦时算的不一样，丢掉攒下的首字重开麦克风')
        releaseMicrophone()
      }
      inputSampleRate = session.inputSampleRate
      outputSampleRate = session.outputSampleRate

      // session.created 才表示厂商接受了配置。此前送上去的音频服务端不会认
      if (!(await handshake) || generation !== currentGeneration) return

      // audioSpec 没答上来、或者采样率对不上重开的，这会儿才开麦（没有首字缓冲）
      if (!micContext) {
        await openMicrophone(currentGeneration)
        if (generation !== currentGeneration) return
      }

      /*
       * 播放这一路**不指定采样率**，跟着输出设备走。
       *
       * 上一版这里写死 24000，和采集那一路对称，看着很整齐 —— 但这两路的
       * 约束根本不一样：指定一个非默认采样率会把这一路推到另一条渲染路径上。
       * 重采样交给 `createBuffer(1, len, outputSampleRate)` —— 缓冲区的采样率
       * 允许和上下文不同，浏览器会在播放时转换，质量比我们自己插值好。
       */
      playContext = new AudioContext()
      /*
       * 所有播放都串过它，球体的输出响度拿它现场量（见 `analyser`）。
       * `fftSize` 1024 在 48k 上约 21 毫秒，正好一包麦克风数据的量级。
       */
      analyser = playContext.createAnalyser()
      analyser.fftSize = 1024
      /*
       * 出口是那条 WebRTC 回环，不是 `destination` —— 这是全双工的全部秘密：
       * Chromium 的回声消除只参考得到 WebRTC 渲染路径上的声音（见
       * `createAecLoopback`）。建不起来就直连，并且上行退回半双工。
       */
      const loopback = await createAecLoopback(playContext)
      if (generation !== currentGeneration) {
        loopback?.close()
        return
      }
      aecLoopback = loopback
      canInterruptByVoice.value = loopback !== null
      analyser.connect(aecLoopback?.node ?? playContext.destination)
      /*
       * 这一行**必须留着**，而且要和厂商帧日志同一个格式。
       *
       * 全双工还是半双工，决定了「模型说话期间用户开口算不算数」—— 而这两种情况
       * 在厂商帧日志里长得**一模一样**：半双工时用户说的话根本没上行，服务端
       * 什么都没收到，日志里就是一片安静。真机（2026-09-03）排「打断了但话不算数」
       * 时卡在这儿：光看帧日志分不出是「用户没插话」还是「插了但没送上去」。
       */
      console.log(
        `[Realtime Voice ${new Date().toISOString().slice(11, 23)}] ${
          aecLoopback
            ? '回声消除回环已就绪：模型说话期间上行照开，开口即可打断（全双工）'
            : '回声消除回环没建起来：模型说话期间上行关闭，打断只能点球体或按快捷键（半双工）'
        }`
      )
      analyserFrame = new Float32Array(analyser.fftSize)
      playCursor = 0

      /*
       * **到这里才算真的开着**，闸门也在这一刻开。
       *
       * 上一版在收到 `ready` 时就置位，那时候麦克风还没申请、worklet 还没加载。
       * 中间这段时间界面显示「正在听」，用户对着麦克风说的话一个字都没被采到，
       * 而全程没有任何报错 —— 用户只会觉得「它不理我」。现在那段话攒着，
       * 这会儿一并补发（`flushPreroll`）。
       */
      active.value = true
      connecting.value = false
      phase.value = 'listening'
      window.api.realtimeVoice.playbackReady(session.connectionId)
      flushPreroll()
      if (connectionTimer) clearTimeout(connectionTimer)
      connectionTimer = null
    } catch (err) {
      if (generation !== currentGeneration) return
      error.value = err instanceof Error ? err.message : String(err)
      await stop()
    }
  }

  async function stop(): Promise<void> {
    const committed = commitAssistantTurn()
    generation += 1
    if (connectionTimer) clearTimeout(connectionTimer)
    connectionTimer = null
    awaitingAnswer = null
    toolCalledThisTurn = false
    // 这通已经结束了。留着的话下一通开口第一句就可能被挂掉
    hangUpWhenDoneSpeaking = false
    setDiscardingAudio(false)
    reportFloor(false, false)
    armFloorWatchdogs(false, false)
    pendingToolCalls = 0
    settleHandshake?.(false)
    settleHandshake = null
    unsubscribe?.()
    unsubscribe = null
    unsubscribeRunTask?.()
    unsubscribeRunTask = null
    releaseAudio()
    active.value = false
    connecting.value = false
    phase.value = 'idle'
    await window.api.realtimeVoice.stop()
    await committed
  }

  function setMuted(value: boolean): void {
    muted.value = value
    micStream?.getTracks().forEach((track) => {
      track.enabled = !value
    })
    if (value) {
      preroll = []
      inputPeak = 0
      inputLevel.value = 0
      reportFloor(false, reportedFloor.assistantSpeaking)
    }
  }

  /**
   * 手动打断（点球体、按快捷键）。
   *
   * 全双工之后用户开口本身就打断得了（服务端 VAD 听得见），这条是**另一条**入口：
   * 不方便出声的场合、本机语音合成正念着长通知（那一路上行仍是闭的）、
   * 以及回环没建起来的机器上仍然是半双工，那时它是唯一的入口。
   *
   * 三件事一起做，缺一件都表现为「打断不了」：掐本地播放、让服务端停止这一轮、
   * 丢掉随后到的在途残片（发了取消，网络上已经在路上的分片照样会到）。
   */
  function interrupt(): void {
    if (!active.value) return
    const wasSpeaking = speaking.value || reportedFloor.assistantSpeaking
    stopLocalSpeech()
    stopPlayback()
    syncSpeaking()
    // 没在出声就只是个空操作，别去打扰服务端：没有进行中的响应时发取消，
    // 有的厂商会回一条 error，而 error 会掐掉整通电话
    if (!wasSpeaking) return

    setDiscardingAudio(true)
    window.api.realtimeVoice.cancelResponse()
    // 它不说了，场子交回给用户。静音窗口由 `muteUplinkNow` 自己按余响放开
    reportFloor(false, false)
    phase.value = 'listening'
    void commitAssistantTurn()
  }

  function sendText(text: string): void {
    const normalized = String(text || '').trim()
    if (!active.value || !normalized) return
    void commitAssistantTurn()
    userText.value = normalized
    assistantText.value = ''
    assistantTurnCommitted = false
    phase.value = 'thinking'
    options.onUserText?.(normalized)
    window.api.realtimeVoice.sendText(normalized)
  }

  /*
   * 这里**不挂** onBeforeUnmount。
   *
   * 原先挂了一条「组件没了就 stop」，理由是别让麦克风开着、会话计着费。
   * 但每条对话是一个独立的 keep-alive 页面实例，切一下会话旧页面就可能被换掉 ——
   * 于是切到「语音任务」看一眼过程，通话就断了。这一路的主人是应用级的
   * `voiceAssistant.ts`，不是任何页面；挂断只由用户点球体决定，
   * 窗口整个关掉时主进程在 sender 销毁那一刻自己收尾。
   */

  return {
    muted,
    canInterruptByVoice,
    setMuted,
    active,
    connecting,
    phase,
    userText,
    assistantText,
    outputLevel,
    inputLevel,
    error,
    speaking,
    start,
    stop,
    sendText,
    interrupt
  }
}
