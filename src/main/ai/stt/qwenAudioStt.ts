import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  STT_FLUSH_GRACE_MS,
  STT_INPUT_SAMPLE_RATE,
  type SttEvent,
  type SttSessionConfig
} from './types'
import type { SttSessionHandle } from './types'

/**
 * 阿里云百炼实时语音识别（Qwen-Audio 3.x ASR Flash Streaming / Fun-ASR Realtime）。
 *
 * ## 和同一个地址上的语音合成是同一套协议
 *
 * `wss://dashscope.aliyuncs.com/api-ws/v1/inference` 这个端点上跑的是百炼统一的
 * 「指令 + 二进制」协议：`run-task` 开任务、`task-started` 之后才能送数据、
 * `finish-task` 收摊。语音合成那边（`speechQwenAudio.ts`）走的就是同一套，
 * 只是 `task` 从 `tts` 换成 `asr`、二进制的方向从下行换成上行。
 *
 * **两边没有抽出公共层**，是有意的：共用的只有三个字段名和一个 task_id，
 * 而不共用的是每一个参数、每一个事件、以及二进制往哪个方向走。抽出来之后
 * 两边都要绕着那个壳写，读的人还得先去壳里确认自己这一路走的是哪几个分支。
 *
 * ## 两个「填对了才不出错」的地方
 *
 * 1. **`task-started` 之前送的音频会被丢掉。** 所以 `ready` 必须等这个事件，
 *    不能在 `open` 时就放行 —— 表现是每次都吃掉开头一两个字。
 * 2. **心跳包也长成一条识别结果**（`sentence.heartbeat === true`，
 *    `sentence_id` 固定 0）。不认这一位的话，用户不说话时输入框会被一串
 *    空句子刷新。
 *
 * @see https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api
 */

const DEFAULT_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'

/**
 * VAD 判停阈值（毫秒）。
 *
 * 厂商默认 1300，那是给会议转写调的 —— 听写场景里用户说完一句要干等一秒多
 * 才出终稿，而终稿之后还压着我们自己两秒的自动提交倒计时。800 与豆包那条线
 * 的 `end_window_size` 取同一个数，两家的停顿手感才一致。
 */
const MAX_SENTENCE_SILENCE_MS = 800

/** 关会话时最多等厂商回 `task-finished` 这么久，超了就硬断 */
const CLOSE_GRACE_MS = 1_000

export function resolveQwenSttUrl(baseUrl?: string): string {
  const url = (baseUrl?.trim() || DEFAULT_URL).replace(/^http/i, 'ws').replace(/\/+$/, '')
  return url
}

interface DashScopeSentence {
  text?: string
  heartbeat?: boolean
  sentence_end?: boolean
}

/**
 * 一条 `result-generated` 里的分句翻成我们的事件。回 `null` 表示「这条不该上屏」。
 *
 * 单独抽出来是因为它有两条**静默**的分支：心跳包和空文本。两条都错的话
 * 症状一样 —— 用户不说话时输入框自己在动，而日志里一条异常都没有。
 */
export function sentenceToEvent(sentence: DashScopeSentence | undefined): SttEvent | null {
  // 心跳包：持续送静音时厂商用它保活，`sentence_id` 固定 0、文本为空
  if (!sentence || sentence.heartbeat) return null
  const text = sentence.text?.trim()
  if (!text) return null
  return { type: 'user-text', text, final: sentence.sentence_end === true }
}

interface DashScopeEvent {
  header?: {
    task_id?: string
    event?: string
    error_code?: string
    error_message?: string
  }
  payload?: {
    output?: {
      sentence?: DashScopeSentence
    }
  }
}

export function openQwenAudioSttSession(config: SttSessionConfig): SttSessionHandle {
  const socket = new WebSocket(resolveQwenSttUrl(config.baseUrl), {
    headers: {
      ...config.headers,
      Authorization: `Bearer ${config.apiKey}`,
      'user-agent': 'unreal-box'
    },
    handshakeTimeout: 15_000,
    // 上行是 PCM，压不动；而压缩会把后面的 send 排在 zlib 的异步回调后面。
    // 理由与实时语音那条线相同
    perMessageDeflate: false
  })

  const taskId = randomUUID()
  let closed = false
  /** 已经发过收尾包。发完还继续收终稿，但不再接受新音频 */
  let flushed = false
  let started = false
  /** 真的把 socket 收掉了没有。`closed` 只表示「不再接受新事件」，两者不同步 */
  let finished = false
  let closeTimer: ReturnType<typeof setTimeout> | null = null

  const emit = (event: SttEvent): void => {
    if (closed && event.type !== 'closed') return
    config.onEvent(event)
  }

  function finish(): void {
    // 关这条路有三个入口（超时、厂商的 close、task-finished），都会走到这儿
    if (finished) return
    finished = true
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
    socket.removeAllListeners()
    socket.on('error', () => {})
    socket.terminate()
    config.onEvent({ type: 'closed' })
  }

  const fail = (message: string): void => {
    if (closed) return
    closed = true
    emit({ type: 'error', message })
    finish()
  }

  function send(action: string, payload: Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(
      JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload }),
      (error) => {
        if (error) fail(error.message)
      }
    )
  }

  socket.on('open', () => {
    if (closed) return
    send('run-task', {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: config.model,
      parameters: {
        format: 'pcm',
        sample_rate: STT_INPUT_SAMPLE_RATE,
        /*
         * VAD 断句而不是语义断句。语义断句更准，但它要等模型判断这句话说完没有，
         * 交互场景里那几百毫秒就是干等 —— 厂商自己的建议也是「会议转写用语义，
         * 交互用 VAD」。
         */
        semantic_punctuation_enabled: false,
        max_sentence_silence: MAX_SENTENCE_SILENCE_MS
      },
      input: {}
    })
  })

  socket.on('message', (data, isBinary) => {
    if (closed || isBinary) return
    try {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      const event = JSON.parse(bytes.toString('utf8')) as DashScopeEvent
      // 连接可以复用（厂商支持一条连接跑多个任务），所以别人的 task_id 要认出来丢掉
      if (event.header?.task_id && event.header.task_id !== taskId) return
      accept(event)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  })

  socket.on('error', (error) => fail(error.message))
  socket.on('close', () => {
    // flush 之后厂商回完终稿就会自己关，走的正是这条。兜底闹钟得撤掉
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
    if (closed) return
    closed = true
    finish()
  })

  function accept(event: DashScopeEvent): void {
    switch (event.header?.event) {
      case 'task-started':
        if (started) return
        started = true
        emit({ type: 'ready' })
        break
      case 'result-generated': {
        const next = sentenceToEvent(event.payload?.output?.sentence)
        if (next) emit(next)
        break
      }
      case 'task-finished':
        if (closed) return
        closed = true
        finish()
        break
      case 'task-failed': {
        const code = event.header.error_code || ''
        const message = event.header.error_message || ''
        fail([code, message].filter(Boolean).join('：') || '识别任务失败')
        break
      }
      default:
        break
    }
  }

  const handle: SttSessionHandle = {
    appendAudio: (base64: string) => {
      // `task-started` 之前送的音频厂商会丢掉。上层本来就攒着等 ready，
      // 这里再挡一道 —— 两个条件里漏一个，表现都是「每次吃掉开头几个字」
      // 收尾包之后再送音频厂商会当协议错误。松手到真正收摊之间还有一两包在路上
      if (closed || flushed || !started || socket.readyState !== WebSocket.OPEN) return
      const pcm = Buffer.from(base64, 'base64')
      if (pcm.length) socket.send(pcm)
    },
    /**
     * 音频到此为止，但继续等终稿（见 `SttSessionHandle.flush`）。
     *
     * **不置 `closed`** —— 这是它和 `close` 唯一的、也是全部的区别。置了的话
     * `emit` 会把 `finish-task` 换回来的那条终稿挡在门外，用户松手之后
     * 就永远少最后一句。
     *
     * 这里不主动 `socket.close()`：厂商回完 `task-finished` 会自己关，
     * 那条由下面的 `socket.on('close')` 接住。我们只留一个兜底闹钟。
     */
    flush: () => {
      if (closed || flushed) return
      flushed = true
      if (!started || socket.readyState !== WebSocket.OPEN) {
        handle.close()
        return
      }
      send('finish-task', { input: {} })
      closeTimer = setTimeout(() => handle.close(), STT_FLUSH_GRACE_MS)
    },
    close: () => {
      if (closed) return
      closed = true
      if (closeTimer) clearTimeout(closeTimer)
      closeTimer = null
      // 先好好收尾：没有 finish-task 的话这条任务要等厂商超时才结束，而那是计费的。
      // flush 已经发过就不再发 —— 那条任务在厂商那边早就结束了
      if (started && !flushed) send('finish-task', { input: {} })
      closeTimer = setTimeout(finish, CLOSE_GRACE_MS)
      socket.once('close', finish)
      if (socket.readyState === WebSocket.OPEN) socket.close()
      else finish()
    }
  }
  return handle
}
