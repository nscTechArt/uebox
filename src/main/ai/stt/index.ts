import { resolveApiKey } from '../credentials'
import { readSettings } from '../store'
import type { ProviderConfig } from '../types'
import { openDoubaoSttSession } from './doubaoStt'
import { openQwenAudioSttSession } from './qwenAudioStt'
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
 * 流式语音识别的统一入口。
 *
 * 两家适配器（豆包 sauc、阿里百炼 ASR）各自处理自己的协议，这里只做三件事：
 * **认出连哪一家**、**攒包**、**把凭据取出来**。
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
    throw new Error('语音识别服务商已被删除。请到 设置 → 模型 重新选择默认模型。')
  }
  return {
    apiKey: await resolveApiKey(provider.apiKey),
    baseUrl: provider.baseUrl,
    model: binding.modelId,
    headers: provider.headers
  }
}

/** 这个地址有没有对应的适配器。绑了一家我们不认识的厂商时用它提前说清楚 */
export function hasSttAdapter(baseUrl: string): boolean {
  return isDoubaoSpeechUrl(baseUrl) || isDashScopeUrl(baseUrl)
}

/**
 * 开一路识别会话，并在上行方向攒包。
 *
 * 攒包放在这里而不是各家适配器里：两家要的包长一样（100~200ms），而采集那头
 * 给的是 20 毫秒一包 —— 这是**采集侧的事实**，不是厂商差异。写两遍的后果是
 * 改了一处忘了另一处，而症状（识别变慢）不会指向这里。
 */
export function openSttSession(
  binding: SttBinding,
  onEvent: (event: SttEvent) => void
): SttSessionHandle {
  const config: SttSessionConfig = { ...binding, onEvent }
  const session = isDoubaoSpeechUrl(binding.baseUrl)
    ? openDoubaoSttSession(config)
    : openQwenAudioSttSession(config)

  let buffered: Buffer[] = []
  let bufferedBytes = 0

  const flush = (): void => {
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
      if (bufferedBytes >= PACKET_BYTES) flush()
    },
    close: () => {
      // 攒着的先送出去。丢掉的话，用户最后那 200 毫秒说的字就没了 ——
      // 而中文里 200 毫秒足够一个字，缺的正好是一句话的末尾
      flush()
      session.close()
    }
  }
}

/** 探测用的超时。比热路径宽松：用户盯着界面等结果时，慢不等于不通 */
const PROBE_TIMEOUT_MS = 20_000

/**
 * 「测试连接」。
 *
 * 开一条真会话、等厂商说就绪、然后收掉 —— 不送一个字节的音频。
 * 两家都是**先握手再计费**，所以这一次探测的成本是零，而它验的恰恰是
 * 最容易配错的那两样：密钥对不对、资源 ID / 模型名认不认。
 */
export async function probeStt(provider: ProviderConfig, modelId: string): Promise<void> {
  if (!hasSttAdapter(provider.baseUrl)) {
    throw new Error('认不出这个语音识别服务商。目前支持豆包语音（openspeech）与阿里云百炼。')
  }
  const apiKey = await resolveApiKey(provider.apiKey)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let session: SttSessionHandle | null = null
    const done = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 先置 settled 再关：关会话自己会发一条 `closed`，不挡的话它会把
      // 一次成功的探测覆盖成「服务端断开了连接」
      session?.close()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => done(new Error('连接超时')), PROBE_TIMEOUT_MS)
    session = openSttSession(
      { apiKey, baseUrl: provider.baseUrl, model: modelId, headers: provider.headers },
      (event) => {
        if (event.type === 'ready') done()
        // 握手没过、资源 ID 不对都走这条。原话直接交上去 —— 厂商那句比我们能编的准
        if (event.type === 'error') done(new Error(event.message))
        if (event.type === 'closed') done(new Error('服务端断开了连接'))
      }
    )
  })
}
