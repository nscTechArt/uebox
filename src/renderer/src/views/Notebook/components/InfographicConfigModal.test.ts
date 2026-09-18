import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { ProviderView, SettingsView } from '@core/shared/aiProvider'
import InfographicConfigModal from './InfographicConfigModal.vue'

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush })
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, params?: Record<string, string>) =>
        params?.provider ? `${key}:${params.provider}` : key
    })
  }
})

const mounted: VueWrapper[] = []

function provider(models: ProviderView['models']): ProviderView {
  return {
    id: 'images',
    displayName: 'My Images',
    kind: 'image',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: { kind: 'none' },
    models
  }
}

function settings(providers: ProviderView[], roles: SettingsView['roles'] = {}): SettingsView {
  return {
    providers,
    roles,
    path: 'C:\\models.json',
    encryptionAvailable: true,
    configured: providers.length > 0
  }
}

function mountModal(value: SettingsView): VueWrapper {
  window.api.aiProvider = {
    getSettings: vi.fn(async () => value)
  } as unknown as typeof window.api.aiProvider
  const wrapper = mount(InfographicConfigModal, {
    props: { visible: true },
    attachTo: document.body
  })
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
  localStorage.clear()
  routerPush.mockReset()
})

describe('InfographicConfigModal', () => {
  it('没有可用生图模型时关闭弹窗并跳到服务商配置', async () => {
    const wrapper = mountModal(settings([]))
    await flushPromises()

    expect(routerPush).toHaveBeenCalledWith('/preferences?tab=models')
    expect(wrapper.emitted('update:visible')).toContainEqual([false])
  })

  it('模型很多时完整放进独立滚动区，不截断选项', async () => {
    const models = Array.from({ length: 24 }, (_, index) => ({
      id: `image-${index}`,
      displayName: `Image ${index}`
    }))
    mountModal(settings([provider(models)]))
    await flushPromises()

    const scrollRegion = document.body.querySelector('.modal-body')
    expect(scrollRegion).not.toBeNull()
    expect(scrollRegion?.querySelectorAll('.model-option')).toHaveLength(24)
  })

  it('确认后保存实际 Provider 与模型，后续生成使用这一项', async () => {
    const models = [
      { id: 'image-a', displayName: 'Image A' },
      { id: 'image-b', displayName: 'Image B' }
    ]
    mountModal(
      settings([provider(models)], { image: { providerId: 'images', modelId: 'image-a' } })
    )
    await flushPromises()

    const options = document.body.querySelectorAll<HTMLButtonElement>('.model-option')
    options[1].click()
    await nextTick()
    document.body.querySelector<HTMLButtonElement>('.confirm-btn')?.click()
    await nextTick()

    expect(JSON.parse(localStorage.getItem('infographic_model_config') || '{}')).toMatchObject({
      providerId: 'images',
      modelId: 'image-b'
    })
  })

  it('允许编辑 Prompt，并在确认后保存用户模板', async () => {
    mountModal(settings([provider([{ id: 'image-a', displayName: 'Image A' }])]))
    await flushPromises()

    const promptInput = document.body.querySelector<HTMLTextAreaElement>('.prompt-input')
    expect(promptInput?.value).toContain('{title}')
    expect(promptInput?.value).toContain('{content}')

    const customPrompt = '为 {title} 绘制手绘信息图，必须包含：{content}'
    if (!promptInput) throw new Error('Prompt 输入框未渲染')
    promptInput.value = customPrompt
    promptInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    document.body.querySelector<HTMLButtonElement>('.confirm-btn')?.click()
    await nextTick()

    expect(JSON.parse(localStorage.getItem('infographic_model_config') || '{}')).toMatchObject({
      prompt: customPrompt
    })
  })

  it('重新打开时回填已保存的 Prompt，恢复默认后不再保存覆盖值', async () => {
    localStorage.setItem(
      'infographic_model_config',
      JSON.stringify({
        imageSize: '1536x1024',
        aspectRatio: '3:2',
        providerId: 'images',
        modelId: 'image-a',
        prompt: '已保存的 {title} / {content}'
      })
    )
    mountModal(settings([provider([{ id: 'image-a', displayName: 'Image A' }])]))
    await flushPromises()

    const promptInput = document.body.querySelector<HTMLTextAreaElement>('.prompt-input')
    expect(promptInput?.value).toBe('已保存的 {title} / {content}')

    document.body.querySelector<HTMLButtonElement>('.reset-prompt-btn')?.click()
    await nextTick()
    document.body.querySelector<HTMLButtonElement>('.confirm-btn')?.click()
    await nextTick()

    expect(JSON.parse(localStorage.getItem('infographic_model_config') || '{}')).not.toHaveProperty(
      'prompt'
    )
  })
})
