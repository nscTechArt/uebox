/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../defineUeTool', () => ({
  callUe: vi.fn()
}))

import { callUe } from '../defineUeTool'
import { createSequenceDescribeTool } from './describe'

const mockUe = vi.mocked(callUe)

const tool = createSequenceDescribeTool()

/** Python 侧回传的最小可用结构 */
function output(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sequence: {
      path: '/Game/Cine/Shot_01.Shot_01',
      display_rate: '30/1',
      playback_start: 0,
      playback_end: 300,
      duration_frames: 300
    },
    bindings: [
      { name: 'CineCamera', id: 'abc', type: 'possessable', bound_to: '/Game/x', track_count: 2 }
    ],
    camera_cuts: { exists: true, section_count: 1, covers_playback: true },
    broken_bindings: [],
    truncated: false,
    ...over
  }
}

/**
 * `callUe` 直接 resolve 出引擎的数据本身，不再有 `{ success, output }` 那层信封 ——
 * 失败是抛异常，由 pi 标记 isError。见 `defineUeTool.ts`。
 */
function ok(over: Record<string, unknown> = {}): Record<string, unknown> {
  return output(over)
}

describe('sequence_describe 的元数据', () => {
  it('是只读工具，不该触发审批', () => {
    expect(tool.unrealBox.risk).toBe('safe')
    expect(tool.unrealBox.namespace).toBe('ue.sequencer')
  })

  it('工具名符合厂商约定', () => {
    expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('描述里写明帧边界约定 —— 让模型自己推算帧边界是错帧的来源', () => {
    expect(tool.description).toContain('[start, end)')
    expect(tool.description).toContain('不要自己推算帧边界')
  })

  it('描述里划清不做渲染的边界', () => {
    expect(tool.description).toContain('只诊断不渲染')
  })
})

describe('detail=keys 的护栏', () => {
  // defineTool 把 isError 转成抛出的 ToolFailure，所以这里断言 rejects
  it('不点名 bindings 时直接拒绝，不去执行', async () => {
    // 不限范围地拉全序列关键帧会一次吃掉整个上下文
    await expect(
      tool.execute('c1', { sequence_path: '/Game/Cine/Shot_01.Shot_01', detail: 'keys' })
    ).rejects.toThrow()

    expect(mockUe).not.toHaveBeenCalled()
  })

  it('拒绝时要告诉模型下一步怎么做，而不只是说不行', async () => {
    await expect(
      tool.execute('c1', { sequence_path: '/Game/x.x', detail: 'keys' })
    ).rejects.toThrow(/bindings[\s\S]*outline|outline[\s\S]*bindings/)
  })

  it('点名了 bindings 就放行', async () => {
    mockUe.mockResolvedValueOnce(ok())
    await expect(
      tool.execute('c1', {
        sequence_path: '/Game/x.x',
        detail: 'keys',
        bindings: ['CineCamera']
      })
    ).resolves.toBeDefined()

    expect(mockUe).toHaveBeenCalled()
  })
})

describe('出片体检', () => {
  const run = async (over: Record<string, unknown>): Promise<string> => {
    mockUe.mockResolvedValueOnce(ok(over))
    const result = await tool.execute('c1', {
      sequence_path: '/Game/x.x',
      detail: 'outline'
    })
    return result.content.map((c) => ('text' in c ? c.text : '')).join('')
  }

  it('没有相机切轨时明说会是黑画面', async () => {
    // 这是社区里最高频的问题：视口好好的，渲出来全黑
    const text = await run({
      camera_cuts: { exists: false, section_count: 0, covers_playback: false }
    })
    expect(text).toContain('没有相机切轨')
    expect(text).toContain('黑画面')
  })

  it('切轨存在但没覆盖播放范围时给警告', async () => {
    const text = await run({
      camera_cuts: { exists: true, section_count: 1, covers_playback: false }
    })
    expect(text).toContain('没有覆盖完整播放范围')
  })

  it('切轨是空的也算黑画面', async () => {
    const text = await run({
      camera_cuts: { exists: true, section_count: 0, covers_playback: false }
    })
    expect(text).toContain('黑画面')
  })

  it('失效绑定要指出「不会报错，只是什么都不做」', async () => {
    // 断链是静默的，模型和用户都不会自己想到这一层
    const text = await run({ broken_bindings: ['Hero', 'Light_01'] })
    expect(text).toContain('2 个绑定已失效')
    expect(text).toContain('什么都不做')
  })

  it('失效绑定要给出引擎自带的修复入口，而不是让用户自己找', async () => {
    const text = await run({ broken_bindings: ['Hero'] })
    expect(text).toContain('Rebind Possessable References')
  })

  // 回归：用 bindings 点名时，broken 只覆盖被点到的那几个，
  // 再说「✅ 没有失效的绑定」就是假话 —— 没点到的这次根本没查
  it('用 bindings 过滤时不许声称全部绑定都好着', async () => {
    mockUe.mockResolvedValueOnce(ok({ broken_bindings: [] }))
    const result = await tool.execute('c1', {
      sequence_path: '/Game/x.x',
      detail: 'tracks',
      bindings: ['CineCamera']
    })
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('')

    expect(text).toContain('其余绑定这次没查')
    expect(text).not.toContain('✅ 没有失效的绑定')
  })

  it('一切正常时也要明确说正常 —— 沉默不等于通过', async () => {
    const text = await run({})
    expect(text).toContain('✅ 相机切轨覆盖了完整播放范围')
    expect(text).toContain('✅ 没有失效的绑定')
  })

  it('失效绑定超过 5 个时只列前 5 个并带「等」', async () => {
    const text = await run({ broken_bindings: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })
    expect(text).toContain('7 个绑定已失效')
    expect(text).toContain('等')
  })

  it('切轨空隙要点名到帧 —— 肉眼在时间线上看不出来', async () => {
    const text = await run({
      camera_cuts: { exists: true, section_count: 2, covers_playback: true, gaps: [[120, 121]] }
    })
    expect(text).toContain('120–121')
    expect(text).toContain('黑画面')
  })

  // 重叠原来在 C++ 侧算了又丢掉，describe 在结构上永远报不出来，
  // 只有 sequence_audit 报得出 —— 同一条序列两个工具两种说法
  it('切轨重叠要报出来，并说清渲哪台相机是不确定的', async () => {
    const text = await run({
      camera_cuts: {
        exists: true,
        section_count: 2,
        covers_playback: true,
        overlaps: [[250, 300]]
      }
    })
    expect(text).toContain('250–300')
    expect(text).toContain('不确定')
  })

  // 「判不出来」不能印成「没盖满」—— 那会让用户去修一个可能没坏的东西
  it('判不出覆盖时如实说判不出来，不说成没盖满', async () => {
    const text = await run({
      camera_cuts: {
        exists: true,
        section_count: 2,
        covers_playback: false,
        coverage_known: false,
        coverage_unknown_reason: '有 1 个切轨段的时间范围有一头是无界的，算不出它盖到哪里'
      }
    })
    expect(text).toContain('判不出')
    expect(text).toContain('无界')
    expect(text).not.toContain('没有覆盖完整播放范围')
  })

  it('老引擎不回传 coverage_known 时按判得出来处理', async () => {
    const text = await run({
      camera_cuts: { exists: true, section_count: 1, covers_playback: true }
    })
    expect(text).toContain('✅ 相机切轨覆盖了完整播放范围')
  })

  it('「判不出来」和「已失效」必须分开说', async () => {
    // 混为一谈会让用户去修一个根本没坏的东西
    const text = await run({ unresolved_bindings: ['Hero'], broken_bindings: [] })
    expect(text).toContain('无法判定')
    expect(text).toContain('这不代表它们坏了')
    expect(text).toContain('✅ 没有失效的绑定')
  })

  it('World Partition / PIE 是「判不出来」的已知原因，要写给用户看', async () => {
    const text = await run({ unresolved_bindings: ['Hero'] })
    expect(text).toContain('World Partition')
  })
})

describe('跨版本能力如实上报', () => {
  const run = async (over: Record<string, unknown>): Promise<string> => {
    mockUe.mockResolvedValueOnce(ok(over))
    const result = await tool.execute('c1', { sequence_path: '/Game/x.x', detail: 'outline' })
    return result.content.map((c) => ('text' in c ? c.text : '')).join('')
  }

  it('分不出 spawnable 时明说，不静默降级', async () => {
    // 5.5 的 Custom Binding 重构改了语义。静默给个错答案比不给答案更糟
    const text = await run({
      capabilities: { engine_version: '5.5.4', spawnable_detection: false }
    })
    expect(text).toContain('分不出 spawnable')
    expect(text).toContain('5.5.4')
  })

  it('拿不到编辑器世界时说明失效检查没跑', async () => {
    const text = await run({ capabilities: { engine_version: '5.0.3', binding_resolution: false } })
    expect(text).toContain('无法判定绑定是否失效')
  })

  it('能力齐全时不啰嗦', async () => {
    const text = await run({
      capabilities: { engine_version: '5.6.0', spawnable_detection: true, binding_resolution: true }
    })
    expect(text).not.toContain('引擎能力')
  })

  it('没有 capabilities 字段时不报错也不印 undefined', async () => {
    const text = await run({})
    expect(text).not.toContain('undefined')
  })
})

describe('输出格式', () => {
  const run = async (
    input: Record<string, unknown>,
    over: Record<string, unknown> = {}
  ): Promise<string> => {
    mockUe.mockResolvedValueOnce(ok(over))
    const result = await tool.execute('c1', {
      sequence_path: '/Game/x.x',
      detail: 'outline',
      ...input
    })
    return result.content.map((c) => ('text' in c ? c.text : '')).join('')
  }

  it('播放范围按闭开区间写出来', async () => {
    expect(await run({})).toContain('[0, 300)')
  })

  it('报出帧率和时长', async () => {
    const text = await run({})
    expect(text).toContain('30/1')
    expect(text).toContain('300 帧')
  })

  it('outline 层提示怎么往下钻', async () => {
    const text = await run({})
    expect(text).toContain('detail="tracks"')
  })

  it('截断时必须如实告知 —— 悄悄少给比报错更危险', async () => {
    // 模型会拿一份不完整却看起来完整的结构做后续决策，错得无声无息
    const text = await run({}, { truncated: true })
    expect(text).toContain('已截断')
    expect(text).toContain('bindings')
  })

  it('没截断就不提截断，别制造不存在的疑虑', async () => {
    expect(await run({})).not.toContain('已截断')
  })

  it('结构化数据进 details 而不是全塞进文本', async () => {
    mockUe.mockResolvedValueOnce(ok())
    const result = await tool.execute('c1', { sequence_path: '/Game/x.x', detail: 'outline' })
    expect((result.details as { sequence?: unknown })?.sequence).toBeDefined()
  })
})

describe('失败处理', () => {
  it('RPC 失败时原样带上原因', async () => {
    mockUe.mockRejectedValueOnce(new Error('找不到资产：/Game/x.x'))
    await expect(
      tool.execute('c1', { sequence_path: '/Game/x.x', detail: 'outline' })
    ).rejects.toThrow(/找不到资产/)
  })

  it('没给原因时不能印出 undefined', async () => {
    mockUe.mockRejectedValueOnce(new Error('sequence.describe 失败：未提供失败原因'))
    await expect(
      tool.execute('c1', { sequence_path: '/Game/x.x', detail: 'outline' })
    ).rejects.toThrow(/^(?!.*undefined).*$/s)
  })

  it('引擎回了空结构时报错，不当成一条空序列', async () => {
    // 静默当成「这条序列什么都没有」会让模型基于错误前提往下做
    mockUe.mockResolvedValueOnce({})
    await expect(
      tool.execute('c1', { sequence_path: '/Game/x.x', detail: 'outline' })
    ).rejects.toThrow()
  })
})
