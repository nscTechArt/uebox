/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import ProfileAI from './ProfileAI.vue'

/**
 * 「允许编辑器截图」这一格。
 *
 * 这个开关曾经是**假的**：界面点得动、store 存得下，主进程一次都没读过
 * （`grep -rn editorScreenshotEnabled src/main` 零命中），`ue_screenshot` 照样
 * 在工具池里。一个什么都不做的隐私开关比没有开关更糟 —— 用户以为自己关上了。
 *
 * 主进程那一侧的闸门测在
 * `main/agent-v3/core/editorScreenshotScope.test.ts` 和 `createAgent.test.ts`；
 * 这里守的是**界面到 store 这一段**：点得到、点了真的改值、默认是开着的。
 * 这三条里任何一条断了，后面那些闸门再对也等于不存在。
 */

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('./ArchivedChatsModal.vue', () => ({ default: { template: '<div />' } }))

function mountPanel(): ReturnType<typeof mount> {
  return mount(ProfileAI, { global: { mocks: { $t: (key: string) => key } } })
}

/** 这一格的开关。靠 label 的 i18n key 认（$t 被替身成原样返回 key） */
function screenshotSwitch(wrapper: ReturnType<typeof mount>): {
  attributes: (name: string) => string | undefined
  trigger: (event: string) => Promise<void>
} {
  const row = wrapper
    .findAll('.setting-item')
    .find((item) => item.text().includes('profile.ai.editorScreenshot'))!
  return row.find('.app-switch') as never
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  ;(window as unknown as { api: unknown }).api = {
    appSettings: {
      get: vi.fn(async () => ({ agentBrowserMode: 'window' })),
      set: vi.fn(async () => ({ success: true }))
    },
    invoke: vi.fn(async () => undefined)
  }
})

describe('AI 设置 · 允许编辑器截图', () => {
  /**
   * 默认开着，和主进程的 `EDITOR_SCREENSHOT_DEFAULT` 一致。
   *
   * 两边不一致会出现最糟的一种错位：界面显示关着、实际生效的是开着（或反过来），
   * 用户看着设置对不上行为，而且没有任何报错。
   */
  it('没设置过时开关是开着的', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    expect(screenshotSwitch(wrapper).attributes('aria-checked')).toBe('true')
  })

  it('点一下真的把值写进 store，而不是只改本地 ref', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await screenshotSwitch(wrapper).trigger('click')
    await flushPromises()

    expect(useAIConfigStore().editorScreenshotEnabled).toBe(false)
    expect(screenshotSwitch(wrapper).attributes('aria-checked')).toBe('false')
  })

  // 用户关过就得照关着显示 —— 挂载时被默认值覆盖回去的话，他会以为自己没关成
  it('读回用户已经关掉的状态', async () => {
    useAIConfigStore().setEditorScreenshotEnabled(false)

    const wrapper = mountPanel()
    await flushPromises()

    expect(screenshotSwitch(wrapper).attributes('aria-checked')).toBe('false')
  })
})
