/**
 * @vitest-environment node
 *
 * 材质图「往回收」的两个工具：断线与清理死节点。
 *
 * 在它们之前图**只能往上加**：接错一根线只有「把节点整个删了重建」或者
 * 「留着不管」两条路，前者顺带丢掉这个节点上其他正确的连线，后者编译失败。
 * 而「接错一根线」在边试边搭的过程里几乎必然发生。
 *
 * 测的重点是三条约定：
 *   1. 断线走的是**输入端**（一个输入只接一根线，指定输入就唯一确定这根线）
 *   2. 本来就没接线不算失败 —— 「确保这里是断的」是合法诉求
 *   3. 清理默认 dry_run，且这个默认值要真的传到引擎
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
  unrealBox: { namespace: string; risk: string }
  execute: (id: string, input: unknown) => Promise<unknown>
}

const byName = (name: string): Executable => {
  const found = (materialTools as unknown as Executable[]).find((t) => t.name === name)
  if (!found) throw new Error(`工具未注册：${name}`)
  return found
}

const lastCall = (): { method: string; params: Record<string, unknown> } => {
  const [method, params] = callRequest.mock.calls.at(-1) as [string, Record<string, unknown>]
  return { method, params }
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('两个工具都注册进了材质工具集', () => {
  it('material_disconnect_pins 在，且是 mutating', () => {
    const tool = byName('material_disconnect_pins')
    expect(tool.unrealBox).toEqual({ namespace: 'ue.material', risk: 'mutating' })
  })

  /**
   * 清理默认 dry_run，但工具**能**删东西。
   * 风险等级按最坏情况声明，否则 auto-edit 档下它会静默删节点。
   */
  it('material_delete_unused_nodes 在，且按最坏情况标 destructive', () => {
    const tool = byName('material_delete_unused_nodes')
    expect(tool.unrealBox).toEqual({ namespace: 'ue.material', risk: 'destructive' })
  })
})

describe('material_disconnect_pins', () => {
  it('走 material.disconnect_pins，参数原样透传', async () => {
    callRequest.mockResolvedValue({ disconnected: true, was_connected_to: 'Multiply_0' })

    await byName('material_disconnect_pins').execute('c1', {
      path: '/Game/M_Wood',
      target_node: 'Material',
      target_pin: 'BaseColor'
    })

    const { method, params } = lastCall()
    expect(method).toBe('material.disconnect_pins')
    expect(params).toEqual({
      material_path: '/Game/M_Wood',
      target_node: 'Material',
      target_pin: 'BaseColor'
    })
  })

  it('省略 target_pin 是合法的 —— 单输入节点占多数', async () => {
    callRequest.mockResolvedValue({ disconnected: true })

    await byName('material_disconnect_pins').execute('c1', {
      path: '/Game/M_Wood',
      target_node: 'Sine_0'
    })

    expect('target_pin' in lastCall().params).toBe(false)
  })

  // 「确保这里是断的」是合法诉求，报成失败会逼调用方先查一次再决定调不调
  it('本来就没接线时不当作失败', async () => {
    callRequest.mockResolvedValue({
      disconnected: false,
      note: 'That input was already empty - nothing to do.'
    })

    const result = (await byName('material_disconnect_pins').execute('c1', {
      path: '/Game/M_Wood',
      target_node: 'Material',
      target_pin: 'Normal'
    })) as { isError?: boolean }

    expect(result.isError).not.toBe(true)
  })
})

describe('material_delete_unused_nodes', () => {
  /**
   * 这条是重点：默认值必须**真的传出去**。
   *
   * Zod 的 .default() 只在解析时生效 —— 如果链路上某处绕过了解析，
   * dry_run 会变成 undefined，引擎侧 TryGetBoolField 读不到就用它自己的
   * 默认值。两边默认值一旦不一致，这个工具就会在没人察觉的情况下真的删节点。
   */
  it('不传 dry_run 时按 true 发出去，而不是留空让引擎自己猜', async () => {
    callRequest.mockResolvedValue({ dry_run: true, unused_count: 0, unused: [], deleted_count: 0 })

    await byName('material_delete_unused_nodes').execute('c1', { path: '/Game/M_Wood' })

    expect(lastCall().params.dry_run).toBe(true)
  })

  it('显式 dry_run=false 才真的删', async () => {
    callRequest.mockResolvedValue({ dry_run: false, unused_count: 2, unused: [], deleted_count: 2 })

    await byName('material_delete_unused_nodes').execute('c1', {
      path: '/Game/M_Wood',
      dry_run: false
    })

    expect(lastCall().params.dry_run).toBe(false)
  })

  it('走 material.delete_unused_nodes 这条 RPC', async () => {
    callRequest.mockResolvedValue({ dry_run: true, unused_count: 0, unused: [], deleted_count: 0 })
    await byName('material_delete_unused_nodes').execute('c1', { path: '/Game/M_Wood' })
    expect(lastCall().method).toBe('material.delete_unused_nodes')
  })
})

/**
 * 材质参数集合（MPC）—— 「一个开关控制全场景材质」。
 *
 * 测的重点是**建出来还得能用**：MPC 本身不影响任何东西，
 * 必须在材质里加一个 CollectionParameter 节点引用它。
 * 少了这一步，调用方会以为「建好了」然后发现画面纹丝不动。
 */
describe('material_parameter_collection', () => {
  const collection = {
    collection_path: '/Game/Materials/MPC_Weather',
    collection_name: 'MPC_Weather',
    created: true,
    scalars: [{ name: 'Wetness', value: 0 }],
    vectors: [{ name: 'SkyTint', value: { r: 1, g: 1, b: 1, a: 1 } }],
    scalar_slots_left: 15,
    vector_slots_left: 15
  }

  it('注册了，且是 mutating', () => {
    expect(byName('material_parameter_collection').unrealBox).toEqual({
      namespace: 'ue.material',
      risk: 'mutating'
    })
  })

  it('走 material.parameter_collection，参数原样透传', async () => {
    callRequest.mockResolvedValue(collection)

    await byName('material_parameter_collection').execute('c1', {
      action: 'create',
      collection_name: 'MPC_Weather',
      scalars: [{ name: 'Wetness', value: 0 }]
    })

    const { method, params } = lastCall()
    expect(method).toBe('material.parameter_collection')
    expect(params.action).toBe('create')
    expect(params.collection_name).toBe('MPC_Weather')
  })

  /**
   * 这条是重点：建完必须指出下一步。
   *
   * MPC 本身什么也不影响 —— 不在材质里引用它，调用方会拿着一个
   * 「创建成功」去问用户为什么没变化。
   */
  it('回执里给出「怎么在材质里用它」的下一步', async () => {
    callRequest.mockResolvedValue(collection)

    const result = (await byName('material_parameter_collection').execute('c1', {
      action: 'create',
      collection_name: 'MPC_Weather'
    })) as { content?: Array<{ text?: string }> }

    const text = JSON.stringify(result)
    expect(text).toContain('CollectionParameter')
    expect(text).toContain('/Game/Materials/MPC_Weather')
  })

  // 16 是引擎硬上限，超了引擎会静默丢弃 —— 报出来才不会让调用方
  // 拿着一个「成功」去材质里找一个根本不存在的参数
  it('把剩余位置和被拒的参数报出来', async () => {
    callRequest.mockResolvedValue({
      ...collection,
      scalar_slots_left: 0,
      rejected: "scalar 'Extra' (collection is full, 16 max)"
    })

    const result = await byName('material_parameter_collection').execute('c1', {
      action: 'set',
      collection_path: '/Game/Materials/MPC_Weather',
      scalars: [{ name: 'Extra', value: 1 }]
    })

    const text = JSON.stringify(result)
    expect(text).toContain('Extra')
    expect(text).toContain('16')
  })

  it('空集合时说清楚里面还没有参数', async () => {
    callRequest.mockResolvedValue({
      ...collection,
      created: false,
      scalars: [],
      vectors: [],
      scalar_slots_left: 16,
      vector_slots_left: 16
    })

    const result = await byName('material_parameter_collection').execute('c1', {
      action: 'list',
      collection_path: '/Game/Materials/MPC_Weather'
    })

    expect(JSON.stringify(result)).toContain('还没有任何参数')
  })
})

describe('material_create_function / material_get_referencers', () => {
  it('材质函数是 mutating，反查引用是 safe（只读不该弹审批）', () => {
    expect(byName('material_create_function').unrealBox.risk).toBe('mutating')
    expect(byName('material_get_referencers').unrealBox.risk).toBe('safe')
  })

  /**
   * 建出来是空的、而且**这套工具填不了它**，这两件事都必须说。
   *
   * 原来这里断言回执里出现 "FunctionOutput"，照着那句话走是条死路：
   * 图表类命令一律 `LoadObject<UMaterial>`，拿函数路径去调只会回
   * "Material not found"，而 `FunctionOutput` 压根不在可建的节点类型里。
   * 模型会白跑好几轮，还在用户工程里留下一个永远空着的函数资产。
   * 所以改成断言「说了填不了」和「给了能走通的替代路子」。
   */
  it('建完点破「现在是空的」和「这套工具填不了它」', async () => {
    callRequest.mockResolvedValue({
      function_path: '/Game/Materials/MF_Wetness',
      function_name: 'MF_Wetness'
    })

    const result = await byName('material_create_function').execute('c1', {
      function_name: 'MF_Wetness'
    })

    const text = JSON.stringify(result)
    expect(text).toContain('空的')
    expect(text).toContain('填不了')
    expect(text).toContain('材质编辑器')
    expect(text).toContain('MaterialFunctionCall')
  })

  it('没人引用时明确说「删掉不会影响别的东西」', async () => {
    callRequest.mockResolvedValue({
      asset_path: '/Game/T_Unused',
      referencer_count: 0,
      referencers: [],
      truncated: false
    })

    const result = await byName('material_get_referencers').execute('c1', {
      path: '/Game/T_Unused'
    })

    expect(JSON.stringify(result)).toContain('不会影响')
  })

  // 改母材质之前问一句 —— 不知道影响面就动手是这里最常见的事故
  it('列出引用者时把影响面说出来', async () => {
    callRequest.mockResolvedValue({
      asset_path: '/Game/M_Wood',
      referencer_count: 2,
      referencers: [
        { path: '/Game/MI_WoodDark', class: 'MaterialInstanceConstant' },
        { path: '/Game/Maps/Main', class: 'World' }
      ],
      truncated: false
    })

    const result = await byName('material_get_referencers').execute('c1', {
      path: '/Game/M_Wood'
    })

    const text = JSON.stringify(result)
    expect(text).toContain('MI_WoodDark')
    expect(text).toContain('MaterialInstanceConstant')
    expect(text).toContain('影响')
  })

  it('被截断时说清楚还有更多', async () => {
    callRequest.mockResolvedValue({
      asset_path: '/Game/M_Wood',
      referencer_count: 200,
      referencers: [{ path: '/Game/MI_A' }],
      truncated: true
    })

    expect(
      JSON.stringify(
        await byName('material_get_referencers').execute('c1', { path: '/Game/M_Wood' })
      )
    ).toContain('还有更多')
  })
})

/**
 * 「没人引用」这个答案最危险 —— 真机验证撞出来的。
 *
 * 引用关系从已落盘的包里读。刚建好还没存的引用不在索引里，于是
 * 「这张贴图还有人用吗」会答「没有」，用户照着删掉，下次打开工程
 * 一片丢失引用。所以有未保存的包时，绝不能说「删掉不会影响别的东西」。
 */
describe('material_get_referencers：未保存时的结论不能用来删东西', () => {
  it('有未保存的包 + 查到 0 个引用者 → 不许说「删掉不会影响」', async () => {
    callRequest.mockResolvedValue({
      asset_path: '/Game/T_Maybe',
      referencer_count: 0,
      referencers: [],
      truncated: false,
      unsaved_package_count: 3,
      incomplete_reason: '3 unsaved package(s) exist'
    })

    const text = JSON.stringify(
      await byName('material_get_referencers').execute('c1', { path: '/Game/T_Maybe' })
    )

    expect(text).not.toContain('删掉它不会影响别的东西')
    expect(text).toContain('不能用来决定删不删')
    expect(text).toContain('ue_save')
  })

  it('全部已保存 + 0 个引用者 → 可以放心说删掉没影响', async () => {
    callRequest.mockResolvedValue({
      asset_path: '/Game/T_Unused',
      referencer_count: 0,
      referencers: [],
      truncated: false,
      unsaved_package_count: 0
    })

    expect(
      JSON.stringify(
        await byName('material_get_referencers').execute('c1', { path: '/Game/T_Unused' })
      )
    ).toContain('不会影响')
  })

  // 查到了引用者也一样要提醒：可能还有更多没算进来
  it('有未保存的包 + 查到了引用者 → 提醒列表可能不全', async () => {
    callRequest.mockResolvedValue({
      asset_path: '/Game/M_Wood',
      referencer_count: 1,
      referencers: [{ path: '/Game/MI_A', class: 'MaterialInstanceConstant' }],
      truncated: false,
      unsaved_package_count: 2
    })

    const text = JSON.stringify(
      await byName('material_get_referencers').execute('c1', { path: '/Game/M_Wood' })
    )

    expect(text).toContain('MI_A')
    expect(text).toContain('可能有更多引用者没算进来')
  })

  // 老插件不回这个字段时按「已保存」处理，不能凭空冒出一条警告
  it('旧插件不回 unsaved_package_count 时不乱报警', async () => {
    callRequest.mockResolvedValue({
      asset_path: '/Game/T_Unused',
      referencer_count: 0,
      referencers: [],
      truncated: false
    })

    expect(
      JSON.stringify(
        await byName('material_get_referencers').execute('c1', { path: '/Game/T_Unused' })
      )
    ).toContain('不会影响')
  })
})

/**
 * 模型侧只有一个 `path`。
 *
 * 以前插件的键名直接透给模型，同一件事有四种叫法（`material_path` /
 * `parent_path` / `asset_path` / `path`），skill 里为此专门列了一张表教模型
 * 哪个工具用哪个名字 —— schema 不一致的成本被转嫁成了每次材质任务的上下文。
 * 现在统一在 `toParams` 里换，插件一个字都不用改。
 */
describe('模型侧统一用 path，线上键名由 toParams 负责换', () => {
  const cases: Array<[string, string, string, Record<string, unknown>]> = [
    [
      'material_set_node_value',
      'material_path',
      '/Game/M_Wood',
      { node_id: 'Constant_0', value: 1 }
    ],
    ['material_delete_node', 'material_path', '/Game/M_Wood', { node_id: 'Constant_0' }],
    ['material_delete_unused_nodes', 'material_path', '/Game/M_Wood', {}],
    ['material_disconnect_pins', 'material_path', '/Game/M_Wood', { target_node: 'Material' }],
    ['material_apply', 'material_path', '/Game/MI_Wood', { targets: { names: ['Cube'] } }],
    ['material_create_instance', 'parent_path', '/Game/M_Wood', {}],
    ['material_get_referencers', 'asset_path', '/Game/M_Wood', {}]
  ]

  for (const [tool, wireKey, path, rest] of cases) {
    it(`${tool}：模型传 path → 引擎收到 ${wireKey}`, async () => {
      callRequest.mockResolvedValue({})

      await byName(tool).execute('c1', { path, ...rest })

      const { params } = lastCall()
      expect(params[wireKey]).toBe(path)
      // 模型侧那个名字不该漏到线上去
      expect('path' in params).toBe(wireKey === 'path')
    })
  }
})
