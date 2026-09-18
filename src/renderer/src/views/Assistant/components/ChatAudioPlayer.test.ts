import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { useGlobalAudioStore } from '@renderer/store/modules/globalAudio'
import ChatAudioPlayer from './ChatAudioPlayer.vue'
import { collectGeneratedMusic } from '../composables/agentGeneratedMedia'
import { saveAudioCopy } from '@renderer/api/chatAudio'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string): string => key }) }))
vi.mock('@renderer/api/chatAudio', () => ({ saveAudioCopy: vi.fn() }))

describe('chat music', () => {
  it('keeps both tracks, deduplicates historical results and ignores failed tools', () => {
    const result = {
      tracks: [{ path: 'C:/music/1.mp3' }, { path: 'C:/music/2.mp3', title: 'Second' }]
    }
    expect(
      collectGeneratedMusic({
        toolResults: [{ toolName: 'generate_task_music', result: JSON.stringify(result) }],
        agentProcess: [
          { type: 'tool-result', timestamp: 1, data: { toolName: 'generate_task_music', result } },
          {
            type: 'tool-result',
            timestamp: 2,
            data: { toolName: 'generate_task_music', isError: true, result: { path: 'C:/bad.mp3' } }
          }
        ]
      })
    ).toEqual([
      { path: 'C:/music/1.mp3', title: undefined },
      { path: 'C:/music/2.mp3', title: 'Second' }
    ])
    expect(
      collectGeneratedMusic({
        toolResults: [{ toolName: 'generate_task_music', result: { path: 'C:/old.mp3' } }]
      })
    ).toHaveLength(1)
  })

  it('plays, pauses, seeks and exposes copy/save actions without autoplay', async () => {
    const wrapper = mount(ChatAudioPlayer, {
      props: { filePath: 'C:/music/second.mp3' },
      global: {
        stubs: {
          AppDropdown: { template: '<div><slot /><slot name="overlay" /></div>' },
          AppMenu: { template: '<div><slot /></div>' },
          AppMenuItem: { template: '<button><slot /></button>' }
        }
      }
    })
    const element = wrapper.get('audio').element as HTMLAudioElement
    const play = vi.spyOn(element, 'play').mockResolvedValue()
    const pause = vi.spyOn(element, 'pause').mockImplementation(() => {})
    expect(element.autoplay).toBe(false)
    expect(element.getAttribute('src')).toBe('local-resource://C:/music/second.mp3')
    await wrapper.get('[aria-label="assistant.musicPlayer.play"]').trigger('click')
    const store = useGlobalAudioStore()
    expect(play).not.toHaveBeenCalled()
    expect(store.isPlaying).toBe(true)
    expect(store.currentAudio?.src).toBe('local-resource://C:/music/second.mp3')
    await wrapper.get('[aria-label="assistant.musicPlayer.pause"]').trigger('click')
    expect(pause).not.toHaveBeenCalled()
    expect(store.isPlaying).toBe(false)
    Object.defineProperty(element, 'duration', { value: 120, configurable: true })
    await wrapper.get('audio').trigger('loadedmetadata')
    store.duration = 120
    await wrapper.get('input').setValue('60')
    expect(store.seekRequest?.time).toBe(60)
    store.currentTime = 60
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('1:00 / 2:00')
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('musicPlayer.copy'))!
      .trigger('click')
    expect(writeText).toHaveBeenCalledWith('C:/music/second.mp3')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('musicPlayer.save'))!
      .trigger('click')
    await flushPromises()
    expect(saveAudioCopy).toHaveBeenCalledWith('C:/music/second.mp3')
    await wrapper.get('audio').trigger('error')
    expect(wrapper.get('[role="alert"]').text()).toContain('musicPlayer.error')
    const controls = wrapper.findAll('.audio-heading > button')
    expect(controls[1].attributes('aria-label')).toBe('assistant.musicPlayer.loop')
    await controls[1].trigger('click')
    expect(store.loopMode).toBe('single')
    expect(store.handleEnded()).toBe(true)
    store.resume()
    wrapper.unmount()
    expect(store.isPlaying).toBe(true)
    store.stop()
  })
})
