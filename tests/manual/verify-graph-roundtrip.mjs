/**
 * 蓝图整图**往返**验证：读回来 → 原样写回去 → 比对有没有丢东西。
 *
 * ## 为什么单独一个脚本
 *
 * 「读一张图、改一改、整张写回去」是这套工具最主要的用法，而它此前
 * **两头都是断的**，两个缺陷都只有真机能发现：
 *
 *   1. `get_graph` 报 `connection_count: 0` —— 插件不发顶层 connections，
 *      连线只在 `pins[].linked_to` 里。照着写回去得到一张完全断开的图。
 *   2. 节点只回 `class`（K2Node_CallFunction）和**本地化**的 `title`
 *      （「打印字符串」），说不出它调的是哪个函数，根本重建不了。
 *
 * 单测发现不了这两个：它们把插件 mock 掉了，mock 出来的形状正是
 * 我以为的形状。所以这条只能连着真引擎跑。
 *
 * ## 判据
 *
 * 不看工具说了什么，只看**第二次读回来的图和第一次是否等价**：
 * 节点集合（按 write_as + member_name）、连线集合、引脚字面量，三样都要对上。
 *
 * ## 用法
 *
 *   1. 盒子在跑（HTTP_ENABLED=true pnpm dev），UE 开着且插件已连接
 *   2. node tests/manual/verify-graph-roundtrip.mjs
 */

const BASE = 'http://127.0.0.1:8766'
const FOLDER = '/Game/UAVerify'
const BP = `${FOLDER}/BP_RoundTrip`
const GRAPH = 'EventGraph'

async function tool(name, args) {
  const res = await fetch(`${BASE}/api/debug/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args })
  })
  const json = await res.json().catch(() => null)
  if (!json?.success) {
    return { ok: false, error: json?.error ?? `HTTP ${res.status}` }
  }
  const text = (json.data?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
  try {
    return { ok: true, data: JSON.parse(text) }
  } catch {
    return { ok: true, data: { raw: text } }
  }
}

/**
 * 把一张读回来的图压成可比较的形状。
 *
 * 刻意**丢掉 node_id 和坐标**：重建之后 GUID 必然是新的，坐标也会被重新布局，
 * 拿它们比会永远不相等。真正要守住的是「逻辑结构一样」——
 * 哪些节点、怎么连、引脚上的值是什么。
 */
function normalize(graph) {
  const idToKey = new Map()
  const nodes = []

  for (const n of graph.nodes ?? []) {
    // 节点的身份 = 怎么重建它。没有 write_as 的节点重建不了，
    // 单独标出来 —— 它们的存在本身就是往返能力的缺口。
    const key = n.write_as ? `${n.write_as}:${n.member_name ?? ''}` : `UNREBUILDABLE:${n.class}`
    idToKey.set(n.id, key)

    const defaults = {}
    for (const p of n.pins ?? []) {
      if (p.default_value !== undefined) defaults[p.name] = p.default_value
    }
    nodes.push({ key, defaults })
  }

  const connections = (graph.connections ?? []).map(
    (c) =>
      `${idToKey.get(c.from_node) ?? c.from_node}.${c.from_pin} -> ${idToKey.get(c.to_node) ?? c.to_node}.${c.to_pin}`
  )

  return {
    nodes: nodes.sort((a, b) => a.key.localeCompare(b.key)),
    connections: connections.sort()
  }
}

/** 把读回来的图翻译成 apply_graph 的入参 */
function toWriteSpec(graph) {
  const idToLocal = new Map()
  const nodes = []
  const unrebuildable = []

  for (const [i, n] of (graph.nodes ?? []).entries()) {
    if (!n.write_as) {
      unrebuildable.push(`${n.class}（${n.title}）`)
      continue
    }
    const local = `n${i}`
    idToLocal.set(n.id, local)

    const pin_defaults = {}
    for (const p of n.pins ?? []) {
      // 只带**输入**引脚上的值：输出引脚的 default 是引擎自己的产物，
      // 写回去会被拒（"pin is connected" 或类型不符）
      if (p.dir === 'Input' && p.default_value !== undefined) {
        pin_defaults[p.name] = p.default_value
      }
    }

    nodes.push({
      id: local,
      class: n.write_as,
      ...(n.member_name ? { member_name: n.member_name } : {}),
      ...(n.target_class ? { target_class: n.target_class } : {}),
      ...(n.struct_type ? { struct_type: n.struct_type } : {}),
      ...(Object.keys(pin_defaults).length ? { pin_defaults } : {})
    })
  }

  const connections = []
  for (const c of graph.connections ?? []) {
    const from = idToLocal.get(c.from_node)
    const to = idToLocal.get(c.to_node)
    // 端点有一头重建不了，这条线也就带不过去 —— 如实记，不静默丢
    if (from && to) connections.push({ from: `${from}.${c.from_pin}`, to: `${to}.${c.to_pin}` })
  }

  return { nodes, connections, unrebuildable }
}

function diff(before, after) {
  const problems = []

  const keyCount = (g) => {
    const m = new Map()
    for (const n of g.nodes) m.set(n.key, (m.get(n.key) ?? 0) + 1)
    return m
  }
  const b = keyCount(before)
  const a = keyCount(after)
  for (const [k, n] of b) {
    if ((a.get(k) ?? 0) !== n)
      problems.push(`节点 ${k}：写回前 ${n} 个，写回后 ${a.get(k) ?? 0} 个`)
  }
  for (const [k, n] of a) {
    if (!b.has(k)) problems.push(`节点 ${k}：写回后多出来 ${n} 个`)
  }

  const bc = new Set(before.connections)
  const ac = new Set(after.connections)
  for (const c of bc) if (!ac.has(c)) problems.push(`连线丢了：${c}`)
  for (const c of ac) if (!bc.has(c)) problems.push(`连线多了：${c}`)

  /**
   * 引脚字面量按**整节点多重集**比，不能按 key 配对。
   *
   * 这张测试图里有两个 PrintString，key 完全相同（都是
   * `Function:KismetSystemLibrary.PrintString`）。第一版拿 key 去
   * `find` 第一个匹配项，于是把「no branch」那个和「yes branch」那个比了 ——
   * 报出两处根本不存在的差异，而真实往返是好的。
   *
   * 同名节点是常态（一张图里放三个 PrintString 再普通不过），
   * 所以判据只能是「这一组节点整体上一不一样」。
   */
  const fingerprint = (n) =>
    `${n.key}|${Object.entries(n.defaults)
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([k, v]) => `${k}=${v}`)
      .join(',')}`

  const bag = (g) => {
    const m = new Map()
    for (const n of g.nodes) {
      const f = fingerprint(n)
      m.set(f, (m.get(f) ?? 0) + 1)
    }
    return m
  }
  const bf = bag(before)
  const af = bag(after)
  for (const [f, n] of bf) {
    const got = af.get(f) ?? 0
    if (got !== n) problems.push(`节点(含引脚值) ${f}：写回前 ${n} 个，写回后 ${got} 个`)
  }
  for (const [f, n] of af) {
    if (!bf.has(f)) problems.push(`节点(含引脚值) ${f}：写回后多出来 ${n} 个`)
  }

  return problems
}

async function main() {
  console.log('\n=== 蓝图整图往返验证 ===\n')

  // 1. 造一张有点内容的图：事件 + 分支 + 两个不同的打印 + 引脚字面量
  console.log('▶ 建一张测试图')
  const created = await tool('blueprint_create', {
    name: 'BP_RoundTrip',
    parent_class: '/Script/Engine.Actor',
    folder: FOLDER
  })
  if (!created.ok) {
    console.error(`✖ 建蓝图失败：${created.error}`)
    process.exit(1)
  }

  const seeded = await tool('blueprint_apply_graph', {
    blueprint_path: BP,
    graph_name: GRAPH,
    clear_existing: true,
    nodes: [
      { id: 'begin', class: 'Event', member_name: 'ReceiveBeginPlay' },
      { id: 'gate', class: 'Branch', pin_defaults: { Condition: 'true' } },
      {
        id: 'yes',
        class: 'Function',
        member_name: 'KismetSystemLibrary.PrintString',
        pin_defaults: { InString: 'yes branch', Duration: '3.000000' }
      },
      {
        id: 'no',
        class: 'Function',
        member_name: 'KismetSystemLibrary.PrintString',
        pin_defaults: { InString: 'no branch' }
      }
    ],
    connections: [
      { from: 'begin.then', to: 'gate.execute' },
      { from: 'gate.then', to: 'yes.execute' },
      { from: 'gate.else', to: 'no.execute' }
    ]
  })
  if (!seeded.ok) {
    console.error(`✖ 建图失败：${seeded.error}`)
    process.exit(1)
  }
  console.log(`  已写入 ${seeded.data.created_count} 节点 / ${seeded.data.connection_count} 连线`)

  // 2. 读回来
  console.log('\n▶ 读回来')
  const first = await tool('blueprint_get_graph', { blueprint_path: BP, graph_name: GRAPH })
  if (!first.ok) {
    console.error(`✖ 读图失败：${first.error}`)
    process.exit(1)
  }
  console.log(`  ${first.data.node_count} 节点 / ${first.data.connection_count} 连线`)

  if (first.data.connection_count === 0 && seeded.data.connection_count > 0) {
    console.error('\n✖ 读回来 0 条连线，但写进去的时候有 —— 连线在读取路径上丢了')
    process.exit(1)
  }

  const spec = toWriteSpec(first.data)
  if (spec.unrebuildable.length) {
    console.log(
      `  ⚠ 有 ${spec.unrebuildable.length} 个节点重建不了：${spec.unrebuildable.join('、')}`
    )
  }

  // 3. 原样写回（clear_existing 让它成为真正的"整图替换"）
  console.log('\n▶ 原样写回去')
  const rewritten = await tool('blueprint_apply_graph', {
    blueprint_path: BP,
    graph_name: GRAPH,
    clear_existing: true,
    nodes: spec.nodes,
    connections: spec.connections
  })
  if (!rewritten.ok) {
    console.error(`✖ 写回失败：${rewritten.error}`)
    process.exit(1)
  }
  console.log(
    `  已写入 ${rewritten.data.created_count} 节点 / ${rewritten.data.connection_count} 连线`
  )
  for (const w of rewritten.data.warnings ?? []) console.log(`  ⚠ ${w}`)

  // 4. 再读一次，比对
  console.log('\n▶ 再读一次并比对')
  const second = await tool('blueprint_get_graph', { blueprint_path: BP, graph_name: GRAPH })
  if (!second.ok) {
    console.error(`✖ 读图失败：${second.error}`)
    process.exit(1)
  }

  const problems = diff(normalize(first.data), normalize(second.data))

  console.log('\n' + '─'.repeat(60))
  if (problems.length === 0) {
    console.log('✅ 往返无损：节点、连线、引脚字面量都对得上')
    process.exit(0)
  }
  console.log(`✖ 往返丢了东西（${problems.length} 处）：\n`)
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}

main().catch((err) => {
  console.error(`✖ ${err?.message ?? err}`)
  process.exit(1)
})
