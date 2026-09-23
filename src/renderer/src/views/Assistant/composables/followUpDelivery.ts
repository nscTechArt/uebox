/**
 * 排着的跟进消息由**谁**发出去。
 *
 * ## 为什么不能是助手页
 *
 * 原来这段逻辑长在 `Welcome.vue` 里：页面监听 `agent-v3:released`，自己判断
 * 「这条对话空出来了」，自己把队首那条发出去。而助手路由没开 `meta.keepAlive` ——
 * 用户切去看素材库那一刻，整棵组件树连同监听器一起没了。这一轮照样在主进程里跑，
 * 跑完的那条 `released` 也照样发出来，**只是没人接**。用户回来时看到的是：
 * agent 早跑完了，自己排的那句话还挂在那儿，谁也没动它。
 *
 * 页面只该是个显示器。「什么时候该发下一条」是这条对话自己的事，跟用户此刻
 * 正看着哪个页面无关，所以它属于应用级：`main.ts` 起来就在，一直到应用关掉。
 *
 * ## 谁来跑那一轮
 *
 * `appAgentRunner` —— 同样挂在常驻布局上的应用级运行器，语音派活也用它。
 * 为什么它不能是页面级的，写在那个文件的头部。
 *
 * ## 刷新之后
 *
 * 队列会落盘（`store/modules/followUpQueue.ts`），刷新页面或重开应用都还在。
 * agent 跑在主进程，刷新时那一轮多半还在跑，`agentReattach` 把界面接回去，
 * 队列这边由下面那次「起来先试投一次」接上：还在跑就等 `released`，已经跑完
 * 就当场发出去。
 */

import { watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

import type { EditorSnapshot } from '@core/shared/editorSnapshot'

import { useAgentStreamStore } from '@renderer/store/modules/agentStream'
import { useFollowUpQueueStore } from '@renderer/store/modules/followUpQueue'
import { useChatMessagesStore, type ChatMessageContent } from '@renderer/store/modules/chatMessages'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useTabsStore } from '@renderer/store/modules/tabs'

import { appExecuteAgent } from './appAgentRunner'
import { buildMultimodalContent, ensureSessionWithTitle } from './chatSendPrimitives'
import { dequeueFollowUp, listFollowUps } from './followUpQueue'
import { bubbleAttachments, type ChatMediaFile } from './turnAttachments'

/**
 * 排着的一条要发出去时，需要的全部东西。
 *
 * 和输入框那边的发送参数是同一份（队列原样存着不解释），这里只取投递用得上的
 * 几个字段 —— 生图模式、语音那些分支不会排队进来。
 */
export interface FollowUpPayload {
  content: string
  images?: string[]
  forcedSources?: Array<{ id: string; title: string; type: string }>
  excelContext?: string
  excelFiles?: Array<{ fileName: string; rowCount?: number }>
  docFiles?: Array<{ fileName: string; kind?: 'document' | 'video' | 'audio' }>
  /** 随消息带过去的音视频路径，agent 自己决定怎么看 */
  mediaFiles?: ChatMediaFile[]
  /**
   * 入队那一刻抓好的编辑器快照（闪存）。
   *
   * **投递时不重抓。** 用户是在框选着 A 段的时候说的那句话，哪怕这条消息在队列里
   * 等了十分钟、他早就改选了 B 段 —— 模型该看到的仍是 A 段。这就是闪存的全部意义。
   */
  editorSnapshot?: EditorSnapshot | null
  /** 快照来自哪个工程。这条消息就钉在它上面，等待期间别的工程连上也不改 */
  sessionProject?: { projectName: string; projectPath?: string; engineVersion?: string } | null
}

/**
 * 「只看这几份来源」。和 `useChatFlow` 里那份同义：检索工具搜的是整个知识库，
 * 不认范围限定，所以把它说在话里让模型自己筛。
 */
function withSourceScope(
  content: ChatMessageContent,
  sources: Array<{ title: string }>
): ChatMessageContent {
  if (sources.length === 0) return content
  const scope = `\n\n（这个问题只看这几份来源：${sources.map((s) => s.title).join('、')}）`
  if (typeof content === 'string') return content + scope
  return content.map((item, index) =>
    index === 0 && item.type === 'text' ? { ...item, text: (item.text || '') + scope } : item
  )
}

/**
 * 装在常驻布局里，整个应用一份。
 *
 * 放在 setup 里而不是模块顶层：`useAgentMode` 内部要 `useI18n()` 和生命周期钩子，
 * 那些只有在组件上下文里才立得住。常驻布局的寿命就是应用的寿命，效果一样。
 */
export function useFollowUpDelivery(): void {
  const { t } = useI18n()
  const route = useRoute()
  const queueStore = useFollowUpQueueStore()
  const streamStore = useAgentStreamStore()
  const chatStore = useChatSessionsStore()
  const chatMsgStore = useChatMessagesStore()
  const tabsStore = useTabsStore()

  /**
   * 把某条对话队首那条发出去 —— 前提是它此刻确实空着。
   *
   * 一次只发一条：第二条要等这一条也跑完，下一次 `released` 会来接它。
   */
  function deliverNext(chatSid: string): void {
    if (!chatSid) return
    /*
     * 判「忙」不能只看流式状态。
     *
     * `done` 一到界面就把 `isStreaming` 清了，而主进程还要跑完 `finally` 里的
     * release 才真正空出来。这个间隙里发出去会被顶回来一句「会话正在执行中」——
     * 而下面是**先出队再发**的，被顶回来的那条话就没了，用户什么都不会看到。
     */
    if (streamStore.isBusy(chatSid)) return
    if (listFollowUps(queueStore.queues, chatSid).length === 0) return

    const { queues, item } = dequeueFollowUp(queueStore.queues, chatSid)
    if (!item) return
    queueStore.queues = queues

    const payload = item.payload as FollowUpPayload
    const text = String(payload.content || '').trim()
    const images = payload.images || []
    const sources = payload.forcedSources || []

    const content = buildMultimodalContent(text, images)
    const displayText = text || item.text

    chatMsgStore.pushUser(
      chatSid,
      content,
      sources.length > 0 ? sources : undefined,
      bubbleAttachments(payload.excelFiles, payload.docFiles)
    )
    ensureSessionWithTitle(chatSid, displayText, {
      chatStore,
      tabsStore,
      route,
      unnamedTitle: t('assistant.chatFlow.unnamedSession')
    })
    void appExecuteAgent(withSourceScope(content, sources), payload.excelContext, {
      chatSid,
      // 原样透传，**不重抓**：负载里有这个键就说明入队那一刻已经定过了
      ...('editorSnapshot' in payload ? { editorSnapshot: payload.editorSnapshot } : {}),
      ...(payload.sessionProject ? { sessionProject: payload.sessionProject } : {}),
      ...(payload.mediaFiles?.length ? { mediaFiles: payload.mediaFiles } : {})
    })
  }

  /**
   * 主进程说有会话空出来了。
   *
   * 不看它带的 sessionId：那是 agent 会话号，而队列按对话（chatSid）分桶，两者的
   * 映射在流式状态清理时就没了 —— 收到这条时往往已经查不到。所以把**所有**排着
   * 队的对话过一遍，各自判「我这条在不在跑」，谁空了谁发。
   */
  function handleReleased(...args: unknown[]): void {
    const payload = args[0] as { sessionId?: string } | undefined
    /*
     * 先摘「等释放」标记，再投递。两件事必须在同一个处理器里按这个顺序做 ——
     * 拆成两个监听器的话，谁先跑取决于注册顺序，而那个顺序没人保证：
     * 先投递的那一版会看到自己还「忙」，于是什么都不发，然后再也没人来接。
     */
    if (payload?.sessionId) streamStore.clearAwaitingRelease(payload.sessionId)
    for (const chatSid of Object.keys(queueStore.queues)) deliverNext(chatSid)
  }

  window.api.on('agent-v3:released', handleReleased)

  /*
   * 队列里多了东西也试一次。
   *
   * 主路径是 `released` 触发投递，但有一个真实的空档：用户按发送时那一轮还在跑，
   * 于是走排队；而排队之前要先 `await` 一次闪存抓取（最多 2 秒）——
   * 这两秒里那一轮跑完了，`released` 已经发过了，它看到的是一个空队列。
   * 消息随后才入队，就再也没人来接它了。
   *
   * `deliverNext` 自己判忙，所以还在跑的时候这里什么都不会做。
   */
  watch(
    () => queueStore.queues,
    (queues) => {
      for (const chatSid of Object.keys(queues)) deliverNext(chatSid)
    },
    { deep: true }
  )

  /*
   * 起来时先对已经排着的对话试投一次。
   *
   * 队列现在会落盘（见 store 里的注释），所以刷新页面 / 重开应用之后它还在。
   * 上面那个 watch 只在**变化**时触发，恢复出来的这一批不会让它响；`released`
   * 也早就发过了。少了这一步，用户排的话会一直挂着没人动 —— 正是持久化要解决的
   * 那个症状，只是从「刷新就没了」变成「刷新之后永远发不出去」。
   *
   * `deliverNext` 自己判忙：那一轮还在跑就什么都不做，等 `released` 来接。
   */
  for (const chatSid of Object.keys(queueStore.queues)) deliverNext(chatSid)

  /*
   * 不注销这个监听器。
   *
   * 它挂在常驻布局上，活到应用关闭为止 —— 而「排着的话要发出去」这件事没有
   * 提前结束的时候。加个 onUnmounted 反而会在热更新之外的路径上悄悄把投递关掉。
   */
}
