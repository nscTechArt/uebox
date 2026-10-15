/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 工具这一层守的是分路：没绑就交给本机合成（并说清 FFmpeg 在不在），
 * 绑了就逐个变体生成、入素材库，入库失败不吞掉已生成的文件。
 */

const settings = { providers: [] as unknown[], roles: {} as Record<string, unknown> }
const findFFmpeg = vi.fn()
const generateSoundEffect = vi.fn()
const saveLocalMusicAsset = vi.fn()

vi.mock('electron', () => ({ app: { getPath: () => '/home/u/Music' } }))
vi.mock('../../../ai/store', () => ({
  readSettings: async () => settings,
  readSettingsSync: () => settings
}))
vi.mock('../../../services/ffmpegPath', () => ({ findFFmpeg: () => findFFmpeg() }))
vi.mock('../../../ai/soundEffect', () => ({
  generateSoundEffect: (...args: unknown[]) => generateSoundEffect(...args)
}))
vi.mock('../../../services/aigc/assetSaver', () => ({
  saveLocalMusicAsset: (...args: unknown[]) => saveLocalMusicAsset(...args)
}))

import { createGenerateSoundEffectTool } from './generateSoundEffect'

const provider = {
  id: 'elevenlabs-sfx',
  kind: 'sfx',
  models: [{ id: 'eleven_text_to_sound_v2' }]
}

async function run(args: Record<string, unknown>): Promise<{
  text: string
  details: Record<string, unknown>
}> {
  const result = (await createGenerateSoundEffectTool().execute('c1', args)) as unknown as {
    content: { type: string; text?: string }[]
    details: Record<string, unknown>
  }
  return { text: result.content.map((part) => part.text ?? '').join('\n'), details: result.details }
}

beforeEach(() => {
  vi.clearAllMocks()
  settings.providers = []
  settings.roles = {}
})

describe('generate_sound_effect', () => {
  it('hands off to local synthesis when nothing is bound', async () => {
    findFFmpeg.mockResolvedValue('C:/ffmpeg/bin/ffmpeg.exe')
    const { text, details } = await run({ prompt: 'click' })
    expect(details).toMatchObject({ mode: 'local', ffmpeg: 'C:/ffmpeg/bin/ffmpeg.exe' })
    expect(String(details.outputDir)).toContain('sfx')
    expect(text).toContain('sound-effects')
    expect(generateSoundEffect).not.toHaveBeenCalled()
  })

  it('names both ways out when FFmpeg is missing too', async () => {
    findFFmpeg.mockResolvedValue(null)
    const { text } = await run({ prompt: 'click' })
    expect(text).toContain('FFmpeg')
    expect(text).toContain('ElevenLabs')
  })

  it('generates each variant and keeps the file when the library save fails', async () => {
    settings.providers = [provider]
    settings.roles = { sfx: { providerId: provider.id, modelId: 'eleven_text_to_sound_v2' } }
    generateSoundEffect.mockImplementation(async (_p, _m, _r, variant: number) => ({
      path: `/tmp/v${variant}.wav`,
      seconds: 0.4,
      reused: false
    }))
    saveLocalMusicAsset
      .mockResolvedValueOnce({ filePath: '/vault/v0.wav', assetKey: 'k0' })
      .mockRejectedValueOnce(new Error('vault offline'))
    const { details } = await run({ prompt: 'footstep', variants: 2 })
    expect(generateSoundEffect).toHaveBeenCalledTimes(2)
    expect(saveLocalMusicAsset).toHaveBeenCalledWith('/tmp/v0.wav', 'footstep', 'sound')
    expect(details.tracks).toEqual([
      { path: '/vault/v0.wav', seconds: 0.4, assetKey: 'k0' },
      { path: '/tmp/v1.wav', seconds: 0.4, save_error: 'Error: vault offline' }
    ])
  })
})
