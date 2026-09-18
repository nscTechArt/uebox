import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { RealtimeVoiceState } from '../composables/useRealtimeVoice'
import type { SettingsView } from '@core/shared/aiProvider'

const mocks = vi.hoisted(() => ({ settings: vi.fn(), push: vi.fn(), info: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/api/aiProvider', () => ({ aiProviderAPI: { getSettings: mocks.settings } }))
vi.mock('@/api/agentV3', () => ({
  agentV3API: { thinkingLevels: async () => null, listSkills: async () => ({ skills: [] }) }
}))
vi.mock('@/utils/messageManager', () => ({ message: { info: mocks.info } }))
vi.mock('../composables/voiceAssistant', () => ({ startVoiceIn: vi.fn() }))

import InputComposer from './InputComposer.vue'

const empty: SettingsView = {
  providers: [],
  roles: {},
  configured: false,
  encryptionAvailable: true,
  path: ''
}
const ready: SettingsView = {
  ...empty,
  configured: true,
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
  roles: { agent: { providerId: 'local', modelId: 'test' } }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings.mockResolvedValue(empty)
  setActivePinia(createPinia())
})

async function composer(): Promise<VueWrapper> {
  const wrapper = shallowMount(InputComposer, {
    attachTo: document.body,
    props: {
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

describe('输入框首次发送与恢复', () => {
  it('权限与思考选项可聚焦，Escape 关闭面板并归还焦点', async () => {
    const wrapper = await composer()
    for (const selector of ['approval', 'thinking']) {
      const trigger = wrapper.get(`.${selector}-selector button.mode-trigger`)
      ;(trigger.element as HTMLButtonElement).focus()
      await trigger.trigger('click')
      const option = wrapper.get(`.${selector}-dropdown button`)
      ;(option.element as HTMLButtonElement).focus()
      expect(document.activeElement).toBe(option.element)
      await option.trigger('keydown', { key: 'Escape' })
      expect(wrapper.find(`.${selector}-dropdown`).exists()).toBe(false)
      expect(document.activeElement).toBe(trigger.element)
    }
    wrapper.unmount()
  })

  it('没有可用模型时保留草稿，不创建失败会话，提供直接设置入口', async () => {
    const wrapper = await composer()
    await wrapper.get('textarea').setValue('不要丢掉这份草稿')
    await wrapper.get('.send-btn').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(wrapper.get('textarea').element.value).toBe('不要丢掉这份草稿')
    await wrapper.get('.agent-model-settings').trigger('click')
    expect(mocks.push).toHaveBeenCalledWith({ path: '/preferences', query: { tab: 'models' } })
    wrapper.unmount()
  })

  it('模型设置有效时正常发送并清空草稿', async () => {
    mocks.settings.mockResolvedValue(ready)
    const wrapper = await composer()
    await wrapper.get('textarea').setValue('继续我的任务')
    await wrapper.get('.send-btn').trigger('click')
    expect(wrapper.emitted('send')?.[0]?.[0]).toMatchObject({ content: '继续我的任务' })
    expect(wrapper.get('textarea').element.value).toBe('')
    wrapper.unmount()
  })

  it('没有模型仍可使用本地压缩命令，不被模型设置挡住', async () => {
    const wrapper = await composer()
    await wrapper.get('textarea').setValue('/compact')
    await wrapper.get('.send-btn').trigger('click')
    expect(wrapper.emitted('run-command')?.[0]).toEqual(['compact'])
    expect(wrapper.emitted('send')).toBeUndefined()
    wrapper.unmount()
  })
})
