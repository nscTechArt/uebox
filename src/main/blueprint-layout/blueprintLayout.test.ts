/**
 * @vitest-environment node
 *
 * 分层排版的契约测试。
 *
 * 这些用例是照着**上一版在真机上排坏的那张图**写的：一张能用的蓝图被排成了
 * 一条从左上拉到右下的斜线，数据节点飞在离消费者半屏远的地方。所以这里测的
 * 不是「坐标等于多少」，而是四条人眼能看出来的性质：
 *
 *   1. 节点不重叠
 *   2. 生产者永远在**每一个**消费者左边
 *   3. 执行主干是一条直线
 *   4. 整张图不会被拉成对角线
 */

import { describe, expect, it } from 'vitest'
import {
  estimateBlueprintNodeSize,
  layoutBlueprintNodes,
  type BlueprintLayoutConnection,
  type BlueprintLayoutNode
} from './blueprintLayout'

type Placed = BlueprintLayoutNode

function node(id: string, name = id, type = 'K2Node_CallFunction'): BlueprintLayoutNode {
  return { id, name, type, x: 0, y: 0, width: 200, height: 100 }
}

function exec(from: string, to: string): BlueprintLayoutConnection {
  return { from: `${from}.then`, to: `${to}.execute`, kind: 'exec' }
}

function data(from: string, to: string): BlueprintLayoutConnection {
  return { from: `${from}.ReturnValue`, to: `${to}.Value`, kind: 'data' }
}

function at(nodes: Placed[], id: string): Placed {
  const found = nodes.find((item) => item.id === id)
  if (!found) throw new Error(`没有这个节点：${id}`)
  return found
}

/** 任意两个节点的矩形不相交 —— 允许贴边，不允许压上去 */
function overlaps(nodes: Placed[]): Array<[string, string]> {
  const hits: Array<[string, string]> = []
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]
      const b = nodes[j]
      const aw = a.width ?? 200
      const ah = a.height ?? 100
      const bw = b.width ?? 200
      const bh = b.height ?? 100
      if (a.x < b.x + bw && b.x < a.x + aw && a.y < b.y + bh && b.y < a.y + ah) {
        hits.push([a.id, b.id])
      }
    }
  }
  return hits
}

describe('执行流', () => {
  it('主干排成一条直线，从左往右', () => {
    const nodes = ['A', 'B', 'C', 'D'].map((id) => node(id))
    const result = layoutBlueprintNodes(nodes, [exec('A', 'B'), exec('B', 'C'), exec('C', 'D')])

    const ys = result.map((item) => item.y)
    expect(new Set(ys).size).toBe(1)
    expect(at(result, 'A').x).toBeLessThan(at(result, 'B').x)
    expect(at(result, 'B').x).toBeLessThan(at(result, 'C').x)
    expect(at(result, 'C').x).toBeLessThan(at(result, 'D').x)
  })

  it('分支分道，汇合点落在两条支路右边', () => {
    const nodes = ['Event', 'Branch', 'Yes', 'No', 'Merge'].map((id) => node(id))
    const result = layoutBlueprintNodes(nodes, [
      exec('Event', 'Branch'),
      { from: 'Branch.then', to: 'Yes.execute', kind: 'exec' },
      { from: 'Branch.else', to: 'No.execute', kind: 'exec' },
      exec('Yes', 'Merge'),
      exec('No', 'Merge')
    ])

    expect(at(result, 'Yes').y).not.toBe(at(result, 'No').y)
    expect(at(result, 'Merge').x).toBeGreaterThan(at(result, 'Yes').x)
    expect(at(result, 'Merge').x).toBeGreaterThan(at(result, 'No').x)
    expect(overlaps(result)).toEqual([])
  })

  /** ForLoop 的 body 绕回来是常态，转不出拓扑序就会卡死或者把列号推到天上 */
  it('回边不会让列号一直往右跑', () => {
    const nodes = ['Loop', 'Body', 'Back'].map((id) => node(id))
    const result = layoutBlueprintNodes(nodes, [
      { from: 'Loop.LoopBody', to: 'Body.execute', kind: 'exec' },
      exec('Body', 'Back'),
      exec('Back', 'Loop')
    ])

    const width =
      Math.max(...result.map((item) => item.x)) - Math.min(...result.map((item) => item.x))
    expect(width).toBeLessThan(2000)
    expect(overlaps(result)).toEqual([])
  })
})

describe('数据节点', () => {
  it('生产者永远在消费者左边', () => {
    const nodes = ['Event', 'Call', 'Getter'].map((id) => node(id))
    const result = layoutBlueprintNodes(nodes, [exec('Event', 'Call'), data('Getter', 'Call')])

    expect(at(result, 'Getter').x).toBeLessThan(at(result, 'Call').x)
  })

  /**
   * 上一版的核心缺陷：数据节点只认「第一个遇到的消费者」，被两处用到的 getter
   * 会贴在其中一处旁边，另一根线横跨整张画布。
   */
  it('被多处用到时落在最靠左的那个消费者左边', () => {
    const nodes = ['A', 'B', 'C', 'Shared'].map((id) => node(id))
    const result = layoutBlueprintNodes(nodes, [
      exec('A', 'B'),
      exec('B', 'C'),
      data('Shared', 'B'),
      data('Shared', 'C')
    ])

    expect(at(result, 'Shared').x).toBeLessThan(at(result, 'B').x)
    expect(at(result, 'Shared').x).toBeLessThan(at(result, 'C').x)
  })

  /**
   * 上一版把数据链按「相对消费者偏 (-150, -120)」逐层累加，五层深就跑到
   * 左上角 750x600 外 —— 整张图被拉成一条斜线。这条就是钉住那个回归的。
   */
  it('深数据链不会把图拉成对角线', () => {
    const chain = ['D5', 'D4', 'D3', 'D2', 'D1'].map((id) => node(id))
    const nodes = [node('Event'), node('Call'), ...chain]
    const result = layoutBlueprintNodes(nodes, [
      exec('Event', 'Call'),
      data('D1', 'Call'),
      data('D2', 'D1'),
      data('D3', 'D2'),
      data('D4', 'D3'),
      data('D5', 'D4')
    ])

    const height =
      Math.max(...result.map((item) => item.y)) - Math.min(...result.map((item) => item.y))
    // 一条纯链上的节点各占一列，纵向应该几乎不铺开
    expect(height).toBeLessThan(400)
    expect(at(result, 'D5').x).toBeLessThan(at(result, 'D4').x)
    expect(at(result, 'D1').x).toBeLessThan(at(result, 'Call').x)
  })

  it('纯数据节点挂在执行行下方', () => {
    const nodes = [node('Event'), node('Call'), node('Getter')]
    const result = layoutBlueprintNodes(nodes, [exec('Event', 'Call'), data('Getter', 'Call')])

    expect(at(result, 'Getter').y).toBeGreaterThan(at(result, 'Call').y)
  })

  /**
   * 只为上面那条分支服务的数据节点，不该被推到下面所有分支的底下去 ——
   * 那根线要横穿整张图才能走回来。分支之间的空当就是给它留的。
   */
  it('只为某条分支服务的数据节点不会被推到所有分支下面', () => {
    const nodes = ['Branch', 'Top', 'Bottom', 'Far', 'Feeder'].map((id) => node(id))
    const result = layoutBlueprintNodes(nodes, [
      { from: 'Branch.then', to: 'Top.execute', kind: 'exec' },
      { from: 'Branch.else', to: 'Bottom.execute', kind: 'exec' },
      exec('Bottom', 'Far'),
      data('Feeder', 'Top')
    ])

    expect(at(result, 'Feeder').y).toBeLessThan(at(result, 'Bottom').y)
    expect(overlaps(result)).toEqual([])
  })

  it('一张全是数据流的图也能从左往右排开', () => {
    const nodes = ['Src', 'Mid', 'Sink'].map((id) => node(id))
    const result = layoutBlueprintNodes(nodes, [data('Src', 'Mid'), data('Mid', 'Sink')])

    expect(at(result, 'Src').x).toBeLessThan(at(result, 'Mid').x)
    expect(at(result, 'Mid').x).toBeLessThan(at(result, 'Sink').x)
    expect(overlaps(result)).toEqual([])
  })
})

describe('不重叠', () => {
  it('二十个节点的混合图里一个都不压', () => {
    const nodes: BlueprintLayoutNode[] = []
    const connections: BlueprintLayoutConnection[] = []
    for (let i = 0; i < 10; i += 1) {
      nodes.push(node(`E${i}`, `执行节点 ${i}`))
      if (i > 0) connections.push(exec(`E${i - 1}`, `E${i}`))
      nodes.push(node(`G${i}`, `获取变量 ${i}`))
      connections.push(data(`G${i}`, `E${i}`))
    }

    const result = layoutBlueprintNodes(nodes, connections)
    expect(overlaps(result)).toEqual([])
  })

  it('互不相连的两坨逻辑上下排开，不互相穿插', () => {
    const nodes = ['A1', 'A2', 'B1', 'B2'].map((id) => node(id))
    const result = layoutBlueprintNodes(nodes, [exec('A1', 'A2'), exec('B1', 'B2')])

    expect(at(result, 'A1').y).not.toBe(at(result, 'B1').y)
    expect(overlaps(result)).toEqual([])
  })

  it('孤立节点也有位置，不堆在原点', () => {
    const nodes = ['A', 'B', 'Lonely'].map((id) => node(id))
    const result = layoutBlueprintNodes(nodes, [exec('A', 'B')])

    expect(overlaps(result)).toEqual([])
  })
})

describe('放在哪儿', () => {
  it('默认左上角对齐原点', () => {
    const nodes = [node('A'), node('B')].map((item) => ({ ...item, x: 5000, y: -2000 }))
    const result = layoutBlueprintNodes(nodes, [exec('A', 'B')])

    expect(Math.min(...result.map((item) => item.x))).toBe(0)
    expect(Math.min(...result.map((item) => item.y))).toBe(0)
  })

  /** 整理已有的图时，图应该留在用户原来放它的地方，不能整张跳到原点 */
  it('anchor=original 时留在原来的左上角', () => {
    const nodes = [
      { ...node('A'), x: 1200, y: 640 },
      { ...node('B'), x: 1900, y: 900 }
    ]
    const result = layoutBlueprintNodes(nodes, [exec('A', 'B')], { anchor: 'original' })

    expect(Math.min(...result.map((item) => item.x))).toBe(1200)
    expect(Math.min(...result.map((item) => item.y))).toBe(640)
  })
})

describe('引脚名兜底（调用方给不出类型时）', () => {
  it('认得执行引脚的真名，不把数据引脚当执行引脚', () => {
    const nodes = ['A', 'B'].map((id) => node(id))
    // Update Rate 是数据引脚 —— 上一版按 includes('update') 会把它当执行线
    const result = layoutBlueprintNodes(nodes, [{ from: 'A.Update Rate', to: 'B.Value' }])

    // 当成数据线的话 B 是消费者，A 在它左边，且 A 不进执行行
    expect(at(result, 'A').x).toBeLessThan(at(result, 'B').x)
  })

  it('Then_1 这种带序号的出口仍然算执行引脚', () => {
    const nodes = ['A', 'B'].map((id) => node(id))
    const result = layoutBlueprintNodes(nodes, [{ from: 'A.Then_1', to: 'B.execute' }])

    expect(at(result, 'A').y).toBe(at(result, 'B').y)
  })
})

/**
 * 真机上那张排坏了的图：BP_SplineTool 的构造脚本，29 个节点。
 *
 * 用户反馈「排完还是乱糟糟」的就是它，所以这里不测坐标，测的是四条
 * 能解释「为什么看着乱」的量：倒着走的线、交叉数、重叠、主干直不直。
 */
function splineToolGraph(): {
  nodes: BlueprintLayoutNode[]
  connections: BlueprintLayoutConnection[]
} {
  const nodes: BlueprintLayoutNode[] = []
  const connections: BlueprintLayoutConnection[] = []
  const add = (id: string): void => {
    nodes.push({ id, name: id, type: 'K2Node', x: 0, y: 0, width: 200, height: 144 })
  }
  const e = (from: string, to: string, pin = 'then'): void => {
    connections.push({ from: `${from}.${pin}`, to: `${to}.execute`, kind: 'exec' })
  }
  const d = (from: string, to: string): void => {
    connections.push({ from: `${from}.Out`, to: `${to}.In`, kind: 'data' })
  }

  for (const id of [
    '构造脚本',
    '设置静态网格',
    'SET网格间距',
    'SET实例数量',
    'ForLoop',
    '添加实例',
    'PlacedMesh',
    '实例化静态网格',
    'PlacedMesh2',
    '获取边界框',
    '中断Box',
    '减法',
    '中断矢量',
    '网格偏移',
    '加法',
    'Spline',
    '获取样条长度',
    '除法',
    'Floor',
    '实例化静态网格2',
    '乘法',
    '获取位置索引A',
    '获取位置索引B',
    '加1',
    '减法2',
    'MakeRotFromX',
    '网格旋转乘数',
    '乘法2',
    '生成变换'
  ]) {
    add(id)
  }

  e('构造脚本', '设置静态网格')
  e('设置静态网格', 'SET网格间距')
  e('SET网格间距', 'SET实例数量')
  e('SET实例数量', 'ForLoop')
  e('ForLoop', '添加实例', 'LoopBody')

  d('PlacedMesh', '设置静态网格')
  d('实例化静态网格', '设置静态网格')
  d('PlacedMesh2', '获取边界框')
  d('获取边界框', '中断Box')
  d('中断Box', '减法')
  d('减法', '中断矢量')
  d('中断矢量', '加法')
  d('网格偏移', '加法')
  d('加法', 'SET网格间距')
  d('Spline', '获取样条长度')
  d('获取样条长度', '除法')
  d('SET网格间距', '除法')
  d('除法', 'Floor')
  d('Floor', 'SET实例数量')
  d('SET实例数量', 'ForLoop')
  d('ForLoop', '乘法')
  d('SET网格间距', '乘法')
  d('乘法', '获取位置索引A')
  d('Spline', '获取位置索引A')
  d('乘法', '加1')
  d('加1', '获取位置索引B')
  d('Spline', '获取位置索引B')
  d('获取位置索引A', '减法2')
  d('获取位置索引B', '减法2')
  d('减法2', 'MakeRotFromX')
  d('网格旋转乘数', '乘法2')
  d('MakeRotFromX', '乘法2')
  d('获取位置索引A', '生成变换')
  d('乘法2', '生成变换')
  d('生成变换', '添加实例')
  d('实例化静态网格2', '添加实例')

  return { nodes, connections }
}

/** 每根线画成「生产者右边中点 → 消费者左边中点」，数一数交叉了几次 */
function countCrossings(placed: Placed[], connections: BlueprintLayoutConnection[]): number {
  const find = (ref: string): Placed => at(placed, ref.split('.')[0])
  const segments = connections.map((connection) => {
    const from = find(connection.from)
    const to = find(connection.to)
    return [
      from.x + (from.width ?? 200),
      from.y + (from.height ?? 100) / 2,
      to.x,
      to.y + (to.height ?? 100) / 2
    ] as const
  })

  const turnsLeft = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number
  ): boolean => (cy - ay) * (bx - ax) > (by - ay) * (cx - ax)

  let crossings = 0
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const [ax, ay, bx, by] = segments[i]
      const [cx, cy, dx, dy] = segments[j]
      if (
        turnsLeft(ax, ay, cx, cy, dx, dy) !== turnsLeft(bx, by, cx, cy, dx, dy) &&
        turnsLeft(ax, ay, bx, by, cx, cy) !== turnsLeft(ax, ay, bx, by, dx, dy)
      ) {
        crossings += 1
      }
    }
  }
  return crossings
}

describe('真机回归：BP_SplineTool 的构造脚本', () => {
  const { nodes, connections } = splineToolGraph()
  const result = layoutBlueprintNodes(nodes, connections)

  /**
   * 「乱」最主要的来源。只按执行流定列时，`乘法`（用 ForLoop 的 Index 算的）
   * 会被它另一个消费者拽到 ForLoop 左边一千多像素，那根线只能倒着拉回来 ——
   * 一根倒着走的线就足以让人读不下去。
   */
  it('没有一根线是倒着走的', () => {
    const backwards = connections.filter((connection) => {
      const from = at(result, connection.from.split('.')[0])
      const to = at(result, connection.to.split('.')[0])
      return to.x < from.x + (from.width ?? 200)
    })
    expect(backwards).toEqual([])
  })

  it('没有节点叠在一起', () => {
    expect(overlaps(result)).toEqual([])
  })

  /** 交叉数是「看着乱不乱」最接近的一个量。上一版的排法在这张图上是 37 */
  it('连线交叉控制在个位数附近', () => {
    expect(countCrossings(result, connections)).toBeLessThanOrEqual(15)
  })

  it('执行主干是一条直线', () => {
    const backbone = [
      '构造脚本',
      '设置静态网格',
      'SET网格间距',
      'SET实例数量',
      'ForLoop',
      '添加实例'
    ]
    expect(new Set(backbone.map((id) => at(result, id).y)).size).toBe(1)
  })

  /**
   * 执行流那一行是留给主干的。和主干同列的数据节点挂在它下面；同列里没有
   * 执行节点的，就可以和主干齐平 —— `Make Transform` 正对着 `Add Instance`
   * 是手排图里最常见的样子，不该把它硬压下去。
   */
  it('和主干同列的数据节点挂在主干下面', () => {
    const line = at(result, '构造脚本').y
    for (const id of ['PlacedMesh', '实例化静态网格', '获取边界框']) {
      expect(at(result, id).y).toBeGreaterThan(line)
    }
  })

  /** 排成一条横带，不是一坨方块 —— 这是手排图看着顺的根本原因 */
  it('整张图是一条扁的横带', () => {
    const width = Math.max(...result.map((item) => item.x + (item.width ?? 200)))
    const height = Math.max(...result.map((item) => item.y + (item.height ?? 100)))
    expect(width / height).toBeGreaterThan(3)
  })
})

describe('节点尺寸估算', () => {
  it('引脚越多越高', () => {
    const small = estimateBlueprintNodeSize({ title: 'Add', inputPins: ['A'], outputPins: ['R'] })
    const big = estimateBlueprintNodeSize({
      title: 'Add',
      inputPins: ['A', 'B', 'C', 'D', 'E'],
      outputPins: ['R']
    })
    expect(big.height).toBeGreaterThan(small.height)
  })

  it('中文标题按两倍宽算 —— 编辑器是中文时标题几乎全是中文', () => {
    const chinese = estimateBlueprintNodeSize({ title: '添加实例节点' })
    const latin = estimateBlueprintNodeSize({ title: 'abcdef' })
    expect(chinese.width).toBeGreaterThan(latin.width)
  })

  it('再长的标题也不会算出一个离谱的宽度', () => {
    const size = estimateBlueprintNodeSize({ title: 'x'.repeat(500) })
    expect(size.width).toBeLessThanOrEqual(420)
  })
})
