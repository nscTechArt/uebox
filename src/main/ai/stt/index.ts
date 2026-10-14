import { resolveApiKey } from '../credentials'
import { readSettings } from '../store'
import type { ProviderConfig } from '../types'
import { openDoubaoSttSession } from './doubaoStt'
import { openQwenAudioSttSession } from './qwenAudioStt'
import { openUeboxSttSession } from './ueboxStt'
import { openTranscriptionSttSession, probeTranscription } from './transcriptionStt'
import { isPlanProvider } from '../../../shared/creatorPlan'
import {
  STT_INPUT_SAMPLE_RATE,
  STT_PACKET_MS,
  type SttEvent,
  type SttSessionConfig,
  type SttSessionHandle
} from './types'

export { STT_INPUT_SAMPLE_RATE, STT_PACKET_MS } from './types'
export type { SttEvent, SttSessionHandle } from './types'

/**
 * 语音识别的统一入口。
 *
 * 三个适配器各自处理自己的协议：豆包 sauc、阿里百炼 ASR（这两家是流式的），
 * 以及 OpenAI 兼容的整段转写（本机 SenseVoice / Whisper、硅基流动等，见
 * `transcriptionStt.ts`）。这里只做三件事：**认出连哪一家**、**攒包**、**把凭据取出来**。
 *
 * ## 为什么按 Base URL 认，不看别的
 *
 * 和实时语音那条线同一个套路（`ipc/realtimeVoice.ts` 的 `resolveRealtimeBinding`）：
 * 这两家都不是 OpenAI 兼容那套，协议下拉框对它们没有意义；而域名是**厂商的事实**，
 * 不是让用户回答的问题。多一个「你连的是哪家」的下拉框，只会多一种填错的方式，
 * 而填错的表现是一串谁也看不懂的握手失败。
 */

/** 一包 200 毫秒的 PCM16 单声道有多少字节。攒够这么多才往上发，理由见 `STT_PACKET_MS` */
const PACKET_BYTES = (STT_INPUT_SAMPLE_RATE * 2 * STT_PACKET_MS) / 1000

export interface SttBinding {
  apiKey: string
  baseUrl: string
  /** 豆包那边是资源 ID，阿里那边是模型名。见 `SttSessionConfig.model` */
  model: string
  headers?: Record<string, string>
  /**
   * Box Plan 的来源。它不按域名认（地址是套餐给的，可以是本机联调地址），
   * 按来源 id 认 —— 见 creatorPlan/apply.ts 的 PLAN_PROVIDER_IDS
   */
  plan?: boolean
}

/** 认出这是不是豆包的语音服务（识别、合成、实时语音同一个域名） */
function isDoubaoSpeechUrl(baseUrl: string): boolean {
  return /openspeech\.bytedance\.com/i.test(baseUrl)
}

/** 认出这是不是阿里云百炼的 WebSocket 推理入口（含业务空间专属域名） */
function isDashScopeUrl(baseUrl: string): boolean {
  return /dashscope[.-]|\.maas\.aliyuncs\.com/i.test(baseUrl)
}

/**
 * 其余 http(s) 地址一律按 OpenAI 兼容的整段转写处理。
 *
 * 这是兜底而不是猜：本机服务的地址是 `127.0.0.1:端口`，域名里没有任何厂商的事实
 * 可认，而这一类服务几乎全都实现了 `/v1/audio/transcriptions`。真不是的话，
 * 「测试连接」会把 404 原样报出来，并告诉用户地址该填到哪一层。
 */
function isTranscriptionUrl(baseUrl: string): boolean {
  return /^https?:\/\//i.test(baseUrl.trim())
}

type SttAdapter = 'plan' | 'doubao' | 'qwen' | 'transcription'

/** 这个地址走哪个适配器。开会话、测试连接、开会话前的预检都按它，不各判一遍 */
function sttAdapterOf(baseUrl: string, plan: boolean): SttAdapter | null {
  if (plan) return 'plan'
  if (isDoubaoSpeechUrl(baseUrl)) return 'doubao'
  if (isDashScopeUrl(baseUrl)) return 'qwen'
  if (isTranscriptionUrl(baseUrl)) return 'transcription'
  return null
}

/** 地址一个适配器都对不上时给用户的话。IPC 那头开会话前也用它 */
export const UNSUPPORTED_STT_MESSAGE =
  '无法识别这个语音识别地址。支持豆包语音、阿里云百炼，以及 http(s) 开头的 OpenAI 兼容转写地址（例如 http://127.0.0.1:8000/v1）。'

/**
 * 取「语音识别」角色绑的那个 Provider 与模型。
 *
 * **没绑不是错误。** 调用方（听写）拿不到它时会回落到实时语音那一路，
 * 所以这里回 `null` 而不是抛 —— 抛的话每一个调用点都要写一次 try/catch
 * 才能表达「没绑就算了」。真正的错误（绑了但 Provider 被删了）才抛。
 */
export async function resolveSttBinding(): Promise<SttBinding | null> {
  const settings = await readSettings()
  const binding = settings.roles.stt
  if (!binding) return null

  const provider = settings.providers.find((item) => item.id === binding.providerId)
  if (!provider) {
    throw new Error('语音识别服务商已被删除。请在「设置 → 模型」中重新选择默认模型。')
  }
  return {
    apiKey: await resolveApiKey(provider.apiKey),
    baseUrl: provider.baseUrl,
    model: binding.modelId,
    headers: provider.headers,
    ...(isPlanProvider(provider.id) ? { plan: true } : {})
  }
}

/** 这个地址有没有对应的适配器。绑了一家我们不认识的厂商时用它提前说清楚 */
export function hasSttAdapter(baseUrl: string, plan = false): boolean {
  return sttAdapterOf(baseUrl, plan) !== null
}

/**
 * 开一路识别会话，并在上行方向攒包。
 *
 * 攒包放在这里而不是各家适配器里：流式那两家要的包长一样（100~200ms），而采集那头
 * 给的是 20 毫秒一包 —— 这是**采集侧的事实**，不是厂商差异。写两遍的后果是
 * 改了一处忘了另一处，而症状（识别变慢）不会指向这里。整段转写那一路自己再切帧，
 * 攒不攒对它没有影响。
 */
export function openSttSession(
  binding: SttBinding,
  onEvent: (event: SttEvent) => void
): SttSessionHandle {
  const config: SttSessionConfig = {
    apiKey: binding.apiKey,
    baseUrl: binding.baseUrl,
    model: binding.model,
    ...(binding.headers ? { headers: binding.headers } : {}),
    onEvent
  }
  const adapter = sttAdapterOf(binding.baseUrl, binding.plan === true)
  const session =
    adapter === 'plan'
      ? openUeboxSttSession(config)
      : adapter === 'doubao'
        ? openDoubaoSttSession(config)
        : adapter === 'qwen'
          ? openQwenAudioSttSession(config)
          : openTranscriptionSttSession(config)

  let buffered: Buffer[] = []
  let bufferedBytes = 0

  /**
   * 把攒着的那点音频送出去。
   *
   * 叫 `drain` 不叫 `flush`：`flush` 在这一层已经是**句柄上的那个语义**
   * （告诉厂商说完了、等终稿），两个同名的东西做着不同的事，读代码时分不清。
   */
  const drain = (): void => {
    if (!bufferedBytes) return
    const packet = Buffer.concat(buffered, bufferedBytes)
    buffered = []
    bufferedBytes = 0
    session.appendAudio(packet.toString('base64'))
  }

  return {
    appendAudio: (base64: string) => {
      const pcm = Buffer.from(base64, 'base64')
      if (!pcm.length) return
      buffered.push(pcm)
      bufferedBytes += pcm.length
      if (bufferedBytes >= PACKET_BYTES) drain()
    },
    flush: () => {
      /*
       * 攒着的先送出去，**而且必须赶在收尾包之前**。
       *
       * 「按住说话」松手时走的就是这条，那时候缓冲里正压着最后不到 200 毫秒的
       * 音频 —— 而中文里 200 毫秒足够一个字，缺的正好是一句话的末尾。
       * 顺序反了的话，适配器 `flushed` 之后就不再往外发，这包直接掉地上。
       */
      drain()
      session.flush()
    },
    close: () => {
      // 攒着的先送出去。理由同上
      drain()
      session.close()
    }
  }
}

/** 探测用的超时。比热路径宽松：用户盯着界面等结果时，慢不等于不通 */
const PROBE_TIMEOUT_MS = 20_000

/**
 * 就绪之后再等这么久，看厂商会不会在带内回一个拒绝。
 *
 * 豆包那边的「就绪」是连接一开、请求发出去就报的，**不等服务端回话** —— 资源 ID
 * 不认、没开通这类拒绝是随后第一帧里才来的。就绪即成功的话，测试连接会给一个
 * 配错了的绑定亮绿灯，之后每次听写都失败。
 */
const PROBE_ACK_GRACE_MS = 1_500

/**
 * 「测试连接」。
 *
 * 开一条真会话、等厂商说就绪、然后收掉 —— 不送一个字节的音频。
 * 流式那两家都是**先握手再计费**，所以这一次探测的成本是零，而它验的恰恰是
 * 最容易配错的那两样：密钥对不对、资源 ID / 模型名认不认。
 *
 * 整段转写那一类没有握手，开会话必然「就绪」，只能真送一段静音去问（见 `probeTranscription`）。
 */
export async function probeStt(provider: ProviderConfig, modelId: string): Promise<void> {
  const plan = isPlanProvider(provider.id)
  const adapter = sttAdapterOf(provider.baseUrl, plan)
  if (!adapter) throw new Error(UNSUPPORTED_STT_MESSAGE)
  const apiKey = await resolveApiKey(provider.apiKey)
  if (adapter === 'transcription') {
    await probeTranscription(
      { apiKey, baseUrl: provider.baseUrl, model: modelId, headers: provider.headers },
      AbortSignal.timeout(PROBE_TIMEOUT_MS)
    )
    return
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let session: SttSessionHandle | null = null
    let grace: ReturnType<typeof setTimeout> | null = null
    const done = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      // 先置 settled 再关：关会话自己会发一条 `closed`，不挡的话它会把
      // 一次成功的探测覆盖成「服务端断开了连接」
      session?.close()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => done(new Error('连接超时')), PROBE_TIMEOUT_MS)
    session = openSttSession(
      {
        apiKey,
        baseUrl: provider.baseUrl,
        model: modelId,
        headers: provider.headers,
        ...(plan ? { plan } : {})
      },
      (event) => {
        // 就绪之后稍等一下，带内的拒绝来了就按失败报（见 PROBE_ACK_GRACE_MS）
        if (event.type === 'ready' && !grace) grace = setTimeout(() => done(), PROBE_ACK_GRACE_MS)
        // 握手没过、资源 ID 不对都走这条。原话直接交上去 —— 厂商那句比我们能编的准
        if (event.type === 'error') done(new Error(event.message))
        if (event.type === 'closed') done(new Error('服务端断开了连接'))
      }
    )
  })
}
