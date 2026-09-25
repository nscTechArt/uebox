/**
 * `ask_user` 在外部会话里的落点：MCP elicitation。
 *
 * 盒子里 `ask_user` 弹的是时间线上那张卡片；外部会话没有那张卡片，就请客户端
 * （Codex、Claude Code）用它自己的表单问。回来的形状和卡片交回来的一样，
 * `ask_user` 工具本身一个字不用改。
 */

import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js'

import type { AskUserQuestion, QuestionOutcome } from '../../host/questionChannel'

type Elicit = (params: ElicitRequestFormParams, signal?: AbortSignal) => Promise<ElicitResult>
type QuestionRequester = (
  req: { questions: AskUserQuestion[] },
  signal?: AbortSignal
) => Promise<QuestionOutcome>

/**
 * `ask_user` 的提问改走 MCP elicitation。
 *
 * 一问对应表单里的一个字段：单选是字符串枚举，多选是枚举数组。选项说明拼进字段描述 ——
 * elicitation 的枚举只有标题没有说明，丢掉它用户就只看得见 1~5 个词的标签。
 */
export function elicitQuestions(elicit: Elicit): QuestionRequester {
  return async ({ questions }, signal): Promise<QuestionOutcome> => {
    const result = await elicit(toElicitation(questions), signal)
    if (result.action !== 'accept') return { action: result.action }
    return { action: 'accept', answers: fromElicitation(questions, result.content ?? {}) }
  }
}

/** 字段名用下标：header 可能重复，下标不会（同 `QuestionOutcome.answers` 的理由） */
const fieldName = (index: number): string => `q${index + 1}`

export function toElicitation(questions: AskUserQuestion[]): ElicitRequestFormParams {
  const properties: Record<string, unknown> = {}
  questions.forEach((q, index) => {
    const labels = q.options.map((option) => option.label)
    const description = [
      q.question,
      ...q.options.map((option) => `- ${option.label}: ${option.description}`)
    ].join('\n')
    properties[fieldName(index)] = q.multiSelect
      ? { type: 'array', title: q.header, description, items: { type: 'string', enum: labels } }
      : { type: 'string', title: q.header, description, enum: labels }
  })

  return {
    mode: 'form',
    message: questions.length === 1 ? questions[0].question : questions.map((q) => q.question).join('\n'),
    requestedSchema: {
      type: 'object',
      properties: properties as ElicitRequestFormParams['requestedSchema']['properties']
    }
  }
}

/** 回答按提问顺序排好，没答的是空串 —— 和盒子界面那张卡片交回来的形状一样 */
export function fromElicitation(
  questions: AskUserQuestion[],
  content: Record<string, unknown>
): string[] {
  return questions.map((_, index) => {
    const value = content[fieldName(index)]
    if (Array.isArray(value)) return value.map(String).join(', ')
    return typeof value === 'string' ? value : ''
  })
}
