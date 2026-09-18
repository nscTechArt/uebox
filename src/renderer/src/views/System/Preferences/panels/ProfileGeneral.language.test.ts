import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { getLocale, setLocale } from '@renderer/i18n'
import ProfileGeneral from './ProfileGeneral.vue'

vi.mock('@renderer/utils/messageManager', () => ({
  message: { success: vi.fn(), error: vi.fn() }
}))

afterEach(() => vi.useRealTimers())

it('changes and saves the language from General without saving on mount', async () => {
  vi.useFakeTimers()
  const previous = getLocale()
  const setLanguage = vi.fn().mockResolvedValue(undefined)
  window.api = {
    appSettings: {
      get: vi.fn().mockResolvedValue({
        autoLaunch: true,
        notifyTurnComplete: 'unfocused',
        notifyApprovalRequired: true,
        notifyQuestionRequired: true
      }),
      setLanguage
    }
  } as unknown as typeof window.api
  const wrapper = mount(ProfileGeneral, {
    global: {
      mocks: { $t: (key: string) => key },
      stubs: {
        ASelect: { name: 'ASelect', props: ['value'], template: '<div><slot /></div>' },
        ASelectOption: true
      }
    }
  })
  await flushPromises()
  expect(setLanguage).not.toHaveBeenCalled()
  const next = previous === 'en-US' ? 'zh-CN' : 'en-US'
  wrapper.findAllComponents({ name: 'ASelect' })[0].vm.$emit('update:value', next)
  await flushPromises()
  expect(getLocale()).toBe(next)
  expect(localStorage.getItem('locale')).toBe(next)
  expect(setLanguage).toHaveBeenCalledWith(next)
  wrapper.unmount()
  setLocale(previous)
})
