import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import ProfileVoice from './ProfileVoice.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

beforeEach(() => setActivePinia(createPinia()))

describe('回声门限', () => {
  /**
   * 默认必须是「外放」而不是最灵敏那档：桌面端绝大多数是外放，
   * 而门限偏低的代价是模型把自己的尾音当成用户在说话，开始跟自己对话。
   */
  it('默认外放，选了就存下来', async () => {
    const store = useAIConfigStore()
    const wrapper = mount(ProfileVoice, { global: { mocks: { $t: (key: string) => key } } })
    expect(store.voiceEchoGuard).toBe('speaker')
    const segmented = wrapper.get('[aria-label="profile.voice.echoGuard"]')
    expect(segmented.text()).toContain('profile.voice.echoGuardStrong')
    await segmented.findAll('button')[2].trigger('click')
    expect(store.voiceEchoGuard).toBe('strong')
    wrapper.unmount()
  })
})

describe('独立的语音自动结束设置', () => {
  it('语音和语音助手分组，自动播放默认关闭并独立保存', async () => {
    const store = useAIConfigStore()
    const wrapper = mount(ProfileVoice, { global: { mocks: { $t: (key: string) => key } } })
    const sections = wrapper.findAll('section')
    expect(sections).toHaveLength(3)
    expect(sections[0].text()).toContain('profile.voice.generalTitle')
    expect(sections[0].text()).toContain('profile.voice.microphone')
    expect(sections[0].find('[aria-label="profile.voice.autoPlay"]').exists()).toBe(false)
    expect(sections[0].find('[aria-label="profile.voice.autoHangup"]').exists()).toBe(false)
    expect(sections[1].text()).toContain('profile.voice.title')
    expect(sections[1].text()).not.toContain('profile.voice.microphone')
    expect(sections[2].text()).toContain('profile.voice.assistantTitle')
    expect(sections[2].text()).toContain('profile.voice.feedback')
    expect(sections[2].find('[aria-label="profile.voice.autoHangup"]').exists()).toBe(true)
    const toggle = sections[1].get('[aria-label="profile.voice.autoPlay"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    await toggle.trigger('click')
    expect(store.config.voiceAutoPlayEnabled).toBe(true)
    expect(store.voiceAntiSilenceEnabled).toBe(true)
    expect(store.voiceAutoHangupEnabled).toBe(true)
    wrapper.unmount()
    const reopened = mount(ProfileVoice, { global: { mocks: { $t: (key: string) => key } } })
    expect(reopened.get('[aria-label="profile.voice.autoPlay"]').attributes('aria-checked')).toBe(
      'true'
    )
    reopened.unmount()
  })

  it('保存麦克风选择，设备缺失时保留选择，并可恢复系统默认', async () => {
    const store = useAIConfigStore()
    const wrapper = mount(ProfileVoice, {
      global: {
        mocks: { $t: (key: string) => key },
        stubs: { ASelect: { name: 'ASelect', props: ['value', 'options'], template: '<div />' } }
      }
    })
    const select = wrapper.findComponent({ name: 'ASelect' })
    expect(store.voiceMicrophoneDeviceId).toBe('')
    select.vm.$emit('update:value', 'usb-microphone')
    await flushPromises()
    expect(store.config.voiceMicrophoneDeviceId).toBe('usb-microphone')
    expect(select.props('options')).toContainEqual({
      value: 'usb-microphone',
      label: 'profile.voice.microphoneUnavailable',
      disabled: true
    })
    select.vm.$emit('update:value', '')
    await flushPromises()
    expect(store.config.voiceMicrophoneDeviceId).toBe('')
    wrapper.unmount()
  })

  it.each([false, true])('保留旧配置的自动结束状态：%s', (enabled) => {
    const store = useAIConfigStore()
    store.config.voiceAntiSilenceEnabled = enabled
    expect(store.voiceAutoHangupEnabled).toBe(enabled)
    store.setVoiceAntiSilenceEnabled(!enabled)
    expect(store.voiceAutoHangupEnabled).toBe(enabled)
    expect(store.config.voiceAutoHangupEnabled).toBe(enabled)
  })

  it('切换自动结束不改变语音反馈，切换反馈也不改变开关', async () => {
    const store = useAIConfigStore()
    store.config.voiceAntiSilenceEnabled = false
    const wrapper = mount(ProfileVoice, { global: { mocks: { $t: (key: string) => key } } })
    const toggle = wrapper.get('[aria-label="profile.voice.autoHangup"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    await toggle.trigger('click')
    expect(store.voiceAutoHangupEnabled).toBe(true)
    expect(store.voiceAntiSilenceEnabled).toBe(false)
    store.setVoiceAntiSilenceEnabled(true)
    await flushPromises()
    expect(toggle.attributes('aria-checked')).toBe('true')
    await toggle.trigger('click')
    expect(store.voiceAntiSilenceEnabled).toBe(true)
    expect(store.config.voiceAutoHangupEnabled).toBe(false)
    wrapper.unmount()
  })
})
