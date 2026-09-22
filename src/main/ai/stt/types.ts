/**
 * 流式语音识别会话的中性词汇表。
 *
 * 两家（豆包 STT 2.0、阿里云 Qwen-Audio ASR）各有一个适配器，共用这一份形状 ——
 * 上层（IPC、渲染层）不该知道当前连的是谁。
 *
 * ## 为什么不直接复用 `ai/realtime/types.ts`
 *
 * 事件名是故意对齐的（`ready` / `user-text` / `asr-failed` / `error` / `closed`），
 * 渲染层那条听写链路收到哪一路的事件都能照原样处理 —— 这正是「换一家厂商不用
 * 改界面」的代价最低的做法。但**只对齐这五条**：那边还有 `audio`、`tool-call`、
 * `interrupted`、`turn-done` 十几条，每一条在这里都永远不会发生。把它们一起继承
 * 过来，读代码的人就得逐条去确认「这个分支到底会不会走」，而答案全是「不会」。
 */

/** 一次听写里我们关心的事件。已经翻译成中性形状，与厂商无关 */
export type SttEvent =
  /** 厂商就绪，可以开始送音频。收到之前采到的音频由上层攒着 */
  | { type: 'ready' }
  /**
   * 识别结果。`final` 为假时是中间态 —— 同一句话会被反复改写，
   * 界面可以先显示，但不能拿它去做「说完了」的判断。
   */
  | { type: 'user-text'; text: string; final: boolean }
  /**
   * 这一段没听清。
   *
   * 和 `error` 分开：识别失败**不该掐掉会话**，再说一遍就好。
   */
  | { type: 'asr-failed' }
  /** 会话本身出问题了，带一句能说给用户看的话。收到之后这条会话就废了 */
  | { type: 'error'; message: string }
  /** 会话结束（厂商关的、或者我们自己关的） */
  | { type: 'closed' }

export interface SttSessionConfig {
  apiKey: string
  /** 厂商地址。用户在 Provider 里填的那个，适配器按它决定后面拼什么 */
  baseUrl: string
  /**
   * 传给厂商的那个字符串。
   *
   * 两家的含义不一样，而且都不是「模型名」的直觉含义：豆包那边是
   * **资源 ID**（`volc.seedasr.sauc.duration`，还分小时版和并发版），
   * 阿里那边才是真正的模型名。所以这里不叫 `model` 也不做校验 ——
   * 用户填什么发什么，填错了厂商的报错比我们能编的任何一句都准。
   */
  model: string
  /** Provider 上的自定义请求头，原样带上 */
  headers?: Record<string, string>
  onEvent: (event: SttEvent) => void
}

export interface SttSessionHandle {
  /** 送一段用户音频。base64 的 PCM16 单声道，采样率见 `STT_INPUT_SAMPLE_RATE` */
  appendAudio: (base64: string) => void
  /** 主动结束。重复调用无害 */
  close: () => void
}

/**
 * 上行采样率。**两家都只收 16k**，所以这是个常量而不是每家一份。
 *
 * 豆包的文档写死了「目前只支持 16000」；阿里那边任意采样率都收，跟着写 16k
 * 是因为识别模型本来就在 16k 上训练，送 24k 只是多花带宽。
 *
 * 渲染层要拿它去创建 `AudioContext`（让浏览器替我们重采样），所以它必须
 * 在开会话**之前**就能回答 —— 见 `ipc/speechToText.ts` 的 `audio-spec`。
 */
export const STT_INPUT_SAMPLE_RATE = 16_000

/**
 * 上行攒够这么多毫秒再发一包。
 *
 * 采集那头是 20 毫秒一包（`pcmCapture.worklet.js`），而豆包的文档明确写着
 * 「单包建议 100~200ms，过大或过小都会影响性能，双向流式 200ms 最优」。
 * 直接转发的话就是每秒 50 个小包，每包还各带一次 gzip 和一个协议头。
 *
 * 代价是最多多 200 毫秒的首字延迟，这在听写里看不出来 —— 用户在等的是
 * 「说完一整句之后出字」，不是逐字上屏。
 */
export const STT_PACKET_MS = 200
