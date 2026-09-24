import { describe, expect, it } from 'vitest'

import {
  formatInterruptedWrites,
  summarizeDoneWrites,
  WriteLedger,
  writeTarget
} from './writeLedger'

describe('writeTarget', () => {
  it('按优先级取点名的单个对象', () => {
    expect(writeTarget({ blueprint_path: '/Game/BP_A', name: 'Var' })).toBe('/Game/BP_A')
    expect(writeTarget({ path: '/Game/M_A' })).toBe('/Game/M_A')
  })

  it('认 UE 的批量寻址，多了只报数', () => {
    expect(writeTarget({ targets: { names: ['A', 'B'] } })).toBe('A、B')
    expect(writeTarget({ targets: { names: ['A', 'B', 'C', 'D'] } })).toBe('A、B、C 等 4 个')
  })

  it('认批量重定向的输出路径', () => {
    expect(writeTarget({ animations: [{ animation: '/Game/S', output_path: '/Game/T' }] })).toBe(
      '/Game/T'
    )
  })

  // 宁可少说，不编一个对象出来
  it('认不出就不给', () => {
    expect(writeTarget({ script: 'import unreal' })).toBeUndefined()
    expect(writeTarget(undefined)).toBeUndefined()
  })

  it('截断超长的对象描述', () => {
    expect(writeTarget({ path: 'x'.repeat(500) })!.length).toBeLessThanOrEqual(120)
  })
})

describe('WriteLedger', () => {
  it('失败的调用划掉，成功的转为已完成，计数只数已完成', () => {
    const ledger = new WriteLedger()
    ledger.start('a', 'ue_save', {})
    ledger.start('b', 'material_apply', { path: '/Game/M' })
    ledger.start('c', 'material_apply', { path: '/Game/M' })
    ledger.end('a', false)
    ledger.end('b', true)

    expect(ledger.counts()).toEqual({ material_apply: 1 })
    expect(ledger.list().map((e) => [e.tool, e.state])).toEqual([
      ['material_apply', 'done'],
      ['material_apply', 'in_flight']
    ])
  })

  it('同一工具的对象去重', () => {
    const ledger = new WriteLedger()
    for (const id of ['1', '2', '3']) {
      ledger.start(id, 'material_apply', { targets: { names: ['BossA'] } })
      ledger.end(id, true)
    }
    expect(summarizeDoneWrites(ledger.list())).toBe('material_apply ×3（BossA）')
  })
})

describe('formatInterruptedWrites', () => {
  it('没写过就直说没写过', () => {
    expect(formatInterruptedWrites([], false)).toContain('只调用过只读工具')
  })
})
