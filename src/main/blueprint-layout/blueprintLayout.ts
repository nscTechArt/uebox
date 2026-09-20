/**
 * 蓝图排版 —— 按「真人排图的样子」算坐标。
 *
 * ## 这里在还什么债
 *
 * 上一版的做法是：执行流用 BFS 铺出一条主干，数据节点**相对它的消费者**
 * 往左上角偏一格（-150, -120），再对这个偏完的位置递归一次。
 * 三个后果，在真机上全中：
 *
 * 1. **对角线漂移**。偏移是相对父节点累加的，所以一条 5 层深的数据链会跑到
 *    消费者左上方 750x600 的地方，整张图被拉成一条从左上到右下的斜线 ——
 *    而真人排的图是一条横带。
 * 2. **连线横跨整张画布**。数据节点只认「第一个遇到的消费者」，被两处用到的
 *    getter 会落在其中一处旁边，另一根线就从画布这头拉到那头。
 * 3. **节点互相叠**。尺寸写死 220x100，而真实节点从 100 到 400 宽都有，
 *    偏移又只按格子算，没有任何避让。
 *
 * 现在改成**分层布局**，和 UE 用户自己排图的习惯对齐：
 *
 * - **列 = 最长路径深度，执行流和数据流一起算**。一个节点落在它**所有**上游
 *   右边 —— 不管那条上游是执行线还是数据线。这一条保证没有一根线是倒着走的
 *   （只算执行流的话，用 ForLoop 的 Index 算出来的那串会跑到 ForLoop 左边，
 *   线只能横穿整张图倒拉回来）。
 * - **数据节点再往右贴到 `min(消费者的列) - 1`**：最长路径给的是最左边那个
 *   合法位置，getter 会被甩得离用它的节点好几列远，中间全是空的。
 * - **执行流是一条直线**。单出口的下游继承父节点的 Y，分支才分道，
 *   所以主干横平竖直 —— 这正是图里最该一眼读完的那条线。
 * - **数据节点对齐到它喂的那个节点**（中位数法，从右往左扫两轮）。不对齐的话
 *   一列里挤七八个数据节点、顺序还是随便定的，七八根线互相交叉着扇出去 ——
 *   图没有重叠，但照样看不懂。
 * - **列内按真实尺寸找空位**，同列节点永不重叠；列宽取该列最宽的节点。
 *
 * 不重叠、没有倒着走的线、主干是直线，是这套算法的硬保证；
 * `blueprintLayout.test.ts` 里那张真机图（BP_SplineTool 的构造脚本）就是按
 * 这几条钉的。
 */

export interface BlueprintLayoutNode {
  id: string
  name: string
  type: string
  x: number
  y: number
  /** 节点实际尺寸。不给就按标题长度估，估出来的比写死 220x100 准得多 */
  width?: number
  height?: number
}

export interface BlueprintLayoutConnection {
  /** `节点id.引脚名` */
  from: string
  to: string
  /**
   * 这根线是执行流还是数据流。
   *
   * **调用方知道就一定要传** —— 引脚名猜不准：数据引脚里叫 `Update Rate`、
   * `bLoop` 的多的是，按名字猜会把数据线当成执行线，整张图的分层跟着错。
   * 不传才退回按名字猜。
   */
  kind?: 'exec' | 'data'
}

export interface BlueprintLayoutOptions {
  /**
   * 排完的图放在哪儿。
   *
   * - `origin`：左上角对齐 (0, 0)。新建的一批节点用这个。
   * - `original`：左上角对齐**原来那批节点的左上角** —— 整理已有的图时用，
   *   图还待在用户原来放它的地方，不会整张跳到原点去。
   */
  anchor?: 'origin' | 'original'
}

/** 列与列之间留的空档 */
const COLUMN_GAP = 110
/** 同一列上下两个节点之间的空档 */
const ROW_GAP = 48
/** 分支的第 n 个出口往下让开多少 */
const BRANCH_LANE_GAP = 200
/** 纯数据节点挂在消费者下方多少 */
const DATA_DROP = 120
/** 两坨互不相连的逻辑之间留的空档 */
const COMPONENT_GAP = 260
/** 数据节点对齐消费者要扫几轮 —— 两轮就收敛，再多是白跑 */
const DATA_SWEEP_PASSES = 2

const DEFAULT_NODE_WIDTH = 200
const DEFAULT_NODE_HEIGHT = 110

const CHAR_WIDTH = 7.2
const MIN_NODE_WIDTH = 120
const MAX_NODE_WIDTH = 420
const MIN_NODE_HEIGHT = 80
const MAX_NODE_HEIGHT = 520

interface LayoutState {
  id: string
  name: string
  type: string
  width: number
  height: number
  execOut: Array<{ id: string; pin: string }>
  execIn: string[]
  /** 用到我输出的节点 */
  dataOut: string[]
  /** 我的输入来自谁 */
  dataIn: string[]
  rank: number
  desiredY: number
  /** 摆完之后的真实 Y —— 对齐消费者那一步读的就是它，不是估计值 */
  y: number
  component: number
  isExec: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 中日韩字符在节点标题里占两个西文字符的宽度。
 * 编辑器是中文的时候，节点标题几乎全是中文（「添加实例」「获取样条长度」），
 * 按 `length` 算会把宽度低估一半，列宽跟着塌。
 */
function textWidth(value: string): number {
  let units = 0
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    units += code >= 0x2e80 && code <= 0xfaff ? 2 : 1
  }
  return units * CHAR_WIDTH
}

export interface BlueprintNodeShape {
  title?: string
  inputPins?: string[]
  outputPins?: string[]
}

/**
 * 估一个节点在画布上多大。
 *
 * 真实尺寸只有引擎里的 Slate widget 知道（插件的 get_graph 不回），
 * 但标题和引脚名就已经能估到够用的精度 —— 够用的意思是：列宽和行距按它算，
 * 排出来的图不重叠。比写死一个 220x100 强得多。
 */
export function estimateBlueprintNodeSize(shape: BlueprintNodeShape): {
  width: number
  height: number
} {
  const inputs = shape.inputPins ?? []
  const outputs = shape.outputPins ?? []

  const titleWidth = textWidth(shape.title ?? '') + 56
  const inputWidth = inputs.reduce((max, pin) => Math.max(max, textWidth(pin)), 0)
  const outputWidth = outputs.reduce((max, pin) => Math.max(max, textWidth(pin)), 0)
  const bodyWidth = inputWidth + outputWidth + 72

  const rows = Math.max(inputs.length, outputs.length)

  return {
    width: Math.round(clamp(Math.max(titleWidth, bodyWidth), MIN_NODE_WIDTH, MAX_NODE_WIDTH)),
    height: Math.round(clamp(52 + rows * 28, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT))
  }
}

function parsePinRef(ref: string): { nodeId: string; pinName: string } {
  const [nodeId, pinName = 'exec'] = ref.split('.')
  return { nodeId, pinName }
}

/**
 * 引脚名归一：小写、去掉非字母数字、去掉结尾的序号。
 * `Then_1` / `then 1` / `THEN` 归到同一个 `then`。
 */
function normalizePinName(pinName: string): string {
  return pinName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/\d+$/, '')
}

/**
 * 引擎里真实存在的执行引脚名，**全等匹配**。
 *
 * 上一版用的是 `includes`，于是 `bLoop`、`Update Rate`、`Play Rate` 这些
 * 数据引脚全被当成执行引脚 —— 一根数据线被当成执行线，分层就从那里开始错。
 * 只有调用方给不出 `kind` 时才走到这里。
 */
const EXEC_PIN_NAMES = new Set([
  'exec',
  'execute',
  'then',
  'else',
  'true',
  'false',
  'completed',
  'loopbody',
  'body',
  'finished',
  'play',
  'playfromstart',
  'stop',
  'reverse',
  'reversefromend',
  'setnewtime',
  'update',
  'aborted',
  'onsuccess',
  'onfail',
  'onfailed',
  'onfailure',
  'oncanceled',
  'oncancelled',
  'oncomplete',
  'oncompleted'
])

function isExecPinName(pinName: string): boolean {
  return EXEC_PIN_NAMES.has(normalizePinName(pinName))
}

function isExecConnection(connection: BlueprintLayoutConnection): boolean {
  if (connection.kind) return connection.kind === 'exec'
  return (
    isExecPinName(parsePinRef(connection.from).pinName) ||
    isExecPinName(parsePinRef(connection.to).pinName)
  )
}

function isEntryNode(state: LayoutState): boolean {
  const haystack = `${state.type} ${state.name}`.toLowerCase()
  return ['event', 'functionentry', 'customevent', 'inputaction', 'tunnel'].some((keyword) =>
    haystack.includes(keyword)
  )
}

function buildStates<T extends BlueprintLayoutNode>(
  nodes: T[],
  connections: BlueprintLayoutConnection[]
): Map<string, LayoutState> {
  const states = new Map<string, LayoutState>()

  for (const node of nodes) {
    const estimated = estimateBlueprintNodeSize({ title: node.name })
    states.set(node.id, {
      id: node.id,
      name: node.name,
      type: node.type,
      width: node.width ?? Math.max(estimated.width, DEFAULT_NODE_WIDTH),
      height: node.height ?? DEFAULT_NODE_HEIGHT,
      execOut: [],
      execIn: [],
      dataOut: [],
      dataIn: [],
      rank: -1,
      desiredY: 0,
      y: 0,
      component: 0,
      isExec: false
    })
  }

  for (const connection of connections) {
    const from = parsePinRef(connection.from)
    const to = parsePinRef(connection.to)
    const fromState = states.get(from.nodeId)
    const toState = states.get(to.nodeId)
    if (!fromState || !toState || fromState === toState) continue

    if (isExecConnection(connection)) {
      fromState.execOut.push({ id: to.nodeId, pin: from.pinName })
      toState.execIn.push(from.nodeId)
      fromState.isExec = true
      toState.isExec = true
    } else {
      if (!fromState.dataOut.includes(to.nodeId)) fromState.dataOut.push(to.nodeId)
      if (!toState.dataIn.includes(from.nodeId)) toState.dataIn.push(from.nodeId)
    }
  }

  return states
}

/** Branch 的 true 走直线、false 往下让 —— 和手排图的习惯一致 */
function sortExecEdges(
  edges: Array<{ id: string; pin: string }>
): Array<{ id: string; pin: string }> {
  const weight = (pin: string): number => {
    const normalized = normalizePinName(pin)
    if (normalized === 'then' || normalized === 'exec' || normalized === 'execute') return 0
    if (normalized === 'true') return 1
    if (normalized === 'loopbody' || normalized === 'body') return 2
    if (normalized === 'completed' || normalized === 'finished') return 3
    if (normalized === 'false' || normalized === 'else') return 4
    return 5
  }
  return [...edges].sort((a, b) => weight(a.pin) - weight(b.pin))
}

/** 一个节点的全部下游：执行流在前（主干优先占位），数据流在后 */
function outgoingOf(state: LayoutState): string[] {
  return [...sortExecEdges(state.execOut).map((edge) => edge.id), ...state.dataOut]
}

/**
 * 全图的拓扑序（迭代式 DFS，回边不入栈）。
 *
 * **执行流和数据流一起排**。只排执行流的话，「ForLoop 的 Index 算出一个位置、
 * 再算出一个旋转、最后喂给 Add Instance」这种链条，数据侧的先后关系就没人管 ——
 * 结果是 `乘法` 跑到了 ForLoop 左边 1800 像素的地方，那根线只能倒着拉回来。
 *
 * ForLoop 的 body 绕回来那种回边在蓝图里是常态，递归排序会直接转不出来。
 */
function topoOrder(states: Map<string, LayoutState>): string[] {
  const all = [...states.values()]
  const roots = all
    .filter((state) => state.execIn.length === 0 && state.dataIn.length === 0)
    .sort((a, b) => Number(!isEntryNode(a)) - Number(!isEntryNode(b)))

  const visited = new Set<string>()
  const order: string[] = []

  for (const start of [...roots, ...all]) {
    if (visited.has(start.id)) continue
    visited.add(start.id)
    const stack: Array<{ id: string; index: number }> = [{ id: start.id, index: 0 }]

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const state = states.get(frame.id)
      if (!state) {
        stack.pop()
        continue
      }
      const outgoing = outgoingOf(state)
      if (frame.index < outgoing.length) {
        const next = outgoing[frame.index]
        frame.index += 1
        if (!visited.has(next) && states.has(next)) {
          visited.add(next)
          stack.push({ id: next, index: 0 })
        }
      } else {
        stack.pop()
        order.push(frame.id)
      }
    }
  }

  return order.reverse()
}

/**
 * 最长路径定列：一个节点落在**所有**上游右边 —— 执行流的上游和数据流的上游
 * 都算。这一条保证了**没有一根线是倒着走的**，汇合点也不会落在第一条路径
 * 算出来的那一格上。
 */
function assignLongestPathRanks(states: Map<string, LayoutState>, order: string[]): void {
  const position = new Map(order.map((id, index) => [id, index]))

  for (const id of order) {
    const state = states.get(id)
    if (!state) continue
    if (state.rank < 0) state.rank = 0

    for (const targetId of outgoingOf(state)) {
      const target = states.get(targetId)
      if (!target) continue
      // 回边（ForLoop 的 body 绕回来那种）不参与定列，否则列号会一直往右跑
      if ((position.get(targetId) ?? -1) <= (position.get(id) ?? 0)) continue
      target.rank = Math.max(target.rank, state.rank + 1)
    }
  }
}

/**
 * 数据节点往右贴：列 = `min(消费者的列) - 1`。
 *
 * 最长路径定的是**最左边那个合法位置**，一个 getter 会被甩到离用它的节点好几
 * 列远的地方，中间全是空的 —— 手排图的人不会这么干，他们把 getter 塞在用它的
 * 节点旁边。这一步就是把每个数据节点挪到**最右边那个仍然合法的位置**。
 *
 * 从右往左算（消费者的列一定比自己大，先算完的就是消费者），所以挪完之后
 * 「生产者在消费者左边」这条依然成立。
 */
function pullDataNodesRight(states: Map<string, LayoutState>): void {
  const resolved = new Set<string>()
  const resolving = new Set<string>()

  const rankOf = (id: string): number => {
    const state = states.get(id)
    if (!state) return 0
    if (resolved.has(id) || resolving.has(id)) return state.rank

    resolving.add(id)
    if (!state.isExec && state.dataOut.length > 0) {
      let best = Number.POSITIVE_INFINITY
      for (const consumerId of state.dataOut) best = Math.min(best, rankOf(consumerId) - 1)
      // 最长路径给的是最左合法位；只会往右挪，不会越过自己的上游
      if (Number.isFinite(best)) state.rank = Math.max(state.rank, best)
    }
    resolving.delete(id)
    resolved.add(id)
    return state.rank
  }

  for (const state of states.values()) rankOf(state.id)
}

/** 并查集：把互不相连的几坨逻辑认出来，各自占一条横带 */
function assignComponents(states: Map<string, LayoutState>): void {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) ?? root
    let cursor = id
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) ?? root
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }
  const union = (a: string, b: string): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootA, rootB)
  }

  for (const id of states.keys()) parent.set(id, id)
  for (const state of states.values()) {
    for (const edge of state.execOut) if (states.has(edge.id)) union(state.id, edge.id)
    for (const target of state.dataOut) if (states.has(target)) union(state.id, target)
  }

  const index = new Map<string, number>()
  for (const state of states.values()) {
    const root = find(state.id)
    if (!index.has(root)) index.set(root, index.size)
    state.component = index.get(root) ?? 0
  }
}

/**
 * 每个节点「想待在」的 Y。
 *
 * 执行流：单出口的下游继承父节点的 Y（主干因此是一条直线），多出口才分道；
 * 汇合点取所有上游的平均，线就不会拐死角。
 * 数据节点：跟着消费者走 —— 消费者是执行节点就挂在它下方，消费者本身是
 * 数据节点就和它同高，**不再逐层累加**。
 */
function assignDesiredY(states: Map<string, LayoutState>, order: string[]): void {
  const sum = new Map<string, number>()
  const count = new Map<string, number>()
  const position = new Map(order.map((id, index) => [id, index]))

  for (const id of order) {
    const state = states.get(id)
    if (!state) continue
    const votes = count.get(id) ?? 0
    state.desiredY = votes > 0 ? (sum.get(id) ?? 0) / votes : 0

    const outgoing = sortExecEdges(state.execOut)
    outgoing.forEach((edge, index) => {
      if ((position.get(edge.id) ?? -1) <= (position.get(id) ?? 0)) return
      const want = state.desiredY + index * BRANCH_LANE_GAP
      sum.set(edge.id, (sum.get(edge.id) ?? 0) + want)
      count.set(edge.id, (count.get(edge.id) ?? 0) + 1)
    })
  }

  // 消费者的列号一定比生产者大，所以按列号从右往左扫，读到的消费者都已经定好了
  const dataNodes = [...states.values()]
    .filter((state) => !state.isExec)
    .sort((a, b) => b.rank - a.rank)

  for (const state of dataNodes) {
    const consumers = state.dataOut
      .map((id) => states.get(id))
      .filter((consumer): consumer is LayoutState => Boolean(consumer))
    if (consumers.length === 0) {
      state.desiredY = 0
      continue
    }
    const total = consumers.reduce(
      (acc, consumer) => acc + consumer.desiredY + (consumer.isExec ? DATA_DROP : 0),
      0
    )
    state.desiredY = total / consumers.length
  }
}

/** 一坨逻辑一条横带，上下排开，互不穿插 */
function stackComponents(states: Map<string, LayoutState>): void {
  const groups = new Map<number, LayoutState[]>()
  for (const state of states.values()) {
    const group = groups.get(state.component)
    if (group) group.push(state)
    else groups.set(state.component, [state])
  }

  const ordered = [...groups.entries()].sort((a, b) => {
    const rankA = Math.min(...a[1].map((state) => state.rank))
    const rankB = Math.min(...b[1].map((state) => state.rank))
    if (rankA !== rankB) return rankA - rankB
    return a[0] - b[0]
  })

  let offset = 0
  for (const [, group] of ordered) {
    const minY = Math.min(...group.map((state) => state.desiredY))
    const maxBottom = Math.max(...group.map((state) => state.desiredY + state.height))
    const shift = offset - minY
    for (const state of group) state.desiredY += shift
    offset += maxBottom - minY + COMPONENT_GAP
  }
}

/**
 * 在一列里找一个能放下这个节点、且离目标位置最近（只往下让）的空位。
 *
 * 不是简单地「一个接一个往下堆」：堆法会让一个只为上面那条分支服务的数据节点
 * 被推到**下面所有分支**的底下去。这里是首次适配 —— 两条分支之间的空当会被
 * 用起来，跟人手排图时往空地里塞一个 getter 是一个道理。
 */
function findFreeSlot(occupied: Array<[number, number]>, desiredY: number, height: number): number {
  let y = desiredY
  for (const [start, end] of occupied) {
    if (y + height + ROW_GAP <= start) break
    if (y < end + ROW_GAP) y = end + ROW_GAP
  }
  return y
}

function occupy(occupied: Array<[number, number]>, y: number, height: number): void {
  occupied.push([y, y + height])
  occupied.sort((a, b) => a[0] - b[0])
}

interface LayoutColumn {
  rank: number
  x: number
  states: LayoutState[]
}

function buildColumns(states: Map<string, LayoutState>): LayoutColumn[] {
  const grouped = new Map<number, LayoutState[]>()
  for (const state of states.values()) {
    const column = grouped.get(state.rank)
    if (column) column.push(state)
    else grouped.set(state.rank, [state])
  }

  const columns: LayoutColumn[] = []
  let cursorX = 0
  for (const rank of [...grouped.keys()].sort((a, b) => a - b)) {
    const group = grouped.get(rank) ?? []
    columns.push({ rank, x: cursorX, states: group })
    cursorX += Math.max(...group.map((state) => state.width), DEFAULT_NODE_WIDTH) + COLUMN_GAP
  }
  return columns
}

/**
 * 摆一列：列内按「想待在哪儿」就近放，放不下才往下让。
 *
 * 纯数据节点压在本列执行节点的下面 —— UE 里手排图就是这么排的，
 * 执行流那一行留给主干，getter 和算式挂在下方。
 */
function packColumn(column: LayoutColumn): void {
  const byDesiredY = (a: LayoutState, b: LayoutState): number =>
    a.desiredY - b.desiredY || a.id.localeCompare(b.id)

  const occupied: Array<[number, number]> = []
  const place = (state: LayoutState, desiredY: number): number => {
    const y = findFreeSlot(occupied, desiredY, state.height)
    occupy(occupied, y, state.height)
    state.y = y
    return y
  }

  /** 本列每坨逻辑的执行节点底边 —— 自己这坨的数据节点落在它下面 */
  const execBottom = new Map<number, number>()
  for (const state of column.states.filter((item) => item.isExec).sort(byDesiredY)) {
    const y = place(state, state.desiredY)
    execBottom.set(
      state.component,
      Math.max(execBottom.get(state.component) ?? Number.NEGATIVE_INFINITY, y + state.height)
    )
  }

  for (const state of column.states.filter((item) => !item.isExec).sort(byDesiredY)) {
    const floor = execBottom.get(state.component)
    place(state, floor === undefined ? state.desiredY : Math.max(state.desiredY, floor + ROW_GAP))
  }
}

/**
 * 数据节点对齐到它喂的那个节点 —— 反复几轮，直到位置不再动。
 *
 * ## 这一步在解决什么
 *
 * 只按「列 = min(消费者列) - 1」定位，一列里可能挤进七八个数据节点，
 * 而它们的消费者散在右边好几列的不同高度上。列内的先后顺序如果是随便定的
 * （上一版就是拿 id 排的），这七八根线就会互相交叉着扇出去 —— 图没有重叠，
 * 但照样看不懂，正是真机上「排完还是乱糟糟」的那个样子。
 *
 * 做法是分层布局里的老办法（中位数法）：从右往左扫，每个数据节点对齐到
 * 它所有消费者的**中位高度**，然后整列重排。消费者在右边，扫到左边时它们的
 * 位置已经定死了，所以这一轮算的是真实坐标，不是估计值。扫两轮就收敛。
 */
function alignDataToConsumers(columns: LayoutColumn[], states: Map<string, LayoutState>): void {
  const center = (state: LayoutState): number => state.y + state.height / 2

  for (let pass = 0; pass < DATA_SWEEP_PASSES; pass += 1) {
    for (let index = columns.length - 1; index >= 0; index -= 1) {
      const column = columns[index]
      for (const state of column.states) {
        if (state.isExec) continue
        const centers = state.dataOut
          .map((id) => states.get(id))
          .filter((consumer): consumer is LayoutState => Boolean(consumer))
          .map(center)
          .sort((a, b) => a - b)
        if (centers.length === 0) continue

        // 中位数而不是平均数：一个被用了五次的 getter，不该被那一个在很远处的
        // 消费者把位置拽走
        const middle = Math.floor(centers.length / 2)
        const median =
          centers.length % 2 === 1 ? centers[middle] : (centers[middle - 1] + centers[middle]) / 2
        state.desiredY = median - state.height / 2
      }
      packColumn(column)
    }
  }
}

function writeBack<T extends BlueprintLayoutNode>(
  nodes: T[],
  columns: LayoutColumn[],
  states: Map<string, LayoutState>
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const column of columns) {
    for (const state of column.states) {
      const node = byId.get(state.id)
      if (!node) continue
      node.x = column.x
      node.y = states.get(state.id)?.y ?? state.y
    }
  }
}

function anchorNodes<T extends BlueprintLayoutNode>(
  nodes: T[],
  laidOut: T[],
  anchor: 'origin' | 'original'
): void {
  if (laidOut.length === 0) return

  const minX = Math.min(...laidOut.map((node) => node.x))
  const minY = Math.min(...laidOut.map((node) => node.y))
  const targetX = anchor === 'original' ? Math.min(...nodes.map((node) => node.x)) : 0
  const targetY = anchor === 'original' ? Math.min(...nodes.map((node) => node.y)) : 0
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return

  const shiftX = targetX - minX
  const shiftY = targetY - minY
  for (const node of laidOut) {
    node.x += shiftX
    node.y += shiftY
  }
}

/** 分列：从连线建图 → 最长路径定列 → 数据节点往右贴 */
function rankGraph<T extends BlueprintLayoutNode>(
  nodes: T[],
  connections: BlueprintLayoutConnection[]
): { states: Map<string, LayoutState>; order: string[] } {
  const states = buildStates(nodes, connections)
  const order = topoOrder(states)
  assignLongestPathRanks(states, order)
  pullDataNodesRight(states)
  return { states, order }
}

/** 一份要复制出来的 getter：这份拷贝接管哪些下游引脚 */
export interface GetterDuplication {
  /** 被复制的那个节点 */
  sourceId: string
  /** 这份拷贝要接管的下游引脚 */
  targets: Array<{ nodeId: string; pin: string }>
  /** 这些消费者所在的列 —— 只用来告诉调用方拷贝该放多远，不是最终坐标 */
  rank: number
}

/**
 * 找出「该复制一份」的纯 getter。
 *
 * ## 为什么排版解决不了这个
 *
 * 一个变量读取节点被图里三个相距很远的地方用到时，它只能待在**最左边那个
 * 消费者**的左边（再往右就越过消费者了），另外两根线只好横跨整张图。
 * 这不是摆放问题 —— 一个节点出现在一个位置，而它要去三个地方，怎么摆都有长线。
 *
 * 手排图的人从来不这么干：他们在每处**再拖一个同名的 Get 节点**出来。
 * 纯节点本来就按消费者各求值一次（不是求一次共用），所以复制出来的图和原来
 * **完全等价**，只是好读得多。
 *
 * 这里只负责算「该复制几份、每份接管哪几根线」，复制本身由调用方去做 ——
 * 它才知道这个节点能不能被重建（`write_as`），以及哪些类可以安全复制。
 */
export function planGetterDuplicates<T extends BlueprintLayoutNode>(
  nodes: T[],
  connections: BlueprintLayoutConnection[],
  isDuplicable: (node: T) => boolean
): GetterDuplication[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const { states } = rankGraph(nodes, connections)

  /** 一个 getter 的下游按列聚团，团与团之间超过这么多列才值得单独来一份 */
  const clusterSpan = 2
  const plans: GetterDuplication[] = []

  for (const state of states.values()) {
    if (state.isExec || state.dataIn.length > 0 || state.dataOut.length < 2) continue
    const node = byId.get(state.id)
    if (!node || !isDuplicable(node)) continue

    const targets = connections
      .filter((connection) => parsePinRef(connection.from).nodeId === state.id)
      .map((connection) => {
        const to = parsePinRef(connection.to)
        return { nodeId: to.nodeId, pin: to.pinName, rank: states.get(to.nodeId)?.rank ?? 0 }
      })
      .sort((a, b) => a.rank - b.rank)
    if (targets.length < 2) continue

    const clusters: Array<typeof targets> = []
    for (const target of targets) {
      const current = clusters[clusters.length - 1]
      if (current && target.rank - current[0].rank <= clusterSpan) current.push(target)
      else clusters.push([target])
    }

    // 最左边那团留给原节点，其余每团各复制一份
    for (const cluster of clusters.slice(1)) {
      plans.push({
        sourceId: state.id,
        targets: cluster.map((target) => ({ nodeId: target.nodeId, pin: target.pin })),
        rank: cluster[0].rank
      })
    }
  }

  return plans.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.rank - b.rank)
}

/**
 * 给一张图重新算坐标。只动 x / y，节点和连线一个字都不改。
 */
export function layoutBlueprintNodes<T extends BlueprintLayoutNode>(
  nodes: T[],
  connections: BlueprintLayoutConnection[],
  options: BlueprintLayoutOptions = {}
): T[] {
  if (nodes.length === 0) return nodes

  const working = nodes.map((node) => ({ ...node }))
  const { states, order } = rankGraph(working, connections)
  assignComponents(states)
  assignDesiredY(states, order)
  stackComponents(states)

  const columns = buildColumns(states)
  for (const column of columns) packColumn(column)
  alignDataToConsumers(columns, states)
  writeBack(working, columns, states)
  anchorNodes(nodes, working, options.anchor ?? 'origin')

  for (const node of working) {
    node.x = Math.round(node.x)
    node.y = Math.round(node.y)
  }

  return working
}

/**
 * 老名字，保持异步签名不变 —— 调用方（apply_graph / tidy_graph）都在 await 它。
 */
export async function autoLayoutBlueprintNodes<T extends BlueprintLayoutNode>(
  nodes: T[],
  connections: BlueprintLayoutConnection[],
  options: BlueprintLayoutOptions = {}
): Promise<T[]> {
  return Promise.resolve(layoutBlueprintNodes(nodes, connections, options))
}

export const __testing = {
  isExecPinName,
  normalizePinName,
  textWidth,
  COLUMN_GAP,
  ROW_GAP,
  DATA_DROP
}
