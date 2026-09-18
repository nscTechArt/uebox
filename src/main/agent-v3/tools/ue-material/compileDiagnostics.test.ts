/**
 * @vitest-environment node
 *
 * material_compile 的报错要指到**节点**，不能只给一句引脚摘要。
 *
 * 这是从一次真实排查里长出来的：一个 176 个节点的植被母材质编译不过，
 * 引擎给的错误是「BaseColor 上的某处类型不对」。只有引脚名的话，
 * 接下来就只能在上百条连线里挨个猜着试 —— 那一轮实际花掉了十几次往返。
 *
 * 引擎其实一直知道是哪个节点（材质编辑器就是靠这份列表把节点标红的），
 * 只是插件没往外传。这里测的是「传出来之后，模型确实看得见」。
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

const compile = async (response: unknown): Promise<string> => {
  callRequest.mockResolvedValue(response)
  const result = await byName('material_compile').execute('c1', { path: '/Game/M_Foliage' })
  return result.content.map((c) => c.text).join('\n')
}

const deleteNode = async (response: unknown): Promise<string> => {
  callRequest.mockResolvedValue(response)
  const result = await byName('material_delete_node').execute('c1', {
    path: '/Game/M_Foliage',
    node_id: 'MaterialExpressionComponentMask_2'
  })
  return result.content.map((c) => c.text).join('\n')
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('material_compile 的错误节点', () => {
  it('把出错的 node_id 和类型摆到模型面前', async () => {
    const text = await compile({
      material_name: 'M_Foliage',
      compiled: false,
      errors: ['[SM6] (Node MakeMaterialAttributes) Coercion failed: BaseColor'],
      error_nodes: [
        {
          node_id: 'MaterialExpressionMakeMaterialAttributes_12',
          class: 'MaterialExpressionMakeMaterialAttributes',
          error: '[SM6] Coercion failed: BaseColor'
        }
      ]
    })

    expect(text).toContain('❌ M_Foliage 编译失败')
    expect(text).toContain('MaterialExpressionMakeMaterialAttributes_12')
    expect(text).toContain('[SM6] Coercion failed: BaseColor')
  })

  /**
   * 光给 id 还不够 —— 下一步该干什么必须写出来。
   * 没有这句，模型的默认动作是回去读那张 176 节点的图然后接着猜。
   */
  it('顺带说清下一步是去看引脚类型，而不是猜引脚名', async () => {
    const text = await compile({
      material_name: 'M_Foliage',
      compiled: false,
      errors: ['boom'],
      error_nodes: [{ node_id: 'Add_3', class: 'MaterialExpressionAdd' }]
    })

    expect(text).toContain('material_get_graph')
    expect(text).toContain('type')
  })

  /**
   * 报错落在材质函数内部时，node_id 在这张图里根本不存在。
   * 不说明的话，调用方会拿着一个查无此人的 id 去 get_graph 里找。
   */
  it('材质函数内部的节点会带上「不在本图里」的说明', async () => {
    const text = await compile({
      material_name: 'M_Foliage',
      compiled: false,
      errors: ['boom'],
      error_nodes: [
        {
          node_id: 'MaterialExpressionMultiply_0',
          class: 'MaterialExpressionMultiply',
          note: 'not in this material graph (likely inside a MaterialFunction)'
        }
      ]
    })

    expect(text).toContain('likely inside a MaterialFunction')
  })

  it('编译通过时不提节点，也不该出现失败字样', async () => {
    const text = await compile({ material_name: 'M_Wood', compiled: true, errors: [] })

    expect(text).toContain('✅ M_Wood 编译通过')
    expect(text).not.toContain('出错的节点')
  })

  /**
   * 插件端还没更新时 error_nodes 整个字段都不会有。
   * 老行为必须原样保留 —— 少一个字段不能让摘要变成空的或者报错。
   */
  it('插件没给 error_nodes 时，退回到只列错误文本', async () => {
    const text = await compile({
      material_name: 'M_Old',
      compiled: false,
      errors: ['Error on property BaseColor']
    })

    expect(text).toContain('1 个错误')
    expect(text).toContain('Error on property BaseColor')
    expect(text).not.toContain('出错的节点')
  })
})

/**
 * 删节点顺带断线，这件事必须说出来。
 *
 * 真机回归测里踩到的：删掉一个接在 Metallic 上的节点，引擎侧没断线，
 * 图里留下一根指向已删节点的悬空连线，材质从此编不过 ——
 * 而编译报错指向的 node_id 在 get_graph 里根本找不到，排查会一路跑偏。
 * 引擎侧改成一律先断线，工具这边把断了几根报出来。
 */
describe('material_delete_node 的断线数', () => {
  it('断了线就说清楚断了几根，并提醒去编译', async () => {
    const text = await deleteNode({
      node_id: 'MaterialExpressionComponentMask_2',
      disconnected_count: 2
    })

    expect(text).toContain('MaterialExpressionComponentMask_2')
    // 数字要能被断言到 —— 只写「顺带断开了 2 根」这种散文，
    // 回归测试里就只能靠读中文猜，字段名和数值一起给出来
    expect(text).toContain('disconnected_count = 2')
    expect(text).toContain('material_compile')
  })

  it('本来就没线连到它时，明说没有，不要留下「断了 0 根」这种半句话', async () => {
    const text = await deleteNode({
      node_id: 'MaterialExpressionComponentMask_2',
      disconnected_count: 0
    })

    expect(text).toContain('没有线连到它')
  })

  /** 这个参数插件从来没读过，留着只会让人以为可以选择不断线 */
  it('不再接受 disconnect_first —— 断线不是可选项', () => {
    const schema = (byName('material_delete_node') as unknown as { inputSchema?: unknown })
      .inputSchema
    expect(JSON.stringify(schema ?? {})).not.toContain('disconnect_first')
  })
})

/**
 * 节点 id 有两套编号，长得一模一样，这是从 UE 源码里确认的：
 *
 * - node_id：ClassName_数组下标，get_graph / add_node 返回的就是它
 * - 对象名：UE 给对象起的名字，也长成 ClassName_数字。那个数字来自
 *   MakeUniqueObjectName 里 UpdateSuffixForNextNewObject 的**单调自增计数**
 *   （UObjectGlobals.cpp），和数组下标没有任何关系，删了节点也不回退
 *
 * 图没动过时两者常常重合，一旦经历删除/撤销/重加就错位 —— 真机测试里表现为
 * 「连线报成功，回读却显示接在另一个节点上」，而且时对时错。
 *
 * 引擎自己用的是 UMaterialExpression::MaterialExpressionGuid：
 * PostInitProperties 和 PostLoad 里生成、是 UPROPERTY、跟着资产存盘
 * （MaterialExpressions.cpp）。所以建节点的那个工具要把它给出来，
 * 并且说清什么时候必须用它 —— 不说的话没人会用。
 *
 * 逐节点的 material_add_node 下线之后，material_apply_graph 是**唯一**建节点的
 * 路径，这份稳定 id 也就只剩它能报。漏了的话，下一次改图只能先花一次
 * material_get_graph 把 guid 捞回来。
 */
describe('material_apply_graph 的稳定 id', () => {
  /** 只建一个节点、不连线不排版不编译 —— 这样整次调用只发出一条 add_node */
  const addOneNode = async (response: unknown): Promise<string> => {
    callRequest.mockResolvedValue(response)
    const result = await byName('material_apply_graph').execute('c1', {
      path: '/Game/M_Foliage',
      nodes: [{ id: 'base', node_type: 'Constant3Vector' }],
      connections: [],
      tidy: false,
      compile: false
    })
    return result.content.map((c) => c.text).join('\n')
  }

  it('把 guid 报出来，并说清什么时候得用它', async () => {
    const text = await addOneNode({
      node_id: 'MaterialExpressionConstant3Vector_2',
      guid: '8A1F0C4E5B7D4A9E8C3F1D2B6E4A7C90',
      class: 'MaterialExpressionConstant3Vector'
    })

    expect(text).toContain('8A1F0C4E5B7D4A9E8C3F1D2B6E4A7C90')
    expect(text).toContain('撤销')
  })

  /** 旧插件不返回 guid，不能因此少说话或者报错 */
  it('插件没给 guid 时，原来的输出照常', async () => {
    const text = await addOneNode({
      node_id: 'MaterialExpressionConstant3Vector_2',
      class: 'MaterialExpressionConstant3Vector'
    })

    expect(text).toContain('新建 1 个节点')
    expect(text).not.toContain('稳定 id')
  })
})
