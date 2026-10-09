/** @vitest-environment node */
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(() => 'session-a'),
  generate: vi.fn(async () => ({
    path: 'music.mp3',
    tracks: [{ path: 'music.mp3' }, { path: 'music-2.mp3' }],
    reused: false
  })),
  save: vi.fn(async (source: string) => ({ filePath: `vault/${source}`, assetKey: source })),
  assertProject: vi.fn(async () => 'verified-video-project'),
  musicProvider: 'music',
  speechBinding: { provider: { id: 'voice' }, modelId: 'tts' } as unknown,
  speak: vi.fn(async (_b: unknown, _t: string, dir: string) => ({
    path: `${dir}/line.pcm`,
    seconds: 1.234
  })),
  toWav: vi.fn(async () => {})
}))
vi.mock('../../../services/taskVideo/audio', () => ({
  resolveSpeechBinding: async () => mocks.speechBinding,
  speakToFile: mocks.speak,
  pcmToWav: mocks.toWav
}))
vi.mock('../../core/projectTargetContext', () => ({ getCurrentSessionId: mocks.session }))
vi.mock('../../../services/aigc/assetSaver', () => ({ saveLocalMusicAsset: mocks.save }))
vi.mock('../../../ai/music', () => ({ generateTaskMusic: mocks.generate }))
vi.mock('../../../services/taskVideo/project', () => ({ assertVideoProject: mocks.assertProject }))
vi.mock('../../../services/taskVideo/render', () => {
  throw new Error('Music-only requests must never load the video renderer')
})
vi.mock('../../core/transcriptStore', () => {
  throw new Error('Music-only requests must never read chat history')
})
vi.mock('electron', async () => {
  const { resolve } = await import('node:path')
  return {
    app: {
      getPath: (name: string) => {
        if (name !== 'music') throw new Error('Music output only')
        return resolve('test-music')
      }
    }
  }
})
vi.mock('../../../ai/store', () => ({
  readSettingsSync: () => ({
    roles: { music: { providerId: mocks.musicProvider, modelId: 'auto' } },
    providers: []
  }),
  readSettings: async () => ({
    roles: { music: { providerId: 'music', modelId: 'auto' } },
    providers: [{ id: 'music', kind: 'music', models: [{ id: 'auto' }] }]
  })
}))
import { taskVideoTools } from './taskVideo'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockReturnValue('session-a')
})
const music = (): ReturnType<typeof taskVideoTools>[number] =>
  taskVideoTools().find((tool) => tool.name === 'generate_task_music')!
describe('independent music generation', () => {
  it('generates directly without video preparation and reuses the same session output folder', async () => {
    const tool = music()
    const result = await tool.execute('one', { prompt: 'lofi piano', seconds: 180 })
    expect(result.details).toMatchObject({
      path: 'vault/music.mp3',
      tracks: [{ path: 'vault/music.mp3' }, { path: 'vault/music-2.mp3' }]
    })
    expect(mocks.save).toHaveBeenCalledTimes(2)
    const first = mocks.generate.mock.calls[0] as unknown as unknown[]
    expect(String(first[4])).toMatch(new RegExp(`UnrealBox[\\\\/]`))
    expect(String(first[4]).startsWith(path.resolve('test-music'))).toBe(true)
    await tool.execute('two', { prompt: 'lofi piano', seconds: 180 })
    expect((mocks.generate.mock.calls[1] as unknown as unknown[])[4]).toBe(first[4])
    mocks.session.mockReturnValue('session-b')
    await tool.execute('three', { prompt: 'lofi piano', seconds: 180 })
    expect((mocks.generate.mock.calls[2] as unknown as unknown[])[4]).not.toBe(first[4])
    expect(mocks.assertProject).not.toHaveBeenCalled()
  })
  it('外部 MCP 调用没有盒子会话也能生成，同样的请求复用同一个回执目录', async () => {
    // Claude Code / Cursor 接进来的模型没有盒子会话，以前直接抛「当前没有会话」
    mocks.session.mockReturnValue(undefined as unknown as string)
    const tool = music()
    await tool.execute('mcp-1', { prompt: 'police chase', seconds: 30 })
    const first = (mocks.generate.mock.calls[0] as unknown as unknown[])[4]
    expect(String(first).startsWith(path.resolve('test-music'))).toBe(true)
    await tool.execute('mcp-2', { prompt: 'police chase', seconds: 30 })
    expect((mocks.generate.mock.calls[1] as unknown as unknown[])[4]).toBe(first)
    await tool.execute('mcp-3', { prompt: 'police chase', seconds: 45 })
    expect((mocks.generate.mock.calls[2] as unknown as unknown[])[4]).not.toBe(first)
    // 给视频工程配乐仍然要求会话
    await expect(
      tool.execute('mcp-4', { projectDir: 'video-project', prompt: 'calm', seconds: 30 })
    ).rejects.toThrow('当前没有对话')
  })
  it('keeps generated audio available if vault import fails', async () => {
    mocks.save.mockRejectedValueOnce(new Error('vault unavailable'))
    const result = await music().execute('recover', { prompt: 'calm', seconds: 30 })
    expect(result.details).toMatchObject({
      path: 'music.mp3',
      tracks: [
        { path: 'music.mp3', save_error: 'Error: vault unavailable' },
        { path: 'vault/music-2.mp3' }
      ]
    })
  })
  it('still validates ownership when adding music to an existing video project', async () => {
    await music().execute('video-music', {
      projectDir: 'video-project',
      prompt: 'calm',
      seconds: 30
    })
    expect(mocks.assertProject).toHaveBeenCalledWith('video-project', 'session-a')
    expect((mocks.generate.mock.calls[0] as unknown as unknown[])[4]).toBe('verified-video-project')
  })
  it('绑的是 Box Plan 时，说明写明已提交的音乐取消后不退额度', () => {
    expect(music().description).not.toContain('已提交的音乐取消后不退额度')
    mocks.musicProvider = 'creator-plan-music'
    try {
      expect(music().description).toContain('已提交的音乐取消后不退额度')
    } finally {
      mocks.musicProvider = 'music'
    }
  })
})

describe('independent speech', () => {
  const speech = (): ReturnType<typeof taskVideoTools>[number] =>
    taskVideoTools().find((tool) => tool.name === 'generate_speech')!
  it('外部 MCP 没有盒子会话也能合成，交付 WAV', async () => {
    mocks.session.mockReturnValue(undefined as unknown as string)
    const result = await speech().execute('s1', { text: '呼叫指挥部，收到请回答' })
    const dir = path.join(path.resolve('test-music'), 'UnrealBox', 'speech')
    expect(mocks.speak.mock.calls[0][2]).toBe(dir)
    expect(mocks.toWav).toHaveBeenCalledWith(`${dir}/line.pcm`, `${dir}/line.wav`)
    expect(result.details).toEqual({ path: `${dir}/line.wav`, seconds: 1.23 })
  })
  it('没绑语音合成时说清去哪里配', async () => {
    mocks.speechBinding = undefined
    await expect(speech().execute('s2', { text: '你好' })).rejects.toThrow('语音合成')
    mocks.speechBinding = { provider: { id: 'voice' }, modelId: 'tts' }
  })
})
