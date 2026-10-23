/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ali = {
  id: 'alibaba-tts',
  kind: 'tts',
  baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  apiKey: { kind: 'none' },
  models: [{ id: 'qwen-audio-3.0-tts-plus' }]
}
const doubao = {
  id: 'doubao-tts',
  kind: 'tts',
  baseUrl: 'https://openspeech.bytedance.com/x',
  apiKey: { kind: 'none' },
  models: [{ id: 'seed-tts-2.0' }]
}
const mocks = vi.hoisted(() => ({
  project: '' as string | undefined,
  binding: undefined as unknown,
  create: vi.fn(),
  query: vi.fn(async () => 'OK'),
  remove: vi.fn(async () => {}),
  speak: vi.fn(async (_b: unknown, _t: string, dir: string) => ({
    path: `${dir}/line.pcm`,
    seconds: 1
  }))
}))
vi.mock('../../core/projectTargetContext', () => ({
  getCurrentSessionId: () => 'session',
  getSessionProjectPath: () => mocks.project,
  getTargetProjectPath: () => undefined
}))
vi.mock('../../../ai/store', () => ({
  readSettingsSync: () => ({ roles: {}, providers: [] }),
  readSettings: async () => ({ roles: {}, providers: [ali, doubao] })
}))
vi.mock('../../../ai/credentials', () => ({ resolveApiKey: async () => 'key' }))
vi.mock('../../../ai/speechVoiceDesign', async (original) => ({
  ...(await original<typeof import('../../../ai/speechVoiceDesign')>()),
  createDesignedVoice: mocks.create,
  queryDesignedVoice: mocks.query,
  deleteDesignedVoice: mocks.remove
}))
vi.mock('../../../services/taskVideo/audio', () => ({
  resolveSpeechBinding: async () => mocks.binding,
  speakToFile: mocks.speak,
  pcmToWav: async () => {}
}))
vi.mock('electron', () => ({ app: { getPath: () => path.resolve('test-music') } }))
import { taskVideoTools } from './taskVideo'

const tool = (name: string): ReturnType<typeof taskVideoTools>[number] =>
  taskVideoTools().find((item) => item.name === name)!
const castFile = (): string => path.join(mocks.project!, '.uebox', 'voices.json')
const readCast = async (): Promise<Record<string, Record<string, { voiceId: string }>>> =>
  JSON.parse(await fs.readFile(castFile(), 'utf8')).roles

const design = (role = '老铁匠'): Promise<unknown> =>
  tool('design_voice').execute('d', {
    role,
    description: '五十岁男性铁匠，嗓音低沉沙哑',
    line: '离我的炉子远点，小子，烫着了可别哭。'
  })

let root = ''
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'voice-cast-'))
  mocks.project = root
  mocks.binding = { provider: ali, modelId: 'qwen-audio-3.0-tts-plus' }
  let n = 0
  mocks.create.mockImplementation(async () => ({
    voiceId: `voice-0000000${++n}`,
    preview: Buffer.from('RIFF')
  }))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  vi.clearAllMocks()
  mocks.query.mockResolvedValue('OK')
})

describe('角色音色：设计 → 试听 → 采用', () => {
  it('设计出的音色先进试听，试听 WAV 写进工程，配音拿不到它', async () => {
    const designed = (await design()) as { details: { path: string; title: string } }
    expect(designed.details.title).toBe('老铁匠 · 试听')
    const role = (await readCast())['老铁匠']
    expect(role.adopted).toBeUndefined()
    expect(role.candidate.voiceId).toBe('voice-00000001')
    const preview = (role.candidate as unknown as { preview: string }).preview
    expect(preview.startsWith(path.join(mocks.project!, '.uebox', 'voices'))).toBe(true)
    expect(await fs.readFile(preview, 'utf8')).toBe('RIFF')
    expect(designed.details.path).toBe(preview)
    await expect(
      tool('generate_speech').execute('s', { text: '你好', role: '老铁匠' })
    ).rejects.toThrow('还在试听')
  })

  it('采用这一步每次都要用户确认，「本对话内都允许」盖不住', () => {
    expect(tool('adopt_voice').unrealBox.requiresExplicitApproval).toBe(true)
    expect(tool('design_voice').unrealBox.requiresExplicitApproval).toBeUndefined()
  })

  it('重新设计替换上一个试听，并删掉阿里云上没用的那个', async () => {
    await design()
    await design()
    expect((await readCast())['老铁匠'].candidate.voiceId).toBe('voice-00000002')
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(
      ali,
      'key',
      'voice-00000001',
      expect.anything()
    )
  })

  it('采用后配音用这个音色和它绑定的模型；换音色时删旧的', async () => {
    await design()
    await tool('adopt_voice').execute('a', { role: '老铁匠' })
    await design()
    await tool('adopt_voice').execute('a', { role: '老铁匠' })
    expect(await readCast()).toEqual({
      老铁匠: { adopted: expect.objectContaining({ voiceId: 'voice-00000002' }) }
    })
    expect(mocks.remove).toHaveBeenCalledWith(ali, 'key', 'voice-00000001', expect.anything())

    mocks.binding = { provider: doubao, modelId: 'seed-tts-2.0' }
    const result = await tool('generate_speech').execute('s', {
      text: '站住！',
      role: '老铁匠',
      style: '愤怒地吼出来'
    })
    const [binding, , , , , options] = mocks.speak.mock.calls[0] as unknown as [
      { provider: { id: string }; modelId: string },
      ...unknown[]
    ]
    expect(binding.provider.id).toBe('alibaba-tts')
    expect(binding.modelId).toBe('qwen-audio-3.0-tts-plus')
    expect(options).toEqual({ voice: 'voice-00000002', instruction: '愤怒地吼出来' })
    expect(result.details).toMatchObject({ role: '老铁匠', style_applied: true })
  })

  it('阿里云审核没过：不入表、删掉，并如实报错', async () => {
    await design()
    mocks.query.mockResolvedValue('UNDEPLOYED')
    await expect(tool('adopt_voice').execute('a', { role: '老铁匠' })).rejects.toThrow('审核')
    expect(await readCast()).toEqual({ 老铁匠: {} })
    expect(mocks.remove).toHaveBeenCalledOnce()
  })

  it('没绑阿里云时说清楚只支持哪家', async () => {
    mocks.binding = { provider: doubao, modelId: 'seed-tts-2.0' }
    await expect(design()).rejects.toThrow('Qwen-Audio 3.0')
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('不认演法的模型照常合成，但回执写明没生效', async () => {
    mocks.binding = { provider: doubao, modelId: 'seed-tts-2.0' }
    const result = await tool('generate_speech').execute('s', { text: '你好', style: '温柔地' })
    expect((mocks.speak.mock.calls[0] as unknown[])[5]).toEqual({
      voice: undefined,
      instruction: undefined
    })
    expect(result.details).toMatchObject({ style_applied: false })
  })

  it('未知角色报出已有角色；没有工程时说清楚原因', async () => {
    await design('旁白')
    await tool('adopt_voice').execute('a', { role: '旁白' })
    await expect(
      tool('generate_speech').execute('s', { text: '你好', role: '村长' })
    ).rejects.toThrow('已有：旁白')
    mocks.project = undefined
    await expect(tool('list_voices').execute('l', {})).rejects.toThrow('归属工程')
  })
})
