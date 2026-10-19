/**
 * @vitest-environment node
 *
 * 读图和查节点这两条只读路，产出必须是**模型读得动的正文**。
 *
 * 这是从一次真实的荷塘材质复刻里长出来的两个洞：
 *
 * 1. `material_get_graph` 以前没有 toOutcome，整张图 `JSON.stringify` 成一行。
 *    一个子 agent 要找五张贴图分别挂在哪个 TextureSample 上，在那坨里没找着，
 *    于是**猜了节点编号**（报 _8/_25/_58/_75/_85，实际是 _0/_4/_5/_9/_10）。
 *    贴图路径一直在返回体里 —— 读不出来不等于没给。
 *
 * 2. 引脚名只能靠「先建一个节点再读回来」试。真机上的做法是新建一个 31 节点的
 *    探针材质，把要用的类型各放一个，抄下引脚名再回去写图。
 *
 * 所以这里钉的都是「正文里有没有」——**不是 details 里有没有**。
 * details 不进模型上下文，写进那里等于没写。
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

import { materialTools } from './index'

type Executable = {
  name: string
  execute: (id: string, input: unknown) => Promise<{ content: { text: string }[] }>
}

const byName = (name: string): Executable => {
  const found = (materialTools as unknown as Executable[]).find((t) => t.name === name)
  if (!found) throw new Error(`工具未注册：${name}`)
  return found
}

const run = async (tool: string, input: unknown, response: unknown): Promise<string> => {
  callRequest.mockResolvedValue(response)
  const result = await byName(tool).execute('c1', input)
  return result.content.map((c) => c.text).join('\n')
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('material_get_graph 的正文', () => {
  const graph = {
    material_name: 'M_Water',
    material_path: '/Game/Materials/M_Water',
    node_count: 3,
    nodes: [
      {
        node_id: 'TextureSample_0',
        class: 'MaterialExpressionTextureSample',
        guid: 'AAAA-1111',
        value: '/Game/Textures/T_Lotus',
        inputs: [
          { name: 'Coordinates', is_connected: true, type: 'float2' },
          { name: 'Tex', is_connected: false, type: 'Texture2D' }
        ],
        outputs: [
          { name: 'RGB', type: 'float3' },
          { name: 'R', type: 'float' },
          { name: 'A', type: 'float' }
        ]
      },
      {
        node_id: 'Constant3Vector_1',
        class: 'MaterialExpressionConstant3Vector',
        guid: 'BBBB-2222',
        value: { r: 0.1, g: 0.4, b: 0.2 },
        inputs: [],
        outputs: [{ name: 'RGB' }, { name: 'R' }, { name: 'G' }, { name: 'B' }]
      },
      {
        node_id: 'NamedRerouteUsage_2',
        class: 'MaterialExpressionNamedRerouteUsage',
        reroute_kind: 'usage',
        reroute_name: 'Caustics',
        reroute_declaration_node: 'NamedRerouteDeclaration_9',
        inputs: [],
        outputs: [{ name: 'Out' }]
      }
    ],
    connection_count: 2,
    connections: [
      {
        from_node: 'TextureSample_0',
        from_pin: 'RGB',
        to_node: 'Material',
        // 引擎侧的键名是 to_input，不是和 from_pin 对称的 to_pin。
        // 照对称猜过一次，渲染出来是一串 `Material.undefined`，真机才发现
        to_input: 'BaseColor',
        from_type: 'float3',
        to_type: 'float3'
      },
      {
        from_node: 'Constant3Vector_1',
        from_pin: 'G',
        from_output: 2,
        to_node: 'Material',
        to_input: 'Roughness',
        from_type: 'float3',
        to_type: 'float'
      }
    ],
    material_pins: ['BaseColor', 'Roughness'],
    use_material_attributes: false
  }

  const read = (patch: Record<string, unknown> = {}): Promise<string> =>
    run('material_get_graph', { path: '/Game/Materials/M_Water' }, { ...graph, ...patch })

  it('贴图路径出现在正文里 —— 这是上一轮子 agent 靠猜的那一项', async () => {
    const text = await read()
    expect(text).toContain('/Game/Textures/T_Lotus')
    expect(text).toContain('TextureSample_0')
  })

  it('常量的值也在正文里，不用再单独读一遍', async () => {
    expect(await read()).toContain('"r":0.1')
  })

  it('带上 guid —— 跨过删除/撤销之后只有它指得准', async () => {
    const text = await read()
    expect(text).toContain('AAAA-1111')
    expect(text).toContain('BBBB-2222')
  })

  it('输出引脚名照列，从这个节点接出去时要写它', async () => {
    expect(await read()).toContain('RGB, R, G, B')
  })

  /**
   * 引脚要**带类型**。material_compile 编译失败时的提示（以及本工具自己的描述）
   * 都叫模型「回来看 inputs/outputs 里的 type」—— 只印名字的话那是条死路：
   * 类型只剩在 details 里，而 details 不进模型上下文。
   */
  it('引脚带类型 —— 编译失败时那句提示才有地方落', async () => {
    const text = await read()
    expect(text).toContain('Coordinates float2')
    expect(text).toContain('A float')
  })

  /**
   * 已接线的输入也要列出来。「把这根线改接到别处」是常规操作，需要的正是那个
   * 已经占着的引脚名；全部接满的 MaterialFunctionCall 连 search_nodes 也帮不上
   * （引脚来自函数资产，CDO 上是空的），读图是唯一来源。
   */
  it('输入全列出来，已接线的打星号', async () => {
    const text = await read()
    expect(text).toContain('Coordinates float2*')
    expect(text).toContain('Tex')
  })

  /**
   * 引擎对两种「静默坏掉」的节点恰好回空串：没挂贴图的 TextureSample、
   * 四位全 0 的 ComponentMask。当成「没有值」丢掉，它们就和 Add / Multiply
   * 长得一模一样了。
   */
  it('空串值渲染成 (未设置)，不能当成没有值丢掉', async () => {
    const text = await read({
      nodes: [
        {
          node_id: 'TextureSample_9',
          class: 'MaterialExpressionTextureSample',
          value: '',
          inputs: [],
          outputs: [{ name: 'RGB' }]
        }
      ],
      connections: []
    })
    expect(text).toContain('(未设置)')
  })

  /** 节点注释是手搓材质里唯一的自然语言线索，丢掉它改图的人就会径直改过去 */
  it('节点注释照抄进正文', async () => {
    const text = await read({
      nodes: [
        {
          node_id: 'Constant_3',
          class: 'MaterialExpressionConstant',
          value: 0.5,
          description: '湿度遮罩，别动',
          inputs: [],
          outputs: [{ name: 'Out' }]
        }
      ],
      connections: []
    })
    expect(text).toContain('湿度遮罩，别动')
  })

  it('连线两端的节点和引脚名都写全，目标读的是 to_input', async () => {
    const text = await read()
    expect(text).toContain('Constant3Vector_1.G → Material.Roughness')
    expect(text).toContain('TextureSample_0.RGB → Material.BaseColor')
    expect(text).not.toContain('undefined')
  })

  /**
   * 类型如实并列，不替调用方判「这算不算不匹配」。
   *
   * 这里一度是「两端不一样就打 ⚠️」。真机上第一次跑就证明那样会喊狼来了：
   * Constant3Vector 的 G 输出（1 个通道）引擎回的 from_type 是 float3，
   * 接进 Roughness 会被标成不匹配 —— 而那根线完全正确。
   * 假警报比不报更糟，模型会掉头去查一个不存在的问题。
   */
  it('类型只并列不下判断，不打警告', async () => {
    const text = await read()
    expect(text).toContain('[float3 → float]')
    expect(text).not.toMatch(/⚠️[^\n]*float3 → float/)
  })

  it('命名重定向指出下一跳，追链不用猜', async () => {
    expect(await read()).toContain('NamedRerouteDeclaration_9')
  })

  /**
   * 开着材质属性时，主节点那一排引脚全是摆设：连得上、不报错、编译也过，
   * 画面一点变化都没有。这句话必须顶在前面。
   */
  it('use_material_attributes 开着时把话说死', async () => {
    const text = await read({ use_material_attributes: true })
    expect(text).toContain('use_material_attributes=true')
    expect(text).toContain('没有任何效果')
  })

  it('空图不报错，也不假装有内容', async () => {
    const text = await read({ nodes: [], connections: [], node_count: 0, connection_count: 0 })
    expect(text).toContain('0 个节点')
  })

  /*
   * 大图要封顶，但封顶**不能把 id 封掉**。
   *
   * 这个工具没有 node_id / offset 入参，别的工具也读不了图的一段 ——
   * 所以一旦某个节点的 node_id 没进正文，它就是彻底拿不到了，
   * 而模型下一步要做的每件事（改值、删、连线）都以这个 id 为前提。
   */
  describe('大图封顶', () => {
    const bigGraph = (nodeCount: number, innerCount: number): Record<string, unknown> => ({
      material_name: 'M_Big',
      nodes: Array.from({ length: nodeCount }, (_, i) => ({
        node_id: `Multiply_${i}`,
        class: 'MaterialExpressionMultiply',
        guid: `GUID-${i}`,
        inputs: [{ name: 'A', type: 'float' }],
        outputs: [{ name: '', type: 'float' }]
      })),
      connections: [
        // 引擎是**最后**才补主节点这几根的，所以它们天然排在数组末尾
        ...Array.from({ length: innerCount }, (_, i) => ({
          from_node: `Multiply_${i}`,
          from_pin: '',
          to_node: `Multiply_${i + 1}`,
          to_input: 'A'
        })),
        { from_node: 'Multiply_0', from_pin: '', to_node: 'Material', to_input: 'BaseColor' },
        { from_node: 'Multiply_1', from_pin: '', to_node: 'Material', to_input: 'Roughness' }
      ]
    })

    it('超出详列上限的节点仍然给得出 node_id 和 guid', async () => {
      const text = await read(bigGraph(200, 10))
      // 第 61 个之后只给三件套，但一个都不能少
      expect(text).toContain('Multiply_199')
      expect(text).toContain('GUID-199')
      // 而且不能再叫模型去干一件没有工具能干的事
      expect(text).not.toContain('按 node_id 定点看')
    })

    /*
     * 上限要**量**出来，不能估。
     *
     * 这个封顶前后估错过两次：先估一行 50 字符、后来估 95，实测 203
     * （一条 Megascans 贴图路径单独就有 140）。所以这条用例直接对着字符数断言 ——
     * 行变长、字段变多、额度被调大，都会在这里红，而不是等到某次真机上
     * 甩出六万字符才发现。
     */
    it('最坏情况下整段输出有实际字符上限', async () => {
      const text = await read({
        material_name: 'M_Big',
        nodes: Array.from({ length: 800 }, (_, i) => ({
          node_id: `TextureSampleParameter2D_${i}`,
          class: 'MaterialExpressionTextureSampleParameter2D',
          guid: '3F2A1B4C5D6E7F8091A2B3C4D5E6F708',
          value:
            '/Game/Megascans/Surfaces/Rock_Cliff_vlkhcbxia/T_vlkhcbxia_4K_Albedo.T_vlkhcbxia_4K_Albedo',
          // 注释一定要进夹具：它是引擎照抄设计师自由文本的字段（Expression->Desc），
          // 长度不受控，也正是这一版新加截断的那个。夹具里不放，
          // 「最坏情况」这条用例就看不见自己该看的东西 —— 上一版就是这么漏的
          description:
            '湿度遮罩，别动。这一段是设计师随手写的说明，通常会写为什么要这么接。'.repeat(4),
          inputs: [{ name: 'Coordinates', type: 'float2', is_connected: true }],
          outputs: [
            { name: 'RGB', type: 'float3' },
            { name: 'A', type: 'float' }
          ]
        })),
        // 连线也要进夹具。这一段和前两段一样按字符封顶，不放进来的话
        // 「最坏情况」又看不见自己该看的东西 —— 前三轮就是这么连着漏的：
        // 封了简表漏详列、封了详列漏注释、封了注释漏连线
        connections: Array.from({ length: 600 }, (_, i) => ({
          from_node: `TextureSampleParameter2D_${i}`,
          from_pin: 'RGB',
          to_node: `TextureSampleParameter2D_${i + 1}`,
          to_input: 'Coordinates',
          from_type: 'float3',
          to_type: 'float2'
        }))
      })
      /*
       * 上限 = 三个额度之和 + 一点点散文余量。实测 32,624。
       *
       * 详列 14,000 + 简表 12,000 + 连线 6,000 = 32,000，剩下六百多是标题、
       * 页脚和「还有 N 个没列」那几句一次性的话。所以定 34,000：
       * 任何一个额度往上调超过一千多，这里立刻红。
       *
       * 这么定而不是「贴着实测再留一成」，是因为实测值本身几乎全由额度决定 ——
       * 贴着输出定，等于把旋钮的容差放大好几倍（上一版定 30,000，
       * 详列额度从 14,000 偷偷调到 17,000 都不会红）。
       * 改了任何一个额度就回来改这个数，顺手把上面这笔账重算一遍。
       */
      expect(text.length).toBeLessThan(34_000)
      // 别封过头：简表该列的还是要列出来
      expect(text).toContain('TextureSampleParameter2D_60')
      expect(text).toContain('连简表都没列')
    })

    /*
     * 列出来的简表必须是**一段连续的前缀**。
     *
     * 额度用完时 break 而不是 continue：continue 会跳过长行、留下短行，
     * 于是列出来的是断续的，而且被跳掉的恰恰是带长贴图路径的那些节点 ——
     * 简表加上 value 就是为了留住它们。更糟的是下面那句「还有 N 个没列」
     * 说的是一条尾巴，断续的话这句话就是假的：读到 Node_81、Node_83
     * 的人会以为 Node_82 不存在。
     *
     * 夹具特意让行长交替，否则 break 和 continue 的行为一模一样，测不出来。
     */
    it('简表列出来的是连续的一段，不是挑着列', async () => {
      // 长短差距要拉够大：差一点点的话，跳过一条长行之后剩下的额度连短行也放不下，
      // continue 就退化成 break，这条用例也就区分不出两者了（第一版夹具就是这么失效的）
      const long = `/Game/Megascans/${'VeryLongSurfaceName'.repeat(100)}.Albedo`
      const text = await read({
        material_name: 'M_Mixed',
        nodes: Array.from({ length: 400 }, (_, i) => ({
          node_id: `N_${i}`,
          class: 'MaterialExpressionTextureSample',
          guid: '3F2A1B4C5D6E7F8091A2B3C4D5E6F708',
          // 偶数节点的值很长、奇数很短 —— continue 会只留下奇数那些
          value: i % 2 === 0 ? long : 'x',
          inputs: [],
          outputs: [{ name: 'RGB', type: 'float3' }]
        })),
        connections: []
      })

      /*
       * 要**按简表标题切开**再判，不能把两段混在一个数组里看。
       *
       * 混着判的话，把 BRIEF_CHAR_BUDGET 调成 0（简表一条都不列）照样是绿的：
       * 剩下的详列前缀 N_0..N_13 自己就连续，也满足 length > 10 —— 这条用例
       * 名字里承诺的那件事其实一次都没验到。
       *
       * 正则同时匹配详列行和简表行是**故意的**，union 那一条断言靠的就是这点：
       * 简表要是从 nodes.slice(MAX_GRAPH_NODES) 起头而不是接着详列，
       * 两段 id 之间会裂一个口子，只有并起来看才看得见。
       */
      const idsIn = (s: string): number[] =>
        [...s.matchAll(/^ {2}(N_\d+) ｜/gm)].map((m) => Number(m[1].slice(2)))

      const headerAt = text.indexOf('个节点只给 node_id')
      expect(headerAt).toBeGreaterThan(-1)
      const detail = idsIn(text.slice(0, headerAt))
      const brief = idsIn(text.slice(headerAt))

      // 简表必须真的列了东西，否则下面两条断言都是空转
      expect(brief.length).toBeGreaterThan(10)
      // 接着详列往下走，不是另起炉灶从 MAX_GRAPH_NODES 开始
      expect(brief[0]).toBe(detail[detail.length - 1] + 1)
      // 简表自己连续：挑着列的话这个等式立刻不成立
      expect(brief[brief.length - 1] - brief[0]).toBe(brief.length - 1)
      // 两段并起来也连续 —— 中间不许漏
      const all = [...detail, ...brief]
      expect(all[all.length - 1] - all[0]).toBe(all.length - 1)
    })

    /*
     * 详列的条数上限也要钉住。
     *
     * 字符额度只在行很长时才先到；Multiply / Add 这种链路一行才 ~85 字符，
     * 额度根本碰不到，**MAX_GRAPH_NODES 是唯一起作用的那道闸** ——
     * 也就是说它决定了普通图上模型能看到几个节点的引脚和类型。
     * 之前 60 改 90、改 10 都不会红，等于这道闸没人守。
     */
    it('短行图上详列条数由 MAX_GRAPH_NODES 决定', async () => {
      const text = await read({
        material_name: 'M_Chain',
        nodes: Array.from({ length: 200 }, (_, i) => ({
          node_id: `N_${i}`,
          class: 'MaterialExpressionMultiply',
          inputs: [{ name: 'A', type: 'float' }],
          outputs: [{ name: '', type: 'float' }]
        })),
        connections: []
      })
      // 和上面那条一样先确认标题找得到。少了这句的话，标题一改写
      // indexOf 回 -1、slice(0,-1) 几乎原样返回，这条用例会以
      //「详列有 200 条」的面目失败 —— 罪名安在 MAX_GRAPH_NODES 头上，而它是无辜的
      const headerAt = text.indexOf('个节点只给 node_id')
      expect(headerAt).toBeGreaterThan(-1)
      const detail = [...text.slice(0, headerAt).matchAll(/^ {2}(N_\d+) ｜/gm)]
      expect(detail).toHaveLength(60)
    })

    // 判长度和切用的单位必须一致。emoji 是 2 个码元 1 个码点，
    // 125 个 emoji = 250 码元 / 125 码点 —— 判 .length 会走进截断分支，
    // 而按码点切一个字都不会少，于是给一段完整的注释挂上「（截断）」
    it('码点数没超就不该挂截断标记', async () => {
      const text = await read({
        nodes: [
          {
            node_id: 'Constant_0',
            class: 'MaterialExpressionConstant',
            value: 0.5,
            description: '😀'.repeat(125),
            inputs: [],
            outputs: [{ name: 'Out' }]
          }
        ],
        connections: []
      })
      expect(text).not.toContain('（截断）')
      // 光断言「没有截断标记」的话，把整行注释删掉这条用例照样绿 ——
      // 它名字里说的是「一个字都没少」，那就把这件事直接断言出来
      expect(text).toContain('😀'.repeat(125))
    })

    // 注释是设计师随手写的自由文本，长度不受控 —— 详列那半边本来就是更大的一半，
    // 不截的话它照样可以无限长
    it('超长节点注释要截断', async () => {
      const text = await read({
        nodes: [
          {
            node_id: 'Constant_0',
            class: 'MaterialExpressionConstant',
            value: 0.5,
            // 长度要卡在阈值和「放宽后的阈值」之间：4000 字的话，阈值从 200
            // 放宽到 2000 照样触发截断，输出一模一样，这条用例就区分不出来。
            // 500 字只在阈值是 200 时才截 —— 阈值被调松立刻红
            description: '啰嗦'.repeat(250),
            inputs: [],
            outputs: [{ name: 'Out' }]
          }
        ],
        connections: []
      })
      expect(text).toContain('（截断）')
      /*
       * 还要钉**截到多长**。
       *
       * 上面那句只管「截没截」，挡得住阈值被放宽（夹具 500 字，阈值一放到 2000
       * 就不截了，那句立刻红），但挡不住 200 悄悄变成 210 —— 照样截，只是多放了 10 个字。
       * 所以把长度算死：`      ※ 节点注释：`（13）+ 200 + `…（截断）`（5）= 218。
       * 用 toBe 不用 toBeLessThan：留 12 个字的余量等于默许阈值在 200~211 之间乱飘，
       * 而这一批改动的论点正是「上限要贴着旋钮的容差定」。
       */
      const note = text.split('\n').find((l) => l.includes('※ 节点注释：'))
      expect(note).toBeDefined()
      expect([...(note as string)].length).toBe(218)
    })

    it('连主节点的那几根线不会被连线上限挤掉', async () => {
      // 200 根节点间连线远超 80 的上限；主节点那两根在数组最末尾
      const text = await read(bigGraph(10, 200))
      expect(text).toContain('Material.BaseColor')
      expect(text).toContain('Material.Roughness')
      expect(text).toContain('没列')
    })
  })
})

describe('material_search_nodes 的正文', () => {
  const response = {
    ok: true,
    query: 'lerp',
    match_count: 1,
    total_types: 55,
    truncated: false,
    nodes: [
      {
        node_type: 'Lerp',
        class: 'MaterialExpressionLinearInterpolate',
        inputs: [
          { name: 'A', type: 'float(any)' },
          { name: 'B', type: 'float(any)' },
          { name: 'Alpha', type: 'float' }
        ],
        outputs: [{ name: 'Out', index: 0, type: 'float(any)' }],
        has_value: false
      }
    ]
  }

  const search = (patch: Record<string, unknown> = {}): Promise<string> =>
    run('material_search_nodes', { query: 'lerp' }, { ...response, ...patch })

  /**
   * 引脚名必须全部落在正文里 —— 这正是调用它的理由。
   * 「完整列表在 details 里」对模型是死路。
   */
  it('每个引脚的名字和类型都在正文里', async () => {
    const text = await search()
    expect(text).toContain('Alpha')
    expect(text).toContain('float(any)')
    expect(text).toContain('Lerp')
  })

  it('「不给就废」的字段单独警告，别等撞墙才知道', async () => {
    const text = await search({
      nodes: [
        {
          node_type: 'ComponentMask',
          class: 'MaterialExpressionComponentMask',
          inputs: [{ name: 'Input' }],
          outputs: [{ name: 'Out' }],
          requires: ['value'],
          has_value: true,
          note: 'value is the channels to keep: "R", "RG", "RGB", "A"'
        }
      ]
    })
    expect(text).toContain('建它必须带：value')
    expect(text).toContain('channels to keep')
  })

  it('一条都没匹配上时给出下一步，不是干说没找到', async () => {
    const text = await search({ match_count: 0, nodes: [] })
    expect(text).toContain('换个更短的关键字')
  })

  it('被 limit 截断时说清楚还有更多', async () => {
    const text = await search({ match_count: 30, truncated: true })
    expect(text).toContain('加大 limit')
  })
})
