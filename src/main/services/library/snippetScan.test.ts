import { describe, expect, it } from 'vitest'
import { describeRejections, scanSnippet, type ReadGraph, type ReadNode } from './snippetScan'

/** 一个最省事的、没有外部依赖的节点 */
function printNode(overrides: Partial<ReadNode> = {}): ReadNode {
  return {
    id: 'print',
    class: 'K2Node_CallFunction',
    title: '打印字符串',
    write_as: 'Function',
    member_name: 'KismetSystemLibrary.PrintString',
    pos_x: 100,
    pos_y: 200,
    pins: [
      { name: 'execute', dir: 'Input', type: 'exec' },
      { name: 'then', dir: 'Output', type: 'exec' },
      { name: 'InString', dir: 'Input', type: 'string', default_value: 'Hello' }
    ],
    ...overrides
  }
}

function beginPlay(overrides: Partial<ReadNode> = {}): ReadNode {
  return {
    id: 'begin',
    class: 'K2Node_Event',
    title: '事件开始运行',
    write_as: 'Event',
    member_name: 'ReceiveBeginPlay',
    pins: [{ name: 'then', dir: 'Output', type: 'exec' }],
    ...overrides
  }
}

function graphOf(nodes: ReadNode[], connections: ReadGraph['connections'] = []): ReadGraph {
  return {
    blueprint_path: '/Game/BP_Test',
    graph_name: 'EventGraph',
    nodes,
    connections
  }
}

describe('scanSnippet —— 摘要', () => {
  it('节点数、连线数、用到的类型都算出来', () => {
    const result = scanSnippet(
      graphOf(
        [beginPlay(), printNode()],
        [{ from_node: 'begin', from_pin: 'then', to_node: 'print', to_pin: 'execute' }]
      )
    )

    expect(result.ok).toBe(true)
    expect(result.meta).toEqual({
      nodeCount: 2,
      connectionCount: 1,
      classes: ['Event', 'Function'],
      openPorts: []
    })
  })

  it('类型去重且保持出现顺序', () => {
    const result = scanSnippet(
      graphOf([printNode({ id: 'a' }), beginPlay(), printNode({ id: 'b' })])
    )
    expect(result.meta!.classes).toEqual(['Function', 'Event'])
  })

  it('没有 write_as 的节点按引擎类名记账', () => {
    const comment: ReadNode = { id: 'c', class: 'EdGraphNode_Comment', title: '说明' }
    const result = scanSnippet(graphOf([comment]))
    expect(result.ok).toBe(true)
    expect(result.meta!.classes).toEqual(['EdGraphNode_Comment'])
  })
})

describe('scanSnippet —— 选区与悬空端口', () => {
  it('只算选中的节点', () => {
    const result = scanSnippet(graphOf([beginPlay(), printNode()]), ['print'])
    expect(result.ok).toBe(true)
    expect(result.meta!.nodeCount).toBe(1)
  })

  it('跨出选区的连线记成悬空端口，不算进连线数', () => {
    const result = scanSnippet(
      graphOf(
        [beginPlay(), printNode()],
        [{ from_node: 'begin', from_pin: 'then', to_node: 'print', to_pin: 'execute' }]
      ),
      ['print']
    )

    expect(result.meta!.connectionCount).toBe(0)
    expect(result.meta!.openPorts).toEqual([
      { nodeId: 'print', pinName: 'execute', dir: 'in', formerPeer: 'begin.then' }
    ])
  })

  it('选区里一个节点都没有就拒绝', () => {
    const result = scanSnippet(graphOf([printNode()]), ['nobody'])
    expect(result.ok).toBe(false)
    expect(result.rejections[0].code).toBe('empty-selection')
  })
})

describe('scanSnippet —— 改道之后不再拦形状', () => {
  /*
   * 这一组是 2026-09-12 真机验证（发现四）的成果：整条路线改走 T3D 之后，
   * 「节点被用户改过形状」不再是拒绝理由 —— 引擎自己的序列化保得住。
   * 旧版在这里拦了两类，现在两类都放行。
   */

  it('手动加过输出引脚的 Sequence 现在存得下 —— T3D 保得住第三条分支', () => {
    const sequence: ReadNode = {
      id: 'seq',
      class: 'K2Node_ExecutionSequence',
      title: '序列',
      write_as: 'Sequence',
      pins: [
        { name: 'execute', dir: 'Input', type: 'exec' },
        { name: 'then_0', dir: 'Output', type: 'exec' },
        { name: 'then_1', dir: 'Output', type: 'exec' },
        // 用户手动加的第三个分支。旧版按 dynamic-pins 拒绝
        { name: 'then_2', dir: 'Output', type: 'exec' }
      ]
    }

    expect(scanSnippet(graphOf([sequence])).ok).toBe(true)
  })

  it('注释框和重路由点放行 —— 它们装不下引用', () => {
    const comment: ReadNode = { id: 'c', class: 'EdGraphNode_Comment', title: '受击处理' }
    const knot: ReadNode = { id: 'k', class: 'K2Node_Knot' }
    expect(scanSnippet(graphOf([comment, knot])).ok).toBe(true)
  })
})

describe('scanSnippet —— 看不穿的节点仍然拒绝', () => {
  it('没有 write_as、又不在「确定没引用」名单里的，拒绝', () => {
    const exotic: ReadNode = { id: 'x', class: 'K2Node_SomethingExotic', title: '怪东西' }
    const result = scanSnippet(graphOf([exotic]))
    expect(result.ok).toBe(false)
    expect(result.rejections[0].code).toBe('unscannable')
    expect(result.rejections[0].nodeLabel).toBe('怪东西')
  })

  it('用户自建的宏拒绝 —— 宏存在工程的宏库资产上，换工程就没了', () => {
    // 插件把宏图自己的名字当 write_as 回来，引擎宏（ForLoop）和用户宏
    // （MyAwesomeMacro）在这个字段上长得一模一样，只能靠白名单分
    const userMacro: ReadNode = {
      id: 'm',
      class: 'K2Node_MacroInstance',
      write_as: 'MyAwesomeMacro'
    }
    const result = scanSnippet(graphOf([userMacro]))
    expect(result.ok).toBe(false)
    expect(result.rejections[0].code).toBe('unscannable')
  })

  it('引擎宏放行', () => {
    const forLoop: ReadNode = { id: 'f', class: 'K2Node_MacroInstance', write_as: 'ForLoop' }
    expect(scanSnippet(graphOf([forLoop])).ok).toBe(true)
  })
})

describe('scanSnippet —— 决定 6：有外部依赖的拒绝掉', () => {
  it('变量引用拒绝', () => {
    const varGet: ReadNode = {
      id: 'v',
      class: 'K2Node_VariableGet',
      title: 'Health',
      write_as: 'VariableGet',
      member_name: 'Health',
      pins: [{ name: 'Health', dir: 'Output', type: 'float' }]
    }

    const result = scanSnippet(graphOf([varGet]))
    expect(result.ok).toBe(false)
    expect(result.rejections[0].code).toBe('dependency-variable')
    expect(result.rejections[0].detail).toContain('Health')
  })

  it('自定义函数调用拒绝，引擎内置函数放行', () => {
    const custom = scanSnippet(graphOf([printNode({ member_name: 'MyPlayerLibrary.DoTheThing' })]))
    expect(custom.ok).toBe(false)
    expect(custom.rejections[0].code).toBe('dependency-function')

    expect(scanSnippet(graphOf([printNode()])).ok).toBe(true)
  })

  it('自定义事件拒绝，引擎事件放行', () => {
    const custom = scanSnippet(
      graphOf([beginPlay({ write_as: 'CustomEvent', member_name: 'MyEvent' })])
    )
    expect(custom.ok).toBe(false)
    expect(custom.rejections[0].code).toBe('dependency-function')

    expect(scanSnippet(graphOf([beginPlay()])).ok).toBe(true)
  })

  it('Self 节点拒绝 —— 它绑在当前蓝图上', () => {
    const self: ReadNode = { id: 's', class: 'K2Node_Self', write_as: 'Self', pins: [] }
    const result = scanSnippet(graphOf([self]))
    expect(result.ok).toBe(false)
    expect(result.rejections[0].code).toBe('dependency-component')
  })

  it('struct_type 指向 /Game 结构体的拒绝 —— 上一版漏了这个槽位', () => {
    const makeStruct: ReadNode = {
      id: 'ms',
      class: 'K2Node_MakeStruct',
      title: 'Make ST_Private',
      write_as: 'MakeStruct',
      struct_type: '/Game/Structs/ST_Private.ST_Private',
      pins: []
    }
    const result = scanSnippet(graphOf([makeStruct]))
    expect(result.ok).toBe(false)
    expect(result.rejections[0].code).toBe('dependency-asset')
    expect(result.rejections[0].detail).toContain('ST_Private')
  })

  it('引擎内置结构体放行', () => {
    const makeVector: ReadNode = {
      id: 'mv',
      class: 'K2Node_MakeStruct',
      write_as: 'MakeStruct',
      struct_type: 'Vector',
      pins: []
    }
    expect(scanSnippet(graphOf([makeVector])).ok).toBe(true)
  })

  it('target_class 指向 /Game 资产的拒绝', () => {
    const spawn: ReadNode = {
      id: 'sp',
      class: 'K2Node_SpawnActorFromClass',
      write_as: 'SpawnActor',
      target_class: '/Game/Blueprints/BP_Bullet',
      pins: []
    }
    const result = scanSnippet(graphOf([spawn]))
    expect(result.ok).toBe(false)
    expect(result.rejections[0].code).toBe('dependency-asset')
  })

  it('引脚上填资产引用的拒绝 —— T3D 会把路径原样搬过去，目标工程没有就是断的', () => {
    const node = printNode({
      pins: [
        { name: 'Target', dir: 'Input', type: 'object', default_value: '/Game/Meshes/SM_Rock' }
      ]
    })
    const result = scanSnippet(graphOf([node]))
    expect(result.ok).toBe(false)
    expect(result.rejections[0].code).toBe('dependency-asset')
  })

  it('一次把所有问题节点都列出来，不是报一个停一个', () => {
    const result = scanSnippet(
      graphOf([
        printNode({ id: 'a', write_as: undefined, class: 'K2Node_Weird' }),
        printNode({ id: 'b', member_name: 'MyLib.Custom' })
      ])
    )
    expect(result.ok).toBe(false)
    expect(result.rejections).toHaveLength(2)
    expect(result.rejections.map((r) => r.nodeId)).toEqual(['a', 'b'])
  })
})

describe('describeRejections', () => {
  it('每条都带上节点名，用户才知道去改哪个', () => {
    const result = scanSnippet(graphOf([printNode({ member_name: 'MyLib.Custom' })]))
    expect(describeRejections(result.rejections)).toContain('打印字符串')
  })

  it('没有拒绝就是空串', () => {
    expect(describeRejections([])).toBe('')
  })
})
