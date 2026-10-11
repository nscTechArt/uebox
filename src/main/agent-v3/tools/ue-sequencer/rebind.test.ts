/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../defineUeTool', () => ({
  callUe: vi.fn()
}))

import { callUe } from '../defineUeTool'
import { createSequenceRebindTool } from './rebind'

const mockUe = vi.mocked(callUe)
const tool = createSequenceRebindTool()

const OK = {
  sequence_path: '/Game/Cine/SQ_Intro',
  binding_guid: '1A2B3C4D-0000-0000-0000-000000000001',
  previous_name: 'CineCam',
  binding_name: 'CineCam',
  was_broken: true,
  actor_label: 'CineCam',
  actor_path: '/Game/Maps/Intro.Intro:PersistentLevel.CineCameraActor_3',
  actor_class: 'CineCameraActor',
  resolved: true,
  broken_components: [],
  sequence_saved: true
}

const call = (over: Record<string, unknown> = {}): Promise<unknown> =>
  tool.execute('c1', {
    sequence_path: '/Game/Cine/SQ_Intro',
    binding: 'CineCam',
    actor: 'CineCam',
    ...over
  })

const textOf = (r: unknown): string =>
  (r as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('')

describe('元数据', () => {
  it('是改动类工具，串行', () => {
    expect(tool.unrealBox.risk).toBe('mutating')
    expect(tool.unrealBox.namespace).toBe('ue.sequencer')
  })

  it('描述里说清它不猜：同名就拒绝，拿不准就问用户', () => {
    expect(tool.description).toContain('不猜')
    expect(tool.description).toContain('问用户')
  })
})

describe('发给引擎的载荷', () => {
  it('发 sequence.rebind，class 变更默认不放开', async () => {
    mockUe.mockResolvedValueOnce(OK)
    await call()
    const [method, params] = mockUe.mock.calls.at(-1)!
    expect(method).toBe('sequence.rebind')
    expect(params).toMatchObject({
      sequence_path: '/Game/Cine/SQ_Intro',
      binding: 'CineCam',
      actor: 'CineCam',
      allow_class_change: false
    })
  })
})

describe('回执', () => {
  /** 回执跟着引擎走：绑定名、Actor 都用引擎读回来的，不回显入参 */
  it('报引擎读回的 Actor 和绑定名，不是入参', async () => {
    mockUe.mockResolvedValueOnce({
      ...OK,
      previous_name: 'Camera',
      binding_name: 'CineCam_2',
      actor_label: 'CineCam_2',
      was_broken: false,
      previous_actor: 'CineCam_Old'
    })
    const text = textOf(await call({ actor: '/Game/Maps/Intro.Intro:PersistentLevel.Cam' }))
    expect(text).toContain('CineCam_2')
    expect(text).toContain('「Camera」→「CineCam_2」')
    expect(text).toContain('原来指向「CineCam_Old」')
    expect(text).toContain('序列已存盘')
  })

  it('子组件绑定断了要逐条报，不能只说成功', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, broken_components: ['CameraComponent', 'Mesh'] })
    const text = textOf(await call())
    expect(text).toContain('2 条组件子绑定')
    expect(text).toContain('CameraComponent、Mesh')
  })

  it('没存上盘要说在第一段里', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, sequence_saved: false })
    const text = textOf(await call())
    expect(text.split('\n')[0]).toContain('没**存盘成功')
  })

  it('引擎的警告原样带出（如 Actor 所在关卡没保存）', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, warnings: ['「CineCam」所在的关卡还有未保存的改动。'] })
    const text = textOf(await call())
    expect(text).toContain('⚠️ 「CineCam」所在的关卡还有未保存的改动。')
  })

  it('同名 Actor 多个时引擎拒绝，错误和候选一起抛给模型', async () => {
    mockUe.mockRejectedValueOnce(
      new Error('sequence.rebind 失败：关卡里有 2 个 Actor 都叫「Cam」（错误码 409）\n详情：{...}')
    )
    await expect(call({ actor: 'Cam' })).rejects.toThrow('2 个 Actor 都叫')
  })
})
