import { defineStore } from 'pinia'
import { ref } from 'vue'

import {
  EMPTY_QUEUES,
  type FollowUpQueues
} from '@renderer/views/Assistant/composables/followUpQueue'
import { chatHistoryStorage } from '@renderer/utils/chatHistoryStorage'

/**
 * 排着队等下一轮的跟进消息，按 chatSid 分桶。
 *
 * ## 为什么必须是 store 而不是页面里的 ref
 *
 * 它原来是 `Welcome.vue` 里的一个 `ref`，注释里写着「每条对话是一个独立的
 * keep-alive 页面实例，它自己就活得够久」—— 这句话是错的：助手路由**没有**
 * `meta.keepAlive`，切去别的标签页那一刻整棵组件树就卸载了。于是真机上是这样：
 * 用户在跑着的时候排了一句话，去素材库看了一眼再回来，那句话没了 —— 而它本该
 * 在这一轮跑完时自动发出去。他没取消过任何东西，界面也没报错。
 *
 * `pendingApprovals` 那个 store 存在的理由和这里一模一样（同样是助手页卸载
 * 导致状态丢失），两处的判断可以互相印证。
 *
 * ## 为什么只存值、逻辑仍在纯函数里
 *
 * 队列的增删本身没有副作用，值得单独测（漏一条 = 用户的话消失，重一条 =
 * 同件事干两遍，两种都不抛异常，只会在真机上被撞见）。所以运算留在
 * `composables/followUpQueue.ts` 的纯函数里，这里只负责把结果**存活着**。
 *
 * ## payload 为什么是 unknown
 *
 * 里面装的是页面的发送参数（`ComposerSendPayload`），那个类型是从
 * `useChatFlow.handleSend` 的入参推出来的，搬进 store 会把依赖方向倒过来。
 * 队列从来不解释 payload，只是原样存回去，所以这里按 `unknown` 存，
 * 由页面在取出来的那一处收窄。
 */
export const useFollowUpQueueStore = defineStore(
  'follow-up-queue',
  () => {
    const queues = ref<FollowUpQueues<unknown>>(EMPTY_QUEUES)

    return { queues }
  },
  {
    /**
     * 排着的话要落盘。
     *
     * 这里原来写着「不做持久化：排着的话属于这次运行，应用重开后那一轮早就没了」，
     * 前半句的结论不成立 —— **agent 跑在主进程**。用户排完一句话按了 Ctrl+R
     * （或者应用崩了重开），那一轮多半还在跑，`agentReattach` 会把界面接回去，
     * 唯独他排的那句话在渲染进程里跟着页面一起没了。他没取消过任何东西。
     *
     * 就算那一轮真的已经跑完，落盘也仍然是对的：`useFollowUpDelivery` 起来时
     * 会对每条排着队的对话试投一次，此刻不忙就直接发出去 —— 这正是用户当初
     * 排队想要的结果。
     *
     * 存磁盘不存 localStorage：payload 里带着编辑器快照（闪存），几百 KB 起步，
     * 而 localStorage 是给界面偏好用的（AGENTS §5 第 10 条）。
     */
    persist: {
      key: 'follow-up-queue',
      storage: chatHistoryStorage
    }
  }
)
