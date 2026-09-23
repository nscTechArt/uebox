import { computed, ref, watch, type ComputedRef } from 'vue'
import { voiceCallAPI } from '@renderer/api/voiceCall'
import { stopReadAloud } from './useReadAloud'

/**
 * 正在通话中（连接中也算）。**通话期间一律不自动朗读。**
 *
 * 不是「语音自己念过的那几条别再念」那么客气 —— 麦克风开着的时候，
 * 从音箱里出来的 TTS 会被当成用户说话收进去，而且和语音助手自己的声音叠在一起。
 * 所以只要在通话里，任何一条回复落定都不许自动朗读，哪怕它是用户在别的对话里
 * 打字问出来的。
 *
 * 单独一个模块而不是塞进 `voiceAssistant.ts`：气泡只要问一个布尔值，不该为此
 * 把整路语音（IPC、store、派活）拖进每一条消息的依赖里。
 */
const inCall = ref(false)

export const voiceCallActive: ComputedRef<boolean> = computed(() => inCall.value)

/**
 * 由 `voiceAssistant` 跟着那一路语音的状态推过来（主窗口）。
 * 顺手报给主进程，由它转给别的窗口 —— 见 `followVoiceCallFromOtherWindows`
 */
export function setVoiceCallActive(active: boolean): void {
  if (inCall.value === active) return
  inCall.value = active
  voiceCallAPI.announce(active)
}

/**
 * 不开通话的窗口（小窗）调一次：跟着主窗口的通话状态走。
 *
 * 小窗是另一个渲染进程，这个模块在那边是另一份，`inCall` 永远是 false ——
 * 通话期间照样自动朗读，念进主窗口正开着的麦克风。返回取消订阅函数。
 */
export function followVoiceCallFromOtherWindows(): () => void {
  return voiceCallAPI.onChange((active) => {
    inCall.value = active
  })
}

/*
 * 接通的那一刻把正在念的掐掉。
 *
 * 用户点了朗读、还没念完就开口打电话，那半句会一路念进刚打开的麦克风里。
 */
watch(inCall, (active) => {
  if (active) stopReadAloud()
})

/*
 * 按热键开始听写时同理：正在念的那条会从音箱出来、被麦克风收进去，
 * 转写成指令的一部分。主进程在开麦那一下广播，每个会朗读的窗口在这里停下。
 */
voiceCallAPI.onDictationStarted(() => stopReadAloud())
