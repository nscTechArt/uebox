import { createPinia, setActivePinia } from 'pinia'
import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { useAIConfigStore } from './aiConfig'
import PreferencesSidebar from '../../views/System/Preferences/components/PreferencesSidebar.vue'

it('keeps history enabled and opacity at 100% despite old preferences', () => {
  setActivePinia(createPinia())
  const store = useAIConfigStore()
  store.setMiniChatPersistEnabled(false)
  store.setMiniChatOpacity(0.4)
  expect(store.config.miniChatPersistEnabled).toBe(false)
  expect(store.config.miniChatOpacity).toBe(0.4)
  expect(store.miniChatPersistEnabled).toBe(true)
  expect(store.miniChatOpacity).toBe(1)
  store.resetConfig()
  expect(store.miniChatPersistEnabled).toBe(true)
  expect(store.miniChatOpacity).toBe(1)
})

it('does not offer the Mini Chat settings entry', () => {
  const wrapper = mount(PreferencesSidebar, {
    props: { activeKey: 'general' },
    global: { mocks: { $t: (key: string) => key } }
  })
  expect(wrapper.text()).not.toContain('profile.menu.miniChat')
  expect(wrapper.text()).toContain('profile.menu.general')
  wrapper.unmount()
})
