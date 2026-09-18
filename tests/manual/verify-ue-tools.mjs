/**
 * 蓝图 + 材质工具的真机验证。
 *
 * ## 为什么走 HTTP 而不是直接 import 工具
 *
 * 工具要拿 `serviceManager.getWebSocketService()` 才能和引擎说话，而那个连接
 * 属于**正在运行的盒子进程**（UE 侧插件是 WS 客户端，连的是盒子的 17860）。
 * 在外面新起一个进程 import 工具，拿到的是一个没有任何连接的服务实例。
 * 所以必须由跑着的盒子来执行，`/api/debug/tool` 就是这个入口。
 *
 * ## 为什么不验裸 RPC
 *
 * `/api/debug/ue-command` 直连插件，验的是引擎侧。但模型调的是**工具层** ——
 * 参数拼装、默认值填充、响应解析、错误措辞都在那一层，
 * 「调用成功了但结果不对」基本都藏在那里，裸 RPC 一律看不见。
 *
 * ## 用法
 *
 *   1. 盒子在跑（pnpm dev），UE 开着 UALinkDev55 且插件已连接
 *   2. node tests/manual/verify-ue-tools.mjs [blueprint|material|material-graph|actor|all]
 *
 *      material        基础链路：建材质 → 参数节点 → 实例 → 调参 → 上到 Actor
 *      material-graph  进阶：断线 / 清死节点 / 参数集合 / 材质函数 / 反查引用
 *      material-pins   引脚层：节点说明书 / 分量输出接不接得出去 / 遮罩通道
 *
 * 产出一张表：工具 -> 通过 / 失败 / 跳过，附失败原因。
 */

const BASE = 'http://127.0.0.1:8766'
const FOLDER = '/Game/UAVerify'
const BP = `${FOLDER}/BP_VerifyDoor.BP_VerifyDoor`
const MAT = `${FOLDER}/M_VerifyWood.M_VerifyWood`
const MI = `${FOLDER}/MI_VerifyWood.MI_VerifyWood`

const results = []
/** 步骤之间要传递的运行时值（node_id、pin 名等），只能从上一步的返回里拿 */
const ctx = {}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** 工具返回的是 pi 的 AgentToolResult：{ content: [{type:'text',text}], details } */
function readOutput(data) {
  const text = (data?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return { text, parsed, details: data?.details }
}

async function step(name, args, opts = {}) {
  if (opts.skip) {
    results.push({ name, verdict: 'skip', note: opts.skip })
    console.log(`  ⏭  ${name} —— ${opts.skip}`)
    return null
  }

  const { status, json } = await post('/api/debug/tool', { name, args })
  if (!json?.success) {
    /**
     * 预期失败的用例在这里就要认掉。
     *
     * 工具报的失败有两种到达方式：编码进返回体（`out.parsed.success === false`），
     * 或者被端点提到信封上（`json.success === false`）。`expectFail` 原来只处理
     * 前一种，于是走信封那条路的用例照样记成失败 —— 回滚验证就是这么每次
     * 挂一条假红的。假红多了人就不看红色了，真问题跟着被略过。
     */
    if (opts.expectFail) {
      /*
       * 「失败了」还不够 —— 得是**因为那件事**失败的。
       *
       * 光看有没有失败，用例会因为完全无关的原因变绿：目标一个都没匹配上、
       * 参数名写错、工程没连 —— 报错内容天差地别，`expectFail` 一律照收。
       * `expectFail: { contains: '…' }` 时对着错误正文核一句，
       * 这样「该失败」和「按预期的那种失败」才是两回事。
       */
      const wanted =
        (typeof opts.expectFail === 'object' ? opts.expectFail.contains : undefined) ??
        opts.contains
      const reason = String(json?.error ?? '')
      if (wanted && !reason.includes(wanted)) {
        results.push({
          name,
          verdict: 'fail',
          note: `失败了，但原因里没有「${wanted}」：${reason}`
        })
        console.log(`  ❌ ${name} —— 失败原因不对\n       ${reason}`)
        return null
      }
      results.push({ name, verdict: 'pass', note: '按预期失败了', ms: json?.elapsedMs })
      console.log(`  ✅ ${name}（按预期失败）`)
      return null
    }
    results.push({ name, verdict: 'fail', note: json?.error ?? `HTTP ${status}` })
    console.log(`  ❌ ${name}\n       ${json?.error ?? status}`)
    return null
  }

  const out = readOutput(json.data)
  // 工具**没抛异常**不等于做成了：不少工具把失败编码进返回的 JSON。
  // 只看 HTTP 200 的话，这一整类「静默失败」全会被记成通过。
  const claimsFailure = out.parsed && typeof out.parsed === 'object' && out.parsed.success === false

  /**
   * 有些用例考的恰恰是「该拒绝的时候有没有拒绝」——「有未保存改动时不许换关卡」
   * 就是一条。对它们来说 success:false 是**正确答案**，成功反而是缺陷。
   *
   * 没有这个开关的话，这类用例只有两种写法：要么记成失败（报告里一片红，
   * 真问题被淹掉），要么根本不写 —— 而不写意味着"该拒绝却没拒绝"永远没人发现，
   * 那正是会让用户丢工作的那一类退化。
   */
  if (opts.expectFail) {
    if (claimsFailure) {
      /*
       * 这条分支以前**不看 `contains`**，只有上面那条（失败提到信封上的）看。
       *
       * 于是 `expectFail: { contains: '…' }` 写在走返回体这条路的用例上时，
       * 那半句核对被静默跳过 —— 工程没连、参数名写错、路径打错，一律记成绿。
       * 正是 `contains` 这个机制当初要消灭的假绿，只不过藏在另一条分支里。
       */
      const wanted =
        (typeof opts.expectFail === 'object' ? opts.expectFail.contains : undefined) ??
        opts.contains
      const reason = String(out.parsed?.error ?? '')
      if (wanted && !reason.includes(wanted)) {
        results.push({
          name,
          verdict: 'fail',
          note: `拒了，但原因里没有「${wanted}」：${reason}`
        })
        console.log(`  ❌ ${name} —— 拒绝原因不对\n       ${reason}`)
        return out
      }
      results.push({ name, verdict: 'pass', note: '按预期拒绝了', ms: json.elapsedMs })
      console.log(`  ✅ ${name}（按预期拒绝）`)
      return out
    }
    results.push({ name, verdict: 'fail', note: '预期被拒绝，实际却成功了' })
    console.log(`  ❌ ${name} —— 预期被拒绝，实际却成功了`)
    return out
  }

  if (claimsFailure) {
    results.push({ name, verdict: 'fail', note: `返回体报失败: ${out.parsed.error ?? ''}` })
    console.log(`  ❌ ${name}（返回 success:false）\n       ${out.parsed.error ?? ''}`)
    return null
  }

  const note = opts.check ? opts.check(out) : ''
  // check 默认只警告。opts.hard 把它升成失败 —— 用于「返回 200 但值是错的」
  // 这一类：那正是材质工具历史上最会骗人的地方，警告色的话没人会停下来看
  const verdict = note ? (opts.hard ? 'fail' : 'warn') : 'pass'
  results.push({ name, verdict, note, ms: json.elapsedMs })
  console.log(
    `  ${note ? '⚠️ ' : '✅'} ${name} (${json.elapsedMs}ms)${note ? '\n       ' + note : ''}`
  )
  return out
}

/**
 * 直发裸 RPC，绕过工具层。
 *
 * 专门用来验**引擎侧的兜底校验**：有几条规则客户端预检已经拦住了
 * （参数节点缺 node_name、ComponentMask 缺 value），走工具层的话一条命令都发不出去，
 * 引擎那道关永远跑不到 —— 而客户端那份名单是手维护的，漂了就靠引擎兜底。
 * 所以兜底那一层必须单独验。
 */
async function rawStep(name, command, params, opts = {}) {
  const { json } = await post('/api/debug/ue-command', { command, params })
  // 失败时 executeUECommand 回的是 `{success:false, error}`，连 data 都没有，
  // 所以判据就是 success 这一个字段
  const reason = String(json?.error ?? json?.data?.error ?? '')
  const failed = json?.success === false

  if (opts.expectFail) {
    if (!failed) {
      results.push({ name, verdict: 'fail', note: '预期被引擎拒绝，实际却成功了' })
      console.log(`  ❌ ${name} —— 预期被引擎拒绝，实际却成功了`)
      return null
    }
    /*
     * 期望的错误正文两种写法都认：`{expectFail:{contains}}`（和 step() 一样）
     * 和 `{expectFail:true, contains}`。
     *
     * 原来只认后一种，于是有人照着 step() 的写法写一条 rawStep 时，
     * `contains` 就是 undefined，这一整段核对被静默跳过 ——「因为完全无关的原因
     * 失败」也算绿：工程没连、参数名写错、material_path 打错，一律照收。
     * 正是 contains 这个机制当初要消灭的假绿。
     * （step() 那边同一个洞在「失败写在返回体里」那条分支上，已经一并补了。）
     */
    const wanted =
      (typeof opts.expectFail === 'object' ? opts.expectFail.contains : undefined) ?? opts.contains
    if (wanted && !reason.includes(wanted)) {
      results.push({
        name,
        verdict: 'fail',
        note: `拒了，但原因里没有「${wanted}」：${reason}`
      })
      console.log(`  ❌ ${name} —— 拒绝原因不对
       ${reason}`)
      return null
    }
    results.push({ name, verdict: 'pass', note: '引擎侧按预期拒绝' })
    console.log(`  ✅ ${name}（引擎侧按预期拒绝）`)
    return null
  }

  const verdict = failed ? 'fail' : 'pass'
  results.push({ name, verdict, note: failed ? reason : '' })
  console.log(`  ${failed ? '❌' : '✅'} ${name}${failed ? '\n       ' + reason : ''}`)
  return json?.data ?? null
}

/**
 * 每轮先删掉验证目录。
 *
 * 不清的话第二次跑起来满屏 409「已存在」—— 那是**正确行为**被记成失败，
 * 会把真正的问题淹掉。
 */
async function cleanup() {
  // 只能逐个删资产：`ue_content_delete` 的参数描述写着「支持 Folder 路径」，
  // 但插件的 content.delete 里**根本没有文件夹分支** —— 传目录一律失败，
  // 而且错误只说「无响应或 ok=false」，看不出是「不支持文件夹」。
  // 这是本次验证发现的问题之一，不是脚手架偷懒。
  const { json } = await post('/api/debug/tool', {
    name: 'ue_content_delete',
    args: {
      paths: [
        BP,
        MAT,
        MI,
        // 材质进阶那一套的产物。漏掉的话第二轮全是 409「已存在」，
        // 而那是正确行为被记成失败
        `${FOLDER}/M_VerifyGraph.M_VerifyGraph`,
        // 引脚那一套整套写在 M_VerifyPins 上。这条原来漏了 —— 而 material_create
        // 没传 fail_if_exists，第二轮是**原地覆盖**而不是 409，所以没人发现：
        // 表面上一直是绿的，实际每轮都在一份上轮残留的资产上跑，
        // 而且这份资产永久留在用户工程里
        `${FOLDER}/M_VerifyPins.M_VerifyPins`,
        `${FOLDER}/MPC_VerifyWeather.MPC_VerifyWeather`,
        `${FOLDER}/MF_VerifyHelper.MF_VerifyHelper`
      ]
    }
  })
  console.log(`清理：${json?.success ? '已删旧资产' : '（本来就没有）'}`)
}

async function blueprintSuite() {
  console.log('\n=== 蓝图：造一个「按 E 开门」的蓝图并编译通过 ===\n')

  await step('blueprint_create', {
    name: 'BP_VerifyDoor',
    parent_class: '/Script/Engine.Actor',
    folder: FOLDER
  })

  await step('blueprint_describe', { blueprint_path: BP })

  await step('blueprint_add_component', {
    blueprint_name: BP,
    component_type: 'StaticMeshComponent',
    component_name: 'DoorMesh',
    location: { x: 0, y: 0, z: 0 }
  })

  await step('blueprint_add_variable', {
    blueprint_path: BP,
    name: 'bIsOpen',
    type: 'bool',
    default_value: 'false'
  })

  // 这里原来调的是 `blueprint_list_graphs` —— **那个工具从来不存在**。
  // 插件端有 blueprint.list_graphs 这个 RPC，但工具层把它并进了
  // blueprint_describe（见 toolNames.ts），所以这一步一直在报
  // 「Unknown tool」，只是没人细看。图表名从 describe 里拿。
  const graphs = await step('blueprint_describe', { blueprint_path: BP })
  if (graphs) {
    const names = JSON.stringify(graphs.parsed ?? graphs.text)
    ctx.hasEventGraph = names.includes('EventGraph')
  }

  // 写图之前先查 —— 这是新链条的第一步，也是「不用先建节点就知道引脚」的证明
  const search = await step('blueprint_search_nodes', {
    query: 'print',
    blueprint_path: BP
  })
  if (search) {
    const fns = search.parsed?.functions ?? search.details?.functions ?? []
    ctx.printFn = fns.find((f) => (f.name ?? '') === 'PrintString') ?? fns[0]
    console.log(
      `       搜到 ${fns.length} 个函数；PrintString=${ctx.printFn?.member_name ?? '未找到'}` +
        `，引脚 ${(ctx.printFn?.params ?? []).map((x) => x.name).join('/') || '无'}`
    )
  }

  /**
   * 一次调用写完整张图：节点 + 连线 + 引脚字面量 + 布局 + 编译。
   *
   * 这一整块以前是六步（add_node ×2 → get_graph 拿 node_id → connect_pins →
   * set_pin_value → compile），每一步都要等一个来回。
   */
  const applied = await step('blueprint_apply_graph', {
    blueprint_path: BP,
    graph_name: 'EventGraph',
    nodes: [
      { id: 'open', class: 'InputAction', member_name: 'OpenDoor' },
      { id: 'gate', class: 'Branch' },
      {
        id: 'say',
        class: 'Function',
        member_name: ctx.printFn?.member_name ?? 'KismetSystemLibrary.PrintString',
        pin_defaults: { InString: 'door opened' }
      }
    ],
    connections: [
      { from: 'open.Pressed', to: 'gate.execute' },
      { from: 'gate.then', to: 'say.execute' }
    ]
  })
  if (applied) {
    const parsed = applied.parsed ?? applied.details ?? {}
    console.log(
      `       写入 ${parsed.created_count ?? '?'} 节点 / ${parsed.connection_count ?? '?'} 连线` +
        `，编译错误 ${parsed.compile_error_count ?? 0} 个`
    )
  }

  /**
   * 回读校验：写进去的东西真的在图里。
   *
   * 只能按 `class` 找，不能按你写进去的类型名找 —— **写进去和读回来是两套
   * 词汇**：`class: 'Branch'` 建出来的节点，get_graph 报的是
   * `K2Node_IfThenElse`，title 还是本地化的「分支」。
   */
  const graph = await step('blueprint_get_graph', {
    blueprint_path: BP,
    graph_name: 'EventGraph'
  })
  if (graph) {
    const nodes = graph.parsed?.nodes ?? graph.details?.nodes ?? []
    ctx.nodes = nodes
    const byClass = (cls) => nodes.find((n) => (n.class ?? '') === cls)
    ctx.inputNode = byClass('K2Node_InputAction')
    ctx.branchNode = byClass('K2Node_IfThenElse')
    ctx.callNode = byClass('K2Node_CallFunction')
    console.log(
      `       图里 ${nodes.length} 个节点；InputAction=${ctx.inputNode?.id ?? '未找到'}` +
        ` Branch=${ctx.branchNode?.id ?? '未找到'} CallFunction=${ctx.callNode?.id ?? '未找到'}`
    )
  }

  /**
   * 失败必须整体回滚 —— 这条是新接口最重要的性质，也最容易悄悄退化。
   *
   * 故意混一个建得出来的节点和一个函数名拼错的节点。正确行为是**一个都不建**，
   * 图里的节点数和调用前一样。旧实现会把好的那个建出来、坏的那个报错，
   * 留下半张图。
   */
  const beforeCount = (ctx.nodes ?? []).length
  await step(
    'blueprint_apply_graph',
    {
      blueprint_path: BP,
      graph_name: 'EventGraph',
      nodes: [
        { id: 'ok', class: 'Event', member_name: 'ReceiveEndPlay' },
        { id: 'bad', class: 'Function', member_name: 'KismetSystemLibrary.NoSuchFunctionHere' }
      ],
      connections: []
    },
    // 这一步**就是要它失败**。不标 expectFail 的话，报告里每次都挂一条红 ——
    // 而常驻的假红会训练人忽略红色，真问题跟着一起被略过。
    { expectFail: true }
  )
  const after = await step('blueprint_get_graph', {
    blueprint_path: BP,
    graph_name: 'EventGraph'
  })
  if (after && beforeCount > 0) {
    const afterCount = (after.parsed?.nodes ?? after.details?.nodes ?? []).length
    console.log(
      afterCount === beforeCount
        ? `       ✓ 回滚生效：节点数仍是 ${afterCount}`
        : `       ✖ 回滚失效：${beforeCount} → ${afterCount}，留下了半张图`
    )
  }

  await step('blueprint_create_function', {
    blueprint_path: BP,
    function_name: 'ToggleDoor'
  })

  await step('blueprint_set_property', {
    blueprint_path: BP,
    properties: { bCanBeDamaged: false }
  })

  await step('blueprint_compile', { blueprint_path: BP, save: true })

  // graph_name 必须是**已存在**的图。ToggleDoor 上一步刚建出来，所以这次能进去；
  // 传一个没建过的名字会拿到 404 Graph not found（这是真实语义，不是 bug）
  await step('blueprint_apply_graph', {
    blueprint_path: BP,
    graph_name: 'ToggleDoor',
    nodes: [{ id: 'n1', class: 'Branch' }],
    connections: []
  })
}

async function materialSuite() {
  console.log('\n=== 材质：建主材质 + 参数节点 → 实例 → 调参 → 上到 Actor ===\n')

  // 这一套的断言全部针对「返回 200 但事情没做成」—— 材质工具历史上
  // 每一个坑都是这个形状：模型收到成功，用户拿到一个黑材质。
  // 所以下面每一步都回读实际值，而不是只看有没有报错。
  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.01

  await step('material_create', {
    material_name: 'M_VerifyWood',
    destination_path: FOLDER,
    shading_model: 'DefaultLit'
  })

  await step(
    'material_describe',
    { path: MAT },
    {
      hard: true,
      check: (o) => {
        const d = o.parsed ?? o.details ?? {}
        if (!d.blend_mode) return 'describe 没回 blend_mode'
        if (!d.shading_model) return 'describe 没回 shading_model'
        if (d.two_sided === undefined) return 'describe 没回 two_sided'
        return ''
      }
    }
  )

  // ---- initial_value 是否真的生效（以前任何形状都静默失效）----
  //
  // 逐节点的 material_add_node 已下线（它不排版），建节点一律走整图写入
  const colorNode = await step(
    'material_apply_graph',
    {
      path: MAT,
      nodes: [{ id: 'color', node_type: 'Constant3Vector', value: { r: 0.4, g: 0.26, b: 0.13 } }],
      compile: false
    },
    {
      hard: true,
      check: (o) => {
        const d = o.details ?? {}
        const w = (d.warnings ?? []).find((x) => x.includes('初始值'))
        if (w) return `initial_value 没设上：${w}`
        if (d.created !== 1) return `没建出节点：created=${d.created}`
        return ''
      }
    }
  )
  ctx.matNodeId = colorNode?.details?.node_ids?.color
  console.log(`       颜色节点 = ${ctx.matNodeId ?? '没拿到 node_id'}`)

  // ---- get_graph 的 include_values（以前解析了却从不使用）----
  await step(
    'material_get_graph',
    { path: MAT, include_values: true },
    {
      hard: true,
      check: (o) => {
        const nodes = (o.parsed ?? o.details ?? {}).nodes ?? []
        const hit = nodes.find((n) => n.node_id === ctx.matNodeId)
        if (!hit) return `图里找不到 ${ctx.matNodeId}`
        if (!near(hit.value?.r, 0.4))
          return `include_values 没给出节点值：${JSON.stringify(hit.value)}`
        return ''
      },
      skip: !ctx.matNodeId ? '没拿到 node_id' : undefined
    }
  )

  // ---- 改颜色（以前颜色节点一律设不了，还回 200）----
  await step(
    'material_set_node_value',
    { path: MAT, node_id: ctx.matNodeId, value: { r: 0.8, g: 0.1, b: 0.05 } },
    {
      hard: true,
      check: (o) => {
        const d = o.details ?? {}
        if (!near(d.new_value?.r, 0.8)) return `new_value 不对：${JSON.stringify(d.new_value)}`
        if (!near(d.old_value?.r, 0.4)) return `old_value 不对：${JSON.stringify(d.old_value)}`
        return ''
      },
      skip: !ctx.matNodeId ? '没拿到 node_id' : undefined
    }
  )

  // ---- 对没有值的节点设值必须失败（以前取消事务却照样回 200）----
  const mul = await step('material_apply_graph', {
    path: MAT,
    nodes: [{ id: 'mul', node_type: 'Multiply' }],
    compile: false
  })
  const mulId = mul?.details?.node_ids?.mul
  await step(
    'material_set_node_value',
    { path: MAT, node_id: mulId, value: 1 },
    { expectFail: true, skip: !mulId ? '没建出 Multiply' : undefined }
  )

  // ---- source_pin 是否按名字生效（以前接主节点时写死 0 号输出）----
  // 顺带把剩下的节点和线一次写完：整图写入本来就是一次调用能做完的事
  const rest = await step(
    'material_apply_graph',
    {
      path: MAT,
      nodes: [
        { id: 'tex', node_type: 'TextureSample' },
        {
          id: 'rough',
          node_type: 'ScalarParameter',
          node_name: 'Roughness',
          group_name: 'Surface',
          value: 0.5
        },
        {
          id: 'tint',
          node_type: 'VectorParameter',
          node_name: 'Tint',
          value: { r: 1, g: 1, b: 1 }
        }
      ],
      connections: [
        // A 是第 4 号输出。以前这里恒为 0（RGB），却回显 "….A" 让人以为对了
        { from: 'tex.A', to: 'Material.Opacity' },
        ...(ctx.matNodeId ? [{ from: `${ctx.matNodeId}.RGB`, to: 'Material.BaseColor' }] : [])
      ],
      compile: false
    },
    {
      hard: true,
      check: (o) => {
        const d = o.details ?? {}
        if (d.stopped_at) return `停在「${d.stopped_at}」，只连好 ${d.connected} 根线`
        if (d.warnings?.length) return `有警告：${d.warnings.join('；')}`
        return ''
      }
    }
  )

  const texId = rest?.details?.node_ids?.tex

  // ---- 排版必须真的发生：逐节点那条路没有这一步，交付的就是一堆叠在一起的节点 ----
  await step(
    'material_tidy_graph',
    { path: MAT },
    {
      hard: true,
      check: (o) => {
        const moved = (o.parsed ?? o.details ?? {}).moved ?? 0
        return moved >= 2 ? '' : `排版只挪了 ${moved} 个节点`
      },
      skip: rest ? undefined : '前一步没建出节点'
    }
  )

  // ---- 真编译错误（以前 compiled 恒为 true）----
  await step(
    'material_compile',
    { path: MAT },
    {
      hard: true,
      check: (o) => {
        const d = o.parsed ?? o.details ?? {}
        return d.compiled === true ? '' : `编译失败：${JSON.stringify(d.errors)}`
      }
    }
  )

  // ---- 材质实例：现在有工具了，不用再走裸 RPC ----
  const inst = await step(
    'material_create_instance',
    { path: MAT, instance_name: 'MI_VerifyWood', destination_path: FOLDER },
    {
      hard: true,
      check: (o) => {
        const p = o.details?.available_params ?? {}
        return (p.scalar_params ?? []).includes('Roughness')
          ? ''
          : `实例上没有 Roughness：${JSON.stringify(p)}`
      }
    }
  )
  const hasInstance = !!inst

  // ---- 参数名校验（以前拼错也报成功）----
  await step(
    'material_set_param',
    { path: MI, params: [{ name: 'Roughnes', value: 0.3 }] },
    { expectFail: true, skip: !hasInstance ? '没建出实例' : undefined }
  )

  await step(
    'material_set_param',
    {
      path: MI,
      params: [
        { name: 'Roughness', value: 0.3 },
        // {x,y,z} 以前会被当成 r/g/b 全缺省，静默设成纯黑
        { name: 'Tint', value: { x: 0.9, y: 0.2, z: 0.2 } }
      ]
    },
    { skip: !hasInstance ? '没建出实例' : undefined }
  )

  await step(
    'material_describe',
    { path: MI },
    {
      hard: true,
      check: (o) => {
        const d = o.parsed ?? o.details ?? {}
        const tint = (d.vector_params ?? []).find((x) => x.name === 'Tint')
        if (!near(tint?.value?.r, 0.9)) return `{x,y,z} 没落对：${JSON.stringify(tint?.value)}`
        const rough = (d.scalar_params ?? []).find((x) => x.name === 'Roughness')
        if (!near(rough?.value, 0.3)) return `标量没落对：${JSON.stringify(rough?.value)}`
        return ''
      },
      skip: !hasInstance ? '没建出实例' : undefined
    }
  )

  // ---- set_property（这次才第一次被暴露成工具）----
  await step('material_set_property', {
    path: MAT,
    properties: { blend_mode: 'Translucent', two_sided: true }
  })
  await step(
    'material_describe',
    { path: MAT },
    {
      hard: true,
      check: (o) => {
        const d = o.parsed ?? o.details ?? {}
        if (!String(d.blend_mode).includes('Translucent'))
          return `blend_mode 没改动：${d.blend_mode}`
        if (d.two_sided !== true) return `two_sided 没改动：${d.two_sided}`
        return ''
      }
    }
  )

  // ---- 编译错误到底报不报得出来 ----
  //
  // 这一条是这套里最容易写成假绿的：上面那次 compile 时混合模式还是 Opaque，
  // 接在 Opacity 上的空 TextureSample 根本不参与编译，引擎不吭声 ——
  // 于是 `compiled: true` 是当时的实情，而材质编辑器里那个大红 ERROR!
  // 是改成 Translucent **之后**才出现的。中间没有重新编译，就什么也没验到。
  //
  // 现在刚把混合模式改成了 Translucent，同一张图必然报
  // "Missing input texture"。报不出来就说明 GetCompileErrors() 这条路是通不了的。
  await step(
    'material_compile',
    { path: MAT, force_recompile: true },
    {
      hard: true,
      check: (o) => {
        const d = o.details ?? {}
        const errors = d.errors ?? []
        if (d.compiled !== false || errors.length === 0) {
          return '空贴图接在 Translucent 的 Opacity 上，编译器应当报错，这里却报了成功'
        }
        if (!errors.some((e) => /texture/i.test(e))) {
          return `报了错但不是缺贴图那条：${JSON.stringify(errors)}`
        }
        return ''
      }
    }
  )

  // 补上贴图，同一张图应当从报错变成通过 —— 只验"能报错"不验"能恢复"的话，
  // 一个永远返回失败的实现也能骗过上一条
  await step(
    'material_set_node_value',
    {
      path: MAT,
      node_id: texId,
      value: '/Engine/EngineResources/DefaultTexture.DefaultTexture'
    },
    { skip: !texId ? '没建出 TextureSample' : undefined }
  )

  await step(
    'material_compile',
    { path: MAT, force_recompile: true },
    {
      hard: true,
      check: (o) => {
        const d = o.details ?? {}
        return d.compiled === true ? '' : `补上贴图后仍编不过：${JSON.stringify(d.errors)}`
      },
      skip: !texId ? '没建出 TextureSample' : undefined
    }
  )

  // apply 要场景里真有这个 Actor，先摆一个
  const spawned = await post('/api/debug/tool', {
    name: 'ue_spawn_actor',
    // 必须带 mesh：不带的话 StaticMeshComponent 上没有网格，GetNumMaterials() 是 0，
    // 这个 Actor 每次都落进「没有材质槽」的跳过，下面那条 check 就断言不到它
    args: {
      class: '/Script/Engine.StaticMeshActor',
      name: 'UAVerifyCube',
      mesh: '/Engine/BasicShapes/Cube.Cube'
    }
  })
  /*
   * 这一步以前没有 check —— 只要工具不抛就算过，于是整个组件挑选逻辑
   * （挑哪个、报不报旁边还有谁、跳过的原因归不归类）在真机上一条都没验。
   * 至少把「挑中了谁」和「账对不对得上」钉住。
   */
  await step(
    'material_apply',
    // 用 filter 而不是 names：`actor.spawn` 报的 name 是**内部对象名**，
    // 而 material.apply 按 **label** 匹配 —— 拿 spawn 报的名字来找必定 404
    { path: MI, targets: { filter: { class: 'StaticMeshActor' } } },
    {
      hard: true,
      check: (o) => {
        const d = o.details ?? {}
        const actor = (d.actors ?? [])[0]
        if (!actor) return '一个 Actor 都没应用上'
        if (!actor.component) return '没回 component —— 挑中了哪个组件说不出来'
        if (!actor.path) return '没回 path —— 标签重名时没法点名重试'
        // applied + skipped 必须等于 target_count，差额那几个就是被静默吞掉的
        const applied = d.applied_count ?? 0
        const skipped = d.skipped_count ?? 0
        const targets = d.target_count ?? 0
        return applied + skipped === targets
          ? ''
          : `账对不上：applied ${applied} + skipped ${skipped} ≠ target ${targets}`
      },
      skip: !spawned.json?.success ? '没能在关卡里摆出测试 Actor' : undefined
    }
  )

  /*
   * 全跳过那条路必须把原因带回来。
   *
   * 引擎在一个都没应用上时回 404，盒子这边 `assertRpcOk` 会在 toOutcome 之前
   * 就抛 —— 只有写进 `error` 的东西到得了模型手上。所以这里断言的是
   * **抛出来的那句话里有没有原因**，不是响应体里有没有。
   */
  await step(
    'material_apply',
    // 打在真的存在的目标上（上面刚摆的那个 StaticMeshActor），用越界槽位逼出全跳过。
    // 换成关卡里可能压根没有的类，会在「一个目标都没匹配上」那一步就失败 ——
    // 根本进不了跳过那段循环，这条用例也就什么都没验到
    { path: MI, targets: { filter: { class: 'StaticMeshActor' } }, slot_index: 99 },
    // 钉的是**原因正文**，不是 `Reasons:` 这个前缀。
    // 只钉前缀的话，把「每类留一句完整原因」退回「只留分类名」照样是绿的，
    // 而那半句才是模型能拿来行动的东西；反过来改个措辞又会假红
    { expectFail: { contains: 'slot(s)' } }
  )

  await step(
    'material_delete_node',
    { path: MAT, node_id: ctx.matNodeId },
    { skip: !ctx.matNodeId ? '没拿到 node_id' : undefined }
  )
}

/**
 * 材质图的「往回收」与「复用」—— 这一批工具补的是同一个洞：
 * 图此前只能往上加，接错了改不回来、试错留下的死节点清不掉、
 * 一串节点复用不了、改之前不知道影响面。
 *
 * 断言全部针对「返回 200 但事情没做成」。这一批里最会骗人的两处：
 *   - 断线：本来就没接线时该报「没什么可断的」，不该报成功也不该报失败
 *   - MPC / 材质函数：资产没挂上时节点照样建出来（灰的 / 没引脚），
 *     只在响应体里埋一个 collection_applied:false
 */
async function materialGraphSuite() {
  console.log('\n=== 材质进阶：断线 / 清死节点 / 参数集合 / 材质函数 / 反查引用 ===\n')

  const MAT2 = `${FOLDER}/M_VerifyGraph.M_VerifyGraph`
  const MPC = `${FOLDER}/MPC_VerifyWeather.MPC_VerifyWeather`
  const MF = `${FOLDER}/MF_VerifyHelper.MF_VerifyHelper`
  // 浮点比较。引擎回来的值会有精度损失，`=== 0.25` 会莫名其妙地失败
  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.01

  await step('material_create', {
    material_name: 'M_VerifyGraph',
    destination_path: FOLDER
  })

  // ── 断线 ────────────────────────────────────────────────────────────
  //
  // 先接上再断开。只验「断开返回成功」是不够的：一个什么都不做的实现
  // 也能返回成功，所以断完要回头读图确认真的断了。
  const constNode = await step('material_apply_graph', {
    path: MAT2,
    nodes: [{ id: 'c', node_type: 'Constant3Vector', value: { r: 1, g: 0, b: 0 } }],
    connections: [{ from: 'c.RGB', to: 'Material.BaseColor' }],
    compile: false
  })
  const constId = constNode?.details?.node_ids?.c

  await step(
    'material_disconnect_pins',
    { path: MAT2, target_node: 'Material', target_pin: 'BaseColor' },
    {
      hard: true,
      check: (o) =>
        o.details?.disconnected === true ? '' : '断线报了成功但 disconnected 不是 true',
      skip: !constId ? '没建出常量节点' : undefined
    }
  )

  // 回头读图确认真断了。这一条才是断线用例的实际断言 ——
  // 上一条只证明工具没报错
  //
  // 材质工具**一律**用 `path` 指「这个工具操作的那个资产」，插件侧那些
  // material_path / asset_path / parent_path 已经由工具层转过一次了
  // （见 ue-material/index.ts 的 renamePath）。
  //
  // 这个脚本里曾经有 12 处还写着插件侧的键名，全部挂在 zod 校验上
  // （「expected string, received undefined」）—— 54 条里红 13 条，
  // 其中一条还连累了断线用例：disconnect 根本没跑，读图当然还看得见那根线。
  // 假红多了人就不看红色了。
  await step(
    'material_get_graph',
    { path: MAT2 },
    {
      hard: true,
      check: (o) => {
        const d = o.parsed ?? o.details ?? {}
        const conns = d.connections ?? []
        const stillThere = conns.some((c) => /BaseColor/i.test(JSON.stringify(c)))
        return stillThere ? '断线之后 BaseColor 上的连线还在图里' : ''
      },
      skip: !constId ? '没建出常量节点' : undefined
    }
  )

  // 已经断开的再断一次，应当是「没什么可做的」而不是失败 ——
  // 「确保这里是断的」是合法诉求，报失败会逼调用方先查一次再决定调不调
  await step(
    'material_disconnect_pins',
    { path: MAT2, target_node: 'Material', target_pin: 'BaseColor' },
    {
      hard: true,
      check: (o) =>
        o.details?.disconnected === false ? '' : '空引脚上重复断线应当返回 disconnected:false'
    }
  )

  // ── 清理死节点 ──────────────────────────────────────────────────────
  //
  // 上面那个常量节点现在没接任何输出，正是「死节点」。
  await step(
    'material_delete_unused_nodes',
    { path: MAT2 },
    {
      hard: true,
      check: (o) => {
        const d = o.details ?? {}
        if (d.dry_run !== true) return 'dry_run 默认应当是 true，这里却真的删了'
        if ((d.unused_count ?? 0) < 1) return `断开的常量节点应当被认成死节点：${d.unused_count}`
        if ((d.deleted_count ?? 0) !== 0) return 'dry_run 下不该真的删'
        return ''
      },
      skip: !constId ? '没建出常量节点' : undefined
    }
  )

  await step(
    'material_delete_unused_nodes',
    { path: MAT2, dry_run: false },
    {
      hard: true,
      check: (o) => ((o.details?.deleted_count ?? 0) >= 1 ? '' : 'dry_run=false 时应当真的删掉'),
      skip: !constId ? '没建出常量节点' : undefined
    }
  )

  // 删完再查一次：应当一个死节点都不剩。只验「删了 N 个」的话，
  // 一个删一半的实现也能过
  await step(
    'material_delete_unused_nodes',
    {
      path: MAT2
    },
    {
      hard: true,
      check: (o) => ((o.details?.unused_count ?? 0) === 0 ? '' : '清理之后仍有死节点')
    }
  )

  // ── 材质参数集合 ────────────────────────────────────────────────────
  const mpc = await step(
    'material_parameter_collection',
    {
      action: 'create',
      collection_name: 'MPC_VerifyWeather',
      destination_path: FOLDER,
      scalars: [{ name: 'Wetness', value: 0.25 }],
      vectors: [{ name: 'SkyTint', value: { r: 0.5, g: 0.6, b: 1 } }]
    },
    {
      hard: true,
      check: (o) => {
        const d = o.details ?? {}
        const scalar = (d.scalars ?? []).find((s) => s.name === 'Wetness')
        if (!near(scalar?.value, 0.25)) return `标量没落对：${JSON.stringify(d.scalars)}`
        if (!(d.vectors ?? []).some((v) => v.name === 'SkyTint')) return '向量参数没建出来'
        return ''
      }
    }
  )
  const hasMpc = !!mpc

  // 改默认值：同名参数应当就地改，不是再加一条
  await step(
    'material_parameter_collection',
    {
      action: 'set',
      collection_path: MPC,
      scalars: [{ name: 'Wetness', value: 0.9 }]
    },
    {
      hard: true,
      check: (o) => {
        const scalars = o.details?.scalars ?? []
        if (scalars.filter((s) => s.name === 'Wetness').length !== 1)
          return `同名参数被加成了两条：${JSON.stringify(scalars)}`
        return near(scalars.find((s) => s.name === 'Wetness')?.value, 0.9)
          ? ''
          : '改默认值没落到集合里'
      },
      skip: !hasMpc ? '没建出参数集合' : undefined
    }
  )

  /**
   * 「资产没挂上」在整图写入里是一条 warning，不是 `collection_applied: false`。
   * 引擎那个字段埋在响应体里，apply_graph 把它翻译成人能读的一句话再往外冒 ——
   * 用例断的就该是模型实际看得见的那份。
   */
  const warnedAbout = (o, id) => (o.details?.warnings ?? []).some((w) => w.startsWith(`${id}：`))

  // 引用它：这一步才决定 MPC 有没有用。建出来不引用的话它什么也不影响
  await step(
    'material_apply_graph',
    {
      path: MAT2,
      nodes: [
        {
          id: 'mpcOk',
          node_type: 'CollectionParameter',
          collection_path: MPC,
          node_name: 'Wetness'
        }
      ],
      compile: false
    },
    {
      hard: true,
      check: (o) =>
        warnedAbout(o, 'mpcOk') ? `参数集合没挂上：${(o.details?.warnings ?? []).join('；')}` : '',
      skip: !hasMpc ? '没建出参数集合' : undefined
    }
  )

  // 参数名拼错时必须挡下来。挡不住的话节点是灰的，而症状要到编译才出现
  await step(
    'material_apply_graph',
    {
      path: MAT2,
      nodes: [
        {
          id: 'mpcTypo',
          node_type: 'CollectionParameter',
          collection_path: MPC,
          node_name: 'Wetnes'
        }
      ],
      compile: false
    },
    {
      hard: true,
      check: (o) =>
        warnedAbout(o, 'mpcTypo') ? '' : '参数名拼错了，却报成挂上了 —— 这个节点其实是灰的',
      skip: !hasMpc ? '没建出参数集合' : undefined
    }
  )

  // collection_path 不传：同样该被点破，而不是建一个残节点就完事
  await step(
    'material_apply_graph',
    {
      path: MAT2,
      nodes: [{ id: 'mpcBare', node_type: 'CollectionParameter', node_name: 'Wetness' }],
      compile: false
    },
    {
      hard: true,
      check: (o) => (warnedAbout(o, 'mpcBare') ? '' : '少传 collection_path 却没有报出来')
    }
  )

  // ── 材质函数 ────────────────────────────────────────────────────────
  const mf = await step('material_create_function', {
    function_name: 'MF_VerifyHelper',
    destination_path: FOLDER,
    description: '验证用'
  })

  await step(
    'material_apply_graph',
    {
      path: MAT2,
      nodes: [{ id: 'mfOk', node_type: 'MaterialFunctionCall', function_path: MF }],
      compile: false
    },
    {
      hard: true,
      check: (o) =>
        warnedAbout(o, 'mfOk') ? `材质函数没挂上：${(o.details?.warnings ?? []).join('；')}` : '',
      skip: !mf ? '没建出材质函数' : undefined
    }
  )

  // 不传 function_path 时节点会一个引脚都没有，症状要到下一步连线才暴露 ——
  // 所以必须在这一步就报出来
  await step(
    'material_apply_graph',
    {
      path: MAT2,
      nodes: [{ id: 'mfBare', node_type: 'MaterialFunctionCall' }],
      compile: false
    },
    {
      hard: true,
      check: (o) => (warnedAbout(o, 'mfBare') ? '' : '少传 function_path 却没有报出来')
    }
  )

  // ── 反查引用 ────────────────────────────────────────────────────────
  //
  // **必须先存盘。** AssetRegistry 的引用关系是从已保存的包里读的，
  // 内存里刚建好还没落盘的引用它看不见 —— 第一次跑就是漏了这一步，
  // 明明 M_VerifyGraph 正引用着 MPC，却查回 0 个引用者。
  //
  // 这不是脚手架的细节：真实使用里同样会踩到（改完材质没存就问「谁在用」），
  // 所以工具侧也加了未保存警告，见下面那条用例。
  await step('ue_save', { scope: 'all' })

  /*
   * M_VerifyGraph 现在引用着 MPC，所以反查 MPC 应当能查到它。
   *
   * **这一条目前稳定挂**（2026-09-10 / UE 5.5 实测，连跑两轮都挂在同一处），
   * 而且不是随机抖动：跑完整轮之后单独再查同一个路径，`referencer_count` 就是 1。
   * 也就是说资产注册表**在这一步的时刻还没把刚 ue_save 下去的引用索引进来**。
   *
   * 它以前从来没真正跑过 —— 这个调用的参数键名一直写着插件侧的 `asset_path`，
   * 每次都挂在 zod 校验上，红的原因看起来只是「参数不对」。键名修好之后
   * 才露出底下这个真问题。
   *
   * 没有就地改成 sleep 重试：那样等于把「保存之后多久能信这个结果」这个
   * 真问题盖掉，而这个工具的结论正是拿来决定「删不删」的。留红在这里，
   * 等着按它本来的样子解决。
   */
  await step(
    'material_get_referencers',
    { path: MPC },
    {
      hard: true,
      check: (o) => {
        const d = o.details ?? {}
        if ((d.referencer_count ?? 0) < 1) return 'MPC 已被材质引用，却查不到任何引用者'
        const paths = (d.referencers ?? []).map((r) => r.path).join(' ')
        return /M_VerifyGraph/.test(paths) ? '' : `引用者里没有 M_VerifyGraph：${paths}`
      },
      skip: !hasMpc ? '没建出参数集合' : undefined
    }
  )

  // 没人用的资产要如实回 0，不能因为查不到就报错 ——
  // 「没有引用」正是删除前想确认的那个答案
  await step(
    'material_get_referencers',
    { path: MF },
    {
      hard: true,
      check: (o) =>
        typeof o.details?.referencer_count === 'number'
          ? ''
          : '没有引用者时应当回 0，而不是报错或不回这个字段',
      skip: !mf ? '没建出材质函数' : undefined
    }
  )

  // 带对象名的路径（/Game/X.X）也要能查。引用关系记在包上，
  // 不剥掉对象名的话一条都查不到，而且不报错 —— 看起来就是「没人用」
  await step(
    'material_get_referencers',
    { path: `${FOLDER}/MPC_VerifyWeather` },
    {
      hard: true,
      check: (o) =>
        (o.details?.referencer_count ?? 0) >= 1
          ? ''
          : '不带对象名的路径查不到引用者 —— 包名归一化没生效',
      skip: !hasMpc ? '没建出参数集合' : undefined
    }
  )

  await step('material_compile', { path: MAT2, force_recompile: true })
}

/**
 * 引脚这一层：说明书、分量输出、遮罩通道。
 *
 * 三件事单测都证明不了，因为它们全在引擎那一侧：
 *
 * 1. **`material_search_nodes` 读的是类默认对象**。编得过不等于读得到 ——
 *    `GetInputName` / `GetOutputs` 在 CDO 上有没有值，只有真引擎能回答。
 *
 * 2. **分量输出以前接不出去，而且不报错**。`Constant3Vector` 四个输出一个名字
 *    都没有，旧的 `ResolveOutputIndex` 匹配不到就掉进「接 0 号」的兜底 ——
 *    写 `.G` 实际接上的是 RGB，返回体照抄入参，看起来完全正确。
 *    所以这里的断言必须是**回读 from_pin**，不是「连线没报错」。
 *
 * 3. **`ComponentMask` 的四个通道位构造函数一个都不设**，默认全 0 编译出来恒为 0。
 *    以前没有任何命令碰得到它们，这个节点从加进 NodeTypeMap 那天起就是废的。
 */
async function materialPinsSuite() {
  console.log('\n=== 引脚：节点说明书 / 分量输出 / 遮罩通道 ===\n')

  const MAT3 = `${FOLDER}/M_VerifyPins.M_VerifyPins`

  // ── 节点说明书 ──────────────────────────────────────────────────────
  await step(
    'material_search_nodes',
    { query: 'lerp' },
    {
      hard: true,
      check: (o) => {
        const pins = (o.details?.nodes ?? []).flatMap((n) => (n.inputs ?? []).map((p) => p.name))
        // Lerp 的三个输入名是这条命令存在的理由 —— 猜不出来，只能问
        return ['A', 'B', 'Alpha'].every((p) => pins.includes(p))
          ? ''
          : `Lerp 的输入引脚没读全，拿到的是：${pins.join(',') || '(空)'}`
      }
    }
  )

  // TextureSample 的 UV 输入叫 Coordinates 不叫 UVs —— 真机上专门为这一条
  // 建过探针材质。它现在必须一次问出来
  await step(
    'material_search_nodes',
    { query: 'texturesample' },
    {
      hard: true,
      check: (o) => {
        const node = (o.details?.nodes ?? []).find((n) => n.node_type === 'TextureSample')
        const inputs = (node?.inputs ?? []).map((p) => p.name)
        const outputs = (node?.outputs ?? []).map((p) => p.name)
        if (!inputs.includes('Coordinates'))
          return `TextureSample 的输入里没有 Coordinates：${inputs.join(',')}`
        if (!outputs.includes('A')) return `TextureSample 的输出里没有 A：${outputs.join(',')}`
        return ''
      }
    }
  )

  // 无名输出必须按通道报出来，不能是一串 None
  await step(
    'material_search_nodes',
    { query: 'constant3vector' },
    {
      hard: true,
      check: (o) => {
        const node = (o.details?.nodes ?? []).find((n) => n.node_type === 'Constant3Vector')
        const outputs = (node?.outputs ?? []).map((p) => p.name)
        return ['RGB', 'R', 'G', 'B'].every((p) => outputs.includes(p))
          ? ''
          : `Constant3Vector 的四个输出没按通道命名：${outputs.join(',') || '(空)'}`
      }
    }
  )

  // ── 分量输出真的接得出去 ────────────────────────────────────────────
  await step('material_create', { material_name: 'M_VerifyPins', destination_path: FOLDER })

  const built = await step('material_apply_graph', {
    path: MAT3,
    nodes: [{ id: 'c3', node_type: 'Constant3Vector', value: { r: 0.2, g: 0.7, b: 0.9 } }],
    // 接的是 G 那一路，不是整体。以前这里会静默接上 RGB
    connections: [{ from: 'c3.G', to: 'Material.Roughness' }],
    compile: false
  })

  await step(
    'material_get_graph',
    { path: MAT3 },
    {
      hard: true,
      check: (o) => {
        // 目标引脚的键名是 `to_input`，不是和 `from_pin` 对称的 `to_pin` ——
        // 照对称猜过一次，断言当场假红
        const conns = o.details?.connections ?? []
        const rough = conns.find((c) => c.to_input === 'Roughness')
        if (!rough) return 'Roughness 上没有连线 —— 分量输出根本没接上'
        // from_output 才是硬证据：接对了是 2（G），被吞成整体输出就是 0（RGB）
        return rough.from_pin === 'G' && rough.from_output === 2
          ? ''
          : `接的是 ${rough.from_pin}（output ${rough.from_output}）而不是 G —— 分量输出又被吞成整体输出了`
      },
      skip: !built ? '没建出常量节点' : undefined
    }
  )

  /*
   * 认不出来的引脚名要报错，不能默默接 0 号 —— 那正是上面那个 bug 的成因。
   *
   * 两端**必须用上一步回来的真实 node_id**。这里一度写的是局部别名 `c3`，
   * 而局部别名只在建它的那一次调用里有效：这一次 `nodes: []`，映射表是空的，
   * `c3` 被原样当成 node_id 发给引擎，于是失败在「找不到源节点」——
   * 根本走不到引脚解析。`expectFail` 收下任何失败，所以它一直是绿的，
   * 而它要守的那条线一次都没跑过。
   */
  const c3Id = built?.details?.node_ids?.c3

  /*
   * 一个输出都没有的节点上，**任何**引脚写法都不许返回成功。
   *
   * 没挂函数资产的 MaterialFunctionCall 构造时就 `Outputs.Empty()`。给它存一个
   * 越界的 OutputIndex，下一次读图 `GetOutputs()[0]` 是无保护的下标访问，
   * TArray 的范围检查是 fatal —— 一个只读工具能把用户的编辑器崩掉。
   * 数字、整体输出别名是两条不同的路，各挡各的，得各测一条。
   */
  const bare = await step('material_apply_graph', {
    path: MAT3,
    nodes: [{ id: 'fn', node_type: 'MaterialFunctionCall' }],
    connections: [],
    compile: false
  })
  const bareId = bare?.details?.node_ids?.fn
  for (const pin of ['0', 'Out', 'Default']) {
    await step(
      'material_apply_graph',
      {
        path: MAT3,
        nodes: [],
        connections: [{ from: `${bareId}.${pin}`, to: 'Material.Specular' }],
        compile: false
      },
      { expectFail: true, skip: !bareId ? '没建出无输出节点' : undefined }
    )
  }

  // 崩没崩，看下一条只读命令还回不回话 —— 崩了就是 RPC 直接死掉
  await step(
    'material_get_graph',
    { path: MAT3 },
    {
      hard: true,
      check: (o) =>
        (o.details?.nodes ?? []).length > 0 ? '' : '读图回来是空的，编辑器可能已经崩了',
      skip: !bareId ? '没建出无输出节点' : undefined
    }
  )

  // 数字引脚必须是**纯数字**：IsNumeric 认正负号和小数点，`<+>` 会被 Atoi 变成 0，
  // 于是静默接上 0 号 —— 正是这个函数被重写要消灭的那种静默接错
  for (const pin of ['<+>', '1.5']) {
    await step(
      'material_apply_graph',
      {
        path: MAT3,
        nodes: [],
        connections: [{ from: `${c3Id}.${pin}`, to: 'Material.Metallic' }],
        compile: false
      },
      { expectFail: true, skip: !c3Id ? '上一步没回真实 node_id' : undefined }
    )
  }

  await step(
    'material_apply_graph',
    {
      path: MAT3,
      nodes: [],
      connections: [{ from: `${c3Id}.NotAPin`, to: 'Material.Metallic' }],
      compile: false
    },
    { expectFail: true, skip: !c3Id ? '上一步没回真实 node_id' : undefined }
  )

  /*
   * 输出**有真名**的节点上，整体输出别名不许被收下。
   *
   * BreakMaterialAttributes 的 35 个输出各有真名，第 0 个是 BaseColor。
   * 写 `.Default` 如果被收下，接到 Roughness 上的就是 BaseColor（float3 灌进
   * float），编译得过、画面不对、返回体照抄入参 —— 和这一整组要修的
   * 「分量输出被吞成整体输出」是同一类静默错误，只是方向相反。
   */
  const brk = await step('material_apply_graph', {
    path: MAT3,
    nodes: [{ id: 'brk', node_type: 'BreakMaterialAttributes' }],
    connections: [],
    compile: false
  })
  const brkId = brk?.details?.node_ids?.brk
  await step(
    'material_apply_graph',
    {
      path: MAT3,
      nodes: [],
      connections: [{ from: `${brkId}.Default`, to: 'Material.Specular' }],
      compile: false
    },
    { expectFail: true, skip: !brkId ? '没建出 BreakMaterialAttributes' : undefined }
  )

  // 同一个节点上写真名要照样接得上 —— 别为了挡住别名把真名也挡了
  await step(
    'material_apply_graph',
    {
      path: MAT3,
      nodes: [],
      connections: [{ from: `${brkId}.Roughness`, to: 'Material.Specular' }],
      compile: false
    },
    { skip: !brkId ? '没建出 BreakMaterialAttributes' : undefined }
  )

  /*
   * `RGB` / `RGBA` 是**通道宽度**，不是「整体输出」的别名。
   *
   * Constant4Vector 的五路输出是 RGBA/R/G/B/A，全都没有真名（靠 mask 推），
   * 所以「有真名就不吃别名」那道闸拦不住它。别名表里要是留着 RGB，
   * 写 `.RGB` 会静默接上 4 通道的 RGBA；反过来 Constant3Vector 上写 `.RGBA`
   * 会接上 3 通道那一路，alpha 悄悄没了。两种都得 400。
   */
  const c4 = await step('material_apply_graph', {
    path: MAT3,
    nodes: [{ id: 'c4', node_type: 'Constant4Vector', value: { r: 1, g: 0, b: 0, a: 1 } }],
    connections: [],
    compile: false
  })
  const c4Id = c4?.details?.node_ids?.c4
  await step(
    'material_apply_graph',
    {
      path: MAT3,
      nodes: [],
      connections: [{ from: `${c4Id}.RGB`, to: 'Material.Specular' }],
      compile: false
    },
    { expectFail: true, skip: !c4Id ? '没建出 Constant4Vector' : undefined }
  )
  await step(
    'material_apply_graph',
    {
      path: MAT3,
      nodes: [],
      connections: [{ from: `${c3Id}.RGBA`, to: 'Material.Specular' }],
      compile: false
    },
    { expectFail: true, skip: !c3Id ? '上一步没回真实 node_id' : undefined }
  )
  /*
   * **只有一路输出的节点上，`.RGB` 要照样收下。**
   *
   * 上面三条钉的都是「该拒的拒了」，可 RGB/RGBA 是被整条从别名表里删过一次的 ——
   * 那次把 `Add` / `Multiply` / `Lerp` 这些只有一路输出的节点一起打死了，
   * 而 `.RGB` 正是工具描述里给的例子。失败即停又不回滚，一次就把半张图留在用户材质里。
   * 这一条守的是那半边：删掉「Outputs.Num() == 1 时收 RGB」那段，这里必须变红。
   */
  const addNode = await step('material_apply_graph', {
    path: MAT3,
    nodes: [{ id: 'add1', node_type: 'Add' }],
    connections: [],
    compile: false
  })
  const addId = addNode?.details?.node_ids?.add1
  await step(
    'material_apply_graph',
    {
      path: MAT3,
      nodes: [],
      connections: [{ from: `${addId}.RGB`, to: 'Material.Specular' }],
      compile: false
    },
    { hard: true, skip: !addId ? '没建出 Add' : undefined }
  )

  // 各自真正有的那一路要照样接得上
  await step(
    'material_apply_graph',
    {
      path: MAT3,
      nodes: [],
      connections: [{ from: `${c4Id}.RGBA`, to: 'Material.EmissiveColor' }],
      compile: false
    },
    { skip: !c4Id ? '没建出 Constant4Vector' : undefined }
  )

  /*
   * 参数节点不给 node_name 要在**发命令之前**就被挡下来。
   *
   * 不挡的话 ParameterName 停在引擎默认的 `Param`，材质照样编译，
   * material_set_param 按你想要的名字调会「全部成功」而画面纹丝不动。
   * 现在客户端预检就拦住了，所以一个节点都不该建出来。
   */
  await step(
    'material_apply_graph',
    {
      path: MAT3,
      nodes: [{ id: 'noname', node_type: 'ScalarParameter', value: 0.5 }],
      connections: [],
      compile: false
    },
    { expectFail: true }
  )
  // 上面那条被客户端预检拦在了门外，引擎那道兜底根本没跑到 —— 直发裸 RPC 补上
  await rawStep(
    'material.add_node（裸 RPC）参数节点缺 node_name',
    'material.add_node',
    { material_path: MAT3, node_type: 'ScalarParameter', initial_value: 0.5 },
    { expectFail: true, contains: 'node_name' }
  )
  // 贴图参数走的是另一棵继承树，名字得单独设 —— 给了名字就必须真的落上
  const texParam = await step('material_apply_graph', {
    path: MAT3,
    nodes: [{ id: 'tp', node_type: 'TextureSampleParameter2D', node_name: 'VerifyTexParam' }],
    connections: [],
    compile: false
  })
  await step(
    'material_describe',
    { path: MAT3 },
    {
      hard: true,
      check: (o) => {
        const names = o.details?.texture_params ?? o.details?.parameters?.texture_params ?? []
        const flat = JSON.stringify(names)
        return flat.includes('VerifyTexParam')
          ? ''
          : `贴图参数名没落上（要名字又不用名字）：${flat}`
      },
      skip: !texParam ? '没建出贴图参数节点' : undefined
    }
  )

  // ── 遮罩通道 ────────────────────────────────────────────────────────
  //
  // 不给通道的 ComponentMask 是个恒为 0 的死节点，必须在建之前就挡掉
  await step(
    'material_apply_graph',
    {
      path: MAT3,
      nodes: [{ id: 'deadmask', node_type: 'ComponentMask' }],
      connections: [],
      compile: false
    },
    { expectFail: true }
  )
  // 同上：客户端拦了一道，引擎那道得单独验
  await rawStep(
    'material.add_node（裸 RPC）ComponentMask 缺 value',
    'material.add_node',
    { material_path: MAT3, node_type: 'ComponentMask' },
    { expectFail: true, contains: 'channels' }
  )
  await rawStep(
    'material.add_node（裸 RPC）ComponentMask 通道换序',
    'material.add_node',
    { material_path: MAT3, node_type: 'ComponentMask', initial_value: 'GR' },
    { expectFail: true, contains: 'order' }
  )

  const masked = await step('material_apply_graph', {
    path: MAT3,
    nodes: [
      { id: 'wp', node_type: 'WorldPosition' },
      { id: 'mask', node_type: 'ComponentMask', value: 'R' }
    ],
    connections: [
      { from: 'wp.XY', to: 'mask.Input' },
      { from: 'mask.Out', to: 'Material.Metallic' }
    ],
    compile: true
  })

  // 回读通道 —— 取错通道是静默错误：材质照样编译通过，只是画面不对
  await step(
    'material_get_graph',
    { path: MAT3 },
    {
      hard: true,
      check: (o) => {
        const node = (o.details?.nodes ?? []).find((n) =>
          /ComponentMask/i.test(String(n.class ?? n.node_id))
        )
        if (!node) return '图里没有 ComponentMask 节点'
        return node.value === 'R' ? '' : `遮罩通道回读是 ${JSON.stringify(node.value)}，不是 "R"`
      },
      skip: !masked ? '没建出遮罩节点' : undefined
    }
  )

  /*
   * 改通道用 guid 指节点，不用 node_id。
   *
   * node_id 是按数组下标编的，图变过就不一定还是 `..._2`；写死一个下标
   * 只是「这次恰好对」。guid 跟着对象走，apply_graph 的回执里就有。
   *
   * 通道只能改成 `G`，不能改成 `GB`：这个遮罩的输入是 WorldPosition 的 XY，
   * 是个 float2，取 B 那一路引擎会报 "Not enough components ... for component
   * mask 0110"，材质从此编不过。第一版这里写的就是 `GB`，材质真的编挂了，
   * 而末尾那条 material_compile 照样记成通过 —— 因为脚手架只认
   * `success:false`，认不出 toOutcome 里那句「❌ 编译失败」。
   */
  const maskGuid = masked?.details?.node_guids?.mask

  /*
   * 换序和重复的通道串要被拒。
   *
   * ComponentMask 底下只有四个 bool，压根没有 swizzle 的能力。收下 "GR" 就等于
   * 把「把 x 和 y 换过来」悄悄做成「取 RG」—— 而 set_node_value 的描述还专门
   * 告诉模型「回读拼法变了是正常的」，于是它连回读都不会起疑。
   */
  for (const bad of ['GR', 'RR']) {
    await step(
      'material_set_node_value',
      { path: MAT3, node_id: maskGuid, value: bad },
      { expectFail: true, skip: !maskGuid ? '上一步没回 guid' : undefined }
    )
  }

  // 合法的多通道串要照样收 —— 别为了挡换序把升序也挡了
  await step(
    'material_set_node_value',
    { path: MAT3, node_id: maskGuid, value: 'RG' },
    {
      hard: true,
      check: (o) => (o.details?.new_value === 'RG' ? '' : `"RG" 回读成了 ${o.details?.new_value}`),
      skip: !maskGuid ? '上一步没回 guid' : undefined
    }
  )

  await step(
    'material_set_node_value',
    { path: MAT3, node_id: maskGuid, value: 'G' },
    {
      hard: true,
      check: (o) => (o.details?.new_value === 'G' ? '' : '改通道之后回读对不上'),
      skip: !maskGuid ? '上一步没回 guid' : undefined
    }
  )

  // 末尾这条不是走过场：上面每一步都可能留下一张编不过的图，而编不过的材质
  // 在场景里就是一片默认灰 —— 前面全绿加末尾编译失败，是最典型的假通过
  await step(
    'material_compile',
    { path: MAT3, force_recompile: true },
    {
      hard: true,
      check: (o) => {
        const errors = o.details?.errors ?? []
        return o.details?.compiled !== false && errors.length === 0
          ? ''
          : `编译失败：${errors.join(' / ') || '未说明原因'}`
      }
    }
  )
}

async function actorSuite() {
  console.log('\n=== Actor：摆一组物体，查询、改属性、批量变换、再删掉 ===\n')

  const CUBE = '/Engine/BasicShapes/Cube.Cube'

  // 单个：spawn 的 name 是**请求名**，实际落地的名字要从 path 里读
  const one = await step('ue_spawn_actor', {
    class: '/Script/Engine.StaticMeshActor',
    name: 'UAOne',
    mesh: CUBE,
    location: { x: 0, y: 0, z: 100 }
  })
  if (one) {
    const c = one.parsed?.created?.[0]
    ctx.oneName = c?.name
    ctx.onePath = c?.path
    console.log(
      `       报的 name=${ctx.oneName}  path 末段=${String(ctx.onePath).split('.').pop()}`
    )
  }

  // 批量：一次调用发多个 instances。这里原来调的是 ue_spawn_actor_batch —— 那个
  // 工具从来就不存在（插件侧的 actor.spawn_batch 也已于 2026-09-16 删掉，
  // 它只是把 batch 改名成 instances 再转发）。批量就是同一个工具多给几个 instances
  await step('ue_spawn_actor', {
    instances: [
      {
        class: '/Script/Engine.StaticMeshActor',
        name: 'UABatchA',
        mesh: CUBE,
        location: { x: 300, y: 0, z: 100 }
      },
      {
        class: '/Script/Engine.StaticMeshActor',
        name: 'UABatchB',
        mesh: CUBE,
        location: { x: 600, y: 0, z: 100 }
      }
    ]
  })

  const found = await step('ue_get_actor', {
    targets: { filter: { name_pattern: 'UA*' } },
    return_transform: true
  })
  if (found) {
    const list = found.parsed?.actors ?? found.parsed?.data?.actors ?? []
    ctx.actorNames = list.map((a) => a.name).filter(Boolean)
    console.log(`       查到 ${list.length} 个：${ctx.actorNames.join('、') || '(没有名字字段)'}`)
  }

  await step(
    'ue_inspect_actor',
    { targets: { names: ctx.actorNames?.slice(0, 1) ?? [] } },
    { skip: !ctx.actorNames?.length ? '上一步没查到 Actor' : undefined }
  )

  await step(
    'ue_set_property',
    {
      targets: { names: ctx.actorNames?.slice(0, 1) ?? [] },
      properties: { bHidden: false }
    },
    { skip: !ctx.actorNames?.length ? '没查到 Actor' : undefined }
  )

  await step(
    'ue_set_transform',
    {
      targets: { filter: { name_pattern: 'UA*' } },
      operation: { add: { location: { z: 50 } } }
    },
    { skip: !ctx.actorNames?.length ? '没查到 Actor' : undefined }
  )

  // 变换到底生效了没有 —— 只看返回 success 不够
  const after = await step('ue_get_actor', {
    targets: { filter: { name_pattern: 'UA*' } },
    return_transform: true
  })
  if (after) {
    const list = after.parsed?.actors ?? after.parsed?.data?.actors ?? []
    const zs = list
      .map((a) => a.transform?.location?.z ?? a.location?.z)
      .filter((z) => z !== undefined)
    console.log(`       变换后的 z：${zs.join(', ') || '(返回里没有 transform)'}`)
    ctx.zAfter = zs
  }

  await step(
    'ue_destroy_actor',
    { targets: { names: [ctx.actorNames?.[0]] } },
    { skip: !ctx.actorNames?.length ? '没查到 Actor' : undefined }
  )

  await step('ue_destroy_actor_batch', {
    batch: (ctx.actorNames ?? []).slice(1).map((n) => ({ name: n }))
  })

  // 收尾：确认真的删干净了，没删掉就是 destroy 谎报成功
  const left = await step('ue_get_actor', { targets: { filter: { name_pattern: 'UA*' } } })
  if (left) {
    const list = left.parsed?.actors ?? left.parsed?.data?.actors ?? []
    console.log(
      `       残留 ${list.length} 个${list.length ? '：' + list.map((a) => a.name).join('、') : ''}`
    )
  }
}

function table() {
  const width = Math.max(...results.map((r) => r.name.length)) + 2
  const icon = { pass: '✅', warn: '⚠️ ', fail: '❌', skip: '⏭ ' }
  console.log('\n\n=== 验证结果 ===\n')
  for (const r of results) {
    console.log(
      `${icon[r.verdict]} ${r.name.padEnd(width)}${r.ms ? String(r.ms).padStart(6) + 'ms' : '        '}  ${r.note ?? ''}`
    )
  }
  const count = (v) => results.filter((r) => r.verdict === v).length
  console.log(
    `\n通过 ${count('pass')}  警告 ${count('warn')}  失败 ${count('fail')}  跳过 ${count('skip')}  共 ${results.length}`
  )
}

/**
 * 引擎级：保存、批量编译、关卡文件操作。
 *
 * 这一组的重点不是"调得通"，而是几条**说错了不会报错**的行为：
 *   - 只存 agent 自己改的，用户手改的要原样留着脏
 *   - 存完还剩脏的要如实报数
 *   - 打开/新建关卡在有未保存改动时必须拒绝，而不是闷头把东西丢了
 */
async function engineSuite() {
  console.log('\n=== 引擎级：保存 / 编译 / 关卡 ===\n')

  const current = await step('ue_get_current_level', {})
  if (current) {
    const p = current.parsed ?? current.details ?? {}
    ctx.levelPackage = p.package
    console.log(
      `       当前关卡 ${p.package}，${p.actor_count} 个 Actor，${p.is_dirty ? '脏' : '干净'}` +
        (p.is_temporary ? '（临时关卡，没有文件）' : '')
    )
  }

  // 前面几个 suite 建了一堆蓝图和材质，这里应该能看到它们还没落盘
  const before = await step('ue_list_unsaved', {})
  let touchedBefore = 0
  if (before) {
    const p = before.parsed ?? before.details ?? {}
    touchedBefore = (p.touched ?? []).length
    console.log(
      `       未保存：我们改的 ${touchedBefore} 个，别处改的 ${(p.other ?? []).length} 个`
    )
    if (touchedBefore === 0) {
      console.log('       ⚠ 我们刚建了一堆资产却一个都没记到 —— 包标脏事件多半没挂上')
    }
  }

  await step('ue_save', {})

  /**
   * 存完之后回读：我们改的应该一个不剩，别处改的应该原样还在。
   *
   * 后半句才是这条验证的重点 —— 把用户手改的东西一起存了，
   * 是这个功能最容易犯又最难发现的错。
   */
  const after = await step('ue_list_unsaved', {})
  if (after && before) {
    const pa = after.parsed ?? after.details ?? {}
    const pb = before.parsed ?? before.details ?? {}
    const touchedAfter = (pa.touched ?? []).length
    const otherBefore = (pb.other ?? []).length
    const otherAfter = (pa.other ?? []).length

    console.log(
      touchedAfter === 0
        ? `       ✓ 我们改的已全部落盘（${touchedBefore} → 0）`
        : `       ✖ 还剩 ${touchedAfter} 个没存下去`
    )
    console.log(
      otherAfter === otherBefore
        ? `       ✓ 别处改的没被动（${otherAfter} 个仍然脏着）`
        : `       ✖ 别处改的从 ${otherBefore} 变成 ${otherAfter} —— 越界保存了用户的东西`
    )
  }

  await step('blueprint_compile_all', { scope: 'touched' })

  // 有未保存改动时，打开关卡必须被拒。先制造一点脏东西。
  await step('blueprint_add_variable', {
    blueprint_path: BP,
    name: 'DirtyMarker',
    type: 'bool',
    default_value: 'false'
  })

  const refused = await step(
    'ue_open_level',
    { path: ctx.levelPackage ?? '/Game/Maps/Minimal_Default' },
    { expectFail: true }
  )
  if (refused) {
    const text = JSON.stringify(refused.parsed ?? refused.text ?? '')
    console.log(
      text.includes('ue_save') || text.includes('未保存')
        ? '       ✓ 有未保存改动时拒绝打开关卡，并指向先保存'
        : '       ✖ 没有拒绝 —— 未保存的改动会被直接丢掉'
    )
  }

  // 收拾干净，别把脏标记留给下一次跑
  await step('ue_save', {})
}

/**
 * PIE 试玩。
 *
 * 这一组的核心不是「PIE 起得来」，而是**日志真的被捕获到了** ——
 * 没有 print_strings，这个工具就退化成「跑了 5 秒，不知道发生了什么」。
 *
 * 所以先造一个 BeginPlay 就打印一句暗号的蓝图、摆进关卡，再跑试玩，
 * 最后在报告里找那句暗号。找到了才说明整条链是通的。
 */
async function playtestSuite() {
  console.log('\n=== PIE 试玩：跑起来并捕获蓝图输出 ===\n')

  const PIE_BP = `${FOLDER}/BP_PieProbe.BP_PieProbe`
  // 暗号带一个固定串，便于在一堆引擎日志里精确认出来
  const TOKEN = 'UAL_PIE_PROBE_OK'

  await step('blueprint_create', {
    name: 'BP_PieProbe',
    parent_class: '/Script/Engine.Actor',
    folder: FOLDER
  })

  // BeginPlay -> PrintString(暗号)。整图一次写完。
  await step('blueprint_apply_graph', {
    blueprint_path: PIE_BP,
    graph_name: 'EventGraph',
    nodes: [
      { id: 'begin', class: 'Event', member_name: 'ReceiveBeginPlay' },
      {
        id: 'say',
        class: 'Function',
        member_name: 'KismetSystemLibrary.PrintString',
        pin_defaults: { InString: TOKEN, bPrintToScreen: 'false', bPrintToLog: 'true' }
      }
    ],
    connections: [{ from: 'begin.then', to: 'say.execute' }]
  })

  // 蓝图要存（编译产物落盘），再摆进关卡
  await step('ue_save', {})
  await step('ue_spawn_actor', { class: PIE_BP, name: 'UAPieProbe' })

  /**
   * **不存关卡**，这是这一版特意去掉的一步。
   *
   * 第一次真机跑到这里失败了：验证工程用的是一张从没保存过的临时关卡，
   * 而 `ue_save_level` 不给路径时会正确地拒绝（它不该替用户挑存放位置）。
   *
   * 更要紧的是那次失败顺带证明了一件事 —— **PIE 根本不需要先存关卡**：
   * 那一步失败之后，试玩照样跑起来了，而且捕获到了刚摆进去、还没落盘的
   * 那个 Actor 打印的暗号。PIE 复制的是编辑器**内存里**的世界，不是磁盘上的。
   *
   * 所以这里不存关卡，反而更接近真实用法，也顺带守住了这条结论。
   */

  const report = await step('ue_playtest', { duration_seconds: 4 })
  if (report) {
    const parsed = report.parsed ?? report.details ?? {}
    const prints = parsed.print_strings ?? []
    const hit = prints.some((line) => String(line).includes(TOKEN))

    console.log(
      `       跑了 ${parsed.elapsed_seconds}s，结束原因 ${parsed.ended_by}，` +
        `${prints.length} 条 PrintString，${parsed.error_count ?? 0} 个错误`
    )
    console.log(
      hit
        ? '       ✓ 捕获到蓝图 PrintString —— 日志链路通了'
        : `       ✖ 没捕获到暗号。PIE 跑起来了但日志没收到，这个工具等于瞎跑`
    )
    console.log(
      parsed.images || parsed.screenshot_error
        ? `       截图：${parsed.screenshot_error ? '失败 ' + parsed.screenshot_error : '已带回'}`
        : '       截图：未产出'
    )
  }

  // 已经在 Play 模式时必须拒绝 —— 这条防的是并发试玩把状态搅乱。
  // 上一次试玩已经结束，所以这里改为验「连着跑两次不会串味」。
  const second = await step('ue_playtest', { duration_seconds: 1, screenshot: false })
  if (second) {
    const parsed = second.parsed ?? second.details ?? {}
    console.log(
      parsed.ended_by === 'duration'
        ? '       ✓ 连跑第二次正常，会话状态没有残留'
        : `       ✖ 第二次结束原因是 ${parsed.ended_by}，上一次的状态可能没清干净`
    )
  }
}

const which = process.argv[2] ?? 'all'
/**
 * 探的是**调试 HTTP 服务**，不是盒子本身。
 *
 * 这两件事以前被混为一谈，报的是「盒子没在跑」—— 而最常见的情况恰恰是
 * 盒子跑得好好的、UE 也连着，只是 `HTTP_ENABLED` 没开（它默认关闭，
 * 见 services/index.ts：一组无鉴权的 debug 路由不该在每台机器上无条件监听）。
 * 照着那句话去 rebuild + 重启，重启完还是连不上，而真正要做的只是加个环境变量。
 *
 * 顺带查一下 WebSocket 端口：那个通了就说明盒子确实在跑，能把
 * 「盒子没起」和「调试口没开」当场分开。
 */
const health = await fetch(`${BASE}/api/health`).catch(() => null)
if (!health?.ok) {
  const wsAlive = await fetch('http://127.0.0.1:17860')
    .then(() => true)
    .catch((e) => !/ECONNREFUSED/.test(String(e)))

  console.error(`调试接口 ${BASE} 连不上。`)
  if (wsAlive) {
    console.error('')
    console.error('盒子本身在跑（17860 通着），只是调试 HTTP 服务没开 —— 它默认关闭。')
    console.error('用这条重启盒子，UE 的连接端口不变：')
    console.error('')
    console.error('  pnpm dev:ue-verify')
    console.error('')
    console.error('不要用 pnpm dev:smoke —— 它把 WS_PORT 改成 8765，UE 那边会掉线。')
  } else {
    console.error('盒子也没在跑。先 pnpm rebuild:electron，再 HTTP_ENABLED=true pnpm dev')
  }
  process.exit(1)
}

await cleanup()
if (which === 'blueprint' || which === 'all') await blueprintSuite()
if (which === 'material' || which === 'all') await materialSuite()
// 材质进阶接在基础之后：它复用同一个 FOLDER，但另建一张图，互不干扰
if (which === 'material' || which === 'material-graph' || which === 'all')
  await materialGraphSuite()
// 引脚层：说明书 / 分量输出 / 遮罩通道。另建一张图，和上面两组互不干扰
if (which === 'material' || which === 'material-pins' || which === 'all') await materialPinsSuite()
if (which === 'actor' || which === 'all') await actorSuite()
// 引擎级放最后：它要靠前面几个 suite 制造出未保存的改动才验得出东西
if (which === 'engine' || which === 'all') await engineSuite()
// 试玩放最末：它要靠前面几组把资产建出来并落盘
if (which === 'playtest' || which === 'all') await playtestSuite()
table()
