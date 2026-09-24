/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../defineUeTool', () => ({
  callUe: vi.fn()
}))

import { callUe } from '../defineUeTool'
import { createSequenceCameraKeysTool } from './cameraKeys'

const mockUe = vi.mocked(callUe)
const tool = createSequenceCameraKeysTool()

const KEYS = [
  { frame: 0, location: { x: 100, y: 0, z: 50 }, rotation: { roll: 0, pitch: -15, yaw: 180 } },
  { frame: 120, location: { x: -100, y: 0, z: 50 }, rotation: { roll: 0, pitch: -15, yaw: 360 } },
  { frame: 239, location: { x: 100, y: 0, z: 50 }, rotation: { roll: 0, pitch: -15, yaw: 540 } }
]

const OK = {
  sequence_path: '/Game/Cine/SQ_Shot01',
  camera_label: 'GlowBall_Cam',
  camera_created: true,
  sequence_created: true,
  key_count: 3,
  range: [0, 240],
  replaced_keys: 0,
  camera_cut_bound: true,
  kept_existing_cuts: false,
  removed_cut_sections: 0,
  level_saved: true,
  warnings: []
}

const call = (over: Record<string, unknown> = {}): Promise<unknown> =>
  tool.execute('c1', {
    sequence_path: '/Game/Cine/SQ_Shot01',
    camera_label: 'GlowBall_Cam',
    keys: KEYS,
    fps: 30,
    interpolation: 'linear',
    replace_existing_keys: true,
    camera_cuts: true,
    ...over
  })

const textOf = (r: unknown): string =>
  (r as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('')

/** 这次调用实际发给引擎的 RPC 载荷。迁到 C++ 之后，这才是 TS 侧的契约 */
const payloadOf = async (over: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  mockUe.mockResolvedValueOnce(OK)
  await call(over)
  return mockUe.mock.calls.at(-1)![1] as Record<string, unknown>
}

/** 这次调用打给引擎的方法名 */
const methodOf = async (over: Record<string, unknown> = {}): Promise<string> => {
  mockUe.mockResolvedValueOnce(OK)
  await call(over)
  return mockUe.mock.calls.at(-1)![0] as string
}

describe('元数据', () => {
  it('返回世界坐标和单位契约', async () => {
    mockUe.mockResolvedValueOnce(OK)
    const result = (await call()) as { details: { geometry: unknown } }
    expect(result.details.geometry).toEqual({
      space: 'world',
      length_unit: 'cm',
      rotation_unit: 'deg'
    })
    expect(textOf(result)).toContain('world 世界空间')
  })
  it('是改动类工具，要过审批门', () => {
    expect(tool.unrealBox.risk).toBe('mutating')
    expect(tool.unrealBox.namespace).toBe('ue.sequencer')
  })

  /**
   * 这个工具存在的全部理由：不预设镜头形状。
   * 描述里一旦出现「环绕/推轨要这么调」，就又变回替模型做创作决定了。
   */
  it('描述里说清轨迹由模型算，工具不预设形状', () => {
    expect(tool.description).toContain('轨迹由**你**来算')
    expect(tool.description).toContain('不预设任何镜头形状')
  })

  it('描述里把引擎事实和审美分开讲', () => {
    expect(tool.description).toContain('几件引擎的事，不是审美')
  })

  it('描述里说清它会覆盖已有曲线，以及怎么关掉', () => {
    expect(tool.description).toContain('会覆盖已有曲线')
    expect(tool.description).toContain('replace_existing_keys')
  })
})

/**
 * 迁到插件 C++ 之后，TS 侧只剩「拼对载荷」这一件事。
 *
 * 原来这里有一批断言在检查**生成的 Python 脚本文本**（存盘顺序、
 * `get_display_name` 前有没有 `str()`、`get_master_tracks` 的能力探测……）。
 * 那些行为现在住在 `UAL_SequencerCommands.cpp` 里，由编译器和引擎负责，
 * 断言字符串已经没有意义 —— 留着只会给人「测过了」的错觉。
 *
 * 它们对应的意图去了哪里：
 *   - 存盘顺序、覆盖计数、切轨重建 → `Handle_CameraKeys`
 *   - 绑定名取法（不再有 FText 的坑）→ `ResolveBindingName`
 *   - `get_master_tracks` 能力探测   → `UALCompat::GetRootTracks`（编译期重载决议）
 */
describe('发给引擎的 RPC 载荷', () => {
  it('打的是 sequence.camera_keys', async () => {
    expect(await methodOf()).toBe('sequence.camera_keys')
  })

  it('关键帧按帧号升序发出，不管调用方给的顺序', async () => {
    const payload = await payloadOf({
      keys: [
        { frame: 100, location: { x: 1, y: 2, z: 3 } },
        { frame: 0, location: { x: 4, y: 5, z: 6 } }
      ]
    })
    expect((payload.keys as { frame: number }[]).map((k) => k.frame)).toEqual([0, 100])
  })

  it('播放范围终点原样透传，不在 TS 侧自作主张', async () => {
    expect((await payloadOf({ playback_end_frame: 300 })).playback_end_frame).toBe(300)
    // 不给就不发，让引擎按「最后一帧 +1」算 —— 两边各算一次迟早会漂
    expect((await payloadOf({ keys: KEYS })).playback_end_frame).toBeUndefined()
  })

  it('插值方式透传，默认线性', async () => {
    expect((await payloadOf()).interpolation).toBe('linear')
    expect((await payloadOf({ interpolation: 'cubic' })).interpolation).toBe('cubic')
    expect((await payloadOf({ interpolation: 'constant' })).interpolation).toBe('constant')
  })

  it('camera_cuts / replace_existing_keys 如实透传', async () => {
    expect((await payloadOf({ camera_cuts: false })).camera_cuts).toBe(false)
    expect((await payloadOf({ replace_existing_keys: false })).replace_existing_keys).toBe(false)
  })
})

describe('返回给用户的话', () => {
  it('报出写到哪、几个键、覆盖什么范围', async () => {
    mockUe.mockResolvedValueOnce(OK)
    const text = textOf(await call())

    expect(text).toContain('/Game/Cine/SQ_Shot01')
    expect(text).toContain('GlowBall_Cam')
    expect(text).toContain('3 个关键帧')
    expect(text).toContain('[0, 240)')
  })

  /**
   * 覆盖用户已有的曲线是允许的，但必须说 —— 而且要说在前面。
   * 不说的话用户是在下一次打开 Sequencer 时才发现自己的东西没了。
   */
  it('清掉了旧关键帧时必须报出来', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, replaced_keys: 48 })
    expect(textOf(await call())).toContain('原有的 48 个关键帧已被清掉')
  })

  it('切轨没绑上时说清现在是黑的', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, camera_cut_bound: false })
    expect(textOf(await call())).toContain('渲出来是黑的')
  })

  it('关卡没存盘时说清 —— 相机随时会连人带绑定一起没', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, level_saved: false })
    expect(textOf(await call())).toContain('关卡**未**保存')
  })

  it('提醒模型自查', async () => {
    mockUe.mockResolvedValueOnce(OK)
    expect(textOf(await call())).toContain('sequence_audit')
  })

  it('序列存盘结果照引擎说：成功才说已存盘，失败要说，旧插件不报就不提', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, sequence_saved: true })
    expect(textOf(await call())).toContain('序列已存盘')

    mockUe.mockResolvedValueOnce({ ...OK, sequence_saved: false })
    const failed = textOf(await call())
    expect(failed).toContain('序列**没**存盘成功')
    expect(failed).not.toContain('序列已存盘')

    mockUe.mockResolvedValueOnce(OK)
    expect(textOf(await call())).not.toContain('存盘')
  })

  /** 键数以插件从通道读回的为准，不是请求里给了几个 */
  it('轨道键数和写入数对不上时两个都报', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, written_keys: 3, key_count: 5 })
    expect(textOf(await call({ replace_existing_keys: false }))).toContain(
      '写入 3 个关键帧，轨道上现有 5 个'
    )
  })

  it('有键被跳过时第一句不是成功，逐条列出原因', async () => {
    mockUe.mockResolvedValueOnce({
      ...OK,
      key_count: 2,
      written_keys: 2,
      skipped_keys: 1,
      skipped_key_reasons: [{ index: 1, reason: '第 120 帧 location 和 rotation 都没给' }]
    })
    const text = textOf(await call())

    expect(text.split('\n')[0]).toBe(
      '⚠️ 部分完成：2 个关键帧成功 / 0 个关键帧失败 / 1 个关键帧跳过。'
    )
    expect(text).toContain('按帧排序后的第 2 个键：第 120 帧 location 和 rotation 都没给')
  })

  it('失败时带上原因', async () => {
    mockUe.mockRejectedValueOnce(new Error('创建序列失败'))
    await expect(call()).rejects.toThrow(/创建序列失败/)
  })

  it('引擎回了空结果时报错，不谎报成功', async () => {
    mockUe.mockResolvedValueOnce({})
    await expect(call()).rejects.toThrow()
  })
})

describe('输入校验', () => {
  it('少于两个关键帧直接拒绝 —— 一个键构不成运动', async () => {
    await expect(call({ keys: [KEYS[0]] })).rejects.toThrow()
  })

  /**
   * 引擎的 AddLinearKey / AddCubicKey / AddConstantKey 底下都是
   * `InsertKeyInternal`，它只做 `Algo::UpperBound` + `Insert`，**不去重**
   * （`MovieSceneCurveChannelImpl.cpp`）。同帧两个键会两个都留下，
   * 切线按零时间差算，求值取哪个不定 —— 而且没有任何报错。
   */
  it('同一帧给两个键必须在发出去之前拒掉', async () => {
    await expect(call({ keys: [KEYS[0], { ...KEYS[1], frame: 0 }, KEYS[2]] })).rejects.toThrow(
      /第 0 帧/
    )

    expect(mockUe).not.toHaveBeenCalled()
  })

  it('拒绝时要说清怎么改，而不只是说不行', async () => {
    await expect(call({ keys: [KEYS[0], { ...KEYS[1], frame: 0 }] })).rejects.toThrow(
      /每帧只给一个键/
    )
  })

  it('乱序但不重复的帧照常放行', async () => {
    mockUe.mockResolvedValueOnce(OK)
    await expect(call({ keys: [KEYS[2], KEYS[0], KEYS[1]] })).resolves.toBeDefined()
    expect(mockUe).toHaveBeenCalled()
  })
})

/**
 * 切轨上已有的段不默认删。
 *
 * 用户要的是「给这台相机打一串关键帧」，不是「把我排好的多机位剪辑抹掉」。
 * 见 `red-lines.md` 第 1、3 条。
 */
describe('rebuild_camera_cuts 开关', () => {
  it('默认不带，等于不许删', async () => {
    mockUe.mockResolvedValueOnce(OK)
    await call()
    expect(mockUe.mock.calls.at(-1)![1]).toMatchObject({ rebuild_camera_cuts: false })
  })

  it('有意没动已有切轨时，不能说成「没建成」', async () => {
    // 两件事的下一步完全不一样：一个要用户去排剪辑，一个要重试
    mockUe.mockResolvedValueOnce({
      ...OK,
      camera_cut_bound: false,
      kept_existing_cuts: true
    })
    const text = textOf(await call())

    expect(text).toContain('已有的段没有动')
    expect(text).not.toContain('渲出来是黑的')
  })

  it('真的没建成时照旧警告会黑屏', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, camera_cut_bound: false })
    expect(textOf(await call())).toContain('渲出来是黑的')
  })

  it('删掉了切轨段要报数并说清撤不回来', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, removed_cut_sections: 2 })
    const text = textOf(await call({ rebuild_camera_cuts: true }))

    expect(text).toContain('2 个切轨段已被删除')
    expect(text).toContain('撤不回来')
  })
})

describe('关卡存盘如实上报', () => {
  it('复用已有相机时不说「关卡已保存」—— 根本没动过关卡', async () => {
    // 说成已保存，用户会以为关卡里别的未保存改动也落盘了
    mockUe.mockResolvedValueOnce({ ...OK, camera_created: false, level_saved: true })
    const text = textOf(await call())

    expect(text).toContain('没有改动关卡')
    expect(text).not.toContain('关卡已保存')
  })

  it('新建相机且存盘失败时明说未保存', async () => {
    mockUe.mockResolvedValueOnce({ ...OK, camera_created: true, level_saved: false })
    expect(textOf(await call())).toContain('**未**保存')
  })
})
