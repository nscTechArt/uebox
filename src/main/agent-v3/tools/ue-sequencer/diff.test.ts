/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../defineUeTool', () => ({
  callUe: vi.fn()
}))

import { callUe } from '../defineUeTool'
import { createSequenceDiffTool, type DiffOutput } from './diff'

const mockUe = vi.mocked(callUe)
const tool = createSequenceDiffTool()

const seq = (path: string, bindings = 3): DiffOutput['base'] => ({
  path,
  display_rate: '60/1',
  tick_resolution: '24000/1',
  playback_start: 0,
  playback_end: 3849,
  duration_seconds: 64.15,
  binding_count: bindings
})

const run = async (
  input: Record<string, unknown>,
  output: Partial<DiffOutput>
): Promise<string> => {
  mockUe.mockResolvedValueOnce({ base: seq('/Game/A'), compare: seq('/Game/B'), ...output })
  const result = await tool.execute('c1', {
    base_path: '/Game/A',
    compare_path: '/Game/B',
    ...input
  })
  return result.content.map((c) => ('text' in c ? c.text : '')).join('')
}

describe('sequence_diff', () => {
  it('是只读工具', () => {
    expect(tool.unrealBox.risk).toBe('safe')
    expect(tool.unrealBox.namespace).toBe('ue.sequencer')
  })

  it('不给 binding_map 时不往引擎发空数组', async () => {
    await run({}, { mode: 'diff', bindings: [], unchanged_bindings: 3 })
    expect(mockUe.mock.calls.at(-1)?.[1]).toEqual({ base_path: '/Game/A', compare_path: '/Game/B' })
  })

  /**
   * 反馈里原序列的 SHA256 和备份对不上，却说不出差在哪。
   * 内容一致时要明说「哈希差异在内容以外」，否则模型还是不敢下结论
   */
  it('内容一致时直说人手 K 的曲线没动', async () => {
    const text = await run({}, { mode: 'diff', bindings: [], unchanged_bindings: 3 })
    expect(text).toContain('没有语义差异')
    expect(text).toContain('曲线没被动过')
  })

  it('点名比较时不替没比的绑定打包票', async () => {
    const text = await run(
      { bindings: ['Dog_01'] },
      { mode: 'diff', bindings: [], unchanged_bindings: 1, filtered: true }
    )
    expect(text).toContain('其余绑定这次没比')
    expect(text).not.toContain('曲线没被动过')
  })

  it('逐条列出变了的轨道和细节', async () => {
    const text = await run(
      {},
      {
        mode: 'diff',
        sequence_changes: [{ field: 'display_rate', base: '30/1', compare: '60/1' }],
        bindings: [
          {
            base: 'Boss',
            compare: 'Boss',
            status: 'changed',
            matched_by: 'id',
            tracks: [
              {
                track: 'Material Element 7（ComponentMaterialTrack）',
                status: 'changed',
                details: ['通道 溶解值：1 个关键帧的值变了（首个在第 1831 帧：1 → 0.5）']
              }
            ]
          },
          { base: 'Dog_02', status: 'only_in_base', track_count: 4 }
        ],
        unchanged_bindings: 1
      }
    )
    expect(text).toContain('帧率：30/1 → 60/1')
    expect(text).toContain('Material Element 7')
    expect(text).toContain('第 1831 帧：1 → 0.5')
    expect(text).toContain('Dog_02：对比序列里没有这个绑定')
  })

  /**
   * 目标绑定不在序列里时，状态可能由运行时组件接管。
   * 报成「缺失」会让人去补一条已经有人管的轨道，报成「已继承」则是替没查过的东西打包票
   */
  it('覆盖检查：目标不在序列里时说无法判断，不说缺失', async () => {
    const text = await run(
      { binding_map: [{ base: 'Dog_01', compare: 'DogDisplay_01' }] },
      {
        mode: 'coverage',
        coverage: [
          {
            base: 'Dog_01',
            compare: 'DogDisplay_01',
            status: 'compare_not_found',
            items: [{ track: 'CustomDepthStencilValue（FloatTrack）', status: 'unknown' }]
          }
        ]
      }
    )
    expect(text).toContain('无法判断')
    expect(text).toContain('缺失 0 条轨道')
  })

  it('覆盖检查：列出缺失和已适配，已继承只计数', async () => {
    const text = await run(
      { binding_map: [{ base: 'Dog_01', compare: 'DogDisplay_01' }] },
      {
        mode: 'coverage',
        coverage: [
          {
            base: 'Dog_01',
            compare: 'DogDisplay_01',
            status: 'compared',
            items: [
              { track: 'Transform（3DTransformTrack）', status: 'inherited' },
              { track: 'OverlayMaterial（ObjectPropertyTrack）', status: 'missing' },
              {
                track: 'Material Element 1（ComponentMaterialTrack）',
                status: 'adapted',
                details: ['段范围 [0, 60) → [0, 120)']
              }
            ],
            extra_in_compare: []
          }
        ]
      }
    )
    expect(text).toContain('已继承 1，已适配 1，缺失 1')
    expect(text).toContain('OverlayMaterial（ObjectPropertyTrack）：缺失')
    expect(text).not.toContain('Transform（3DTransformTrack）：')
  })

  it('截断时如实说', async () => {
    const text = await run({}, { mode: 'diff', bindings: [], truncated: true })
    expect(text).toContain('只列了前 150 个')
  })
})
