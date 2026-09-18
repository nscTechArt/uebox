/**
 * @vitest-environment node
 *
 * 关卡组成与流送设置的契约测试。
 *
 * 这两个工具存在的唯一理由是回答「编辑器里好好的、运行起来不一样」。
 * 所以最要紧的不是字段透传对不对，而是**结论有没有被说出来**：
 * 一个 mismatch=editor_only 的子关卡，如果只是躺在返回的数组里而没进
 * summary，模型多半不会逐条读数组，那这两个工具就等于没加 ——
 * 它会照旧去翻材质和 bHidden，正是 2026-09-07 那次白走的路。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { createGetLevelsTool, createSetLevelStreamingTool } from './levelStreaming'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const exec = (factory: () => unknown, input: unknown = {}): Promise<ToolResult> =>
  (factory() as unknown as Executable).execute(input)

/** L_BaseEnvironment 那一档：编辑器看得见，游戏里不加载 */
const EDITOR_ONLY_LEVEL = {
  package: '/Game/Studio/L_BaseEnvironment',
  name: 'L_BaseEnvironment',
  streaming_class: 'LevelStreamingDynamic',
  always_loaded: false,
  should_be_loaded: false,
  should_be_visible: true,
  visible_at_runtime: false,
  visible_in_editor: true,
  is_loaded: true,
  is_visible: true,
  actor_count: 31,
  mismatch: 'editor_only',
  mismatch_reason: 'not_loaded'
}

/** 加载了、在跑，只是没显示 —— 和上面那种是两种病，药也不一样 */
const HIDDEN_LEVEL = {
  ...EDITOR_ONLY_LEVEL,
  package: '/Game/Studio/L_Audio',
  name: 'L_Audio',
  should_be_loaded: true,
  should_be_visible: false,
  visible_at_runtime: false,
  mismatch_reason: 'loaded_but_hidden'
}

/**
 * 这些桩必须是插件**真的能发出来**的形状。
 *
 * 第一版的桩不是：它把 visible_at_runtime 和 visible_in_editor 写成两个不同的值，
 * 而当时的插件在编辑器世界里让这两个字段恒等（读的都是编辑器那一位），于是
 * 十四条用例全绿、功能在主用法上恒定失效。桩要是能编出后端编不出的东西，
 * 它测的就不是后端。
 *
 * 现在插件把 visible_at_runtime 定义成 should_be_visible && should_be_loaded，
 * 这条推导跨编辑器世界和游戏世界都成立 —— 所以这里直接钉住它。
 */
function assertEmittable(level: typeof EDITOR_ONLY_LEVEL): void {
  expect(level.visible_at_runtime).toBe(level.should_be_visible && level.should_be_loaded)
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('测试桩本身', () => {
  it('每个桩都是插件能真的发出来的形状', () => {
    assertEmittable(EDITOR_ONLY_LEVEL)
    assertEmittable(HIDDEN_LEVEL)
  })
})

describe('ue_get_levels', () => {
  /**
   * 这条是整个文件里最重要的测试 —— 它就是这两个工具立项的那个案例。
   *
   * 结论必须出现在 summary 里，而且要带上「不是材质、不是 bHidden」这层
   * 排除，否则模型拿到清单还是会先去翻那两样。
   */
  it('把「编辑器看得见、游戏不加载」的子关卡直接点名', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      persistent: { package: '/Game/Studio/L_Studio', name: 'L_Studio', actor_count: 6 },
      is_world_partition: false,
      streaming_level_count: 1,
      streaming_levels: [EDITOR_ONLY_LEVEL],
      editor_only_levels: ['L_BaseEnvironment'],
      game_only_levels: []
    })

    const result = await exec(createGetLevelsTool)

    expect(result.success).toBe(true)
    expect(result.editor_only_levels).toEqual(['L_BaseEnvironment'])

    const summary = String(result.summary)
    expect(summary).toContain('L_BaseEnvironment')
    // 结论本身
    expect(summary).toContain('游戏里不会加载')
    // 排除掉那两条最容易白走的路
    expect(summary).toContain('材质')
    expect(summary).toContain('bHidden')
    // 下一步怎么做，不说的话模型只能请用户自己去点 Levels 窗格
    expect(summary).toContain('ue_set_level_streaming')
  })

  /**
   * 「加载了但没显示」得说成另一件事，并开另一副药。
   *
   * 说成「游戏里不加载」的话，调用方会去开 always_loaded —— 而那个开关
   * 碰不到 should_be_visible，于是回读依旧对不上，它就再试一次。
   */
  it('加载了但没显示的那种，要和「不加载」分开说', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      persistent: { package: '/Game/Studio/L_Studio', name: 'L_Studio', actor_count: 6 },
      streaming_level_count: 1,
      streaming_levels: [HIDDEN_LEVEL],
      editor_only_levels: ['L_Audio'],
      game_only_levels: []
    })

    const summary = String((await exec(createGetLevelsTool)).summary)

    expect(summary).toContain('L_Audio')
    expect(summary).toContain('会加载、但不显示')
    expect(summary).toContain('should_be_visible=true')
    // 这一句是关键：不能建议它去改流送方式
    expect(summary).not.toContain('设成 always_loaded=true')
  })

  it('World Partition 运行时格子不进点名清单，但要说有多少个', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      persistent: { package: '/Game/Maps/Open', name: 'Open', actor_count: 900 },
      is_world_partition: true,
      streaming_level_count: 0,
      streaming_levels: [],
      editor_only_levels: [],
      game_only_levels: [],
      world_partition_runtime_cells: 42
    })

    const summary = String((await exec(createGetLevelsTool)).summary)

    expect(summary).toContain('42')
    expect(summary).toContain('临时对象')
  })

  it('反方向也要点名：编辑器里藏着但游戏里会出现', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      persistent: { package: '/Game/Maps/Main', name: 'Main', actor_count: 12 },
      streaming_level_count: 1,
      streaming_levels: [{ ...EDITOR_ONLY_LEVEL, mismatch: 'game_only' }],
      editor_only_levels: [],
      game_only_levels: ['L_Gameplay']
    })

    const summary = String((await exec(createGetLevelsTool)).summary)

    expect(summary).toContain('L_Gameplay')
    expect(summary).toContain('突然冒出来')
  })

  /**
   * World Partition 关卡没有 StreamingLevels 数组。不说清楚的话，
   * 「0 个子关卡」会被读成「这张图只有一层」，而 WP 恰恰是
   * 「编辑器看得见、运行时不一定加载」的另一种成因。
   */
  it('World Partition 关卡的 0 个子关卡要解释清楚', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      persistent: { package: '/Game/Maps/Open', name: 'Open', actor_count: 900 },
      is_world_partition: true,
      streaming_level_count: 0,
      streaming_levels: [],
      editor_only_levels: [],
      game_only_levels: []
    })

    const summary = String((await exec(createGetLevelsTool)).summary)

    expect(summary).toContain('World Partition')
    expect(summary).toContain('正常')
  })

  it('两边一致时要明说一致，不能只是不提', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      persistent: { package: '/Game/Maps/Main', name: 'Main', actor_count: 3 },
      streaming_level_count: 2,
      streaming_levels: [],
      editor_only_levels: [],
      game_only_levels: []
    })

    expect(String((await exec(createGetLevelsTool)).summary)).toContain('一致')
  })

  /** PIE 跑着时读的是游戏世界，这件事必须透传，否则结论会被当成关卡的原始摆放 */
  it('PIE 时透传 world 字段', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      persistent: { package: '/Game/Maps/Main', name: 'Main', actor_count: 3 },
      streaming_level_count: 0,
      streaming_levels: [],
      editor_only_levels: [],
      game_only_levels: [],
      world: 'pie',
      world_note: '读写的是正在运行的游戏世界。'
    })

    const result = await exec(createGetLevelsTool)

    expect(result.world).toBe('pie')
    expect(String(result.summary)).toContain('游戏正在运行')
  })

  it('没连引擎时不发请求', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await exec(createGetLevelsTool)

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('ue_set_level_streaming', () => {
  it('只把给了的字段发出去', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      level: '/Game/Studio/L_BaseEnvironment',
      before: EDITOR_ONLY_LEVEL,
      after: {
        ...EDITOR_ONLY_LEVEL,
        always_loaded: true,
        should_be_loaded: true,
        visible_at_runtime: true,
        mismatch: 'none',
        mismatch_reason: undefined
      },
      changed: ['always_loaded', 'should_be_loaded'],
      undoable: false
    })

    await exec(createSetLevelStreamingTool, { level: 'L_BaseEnvironment', always_loaded: true })

    expect(callRequest.mock.calls[0][0]).toBe('level.set_streaming')
    expect(callRequest.mock.calls[0][1]).toEqual({
      level: 'L_BaseEnvironment',
      always_loaded: true
    })
  })

  /**
   * 「设进去了」和「生效了」是两回事。回读还是 editor_only 就必须说 ——
   * 报一句「已设为固定加载」而 PIE 里照旧是黑的，是最糟的那种成功。
   */
  it('回读仍然对不上时当场说出来', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      level: '/Game/Studio/L_BaseEnvironment',
      before: EDITOR_ONLY_LEVEL,
      after: EDITOR_ONLY_LEVEL,
      changed: ['should_be_visible'],
      undoable: true
    })

    const summary = String(
      (
        await exec(createSetLevelStreamingTool, {
          level: 'L_BaseEnvironment',
          should_be_visible: true
        })
      ).summary
    )

    expect(summary).toContain('仍然是编辑器可见、游戏里不加载')
    expect(summary).toContain('always_loaded=true')
  })

  /**
   * `changed` 是空的就等于什么都没改到。
   *
   * 插件那边现在按 before/after 逐字段比来算 changed，所以空数组是可信的信号；
   * 不说出来的话，模型会把一次纯粹的空转当成「已修好」，然后去验一个没改过的场景。
   */
  it('changed 为空时明说什么都没变', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      level: '/Game/Studio/L_BaseEnvironment',
      before: EDITOR_ONLY_LEVEL,
      after: EDITOR_ONLY_LEVEL,
      changed: [],
      undoable: true,
      needs_save: false
    })

    const summary = String(
      (
        await exec(createSetLevelStreamingTool, {
          level: 'L_BaseEnvironment',
          should_be_loaded: false
        })
      ).summary
    )

    expect(summary).toContain('实际上什么都没变')
    // 什么都没改就不该催人保存
    expect(summary).not.toContain('ue_save_level')
  })

  /** 加载了但没显示的那种，别再劝人去开 always_loaded */
  it('回读是 loaded_but_hidden 时开的是另一副药', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      level: '/Game/Studio/L_Audio',
      before: HIDDEN_LEVEL,
      after: HIDDEN_LEVEL,
      changed: [],
      undoable: true,
      needs_save: false
    })

    const summary = String(
      (await exec(createSetLevelStreamingTool, { level: 'L_Audio', always_loaded: true })).summary
    )

    expect(summary).toContain('会加载、但仍然不显示')
    expect(summary).toContain('should_be_visible=true')
  })

  it('换流送方式撤不回来这件事要说', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      level: '/Game/Studio/L_BaseEnvironment',
      before: EDITOR_ONLY_LEVEL,
      after: {
        ...EDITOR_ONLY_LEVEL,
        streaming_class: 'LevelStreamingAlwaysLoaded',
        always_loaded: true,
        should_be_loaded: true,
        visible_at_runtime: true,
        mismatch: 'none'
      },
      changed: ['always_loaded'],
      undoable: false
    })

    const summary = String(
      (await exec(createSetLevelStreamingTool, { level: 'L_BaseEnvironment', always_loaded: true }))
        .summary
    )

    expect(summary).toContain('撤不回来')
    // 流送设置在持久关卡的包里，不存就白改
    expect(summary).toContain('ue_save_level')
  })

  /** 插件没回读到状态时不许说成功，宁可说「没确认上」 */
  it('插件没回 after 就不谎称改好了', async () => {
    callRequest.mockResolvedValue({ ok: true, level: '/Game/Studio/L_BaseEnvironment' })

    const summary = String(
      (await exec(createSetLevelStreamingTool, { level: 'L_BaseEnvironment', always_loaded: true }))
        .summary
    )

    expect(summary).toContain('没有确认上')
    expect(summary).toContain('ue_get_levels')
  })

  /** 名字找不到时要把候选列出来，否则模型只能反复猜名字 */
  it('找不到关卡时列出这张图里有哪些子关卡', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: 'No single streaming level matches "L_Base".',
      details: { available_levels: ['/Game/Studio/L_BaseEnvironment', '/Game/Studio/L_Props'] }
    })

    const result = await exec(createSetLevelStreamingTool, { level: 'L_Base' })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('/Game/Studio/L_BaseEnvironment')
    expect(String(result.error)).toContain('/Game/Studio/L_Props')
  })
})
