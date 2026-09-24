/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../defineUeTool', () => ({
  callUe: vi.fn()
}))

import { callUe } from '../defineUeTool'
import { createSequenceCameraCutsTool } from './cameraCuts'

const mockUe = vi.mocked(callUe)
const tool = createSequenceCameraCutsTool()

const OK = {
  sequence_path: '/Game/Cine/SQ_BallOrbit',
  camera_binding: 'GlowBall_OrbitCam',
  range: [0, 240],
  already_covered: false,
  binding_broken: false,
  removed_sections: 0,
  sequence_saved: true,
  warnings: []
}

const call = (over: Record<string, unknown> = {}): Promise<unknown> =>
  tool.execute('c1', { sequence_path: '/Game/Cine/SQ_BallOrbit', ...over })

const textOf = (r: unknown): string =>
  (r as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('')

/** 这次调用实际发给引擎的方法名与载荷。迁到 C++ 之后，这才是 TS 侧的契约 */
const callArgs = async (
  over: Record<string, unknown> = {}
): Promise<[string, Record<string, unknown>]> => {
  mockUe.mockResolvedValueOnce(OK)
  await call(over)
  const args = mockUe.mock.calls.at(-1)!
  return [args[0] as string, args[1] as Record<string, unknown>]
}

describe('元数据', () => {
  it('是改动类工具，要过审批门', () => {
    expect(tool.unrealBox.risk).toBe('mutating')
    expect(tool.unrealBox.namespace).toBe('ue.sequencer')
  })

  it('描述里说清它不做重新绑定，也说清为什么', () => {
    expect(tool.description).toContain('不做 possessable 的重新绑定')
    expect(tool.description).toContain('不会假装修好')
  })
})

/**
 * 迁到插件 C++ 之后，TS 侧只剩「拼对载荷」这一件事。
 *
 * 原来这里有一批断言在检查**生成的 Python 脚本文本**。那些行为现在住在
 * `UAL_SequencerCommands.cpp` 的 `Handle_CameraCuts` 里，断言字符串没有意义了 ——
 * 留着只会给人「测过了」的错觉。
 *
 * 它们对应的意图去了哪里：
 *   - 切轨盖满播放范围、已盖满就不改 → `Handle_CameraCuts`
 *   - 多台相机不替用户挑（返回 409 + candidates）→ 同上
 *   - 拿不到编辑器世界不把好绑定判成坏的 → `UALCompat::LocateBoundObjects` 的返回值
 *   - `get_master_tracks` 能力探测 → `UALCompat::GetRootTracks`（编译期重载决议）
 *   - 绑定名取法（不再有 FText 的坑）→ `ResolveBindingName`
 */
describe('发给引擎的 RPC 载荷', () => {
  it('打的是 sequence.camera_cuts', async () => {
    const [method] = await callArgs()
    expect(method).toBe('sequence.camera_cuts')
  })

  it('camera_label 原样透传', async () => {
    const [, payload] = await callArgs({ camera_label: 'Cam_A' })
    expect(payload.camera_label).toBe('Cam_A')
  })

  it('不给 camera_label 时不发这个字段，由引擎自己判定', async () => {
    const [, payload] = await callArgs()
    expect(payload.camera_label).toBeUndefined()
  })

  it('序列路径原样透传', async () => {
    const [, payload] = await callArgs()
    expect(payload.sequence_path).toBe('/Game/Cine/SQ_BallOrbit')
  })
})

describe('返回给用户的话', () => {
  it('报出补到哪条序列、切给谁、覆盖多少', async () => {
    mockUe.mockResolvedValueOnce(OK)
    const text = textOf(await call())

    expect(text).toContain('/Game/Cine/SQ_BallOrbit')
    expect(text).toContain('GlowBall_OrbitCam')
    expect(text).toContain('[0, 240)')
  })

  it('本来就盖满时说清没有改动，不谎报干了活', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, already_covered: true })
    const text = textOf(await call())

    expect(text).toContain('本来就盖满')
    expect(text).toContain('没有改动')
  })

  /**
   * 最重要的一条。绑定是坏的时候补完切轨渲出来照样是黑的 ——
   * 只说「已补上」会让用户以为修好了，比不修更糟。
   */
  it('绑定已失效时，必须跟上手动重绑的步骤', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, binding_broken: true })
    const text = textOf(await call())

    expect(text).toContain('照样是黑的')
    expect(text).toContain('Rebind Possessable References')
    expect(text).toContain('Assign Actor')
  })

  it('提醒模型自查', async () => {
    mockUe.mockResolvedValueOnce(OK)
    expect(textOf(await call())).toContain('sequence_audit')
  })

  /** 存盘结果以引擎回的为准：插件原来丢掉 SavePackages 的返回值，这里无条件说「已存盘」 */
  it('插件说存盘成功才说已存盘', async () => {
    mockUe.mockResolvedValueOnce(OK)
    expect(textOf(await call())).toContain('序列已存盘')
  })

  it('存盘失败时说没存上，不说已存盘', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, sequence_saved: false, removed_sections: 2 })
    const text = textOf(await call({ rebuild: true }))

    expect(text).toContain('没**存盘成功')
    expect(text).not.toContain('序列已存盘')
    expect(text).not.toContain('撤不回来')
  })

  it('旧插件不报 sequence_saved 时不替它说已存盘', async () => {
    const legacy: Record<string, unknown> = { ...OK, removed_sections: 1 }
    delete legacy.sequence_saved
    mockUe.mockResolvedValueOnce(legacy)
    const text = textOf(await call({ rebuild: true }))

    expect(text).not.toContain('已存盘')
    expect(text).toContain('1 个切轨段已被删除')
  })

  it('失败时带上原因', async () => {
    mockUe.mockRejectedValueOnce(new Error('这条序列里一条绑定都没有'))
    await expect(call()).rejects.toThrow(/一条绑定都没有/)
  })

  it('引擎回了空结果时报错，不谎报成功', async () => {
    mockUe.mockResolvedValueOnce({})
    await expect(call()).rejects.toThrow()
  })
})

/**
 * 删除是撤不回来的，所以默认不删。
 *
 * 这个工具「补全」的做法是把切轨上已有的段全删了换成一整段。之前它无条件这么干：
 * 一条排好的三机位序列只要有一帧对不齐，调一次就只剩一台相机，而且没有事务、
 * 存盘即成事实。`red-lines.md` 第 1、3 条写着「只报告不动手」「删除永远由用户发起」。
 */
describe('rebuild 开关', () => {
  it('默认不带 rebuild，等于不许删', async () => {
    const [, payload] = await callArgs()
    expect(payload.rebuild).toBe(false)
  })

  it('点名了才传 true', async () => {
    const [, payload] = await callArgs({ rebuild: true })
    expect(payload.rebuild).toBe(true)
  })

  it('删掉了用户的段必须报数，并说清撤不回来', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, removed_sections: 3 })
    const text = textOf(await call({ rebuild: true }))

    expect(text).toContain('3 个切轨段已被删除')
    expect(text).toContain('撤不回来')
  })

  it('什么都没删时不提删除，别制造不存在的疑虑', async () => {
    mockUe.mockResolvedValueOnce(OK)
    expect(textOf(await call())).not.toContain('已被删除')
  })

  it('描述里写明它会删、以及怎么才会删', () => {
    expect(tool.description).toContain('全删掉')
    expect(tool.description).toContain('rebuild')
  })
})
