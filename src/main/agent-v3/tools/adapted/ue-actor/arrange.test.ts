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

/** get_info 照常，但第 n 次 set_transform（从 1 数）回一个引擎失败 */
function mockEngineFailingAt(n: number, actors: unknown[] = [CORNER_PIVOT, CENTER_PIVOT]): void {
  let moves = 0
  callRequest.mockImplementation(async (method: string) => {
    if (method === 'actor.get_info') return { actors }
    moves += 1
    return moves === n
      ? { ok: false, error: 'No actor found matching the specified names/paths' }
      : { count: 1 }
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

  /**
   * 引擎报错是 **resolve 不是 throw** —— `services/websocket/server.ts` 把 code>=400
   * 规范化成 `{ok:false, success:false, error}` 原样返回。所以「await 了没抛异常」
   * 不等于「改成功了」。不看回包的话，「这个 Actor 刚被改名了，404」和真的挪好了
   * 在调用方眼里一模一样，而回执还会加一句「不用再逐个回读位置」。
   */
  it('引擎回 ok:false 时不许报成功，并说清已经挪了几个', async () => {
    mockEngineFailingAt(2)

    const result = await run({
      targets: { names: ['A', 'B'] },
      operation: { arrange: { axis: 'y', gap: 50, start: 0 } }
    })

    expect(result.success).toBe(false)
    // 发了两次，但只有第一次引擎确认动了 —— 报的是确认数，不是请求数。
    // 结构化数据要放 details：适配层只转发 error/code/details，顶层字段会被丢掉
    const details = result.details as Record<string, unknown>
    expect(details.moved).toBe(1)
    expect(details.requested).toBe(2)
    expect(sentLocations()).toHaveLength(2)
    // 重试要能原地接上，否则游标会从已经挪过的那批重新起算
    expect(String(result.error)).toContain('start: 0')
    expect(String(result.error)).toContain('不会回滚')
  })

  it('名字一个都没对上时报错，不返回 Infinity/NaN 的「成功」', async () => {
    // 引擎按 filter 命中了别的 Actor，names 里那个拼错了
    mockEngine([{ ...CORNER_PIVOT, name: 'Other' }])

    const result = await run({
      targets: { names: ['wall_typo'] },
      operation: { arrange: { axis: 'y', gap: 50 } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('wall_typo')
    expect(JSON.stringify(result)).not.toContain('Infinity')
    expect(JSON.stringify(result)).not.toContain('NaN')
    expect(sentLocations()).toHaveLength(0)
  })

  it('名字只对上一半也拒绝 —— 少排一栋的街看起来完全正常', async () => {
    mockEngine()
    const result = await run({
      targets: { names: ['A', 'H2_typo', 'B'] },
      operation: { arrange: { axis: 'y', gap: 50, start: 0 } }
    })

    expect(result.success).toBe(false)
    expect(result.unmatched_targets).toEqual(['H2_typo'])
    expect(sentLocations()).toHaveLength(0)
  })

  /** 引擎的名字匹配不分大小写，回给我们的是 GetActorLabel() 的原样大小写 */
  it('大小写不同的名字照样认得出来', async () => {
    mockEngine()
    const result = await run({
      targets: { names: ['a', 'b'] },
      operation: { arrange: { axis: 'y', gap: 50, start: 0 } }
    })

    expect(result.success).toBe(true)
    expect(sentLocations()).toHaveLength(2)
  })

  /** 名字不唯一（getActor.ts 明写着「path 是唯一的，名字不是」） */
  it('重名不会把同一个 Actor 摆两次', async () => {
    mockEngine([CORNER_PIVOT])
    const result = await run({
      targets: { names: ['A', 'A'] },
      operation: { arrange: { axis: 'y', gap: 50, start: 0 } }
    })

    // 池子里只有一个 A，第二个 A 对不上 —— 报出来，而不是把那一个摆两次
    expect(result.success).toBe(false)
    expect(result.unmatched_targets).toEqual(['A'])
  })

  it('get_info 失败时报真实错误，不说成「你没选中东西」', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'actor.get_info') {
        return { ok: false, error: 'Unknown filter key: klass', __rpc: { code: 400 } }
      }
      return { count: 1 }
    })

    const result = await run({
      targets: { filter: { klass: 'Light' } },
      operation: { arrange: { axis: 'y', gap: 50 } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('Unknown filter key')
    expect(String(result.error)).not.toContain('没有选中任何 Actor')
  })

  it('align.axis 写成大写就报错，不静默算出 NaN', async () => {
    mockEngine()
    const result = await run({
      targets: { names: ['A'] },
      operation: { arrange: { axis: 'y', gap: 50, align: { axis: 'X', value: -1310 } } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('align.axis')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('align.edge 拼错就报错，不静默退回 min', async () => {
    mockEngine()
    const result = await run({
      targets: { names: ['A'] },
      operation: {
        arrange: { axis: 'y', gap: 50, align: { axis: 'x', edge: 'centre', value: 0 } }
      }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('align.edge')
  })

  /**
   * 模型把嵌套对象序列化成字符串是这个文件从头就在防的事。`gap: "200"` 原来会
   * 静默变成 0：20 栋楼严丝合缝贴在一起，success 照报，回执还说「间距 0 厘米」——
   * 自洽得看不出毛病，只有截图才发现。
   */
  it('gap / start 给成字符串就报错，不静默当默认值', async () => {
    mockEngine()
    const gapResult = await run({
      targets: { names: ['A'] },
      operation: { arrange: { axis: 'y', gap: '200' } }
    })
    expect(gapResult.success).toBe(false)
    expect(String(gapResult.error)).toContain('arrange.gap')

    const startResult = await run({
      targets: { names: ['A'] },
      operation: { arrange: { axis: 'y', gap: 0, start: '-800' } }
    })
    expect(startResult.success).toBe(false)
    expect(String(startResult.error)).toContain('arrange.start')
    expect(callRequest).not.toHaveBeenCalled()
  })

  /**
   * 名字一个都没对上时引擎回的是 404，不是「200 + 空 actors」——
   * 插件只把 filter 那条翻译成 200 空列表。原来这会走到「查询失败」那一支，
   * 回一句英文，而且 404 会被适配层抛成 EngineNotFoundError。
   */
  it('全部名字都没对上（引擎 404）也走同一句中文指引', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'actor.get_info') {
        return {
          ok: false,
          error: 'No actor found matching the specified names/paths',
          __rpc: { code: 404 }
        }
      }
      return { count: 1 }
    })

    const result = await run({
      targets: { names: ['Wall_A', 'Wall_B'] },
      operation: { arrange: { axis: 'y', gap: 50 } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('Wall_A')
    expect(String(result.error)).toContain('不会少排几个凑合过去')
    expect(result.unmatched_count).toBe(2)
  })

  it('没有几何体的 Actor 不劝人去升级插件', async () => {
    // 插件无条件发 bounds，只在包围盒有效时才发 min/max —— 点光源永远没有
    mockEngine([
      {
        name: 'PointLight_1',
        path: '/L/PointLight_1',
        transform: { location: { x: 0, y: 0, z: 0 } },
        bounds: { x: 0, y: 0, z: 0 }
      }
    ])

    const result = await run({
      targets: { names: ['PointLight_1'] },
      operation: { arrange: { axis: 'y', gap: 50 } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('没有可量的包围盒')
    expect(String(result.error)).not.toContain('升级引擎插件')
  })

  it('重名点两次时说「不够用」，不说「没找到」', async () => {
    // 引擎按名字只解析得出一个（FindActorByLabel 取第一个命中，结果进 TSet）
    mockEngine([CORNER_PIVOT])
    const result = await run({
      targets: { names: ['A', 'A'] },
      operation: { arrange: { axis: 'y', gap: 50, start: 0 } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('不够用')
    expect(String(result.error)).toContain('targets.paths')
    expect(String(result.error)).not.toContain('在关卡里没找到')
  })

  it('names 给成裸字符串时报错，不逐字符去找', async () => {
    mockEngine()
    const result = await run({
      targets: { names: 'MyCube' },
      operation: { arrange: { axis: 'y', gap: 50 } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('targets.names')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('names 里混了非字符串也报错，不抛 TypeError', async () => {
    mockEngine()
    const result = await run({
      targets: { names: ['A', 123] },
      operation: { arrange: { axis: 'y', gap: 50 } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('targets.names')
  })

  it('space 和 arrange 同时给时拒绝，不默默按世界坐标排', async () => {
    mockEngine()
    const result = await run({
      targets: { names: ['A'] },
      operation: { space: 'Local', arrange: { axis: 'y', gap: 50 } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('space')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('超过 100 个时按真实总数报，不报被截断的数', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({
      ...CORNER_PIVOT,
      name: `A${i}`,
      path: `/L/A${i}`
    }))
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'actor.get_info') return { actors: many, total_found: 500 }
      return { count: 1 }
    })

    const result = await run({
      targets: { filter: {} },
      operation: { arrange: { axis: 'y', gap: 50 } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('500')
    expect(sentLocations()).toHaveLength(0)
  })

  it('names 和 filter 混着给时拒绝，不把筛出来的那些悄悄丢掉', async () => {
    mockEngine()
    const result = await run({
      targets: { names: ['A'], filter: { class: 'StaticMeshActor' } },
      operation: { arrange: { axis: 'y', gap: 50 } }
    })

    expect(result.success).toBe(false)
    expect(sentLocations()).toHaveLength(0)
  })
})

describe('arrange：中止与世界归属', () => {
  /**
   * 守的是「不再往场景里写」这一件事，**不是回执**。
   *
   * 回执到不了模型：适配层把 execute 包在 `runAbortable` 里，那是一场
   * `Promise.race`，abort 一触发就立刻 reject 成 ToolAbortedError，我们这个
   * return 慢一个微任务，永远输。这个用例直接调 execute（绕开适配层），
   * 所以它能看到返回值 —— 但生产环境看不到，别据此以为模型会拿到 moved。
   */
  it('用户按停止之后不再往场景里写', async () => {
    mockEngine()
    const controller = new AbortController()
    let moves = 0
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'actor.get_info') return { actors: [CORNER_PIVOT, CENTER_PIVOT] }
      moves += 1
      controller.abort() // 第一个刚挪完，用户就按了停止
      return { count: 1 }
    })

    const tool = createSetTransformUnifiedTool() as unknown as {
      execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<ToolResult>
    }
    const result = await tool.execute(
      { targets: { names: ['A', 'B'] }, operation: { arrange: { axis: 'y', gap: 50, start: 0 } } },
      { abortSignal: controller.signal }
    )

    expect(result.aborted).toBe(true)
    expect((result.details as Record<string, unknown>).moved).toBe(1)
    expect(moves).toBe(1) // 第二个没发出去 —— 这条才是生产环境真正依赖的
  })

  /** PIE 里排完就没了，不说一声的话模型会把「改成功了」原样转述给用户 */
  it('PIE 世界要在回执里点出来', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'actor.get_info') {
        return {
          actors: [CORNER_PIVOT],
          world: 'pie',
          world_note: '改动不落盘，停止 PIE 就没了'
        }
      }
      return { count: 1 }
    })

    const result = await run({
      targets: { names: ['A'] },
      operation: { arrange: { axis: 'y', gap: 0, start: 0 } }
    })

    expect(result.success).toBe(true)
    expect(result.world).toBe('pie')
    expect(String(result.message)).toContain('游戏正在运行')
    expect(String(result.message)).toContain('停止 PIE 就没了')
  })
})
