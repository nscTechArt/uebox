import type { AgentReviewFinding } from '@core/shared/agentReview'

import type { ChatMessageContent } from '@renderer/store/modules/chatMessages'

/**
 * 让它自证 —— 审查的第二条腿。
 *
 * ## 机器查不了的那一半
 *
 * `reviewChanges` 问的是引擎：资产在不在、落盘没有、编译过不过、引用断没断。
 * 这些是**事实**，机器答得比谁都准。但它答不了另一个问题，而那个问题才是
 * 用户真正在问的：**这是不是我要的东西**。
 *
 * 「材质存在、编译通过、引用完整」和「这材质是我要的呼吸发光效果」之间没有
 * 任何关系。前者绿灯的东西，完全可能是个纯黑的球。
 *
 * ## 为什么自证不等于让它自夸
 *
 * 直接问「你做好了吗」，得到的永远是「做好了」—— 模型审的是自己的记忆，
 * 而它记得的是「我调用成功了」。所以这里的 prompt 有三条硬约束：
 *
 * 1. **不许凭记忆**：每一条都要用只读工具重新去引擎里查，把查到的实际值写出来；
 * 2. **带着机器的结论去对质**：机器查出的问题逐条回应，说是真的还是误报、依据是什么；
 * 3. **不许顺手改**：这一轮只说明。发现问题让用户决定改不改 —— 自证顺手把
 *    证据改掉，用户就永远看不到刚才那个状态了。
 *
 * 文案走 i18n 而不是写死中文：它是发给模型的，但英文界面的用户读到的是自己的
 * 那句话被翻译成中文发出去 —— 那看起来像 bug。
 */

/** 气泡操作按钮里的动作名，AIBubble 发、Welcome 收 */
export const SELF_CHECK_ACTION = 'review-self-check'

/** i18n 的 `t`，注入进来是为了这个模块能纯函数地测 */
type Translate = (key: string, params?: Record<string, unknown>) => string

export interface SelfCheckInput {
  /** 机器查出来的问题，空数组表示没查出问题 */
  findings: AgentReviewFinding[]
  /** 查了几个资产 */
  checked: number
  /** 引擎那一半跑了没有。没跑的话不能拿「没查出问题」当结论 */
  engineChecked: boolean
  /** 用户最初的那句要求。取不到就空串 */
  request: string
}

/** 一条 finding 写成一行给模型看的话 */
function describeFinding(finding: AgentReviewFinding, t: Translate): string {
  const text = t(`assistant.review.codes.${finding.code}`, { detail: finding.detail ?? '' })
  return `- ${finding.target}：${text}`
}

/**
 * 拼出自证请求。
 *
 * 这条会作为一句**普通用户消息**发进当前会话 —— 用户看得见自己"说"了什么，
 * 模型的回答也留在对话里。藏起来偷偷发的话，之后翻这段对话会看到一段
 * 没头没尾的自我检讨。
 */
export function buildSelfCheckPrompt(input: SelfCheckInput, t: Translate): string {
  const parts: string[] = [t('assistant.selfCheck.prompt.intro')]

  if (input.findings.length > 0) {
    parts.push(t('assistant.selfCheck.prompt.foundHeader', { count: input.findings.length }))
    parts.push(input.findings.map((finding) => describeFinding(finding, t)).join('\n'))
  } else if (input.engineChecked) {
    parts.push(t('assistant.selfCheck.prompt.cleanHeader', { count: input.checked }))
  } else {
    // 引擎没连时那半边根本没跑，不能让模型把「机器没说话」读成「机器说没问题」
    parts.push(t('assistant.selfCheck.prompt.engineOfflineHeader'))
  }

  parts.push(t('assistant.selfCheck.prompt.rules'))

  if (input.request) {
    parts.push(t('assistant.selfCheck.prompt.request', { request: input.request }))
  }

  return parts.join('\n\n')
}

interface MessageLike {
  id: string
  role: string
  content: ChatMessageContent
}

/** 多模态内容里把文字抠出来 */
function textOf(content: ChatMessageContent): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((item): item is { type: 'text'; text: string } => item?.type === 'text' && !!item.text)
    .map((item) => item.text)
    .join('\n')
    .trim()
}

/**
 * 这条回复是在回应哪句话。
 *
 * 往前找最近的一条用户消息 —— 自证要对照的是**用户当时要的东西**，
 * 不是整段对话。找不到就返回空串，prompt 里那一段随之省掉：
 * 编一个「你最初的要求是」比不写更糟。
 */
export function findRequestBefore(messages: MessageLike[], assistantId: string): string {
  const index = messages.findIndex((message) => message.id === assistantId)
  if (index < 0) return ''

  for (let i = index - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue
    const text = textOf(messages[i].content)
    if (text) return text
  }

  return ''
}
