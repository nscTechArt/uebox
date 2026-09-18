/**
 * Agent 反问用户时，主进程和渲染层之间流转的那份数据。
 *
 * 放 `shared/` 是因为**三边**都要认它：工具（`main/agent-v3/tools/builtin/askUser.ts`）
 * 造它、IPC 通道（`main/agent-v3/host/questionChannel.ts`）发它、界面卡片
 * （`renderer/.../AskUserCard.vue`）画它。抄三份的话，哪天多一个字段就会漏掉一处，
 * 而漏掉的那一处表现是「卡片上少了一个选项」——没有报错，只是用户少了个出路。
 */

export interface AgentQuestionOption {
  /** 选项标题，1~5 个词 */
  label: string
  /** 选了会发生什么、代价是什么 */
  description: string
}

export interface AgentQuestion {
  /** 卡片上的短标签，不超过 12 个字符 */
  header: string
  question: string
  multiSelect: boolean
  options: AgentQuestionOption[]
}

/**
 * 用户对一次提问的处置。
 *
 * 三态而不是两态，照 MCP elicitation 规范的分法。`decline` 和 `cancel` 必须分开：
 * 前者是「我懒得选，你自己定」，后者是「这事先停一停」。合成一个的话，
 * 用户按了停止，agent 反而收到一句「你自己定」然后继续埋头干活。
 */
export type AgentQuestionAction = 'accept' | 'decline' | 'cancel'

/** 时间线上那张卡片的完整状态 */
export interface AgentQuestionItem {
  toolCallId: string
  questions: AgentQuestion[]
  /**
   * 这张卡片属于哪条 agent 会话。**只有渲染层填**。
   *
   * 卡片渲染自消息里的 `agentProcess`，那份数据不带会话上下文 —— 用户点了
   * 「提交」时手上必须有 sessionId 才能把答案送回去。存进条目里而不是靠组件
   * 层层往下传 props：这张卡片嵌在时间线的第三层，中间每一层都得为它加一个
   * 用不上的参数。
   */
  sessionId?: string
  /** 还没答时为 undefined —— 卡片据此决定是可点的还是只读的 */
  action?: AgentQuestionAction
  /** 与 `questions` 同序，空串表示这一问没选 */
  answers?: string[]
}
