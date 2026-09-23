/**
 * 「语音通话接通 / 挂断」在窗口之间的同步。
 *
 * 这一位只在主窗口的渲染进程里知道（通话开在那边），而小窗是另一个渲染进程 ——
 * 它自己那份永远是「没在通话」，会在通话期间把回复念进正开着的麦克风。
 * 主窗口报上去，主进程转给每个窗口。
 *
 * 两个都是即发即忘的通知，没有要解包的结果，所以不走 `unwrapResult`。
 */
/** 模块加载时就会订阅，而单测可能跑在没有 window 的环境里 */
const bridge = (): Window['api']['realtimeVoice'] | undefined =>
  typeof window === 'undefined' ? undefined : window.api?.realtimeVoice

export const voiceCallAPI = {
  /** 主窗口：通话状态变了 */
  announce(active: boolean): void {
    bridge()?.setCallActive?.(active)
  },
  /** 其他窗口：跟着主窗口的通话状态走。返回取消订阅函数 */
  onChange(handler: (active: boolean) => void): () => void {
    return bridge()?.onCallActive?.(handler) ?? (() => {})
  },
  /** Spotlight 开始听写了。返回取消订阅函数 */
  onDictationStarted(handler: () => void): () => void {
    return bridge()?.onDictationStarted?.(handler) ?? (() => {})
  }
}
