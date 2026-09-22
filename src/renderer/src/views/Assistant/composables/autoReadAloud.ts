/**
 * 「回复落定了就念出来」由**谁**来接。
 *
 * ## 为什么不能是气泡
 *
 * 这段逻辑原来长在 `AIBubble.vue` 里：气泡自己盯着 `status`，看见 typing → done
 * 就开念。而助手路由没开 `meta.keepAlive` —— 用户切去看素材库那一刻，整棵组件树
 * 连同这个监听器一起没了。活照样在主进程里跑完，回复照样写进 store，**只是没人念**。
 * 而长活恰恰是用户最会切走的那一种：他就是因为要等，才去干点别的。
 *
 * 这是仓库里同一个坑的第三次（前两次是 `followUpDelivery` 和 `appAgentRunner`，
 * 那两个文件头部写着同样的话）。页面只该是个显示器：「该不该念」是这条回复自己的
 * 事，跟用户此刻正看着哪个页面无关，所以它属于应用级 —— 常驻布局装一次，活到
 * 应用关掉。
 *
 * ## 只念最终答复那一段
 *
 * 过程里的解说不念，理由写在 `finalReplyText` 上。
 *
 * ## 盯的是哪个信号
 *
 * 每条对话**最后一条**回复的 `id + status`。只读这三个字段，流式过程中每来一段
 * 增量都不会惊动它（`content` 没被读，就不在依赖里），所以这个 watch 在长活跑着的
 * 时候是安静的，只有状态真的翻成 done 才响一次。
 */

import { ref, watch } from 'vue'

import type { SpeechBriefingStyle } from '@core/shared/speechBriefing'
import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import { useChatMessagesStore, type ChatMessage } from '@renderer/store/modules/chatMessages'

import { AGENT_RESUME_ACTION } from './agentHandlerShared'
import { finalReplyText } from './finalReplyText'
import { useReadAloud } from './useReadAloud'
import { voiceCallActive } from './voiceCallState'

/** 一条对话此刻的「最后一条回复是谁、到哪一步了」 */
interface LastReply {
  chatSid: string
  messageId: string
  status: string
}

function lastReplies(messages: Record<string, ChatMessage[]>): LastReply[] {
  const rows: LastReply[] = []
  for (const [chatSid, list] of Object.entries(messages)) {
    const last = list[list.length - 1]
    if (last?.role !== 'assistant') continue
    rows.push({ chatSid, messageId: last.id, status: last.status ?? 'done' })
  }
  return rows
}

/**
 * 装在常驻布局里，整个应用一份。
 *
 * 放在 setup 里而不是模块顶层：`useReadAloud` 内部要 `useI18n()`，那只有在组件
 * 上下文里才立得住。常驻布局的寿命就是应用的寿命，效果一样。
 *
 * `enabled` 是「自动朗读开关此刻开着没有」。默认读本窗口的设置 store；小窗是另一个
 * 渲染进程，它的 store 只在启动时从 localStorage 抄过一次，主窗口后来拨的开关它
 * 看不见，所以小窗自己盯着 storage 事件、把新鲜值从这儿递进来（见 `miniVoiceAutoPlay`）。
 * `briefingStyle` 同理，是播报风格此刻的值。
 */
export function useAutoReadAloud(
  enabled?: () => boolean,
  briefingStyle?: () => SpeechBriefingStyle
): void {
  const chatMsgStore = useChatMessagesStore()
  const aiConfigStore = useAIConfigStore()
  const autoPlayEnabled = enabled ?? ((): boolean => aiConfigStore.voiceAutoPlayEnabled)

  /*
   * 念的时候把「主人」记成那条消息的 id，和气泡里手动朗读用的是同一个号 ——
   * 于是那条气泡上的朗读按钮会正确显示成「停止」，用户点一下就能掐掉。
   *
   * 必须是 ref，不能是个普通变量：`useReadAloud` 把这个取值函数裹进了 computed，
   * 而没有响应式依赖的 computed 算一次就永远缓存着 —— 那样第二条回复开念时，
   * 「停止」还挂在第一条的气泡上。气泡那边传的是 `props.id`，本来就是响应式的。
   */
  const owner = ref('')
  const readAloud = useReadAloud(() => owner.value, briefingStyle)

  function read(chatSid: string, messageId: string): void {
    if (!autoPlayEnabled()) return
    // 通话期间一律不念，理由见 `voiceCallState`
    if (voiceCallActive.value) return

    const target = chatMsgStore.getMessages(chatSid).find((item) => item.id === messageId)
    if (!target || target.status !== 'done') return
    // 报错和中途停下的那一轮不念：念出来的会是一句错误提示，或者半截话
    if (target.outcome) return
    if (target.actionButtons?.some((button) => button.action === AGENT_RESUME_ACTION)) return

    const text = finalReplyText(
      chatMsgStore.extractTextFromContent(target.content),
      target.agentProcess
    )
    if (!text.trim()) return

    owner.value = messageId
    void readAloud.toggle(text)
  }

  watch(
    () => lastReplies(chatMsgStore.messagesBySid),
    (next, previous) => {
      const before = new Map(
        (previous ?? []).map((row) => [`${row.chatSid}/${row.messageId}`, row.status])
      )
      for (const row of next) {
        if (row.status !== 'done') continue
        if (before.get(`${row.chatSid}/${row.messageId}`) !== 'typing') continue
        read(row.chatSid, row.messageId)
      }
    }
  )

  /*
   * 开关关掉就立刻停嘴。用户按下那个开关多半正是因为「它现在正在念」。
   */
  watch(autoPlayEnabled, (on) => {
    if (!on) readAloud.stop()
  })

  /*
   * 不注销这两个监听器 —— 它们挂在常驻布局上，活到应用关闭为止，而「回复落定了
   * 要念出来」这件事没有提前结束的时候。
   */
}
