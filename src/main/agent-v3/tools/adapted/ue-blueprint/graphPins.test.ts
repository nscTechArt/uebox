import { describe, expect, it, vi } from 'vitest'

import { electronMock, servicesMock, targetContextMock } from '../../../testSupport/toolMocks'

// getBlueprintGraph → services → electron。理由见 testSupport/toolMocks.ts。
// 包一层箭头：vi.mock 会被提升到 import 之上，直接传标识符会在初始化前访问它。
vi.mock('electron', () => electronMock())
vi.mock('../../../../services', () => servicesMock())
vi.mock('../../../core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)

import { __testing, type BlueprintGraphPinInfo } from './getBlueprintGraph'

const { describePin } = __testing

function pin(overrides: Partial<BlueprintGraphPinInfo>): BlueprintGraphPinInfo {
  return {
    name: 'Value',
    dir: 'Input',
    category: 'float',
    sub_category: '',
    is_array: false,
    is_reference: false,
    is_const: false,
    ...overrides
  }
}

/**
 * 引脚是模型改图的**唯一依据** —— 系统提示词里写死了「引脚名不能猜，
 * 必须先调 get_graph 拿真的」。所以这里删掉的每一个字段，都会变成模型
 * 只能靠猜的东西，而猜错的表现是「连了一条不存在的线」，报错里还看不出
 * 是猜的问题。
 *
 * 这几条锁的都是曾经为了省 token 删掉过的信息。
 */
describe('describePin', () => {
  it('保留 self —— 函数调用节点的 Target 就是它', () => {
    expect(describePin(pin({ name: 'self', category: 'object' })).name).toBe('self')
  })

  it('保留 WorldContextObject 和 OutputDelegate', () => {
    expect(describePin(pin({ name: 'WorldContextObject' })).name).toBe('WorldContextObject')
    expect(describePin(pin({ name: 'OutputDelegate' })).name).toBe('OutputDelegate')
  })

  /**
   * 只回 category 的话，Actor 引脚和 Component 引脚在模型眼里长得一模一样
   * （都是 "object"），接不上也看不出来，得等编译才报错。
   */
  it('object 引脚带上具体类，不是光一个 object', () => {
    const result = describePin(
      pin({ name: 'Target', category: 'object', sub_category_object: 'Actor' })
    )
    expect(result.type).toBe('object(Actor)')
  })

  it('struct 引脚带上结构体名', () => {
    const result = describePin(
      pin({ name: 'NewLocation', category: 'struct', sub_category_object: 'Vector' })
    )
    expect(result.type).toBe('struct(Vector)')
  })

  it('没有具体类型时只回大类', () => {
    expect(describePin(pin({ category: 'float' })).type).toBe('float')
    expect(describePin(pin({ category: 'bool' })).type).toBe('bool')
  })

  it('exec 引脚一律标 exec，不去拼子类型', () => {
    const result = describePin(
      pin({ name: 'then', category: 'exec', sub_category_object: 'ShouldNotAppear' })
    )
    expect(result.type).toBe('exec')
  })

  /** 数组和引用只在为真时出现 —— 每个引脚都挂两个 false 是白占地方 */
  it('is_array / is_reference 只在为真时出现', () => {
    expect(describePin(pin({ is_array: false, is_reference: false })).is_array).toBeUndefined()

    const arrayPin = describePin(pin({ is_array: true, is_reference: true }))
    expect(arrayPin.is_array).toBe(true)
    expect(arrayPin.is_reference).toBe(true)
  })
})

/**
 * 这两组是真机验证逼出来的。
 *
 * `then/else` 那条：Branch 的两个出口在编辑器里显示 true/false，真名是
 * then/else（PinFriendlyName 只用于显示）。我把显示名写进了工具描述，
 * 真机第一次跑就撞上「pin 'True' not found」。
 *
 * `default_value` 那条：get_graph 原来一个默认值都不回，于是「读回来改一改
 * 写回去」会把图里所有字面量静默清空 —— 调用方根本不知道它们存在过。
 */
describe('显示名与真名不一致时要说出来', () => {
  it('friendly_name 和 name 不同 → 带上 displayed_as', () => {
    const out = describePin(pin({ name: 'then', friendly_name: 'true', category: 'exec' }))
    expect(out.name).toBe('then')
    expect(out.displayed_as).toBe('true')
  })

  it('两者一致 → 不带，省 token 也少噪音', () => {
    const out = describePin(pin({ name: 'Duration', friendly_name: 'Duration' }))
    expect(out).not.toHaveProperty('displayed_as')
  })

  it('大小写差异不算不一致', () => {
    const out = describePin(pin({ name: 'InString', friendly_name: 'instring' }))
    expect(out).not.toHaveProperty('displayed_as')
  })

  it('没有 friendly_name 时不带', () => {
    const out = describePin(pin({ name: 'Value' }))
    expect(out).not.toHaveProperty('displayed_as')
  })
})

describe('引脚上的字面量要回给调用方', () => {
  it('default_value 原样带上', () => {
    const out = describePin(pin({ name: 'InString', default_value: 'door ready' }))
    expect(out.default_value).toBe('door ready')
  })

  it('对象引用走 default_object，也归到同一个字段', () => {
    const out = describePin(
      pin({ name: 'Class', category: 'class', default_object: '/Script/Engine.StaticMeshActor' })
    )
    expect(out.default_value).toBe('/Script/Engine.StaticMeshActor')
  })

  it('文本走 default_text，同样归一', () => {
    const out = describePin(pin({ name: 'Label', category: 'text', default_text: '你好' }))
    expect(out.default_value).toBe('你好')
  })

  it('没有默认值就不带这个字段', () => {
    const out = describePin(pin({ name: 'Value' }))
    expect(out).not.toHaveProperty('default_value')
  })
})

/**
 * 连线只存在于 `pins[].linked_to` —— 插件不发顶层的 connections。
 *
 * 这条是真机抓到的：图里明明有 4 个连线端点，工具报 connection_count: 0。
 * 而「读回来改一改整图写回去」是主要用法，看到 0 条连线就会写回一张
 * **完全断开**的图。
 */
describe('从引脚推导连线', () => {
  const { deriveConnectionsFromPins } = __testing

  const node = (id: string, pins: Array<Partial<BlueprintGraphPinInfo>>): unknown => ({
    node_id: id,
    class: 'K2Node_X',
    title: id,
    pos_x: 0,
    pos_y: 0,
    pins: pins.map((p) => pin(p))
  })

  it('输出引脚连到输入引脚 → 一条连线，方向是输出到输入', () => {
    const out = deriveConnectionsFromPins([
      node('A', [
        { name: 'then', dir: 'Output', linked_to: [{ node_id: 'B', pin_name: 'execute' }] }
      ]),
      node('B', [
        { name: 'execute', dir: 'Input', linked_to: [{ node_id: 'A', pin_name: 'then' }] }
      ])
    ] as never)

    expect(out).toEqual([
      { from_node_id: 'A', from_pin: 'then', to_node_id: 'B', to_pin: 'execute' }
    ])
  })

  it('同一根线不会因为两端各记一次而重复', () => {
    const out = deriveConnectionsFromPins([
      node('A', [{ name: 'v', dir: 'Output', linked_to: [{ node_id: 'B', pin_name: 'in' }] }]),
      node('B', [{ name: 'in', dir: 'Input', linked_to: [{ node_id: 'A', pin_name: 'v' }] }])
    ] as never)

    expect(out).toHaveLength(1)
  })

  it('一个输出连多个输入 → 每个各一条', () => {
    const out = deriveConnectionsFromPins([
      node('A', [
        {
          name: 'then',
          dir: 'Output',
          linked_to: [
            { node_id: 'B', pin_name: 'execute' },
            { node_id: 'C', pin_name: 'execute' }
          ]
        }
      ])
    ] as never)

    expect(out).toHaveLength(2)
    expect(out.map((c) => c.to_node_id)).toEqual(['B', 'C'])
  })

  it('没有连线时回空数组，不是 undefined', () => {
    expect(
      deriveConnectionsFromPins([node('A', [{ name: 'then', dir: 'Output' }])] as never)
    ).toEqual([])
  })

  it('缺 node_id 的脏数据跳过，不产出半条连线', () => {
    const out = deriveConnectionsFromPins([
      node('A', [{ name: 'then', dir: 'Output', linked_to: [{ pin_name: 'execute' }] }])
    ] as never)

    expect(out).toEqual([])
  })

  it('nodes 缺席时不炸', () => {
    expect(deriveConnectionsFromPins(undefined)).toEqual([])
  })
})

/**
 * 「读回来改一改写回去」是这套工具的主要用法，而它成立的前提是：
 * 读回来的那份**足够重建**。少带一个字段，模型写回去的图就和它读到的不是
 * 同一张，而返回里看不出任何异常 —— 这是最难查的一类坏法。
 */
describe('节点的重建说明', () => {
  const { describeNodeForModel } = __testing

  const node = (overrides: Record<string, unknown>): never =>
    ({
      node_id: 'GUID-1',
      class: 'K2Node_CustomEvent',
      title: 'OnDoorOpened',
      pos_x: 10,
      pos_y: 20,
      pins: [],
      ...overrides
    }) as never

  it('自定义事件的参数表要带回来 —— 丢了它写回去的事件就没有引脚', () => {
    const params = [
      { name: 'Opener', type: 'object', object_class: '/Script/Engine.Actor' },
      { name: 'Delay', type: 'float' }
    ]

    const out = describeNodeForModel(
      node({ write_as: 'CustomEvent', member_name: 'OnDoorOpened', params })
    )

    expect(out.params).toEqual(params)
    expect(out.write_as).toBe('CustomEvent')
  })

  it('无参事件不带空的 params —— 空数组会被当成「查过了，没有」以外的东西', () => {
    const out = describeNodeForModel(
      node({ write_as: 'CustomEvent', member_name: 'Ping', params: [] })
    )

    expect(out).not.toHaveProperty('params')
  })

  it('重建不了的节点不给 write_as，调用方据此知道只能连它不能重写它', () => {
    const out = describeNodeForModel(node({ class: 'K2Node_Knot' }))

    expect(out).not.toHaveProperty('write_as')
    expect(out.id).toBe('GUID-1')
  })

  /**
   * Timeline 的曲线在引脚里是看不见的：引脚只说得出「有一条 Alpha 输出」。
   * 这一段掉了，模型改 Timeline 只能凭空重打一条曲线，把用户手拉的切线盖掉，
   * 而返回里没有任何迹象 —— 和上面 params 那条是同一类坏法。
   */
  it('Timeline 的曲线要带回来 —— 引脚说不出关键帧', () => {
    const timeline = {
      length: 1,
      loop: false,
      autoplay: false,
      tracks: [
        {
          name: 'Alpha',
          keys: [
            { time: 0, value: 0 },
            { time: 1, value: 1, interp: 'auto' }
          ]
        }
      ]
    }

    const out = describeNodeForModel(
      node({
        class: 'K2Node_Timeline',
        write_as: 'Timeline',
        member_name: 'DoorTimeline',
        timeline
      })
    )

    expect(out.timeline).toEqual(timeline)
  })

  it('没有 timeline 的节点不带这个字段', () => {
    const out = describeNodeForModel(node({ write_as: 'Event', member_name: 'ReceiveBeginPlay' }))

    expect(out).not.toHaveProperty('timeline')
  })
})
