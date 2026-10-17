import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveApiKey } from './credentials'
import type { ProviderConfig } from './types'
import { saveMediaFile } from '../services/taskVideo/files'
import { wavBytes } from '../services/taskVideo/audio'

/**
 * ElevenLabs 音效（`POST /sound-generation`）。
 *
 * 和配乐不一样，这个接口是同步的：一次请求直接回音频字节，没有任务号可以续查。
 * 所以防重复扣费只剩一件事 —— 提交前先落回执，回执在、文件不在就说明上次结果
 * 没确认，不再自动提交。
 *
 * 要 PCM 不要 MP3：UE 不导入 MP3，而本机不一定有 FFmpeg 可以转码。
 * 44.1 kHz 的 PCM 要 Pro 档账号，低档账号会 4xx 拒收（拒收不建任务、不收费），
 * 那就降到 22.05 kHz 再要一次。
 */

export interface SoundEffectRequest {
  prompt: string
  /** 0.5–30 秒；不填由服务商按描述定 */
  seconds?: number
  loop: boolean
}

/** 先要高采样率，账号档位不够再降一档 */
const PCM_RATES = [44100, 22050] as const

export function soundEffectRequest(
  provider: ProviderConfig,
  model: string,
  request: SoundEffectRequest,
  sampleRate: number
): { endpoint: string; body: Record<string, unknown> } {
  const base = provider.baseUrl.replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) throw new Error('音效服务地址必须为 HTTP(S) 地址。')
  return {
    endpoint: `${base}/sound-generation?output_format=pcm_${sampleRate}`,
    body: {
      text: request.prompt,
      model_id: model,
      loop: request.loop,
      ...(request.seconds === undefined ? {} : { duration_seconds: request.seconds })
    }
  }
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text
}

export async function generateSoundEffect(
  provider: ProviderConfig,
  model: string,
  request: SoundEffectRequest,
  /** 第几个变体。同样的描述要几个不同版本时靠它区分回执，否则拿回来的是同一个文件 */
  variant: number,
  dir: string,
  signal?: AbortSignal
): Promise<{ path: string; seconds: number; reused: boolean }> {
  const key = await resolveApiKey(provider.apiKey)
  if (!key) throw new Error('音效来源没有配置 API 密钥。')
  await fs.mkdir(dir, { recursive: true })
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        provider: provider.id,
        baseUrl: provider.baseUrl,
        model,
        prompt: request.prompt,
        seconds: request.seconds ?? null,
        loop: request.loop,
        variant
      })
    )
    .digest('hex')
  const target = path.join(dir, `${hash}.wav`)
  const receipt = path.join(dir, `${hash}.json`)
  const done = await fs.stat(target).catch(() => null)
  if (done?.size)
    return { path: target, seconds: wavSeconds(await fs.readFile(target)), reused: true }
  try {
    await fs.writeFile(receipt, JSON.stringify({ model, ...request, variant }), { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `上次音效提交结果未确认，可能已收费，不会自动重复生成。请先查看服务商的用量记录；确认要重做时删除回执 ${receipt} 再试。`
      )
    throw error
  }
  const combined = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(3 * 60_000)
  ])
  let rejected = ''
  for (const rate of PCM_RATES) {
    const { endpoint, body } = soundEffectRequest(provider, model, request, rate)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...provider.headers, 'Content-Type': 'application/json', 'xi-api-key': key },
      body: JSON.stringify(body),
      signal: combined,
      redirect: 'error'
    })
    // 4xx（超时、限流除外）是明确拒收，没生成也不收费：换低一档采样率再要；都被拒就删回执，改好能直接重试
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      response.status !== 429
    ) {
      rejected ||= `HTTP ${response.status}：${redact((await response.text().catch(() => '')).slice(0, 500), key)}`
      continue
    }
    if (!response.ok)
      throw new Error(
        `音效生成失败：HTTP ${response.status}。服务商是否已扣费无法确认，不会自动重试；回执保留在 ${receipt}。`
      )
    const pcm = Buffer.from(await response.arrayBuffer())
    if (!pcm.length) throw new Error('音效服务返回了空音频。')
    await saveMediaFile(target, wavBytes(pcm, rate))
    return { path: target, seconds: pcm.length / (rate * 2), reused: false }
  }
  await fs.rm(receipt, { force: true })
  throw new Error(`音效生成请求被拒绝（${rejected}）。服务商未受理本次请求，修正后可重试。`)
}

/** 读回 WAV 头里的采样率算时长：复用旧文件时不用再记一份元数据 */
function wavSeconds(wav: Buffer): number {
  if (wav.length <= 44) return 0
  return (wav.length - 44) / (wav.readUInt32LE(24) * 2)
}
