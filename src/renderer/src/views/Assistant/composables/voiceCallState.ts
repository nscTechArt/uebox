import { computed, ref, watch, type ComputedRef } from 'vue'
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

/** 由 `voiceAssistant` 跟着那一路语音的状态推过来 */
export function setVoiceCallActive(active: boolean): void {
  inCall.value = active
}

/*
 * 接通的那一刻把正在念的掐掉。
 *
 * 用户点了朗读、还没念完就开口打电话，那半句会一路念进刚打开的麦克风里。
 */
watch(inCall, (active) => {
  if (active) stopReadAloud()
})
