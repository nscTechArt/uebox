import { describe, it, expect } from 'vitest'
import { summarizeInputMap, checkInjectLayer, type InputMapResponse } from './summary'

function make(overrides: Partial<InputMapResponse> = {}): InputMapResponse {
  return {
    ok: true,
    source: 'runtime',
    source_note: '',
    input_system: 'enhanced',
    contexts: [],
    actions: [],
    action_count: 0,
    ...overrides
  }
}

describe('summarizeInputMap', () => {
  it('运行时与资产两种来源必须在结论第一句就分开', () => {
    // 这是整个工具最要紧的区分：资产里定义了不代表游戏里那一刻挂着。
    // 只放在字段里模型不一定看，据此操作就会「注入了没反应」
    expect(summarizeInputMap(make({ source: 'runtime' }))).toContain('此刻真实生效')
    expect(summarizeInputMap(make({ source: 'asset' }))).toContain('工程里定义')
  })

  it('运行时报出挂着几个上下文', () => {
    const text = summarizeInputMap(
      make({
        source: 'runtime',
        contexts: [
          { path: '/Game/IMC_A', name: 'IMC_A' },
          { path: '/Game/IMC_B', name: 'IMC_B' }
        ]
      })
    )
    expect(text).toContain('2 个输入上下文')
  })

  it('旧输入系统的工程要明说「没有动作层」', () => {
    // 不点破的话，模型会一直去找 IA 资产，找不到就说这个工程没配输入 ——
    // 把工具的盲区说成用户的 bug。5.0–5.3 起步的工程大量是这一类
    const text = summarizeInputMap(make({ input_system: 'legacy' }))
    expect(text).toContain('没有 Enhanced Input 动作')
    expect(text).toContain('旧输入系统')
  })

  it('两套并存的工程不报「没有动作层」', () => {
    const text = summarizeInputMap(make({ input_system: 'both', action_count: 3 }))
    expect(text).toContain('并存')
    expect(text).not.toContain('没有 Enhanced Input 动作')
  })

  it('什么都没找到时如实说，不装作正常', () => {
    expect(summarizeInputMap(make({ input_system: 'none' }))).toContain('没找到任何输入配置')
  })

  it('运行时读失败的原因要带进结论', () => {
    const text = summarizeInputMap(
      make({ source: 'asset', runtime_error: '这个世界里还没有 PlayerController' })
    )
    expect(text).toContain('PlayerController')
  })

  it('资产被截断必须说出来', () => {
    // 默默少给几个上下文，模型会以为剩下那些绑定不存在
    const text = summarizeInputMap(
      make({ source: 'asset', contexts_truncated: true, contexts_limit: 40 })
    )
    expect(text).toContain('40')
    expect(text).toContain('只列了前')
  })

  it('没有截断时不提这件事', () => {
    expect(summarizeInputMap(make())).not.toContain('只列了前')
  })
})

describe('checkInjectLayer', () => {
  it('恰好给一个才放行', () => {
    expect(checkInjectLayer('IA_Move', undefined)).toBeNull()
    expect(checkInjectLayer(undefined, 'W')).toBeNull()
  })

  it('两个都给要拒绝，并说清两层的区别', () => {
    // 替调用方猜一层的后果不是「跑不动」，是结论错得看不出来：
    // 它想验键位，我们走了动作层，它拿到成功返回，于是以为键位正常
    const err = checkInjectLayer('IA_Move', 'W')
    expect(err).toContain('只能给一个')
    expect(err).toContain('验键位')
  })

  it('都不给也要拒绝，并指路 ue_input_map', () => {
    const err = checkInjectLayer(undefined, undefined)
    expect(err).toContain('ue_input_map')
  })

  it('空字符串等于没给', () => {
    expect(checkInjectLayer('', '')).toContain('ue_input_map')
    expect(checkInjectLayer('IA_Move', '')).toBeNull()
  })
})
