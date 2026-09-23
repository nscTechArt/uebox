import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, KeepAlive, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { useReadAloud, useSpeechPlayback } from './useReadAloud'
import { SpeechPcmPlayer } from './speechPcmPlayer'
import { speechAPI } from '@renderer/api/speech'
import { message } from '@renderer/utils/messageManager'
import { aiProviderAPI } from '@renderer/api/aiProvider'
import { speechCache } from './speechCache'
import { briefForSpeech } from './speechBriefing'
import { useAIConfigStore } from '@renderer/store/modules/aiConfig'

vi.mock('@renderer/api/aiProvider', () => ({ aiProviderAPI: { getSettings: vi.fn() } }))

vi.mock('@renderer/api/speech', () => ({
  speechAPI: { synthesize: vi.fn(), cancel: vi.fn(async () => {}) }
}))
vi.mock('@renderer/utils/messageManager', () => ({
  message: { error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
vi.mock('./speechPcmPlayer', () => ({ SpeechPcmPlayer: vi.fn() }))
// 默认原样放行：压不压是 speechBriefing 自己的单测管的事
vi.mock('./speechBriefing', () => ({ briefForSpeech: vi.fn(async (text: string) => text) }))
const frame = { base64: 'AAAAAA==', format: 'pcm_s16le' as const, sampleRate: 24000 as const }
const players: {
  enqueue: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  end: () => void
}[] = []
const wrappers: ReturnType<typeof mount>[] = []
function reader(messageId?: string): {
  reading: ReturnType<typeof useReadAloud>
  wrapper: ReturnType<typeof mount>
} {
  let reading!: ReturnType<typeof useReadAloud>
  const wrapper = mount(
    defineComponent({
      setup() {
        reading = useReadAloud(messageId ? () => messageId : undefined)
        return () => null
      }
    })
  )
  wrappers.push(wrapper)
  return { reading, wrapper }
}
beforeEach(() => {
  speechCache.clear()
  vi.mocked(aiProviderAPI.getSettings).mockResolvedValue({
    roles: { tts: { providerId: 'doubao', modelId: 'seed-tts-2.0' } },
    providers: []
  } as unknown as Awaited<ReturnType<typeof aiProviderAPI.getSettings>>)
  players.length = 0
  vi.mocked(SpeechPcmPlayer).mockImplementation(function () {
    let end!: () => void
    const drained = new Promise<void>((resolve) => {
      end = resolve
    })
    const player = {
      ready: Promise.resolve(),
      enqueue: vi.fn(() => true),
      waitForRoom: vi.fn(async () => {}),
      drain: () => drained,
      stop: vi.fn(() => end()),
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      end
    }
    players.push(player)
    return player as unknown as SpeechPcmPlayer
  })
  vi.mocked(speechAPI.synthesize).mockImplementation(async (_request, onAudio) => {
    onAudio(frame)
  })
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.clearAllMocks()
})

describe('念之前先压一遍', () => {
  it('按当前播报风格压，合成的是口播稿；压的期间按钮显示「正在合成」', async () => {
    useAIConfigStore().setVoiceBriefingStyle('concise')
    let release!: () => void
    vi.mocked(briefForSpeech).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('压过的稿子')
        })
    )
    const { reading } = reader('m1')
    const run = reading.toggle('很长的原文')
    await flushPromises()
    expect(briefForSpeech).toHaveBeenCalledWith(
      '很长的原文',
      'concise',
      expect.objectContaining({ plainText: '很长的原文' })
    )
    expect(reading.loading.value).toBe(true)
    expect(speechAPI.synthesize).not.toHaveBeenCalled()
    release()
    await flushPromises()
    expect(speechAPI.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ text: '压过的稿子' }),
      expect.any(Function)
    )
    players[0].end()
    await run
  })

  it('压的期间点了停止，稿子回来也不合成', async () => {
    useAIConfigStore().setVoiceBriefingStyle('detailed')
    let release!: () => void
    vi.mocked(briefForSpeech).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('稿子')
        })
    )
    const { reading } = reader('m2')
    const run = reading.toggle('很长的原文')
    await flushPromises()
    reading.stop()
    release()
    await run
    expect(speechAPI.synthesize).not.toHaveBeenCalled()
    expect(reading.active.value).toBe(false)
  })

  /** 压缩没成多半是轻量模型没绑，提示一次让用户去设置里改；只回空稿不算，那不是配置问题 */
  it('压缩出错只提示一次，回空稿不提示', async () => {
    useAIConfigStore().setVoiceBriefingStyle('concise')
    vi.mocked(briefForSpeech).mockImplementation(async (text, _style, options) => {
      options?.onFallback?.(text.startsWith('出错') ? 'error' : 'empty')
      return text
    })
    const { reading } = reader('m3')
    // 三段正文各不相同，否则第三次会命中语音缓存、根本不再合成
    for (const text of ['空稿', '出错一次', '出错两次']) {
      const run = reading.toggle(text)
      await flushPromises()
      players.at(-1)!.end()
      await run
    }
    expect(message.warning).toHaveBeenCalledTimes(1)
    expect(speechAPI.synthesize).toHaveBeenCalledTimes(3)
  })
})

describe('回复流式朗读', () => {
  it('global controls pause, resume and stop playback after leaving the reply', async () => {
    const { reading, wrapper } = reader()
    const controls = useSpeechPlayback()
    const run = reading.toggle('后台朗读')
    await flushPromises()
    wrapper.unmount()
    expect(controls.active.value).toBe(true)
    await controls.togglePause()
    expect(players[0].pause).toHaveBeenCalledTimes(1)
    expect(controls.paused.value).toBe(true)
    expect(players[0].stop).not.toHaveBeenCalled()
    await controls.togglePause()
    expect(players[0].resume).toHaveBeenCalledTimes(1)
    expect(controls.paused.value).toBe(false)
    expect(speechAPI.synthesize).toHaveBeenCalledTimes(1)
    controls.stop()
    await run
    expect(controls.active.value).toBe(false)
  })

  it('a failed pause leaves playback usable and clears the busy state', async () => {
    const { reading } = reader()
    const controls = useSpeechPlayback()
    const run = reading.toggle('正文')
    await flushPromises()
    players[0].pause.mockRejectedValueOnce(new Error('suspend failed'))
    await expect(controls.togglePause()).rejects.toThrow('suspend failed')
    expect(controls.paused.value).toBe(false)
    expect(controls.changing.value).toBe(false)
    controls.stop()
    await run
  })

  it('replays completed audio without synthesis, including after remounting the reply', async () => {
    const first = reader()
    const run = first.reading.toggle('缓存正文')
    await flushPromises()
    players[0].end()
    await run
    first.wrapper.unmount()
    const second = reader()
    const replay = second.reading.toggle('缓存正文')
    await flushPromises()
    expect(speechAPI.synthesize).toHaveBeenCalledTimes(1)
    expect(players[1].enqueue).toHaveBeenCalledWith(frame)
    players[1].end()
    await replay
    expect(second.reading.active.value).toBe(false)
  })

  it('does not cache a fully synthesized reply when playback was interrupted', async () => {
    const { reading } = reader()
    const run = reading.toggle('中断正文')
    await flushPromises()
    reading.stop()
    await run
    const replay = reading.toggle('中断正文')
    await flushPromises()
    expect(speechAPI.synthesize).toHaveBeenCalledTimes(2)
    reading.stop()
    await replay
  })

  it('caches every segment in order and keeps the cache when a replay is stopped', async () => {
    const secondFrame = { ...frame, base64: 'AQABAA==' }
    vi.mocked(speechAPI.synthesize)
      .mockImplementationOnce(async (_request, onAudio) => {
        onAudio(frame)
      })
      .mockImplementationOnce(async (_request, onAudio) => {
        onAudio(secondFrame)
      })
    const { reading } = reader()
    const text = '长'.repeat(601)
    const run = reading.toggle(text)
    await flushPromises()
    players[0].end()
    await run
    const replay = reading.toggle(text)
    await flushPromises()
    expect(players[1].enqueue.mock.calls).toEqual([[frame], [secondFrame]])
    reading.stop()
    await replay
    const again = reading.toggle(text)
    await flushPromises()
    expect(speechAPI.synthesize).toHaveBeenCalledTimes(2)
    expect(players[2].enqueue.mock.calls).toEqual([[frame], [secondFrame]])
    reading.stop()
    await again
  })

  it('does not cache partial audio after synthesis fails', async () => {
    vi.mocked(speechAPI.synthesize).mockImplementationOnce(async (_request, onAudio) => {
      onAudio(frame)
      throw new Error('TTS_FAILED')
    })
    const { reading } = reader()
    await reading.toggle('失败正文')
    const retry = reading.toggle('失败正文')
    await flushPromises()
    expect(speechAPI.synthesize).toHaveBeenCalledTimes(2)
    reading.stop()
    await retry
  })

  it('synthesizes again when the text or voice changes', async () => {
    const { reading } = reader()
    const run = reading.toggle('原正文')
    await flushPromises()
    players[0].end()
    await run
    const changed = reading.toggle('新正文')
    await flushPromises()
    players[1].end()
    await changed
    const settings = await aiProviderAPI.getSettings()
    vi.mocked(aiProviderAPI.getSettings).mockResolvedValue({
      ...settings,
      providers: [{ id: 'doubao', models: [{ id: 'seed-tts-2.0', ttsVoice: 'new-voice' }] }]
    } as Awaited<ReturnType<typeof aiProviderAPI.getSettings>>)
    const voice = reading.toggle('原正文')
    await flushPromises()
    expect(speechAPI.synthesize).toHaveBeenCalledTimes(3)
    reading.stop()
    await voice
  })

  it('cleans Markdown and starts playback before synthesis completes', async () => {
    let finish!: () => void
    vi.mocked(speechAPI.synthesize).mockImplementationOnce(async (_request, onAudio) => {
      onAudio(frame)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    const { reading } = reader()
    const run = reading.toggle('# 标题\n\n**正文**')
    await flushPromises()
    expect(speechAPI.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ text: '标题\n正文' }),
      expect.any(Function)
    )
    expect(players[0].enqueue).toHaveBeenCalledWith(frame)
    expect(reading.loading.value).toBe(false)
    expect(reading.active.value).toBe(true)
    finish()
    await flushPromises()
    expect(reading.active.value).toBe(true)
    players[0].end()
    await run
    expect(reading.active.value).toBe(false)
  })
  it('cancels pending synthesis and ignores late audio frames', async () => {
    let finish!: () => void
    let deliver!: () => void
    vi.mocked(speechAPI.synthesize).mockImplementationOnce(async (_request, onAudio) => {
      deliver = () => onAudio(frame)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    const { reading } = reader()
    const run = reading.toggle('正文')
    await flushPromises()
    await reading.toggle('正文')
    expect(speechAPI.cancel).toHaveBeenCalled()
    deliver()
    finish()
    await run
    expect(players[0].enqueue).not.toHaveBeenCalled()
    expect(players[0].stop).toHaveBeenCalled()
  })
  it('stops the previous reply but continues after unmount until playback finishes', async () => {
    const first = reader()
    const second = reader()
    const run1 = first.reading.toggle('第一条')
    await flushPromises()
    const run2 = second.reading.toggle('第二条')
    await flushPromises()
    expect(players[0].stop).toHaveBeenCalled()
    expect(first.reading.active.value).toBe(false)
    second.wrapper.unmount()
    expect(players[1].stop).not.toHaveBeenCalled()
    expect(second.reading.active.value).toBe(true)
    players[1].end()
    await Promise.all([run1, run2])
    expect(players[1].stop).toHaveBeenCalled()
  })
  it('continues across cached tab switches and retains the stop button state', async () => {
    const visible = ref(true)
    let reading!: ReturnType<typeof useReadAloud>
    const page = defineComponent({
      setup() {
        reading = useReadAloud(() => 'cached-reply')
        return () => h('div')
      }
    })
    const wrapper = mount(
      defineComponent({
        setup: () => () => h(KeepAlive, null, { default: () => (visible.value ? h(page) : null) })
      })
    )
    wrappers.push(wrapper)
    const run = reading.toggle('切换页面后继续朗读')
    await flushPromises()
    visible.value = false
    await flushPromises()
    expect(players[0].stop).not.toHaveBeenCalled()
    visible.value = true
    await flushPromises()
    expect(reading.active.value).toBe(true)
    await reading.toggle('切换页面后继续朗读')
    await run
    expect(players[0].stop).toHaveBeenCalled()
  })

  it('continues pending synthesis after unmount and lets the remounted reply cancel it', async () => {
    let finish!: () => void
    let deliver!: () => void
    vi.mocked(speechAPI.synthesize).mockImplementationOnce(async (_request, onAudio) => {
      deliver = () => onAudio(frame)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    const first = reader('same-reply')
    const run = first.reading.toggle('仍在生成语音')
    await flushPromises()
    first.wrapper.unmount()
    expect(speechAPI.cancel).not.toHaveBeenCalled()
    deliver()
    expect(players[0].enqueue).toHaveBeenCalledWith(frame)
    const second = reader('same-reply')
    expect(second.reading.active.value).toBe(true)
    await second.reading.toggle('仍在生成语音')
    expect(speechAPI.cancel).toHaveBeenCalledTimes(1)
    deliver()
    expect(players[0].enqueue).toHaveBeenCalledTimes(1)
    finish()
    await run
    expect(second.reading.active.value).toBe(false)
  })
  it('reports errors and handles content with no readable text', async () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { reading } = reader()
    await reading.toggle('---')
    expect(speechAPI.synthesize).not.toHaveBeenCalled()
    const failure = new Error('TTS_NOT_CONFIGURED')
    vi.mocked(speechAPI.synthesize).mockRejectedValueOnce(failure)
    await reading.toggle('正文')
    expect(logError).toHaveBeenCalledWith('[ReadAloud] Playback failed', failure)
    expect(message.error).toHaveBeenCalledWith(expect.stringContaining('语音合成'))
    expect(reading.active.value).toBe(false)
    logError.mockRestore()
  })
  it('套餐额度用完时用对话里同一套文案', async () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { reading } = reader()
    vi.mocked(speechAPI.synthesize).mockRejectedValueOnce(new Error('TTS_PLAN_QUOTA_EXHAUSTED'))
    await reading.toggle('正文')
    expect(message.error).toHaveBeenCalledWith(expect.stringContaining('这项额度本周期用完了'))
    expect(reading.active.value).toBe(false)
    logError.mockRestore()
  })
  it('prefetches the next segment while queued audio is playing', async () => {
    const { reading } = reader()
    const run = reading.toggle('字'.repeat(601))
    await flushPromises()
    expect(speechAPI.synthesize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: '字' }),
      expect.any(Function)
    )
    reading.stop()
    await run
    expect(reading.active.value).toBe(false)
  })
})
