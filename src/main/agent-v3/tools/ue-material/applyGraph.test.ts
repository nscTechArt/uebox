/**
 * @vitest-environment node
 *
 * 一次写完整张材质图。
 *
 * 这个工具存在的理由是把三件本该由工具形状保证的事从 skill 里收回来：
 *   1. 模型不用记引擎返回的 node_id（用自己起的局部 id 连线）
 *   2. 建完自动排版、自动编译（原来靠 skill 提醒「最后 tidy 一次」）
 *   3. 半路失败时如实报出已经落地了什么 —— 引擎侧没有原子写入，回滚不了
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import {
  createMaterialApplyGraphTool,
  describeChannelMaskProblem,
  describeValueMismatch
} from './applyGraph'
import { WebSocketErrorCode, WebSocketServiceError } from '../../../services/websocket/types'

const tool = createMaterialApplyGraphTool()

const callsTo = (method: string): Record<string, unknown>[] =>
  callRequest.mock.calls.filter((c) => c[0] === method).map((c) => c[1] as Record<string, unknown>)

const textOf = (r: unknown): string =>
  (r as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('')

/** 默认：add_node 依次返回 Node_0、Node_1…，其余命令回空对象 */
function mockEngine(overrides: Record<string, unknown> = {}): void {
  let seq = 0
  callRequest.mockImplementation(async (method: string) => {
    if (method in overrides) return overrides[method]
    if (method === 'material.add_node') return { node_id: `Node_${seq++}` }
    if (method === 'material.get_graph') return { nodes: [], connections: [] }
    if (method === 'material.compile') return { compiled: true, errors: [], warnings: [] }
    return {}
  })
}

const TWO_NODES = {
  path: '/Game/M_Wood',
  nodes: [
    { id: 'base', node_type: 'Constant3Vector', value: { r: 0.8, g: 0.1, b: 0.1 } },
    { id: 'rough', node_type: 'ScalarParameter', node_name: 'Roughness', value: 0.4 }
  ],
  connections: [
    { from: 'base.Default', to: 'Material.BaseColor' },
    { from: 'rough.Default', to: 'Material.Roughness' }
  ]
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

/**
 * 建之前先整批过一遍。
 *
 * 引擎那几道 400 是逐节点的，而这里是一个一个发、失败即停、**不回滚**：
 * 二十个节点的图第十二个才违规，前十一个已经落进用户的材质里了。
 * 能在客户端判的就不该跑到引擎再说 —— 判在这里，失败是干净的。
 */
describe('发命令之前的整批预检', () => {
  /** 预检失败走的是 isError 那条路，pi 会把它抛出来 —— 接住拿文本 */
  const runWith = async (nodes: unknown[]): Promise<{ text: string; calls: number }> => {
    mockEngine()
    let text: string
    try {
      text = textOf(await tool.execute('c1', { path: '/Game/M_Wood', nodes, connections: [] }))
    } catch (error) {
      text = error instanceof Error ? error.message : String(error)
    }
    return { text, calls: callRequest.mock.calls.length }
  }

  it('参数节点缺 node_name：一条命令都不发', async () => {
    const { text, calls } = await runWith([
      { id: 'ok', node_type: 'Constant', value: 1 },
      { id: 'bad', node_type: 'ScalarParameter' }
    ])
    expect(text).toContain('bad')
    expect(text).toContain('node_name')
    // 干净失败 —— 前面那个 Constant 也不许建出来
    expect(calls).toBe(0)
  })

  it('ComponentMask 缺 value：同样挡在发命令之前', async () => {
    const { text, calls } = await runWith([{ id: 'm', node_type: 'ComponentMask' }])
    expect(text).toContain('ComponentMask')
    expect(calls).toBe(0)
  })

  it('id 重复也在预检里挡，不再是发到一半才发现', async () => {
    const { text, calls } = await runWith([
      { id: 'dup', node_type: 'Constant', value: 1 },
      { id: 'dup', node_type: 'Constant', value: 2 }
    ])
    expect(text).toContain('id 重复')
    expect(calls).toBe(0)
  })

  it('合法的图照常放行', async () => {
    mockEngine()
    const r = await tool.execute('c1', TWO_NODES)
    expect(textOf(r)).not.toContain('❌')
    expect(callsTo('material.add_node')).toHaveLength(2)
  })

  /**
   * 上一次调用的局部 id 拿到这次来用 —— 真机上为这个连失败四次。
   *
   * 引擎回的是 404「Source node not found: uvco」，字面意思是「图里没这个节点」，
   * 而真正的原因是「这个 id 是上次调用的，用完就失效了」。两者听起来一样，
   * 但前者会让人去图里找节点，后者要去上一次的回执里拿真实 node_id ——
   * 猜错方向就是一整轮。更糟的是这条 404 来自 connect 阶段，那时节点已经全建完，
   * 而材质这边**不回滚**。挡在建节点之前，失败才是干净的。
   */
  it('端点是上次调用的局部 id：挡在建节点之前，且点破为什么', async () => {
    mockEngine()
    let text: string
    try {
      text = textOf(
        await tool.execute('c1', {
          path: '/Game/M_Wood',
          nodes: [{ id: 'base', node_type: 'Constant3Vector', value: '#fff' }],
          connections: [{ from: 'uvco.RGB', to: 'base.A' }]
        })
      )
    } catch (error) {
      text = error instanceof Error ? error.message : String(error)
    }

    expect(text).toContain('uvco')
    expect(text).toContain('只在这一次调用里有效')
    expect(text).toContain('material_get_graph')
    // 那个 Constant3Vector 也不许建出来
    expect(callRequest.mock.calls.length).toBe(0)
  })

  /**
   * 坏的通道串也要在**发命令之前**挡住。
   *
   * 之前只测了「没给 value」，于是把 preflight 的这一段换成
   * `if (!node.value) throw` 照样全绿 —— 而 "GR" 会一路走到引擎那道 400，
   * 那是逐节点的、不回滚的，前面的节点已经落进用户的材质了。
   */
  it('通道串换序（GR）在发命令之前就挡住', async () => {
    const { text, calls } = await runWith([
      { id: 'ok', node_type: 'Constant', value: 1 },
      { id: 'm', node_type: 'ComponentMask', value: 'GR' }
    ])
    expect(text).toContain('换了序')
    expect(calls).toBe(0)
  })
})

/**
 * 编译那一步失败时，**已经建好了什么**不能跟着丢。
 *
 * 建节点和连线都走 fail()（带着 node_id 映射），排版也包了，只有编译是裸的：
 * 它会 404（材质被改名/回收）、会超时。一旦抛出去，模型只剩一句
 * 「material.compile 失败」，然后照着本工具「不要整张重发」的反方向重来一遍。
 */
describe('编译失败不吃掉主报告', () => {
  it('compile 抛异常时，节点和 guid 照样报出来', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'material.compile') throw new Error('Material not found: /Game/M_Wood')
      if (method === 'material.add_node') return { node_id: 'Node_0', guid: 'GUID-0' }
      if (method === 'material.get_graph') return { nodes: [], connections: [] }
      return {}
    })

    const text = textOf(
      await tool.execute('c1', {
        path: '/Game/M_Wood',
        nodes: [{ id: 'base', node_type: 'Constant', value: 1 }],
        connections: []
      })
    )

    expect(text).toContain('新建 1 个节点')
    expect(text).toContain('GUID-0')
    expect(text).toContain('别整张重发')
  })
})

/**
 * 标志缺失 ≠ 成功。老插件不回 `initial_value_applied` 也不回读 `value`，
 * `undefined === false` 是 false，于是一句警告都不报 —— 而插件自己的注释写着
 * 这个参数曾经**从来没生效过、全程 200**，正好就是这种插件。
 */
describe('初始值确认不了时要说出来', () => {
  it('老插件既不回标志也不回读值 → 明说确认不了', async () => {
    mockEngine({ 'material.add_node': { node_id: 'Node_0' } })
    const text = textOf(
      await tool.execute('c1', {
        path: '/Game/M_Wood',
        nodes: [{ id: 'base', node_type: 'Constant', value: 0.2 }],
        connections: []
      })
    )
    expect(text).toContain('没法确认')
  })

  it('回读了 value 就不再唠叨', async () => {
    mockEngine({ 'material.add_node': { node_id: 'Node_0', value: 0.2 } })
    const text = textOf(
      await tool.execute('c1', {
        path: '/Game/M_Wood',
        nodes: [{ id: 'base', node_type: 'Constant', value: 0.2 }],
        connections: []
      })
    )
    expect(text).not.toContain('没法确认')
  })

  it('没给 value 的节点不该冒出这条警告', async () => {
    mockEngine({ 'material.add_node': { node_id: 'Node_0' } })
    const text = textOf(
      await tool.execute('c1', {
        path: '/Game/M_Wood',
        nodes: [{ id: 'mul', node_type: 'Multiply' }],
        connections: []
      })
    )
    expect(text).not.toContain('没法确认')
  })
})

/**
 * 通道串的规则必须和插件的 `UAL_ParseChannelMask` 一字不差。
 *
 * 这一份存在的理由就是「别等引擎那道 400」——两边判得不一样，工具要么比引擎窄
 * （合法的写法被本地拦掉），要么在骗人（本地放行、引擎再拒，而那时节点已经建了一半）。
 * 所以这里按表钉死，不靠「跑一遍看看」。
 */
describe('ComponentMask 通道串', () => {
  const accept = ['R', 'G', 'B', 'A', 'RG', 'RGB', 'RGBA', 'GB', 'RA', 'XY', 'XYZW', 'rg']
  const reject: Array<[string, string]> = [
    ['GR', '换序'],
    ['RR', '重复'],
    ['AR', '换序'],
    ['RGBAA', '重复'],
    ['', '空串'],
    ['Q', '不是通道的字母'],
    ['R,G', '标点'],
    // 原型链上的键不能被当成合法通道 —— order 是普通对象字面量
    ['constructor', '原型键'],
    ['__proto__', '原型键']
  ]

  for (const value of accept) {
    it(`收下 "${value}"`, () => {
      expect(describeChannelMaskProblem(value)).toBe('')
    })
  }
  for (const [value, why] of reject) {
    it(`拒绝 "${value}"（${why}）`, () => {
      expect(describeChannelMaskProblem(value)).not.toBe('')
    })
  }

  it('不是字符串也要拒绝', () => {
    expect(describeChannelMaskProblem(undefined)).not.toBe('')
    expect(describeChannelMaskProblem(1)).not.toBe('')
  })
})

describe('元数据', () => {
  it('是改动类工具，且串行 —— 并发写同一张图会互相覆盖', () => {
    expect(tool.unrealBox.risk).toBe('mutating')
    expect((tool as unknown as { executionMode?: string }).executionMode).toBe('sequential')
  })

  /*
   * 原来这里断言描述里出现「已经下线」，连带要求它点名 material_add_node /
   * material_connect_pins。那两个名字在注册表里已经不存在了，写在常驻描述里
   * 等于教模型去调一个不存在的工具（`toolNameReferences.test.ts` 守这件事）。
   * 所以改成断言**意思还在**：只有这一条路、而且那条路是故意没有的。
   */
  it('描述里明说写图只有这一条路，逐节点那条是故意没有的', () => {
    expect(tool.description).toContain('只有这一个工具')
    expect(tool.description).toContain('故意没有')
  })

  it('描述里说清失败不回滚，别整张重发', () => {
    expect(tool.description).toContain('不会回滚')
    expect(tool.description).toContain('重复节点')
  })
})

describe('一次调用把图写完', () => {
  it('建节点 → 连线 → 排版 → 编译，一个都不少', async () => {
    mockEngine()
    await tool.execute('c1', TWO_NODES)

    expect(callsTo('material.add_node')).toHaveLength(2)
    expect(callsTo('material.connect_pins')).toHaveLength(2)
    expect(callsTo('material.compile')).toHaveLength(1)
  })

  it('局部 id 换成引擎返回的真实 node_id 再连线', async () => {
    mockEngine()
    await tool.execute('c1', TWO_NODES)

    const [first, second] = callsTo('material.connect_pins')
    expect(first!.source_node).toBe('Node_0')
    expect(first!.source_pin).toBe('Default')
    // 材质主节点是保留 id，不参与映射
    expect(first!.target_node).toBe('Material')
    expect(first!.target_pin).toBe('BaseColor')
    expect(second!.source_node).toBe('Node_1')
  })

  /**
   * 主节点别名不分大小写 —— 插件那侧是 `TargetNode == TEXT("Material")`，
   * 而 UE 的 `FString::operator==` 走 Stricmp。前置校验要是用 JS 的严格 ===
   * 去比，就凭空比引擎窄一档：一个本来能跑的写法被挡在门外，报的还是
   * 「这是上次调用的局部 id」这么个完全不沾边的理由。
   */
  it('主节点写成小写 material 也认，并归一化成保留写法', async () => {
    mockEngine()
    await tool.execute('c1', {
      path: '/Game/M_Wood',
      nodes: [],
      connections: [{ from: 'TextureSample_7.RGB', to: 'material.BaseColor' }]
    })

    // 归一化在 splitEndpoint 里做，预检和 connect() 因此不会错开
    expect(callsTo('material.connect_pins')[0]!.target_node).toBe('Material')
  })

  /**
   * 把局部 id 起名叫 material 的话，连到它的线会被当成接主输出，
   * 这个节点从此指不到 —— 而且一个字都不报。当场拦住。
   */
  it('局部 id 叫 material 时拒绝，不让它顶掉主输出', async () => {
    mockEngine()
    let text: string
    try {
      text = textOf(
        await tool.execute('c1', {
          path: '/Game/M_Wood',
          nodes: [{ id: 'material', node_type: 'Constant', value: 1 }],
          connections: []
        })
      )
    } catch (error) {
      text = error instanceof Error ? error.message : String(error)
    }

    expect(text).toContain('保留写法')
    expect(callRequest.mock.calls.length).toBe(0)
  })

  it('图里已有的真实 node_id 可以直接连，不必是本次新建的', async () => {
    mockEngine()
    await tool.execute('c1', {
      path: '/Game/M_Wood',
      nodes: [],
      connections: [{ from: 'TextureSample_7.RGB', to: 'Material.Normal' }]
    })

    expect(callsTo('material.connect_pins')[0]!.source_node).toBe('TextureSample_7')
  })

  it('回执给出局部 id → 真实 id 的对应，排查全靠它', async () => {
    mockEngine()
    const r = (await tool.execute('c1', TWO_NODES)) as { content: unknown }
    const details = (r as unknown as { details?: { node_ids: Record<string, string> } }).details

    expect(details?.node_ids).toEqual({ base: 'Node_0', rough: 'Node_1' })
  })

  /**
   * `material_get_graph` 对没有名字的输入引脚回的是 `<0>` 这种写法。
   * 引脚名限成 `[A-Za-z0-9_]+` 的话，那些引脚从此连不上 ——
   * 工具比它背后的 material.connect_pins 窄，等于凭空少了一块能力。
   */
  it('引脚名带尖括号也连得上，只在第一个点上切', async () => {
    mockEngine()
    await tool.execute('c1', {
      path: '/Game/M_Wood',
      nodes: [],
      connections: [{ from: 'Constant_0.<0>', to: 'MaterialFunctionCall_1.Base Color' }]
    })

    const [conn] = callsTo('material.connect_pins')
    expect(conn!.source_node).toBe('Constant_0')
    expect(conn!.source_pin).toBe('<0>')
    expect(conn!.target_pin).toBe('Base Color')
  })

  it('tidy=false 时不排版，compile=false 时不编译', async () => {
    mockEngine()
    await tool.execute('c1', { ...TWO_NODES, tidy: false, compile: false })

    expect(callsTo('material.set_node_positions')).toHaveLength(0)
    expect(callsTo('material.compile')).toHaveLength(0)
  })
})

describe('引擎埋在响应体里的失败必须冒出来', () => {
  // add_node 回 200 + node_id，但贴图/初始值/集合没接上时只有一个 *_applied: false。
  // 批量之后如果不收集，这些警告就彻底消失了
  it('贴图没设上要报出来', async () => {
    mockEngine({ 'material.add_node': { node_id: 'Node_0', texture_applied: false } })
    const text = textOf(
      await tool.execute('c1', {
        path: '/Game/M_Wood',
        nodes: [{ id: 'tex', node_type: 'TextureSample', texture_path: '/Game/T_Missing' }],
        connections: []
      })
    )

    expect(text).toContain('贴图没设上')
    expect(text).toContain('tex')
  })

  it('初始值没设上要报出来，不能让模型以为值已经对了', async () => {
    mockEngine({
      'material.add_node': {
        node_id: 'Node_0',
        initial_value_applied: false,
        initial_value_error: '类型不匹配'
      }
    })
    const text = textOf(
      await tool.execute('c1', {
        path: '/Game/M_Wood',
        nodes: [{ id: 'c', node_type: 'Constant', value: 1 }],
        connections: []
      })
    )

    expect(text).toContain('初始值没设上')
    expect(text).toContain('类型不匹配')
  })

  it('编译失败要顶到最前面，不能当成功报', async () => {
    mockEngine({
      'material.compile': { compiled: false, errors: ['Missing input on Multiply'], warnings: [] }
    })
    const text = textOf(await tool.execute('c1', TWO_NODES))

    expect(text).toContain('编译失败')
    expect(text).toContain('Missing input on Multiply')
  })
})

describe('半路失败：说清停在哪、已经建了什么', () => {
  it('连线失败时报出已建成的节点，并明说不要整张重发', async () => {
    let added = 0
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'material.add_node') return { node_id: `Node_${added++}` }
      if (method === 'material.connect_pins') throw new Error('引脚 Defaultt 不存在')
      return {}
    })

    const message = await tool.execute('c1', TWO_NODES).then(
      () => '没有抛错',
      (e: Error) => e.message
    )

    expect(message).toContain('停在「连线」')
    expect(message).toContain('引脚 Defaultt 不存在')
    expect(message).toContain('base→Node_0')
    expect(message).toContain('不会回滚')
    expect(message).toContain('不要整张重发')
  })

  /**
   * 连线写法要在**发第一条命令之前**判掉，节点一个都不许建。
   *
   * 用 `nodes: []` 测这条是测不出来的：没有节点要建，`connect_pins` 本来就不会发，
   * 把检查挪回 `connect()` 里也照样绿。而这条检查存在的全部理由，
   * 正是「二十个节点建完了才发现连线写错，还不回滚」。所以必须带上真节点，
   * 断言的也不是「没发连线」，是**一条命令都没发**。
   */
  it('连线写法不对时一条命令都不发 —— 节点也不许建出来', async () => {
    mockEngine()
    const message = await tool
      .execute('c1', {
        path: '/Game/M_Wood',
        nodes: [{ id: 'base', node_type: 'Constant3Vector', value: { r: 1, g: 0, b: 0 } }],
        connections: [{ from: 'base', to: 'Material.BaseColor' }]
      })
      .then(
        (r) => textOf(r),
        (e: Error) => e.message
      )

    expect(message).toContain('节点id.引脚名')
    expect(callRequest.mock.calls).toHaveLength(0)
  })

  it('局部 id 重复时拦住 —— 否则后一个会把前一个的映射覆盖掉', async () => {
    mockEngine()
    const message = await tool
      .execute('c1', {
        path: '/Game/M_Wood',
        nodes: [
          { id: 'a', node_type: 'Constant' },
          { id: 'a', node_type: 'Constant' }
        ],
        connections: []
      })
      .then(
        () => '没有抛错',
        (e: Error) => e.message
      )

    expect(message).toContain('节点 id 重复')
  })

  /*
   * 回读校验。
   *
   * 这一组的重点有一半在**不许误报**：假警报会让模型掉头去查一个不存在的问题，
   * 比不报还糟（本仓库在 from_type/to_type 上已经栽过一次）。所以形状对不上、
   * 或者两边写法本来就不同（贴图路径、通道拼写）的，一律不许出声。
   */
  describe('初始值回读对不对得上', () => {
    it('数值对得上就不吭声，对不上要说出来', () => {
      expect(describeValueMismatch(0.4, 0.4)).toBe('')
      expect(describeValueMismatch(0.4, 0.4000001)).toBe('') // 浮点回读不会一位不差
      expect(describeValueMismatch(0.4, 0)).not.toBe('')
    })

    // 「值没设上」的典型现场：发了 0.2，节点还停在引擎默认的 0
    it('抓得住「值没设上但回了个默认值」', () => {
      expect(describeValueMismatch(0.2, 0)).toContain('0.2')
    })

    it('颜色的三种写法都能和引擎回的 {r,g,b} 对上', () => {
      const readBack = { r: 0.8, g: 0.1, b: 0.1 }
      expect(describeValueMismatch({ r: 0.8, g: 0.1, b: 0.1 }, readBack)).toBe('')
      expect(describeValueMismatch({ x: 0.8, y: 0.1, z: 0.1 }, readBack)).toBe('')
      expect(describeValueMismatch([0.8, 0.1, 0.1], readBack)).toBe('')
      expect(describeValueMismatch({ r: 0.8, g: 0.1, b: 0.1 }, { r: 0, g: 0, b: 0 })).not.toBe('')
    })

    // 入参给 3 个分量、引擎回 4 个（带 alpha）是正常的，只比两边都有的那几个
    it('分量个数不一样不算对不上', () => {
      expect(describeValueMismatch({ r: 1, g: 0, b: 0 }, { r: 1, g: 0, b: 0, a: 1 })).toBe('')
      expect(describeValueMismatch([1, 0], { r: 1, g: 0, b: 0 })).toBe('')
    })

    it('布尔和 0/1 互相认（静态开关回的是 true/false）', () => {
      expect(describeValueMismatch(true, true)).toBe('')
      expect(describeValueMismatch(true, 1)).toBe('')
      expect(describeValueMismatch(true, false)).not.toBe('')
    })

    /*
     * 字符串一律不比 —— 这两种「不一样」都是**正常的**：
     *   · 贴图发 /Game/T_Rock，引擎回 /Game/T_Rock.T_Rock
     *   · ComponentMask 发 "xy"，引擎永远回 "RG"
     * 照着比就是满屏假警报。
     */
    it('字符串不比，免得贴图路径和通道拼写变成假警报', () => {
      expect(describeValueMismatch('/Game/T_Rock', '/Game/T_Rock.T_Rock')).toBe('')
      expect(describeValueMismatch('xy', 'RG')).toBe('')
      expect(describeValueMismatch('RG', 'RG')).toBe('')
    })

    it('形状对不上就不比', () => {
      expect(describeValueMismatch(0.5, { r: 0.5, g: 0.5, b: 0.5 })).toBe('')
      expect(describeValueMismatch({ r: 1, g: 1, b: 1 }, 1)).toBe('')
    })

    /*
     * 引擎存 float32，这边是 double —— 大数上的舍入必然超过任何固定的绝对容差。
     * 4096.3 存进去读回来是 4096.2998046875，差 1.95e-4。这些都是正常值
     * （世界坐标尺度的常量、大 tiling），报出来就是假警报。
     */
    it('大数的 float32 舍入不算对不上', () => {
      const f = new Float32Array(1)
      for (const v of [4096.3, 8192.35, 65536.1, 1e6 + 0.3]) {
        f[0] = v
        expect(describeValueMismatch(v, f[0])).toBe('')
      }
    })

    /*
     * 容差在**每个量级**上都得管用，不能只在大数上对。
     *
     * 这条原来写的是 `(0.2, 0)` 和 `(1, 0.99)` —— 差得太远，换成任何一种容差
     * 都是绿的，等于没测。而且我第一版给容差加了个 `Math.max(1, …)` 的绝对下限，
     * 正是这条测不出来的东西：下限会在小数上制造盲区。
     *
     * 所以钉两头：1.0 附近贴着阈值的一对，以及一个「小值没设上」——
     * 发 0.0001、回读 0（默认值）。加回绝对下限的话最后这条立刻红。
     */
    it('容差在大小两头都管用', () => {
      expect(describeValueMismatch(1, 1.00005)).toBe('')
      expect(describeValueMismatch(1, 1.0002)).not.toBe('')
      // 小值也得抓得住「没设上」：0.0001 掉回默认值 0，差的正好是老下限那个数
      /*
       * 「值没设上」要在**每个量级**上都抓得住，所以扫一遍而不是钉两个点。
       *
       * 钉点的下场实测过：只有 0.0001 和 0.00001 两个点时，重新加上
       * Math.max(0.1, …) 会红，但 0.05 / 0.01 / 0.001 全是绿的 ——
       * 盲区照样回来了，只是换了个量级。扫到 1e-12 才说得上「下限被钉死在 0」。
       */
      for (let e = 4; e <= 12; e++) {
        const sent = 10 ** -e
        expect(describeValueMismatch(sent, 0)).not.toBe('')
      }
      expect(describeValueMismatch(0, 0.0002)).not.toBe('')
    })

    /*
     * Constant2Vector 只存得下两个分量，而 ReadNodeValue 对它回的是
     * {r,g,b}（b 恒为 0）—— 光靠 Math.min 挡不住，得按节点类型封顶。
     * 报了的话附带那句「用 material_set_node_value 单独设一次」是个死循环：
     * 那个调用回 200、什么也不改，因为节点根本没有第三个分量。
     */
    it('节点装不下的多余分量不算对不上', () => {
      expect(describeValueMismatch([1, 2, 3], { r: 1, g: 2, b: 0 }, 'Constant2Vector')).toBe('')
    })

    /*
     * 这条原来还有一句 `('Constant2Vector', {r:1,g:9,b:0})` —— 没了容量表它也是绿的
     * （第二个分量本来就不一样），只挡得住「容量写小了」。真正分得出「有没有这张表」
     * 的是同一对输入配不同 node_type：Constant3Vector 要报，Constant2Vector 不报。
     */
    it('同样的值，容量不同结论就不同', () => {
      const sent = [1, 2, 3]
      const read = { r: 1, g: 2, b: 0 }
      expect(describeValueMismatch(sent, read, 'Constant3Vector')).not.toBe('')
      expect(describeValueMismatch(sent, read, 'Constant2Vector')).toBe('')
    })

    // 空串是唯一一种「不可能是写法差异」的字符串回读：它只意味着没设上。
    // ComponentMask 四位全 0 回的就是空串，而那种节点编译恒为 0、材质照样通过
    it('字符串回读是空串时要报，别和写法差异混为一谈', () => {
      expect(describeValueMismatch('RG', '', 'ComponentMask')).not.toBe('')
      expect(describeValueMismatch('/Game/T_Rock', '', 'TextureSample')).not.toBe('')
      // 仍然不比内容差异
      expect(describeValueMismatch('xy', 'RG', 'ComponentMask')).toBe('')
      // 本来就发的空串不算「没设上」
      expect(describeValueMismatch('', '', 'ComponentMask')).toBe('')
    })

    it('老插件不回 value 时不比（那条路由「确认不了」的警告接管）', () => {
      expect(describeValueMismatch(0.4, undefined)).toBe('')
      expect(describeValueMismatch(0.4, null)).toBe('')
    })

    it('UV 只比入参写了的那几项', () => {
      expect(describeValueMismatch({ u_tiling: 2 }, { u_tiling: 2, v_tiling: 1 })).toBe('')
      expect(describeValueMismatch({ u_tiling: 2 }, { u_tiling: 1, v_tiling: 1 })).not.toBe('')
    })
  })

  // 回读对不上要进警告，而且不能把整次建图判成失败 —— 节点确实建出来了
  it('初始值回读对不上时报警告但不算失败', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'material.add_node') return { node_id: 'Node_0', value: 0 }
      if (method === 'material.get_graph') return { nodes: [], connections: [] }
      if (method === 'material.compile') return { compiled: true, errors: [] }
      return {}
    })

    const r = (await tool.execute('c1', {
      path: '/Game/M_Wood',
      nodes: [{ id: 'a', node_type: 'Constant', value: 0.2 }],
      connections: []
    })) as { isError?: boolean }

    expect(r.isError).not.toBe(true)
    expect(textOf(r)).toContain('回读对不上')
  })

  /*
   * 编译这一步吞不吞异常，要看出错之后「图已经写进去了」还站不站得住。
   * 引擎报的编译失败站得住（收进回执），连接断了站不住（必须抛）。
   */
  it('引擎报的编译失败收进回执，不算工具失败', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'material.add_node') return { node_id: 'Node_0' }
      if (method === 'material.get_graph') return { nodes: [], connections: [] }
      if (method === 'material.compile')
        throw new Error('material.compile 失败：材质找不到（错误码 404）')
      return {}
    })

    const r = (await tool.execute('c1', {
      path: '/Game/M_Wood',
      nodes: [{ id: 'a', node_type: 'Constant' }],
      connections: []
    })) as { isError?: boolean }

    expect(r.isError).not.toBe(true)
    expect(textOf(r)).toContain('别整张重发')
  })

  /*
   * 连接类的失败**必须用真的那个错误对象来造**，不能手写一句中文。
   *
   * 上一版这里是 `throw new Error('这条引擎连接已经断开了（编辑器关了或重启过）。')`
   * —— 那句话来自「还没发出去」的分支。而编辑器在编译途中崩掉时，请求是被
   * `requestStateManager` 拒掉的，抛的是 `WebSocketServiceError(E_CONNECTION_CLOSED)`，
   * 文案完全不同。于是测试绿着，生产代码里那个 `includes` 一次都没命中过。
   *
   * 所以下面一律 `new WebSocketServiceError(真实的码, …)`：判定按码走，
   * 文案怎么改都不影响，而码写错了立刻红。
   */
  const engineGoneMid = (): Error =>
    new WebSocketServiceError(
      WebSocketErrorCode.E_CONNECTION_CLOSED,
      '引擎在执行 material.compile 的过程中断开了连接（编辑器崩溃、被关掉，或插件停了）。'
    )

  it('编译途中引擎断了：算失败，而且回执要留着', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'material.add_node') return { node_id: 'Node_0' }
      if (method === 'material.get_graph') return { nodes: [], connections: [] }
      if (method === 'material.compile') throw engineGoneMid()
      return {}
    })

    // 编辑器崩了的话，那个进程里未保存的节点一起没了 —— 这时候报「已写入、别重发」
    // 会让模型往一张回到旧状态的材质上继续加东西
    let thrown: Error | undefined
    try {
      await tool.execute('c1', {
        path: '/Game/M_Wood',
        nodes: [{ id: 'a', node_type: 'Constant' }],
        connections: []
      })
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown).toBeDefined()
    // 失败了还不够：已经建成的那些 id 必须跟着错误一起出来，
    // 否则模型没法「接着没做完的做」，只能整张重发
    expect(thrown?.message).toContain('停在「编译」')
    expect(thrown?.message).toContain('a→Node_0')
  })

  // 超时不一样：前面每一条 RPC 都成功返回过，连接是活的，图确实写进去了。
  // 这种抛出去反而把 node_id 映射一起弄丢
  it('编译超时不算连接断，照常进回执', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'material.add_node') return { node_id: 'Node_0' }
      if (method === 'material.get_graph') return { nodes: [], connections: [] }
      if (method === 'material.compile') {
        throw new WebSocketServiceError(WebSocketErrorCode.E_TIMEOUT, '请求超时')
      }
      return {}
    })

    const r = (await tool.execute('c1', {
      path: '/Game/M_Wood',
      nodes: [{ id: 'a', node_type: 'Constant' }],
      connections: []
    })) as { isError?: boolean }

    expect(r.isError).not.toBe(true)
    expect(textOf(r)).toContain('别整张重发')
  })

  /*
   * 这里原来有一条「用户按停止（E_ABORTED）不许报成功」，已删。
   *
   * 它靠的是 `tool.execute(...)` 不传 signal —— 那样 `runAbortable` 退化成直接
   * await，E_ABORTED 才走得到这个 catch。真实情况下按停止的那一刻 runAbortable
   * 就赢了赛跑、抛 `ToolAbortedError`，这条路永远到不了。
   * 一条只在「参数少传一个」时才跑得到的用例，绿的时候什么也没证明。
   * 取消这件事归 `abortable.ts` 管，测也该测在那儿。
   */

  // 排版只影响好不好看，不该让一次成功的建图变成失败
  it('排版失败只降级成警告', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'material.add_node') return { node_id: 'Node_0' }
      if (method === 'material.get_graph') throw new Error('炸了')
      if (method === 'material.compile') return { compiled: true }
      return {}
    })

    const r = (await tool.execute('c1', {
      path: '/Game/M_Wood',
      nodes: [{ id: 'a', node_type: 'Constant' }],
      connections: []
    })) as { isError?: boolean }

    expect(r.isError).not.toBe(true)
    expect(textOf(r)).toContain('自动排版没成功')
  })
})
