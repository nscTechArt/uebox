import { describe, expect, it } from 'vitest'

import {
  EMPTY_TURN_USAGE,
  hasTurnUsage,
  mergeTurnUsage,
  toTurnUsage,
  type AgentTurnUsage
} from './agentUsage'

describe('toTurnUsage', () => {
  it('把 pi 的用量收敛成本仓形状，total 自己算', () => {
    expect(
      toTurnUsage({
        input: 12_000,
        output: 480,
        cacheRead: 1024,
        cacheWrite: 96,
        cost: { total: 0.0031 }
      })
    ).toEqual({
      input: 12_000,
      output: 480,
      cacheRead: 1024,
      cacheWrite: 96,
      total: 13_600,
      cost: 0.0031
    })
  })

  // 厂商各自报什么字段不一样：有的不给缓存，有的不给价。
  // 缺字段按 0 处理，不能让 undefined 参与加法变成 NaN —— 界面上会显示 "NaN tokens"
  it('字段缺失或不是数字时按 0 算，不产生 NaN', () => {
    expect(toTurnUsage({ input: 100, output: Number.NaN })).toEqual({
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 100,
      cost: 0
    })
    expect(toTurnUsage(undefined)).toEqual(EMPTY_TURN_USAGE)
  })
})

describe('mergeTurnUsage', () => {
  it('逐项相加，不改动入参', () => {
    const a: AgentTurnUsage = {
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 1,
      total: 126,
      cost: 0.001
    }
    const b: AgentTurnUsage = {
      input: 200,
      output: 30,
      cacheRead: 0,
      cacheWrite: 2,
      total: 232,
      cost: 0.002
    }

    expect(mergeTurnUsage(a, b)).toEqual({
      input: 300,
      output: 50,
      cacheRead: 5,
      cacheWrite: 3,
      total: 358,
      cost: 0.003
    })
    expect(a.input).toBe(100)
  })
})

describe('hasTurnUsage', () => {
  it('全 0 视为没有用量 —— 显示「0 tokens」只会让人以为统计坏了', () => {
    expect(hasTurnUsage(EMPTY_TURN_USAGE)).toBe(false)
    expect(hasTurnUsage(undefined)).toBe(false)
  })

  it('只要有 token 或有费用就算有', () => {
    expect(hasTurnUsage({ ...EMPTY_TURN_USAGE, total: 12 })).toBe(true)
    expect(hasTurnUsage({ ...EMPTY_TURN_USAGE, cost: 0.0001 })).toBe(true)
  })
})
