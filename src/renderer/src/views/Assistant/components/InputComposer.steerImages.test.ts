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

    expect(wrapper.emitted('steer')?.[0]?.[0]).toEqual({
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

    expect(wrapper.emitted('steer')?.[0]?.[0]).toEqual({
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
