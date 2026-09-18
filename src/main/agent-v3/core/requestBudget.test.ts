// @vitest-environment node
/**
 * 出口闸的契约。
 *
 * 守的是那次真机事故：一张 3.5MB 的 UV 图原样进了 transcript，请求体撑到
 * 4.7MB，厂商网关退回 413；而 pi 每轮重发整条 transcript，于是**之后每一轮
 * 都再 413 一次**，整个会话报废。这一层的职责就是让那种失误只损失一张图，
 * 不损失整个会话。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_REQUEST_MAX_BYTES,
  __testing,
  budgetFor,
  measureContextBytes,
  noteOversizedRequest,
  projectWithinBudget
} from './requestBudget'

type Ctx = Parameters<typeof projectWithinBudget>[0]

const image = (kb: number): { type: 'image'; data: string; mimeType: string } => ({
  type: 'image',
  data: 'A'.repeat(kb * 1024),
  mimeType: 'image/jpeg'
})

const userWithImages = (...images: ReturnType<typeof image>[]): Ctx =>
  ({
    systemPrompt: '你是助手',
    messages: images.map((img) => ({
      role: 'user',
      content: [{ type: 'text', text: '看看这个' }, img],
      timestamp: 0
    }))
  }) as unknown as Ctx

beforeEach(() => __testing.resetObservedLimits())

describe('outbound assistant payloads', () => {
  it('counts tool arguments so a large tool call cannot bypass image projection', () => {
    const context = userWithImages(image(500))
    context.messages.unshift({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'write',
          name: 'write_file',
          arguments: { content: 'x'.repeat(2800000) }
        }
      ]
    } as unknown as Ctx['messages'][number])
    const before = JSON.stringify(context)
    const result = projectWithinBudget(context, 3000000)
    expect(measureContextBytes(context)).toBeGreaterThan(3300000)
    expect(result.droppedImages).toBe(1)
    expect(result.bytes).toBeLessThan(3000000)
    expect(JSON.stringify(context)).toBe(before)
  })

  it('counts preserved reasoning and its signature in UTF-8', () => {
    const context = {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: '推理'.repeat(1000),
              thinkingSignature: 'signature'.repeat(1000)
            }
          ]
        }
      ]
    } as Ctx
    expect(measureContextBytes(context)).toBeGreaterThanOrEqual(15000)
  })
})

describe('预算之内的请求原样透传', () => {
  // 复制一份会平白产生垃圾，更重要的是下游拿到的引用不该无缘无故变
  it('不超预算时返回的是同一个对象', () => {
    const context = userWithImages(image(100))
    const result = projectWithinBudget(context, DEFAULT_REQUEST_MAX_BYTES)

    expect(result.context).toBe(context)
    expect(result.droppedImages).toBe(0)
  })

  it('报出来的字节数是真量的，不是估的', () => {
    const context = userWithImages(image(100))

    expect(projectWithinBudget(context, DEFAULT_REQUEST_MAX_BYTES).bytes).toBe(
      measureContextBytes(context)
    )
  })
})

describe('超预算时丢最老的图', () => {
  it('丢到预算之内，并且丢的是最早那几张', () => {
    const context = userWithImages(image(200), image(200), image(200))
    const result = projectWithinBudget(context, 300 * 1024)

    expect(result.droppedImages).toBeGreaterThan(0)
    expect(result.bytes).toBeLessThanOrEqual(300 * 1024)

    // 丢的是最早那张：它早就被回答过了，正在问的那张才是这一轮的重点
    const messages = result.context.messages as Array<{ content: Array<{ type: string }> }>
    expect(messages[0]?.content.some((block) => block.type === 'image')).toBe(false)
  })

  it('丢掉的图换成一句说明，不是凭空消失', () => {
    const result = projectWithinBudget(userWithImages(image(200), image(200)), 250 * 1024)
    const first = (result.context.messages as Array<{ content: Array<{ type: string }> }>)[0]

    expect(JSON.stringify(first.content)).toContain('看不到它')
  })

  /**
   * 丢到刚好压线的话，下一轮多一张图就又超，每轮丢的前缀都在变 ——
   * 变动的前缀会把厂商的 prompt 缓存整段打掉。所以要丢到低水位。
   */
  it('丢到低水位而不是刚好压线', () => {
    const budget = 400 * 1024
    const result = projectWithinBudget(userWithImages(...Array(6).fill(image(100))), budget)

    expect(result.bytes).toBeLessThanOrEqual(budget * __testing.LOW_WATER_RATIO + 4096)
  })

  /**
   * 低水位是为了少丢几次，不是为了多丢一张。最后那张是模型正在看的东西，
   * 丢了它等于这次工具调用白做 —— 预算容得下就必须留着。
   */
  it('预算容得下时不动最新那张', () => {
    const result = projectWithinBudget(
      userWithImages(image(200), image(200), image(200)),
      300 * 1024
    )
    const messages = result.context.messages as Array<{ content: Array<{ type: string }> }>

    expect(messages.at(-1)?.content.some((block) => block.type === 'image')).toBe(true)
    expect(result.bytes).toBeLessThanOrEqual(300 * 1024)
  })

  // 单张图自己就超预算时留不住，硬留下来这一轮照样失败
  it('预算容不下最新那张时也得丢', () => {
    const result = projectWithinBudget(userWithImages(image(400)), 300 * 1024)

    expect(result.droppedImages).toBe(1)
    expect(result.bytes).toBeLessThanOrEqual(300 * 1024)
  })

  // 本地存的 transcript 一个字节都不能动：换个上限更宽的模型，那些图还要回来
  it('不改原来的 context', () => {
    const context = userWithImages(image(200), image(200))
    const before = JSON.stringify(context)

    projectWithinBudget(context, 250 * 1024)

    expect(JSON.stringify(context)).toBe(before)
  })

  // 纯文本撑爆的，这一层无能为力 —— 别在这里编一个错误，让厂商的真实原因回来
  it('没有图可丢时照常发出去', () => {
    const context = {
      systemPrompt: 'x'.repeat(500 * 1024),
      messages: [{ role: 'user', content: '你好', timestamp: 0 }]
    } as unknown as Ctx

    const result = projectWithinBudget(context, 100 * 1024)

    expect(result.context).toBe(context)
    expect(result.droppedImages).toBe(0)
  })

  /**
   * 图全丢光也压不下来时，一张都别丢。
   *
   * 原来 `countToReach(maxBytes)` 走到底就返回「全丢」，于是文本撑爆的那一轮
   * 会把每张图都换成占位文字，**然后照样 413** —— 模型白白丢了正在推理用的图。
   */
  it('文本自己就超预算时不动任何图', () => {
    const context = {
      systemPrompt: 'x'.repeat(4 * 1024 * 1024),
      messages: [image(100), image(100)].map((img) => ({
        role: 'user',
        content: [img],
        timestamp: 0
      }))
    } as unknown as Ctx

    const result = projectWithinBudget(context, 3 * 1024 * 1024)

    expect(result.context).toBe(context)
    expect(result.droppedImages).toBe(0)
  })

  /**
   * 比占位文字还小的图丢了反而更大。
   *
   * 原来没有这个判断：`remaining -= size - placeholder` 在小图上反向增长，
   * 循环永远到不了预算，最后报告「全都要丢」，把每张图都换成一段更长的话。
   */
  it('小到不值得丢的图一张都不动', () => {
    const tiny = { type: 'image', data: 'A'.repeat(64), mimeType: 'image/jpeg' } as const
    const context = {
      systemPrompt: 'x'.repeat(4 * 1024 * 1024),
      messages: [1, 2, 3, 4, 5].map(() => ({ role: 'user', content: [tiny], timestamp: 0 }))
    } as unknown as Ctx

    const result = projectWithinBudget(context, 3 * 1024 * 1024)

    expect(result.droppedImages).toBe(0)
    expect(result.bytes).toBeLessThanOrEqual(measureContextBytes(context))
  })

  /**
   * `details` 是给界面用的，厂商一个字节都收不到 —— 不能算进预算。
   *
   * 算进去的话，工具用得多的会话量出来的数远大于真实请求体，出口闸会为了
   * 抵消这些根本不上线的字节，去丢那些**真的在上线**的图。
   */
  it('不数 details —— 那部分根本不上线', () => {
    const withDetails = {
      messages: [
        {
          role: 'toolResult',
          content: [{ type: 'text', text: 'ok' }],
          details: { blob: 'D'.repeat(2 * 1024 * 1024) },
          timestamp: 0
        }
      ]
    } as unknown as Ctx

    expect(measureContextBytes(withDetails)).toBeLessThan(1024)
  })

  /**
   * 「从老到新」不能护着肇事的那张，而阈值挪一挪就漏 —— 三张各占 40% 的图
   * 一张都算不上「大」，顺序退回从老到新，坑原样复现。按大小排不需要常数。
   */
  it('几张一样大的图，先丢大的那张而不是最老的', () => {
    const context = {
      messages: [image(300), image(300), image(900)].map((img) => ({
        role: 'user',
        content: [img],
        timestamp: 0
      }))
    } as unknown as Ctx

    const result = projectWithinBudget(context, 1024 * 1024)
    const messages = result.context.messages as Array<{ content: Array<{ type: string }> }>

    expect(result.droppedImages).toBe(1)
    expect(messages[2]?.content.some((block) => block.type === 'image')).toBe(false)
    expect(messages[0]?.content.some((block) => block.type === 'image')).toBe(true)
  })

  /**
   * 用户刚让模型看一张巨大的精灵图，它恰好是最新的一张。按纯粹的从老到新，
   * 循环会把之前两张小截图挨个换掉、刚好压线就停手 —— 肇事的那张原封不动。
   */
  it('一张就吃掉大半预算的图优先丢，哪怕它是最新的', () => {
    const context = {
      messages: [image(80), image(80), image(1800)].map((img) => ({
        role: 'user',
        content: [img],
        timestamp: 0
      }))
    } as unknown as Ctx

    const result = projectWithinBudget(context, 1024 * 1024)
    const messages = result.context.messages as Array<{ content: Array<{ type: string }> }>

    expect(messages[2]?.content.some((block) => block.type === 'image')).toBe(false)
    expect(messages[0]?.content.some((block) => block.type === 'image')).toBe(true)
  })
})

/**
 * 各家网关的上限不公开，猜不准。所以从 413 里学：某家退过一次，
 * 之后这家的预算就按那次的大小往下调，同一家的 413 只会发生一次。
 */
describe('从 413 里学这家的上限', () => {
  it('没撞过就是默认预算', () => {
    expect(budgetFor('deepseek')).toBe(DEFAULT_REQUEST_MAX_BYTES)
  })

  it('撞过之后按实测值往下留一档', () => {
    noteOversizedRequest('deepseek', 1_000_000)

    expect(budgetFor('deepseek')).toBe(1_000_000 * __testing.SAFETY_RATIO)
  })

  it('只往下调，不被后来更大的失败抬回去', () => {
    noteOversizedRequest('deepseek', 1_000_000)
    noteOversizedRequest('deepseek', 2_000_000)

    expect(budgetFor('deepseek')).toBe(1_000_000 * __testing.SAFETY_RATIO)
  })

  it('一家学到的不影响另一家', () => {
    noteOversizedRequest('deepseek', 1_000_000)

    expect(budgetFor('moonshot')).toBe(DEFAULT_REQUEST_MAX_BYTES)
  })

  /**
   * 学到的值再小也压到下限为止，**不能因此就不投影**。
   *
   * 不投影的话连 3MB 的默认保护一起没了：下一张 3.5MB 的图原样发出去，
   * 钉在 transcript 里，正是这个模块要防的事故。压到下限还过不去只说明
   * 这家网关严到丢图也救不了，那时厂商的真实报错会照常回到用户面前。
   */
  it('学到的值太小时压到下限，而不是放弃投影', () => {
    noteOversizedRequest('strict-proxy', 200 * 1024)

    const budget = budgetFor('strict-proxy')
    expect(Number.isFinite(budget)).toBe(true)
    expect(budget).toBe(__testing.MIN_BUDGET_BYTES)

    // 默认保护还在：一张超大的图照样会被丢掉，不会原样发出去
    const context = {
      messages: [{ role: 'user', content: [image(3000)], timestamp: 0 }]
    } as unknown as Ctx
    expect(projectWithinBudget(context, budget).droppedImages).toBe(1)
  })
})
