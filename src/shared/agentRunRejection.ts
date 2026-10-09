/**
 * 主进程按码拒绝一次 Agent 请求时回的 `code`。渲染层拿它去语言包查文案，
 * `error` 原文只留给日志 —— 原文里带 `session <uuid>` 这类诊断信息，码对不上时
 * 渲染层会退回显示它。主进程回码处和渲染层的文案表都按这里的类型约束，
 * 两边写法不一致时类型检查报错。对应表在
 * `src/renderer/src/views/Assistant/composables/agentControlHandlers.ts`。
 */

/** `agent-v3:execute` / `agent-v3:continue`：这条对话还有一轮在跑 */
export type AgentStartRejectionCode = 'SESSION_BUSY'

/** `agent-v3:steer`：这一轮已经结束 / 插话抓的工程和正在跑的这一轮对不上 */
export type SteerRejectionCode = 'NOT_RUNNING' | 'PROJECT_MISMATCH'

/**
 * `agent-v3:steer` 按码被拒时随码带回的参数（目前只有 PROJECT_MISMATCH 用）。
 * 工程名是原值、可能为空串 —— 「另一个工程」的措辞归渲染层。
 */
export interface SteerRejectionErrorParams {
  snapshotProject: string
  runProject: string
}
