import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { aiProviderAPI } from '@renderer/api/aiProvider'
import { speechAPI } from '@renderer/api/speech'
import { useAutoReadAloud } from './autoReadAloud'
import { SpeechPcmPlayer } from './speechPcmPlayer'
import { speechCache } from './speechCache'
import { useReadAloud } from './useReadAloud'
import { setVoiceCallActive } from './voiceCallState'

/**
 * 自动朗读认的是**哪条**回复。
 *
 * 这个文件不 mock `useReadAloud` —— 坑恰恰在两者的接缝上：自动朗读把当前这条
 * 回复的号交给它，它裹进 computed。号要是不响应式，computed 算一次就再也不变，
 * 于是第二条开念时「停止」按钮还挂在第一条的气泡上。
 */

vi.mock('@renderer/api/aiProvider', () => ({ aiProviderAPI: { getSettings: vi.fn() } }))
vi.mock('@renderer/api/speech', () => ({
  speechAPI: { synthesize: vi.fn(), cancel: vi.fn(async () => {}) }
}))
vi.mock('@renderer/utils/messageManager', () => ({ message: { error: vi.fn(), info: vi.fn() } }))
vi.mock('./speechPcmPlayer', () => ({ SpeechPcmPlayer: vi.fn() }))

const frame = { base64: 'AAAAAA==', format: 'pcm_s16le' as const, sampleRate: 24000 as const }
const players: { end: () => void }[] = []

/** 气泡上的那个朗读按钮：跟自动朗读用同一个号，才能显示成「停止」 */
function bubble(messageId: string): ReturnType<typeof useReadAloud> {
  let reading!: ReturnType<typeof useReadAloud>
  mount(
    defineComponent({
      setup() {
        reading = useReadAloud(() => messageId)
        return () => null
      }
    })
  )
  return reading
}

/** 跑完一整轮：推一条 typing 的回复，落定，等自动朗读接上 */
async function turn(chatSid: string, text: string): Promise<string> {
  const chatMsgStore = useChatMessagesStore()
  const id = chatMsgStore.pushAssistantTyping(chatSid)
  await nextTick()
  chatMsgStore.replaceTyping(chatSid, id, text, true)
  await flushPromises()
  return id
}

beforeEach(() => {
  setActivePinia(createPinia())
  setVoiceCallActive(false)
  speechCache.clear()
  players.length = 0
  vi.clearAllMocks()
  vi.mocked(aiProviderAPI.getSettings).mockResolvedValue({
    roles: { tts: { providerId: 'doubao', modelId: 'seed-tts-2.0' } },
    providers: []
  } as unknown as Awaited<ReturnType<typeof aiProviderAPI.getSettings>>)
  vi.mocked(SpeechPcmPlayer).mockImplementation(function () {
    let end!: () => void
    const drained = new Promise<void>((resolve) => {
      end = resolve
    })
    players.push({ end })
    return {
      ready: Promise.resolve(),
      enqueue: vi.fn(() => true),
      waitForRoom: vi.fn(async () => {}),
      drain: () => drained,
      stop: vi.fn(() => end()),
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {})
    } as unknown as SpeechPcmPlayer
  })
  vi.mocked(speechAPI.synthesize).mockImplementation(async (_request, onAudio) => {
    onAudio(frame)
  })
})

describe('自动朗读认的是哪条回复', () => {
  it('第二条开念时，「停止」跟着挪到第二条上', async () => {
    useAIConfigStore().setVoiceAutoPlayEnabled(true)
    mount(
      defineComponent({
        setup() {
          useAutoReadAloud()
          return () => h('div')
        }
      })
    )

    const first = await turn('chat-1', '第一条结论。')
    expect(bubble(first).active.value).toBe(true)
    // 第一条念完：队列放空，朗读收场
    players[0].end()
    await flushPromises()
    expect(bubble(first).active.value).toBe(false)

    const second = await turn('chat-1', '第二条结论。')
    expect(bubble(second).active.value).toBe(true)
    expect(bubble(first).active.value).toBe(false)
  })
})
