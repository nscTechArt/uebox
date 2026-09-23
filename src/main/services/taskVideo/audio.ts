import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readSettings } from '../../ai/store'
import { requestSpeech } from '../../ai/speech'
import { CreatorPlanCallError } from '../../ai/creatorPlan/callError'
import { recoverMediaFile, saveMediaFile } from './files'
import type { Storyboard } from './schema'

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

/** Lock narration before visual choreography so animation follows the actual voice, not an estimate. */
export async function prepareVideoAudio(
  projectDir: string,
  storyboard: Storyboard,
  signal?: AbortSignal,
  report: (text: string) => void = () => {}
): Promise<{ storyboard: Storyboard; audio: (string | undefined)[]; voiceUsed: boolean }> {
  const settings = await readSettings()
  const binding = storyboard.voice === 'auto' ? settings.roles.tts : undefined
  const provider = binding
    ? settings.providers.find((p) => p.id === binding.providerId && p.kind === 'tts')
    : undefined
  if (binding && (!provider || !provider.models.some((m) => m.id === binding.modelId)))
    throw new Error('已配置的配音模型不可用，请修复配置或明确关闭配音。')
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
    if (provider && binding && scene.narration.trim()) {
      const key = digest({
        text: scene.narration,
        provider: provider.id,
        baseUrl: provider.baseUrl,
        model: binding.modelId,
        voice: provider.models.find((m) => m.id === binding.modelId)?.ttsVoice
      })
      speechFile = path.join(cacheDir, `${key}.pcm`)
      await recoverMediaFile(speechFile)
      if (!(await exists(speechFile))) {
        const legacyPrefix = `${key}.pcm.`
        if (
          (await fs.readdir(cacheDir)).some(
            (name) => name.startsWith(legacyPrefix) && name.endsWith('.tmp')
          )
        )
          throw new Error(
            `第 ${index + 1} 段配音存在旧版临时文件，无法确认音频是否完整，已停止重复生成。请先检查 ${cacheDir} 中对应的 ${key}.pcm.*.tmp，确认完整后恢复为 ${key}.pcm，再继续同一工程。`
          )
        report(`正在生成第 ${index + 1} 段配音`)
        const chunks: Buffer[] = []
        await requestSpeech(
          provider,
          binding.modelId,
          scene.narration,
          signal ?? new AbortController().signal,
          (chunk) => chunks.push(Buffer.from(chunk.base64, 'base64'))
        ).catch((error: unknown) => {
          // 创作者 Token Plan 的额度 / 订阅 / 授权错误：错误码后面挂着说清下一步的原话，给它
          const cause = error instanceof Error ? error.cause : undefined
          throw cause instanceof CreatorPlanCallError ? cause : error
        })
        const audio = Buffer.concat(chunks)
        if (!audio.length) throw new Error('配音返回空音频。')
        await saveMediaFile(speechFile, audio)
      }
      duration = Math.max(duration, (await fs.stat(speechFile)).size / 48000 + 0.35)
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
