import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useMicrophoneDevices } from './useMicrophoneDevices'

afterEach(() => vi.unstubAllGlobals())

it('loads input devices, releases permission stream and removes its listener', async () => {
  const stop = vi.fn()
  const media = {
    enumerateDevices: vi.fn().mockResolvedValue([]),
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }
  vi.stubGlobal('navigator', { mediaDevices: media })
  let picker!: ReturnType<typeof useMicrophoneDevices>
  const wrapper = mount(
    defineComponent({
      setup() {
        picker = useMicrophoneDevices()
        return () => null
      }
    })
  )
  await flushPromises()
  expect(media.getUserMedia).not.toHaveBeenCalled()
  media.enumerateDevices.mockResolvedValueOnce([]).mockResolvedValue([
    { kind: 'audioinput', deviceId: 'default', label: 'Default' },
    { kind: 'audiooutput', deviceId: 'speaker', label: 'Speaker' },
    { kind: 'audioinput', deviceId: 'usb', label: 'USB microphone' }
  ])
  await picker.refresh(true)
  expect(picker.devices.value.map((device) => device.deviceId)).toEqual(['usb'])
  expect(stop).toHaveBeenCalledOnce()
  media.enumerateDevices.mockRejectedValueOnce(new Error('denied'))
  await picker.refresh(true)
  expect(picker.failed.value).toBe(true)
  wrapper.unmount()
  expect(media.removeEventListener).toHaveBeenCalledWith(
    'devicechange',
    media.addEventListener.mock.calls[0][1]
  )
})
