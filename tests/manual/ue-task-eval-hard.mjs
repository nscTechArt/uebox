/**
 * 更难的一档用例。
 *
 * 基础那 7 个是「一句话对应一两个工具」。真实工作里难的是这些：
 *   - 图上连线要先拿到**真实的 node_id**，摆上节点不等于连上
 *   - 批量操作要自己算坐标，不是照抄参数
 *   - 半路发现前提不成立时要换路子，而不是硬着头皮往下走
 *   - 开放式问题要真去查，不能凭常识写一篇通用建议
 *
 * 判定一律回引擎查真实状态。模型说「已完成」和图里真的连上是两码事 ——
 * 这一档尤其如此：编译能通过的图，完全可能一根线都没连。
 *
 * 工厂函数收下主文件的助手，避免把 fetch 那套重复一遍。
 */
export function buildHardCases({ ue, tool, assetExists, deleteAsset }) {
  return [
    {
      id: 'E1-蓝图变量与逻辑',
      level: '图结构 · 多步',
      scope: ['ue.blueprint'],
      // 这里原来写的是 blueprint_compile。整图写入工具默认自己编译，模型
      // 多半不会再单独调一次编译 —— 继续按那个名字算命中率，会把一次
      // 完全正确的执行记成「漏调必需工具」。要考的是它有没有一次写完整张图。
      expectTools: ['blueprint_apply_graph'],
      prompt:
        '建一个 Actor 蓝图 /Game/EvalTmp/BP_HardDoor，加一个 float 变量 OpenAngle 默认值 90，' +
        '再在事件图里让它开始运行时用 Print String 打印一句 "door ready"，最后编译确认通过。',
      check: async () => {
        const path = '/Game/EvalTmp/BP_HardDoor'
        const desc = await ue('blueprint.describe', { blueprint_path: path })
        if (!desc?.ok) return { ok: false, detail: '蓝图没建出来' }

        const vars = desc.variables ?? []
        const hasVar = vars.some((v) => String(v.name ?? '').toLowerCase() === 'openangle')

        const graph = await ue('blueprint.get_graph', {
          blueprint_path: path,
          graph_name: 'EventGraph'
        })
        const nodes = graph?.nodes ?? []

        // 认节点不能靠 title —— 引擎按编辑器语言本地化，中文环境下
        // Print String 显示成「打印字符串」，用 /print/i 一个都匹配不到。
        // 引脚名是不翻译的，所以按「CallFunction 且有 InString 引脚」来认。
        const hasPrint = nodes.some(
          (n) =>
            /CallFunction/i.test(String(n.class ?? '')) &&
            (n.pins ?? []).some((pin) => pin.name === 'InString')
        )

        // 连线才是真门槛：节点摆上去但没连，编译照样通过，运行时什么也不会发生。
        // 字段是 linked_to / is_connected，不是 links / connections。
        const wired = nodes.some((n) =>
          (n.pins ?? []).some((pin) => pin.is_connected || (pin.linked_to ?? []).length > 0)
        )

        // 失败的 blueprint_create_graph 会把已经建出来的节点留在图里，
        // 模型接着又补了一个 —— 于是出现两个 BeginPlay。编译不报错，
        // 但运行时两条链都会跑。这属于做坏了，要判失败。
        const beginPlays = nodes.filter(
          (n) =>
            /K2Node_Event/i.test(String(n.class ?? '')) &&
            (n.pins ?? []).some((pin) => pin.name === 'then') &&
            (n.pins ?? []).length === 2
        )
        const compiled = /up.?to.?date|success/i.test(String(desc.compile_status ?? ''))

        const missing = [
          !hasVar && '变量 OpenAngle',
          !hasPrint && 'Print String 节点',
          !wired && '节点之间的连线',
          !compiled && `编译状态（${desc.compile_status}）`,
          beginPlays.length > 1 && `${beginPlays.length} 个 BeginPlay 事件节点（应该只有 1 个）`
        ].filter(Boolean)

        return {
          ok: missing.length === 0,
          detail: missing.length
            ? `缺：${missing.join('、')}（图里 ${nodes.length} 个节点，变量 ${vars.length} 个）`
            : `变量、Print 节点、连线、编译四项齐全（${nodes.length} 个节点）`
        }
      },
      cleanup: async () => deleteAsset('/Game/EvalTmp/BP_HardDoor.BP_HardDoor')
    },

    {
      id: 'E2-材质节点间连线',
      level: '图结构 · 节点到节点',
      scope: ['ue.material'],
      expectTools: ['material_apply_graph'],
      prompt:
        '做一个会呼吸式闪烁的自发光材质 /Game/EvalTmp/M_HardBlink：' +
        '用 Time 节点接 Sine，再把结果接到自发光颜色上，然后编译。',
      check: async () => {
        const path = '/Game/EvalTmp/M_HardBlink.M_HardBlink'
        if (!(await assetExists(path))) return { ok: false, detail: '材质没建出来' }
        const graph = await ue('material.get_graph', { path })
        const nodes = graph?.nodes ?? []
        const kinds = nodes.map((n) => String(n.type ?? n.class ?? ''))
        const hasTime = kinds.some((k) => /Time/i.test(k))
        const hasSine = kinds.some((k) => /Sine/i.test(k))
        // 真正的考点：节点**之间**要连上，不只是各自连到材质输出。
        // 字段是 inputs[].is_connected，另有顶层 connections 数组
        // （from_node / to_node / to_input）—— 两个都是这一轮才补上的，
        // 之前 get_graph 只回节点，连接信息一概没有，调用方没法验证自己的成果。
        const nodeToNode = nodes.some((n) =>
          (n.inputs ?? []).some((pin) => pin.is_connected === true)
        )
        const conns = graph?.connections ?? []
        const intoMaterial = conns.some((c) => c.to_node === 'Material')
        const missing = [
          !hasTime && 'Time 节点',
          !hasSine && 'Sine 节点',
          !nodeToNode && '节点之间的连线',
          !intoMaterial && '接到材质输出'
        ].filter(Boolean)
        return {
          ok: missing.length === 0,
          detail: missing.length
            ? `缺：${missing.join('、')}（现有节点：${kinds.join(', ') || '无'}，连接 ${conns.length} 条）`
            : `Time → Sine → 自发光 连通（${nodes.length} 个节点，${conns.length} 条连接）`
        }
      },
      cleanup: async () => deleteAsset('/Game/EvalTmp/M_HardBlink.M_HardBlink')
    },

    {
      id: 'E3-批量摆放要算数',
      level: '批量 · 需要计算',
      // 摆灯是 ue.actor，归文件夹是 ue.level
      scope: ['ue.actor', 'ue.level'],
      expectTools: ['ue_spawn_actor'],
      prompt:
        '在场景原点周围摆 8 个点光源，围成一个半径 500 的正圆，均匀分布，' +
        '名字统一叫 EvalRing_0 到 EvalRing_7，最后把它们都归到 World Outliner 的 EvalRing 文件夹里。',
      check: async () => {
        // name_pattern 属于 targets.filter，不是 targets 本身。放错层的话
        // 旧版会当成「没有筛选条件」返回整个关卡（实测 144 个），
        // 判定就变成拿全场 Actor 去数 —— 我第一版就是这么写错的。
        // 现在 schema 是 strict 的，写错会直接报错而不是给个假答案。
        const got = await tool('ue_get_actor', {
          targets: { filter: { name_pattern: 'EvalRing_*' } },
          return_transform: true,
          limit: 20
        })
        const actors = got?.actors ?? []
        if (actors.length !== 8) {
          return { ok: false, detail: `应该有 8 个，实际 ${actors.length} 个` }
        }
        // 逐个验半径 —— 摆出来了但位置不对，等于没做
        const radii = actors.map((a) => {
          const l = a.transform?.location ?? {}
          return Math.round(Math.hypot(Number(l.x ?? 0), Number(l.y ?? 0)))
        })
        const offBy = radii.filter((r) => Math.abs(r - 500) > 25)
        const foldered = actors.filter((a) => /EvalRing/i.test(String(a.folder_path ?? ''))).length
        const problems = [
          offBy.length && `${offBy.length} 个半径不对（实测 ${radii.join(', ')}）`,
          foldered !== 8 && `只有 ${foldered} 个进了 EvalRing 文件夹`
        ].filter(Boolean)
        return {
          ok: problems.length === 0,
          detail: problems.length ? problems.join('；') : '8 个灯半径 500 均匀分布，且都已归类'
        }
      },
      cleanup: async () => {
        for (let i = 0; i < 8; i++) {
          await tool('ue_destroy_actor', { name: `EvalRing_${i}` }).catch(() => undefined)
        }
      }
    },

    {
      id: 'E4-跨域组合并自查',
      level: '跨域 · 要看结果',
      // 这题本来就是跨域的：摆物体 + 做材质 + 截图自查
      scope: ['ue.actor', 'ue.material', 'ue.editor'],
      expectTools: ['material_apply', 'ue_screenshot'],
      prompt:
        '在场景里放一个立方体，做一个纯蓝色的材质给它贴上，然后截图确认颜色对不对。' +
        '材质放 /Game/EvalTmp/M_HardBlue。',
      check: async (run) => {
        const matOk = await assetExists('/Game/EvalTmp/M_HardBlue.M_HardBlue')
        const applied = run.toolCalls.some((c) => c.name === 'material_apply' && !c.isError)
        const looked = run.toolCalls.some((c) => c.name === 'ue_screenshot' && !c.isError)
        const missing = [
          !matOk && '材质没建出来',
          !applied && '没成功应用到 Actor 上',
          !looked && '没截图自查'
        ].filter(Boolean)
        return {
          ok: missing.length === 0,
          detail: missing.length ? missing.join('、') : '建材质 → 应用 → 截图自查，一条链走完'
        }
      },
      cleanup: async () => deleteAsset('/Game/EvalTmp/M_HardBlue.M_HardBlue')
    },

    {
      id: 'E5-半路失败要换路子',
      level: '恢复能力',
      // 先查再建再改，都在材质域内；ue.content 是允许它先搜一下资产在不在
      scope: ['ue.material', 'ue.content'],
      expectTools: ['material_create'],
      prompt:
        '把 /Game/EvalTmp/M_NotThere 这个材质的粗糙度调成 0.2。' +
        '如果它不存在，就用同样的路径新建一个再调。',
      check: async () => {
        const path = '/Game/EvalTmp/M_NotThere.M_NotThere'
        if (!(await assetExists(path))) {
          return { ok: false, detail: '既没找到也没新建 —— 指令里明确说了不存在就建' }
        }
        const graph = await ue('material.get_graph', { path })
        const nodes = graph?.nodes ?? []
        const hasScalar = nodes.some((n) =>
          /Constant$|ScalarParameter|Constant1/i.test(String(n.type ?? n.class ?? ''))
        )
        return {
          ok: hasScalar,
          detail: hasScalar
            ? `发现不存在后新建并接上了粗糙度（${nodes.length} 个节点）`
            : `材质建出来了但没接粗糙度节点（${nodes.length} 个节点）`
        }
      },
      cleanup: async () => deleteAsset('/Game/EvalTmp/M_NotThere.M_NotThere')
    },

    {
      id: 'E6-开放式审计',
      level: '开放式 · 不能瞎编',
      // 审计天然要到处看，三个性能工具分属三个命名空间 ——
      // 这题恰恰是检验「合并那七条之后模型还分不分得清」的用例
      scope: ['ue.content', 'ue.level', 'ue.system', 'ue.editor'],
      prompt: '帮我看看这个工程有没有什么性能上的隐患，给我一份具体的报告。',
      check: async (run) => {
        const said = run.text || ''
        const names = run.toolCalls.map((c) => c.name)
        // 必须真去查，而不是凭常识写一篇「虚幻优化通用建议」
        const investigated = names.some((n) =>
          [
            'level_query_assets',
            'ue_content_audit_optimization',
            'ue_get_performance_stats'
          ].includes(n)
        )
        // 引用真实资产名 = 报告来自这个工程，不是模板
        const citesReal = /SM_|BP_|M_|\/Game\/|\/Engine\//.test(said)
        // 编造数字是最坏的情况：报了帧率却从没测过
        const fakedFps = /\d+\s*(FPS|帧)/i.test(said) && !names.includes('ue_get_performance_stats')
        const problems = [
          !investigated && '没有调用任何审计/统计工具就下结论',
          !citesReal && '报告里没有任何这个工程的真实资产',
          fakedFps && '报出了帧率数字却从没测过'
        ].filter(Boolean)
        return {
          ok: problems.length === 0,
          detail: problems.length
            ? problems.join('；')
            : `基于 ${names.length} 次实际查询给出报告，引用了真实资产`
        }
      }
    }
  ]
}
