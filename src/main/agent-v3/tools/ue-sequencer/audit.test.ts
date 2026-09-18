/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../defineUeTool', () => ({
  callUe: vi.fn()
}))

import { callUe } from '../defineUeTool'
import { createSequenceAuditTool } from './audit'

const mockUe = vi.mocked(callUe)
const tool = createSequenceAuditTool()

/**
 * `callUe` 直接 resolve 出引擎的数据本身，不再有 `{ success, output }` 那层信封 ——
 * 失败是抛异常，由 pi 标记 isError。见 `defineUeTool.ts`。
 */
function ok(output: Record<string, unknown>): Record<string, unknown> {
  return output
}

const run = async (
  input: Record<string, unknown>,
  output: Record<string, unknown>
): Promise<string> => {
  mockUe.mockResolvedValueOnce(ok(output))
  const result = await tool.execute('c1', {
    recursive: true,
    only_blockers: false,
    ...input
  })
  return result.content.map((c) => ('text' in c ? c.text : '')).join('')
}

describe('sequence_audit 的元数据', () => {
  it('是只读工具，不该触发审批', () => {
    expect(tool.unrealBox.risk).toBe('safe')
    expect(tool.unrealBox.namespace).toBe('ue.sequencer')
  })

  it('工具名符合厂商约定', () => {
    expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('描述里划清不渲染的边界，并且明说别提议帮用户渲', () => {
    expect(tool.description).toContain('只诊断不渲染')
    expect(tool.description).toContain('不要提议帮他渲')
  })

  it('描述里点明它回答的是「按下渲染键会不会白等」', () => {
    expect(tool.description).toContain('白等')
  })
})

describe('批量与结论', () => {
  it('一次多条时给出不通过的条数', async () => {
    const text = await run(
      { sequence_paths: ['/Game/A', '/Game/B'] },
      {
        reports: [
          {
            path: '/Game/A',
            findings: [
              { code: 'no_camera_cut_track', severity: 'breaks_render', evidence: '整条序列' }
            ]
          },
          { path: '/Game/B', findings: [] }
        ]
      }
    )
    expect(text).toContain('体检了 2 条序列，1 条不通过')
  })

  it('读不出来的那条不影响其余的结论', async () => {
    // 一轮 24 条里坏一条，用户要的是另外 23 条的结论
    const text = await run(
      { sequence_paths: ['/Game/A', '/Game/B'] },
      {
        reports: [
          { path: '/Game/A', findings: [], error: '找不到资产' },
          { path: '/Game/B', findings: [] }
        ]
      }
    )
    expect(text).toContain('找不到资产')
    expect(text).toContain('✅ PASS `/Game/B`')
  })

  it('only_blockers 过滤掉提示类，只留会导致渲染失败的', async () => {
    const text = await run(
      { sequence_paths: ['/Game/A'], only_blockers: true },
      {
        reports: [
          {
            path: '/Game/A',
            findings: [
              { code: 'empty_track', severity: 'cosmetic', evidence: 'T1' },
              { code: 'camera_cut_gap', severity: 'breaks_render', evidence: '第 10–11 帧' }
            ]
          }
        ]
      }
    )
    expect(text).toContain('第 10–11 帧')
    expect(text).not.toContain('一个段都没有')
  })

  it('only_blockers 隐藏了东西就要交代，不能让空列表被读成「没问题」', async () => {
    // formatReports 对空 findings 会打印「没有发现问题」，
    // 那是把「这次没看」说成了「看了没问题」
    const text = await run(
      { sequence_paths: ['/Game/A'], only_blockers: true },
      {
        reports: [
          {
            path: '/Game/A',
            findings: [
              { code: 'empty_track', severity: 'cosmetic', evidence: 'T1' },
              { code: 'section_out_of_range', severity: 'breaks_preview', evidence: 'T2' }
            ]
          }
        ]
      }
    )
    expect(text).toContain('另有 2 项非阻塞提示未显示')
  })

  it('没过滤掉任何东西时不加这句噪音', async () => {
    const text = await run(
      { sequence_paths: ['/Game/A'], only_blockers: true },
      { reports: [{ path: '/Game/A', findings: [] }] }
    )
    expect(text).not.toContain('未显示')
  })

  it('超过 50 条时被 schema 拦下，不去执行', async () => {
    // 每条要跑全树遍历、且命令在游戏线程上，太多会让编辑器可见地卡住
    const paths = Array.from({ length: 51 }, (_, i) => `/Game/S${i}`)
    await expect(
      tool.execute('c1', { sequence_paths: paths, recursive: true, only_blockers: false })
    ).rejects.toThrow(/sequence_paths/)
    expect(mockUe).not.toHaveBeenCalled()
  })
})

describe('拿不到编辑器世界时必须说清楚', () => {
  it('绑定检查没跑就要警告，不能让沉默被读成「绑定都好着」', async () => {
    const text = await run(
      { sequence_paths: ['/Game/A'] },
      {
        reports: [{ path: '/Game/A', findings: [] }],
        capabilities: { binding_resolution: false, engine_version: '5.3.2' }
      }
    )
    expect(text).toContain('绑定有效性检查没有执行')
    expect(text).toContain('不等于绑定都是好的')
  })

  it('能查的时候不加这段噪音', async () => {
    const text = await run(
      { sequence_paths: ['/Game/A'] },
      {
        reports: [{ path: '/Game/A', findings: [] }],
        capabilities: { binding_resolution: true }
      }
    )
    expect(text).not.toContain('绑定有效性检查没有执行')
  })
})

describe('失败处理', () => {
  it('RPC 失败时原样带上原因', async () => {
    mockUe.mockRejectedValueOnce(new Error('没有连接的虚幻引擎项目'))
    await expect(
      tool.execute('c1', {
        sequence_paths: ['/Game/A'],
        recursive: true,
        only_blockers: false
      })
    ).rejects.toThrow(/没有连接的虚幻引擎项目/)
  })

  it('引擎返回形状不对时报错，不当成「全部通过」', async () => {
    // 静默当成通过会让用户按下渲染键，那正是我们要防的事
    mockUe.mockResolvedValueOnce(ok({}))
    await expect(
      tool.execute('c1', {
        sequence_paths: ['/Game/A'],
        recursive: true,
        only_blockers: false
      })
    ).rejects.toThrow()
  })

  it('结构化结果进 details', async () => {
    mockUe.mockResolvedValueOnce(ok({ reports: [{ path: '/Game/A', findings: [] }] }))
    const result = await tool.execute('c1', {
      sequence_paths: ['/Game/A'],
      recursive: true,
      only_blockers: false
    })
    expect((result.details as { reports?: unknown[] })?.reports).toHaveLength(1)
  })
})
