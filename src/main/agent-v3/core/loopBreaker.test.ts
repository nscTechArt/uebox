/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import {
  createLoopBreaker,
  MAX_IDENTICAL_FAILURES,
  MAX_VOLATILE_FAILURES,
  VOLATILE_TOOLS,
  type LoopBreaker
} from './loopBreaker'

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

describe('createLoopBreaker —— 世界变了就清账', () => {
  const metas: Record<string, { unrealBox: { namespace: string; risk: 'safe' | 'mutating' } }> = {
    cpp_compile: { unrealBox: { namespace: 'cpp', risk: 'mutating' } },
    edit_local_file: { unrealBox: { namespace: 'local', risk: 'mutating' } },
    read_local_file: { unrealBox: { namespace: 'local', risk: 'safe' } },
    get_note: { unrealBox: { namespace: 'note', risk: 'safe' } }
  }
  const make = (limit?: number): LoopBreaker =>
    createLoopBreaker(limit, {
      lookup: (name) => metas[name] as never
    })

  // 改代码 → 编译 → 再改 → 再编译：编译参数一字不差，但源文件不同了
  it('编译失败、改文件成功、再失败、再改成功之后，编译仍被放行', () => {
    const b = make(1)
    const compile = { module: 'Game' }

    fail(b, 'cpp_compile', compile)
    after(b, 'edit_local_file', { path: 'a.cpp', v: 1 }, false)
    expect(before(b, 'cpp_compile', compile)).toBeUndefined()

    fail(b, 'cpp_compile', compile)
    after(b, 'edit_local_file', { path: 'a.cpp', v: 2 }, false)
    expect(before(b, 'cpp_compile', compile)).toBeUndefined()
  })

  it('成功的改动清掉所有工具的失败计数', () => {
    const b = make()
    fail(b, 'get_note', { id: 1 }, MAX_IDENTICAL_FAILURES)
    expect(before(b, 'get_note', { id: 1 })?.block).toBe(true)

    after(b, 'edit_local_file', { path: 'x' }, false)
    expect(before(b, 'get_note', { id: 1 })).toBeUndefined()
  })

  // 只读调用不改变下一次调用的结果，不能用来洗掉熔断
  it('只读调用成功不清别的工具的计数', () => {
    const b = make()
    fail(b, 'get_note', { id: 1 }, MAX_IDENTICAL_FAILURES)
    after(b, 'read_local_file', { path: 'x' }, false)
    expect(before(b, 'get_note', { id: 1 })?.block).toBe(true)
  })

  it('查不到元数据的工具成功不清别人的计数', () => {
    const b = make()
    fail(b, 'get_note', { id: 1 }, MAX_IDENTICAL_FAILURES)
    after(b, 'mystery_tool', {}, false)
    expect(before(b, 'get_note', { id: 1 })?.block).toBe(true)
  })

  it('改动失败不清账', () => {
    const b = make()
    fail(b, 'get_note', { id: 1 }, MAX_IDENTICAL_FAILURES)
    after(b, 'edit_local_file', { path: 'x' }, true)
    expect(before(b, 'get_note', { id: 1 })?.block).toBe(true)
  })

  it('不传 lookup 时从钩子上下文的 tools 里查元数据', () => {
    const b = createLoopBreaker()
    fail(b, 'get_note', { id: 1 }, MAX_IDENTICAL_FAILURES)
    b.after({
      toolCall: { name: 'edit_local_file' },
      args: {},
      isError: false,
      context: { tools: [{ name: 'edit_local_file', ...metas.edit_local_file }] }
    } as unknown as Parameters<typeof b.after>[0])
    expect(before(b, 'get_note', { id: 1 })).toBeUndefined()
  })

  // 编译、试玩、截图的结果随工程状态变；什么都没变就连发仍然是撞墙，只是阈值更宽
  it('结果随状态变化的工具用更宽的阈值，但不是无限', () => {
    const b = make()
    const args = { module: 'Game' }
    fail(b, 'cpp_compile', args, MAX_IDENTICAL_FAILURES)
    expect(before(b, 'cpp_compile', args)).toBeUndefined()

    fail(b, 'cpp_compile', args, MAX_VOLATILE_FAILURES - MAX_IDENTICAL_FAILURES)
    expect(before(b, 'cpp_compile', args)?.block).toBe(true)
    expect(VOLATILE_TOOLS.has('ue_playtest')).toBe(true)
    expect(VOLATILE_TOOLS.has('run_shell_command')).toBe(true)
  })
})
