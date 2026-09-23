import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./useReadAloud', () => ({ stopReadAloud: vi.fn() }))

/**
 * 「正在通话」这一位在窗口之间的同步。
 *
 * 通话开在主窗口，而小窗是另一个渲染进程：这个模块在那边是另一份，原来永远是
 * 「没在通话」—— 通话期间小窗照样自动朗读，念进主窗口正开着的麦克风。
 */
describe('voiceCallState 跨窗口', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('主窗口通话状态一变就报给主进程，没变不重复报', async () => {
    const setCallActive = vi.fn()
    vi.stubGlobal('window', { api: { realtimeVoice: { setCallActive } } })
    const { setVoiceCallActive } = await import('./voiceCallState')

    setVoiceCallActive(true)
    setVoiceCallActive(true)
    setVoiceCallActive(false)

    expect(setCallActive.mock.calls).toEqual([[true], [false]])
  })

  it('小窗跟着别的窗口报来的状态走，取消订阅后不再跟', async () => {
    let push: (active: boolean) => void = () => {}
    const unsubscribe = vi.fn()
    vi.stubGlobal('window', {
      api: {
        realtimeVoice: {
          onCallActive: (handler: (active: boolean) => void) => {
            push = handler
            return unsubscribe
          }
        }
      }
    })
    const { followVoiceCallFromOtherWindows, voiceCallActive } = await import('./voiceCallState')

    const stop = followVoiceCallFromOtherWindows()
    push(true)
    expect(voiceCallActive.value).toBe(true)
    push(false)
    expect(voiceCallActive.value).toBe(false)

    stop()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
