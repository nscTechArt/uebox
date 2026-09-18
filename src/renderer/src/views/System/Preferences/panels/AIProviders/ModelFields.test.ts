/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { computed, ref } from 'vue'
import type { ModelConfig, ProviderDraft } from '@core/shared/aiProvider'
import ModelFields from './ModelFields.vue'
import type { AiProvidersState } from './useAiProviders'

function makeState(
  baseUrl: string,
  realtimeVoice?: string,
  modelOverrides: Partial<ModelConfig> = {}
): AiProvidersState {
  const draft = ref<ProviderDraft>({
    id: 'doubao-realtime',
    displayName: '豆包实时语音',
    // 用途在 Provider 上：音色栏只对 realtime 用途出现
    kind: 'realtime',
    protocol: 'openai-completions',
    baseUrl,
    models: [{ id: '1.2.6.1', realtimeVoice, ...modelOverrides }]
  })

  return {
    draft,
    providers: computed(() => []),
    isNew: ref(false),
    isDirty: computed(() => false),
    saving: ref(false),
    testing: ref(false),
    selectedId: ref('doubao-realtime'),
    configPath: computed(() => ''),
    selectProvider: () => undefined,
    cancelEdit: () => undefined,
    save: async () => true,
    remove: async () => true,
    test: async () => true,
    importModels: async () => undefined
  } as unknown as AiProvidersState
}

function mountFields(state: AiProvidersState): VueWrapper {
  return mount(ModelFields, {
    props: { state, index: 0 },
    global: {
      stubs: {
        'a-checkbox': {
          template: '<label><slot /></label>'
        },
        ThinkingLadderField: true
      },
      mocks: { $t: (key: string) => key }
    }
  })
}

it('语音合成音色写入独立字段，不修改实时语音音色', async () => {
  const state = makeState('https://openspeech.bytedance.com', 'realtime-voice')
  state.draft.value!.kind = 'tts'
  const wrapper = mountFields(state)
  await wrapper.get('input[placeholder="zh_female_vv_uranus_bigtts"]').setValue('tts-custom')
  expect(state.draft.value!.models[0].ttsVoice).toBe('tts-custom')
  expect(state.draft.value!.models[0].realtimeVoice).toBe('realtime-voice')
  expect(wrapper.find('select').exists()).toBe(false)
})

it.each([
  ['qwen-audio-3.0-tts-plus', 'longanlingxin'],
  ['qwen-audio-3.0-tts-flash', 'longanfengyue']
])('%s 显示自己的默认音色', (id, voice) => {
  const state = makeState('wss://dashscope.aliyuncs.com', undefined, { id })
  state.draft.value!.kind = 'tts'
  const wrapper = mountFields(state)
  expect(wrapper.find(`input[placeholder="${voice}"]`).exists()).toBe(true)
})

describe('豆包实时语音音色', () => {
  it('豆包模型显示四个中文音色，老配置默认选中 VV', () => {
    const wrapper = mountFields(makeState('https://openspeech.bytedance.com'))
    const select = wrapper.find('select')

    expect(select.exists()).toBe(true)
    expect(select.findAll('option')).toHaveLength(4)
    expect((select.element as HTMLSelectElement).value).toBe('zh_female_vv_jupiter_bigtts')
  })

  it('改选后写进模型草稿，保存时会随 Provider 一起落盘', async () => {
    const state = makeState('https://openspeech.bytedance.com', 'zh_female_vv_jupiter_bigtts')
    const wrapper = mountFields(state)

    await wrapper.find('select').setValue('zh_male_xiaotian_jupiter_bigtts')

    expect(state.draft.value?.models[0].realtimeVoice).toBe('zh_male_xiaotian_jupiter_bigtts')
  })

  it('普通对话 Provider 不显示实时音色选项', () => {
    const wrapper = mountFields(makeState('https://api.openai.com/v1'))

    expect(wrapper.find('select').exists()).toBe(false)
  })
})

describe('OpenAI Realtime 音色', () => {
  function openAiState(realtimeVoice?: string): AiProvidersState {
    return makeState('https://api.openai.com/v1', realtimeVoice, { id: 'gpt-realtime-2.1' })
  }

  it('GPT-Realtime-2.1 只显示首批接入的 Marin 与 Cedar，默认选中 Marin', () => {
    const wrapper = mountFields(openAiState())
    const select = wrapper.find('select')

    expect(select.findAll('option').map((option) => option.attributes('value'))).toEqual([
      'marin',
      'cedar'
    ])
    expect((select.element as HTMLSelectElement).value).toBe('marin')
  })

  it('改选 Cedar 后写进模型草稿', async () => {
    const state = openAiState('marin')
    const wrapper = mountFields(state)

    await wrapper.find('select').setValue('cedar')

    expect(state.draft.value?.models[0].realtimeVoice).toBe('cedar')
  })
})
