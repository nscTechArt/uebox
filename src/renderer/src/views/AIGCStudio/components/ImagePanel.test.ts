import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, KeepAlive, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { SettingsView } from '@core/shared/aiProvider'
import { aiProviderAPI } from '@renderer/api/aiProvider'
import ImagePanel from './ImagePanel.vue'

vi.mock('@renderer/api/aiProvider', () => ({
  aiProviderAPI: { getSettings: vi.fn() }
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

function settings(names = ['First', 'Second']): SettingsView {
  return {
    providers: [
      {
        id: 'images',
        displayName: 'Images',
        kind: 'image',
        protocol: 'openai-completions',
        baseUrl: 'http://localhost',
        apiKey: { kind: 'none' },
        models: names.map((displayName, index) => ({ id: `model-${index}`, displayName }))
      }
    ],
    roles: { image: { providerId: 'images', modelId: 'model-0' } },
    configured: true,
    encryptionAvailable: true,
    path: ''
  }
}

const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
  localStorage.clear()
})

async function studio(delayed = false): Promise<{
  wrapper: ReturnType<typeof mount>
  returnToStudio: () => Promise<void>
}> {
  const active = ref(true)
  const ready = ref(!delayed)
  const page = defineComponent({
    setup: () => () => (ready.value ? h(ImagePanel) : null)
  })
  const wrapper = mount(
    {
      setup: () => () => h(KeepAlive, null, { default: () => (active.value ? h(page) : null) })
    },
    {
      global: {
        stubs: {
          'a-select': {
            name: 'ModelSelect',
            props: ['value', 'loading', 'disabled'],
            template: '<div><slot /></div>'
          },
          'a-select-option': { template: '<span><slot /></span>' },
          AppModal: true
        }
      }
    }
  )
  wrappers.push(wrapper)
  await flushPromises()
  if (delayed) {
    ready.value = true
    await flushPromises()
  }
  return {
    wrapper,
    async returnToStudio() {
      active.value = false
      await flushPromises()
      active.value = true
      await flushPromises()
    }
  }
}

describe('ImagePanel cached model list', () => {
  it('loads on first entry when the parent finishes its async check after activation', async () => {
    vi.mocked(aiProviderAPI.getSettings).mockResolvedValue(settings())
    const { wrapper } = await studio(true)
    expect(aiProviderAPI.getSettings).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent({ name: 'ModelSelect' }).props('value')).toBe(
      JSON.stringify(['images', 'model-0'])
    )
    expect(wrapper.find('.model-select').text()).toContain('First')
  })

  it('restores the chosen provider and model after a full remount', async () => {
    vi.mocked(aiProviderAPI.getSettings).mockResolvedValue(settings())
    const first = await studio()
    const id = JSON.stringify(['images', 'model-1'])
    first.wrapper.findComponent({ name: 'ModelSelect' }).vm.$emit('change', id)
    await flushPromises()
    expect(localStorage.getItem('aigc-image-selected-model')).toBe(id)
    first.wrapper.unmount()
    wrappers.splice(wrappers.indexOf(first.wrapper), 1)
    const second = await studio(true)
    expect(second.wrapper.findComponent({ name: 'ModelSelect' }).props('value')).toBe(id)
  })

  it('accepts a legacy model id and falls back if the saved model was deleted', async () => {
    vi.mocked(aiProviderAPI.getSettings).mockResolvedValue(settings())
    localStorage.setItem('aigc-image-selected-model', 'model-1')
    const first = await studio(true)
    expect(first.wrapper.findComponent({ name: 'ModelSelect' }).props('value')).toBe(
      JSON.stringify(['images', 'model-1'])
    )
    localStorage.setItem('aigc-image-selected-model', JSON.stringify(['deleted', 'model-1']))
    const second = await studio(true)
    expect(second.wrapper.findComponent({ name: 'ModelSelect' }).props('value')).toBe(
      JSON.stringify(['images', 'model-0'])
    )
  })

  it('refreshes aliases on return while preserving the chosen model and prompt', async () => {
    vi.mocked(aiProviderAPI.getSettings).mockResolvedValue(settings())
    const { wrapper, returnToStudio } = await studio()
    expect(aiProviderAPI.getSettings).toHaveBeenCalledTimes(1)
    const panel = wrapper.findComponent(ImagePanel)
    const select = panel.findComponent({ name: 'ModelSelect' })
    select.vm.$emit('change', JSON.stringify(['images', 'model-1']))
    await panel.find('textarea').setValue('Keep this prompt')
    vi.mocked(aiProviderAPI.getSettings).mockResolvedValue(settings(['First', 'Renamed']))
    await returnToStudio()
    expect(wrapper.find('.model-select').text()).toContain('Renamed')
    expect(wrapper.find('.model-select').text()).not.toContain('Second')
    expect(select.props('value')).toBe(JSON.stringify(['images', 'model-1']))
    expect(wrapper.find('textarea').element.value).toBe('Keep this prompt')
  })

  it('falls back when the selected model is removed and handles an empty list', async () => {
    vi.mocked(aiProviderAPI.getSettings).mockResolvedValue(settings())
    const { wrapper, returnToStudio } = await studio()
    wrapper
      .findComponent({ name: 'ModelSelect' })
      .vm.$emit('change', JSON.stringify(['images', 'model-1']))
    vi.mocked(aiProviderAPI.getSettings).mockResolvedValue(settings(['First']))
    await returnToStudio()
    expect(wrapper.findComponent({ name: 'ModelSelect' }).props('value')).toBe(
      JSON.stringify(['images', 'model-0'])
    )
    vi.mocked(aiProviderAPI.getSettings).mockResolvedValue(settings([]))
    await returnToStudio()
    expect(wrapper.findComponent({ name: 'ModelSelect' }).props('value')).toBe('')
    expect(wrapper.findComponent({ name: 'ModelSelect' }).props('disabled')).toBe(true)
  })

  it('keeps the last list after a read failure and retries on the next visit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(aiProviderAPI.getSettings).mockResolvedValue(settings())
    const { wrapper, returnToStudio } = await studio()
    vi.mocked(aiProviderAPI.getSettings).mockRejectedValueOnce(new Error('read failed'))
    await returnToStudio()
    expect(wrapper.find('.model-select').text()).toContain('First')
    expect(wrapper.findComponent({ name: 'ModelSelect' }).props('loading')).toBe(false)
    vi.mocked(aiProviderAPI.getSettings).mockResolvedValue(settings(['Updated']))
    await returnToStudio()
    expect(wrapper.find('.model-select').text()).toContain('Updated')
  })
})
