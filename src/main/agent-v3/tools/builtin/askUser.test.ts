import { beforeEach, describe, expect, it, vi } from 'vitest'

const pending = new Set<string>()

vi.mock('../../host/questionChannel', () => ({
  hasPendingQuestion: (sessionId: string) => pending.has(sessionId)
}))

import { createAskUserTool, formatAnswers, MAX_ASKS_PER_RUN } from './askUser'
import type { AskUserQuestion, QuestionOutcome } from '../../host/questionChannel'

const QUESTIONS = [
  {
    header: '用在哪',
    question: 'TTS 适配器接上之后先给谁用？',
    multiSelect: false,
    options: [
      { label: '补适配层（推荐）', description: '只加能力位，不改现有行为' },
      { label: '顺带改音频概览', description: '改动面更大' }
    ]
  }
]

function run(
  outcome: QuestionOutcome | ((n: number) => QuestionOutcome),
  args: unknown = { questions: QUESTIONS }
): {
  execute: (id?: string) => Promise<{ text: string; isError: boolean; terminate?: boolean }>
  calls: () => number
} {
  let calls = 0
  const tool = createAskUserTool({
    sessionId: 'session-1',
    request: async () => {
      calls += 1
      return typeof outcome === 'function' ? outcome(calls) : outcome
    }
  })

  return {
    calls: () => calls,
    execute: async (id = 'call-1') => {
      try {
        const result = await tool.execute(id, args, undefined, undefined)
        const text = result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n')
        return { text, isError: false, terminate: result.terminate }
      } catch (error) {
        // defineTool 把 isError 转成异常交给 pi —— 失败路径只能这样观测
        return { text: (error as Error).message, isError: true }
      }
    }
  }
}

beforeEach(() => {
  pending.clear()
})

describe('formatAnswers', () => {
  /**
   * 逐问带 header。一次问三问、回来一个没有标签的列表，模型会把顺序记串 ——
   * 它看到的只是三个字符串，凭什么知道第二个回的是哪一问。
   */
  it('每行带上 header', () => {
    expect(formatAnswers(QUESTIONS as AskUserQuestion[], ['补适配层'])).toBe(
      ['用户的回答：', '- [用在哪] 补适配层'].join('\n')
    )
  })

  it('没选的那一问明说跳过，而不是留空', () => {
    expect(formatAnswers(QUESTIONS as AskUserQuestion[], [''])).toContain('（用户跳过了这一问）')
  })

  it('答案条数不够时按跳过处理，不越界', () => {
    expect(formatAnswers(QUESTIONS as AskUserQuestion[], [])).toContain('（用户跳过了这一问）')
  })
})

describe('ask_user', () => {
  it('accept 时把用户的选择喂回模型', async () => {
    const { execute } = run({ action: 'accept', answers: ['补适配层（推荐）'] })
    const result = await execute()

    expect(result.isError).toBe(false)
    expect(result.text).toContain('- [用在哪] 补适配层（推荐）')
  })

  /** 「你自己定」要让它带着假设继续，并且**说出来**假设是什么 */
  it('decline 时让模型继续，但要求它写明假设', async () => {
    const { execute } = run({ action: 'decline' })
    const result = await execute()

    expect(result.isError).toBe(false)
    expect(result.text).toContain('写出你替他做了哪些假设')
    expect(result.terminate).toBeUndefined()
  })

  /**
   * cancel 要让它**停下来**。
   *
   * 这是 decline / cancel 必须分开的全部理由：用户按了停止，agent 反而收到
   * 一句「你自己定」然后继续埋头干活，正是这个功能想避免的事。
   */
  it('cancel 时让模型停下来（terminate）', async () => {
    const { execute } = run({ action: 'cancel' })
    const result = await execute()

    expect(result.isError).toBe(false)
    expect(result.terminate).toBe(true)
    expect(result.text).toContain('停下来等用户')
  })

  /**
   * 用户关掉一张卡片之后，同一轮里不该再被追着问第二遍。
   *
   * 直接按取消返回，而且**不弹窗** —— 报 isError 会让模型以为工具坏了然后重试。
   */
  it('用户取消过一次之后，后续提问不再弹窗', async () => {
    const { execute, calls } = run({ action: 'cancel' })

    await execute('call-1')
    const second = await execute('call-2')

    expect(calls()).toBe(1)
    expect(second.isError).toBe(false)
    expect(second.terminate).toBe(true)
  })

  /** Cline 有个未修的 issue 就是模型连发几个提问把状态机打乱 */
  it('已经有问题挂着时直接报错，不再发第二个', async () => {
    pending.add('session-1')
    const { execute, calls } = run({ action: 'accept', answers: ['x'] })

    const result = await execute()

    expect(result.isError).toBe(true)
    expect(result.text).toContain('不能同时问第二个')
    expect(calls()).toBe(0)
  })

  /** 问够 3 轮就断供，逼它自己拿主意 —— 这是防「反复打断用户」的最后一道闸 */
  it(`一次运行最多问 ${MAX_ASKS_PER_RUN} 轮`, async () => {
    const { execute, calls } = run({ action: 'accept', answers: ['x'] })

    for (let i = 0; i < MAX_ASKS_PER_RUN; i++) {
      expect((await execute(`call-${i}`)).isError).toBe(false)
    }

    const extra = await execute('call-overflow')
    expect(extra.isError).toBe(true)
    expect(extra.text).toContain('写明你的假设')
    expect(calls()).toBe(MAX_ASKS_PER_RUN)
  })

  /** 选项少于 2 个就不是「让用户选」，而是变相的是非题 */
  it('选项少于 2 个时 schema 直接拒', async () => {
    const { execute } = run(
      { action: 'accept', answers: ['x'] },
      {
        questions: [{ ...QUESTIONS[0], options: [{ label: '唯一', description: '没得选' }] }]
      }
    )

    expect((await execute()).isError).toBe(true)
  })

  it('一次最多 3 问，超了 schema 直接拒', async () => {
    const { execute } = run(
      { action: 'accept', answers: [] },
      { questions: [QUESTIONS[0], QUESTIONS[0], QUESTIONS[0], QUESTIONS[0]] }
    )

    expect((await execute()).isError).toBe(true)
  })

  /** 只是问一句，什么都不改 —— 走审批门会变成「为了弹问题先弹一个确认框」 */
  it('风险等级是 safe，不进审批门', () => {
    const tool = createAskUserTool({
      sessionId: 'session-1',
      request: async () => ({ action: 'decline' })
    })

    expect(tool.unrealBox.risk).toBe('safe')
    expect(tool.name).toBe('ask_user')
  })
})
