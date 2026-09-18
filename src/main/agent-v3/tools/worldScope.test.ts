import { describe, it, expect } from 'vitest'
import { worldFields, describeWorld } from './worldScope'

describe('worldFields', () => {
  it('老插件不回 world 时一个字段都不加', () => {
    // 说不准的时候不说。默认写成 editor 是在替插件编一个没确认的事实 ——
    // 而那个事实一旦错了，模型会拿 PIE 里的读数当关卡里的摆放去改东西
    expect(worldFields(undefined)).toEqual({})
    expect(worldFields({})).toEqual({})
  })

  it('透传 world 与 note', () => {
    expect(worldFields({ world: 'pie', world_note: '改动不落盘' })).toEqual({
      world: 'pie',
      world_note: '改动不落盘'
    })
  })

  it('没有 note 时不补空字符串', () => {
    expect(worldFields({ world: 'editor' })).toEqual({ world: 'editor' })
  })

  it('多客户端时带上实例数', () => {
    expect(worldFields({ world: 'pie', play_world_count: 3 })).toMatchObject({
      play_world_count: 3
    })
  })
})

describe('describeWorld', () => {
  it('编辑器世界不加噪音', () => {
    // 每条返回都缀一句「这是编辑器世界」，说多了模型就不看了，
    // 真正要紧的那次 PIE 提示也跟着被忽略
    expect(describeWorld({ world: 'editor' })).toBe('')
    expect(describeWorld(undefined)).toBe('')
  })

  it('PIE 时把结论的适用范围写进正文', () => {
    const text = describeWorld({ world: 'pie', world_note: '停止运行就没了' })
    expect(text).toContain('正在跑的游戏世界')
    expect(text).toContain('停止运行就没了')
  })

  it('多客户端时点明结论只针对其中一个', () => {
    const text = describeWorld({ world: 'pie', play_world_count: 2 })
    expect(text).toContain('2 个游戏实例')
    expect(text).toContain('只针对其中一个')
  })

  it('单实例时不提实例数', () => {
    expect(describeWorld({ world: 'pie', play_world_count: 1 })).not.toContain('游戏实例')
  })
})
