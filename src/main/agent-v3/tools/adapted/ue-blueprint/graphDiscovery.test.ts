import { describe, expect, it } from 'vitest'

import {
  describeGraphNameMiss,
  explainGraphNameMiss,
  type BlueprintGraphRef
} from './graphDiscovery'

/** 新插件（1.2.12 起）对一张动画蓝图回的图列表：AnimGraph 带 anim_graph 类型，子图按路径列 */
const ANIM_BP: BlueprintGraphRef[] = [
  { name: 'EventGraph', type: 'event' },
  { name: 'AnimGraph', type: 'anim_graph' },
  { name: 'AnimGraph/MR22基础动作', type: 'state_machine' },
  { name: 'AnimGraph/MR22基础动作/待机', type: 'state' },
  { name: 'AnimGraph/MR22基础动作/移动', type: 'state' },
  { name: 'AnimGraph/MR22基础动作/待机->移动', type: 'transition' },
  { name: 'AnimGraph/上半身/待机', type: 'state' }
]

/**
 * 真机上模型写的是 `blueprint_get_graph("待机")`：用户嘴里、编辑器标签页上都这么叫。
 * 插件只认完整路径，回一句 404，模型据此断定「状态内部的图读不到」，转头让用户手点。
 */
describe('explainGraphNameMiss', () => {
  it('只写状态机的名字 → 换成完整路径', () => {
    expect(explainGraphNameMiss('MR22基础动作', ANIM_BP)).toEqual({
      kind: 'resolved',
      path: 'AnimGraph/MR22基础动作'
    })
  })

  it('路径只写后半段也认', () => {
    expect(explainGraphNameMiss('MR22基础动作/待机', ANIM_BP)).toEqual({
      kind: 'resolved',
      path: 'AnimGraph/MR22基础动作/待机'
    })
  })

  it('转换写成带空格的 A -> B 也认（和插件切路径的规矩一致）', () => {
    expect(explainGraphNameMiss('待机 -> 移动', ANIM_BP)).toEqual({
      kind: 'resolved',
      path: 'AnimGraph/MR22基础动作/待机->移动'
    })
  })

  it('两个状态机里都有同名状态 → 不替它挑，列出完整路径', () => {
    expect(explainGraphNameMiss('待机', ANIM_BP)).toEqual({
      kind: 'ambiguous',
      candidates: ['AnimGraph/MR22基础动作/待机', 'AnimGraph/上半身/待机']
    })
  })

  it('名字本来就在列表里 → 不是名字的问题，返回 null 让原报错照用', () => {
    expect(explainGraphNameMiss('AnimGraph', ANIM_BP)).toBeNull()
    expect(explainGraphNameMiss('animgraph/mr22基础动作', ANIM_BP)).toBeNull()
  })

  it('旧插件：AnimGraph 被当成普通函数图、没有子图 → 说插件太旧，不说「没有这张图」', () => {
    const oldPlugin: BlueprintGraphRef[] = [
      { name: 'EventGraph', type: 'event' },
      { name: 'AnimGraph', type: 'function' }
    ]
    expect(explainGraphNameMiss('待机', oldPlugin)).toEqual({ kind: 'plugin_too_old' })
  })

  it('普通蓝图写错图名 → 真没有，列出现有的图', () => {
    const plain: BlueprintGraphRef[] = [
      { name: 'EventGraph', type: 'event' },
      { name: 'OpenDoor', type: 'function' }
    ]
    expect(explainGraphNameMiss('CloseDoor', plain)).toEqual({
      kind: 'not_found',
      available: ['EventGraph', 'OpenDoor']
    })
  })
})

describe('describeGraphNameMiss', () => {
  it('有歧义时把候选的完整路径都给出来', () => {
    const text = describeGraphNameMiss(
      '待机',
      { kind: 'ambiguous', candidates: ['AnimGraph/A/待机', 'AnimGraph/B/待机'] },
      'HINT'
    )
    expect(text).toContain('AnimGraph/A/待机')
    expect(text).toContain('AnimGraph/B/待机')
  })

  it('插件太旧时接上更新插件的那句', () => {
    expect(describeGraphNameMiss('待机', { kind: 'plugin_too_old' }, 'HINT')).toContain('HINT')
  })

  it('图很多时截断并说还剩几张', () => {
    const available = Array.from({ length: 70 }, (_, i) => `G${i}`)
    const text = describeGraphNameMiss('X', { kind: 'not_found', available }, 'HINT')
    expect(text).toContain('G59')
    expect(text).not.toContain('G60')
    expect(text).toContain('+10 more')
  })
})
