/**
 * 回声门限档位：厂商的服务端判停有多容易被「我们自己的声音」触发。
 *
 * ## 为什么需要它
 *
 * 渲染层已经有一整套回声消除（采集开 `echoCancellation`，播放绕一条本地
 * `RTCPeerConnection` 回环给 Chromium 的 AEC 当参考，见 `useRealtimeVoice` 的
 * `createAecLoopback`）。但 AEC 只能把回声**压低**，压不到零 —— 音箱离麦克风近、
 * 音量大的桌面上，非线性失真那部分是消不掉的。
 *
 * 残留本身不吵，问题在于它照样会把服务端 VAD 顶过门限：OpenAI 那家默认门限 0.5
 * 很敏感，一被顶过就当「用户开口了」，接着转写把残留转成文字 ——
 * 真机上的表现是对话里**凭空多出用户没说过的话**（多半是模型自己上一句的尾巴），
 * 模型于是开始回应自己。豆包那家服务端自带一层处理，所以只有 OpenAI 这条线犯。
 *
 * ## 为什么是三档而不是一个数
 *
 * 门限是个 0~1 的浮点数，但用户手里没有能读出这个数的仪表 —— 他知道的是
 * 「我戴着耳机」还是「音箱就在麦克风旁边」。三档把设备摆位翻译成参数，
 * 具体的数值钉在各家适配器里（OpenAI 的见 `OPENAI_ECHO_GUARD_TUNING`）。
 */

export const REALTIME_ECHO_GUARDS = ['headset', 'speaker', 'strong'] as const

export type RealtimeEchoGuard = (typeof REALTIME_ECHO_GUARDS)[number]

/**
 * 默认按「外放」算。
 *
 * 桌面端绝大多数是外放，而两类错的代价不对称：门限偏高时用户至多要多说半个字
 * 才被听见，门限偏低时模型会开始跟自己对话 —— 后者把整通电话毁掉。
 */
export const DEFAULT_REALTIME_ECHO_GUARD: RealtimeEchoGuard = 'speaker'

/** 跨 IPC 来的值不可信（旧版本存的、被手改过的配置）。认不出就回默认档 */
export function normalizeRealtimeEchoGuard(value: unknown): RealtimeEchoGuard {
  return REALTIME_ECHO_GUARDS.includes(value as RealtimeEchoGuard)
    ? (value as RealtimeEchoGuard)
    : DEFAULT_REALTIME_ECHO_GUARD
}
