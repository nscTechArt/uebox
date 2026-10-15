import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import ProfileMiniChat from './ProfileMiniChat.vue'

/**
 * 透明度滑块必须走 `window.api.miniChat` 桥接：旧实现直接
 * `window.electron.ipcRenderer.send('mini-chat:set-opacity')`，该通道不在
 * preload 的 RAW_REQUEST_CHANNELS 白名单里，走到必抛 Blocked send channel ——
 * store 值已写、已开的小窗却收不到，重开小窗又因挂载时的取值「看起来好了」。
 */

const originalApi = window.api
const electronSend = window.electron.ipcRenderer.send

afterEach(() => {
  window.api = originalApi
})

function mountPanel(): { wrapper: VueWrapper; setOpacity: Mock } {
  const setOpacity = vi.fn()
  window.api = { miniChat: { setOpacity } } as unknown as typeof window.api
  const wrapper = mount(ProfileMiniChat, {
    global: {
      stubs: {
        ASlider: { name: 'ASlider', props: ['value'], template: '<div />' }
      }
    }
  })
  return { wrapper, setOpacity }
}

it('把透明度改动经 window.api.miniChat.setOpacity 发出，不碰裸 ipcRenderer', () => {
  const { wrapper, setOpacity } = mountPanel()
  wrapper.findComponent({ name: 'ASlider' }).vm.$emit('update:value', 60)
  expect(setOpacity).toHaveBeenCalledWith(0.6)
  expect(useAIConfigStore().config.miniChatOpacity).toBe(0.6)
  expect(electronSend).not.toHaveBeenCalled()
  wrapper.unmount()
})

it('发出前把滑块值夹进 0.4–1', () => {
  const { wrapper, setOpacity } = mountPanel()
  wrapper.findComponent({ name: 'ASlider' }).vm.$emit('update:value', 20)
  expect(setOpacity).toHaveBeenCalledWith(0.4)
  expect(useAIConfigStore().config.miniChatOpacity).toBe(0.4)
  wrapper.findComponent({ name: 'ASlider' }).vm.$emit('update:value', 120)
  expect(setOpacity).toHaveBeenCalledWith(1)
  expect(useAIConfigStore().config.miniChatOpacity).toBe(1)
  wrapper.unmount()
})
