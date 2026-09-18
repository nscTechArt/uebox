/**
 * @vitest-environment node
 *
 * 记录脚本的 `flatten` —— 真机验收里「用户原有内容没被动过」的凭据。
 *
 * 这个函数漏一个字段，凭据就是假的。上一版只摊了 `class` / `write_as`，
 * 于是把同一个节点从 Add 改成 Subtract（两者 class 相同、差别在 `member_name`）
 * 之后，脚本照样输出「逐条相等 —— 图没有任何变化」。
 */

import { describe, expect, it } from 'vitest'
// @ts-expect-error 这是一份 .mjs 脚本，没有类型声明；测的是它的纯函数
import { flatten, nodesOf } from '../../scripts/snippet-roundtrip-probe.mjs'

type Row = string
const rows = (node: unknown): Row[] => flatten(node) as Row[]

describe('flatten —— 节点身份', () => {
  it('member_name 变了要看得出来（Add → Subtract 的反例）', () => {
    const add = {
      node_id: 'n1',
      class: 'K2Node_CommutativeAssociativeBinaryOperator',
      member_name: 'KismetMathLibrary.Add_IntInt',
      pins: []
    }
    const subtract = { ...add, member_name: 'KismetMathLibrary.Subtract_IntInt' }

    expect(rows(add)).not.toEqual(rows(subtract))
  })

  it('target_class 变了要看得出来', () => {
    const base = { node_id: 'n1', class: 'K2Node_DynamicCast', pins: [] }
    expect(rows({ ...base, target_class: 'Pawn' })).not.toEqual(
      rows({ ...base, target_class: 'Character' })
    )
  })

  it('struct_type 变了要看得出来', () => {
    const base = { node_id: 'n1', class: 'K2Node_MakeStruct', pins: [] }
    expect(rows({ ...base, struct_type: 'Vector' })).not.toEqual(
      rows({ ...base, struct_type: 'Rotator' })
    )
  })

  it('write_as 变了要看得出来', () => {
    const base = { node_id: 'n1', class: 'K2Node_X', pins: [] }
    expect(rows({ ...base, write_as: 'Branch' })).not.toEqual(
      rows({ ...base, write_as: 'Sequence' })
    )
  })

  it('完全一样的节点摊出来一致', () => {
    const node = {
      node_id: 'n1',
      class: 'K2Node_CallFunction',
      member_name: 'KismetSystemLibrary.PrintString',
      pins: []
    }
    expect(rows(node)).toEqual(rows({ ...node }))
  })
})

describe('flatten —— 每个引脚都要出一行', () => {
  it('给 Sequence 加一个未连接的输出，要判成变了', () => {
    // 上一版只记「带默认值或带连线」的引脚，于是引脚从 3 个变成 4 个
    // 照样判「相同」—— 而这正是决定 5 的核心假设要盯的那类改动。
    const seq = (extra: boolean): unknown => ({
      node_id: 'seq',
      class: 'K2Node_ExecutionSequence',
      write_as: 'Sequence',
      pins: [
        { name: 'execute', dir: 'Input', category: 'exec' },
        { name: 'then_0', dir: 'Output', category: 'exec' },
        { name: 'then_1', dir: 'Output', category: 'exec' },
        ...(extra ? [{ name: 'then_2', dir: 'Output', category: 'exec' }] : [])
      ]
    })

    expect(rows(seq(false))).not.toEqual(rows(seq(true)))
    expect(rows(seq(true))).toHaveLength(rows(seq(false)).length + 1)
  })

  it('引脚类型变了要看得出来', () => {
    const pin = (category: string): unknown => ({
      node_id: 'n1',
      class: 'X',
      pins: [{ name: 'Value', dir: 'Input', category }]
    })
    expect(rows(pin('int'))).not.toEqual(rows(pin('float')))
  })

  it('引脚方向变了要看得出来', () => {
    const pin = (dir: string): unknown => ({
      node_id: 'n1',
      class: 'X',
      pins: [{ name: 'Value', dir, category: 'int' }]
    })
    expect(rows(pin('Input'))).not.toEqual(rows(pin('Output')))
  })

  it('引脚改名要看得出来', () => {
    const pin = (name: string): unknown => ({
      node_id: 'n1',
      class: 'X',
      pins: [{ name, dir: 'Input', category: 'int' }]
    })
    expect(rows(pin('A'))).not.toEqual(rows(pin('B')))
  })

  it('数组 / 引用标记变了要看得出来', () => {
    const base = { node_id: 'n1', class: 'X' }
    const plain = { ...base, pins: [{ name: 'P', dir: 'Input', category: 'int' }] }
    const array = { ...base, pins: [{ name: 'P', dir: 'Input', category: 'int', is_array: true }] }
    expect(rows(plain)).not.toEqual(rows(array))
  })

  it('工具层的 type 和插件层的 category 都认', () => {
    const fromTool = { node_id: 'n1', class: 'X', pins: [{ name: 'P', type: 'int' }] }
    const fromPlugin = { node_id: 'n1', class: 'X', pins: [{ name: 'P', category: 'int' }] }
    expect(rows(fromTool)).toEqual(rows(fromPlugin))
  })
})

describe('flatten —— 引脚与连线', () => {
  it('引脚默认值变了要看得出来', () => {
    const make = (value: string): unknown => ({
      node_id: 'n1',
      class: 'K2Node_CallFunction',
      pins: [{ name: 'InString', default_value: value }]
    })
    expect(rows(make('hello'))).not.toEqual(rows(make('world')))
  })

  it('三个默认值槽位分开写 —— 值挪了个槽位也要看得出来', () => {
    const asValue = {
      node_id: 'n1',
      class: 'X',
      pins: [{ name: 'P', default_value: '/Game/A' }]
    }
    const asObject = {
      node_id: 'n1',
      class: 'X',
      pins: [{ name: 'P', default_object: '/Game/A' }]
    }
    expect(rows(asValue)).not.toEqual(rows(asObject))
  })

  it('连线变了要看得出来', () => {
    const make = (to: string): unknown => ({
      node_id: 'n1',
      class: 'X',
      pins: [{ name: 'then', linked_to: [{ node_id: to, pin_name: 'execute' }] }]
    })
    expect(rows(make('n2'))).not.toEqual(rows(make('n3')))
  })

  it('连线断掉要看得出来', () => {
    const linked = {
      node_id: 'n1',
      class: 'X',
      pins: [{ name: 'then', linked_to: [{ node_id: 'n2', pin_name: 'execute' }] }]
    }
    const unlinked = { node_id: 'n1', class: 'X', pins: [{ name: 'then', linked_to: [] }] }
    expect(rows(linked)).not.toEqual(rows(unlinked))
  })

  it('坐标单独一行 —— 挪位置看得见，但不会和逻辑变化混在一起', () => {
    const at = (x: number): unknown => ({ node_id: 'n1', class: 'X', pos_x: x, pos_y: 0, pins: [] })
    const moved = rows(at(100))
    const original = rows(at(0))

    expect(moved).not.toEqual(original)
    // 身份那一行没变，只有 pos 行变了
    expect(moved[0]).toBe(original[0])
  })
})

describe('nodesOf', () => {
  it('认得出 { data: { nodes } } 和裸 { nodes } 两种包法', () => {
    expect(nodesOf({ raw: { data: { nodes: [1, 2] } } })).toHaveLength(2)
    expect(nodesOf({ raw: { nodes: [1] } })).toHaveLength(1)
  })

  it('没有 nodes 时回空数组，不抛', () => {
    expect(nodesOf({})).toEqual([])
    expect(nodesOf({ raw: {} })).toEqual([])
  })
})
