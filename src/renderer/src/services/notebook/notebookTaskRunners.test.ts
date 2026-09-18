import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamedChatParams } from '@renderer/api/ai'
import {
  NOTEBOOK_TASK_RUNNERS,
  buildContentDigest,
  parseJsonObject,
  type TaskInput,
  type TaskRunContext
} from './notebookTaskRunners'
import { stubSettingsApi } from './testSettingsStub'

const aiMocks = vi.hoisted(() => ({
  chatText: vi.fn()
}))

vi.mock('@renderer/api/ai', () => ({
  aiAPI: { chatText: aiMocks.chatText }
}))

const locale = vi.hoisted(() => ({ value: 'zh-CN' }))
vi.mock('@renderer/i18n', () => ({
  getLocale: () => locale.value,
  // 报错文案走语言包，桩要把 key 原样回出来，断言据此认人
  default: { global: { t: (key: string) => key } }
}))

// 配方跑之前会读一次自定义提示词。不给桩的话每个用例都会打一行「读取失败」的
// warn，真出问题时反而看不见
beforeEach(() => {
  stubSettingsApi()
})

function input(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    sources: [{ id: 's1', title: '光照笔记', content: '关于 Lumen 的记录。' }],
    messages: [],
    options: {},
    ...overrides
  }
}

function context(): TaskRunContext {
  return { signal: new AbortController().signal, report: () => undefined }
}

/** 依次返回给定的几段回答，用于多步配方 */
function respondInOrder(...texts: string[]): void {
  let call = 0
  aiMocks.chatText.mockImplementation(async () => texts[call++] ?? texts[texts.length - 1])
}

describe('buildContentDigest', () => {
  it('带上来源标题与 id —— 面试题要靠 id 标注出处', () => {
    const digest = buildContentDigest(input())
    expect(digest).toContain('光照笔记')
    expect(digest).toContain('来源 id：s1')
    expect(digest).toContain('关于 Lumen 的记录。')
  })

  it('装不下的整条丢掉，而不是塞半条进去', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const digest = buildContentDigest(
      input({
        sources: [
          { id: 'a', title: '超长', content: 'x'.repeat(60000) },
          { id: 'b', title: '第二条', content: '这条还塞得下' }
        ]
      })
    )

    // 超长那条一个字都不进去：半条内容会让模型把残句当成作者写完了
    expect(digest).not.toContain('xxxx')
    // 后面装得下的照样进 —— 不该被前面那条超长的连累
    expect(digest).toContain('这条还塞得下')
    expect(digest.length).toBeLessThanOrEqual(41000)
    // 丢掉哪几条要报出来，不能悄悄丢
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('超长'))
    warn.mockRestore()
  })

  it('对话记录附在来源后面，且不会把正文挤掉', () => {
    const digest = buildContentDigest(
      input({
        messages: [
          { role: 'user', content: 'Lumen 怎么调？' },
          { role: 'assistant', content: '先看 Final Gather。' }
        ]
      })
    )

    expect(digest.indexOf('光照笔记')).toBeLessThan(digest.indexOf('对话记录'))
    expect(digest).toContain('用户：Lumen 怎么调？')
    expect(digest).toContain('助手：先看 Final Gather。')
  })

  /*
    装箱是「装不下的整条丢掉」，所以每条都比预算大时 included 会是空的。
    不拦住的话提示词就成了「以下材料……」后面什么都没有，模型会**凭标题编一整份**
    报告出来，用户完全看不出这份东西跟他的资料没有半点关系 —— 比报错严重得多。
  */
  it('来源一条都装不进去时必须报错，不能送一份空材料给模型', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(() =>
      buildContentDigest(
        input({
          sources: [
            { id: 'a', title: '长文一', content: 'x'.repeat(9000) },
            { id: 'b', title: '长文二', content: 'y'.repeat(9000) }
          ],
          options: { charBudget: 6554 }
        })
      )
    ).toThrow(/notebook\.studio\.sourcesOverBudget/)

    warn.mockRestore()
  })

  /*
    来源全超预算、但有对话记录时**不能**硬失败：那段对话本身就是能用的材料。
    上一版判的是「有来源但一条都没装进去」，于是这种情况直接报错，
    而它本来能照着对话生成。
  */
  it('来源都装不下但有对话记录时，照着对话生成而不是报错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const digest = buildContentDigest(
      input({
        sources: [{ id: 'a', title: '长文', content: 'x'.repeat(9000) }],
        messages: [
          { role: 'user', content: 'Lumen 怎么调？' },
          { role: 'assistant', content: '先看 Final Gather。' }
        ],
        options: { charBudget: 6554 }
      })
    )

    expect(digest).toContain('用户：Lumen 怎么调？')
    expect(digest).not.toContain('xxxx')
    warn.mockRestore()
  })

  it('本来就没有可用来源（只有对话）时不报错 —— 那是合法用法', () => {
    const digest = buildContentDigest(
      input({
        sources: [],
        messages: [{ role: 'user', content: '只聊天不加来源' }],
        options: { charBudget: 100 }
      })
    )

    expect(digest).toContain('只聊天不加来源')
  })
})

describe('parseJsonObject', () => {
  it('裸 JSON、代码块、前后寒暄三种都能解', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseJsonObject('好的，结果如下：{"a":1} 希望有帮助')).toEqual({ a: 1 })
  })

  it('实在解不出来时给一句能看懂的话', () => {
    expect(() => parseJsonObject('我无法完成这个请求')).toThrow('不是合法 JSON')
  })
})

describe('产出配方', () => {
  beforeEach(() => {
    aiMocks.chatText.mockReset()
    locale.value = 'zh-CN'
  })

  it('网页分两步：先出 Brief，再照 Brief 排版', async () => {
    respondInOrder(
      '{"title":"Lumen 入门"}',
      '```html\n<!DOCTYPE html><html><body>页面</body></html>\n```'
    )

    const result = await NOTEBOOK_TASK_RUNNERS.webpage(input(), context())

    expect(aiMocks.chatText).toHaveBeenCalledTimes(2)
    expect(result.title).toBe('Lumen 入门')
    expect(result.htmlContent.startsWith('<!DOCTYPE html>')).toBe(true)

    // 第二步喂的是 Brief，不是三万字原文 —— 否则模型忙着复述内容而不是排版
    const second = aiMocks.chatText.mock.calls[1][0] as StreamedChatParams
    expect(JSON.stringify(second.messages)).toContain('Lumen 入门')
    expect(JSON.stringify(second.messages)).not.toContain('关于 Lumen 的记录')
  })

  it('模型没给出网页代码时直接报错，不把一段散文当页面存下来', async () => {
    respondInOrder('{"title":"Lumen 入门"}', '我建议你自己写一个页面。')

    await expect(NOTEBOOK_TASK_RUNNERS.webpage(input(), context())).rejects.toThrow(
      '没有返回可用的网页代码'
    )
  })

  it('面试题缺字段时补成空数组，而不是让界面拿到 undefined', async () => {
    respondInOrder('{"title":"虚幻引擎面试"}')

    const result = await NOTEBOOK_TASK_RUNNERS.interview(input(), context())

    expect(result).toEqual({ title: '虚幻引擎面试', knowledgePoints: [], questions: [] })
  })

  it('界面是英文时提示词要求模型用英文写', async () => {
    locale.value = 'en-US'
    respondInOrder('- Root\n  - Branch')

    await NOTEBOOK_TASK_RUNNERS.mindmap(input(), context())

    const params = aiMocks.chatText.mock.calls[0][0] as StreamedChatParams
    expect(JSON.stringify(params.messages)).toContain('English')
  })

  it('调用方显式指定语言时以它为准', async () => {
    locale.value = 'en-US'
    respondInOrder('# 标题\n正文')

    await NOTEBOOK_TASK_RUNNERS.report(input({ options: { language: 'zh' } }), context())

    const params = aiMocks.chatText.mock.calls[0][0] as StreamedChatParams
    expect(JSON.stringify(params.messages)).toContain('中文')
  })

  it('进度从起点走到终点，跟着收到的字数走', async () => {
    const reported: number[] = []
    aiMocks.chatText.mockImplementation(async (params: StreamedChatParams) => {
      params.onDelta?.('x'.repeat(2000), 'x'.repeat(2000))
      return '- 根节点'
    })

    await NOTEBOOK_TASK_RUNNERS.mindmap(input(), {
      signal: new AbortController().signal,
      report: (progress) => reported.push(progress)
    })

    expect(reported[0]).toBe(10)
    expect(reported.at(-1)).toBe(95)
    expect(reported[1]).toBeGreaterThan(10)
    expect(reported[1]).toBeLessThan(95)
  })
})
