/**
 * @vitest-environment node
 *
 * 「沿一根轴排开一批尺寸不一的物体」的契约测试。
 *
 * 背景：把 8~20 栋建筑排成一条街，真机上连失败五次 —— 固定槽位塞不下、按标称尺寸
 * 推算把长宽看反、动态游标和探针法都栽在原点偏移上，最后靠拉大间距蒙混过去。
 * 同一个根因在这次会话里还导致了 19 个掩体浮空、4 面围墙没围住场地。
 *
 * 根因只有一个：`location` 填的是**原点**，而原点在几何体的哪个位置全看美术 ——
 * 引擎自带的 SM_Cube 在角上，外部包的模型常在几何中心。所以这里守的是一件事：
 *
 *   **排布结果和原点在哪无关。** 两个原点位置完全不同的物体排出来，
 *   边到边的间距必须都正好等于 gap。
 *
 * 这条守住了，上面那五次失败在这个写法下就不可能发生。
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

import { createSetTransformUnifiedTool } from './setTransformUnified'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }
const run = (input: unknown): Promise<ToolResult> =>
  (createSetTransformUnifiedTool() as unknown as Executable).execute(input)

type Vec = { x: number; y: number; z: number }

/**
 * 两个原点位置**完全不同**的物体，这是整个测试的支点：
 * - A：原点在角上（bounds_min 就是原点），Y 方向 100 厘米长
 * - B：原点在几何中心（bounds_min 比原点小 150），Y 方向 300 厘米长
 */
const CORNER_PIVOT = {
  name: 'A',
  path: '/L/A',
  transform: { location: { x: 0, y: 0, z: 0 } },
  bounds_min: { x: 0, y: 0, z: 0 },
  bounds_max: { x: 100, y: 100, z: 100 }
}
const CENTER_PIVOT = {
  name: 'B',
  path: '/L/B',
  transform: { location: { x: 0, y: 1000, z: 0 } },
  bounds_min: { x: -150, y: 850, z: -150 },
  bounds_max: { x: 150, y: 1150, z: 150 }
}

/** 每个物体的原点相对包围盒的偏移 —— 拿它把「新原点」还原成「新的边」 */
const pivotOffset = (actor: typeof CORNER_PIVOT, axis: 'x' | 'y'): number =>
  actor.transform.location[axis] - actor.bounds_min[axis]

const size = (actor: typeof CORNER_PIVOT, axis: 'x' | 'y'): number =>
  actor.bounds_max[axis] - actor.bounds_min[axis]

function mockEngine(actors: unknown[] = [CORNER_PIVOT, CENTER_PIVOT]): void {
  callRequest.mockImplementation(async (method: string) => {
    if (method === 'actor.get_info') return { actors }
    return { count: 1 }
  })
}

/** 发出去的每一次 set_transform 的目标位置，按调用顺序 */
const sentLocations = (): Vec[] =>
  callRequest.mock.calls
    .filter((c) => c[0] === 'actor.set_transform')
    .map((c) => (c[1] as { operation: { set: { location: Vec } } }).operation.set.location)

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('arrange：间距按包围盒边到边算', () => {
  it('原点在角上和原点在中心的两个物体，边到边的间距都正好是 gap', async () => {
    mockEngine()

    const result = await run({
      targets: { names: ['A', 'B'] },
      operation: { arrange: { axis: 'y', gap: 50, start: 0 } }
    })

    expect(result.success).toBe(true)
    const [locA, locB] = sentLocations()

    // 把发出去的「新原点」还原成「新的边」：新边 = 新原点 − 原点偏移
    const minA = locA!.y - pivotOffset(CORNER_PIVOT, 'y')
    const maxA = minA + size(CORNER_PIVOT, 'y')
    const minB = locB!.y - pivotOffset(CENTER_PIVOT, 'y')

    expect(minA).toBe(0) // start 给的就是这条边
    expect(minB - maxA).toBe(50) // ← 全部意义所在：间隙正好是 gap，两种原点都一样
  })

  it('不给 start 就从这批当前最靠前的那条边开始，不把整排挪走', async () => {
    mockEngine()
    await run({
      targets: { names: ['A', 'B'] },
      operation: { arrange: { axis: 'y', gap: 0 } }
    })

    const [locA] = sentLocations()
    // 当前最小边是 A 的 0，所以 A 原地不动
    expect(locA!.y).toBe(CORNER_PIVOT.transform.location.y)
  })

  it('align 把每个物体的 min 边贴到同一条线上（沿街、贴墙）', async () => {
    mockEngine()
    await run({
      targets: { names: ['A', 'B'] },
      operation: {
        arrange: { axis: 'y', gap: 50, start: 0, align: { axis: 'x', edge: 'min', value: -1310 } }
      }
    })

    const [locA, locB] = sentLocations()
    expect(locA!.x - pivotOffset(CORNER_PIVOT, 'x')).toBe(-1310)
    expect(locB!.x - pivotOffset(CENTER_PIVOT, 'x')).toBe(-1310)
  })

  it('给了 names 就按 names 的顺序排，不按当前坐标重排', async () => {
    mockEngine()
    // B 当前在 Y=1000，A 在 Y=0；按 names 要求 B 排在前面
    await run({
      targets: { names: ['B', 'A'] },
      operation: { arrange: { axis: 'y', gap: 0, start: 0 } }
    })

    const [first, second] = sentLocations()
    const minFirst = first!.y - pivotOffset(CENTER_PIVOT, 'y')
    const minSecond = second!.y - pivotOffset(CORNER_PIVOT, 'y')
    expect(minFirst).toBe(0)
    expect(minSecond).toBe(size(CENTER_PIVOT, 'y'))
  })
})

describe('arrange：算不出来的时候干净地停住', () => {
  it('插件没回包围盒时报错，一个 Actor 都不动', async () => {
    mockEngine([{ name: 'A', path: '/L/A', transform: { location: { x: 0, y: 0, z: 0 } } }])

    const result = await run({
      targets: { names: ['A'] },
      operation: { arrange: { axis: 'y', gap: 50 } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('包围盒')
    expect(sentLocations()).toHaveLength(0)
  })

  it('缺 axis 时不去问引擎，直接说要填什么', async () => {
    mockEngine()
    const result = await run({
      targets: { names: ['A'] },
      operation: { arrange: { gap: 50 } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('arrange.axis')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('排布轴和对齐轴相同时拒绝 —— 同一根轴不能既排开又对齐到一点', async () => {
    mockEngine()
    const result = await run({
      targets: { names: ['A'] },
      operation: { arrange: { axis: 'y', gap: 50, align: { axis: 'y', value: 0 } } }
    })

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('arrange 和 set 同时给时拒绝，不猜谁覆盖谁', async () => {
    mockEngine()
    const result = await run({
      targets: { names: ['A'] },
      operation: { arrange: { axis: 'y', gap: 50 }, set: { location: { z: 100 } } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('arrange')
    expect(callRequest).not.toHaveBeenCalled()
  })
})
