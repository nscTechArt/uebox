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

/**
 * **别的窗口**在通话（主进程按窗口算好了发过来，见主进程 `voiceCallPresence.ts`）。
 *
 * 和自己这份分开存：以前是一个布尔值两头写，独立对话窗口把通话接过去的那一刻，
 * 主窗口随后报的「我挂了」会把接手那边也一起写成「没在通话」。
 */
const inCallElsewhere = ref(false)

export const voiceCallActive: ComputedRef<boolean> = computed(
  () => inCall.value || inCallElsewhere.value
)

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
  let notified = false
  const stop = voiceCallAPI.onChange((active) => {
    notified = true
    inCallElsewhere.value = active
  })
  // 在场状态只在变化时广播：这个窗口是在通话中途打开的就收不到，先问一次。
  // 问的路上已经来过通知的话，以通知为准
  void voiceCallAPI.activeElsewhere().then((active) => {
    if (!notified) inCallElsewhere.value = active
  })
  return stop
}

/*
 * 接通的那一刻把正在念的掐掉。
 *
 * 用户点了朗读、还没念完就开口打电话，那半句会一路念进刚打开的麦克风里。
 */
watch(voiceCallActive, (active) => {
  if (active) stopReadAloud()
})

/*
 * 按热键开始听写时同理：正在念的那条会从音箱出来、被麦克风收进去，
 * 转写成指令的一部分。主进程在开麦那一下广播，每个会朗读的窗口在这里停下。
 */
voiceCallAPI.onDictationStarted(() => stopReadAloud())
