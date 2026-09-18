/**
 * 一条过程时间线条目。
 *
 * `text` 是**模型说给用户听的正文**，和工具调用记在同一根时间线上 ——
 * 界面要按发生顺序把「调工具 → 说一句 → 再调工具 → 再说一句」串起来显示。
 * 正文只有一根累积字符串的话做不到这件事：所有解说会挤到最后变成一大坨，
 * 读的人对不上哪句话在说哪一步。
 *
 * `user-steer` 是**用户在跑的过程中插的那句话**。它也记在这根时间线上，
 * 因为它发生在某两步之间 —— 挂到消息列表末尾的话，它后面 agent 又干了十件事，
 * 那句话却永远浮在最下面，看起来像是「还没被处理」。
 *
 * `question` 是 agent 反问用户的那张选项卡片，同理：它发生在某两步之间，
 * 而且答完之后**要留在原地**。做成弹窗的话，用户回头看不到自己当初选了什么，
 * 而那恰恰是他后来想确认「为什么做成这样」时唯一的凭据。
 */
export interface AgentProcessItem {
  type:
    | 'step'
    | 'tool-call'
    | 'tool-result'
    | 'step-finish'
    | 'notify-users'
    | 'text'
    | 'user-steer'
    | 'question'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  timestamp: number
}
