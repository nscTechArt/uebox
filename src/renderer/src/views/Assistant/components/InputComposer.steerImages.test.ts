import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { RealtimeVoiceState } from '../composables/useRealtimeVoice'
import type { SettingsView } from '@core/shared/aiProvider'

/**
 * 插话带图。
 *
 * 在这之前插话只送一句话：用户贴了参考图、打了「照着这张改」，图会被留在输入框里
 * 一声不响地落下 —— 而他以为图跟着话一起进去了。这一组守住「图跟着走」和
 * 「跟着走的那几张才从输入框摘掉」。
 *
 * **不换模型**是这条路的前提，理由在 `agent-v3:steer` 的注释里：这一轮用哪个模型
 * 跑起来那一刻就定了，中途换等于把整段 prompt cache 作废。当前模型看不了图时，
 * 模型会照实说自己看不到。
 */

const mocks = vi.hoisted(() => ({ settings: vi.fn(), push: vi.fn(), info: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/api/aiProvider', () => ({ aiProviderAPI: { getSettings: mocks.settings } }))
vi.mock('@/api/agentV3', () => ({
  agentV3API: { thinkingLevels: async () => null, listSkills: async () => ({ skills: [] }) }
}))
vi.mock('@/utils/messageManager', () => ({ message: { info: mocks.info } }))
vi.mock('../composables/voiceAssistant', () => ({ startVoiceIn: vi.fn() }))

import InputComposer from './InputComposer.vue'
import { useAIConfigStore } from '@/store/modules/aiConfig'
import { useChatSessionsStore, type ChatImageDraft } from '@/store/modules/chatSessions'

const CHAT_SID = 'chat-steer-images'

const ready: SettingsView = {
  providers: [
    {
      id: 'local',
      displayName: 'Local',
      kind: 'chat',
      protocol: 'openai-completions',
      baseUrl: 'http://localhost/v1',
      apiKey: { kind: 'none' },
      models: [{ id: 'test' }]
    }
  ],
  roles: { agent: { providerId: 'local', modelId: 'test' } },
  configured: true,
  encryptionAvailable: true,
  path: ''
}

/** 一张「传完了」的图。`url` 就是发出去的那份 data URL */
function uploaded(id: string): ChatImageDraft {
  return {
    id,
    file: new File(['x'], `${id}.png`, { type: 'image/png' }),
    preview: `data:image/png;base64,${id}`,
    url: `data:image/png;base64,${id}`,
    uploading: false
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings.mockResolvedValue(ready)
  setActivePinia(createPinia())
})

/** 跑着的 Agent 会话 + 默认插话档，右下角那颗按钮点下去就是插话 */
async function steeringComposer(images: ChatImageDraft[]): Promise<VueWrapper> {
  useAIConfigStore().setFollowUpBehavior('steer')
  useChatSessionsStore().trySetImageDraft(CHAT_SID, images)

  const wrapper = shallowMount(InputComposer, {
    attachTo: document.body,
    props: {
      chatSid: CHAT_SID,
      isAgentMode: true,
      isGenerating: true,
      voice: {
        active: ref(false),
        connecting: ref(false),
        phase: ref('idle'),
        outputLevel: ref(0)
      } as RealtimeVoiceState
    },
    global: {
      stubs: {
        'a-textarea': {
          props: ['value'],
          emits: ['update:value'],
          template:
            '<textarea :value="value" @input="$emit(\'update:value\', $event.target.value)" />'
        },
        AppButton: { template: '<button><slot /></button>' },
        AppTooltip: { template: '<span><slot /></span>' }
      }
    }
  })
  await flushPromises()
  return wrapper
}

describe('插话带图', () => {
  it('贴进来的图跟着这句话一起插进去，并从输入框里摘掉', async () => {
    const wrapper = await steeringComposer([uploaded('a'), uploaded('b')])
    await wrapper.get('textarea').setValue('照着这两张改')
    await wrapper.get('.send-btn').trigger('click')

    expect(wrapper.emitted('steer')?.[0]?.[0]).toMatchObject({
      text: '照着这两张改',
      images: ['data:image/png;base64,a', 'data:image/png;base64,b']
    })
    // 发出去的那两张不能还留在输入框里 —— 那会让用户以为它们还没走
    expect(useChatSessionsStore().getImageDraft(CHAT_SID)).toEqual([])
    wrapper.unmount()
  })

  it('只带附件一个字没打也能插话', async () => {
    const wrapper = await steeringComposer([uploaded('a')])
    await wrapper.get('.send-btn').trigger('click')

    const payload = wrapper.emitted('steer')?.[0]?.[0] as { text: string; images: string[] }
    expect(payload.images).toEqual(['data:image/png;base64,a'])
    // 那句「补充附件：…」由 steerAgent 补，输入框只交出用户打的字
    expect(payload.text).toBe('')
    expect(useChatSessionsStore().getImageDraft(CHAT_SID)).toEqual([])
    wrapper.unmount()
  })

  it('还在传的那张留在原地 —— 它没跟着这句话走', async () => {
    const uploading: ChatImageDraft = {
      id: 'slow',
      file: new File(['x'], 'slow.png', { type: 'image/png' }),
      preview: 'blob:slow',
      uploading: true
    }
    const wrapper = await steeringComposer([uploaded('a'), uploading])
    await wrapper.get('textarea').setValue('先按这张来')
    // 有图在传时右下角是停止按钮（isSendDisabled），插话走键盘这条路
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('steer')?.[0]?.[0]).toMatchObject({
      text: '先按这张来',
      images: ['data:image/png;base64,a']
    })
    expect(
      useChatSessionsStore()
        .getImageDraft(CHAT_SID)
        .map((img) => img.id)
    ).toEqual(['slow'])
    wrapper.unmount()
  })
})

/**
 * 插话把就绪的附件摘走时，还在解析的那份接着解析。解析完按文件认回自己那一格，
 * 不能按拖进来时记下的下标写 —— 下标早就被插话挪了：原来会写到别人的格子上，
 * 留下一张永远转圈的僵尸卡片（发送键随之一直灰着），或者写出一个空洞把整个输入框渲染炸掉。
 */
describe('插话摘走附件时还在解析的那份', () => {
  it('解析完回到自己那一格，不留僵尸卡片', async () => {
    let finishSlow: (value: { success: boolean; text: string }) => void = () => {}
    const ingest = vi.fn(async (filePath: string) => {
      if (filePath.endsWith('slow.pdf')) {
        return new Promise<{ success: boolean; text: string }>((resolve) => {
          finishSlow = resolve
        })
      }
      return { success: true, text: `内容：${filePath}` }
    })
    const api = (window as unknown as { api?: Record<string, unknown> }).api
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...api,
      getPathForFile: (file: File) => `C:/drop/${file.name}`,
      attachment: { ingest, onProgress: () => () => {} }
    }
    try {
      const wrapper = await steeringComposer([])
      const drop = wrapper.get('.input-composer').trigger('drop', {
        dataTransfer: {
          files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt'), new File(['s'], 'slow.pdf')]
        }
      })
      await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(3))

      await flushPromises()
      await wrapper.get('textarea').setValue('看看这两份')
      await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
      expect(wrapper.emitted('steer')).toHaveLength(1)

      finishSlow({ success: true, text: '慢的那份' })
      await drop
      await flushPromises()

      const cards = wrapper.findAllComponents({ name: 'AttachmentCard' })
      expect(cards.map((card) => card.props('fileName'))).toEqual(['slow.pdf'])
      expect(cards[0].props('busy')).toBeFalsy()
      wrapper.unmount()
    } finally {
      ;(window as unknown as { api?: Record<string, unknown> }).api = api
    }
  })
})

/** 插话没成（这一轮刚好收尾、工程对不上）时，摘走的字和附件得放回输入框 —— 不然就这么没了 */
describe('插话没成时放回来', () => {
  it('调 restore 把字和图放回原处', async () => {
    const wrapper = await steeringComposer([uploaded('a')])
    await wrapper.get('textarea').setValue('照着这张改')
    await wrapper.get('.send-btn').trigger('click')

    const payload = wrapper.emitted('steer')?.[0]?.[0] as { restore: () => void }
    expect(useChatSessionsStore().getImageDraft(CHAT_SID)).toEqual([])

    payload.restore()
    await flushPromises()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('照着这张改')
    expect(
      useChatSessionsStore()
        .getImageDraft(CHAT_SID)
        .map((img) => img.id)
    ).toEqual(['a'])
    wrapper.unmount()
  })

  it('这期间又打了字，就不拿旧的盖掉', async () => {
    const wrapper = await steeringComposer([])
    await wrapper.get('textarea').setValue('第一句')
    await wrapper.get('.send-btn').trigger('click')
    const payload = wrapper.emitted('steer')?.[0]?.[0] as { restore: () => void }

    await wrapper.get('textarea').setValue('已经在打第二句')
    payload.restore()
    await flushPromises()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('已经在打第二句')
    wrapper.unmount()
  })
})
