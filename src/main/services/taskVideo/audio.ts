import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readSettings } from '../../ai/store'
import { requestSpeech, type SpeechOptions } from '../../ai/speech'
import { CreatorPlanCallError } from '../../ai/creatorPlan/callError'
import { recoverMediaFile, saveMediaFile } from './files'
import type { Storyboard } from './schema'
import type { ProviderConfig } from '../../ai/types'

const PCM_BYTES_PER_SECOND = 48000

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).size > 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

type SpeechBinding = { provider: ProviderConfig; modelId: string }

/** 用户在「语音合成」上绑的模型；没绑返回 undefined，绑了但模型不在了直接报错。 */
export async function resolveSpeechBinding(): Promise<SpeechBinding | undefined> {
  const settings = await readSettings()
  const binding = settings.roles.tts
  if (!binding) return undefined
  const provider = settings.providers.find((p) => p.id === binding.providerId && p.kind === 'tts')
  if (!provider || !provider.models.some((m) => m.id === binding.modelId))
    throw new Error('已配置的配音模型不可用，请到偏好设置 → 模型来源修复语音合成。')
  return { provider, modelId: binding.modelId }
}

/**
 * 一段文字合成一段 PCM（24kHz、16 位、单声道），按文字和模型取缓存：
 * 同样的话再要一次直接复用，不重复扣费。独立配音和视频旁白都走这里。
 */
export async function speakToFile(
  { provider, modelId }: SpeechBinding,
  text: string,
  cacheDir: string,
  signal?: AbortSignal,
  onSynthesize: () => void = () => {},
  options: SpeechOptions = {}
): Promise<{ path: string; seconds: number }> {
  const key = digest({
    text,
    provider: provider.id,
    baseUrl: provider.baseUrl,
    model: modelId,
    voice: options.voice ?? provider.models.find((m) => m.id === modelId)?.ttsVoice,
    // 不带演法时不进键：以前合成过的配音照旧命中缓存
    ...(options.instruction ? { instruction: options.instruction } : {})
  })
  await fs.mkdir(cacheDir, { recursive: true })
  const speechFile = path.join(cacheDir, `${key}.pcm`)
  await recoverMediaFile(speechFile)
  if (!(await exists(speechFile))) {
    const legacyPrefix = `${key}.pcm.`
    if (
      (await fs.readdir(cacheDir)).some(
        (name) => name.startsWith(legacyPrefix) && name.endsWith('.tmp')
      )
    )
      throw new Error(
        `配音存在旧版临时文件，无法确认音频是否完整，已停止重复生成。请先检查 ${cacheDir} 中对应的 ${key}.pcm.*.tmp，确认完整后恢复为 ${key}.pcm 再重试。`
      )
    onSynthesize()
    const chunks: Buffer[] = []
    await requestSpeech(
      provider,
      modelId,
      text,
      signal ?? new AbortController().signal,
      (chunk) => chunks.push(Buffer.from(chunk.base64, 'base64')),
      options
    ).catch((error: unknown) => {
      // Box Plan 的额度 / 订阅 / 授权错误：错误码后面挂着说清下一步的原话，给它
      const cause = error instanceof Error ? error.cause : undefined
      throw cause instanceof CreatorPlanCallError ? cause : error
    })
    const audio = Buffer.concat(chunks)
    if (!audio.length) throw new Error('配音返回空音频。')
    await saveMediaFile(speechFile, audio)
  }
  return { path: speechFile, seconds: (await fs.stat(speechFile)).size / PCM_BYTES_PER_SECOND }
}

/** 给 PCM 套上 WAV 头，播放器、UE 导入都能直接用。 */
export async function pcmToWav(pcmFile: string, wavFile: string): Promise<void> {
  if (await exists(wavFile)) return
  await saveMediaFile(wavFile, wavBytes(await fs.readFile(pcmFile), 24000))
}

/** 单声道 16 位 PCM 加 WAV 头。配音是 24000，音效按服务商实际给的采样率传 */
export function wavBytes(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Lock narration before visual choreography so animation follows the actual voice, not an estimate. */
export async function prepareVideoAudio(
  projectDir: string,
  storyboard: Storyboard,
  signal?: AbortSignal,
  report: (text: string) => void = () => {}
): Promise<{ storyboard: Storyboard; audio: (string | undefined)[]; voiceUsed: boolean }> {
  const binding = storyboard.voice === 'auto' ? await resolveSpeechBinding() : undefined
  const cacheDir = path.join(projectDir, 'audio')
  await fs.mkdir(cacheDir, { recursive: true })
  const scenes: Storyboard['scenes'] = []
  const audio: (string | undefined)[] = []
  let totalDuration = 0
  let voiceUsed = false
  for (const [index, scene] of storyboard.scenes.entries()) {
    signal?.throwIfAborted()
    let duration = scene.duration
    let speechFile: string | undefined
    if (binding && scene.narration.trim()) {
      const spoken = await speakToFile(binding, scene.narration, cacheDir, signal, () =>
        report(`正在生成第 ${index + 1} 段配音`)
      )
      speechFile = spoken.path
      duration = Math.max(duration, spoken.seconds + 0.35)
      voiceUsed = true
    } else if (scene.kind !== 'composition') {
      duration = Math.max(duration, Array.from(scene.caption + scene.body).length / 6)
    }
    duration = Math.ceil(duration * 30) / 30
    totalDuration += duration
    if (totalDuration > 600)
      throw new Error('实际配音后的时长超过 10 分钟，请拆成多条视频；已生成音频已保留。')
    scenes.push({ ...scene, duration })
    audio.push(speechFile)
  }
  const actual = { ...storyboard, scenes }
  await fs.writeFile(
    path.join(projectDir, 'timing.json'),
    JSON.stringify({ storyboard: actual, audio, voiceUsed }, null, 2)
  )
  return { storyboard: actual, audio, voiceUsed }
}
