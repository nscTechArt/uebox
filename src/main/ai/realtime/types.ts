/**
 * 实时语音会话的中性词汇表。
 *
 * 两家（OpenAI Realtime、豆包 Seeduplex）各有一个适配器，共用这一份形状 ——
 * 上层（IPC、渲染层）不该知道当前连的是谁。
 *
 * 巧的是这两家的事件名几乎同构（豆包 3.0 有意对齐了 Realtime 的事件语义），
 * 但**同构不等于同形**：采样率、首帧事件、工具结果的回传结构、以及怎么优雅关闭，
 * 四处都不一样，而且每一处错了都不报错、只是不工作。差异逐条写在各自的适配器里。
 */

import type { RealtimeEchoGuard } from '../../../shared/realtimeEchoGuard'

/** 一次会话里我们关心的事件。已经翻译成中性形状，与厂商无关 */
export type VoiceSessionEvent =
  /** 连上了，可以开始送音频 */
  | { type: 'ready' }
  /** 用户说的话（识别结果）。`final` 为假时是中间态，界面可以先显示再覆盖 */
  | { type: 'user-text'; text: string; final: boolean }
  /**
   * 这一段没听清。
   *
   * 和 `error` 分开：识别失败**不该掐掉会话**，再说一遍就好。但也不能像以前那样
   * 静默丢掉 —— 用户对着麦克风说完，界面一点动静没有，他没法判断是没听见、
   * 还是在想、还是坏了，只能一直重复说。
   */
  | { type: 'asr-failed' }
  /** 模型说的话的文字版，增量 */
  | { type: 'assistant-text'; text: string }
  /** 模型说的话的音频，base64 PCM16。渲染层拿去播 */
  | { type: 'audio'; base64: string }
  /**
   * 模型要调工具了。
   *
   * 这一层不执行 —— 抛出去，由上层决定要不要先问用户、交给谁跑。
   * 执行完必须回一次 `sendToolResult`，否则模型会一直等着。
   */
  | { type: 'tool-call'; callId: string; name: string; args: string }
  /**
   * 用户插话了，**立刻停掉正在播的那一段**。
   *
   * 全双工的重点就在这儿：模型还在说，用户开口打断，服务端会停止后续音频 ——
   * 但我们这边已经排进播放队列的那几百毫秒不会自己消失。不处理的话表现是
   * 「我都开口了它还在自顾自说完」，比不能打断更糟。
   */
  | { type: 'interrupted' }
  /**
   * 用户这段话说完了（服务端判停），识别结果还没到。
   *
   * 只有 OpenAI 那家发得出（`input_audio_buffer.speech_stopped`）。它存在的唯一理由是
   * **给「丢弃残片」一个不依赖识别的出口**：打断之后渲染层会丢掉在途的音频分片，
   * 而原本的出口只有「用户这句识别完了」和「没听清」两条，两条都来自识别。
   * 识别一旦不来（转写没开、网关把转写吞了），那个开关只能等三秒兜底 ——
   * 而模型对一句短问话的整段回答往往还不到三秒，于是**整段回答一个音都没播出来**，
   * 字幕却好好的。这一条把出口和识别解耦。
   */
  | { type: 'user-speech-done' }
  /** 模型这一轮说完了。界面据此收掉「正在说」的状态 */
  | { type: 'turn-done' }
  /**
   * 让渲染层**自己念**这段话（本机语音合成）。
   *
   * 豆包那边先试它自己的「打招呼」事件让它念，等不到音频才发这个当退路
   * （见 `doubaoRealtime.ts` 的 `buildDoubaoGreeting`）。OpenAI 那家不发这个 ——
   * 它有 `response.create`，模型自己转述。
   */
  | { type: 'speak'; text: string }
  /**
   * 一条播报发出去了（豆包念或本机念），把原话交给渲染层写进「语音助手」对话。
   *
   * 只有豆包这条线发：它念的是我们给的定稿，没有文字增量可写。OpenAI 那家由模型
   * 转述，转述的字幕走 `assistant-text` 本来就进对话了，再发这个就是两条。
   */
  | { type: 'announced'; text: string }
  /**
   * 下面两条不是厂商发的，是主进程的任务表发的（同一条事件通道）。
   *
   * 「替 Agent 问用户」的那条播报念出去了 / 用户在界面上把它答掉了。渲染层据此决定
   * 要不要把用户的下一句直接当答案交回去 —— 真机上模型嘴上说「记下了」却不调
   * answer_question，Agent 就一直卡着；这条保险不经过模型。
   */
  | { type: 'question-announced'; taskId: string }
  | { type: 'question-settled'; taskId?: string }
  | { type: 'error'; message: string }
  | { type: 'closed' }

export interface RealtimeToolDefinition {
  name: string
  description: string
  /** JSON Schema。两家都是这个形状，原样发过去 */
  parameters: Record<string, unknown>
}

/** 已有普通对话在实时会话里的最小投影。富媒体不塞给语音模型，只保留文字。 */
export interface RealtimeConversationMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface RealtimeSessionConfig {
  apiKey: string
  /** 不给就用适配器自己的默认地址 */
  baseUrl?: string
  model: string
  /** 音色名。各家自成一套，传什么发什么 */
  voice?: string
  /** 系统提示词。语音场景要特别短 */
  instructions: string
  /** 打开语音前已经发生的普通对话。新会话先注入，语音才能接着上文聊。 */
  history?: RealtimeConversationMessage[]
  /**
   * 回声门限档位（偏好设置 → 语音）。不给按默认档算。
   *
   * **只有 OpenAI 那家用得上** —— 它的服务端 VAD 门限和输入降噪都是可配的，
   * 而默认的 0.5 顶得过本地 AEC 的回声残留。豆包那边的上行事件表里没有对应字段，
   * 它服务端自带一层处理，这个值到了那个适配器里是被忽略的。
   */
  echoGuard?: RealtimeEchoGuard
  tools: RealtimeToolDefinition[]
  onEvent: (event: VoiceSessionEvent) => void
}

/**
 * 一条不是用户发起的播报（任务跑完了、失败了、Agent 正卡着等人答）。
 *
 * **两段分开给，因为去向不一样。** 播报要同时做成两件事：让用户**听见**，
 * 让模型**知道**。这两件事的最佳措辞往往不是同一句 —— 比如 Agent 反问那条，
 * 用户该听见的是问题本身，模型该收到的是「把用户的原话用 `answer_question`
 * 交回来」这条指令。混成一句的话，用户会听见一段对着模型说的话。
 */
export interface VoiceAnnouncement {
  /** 说给用户听的原话 */
  speech: string
  /** 进模型上下文的那份。可以带对模型的指令，用户不一定听得到 */
  context: string
}

export interface VoiceSessionHandle {
  /** 送一段用户音频。base64 的 PCM16 单声道，采样率见 `audioSpec` */
  appendAudio: (base64: string) => void
  /** 用户在语音会话底部直接键入的文字。 */
  sendText: (text: string) => void
  /**
   * 主动播报。
   *
   * **两家的实现方式完全不同**，因为豆包 3.0 的上行事件表里**没有
   * `response.create`** —— 单靠 `conversation.item.create` 把话塞进上下文，
   * 模型只是记住，不会开口。语音派活跑完却一声不吭，根源就在这儿。
   * 逐条差异见各自的适配器。
   */
  announce: (notice: VoiceAnnouncement) => void
  /**
   * 用户插话了，**让服务端停止生成这一轮**。
   *
   * 光在本地掐掉扬声器不够：服务端不知道被打断，会把整轮说完，
   * 而那些音频分片还在源源不断地到 —— 表现就是「打断了一下，然后它接着说完」。
   * 本地停播 + 这一条，缺一不可。
   */
  cancelResponse: () => void
  /**
   * 工具跑完了，把结果交回去。
   *
   * 一次给一批：豆包要求同一轮里的多个调用**聚合成一条**回传，
   * 分开发会被判成参数不完整。OpenAI 一条一条也行，所以统一走批量。
   */
  sendToolResults: (results: { callId: string; output: string }[]) => void
  /** 主动结束。重复调用无害 */
  close: () => void
}

/**
 * 采样率。
 *
 * **进出两个方向可能不一样** —— 豆包收 16k、出 24k。用一个数糊过去的话，
 * 要么模型听到变调的快放，要么用户听到变调的慢放，而两者都不报错。
 */
export interface AudioSpec {
  inputSampleRate: number
  outputSampleRate: number
}
