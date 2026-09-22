/**
 * @vitest-environment node
 *
 * `ue_focus_viewport` 的契约测试。
 *
 * 重点全在**说错了不会报错、只会让模型拿着一张没用的图下结论**的那几条：
 *   - 相机没停稳时必须说出来（截图会拍到半路）
 *   - 目标在编辑器里隐藏时必须说出来（镜头对了，画面是空的）
 *   - 包围盒炸开导致机位跑到几公里外时必须说出来
 *   - 默认只动当前视口，不能悄悄把用户的四视图全抢走
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

import { createFocusViewportTool, summarizeFocus } from './focusViewport'
import { lastViewportMove, resetViewportProvenance } from './viewportProvenance'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const focus = (input: unknown): Promise<ToolResult> =>
  (createFocusViewportTool() as unknown as Executable).execute(input)

/** 一次「一切正常」的插件响应，各用例只覆盖自己关心的字段 */
const okResponse = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: true,
  focused: ['BP_Chair'],
  camera: {
    location: { x: 100, y: 0, z: 200 },
    rotation: { pitch: -30, yaw: 0, roll: 0 },
    fov: 90
  },
  moved: true,
  transition_settled: true,
  is_perspective: true,
  is_active_viewport: true,
  distance: 300,
  ...extra
})

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
  resetViewportProvenance()
})

describe('请求构造', () => {
  it('names 包进 targets，默认只动当前视口', async () => {
    callRequest.mockResolvedValue(okResponse())

    await focus({ names: ['BP_Chair'] })

    const [command, params] = callRequest.mock.calls[0]
    expect(command).toBe('viewport.focus')
    expect(params).toEqual({ targets: { names: ['BP_Chair'] }, all_viewports: false })
  })

  it('all_viewports 要显式传 true 才会开 —— 默认抢走用户全部视口是不可接受的', async () => {
    callRequest.mockResolvedValue(okResponse())

    await focus({ names: ['BP_Chair'], all_viewports: true })

    expect(callRequest.mock.calls[0][1].all_viewports).toBe(true)
  })

  it('selection 模式不带 names', async () => {
    callRequest.mockResolvedValue(okResponse())

    await focus({ selection: true })

    expect(callRequest.mock.calls[0][1].targets).toEqual({ selection: true })
  })

  it('没连引擎时直接说清楚，不发请求', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await focus({ names: ['BP_Chair'] })

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('把「看着成功其实没用」的情况说出来', () => {
  it('相机还没停稳 —— 这时候截图会拍到半路', async () => {
    callRequest.mockResolvedValue(okResponse({ transition_settled: false }))

    const result = await focus({ names: ['BP_Chair'] })

    expect(result.success).toBe(true)
    expect(result.transition_settled).toBe(false)
    expect(String(result.message)).toContain('还在移动')
  })

  it('目标在编辑器里是隐藏的 —— 镜头对过去了但画面是空的', async () => {
    callRequest.mockResolvedValue(okResponse({ hidden_in_editor: ['BP_Chair'] }))

    const result = await focus({ names: ['BP_Chair'] })

    expect(result.success).toBe(true)
    expect(String(result.message)).toContain('隐藏')
    expect(String(result.message)).toContain('看不见')
  })

  it('相机根本没动', async () => {
    callRequest.mockResolvedValue(okResponse({ moved: false }))

    const result = await focus({ names: ['BP_Chair'] })

    expect(String(result.message)).toContain('没变')
    // 没动就不记 —— 否则截图会说「视口最后是它动的」，而它什么都没干
    expect(lastViewportMove()).toBeNull()
  })

  /** 动了视口就记一笔，ue_screenshot 拍视口时会说「最后是 ue_focus_viewport 对准 BP_Chair」 */
  it('动了视口就记下是谁、对准了什么', async () => {
    callRequest.mockResolvedValue(okResponse({ region: 'bottom' }))

    await focus({ names: ['BP_Chair'], region: 'bottom' })

    expect(lastViewportMove()).toMatchObject({
      tool: 'ue_focus_viewport',
      detail: '对准 BP_Chair 的 bottom'
    })
  })

  it('机位跑到几公里外 —— 包围盒被巨大组件撑开的典型症状', async () => {
    callRequest.mockResolvedValue(okResponse({ distance: 800000 }))

    const result = await focus({ names: ['Landscape'] })

    expect(String(result.message)).toContain('偏远')
  })

  it('正交视口下要提醒，那不是透视视角', async () => {
    callRequest.mockResolvedValue(okResponse({ is_perspective: false }))

    const result = await focus({ names: ['BP_Chair'] })

    expect(String(result.message)).toContain('正交')
  })

  it('距离正常时不要平白吓唬人', async () => {
    callRequest.mockResolvedValue(okResponse({ distance: 420 }))

    const result = await focus({ names: ['BP_Chair'] })

    expect(String(result.message)).not.toContain('偏远')
  })
})

describe('失败路径', () => {
  it('目标在隐藏关卡里 —— 插件回 409，原样透传给模型', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: '目标都在隐藏的关卡里。先在关卡面板里把关卡显示出来再聚焦',
      __rpc: { code: 409 },
      details: { hidden_levels: ['SubLevel_A'] }
    })

    const result = await focus({ names: ['BP_Chair'] })

    expect(result.success).toBe(false)
    expect(result.code).toBe(409)
    expect(String(result.error)).toContain('隐藏的关卡')
  })

  it('名字没匹配上时说清楚认的是大纲名字', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: 'targets 没匹配到任何 Actor。names 认的是大纲里显示的名字（ActorLabel）',
      __rpc: { code: 404 }
    })

    const result = await focus({ names: ['StaticMeshActor_3'] })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('ActorLabel')
  })

  it('请求抛异常时不吞掉', async () => {
    callRequest.mockRejectedValue(new Error('连接断开'))

    const result = await focus({ names: ['BP_Chair'] })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('连接断开')
  })
})

describe('看局部（region / direction / distance）', () => {
  it('不给这三个参数就一个都不发 —— 让插件端去选走引擎还是自己定机位', async () => {
    callRequest.mockResolvedValue(okResponse())

    await focus({ names: ['SM_OakTree2'] })

    expect(callRequest.mock.calls[0][1]).toEqual({
      targets: { names: ['SM_OakTree2'] },
      all_viewports: false
    })
  })

  it('看树干：region=bottom 原样传下去', async () => {
    callRequest.mockResolvedValue(okResponse({ region: 'bottom' }))

    await focus({ names: ['SM_OakTree2'], region: 'bottom' })

    expect(callRequest.mock.calls[0][1].region).toBe('bottom')
    // direction 没给就不传 —— 默认值由插件端定（region 非 whole 时是 horizontal）
    expect(callRequest.mock.calls[0][1].direction).toBeUndefined()
  })

  it('direction 和 distance 给了才传', async () => {
    callRequest.mockResolvedValue(okResponse())

    await focus({ names: ['A'], direction: 'horizontal', distance: 300 })

    const params = callRequest.mock.calls[0][1]
    expect(params.direction).toBe('horizontal')
    expect(params.distance).toBe(300)
  })

  it('看的是哪一截要说出来，不然人和模型都不知道这张图拍的是什么', async () => {
    callRequest.mockResolvedValue(okResponse({ region: 'bottom' }))

    const result = await focus({ names: ['SM_OakTree2'], region: 'bottom' })

    expect(String(result.message)).toContain('下部')
  })
})

describe('截图之前的两道体检', () => {
  it('相机没朝着目标时明确警告 —— 这正是那次连拍五六张全歪的症状', async () => {
    callRequest.mockResolvedValue(
      okResponse({ aim: { point: { x: 0, y: 0, z: 0 }, error_degrees: 87, on_target: false } })
    )

    const result = await focus({ names: ['SM_OakTree2'], region: 'bottom' })

    expect(result.success).toBe(true)
    expect(String(result.message)).toContain('并没有朝着目标')
    expect(String(result.message)).toContain('87')
  })

  it('朝向没问题时不要平白报警', async () => {
    callRequest.mockResolvedValue(
      okResponse({ aim: { point: { x: 0, y: 0, z: 0 }, error_degrees: 0.2, on_target: true } })
    )

    const result = await focus({ names: ['A'] })

    expect(String(result.message)).not.toContain('并没有朝着目标')
  })

  it('视线被别的东西挡住', async () => {
    callRequest.mockResolvedValue(okResponse({ occluded_by: 'SM_Wall', occluded_by_self: false }))

    const result = await focus({ names: ['A'] })

    expect(String(result.message)).toContain('SM_Wall')
    expect(String(result.message)).toContain('挡住')
  })

  it('被目标自己挡住（树冠裹住树干）要说清楚是自遮挡，并给下一步', async () => {
    callRequest.mockResolvedValue(
      okResponse({ occluded_by: 'SM_OakTree2', occluded_by_self: true })
    )

    const result = await focus({ names: ['SM_OakTree2'], region: 'bottom' })

    expect(String(result.message)).toContain('目标自己')
    expect(String(result.message)).toContain('region')
  })

  it('包围盒原样带回来，省得再单独调查询工具', async () => {
    const bounds = {
      center: { x: 0, y: 0, z: 400 },
      extent: { x: 300, y: 300, z: 400 },
      min: { x: -300, y: -300, z: 0 },
      max: { x: 300, y: 300, z: 800 },
      radius: 583,
      height: 800
    }
    callRequest.mockResolvedValue(okResponse({ bounds }))

    const result = await focus({ names: ['SM_OakTree2'] })

    expect(result.bounds).toEqual(bounds)
  })
})

describe('summarizeFocus', () => {
  it('一切正常时只说对准了谁和镜头朝哪，不堆废话', () => {
    // 镜头朝向那一句是刻意加的：真机上参考机位漂成仰视后截回一片天，
    // 三个裸角度看不出来，这一句看得出
    expect(summarizeFocus(okResponse() as never)).toBe(
      '镜头已对准 BP_Chair。镜头朝 +X 方向，俯视 30°'
    )
  })

  it('镜头仰得高要提醒画面多半是天空', () => {
    const text = summarizeFocus(
      okResponse({ camera: { rotation: { pitch: 33.6, yaw: 0, roll: 0 } } }) as never
    )
    expect(text).toContain('仰视 34°')
    expect(text).toContain('天空')
  })

  it('多个目标一起列出来', () => {
    const text = summarizeFocus(okResponse({ focused: ['A', 'B'] }) as never)
    expect(text).toContain('A、B')
  })

  it('跳过的隐藏关卡也要报，不能静默丢弃', () => {
    const text = summarizeFocus(
      okResponse({ focused: ['A'], skipped_hidden_levels: ['B'] }) as never
    )
    expect(text).toContain('B')
    expect(text).toContain('跳过')
  })
})
