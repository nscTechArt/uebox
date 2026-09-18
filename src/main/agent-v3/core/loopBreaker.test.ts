/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { createLoopBreaker, MAX_IDENTICAL_FAILURES, type LoopBreaker } from './loopBreaker'

const before = (
  b: ReturnType<typeof createLoopBreaker>,
  name: string,
  args: unknown
): ReturnType<LoopBreaker['before']> =>
  b.before({ toolCall: { name }, args } as unknown as Parameters<typeof b.before>[0])

const after = (
  b: ReturnType<typeof createLoopBreaker>,
  name: string,
  args: unknown,
  isError: boolean
): void =>
  b.after({ toolCall: { name }, args, isError } as unknown as Parameters<typeof b.after>[0])

/** 打一轮「调用 → 失败」 */
function fail(
  b: ReturnType<typeof createLoopBreaker>,
  name: string,
  args: unknown,
  times = 1
): void {
  for (let i = 0; i < times; i++) after(b, name, args, true)
}

describe('createLoopBreaker', () => {
  it('第一次调用直接放行', () => {
    expect(before(createLoopBreaker(), 'search_assets', { q: 'tree' })).toBeUndefined()
  })

  it(`同一工具+参数失败 ${MAX_IDENTICAL_FAILURES} 次后拦截`, () => {
    const b = createLoopBreaker()
    const args = { assetKey: 'ZZZ' }

    fail(b, 'add_asset_tags', args)
    expect(before(b, 'add_asset_tags', args)).toBeUndefined()

    fail(b, 'add_asset_tags', args)
    const blocked = before(b, 'add_asset_tags', args)
    expect(blocked?.block).toBe(true)
  })

  // 拦截理由会作为 tool result 交给模型，必须是「对模型的指示」。
  // 写成对用户的提示，模型会当成环境噪音继续重试 —— 那就白拦了。
  it('拦截理由告诉模型别再重试并给出替代路径', () => {
    const b = createLoopBreaker()
    fail(b, 'add_asset_tags', {}, MAX_IDENTICAL_FAILURES)

    const reason = before(b, 'add_asset_tags', {})?.reason ?? ''
    expect(reason).toContain('add_asset_tags')
    expect(reason).toContain('不要再用这组参数重试')
    expect(reason).toMatch(/换一个工具|不同的参数/)
  })

  // 搜不到就换关键词再搜是正常排查，拦下来会让 agent 失去正常的排查能力
  it('换了参数不算撞墙 —— 计数按工具+参数，不按工具', () => {
    const b = createLoopBreaker()
    fail(b, 'search_assets', { q: 'tree' }, MAX_IDENTICAL_FAILURES)

    expect(before(b, 'search_assets', { q: 'tree' })?.block).toBe(true)
    expect(before(b, 'search_assets', { q: '树' })).toBeUndefined()
  })

  it('不同工具之间互不影响', () => {
    const b = createLoopBreaker()
    fail(b, 'add_asset_tags', {}, MAX_IDENTICAL_FAILURES)

    expect(before(b, 'add_asset_tags', {})?.block).toBe(true)
    expect(before(b, 'get_note', {})).toBeUndefined()
  })

  // 引擎重连过程中工具会间歇性失败，那不该累积成永久熔断
  it('成功一次就清零', () => {
    const b = createLoopBreaker()
    const args = { id: 1 }

    fail(b, 'get_note', args, MAX_IDENTICAL_FAILURES)
    expect(before(b, 'get_note', args)?.block).toBe(true)

    after(b, 'get_note', args, false)
    expect(before(b, 'get_note', args)).toBeUndefined()

    // 清零是真清零，不是减一 —— 再失败一次不该立刻又被拦
    fail(b, 'get_note', args)
    expect(before(b, 'get_note', args)).toBeUndefined()
  })

  it('参数不可序列化时退回按工具名计数，而不是抛异常', () => {
    const b = createLoopBreaker()
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => fail(b, 'weird', circular, MAX_IDENTICAL_FAILURES)).not.toThrow()
    expect(before(b, 'weird', circular)?.block).toBe(true)
  })

  it('每个会话各自计数 —— 两个熔断器不共享状态', () => {
    const a = createLoopBreaker()
    const b = createLoopBreaker()

    fail(a, 'x', {}, MAX_IDENTICAL_FAILURES)

    expect(before(a, 'x', {})?.block).toBe(true)
    expect(before(b, 'x', {})).toBeUndefined()
  })

  it('阈值可调，供子 agent 用更严格的口径', () => {
    const b = createLoopBreaker(1)
    fail(b, 'x', {})
    expect(before(b, 'x', {})?.block).toBe(true)
  })

  it('阈值的默认值至少给模型一次换路子的机会', () => {
    // 设成 1 会在「第一次失败」后就拦，模型连一次重试都做不了；
    // 瞬时故障（锁竞争、引擎重连）会被误判成撞墙。
    expect(MAX_IDENTICAL_FAILURES).toBeGreaterThanOrEqual(2)
  })
})
