/**
 * 音效生成。
 *
 * 两条路，按「音效生成」角色绑没绑来分：
 * - 绑了 ElevenLabs：本工具按描述生成写实音效，输出 WAV，存进素材库 AIGC/音效。
 * - 没绑：本工具不出声音，只回一句本机 FFmpeg 在哪（或没装），由 Agent 按
 *   `sound-effects` 技能用 `run_shell_command` 合成。没绑不等于不能用 ——
 *   和网页检索不绑就用内置浏览器是一个思路。
 *
 * 只有一个入口而不是两个工具：模型不必先猜用户配了什么，调一次就知道该走哪条。
 */

import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import { readSettings, readSettingsSync } from '../../../ai/store'
import { isPlanProvider } from '../../../../shared/creatorPlan'

const GenerateSoundEffectInput = z.object({
  prompt: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      '音效描述，用英文写效果更好：声源、材质、动作、空间感，如 "footstep on wooden floor, single step, dry"'
    ),
  seconds: z
    .number()
    .min(0.5)
    .max(30)
    .optional()
    .describe('时长（秒）。短促的单次音效不用填，由服务商按描述定'),
  loop: z.boolean().default(false).describe('要无缝循环时打开：风声、引擎声、环境底噪'),
  variants: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(1)
    .describe('同一描述出几个不同版本。脚步、枪声这类在 UE 里要随机轮换着播的才多出')
})

export interface GeneratedSoundEffectDetails {
  /** `local`：没绑音效服务，交给 Agent 用本机 FFmpeg 合成 */
  mode: 'cloud' | 'local'
  tracks?: { path: string; seconds: number; assetKey?: string; save_error?: string }[]
  ffmpeg?: string | null
  /** 本机合成的 WAV 往这里写，和云端生成的放在一起 */
  outputDir?: string
}

function sfxBound(): boolean {
  try {
    return !!readSettingsSync().roles.sfx
  } catch {
    return false
  }
}

const CLOUD_NOTE =
  '当前绑的是 ElevenLabs：每个变体单独计费；同样的参数再调一次复用已有文件，不重复扣费。'
const LOCAL_NOTE =
  '当前没绑音效服务：调用后只返回本机 FFmpeg 路径，按 `sound-effects` 技能用 `run_shell_command` 合成。'

export function createGenerateSoundEffectTool(): UnrealAgentTool<GeneratedSoundEffectDetails> {
  return defineTool<typeof GenerateSoundEffectInput, GeneratedSoundEffectDetails>({
    name: 'generate_sound_effect',
    namespace: 'aigc',
    risk: 'mutating',
    concurrency: 'sequential',
    description:
      '生成游戏音效（脚步、点击、爆炸、枪声、环境循环等），输出可直接导入 UE 的 WAV，按 `sound-effects` 技能执行。' +
      '配乐用 `generate_task_music`，台词旁白用 `generate_speech`，都不是本工具。' +
      '返回 tracks 里的每个文件都给出本地音频链接供试听；要放进工程把路径交给 `ue_content_import`。' +
      '失败时引用具体错误，不猜测密钥、余额或扣费情况，未确认原因前不换描述重试。' +
      (sfxBound() ? CLOUD_NOTE : LOCAL_NOTE),
    input: GenerateSoundEffectInput,
    execute: async ({ prompt, seconds, loop, variants }, ctx) => {
      const settings = await readSettings()
      const binding = settings.roles.sfx
      const { app } = await import('electron')
      const { join } = await import('node:path')
      const dir = join(app.getPath('music'), 'UnrealBox', 'sfx')
      if (!binding) {
        const { findFFmpeg } = await import('../../../services/ffmpegPath')
        const ffmpeg = await findFFmpeg()
        const details: GeneratedSoundEffectDetails = { mode: 'local', ffmpeg, outputDir: dir }
        return {
          text: ffmpeg
            ? `没有绑定音效服务，改用本机合成。FFmpeg：${ffmpeg}；WAV 写到 ${dir}。按 sound-effects 技能用 run_shell_command 合成。`
            : '没有绑定音效服务，本机也没检测到 FFmpeg。告诉用户两条路任选：安装 FFmpeg（如 winget install Gyan.FFmpeg）后本机合成；或到偏好设置 → 模型来源，为「音效生成」配置 ElevenLabs。',
          details
        }
      }
      if (isPlanProvider(binding.providerId))
        throw new Error(
          'Box Plan 暂不提供音效生成。请到偏好设置 → 模型来源为「音效生成」选择 ElevenLabs，或清空让 Agent 用本机 FFmpeg 合成。'
        )
      const provider = settings.providers.find(
        (p) => p.id === binding.providerId && p.kind === 'sfx'
      )
      if (!provider || !provider.models.some((m) => m.id === binding.modelId))
        throw new Error('「音效生成」绑定的模型不存在。请到偏好设置 → 模型来源重新选择。')

      const { generateSoundEffect } = await import('../../../ai/soundEffect')
      const { saveLocalMusicAsset } = await import('../../../services/aigc/assetSaver')
      const tracks: NonNullable<GeneratedSoundEffectDetails['tracks']> = []
      for (let variant = 0; variant < variants; variant++) {
        ctx.report({ text: `正在生成音效 ${variant + 1}/${variants}` })
        const result = await generateSoundEffect(
          provider,
          binding.modelId,
          { prompt, seconds, loop },
          variant,
          dir,
          ctx.signal
        )
        const seconds_ = Number(result.seconds.toFixed(2))
        try {
          const saved = await saveLocalMusicAsset(result.path, prompt, 'sound')
          tracks.push({ path: saved.filePath, seconds: seconds_, assetKey: saved.assetKey })
        } catch (error) {
          // 文件已经生成好了，素材库不可用不影响试听和导入
          tracks.push({ path: result.path, seconds: seconds_, save_error: String(error) })
        }
      }
      const details: GeneratedSoundEffectDetails = { mode: 'cloud', tracks }
      return { text: JSON.stringify(details), details }
    }
  })
}
