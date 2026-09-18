import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia } from 'pinia'
import { useGlobalAudioStore } from '@renderer/store/modules/globalAudio'
import ChatAudioPlayer from '@renderer/views/Assistant/components/ChatAudioPlayer.vue'
import GlobalAudioPlayer from './GlobalAudioPlayer.vue'

const state = vi.hoisted(() => ({
  togglePause: vi.fn(),
  stop: vi.fn()
}))
const active = ref(false)
const paused = ref(false)
vi.mock('@renderer/views/Assistant/composables/useReadAloud', () => ({
  useSpeechPlayback: () => ({ active, paused, changing: ref(false), ...state })
}))

beforeEach(() => {
  active.value = false
  paused.value = false
  state.togglePause.mockReset().mockImplementation(async () => {
    paused.value = !paused.value
  })
  state.stop.mockReset().mockImplementation(() => {
    active.value = false
  })
})

describe('全局朗读悬浮框', () => {
  it('没有音乐也会随朗读出现，提供暂停、继续和关闭', async () => {
    const wrapper = mount(GlobalAudioPlayer)
    expect(wrapper.find('.global-audio-player').exists()).toBe(false)
    active.value = true
    await flushPromises()
    expect(wrapper.get('.audio-title').text()).toBe('AI 回复朗读')
    await wrapper.get('button[aria-label="暂停朗读"]').trigger('click')
    await flushPromises()
    expect(state.togglePause).toHaveBeenCalledTimes(1)
    await wrapper.get('button[aria-label="继续朗读"]').trigger('click')
    await flushPromises()
    expect(state.togglePause).toHaveBeenCalledTimes(2)
    await wrapper.get('button[aria-label="停止朗读"]').trigger('click')
    await flushPromises()
    expect(state.stop).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.global-audio-player').exists()).toBe(false)
    wrapper.unmount()
  })
})

it('music uses one global player, survives leaving the chat, and shares seek/loop state', async () => {
  const pinia = createPinia()
  const store = useGlobalAudioStore(pinia)
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const floating = mount(GlobalAudioPlayer, { global: { plugins: [pinia] } })
  const card = mount(ChatAudioPlayer, {
    props: { filePath: 'C:/one.mp3' },
    global: { plugins: [pinia] }
  })
  await card.get('button[aria-label="播放"]').trigger('click')
  await flushPromises()
  expect(floating.find('.global-audio-player').exists()).toBe(true)
  const element = floating.get('audio').element as HTMLAudioElement
  expect(element.getAttribute('src')).toBe('local-resource://C:/one.mp3')
  Object.defineProperty(element, 'duration', { value: 120, configurable: true })
  Object.defineProperty(element, 'readyState', { value: 4, configurable: true })
  await floating.get('audio').trigger('loadedmetadata')
  await floating.get('audio').trigger('canplay')
  expect(play.mock.contexts.every((context) => context === element)).toBe(true)
  await card.get('input').setValue('50')
  await flushPromises()
  expect(element.currentTime).toBe(50)
  await card.get('button[aria-label="单曲循环"]').trigger('click')
  await floating.get('audio').trigger('ended')
  expect(element.currentTime).toBe(0)
  expect(store.isPlaying).toBe(true)
  store.loopMode = 'list'
  element.currentTime = 120
  await floating.get('audio').trigger('ended')
  expect(element.currentTime).toBe(0)
  card.unmount()
  expect(store.isPlaying).toBe(true)
  expect(floating.get('audio').element).toBe(element)
  store.playPlaylist([{ src: 'C:/two.mp3', title: 'Two' }])
  await flushPromises()
  expect(floating.findAll('audio')).toHaveLength(1)
  expect(element.getAttribute('src')).toBe('local-resource://C:/two.mp3')
  expect(store.currentTime).toBe(0)
  // Reading pauses music; starting music again stops reading.
  active.value = true
  await flushPromises()
  expect(store.isPlaying).toBe(false)
  store.resume()
  await flushPromises()
  expect(active.value).toBe(false)
  store.stop()
  floating.unmount()
  play.mockRestore()
  pause.mockRestore()
  load.mockRestore()
})
