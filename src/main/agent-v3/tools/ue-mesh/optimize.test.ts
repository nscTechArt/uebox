/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

// optimize.ts 经 defineUeTool 间接引入 services（会读 electron 的 app）；这里只测纯函数，桩掉就行
vi.mock('../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest: vi.fn(), getConnectionCount: () => 1 })
  }
}))
vi.mock('../../core/projectTargetContext', () => ({ getTargetConnectionId: () => 'conn-1' }))

import { OptimizeInput, summarizeOptimize, toOptimizeParams } from './optimize'
import type { MeshOptimizeResponse } from './types'

/**
 * 引擎那半边在 C++ 里，这里测的是能测的两头：
 * 参数怎么变成插件 payload，回执怎么变成模型读的那段话。
 *
 * 回执的规矩（AGENTS.md §5 第 14 条）：数字跟引擎走、不跟请求走；
 * 有一项没成，第一句就不许是成功，拒绝原因排在「之前 → 之后」前面。
 */

const parse = (input: unknown): ReturnType<typeof OptimizeInput.parse> => OptimizeInput.parse(input)

describe('参数 → 插件 payload', () => {
  it('只给 lods.count：其余字段不发，让插件用自己的默认值', () => {
    expect(toOptimizeParams(parse({ path: '/Game/SM_Rock', lods: { count: 4 } }))).toEqual({
      path: '/Game/SM_Rock',
      lods: { count: 4 }
    })
  })

  it('lods 和 collision 全给：原样透传，save=false 也要发出去', () => {
    const params = toOptimizeParams(
      parse({
        path: '/Game/SM_Wall',
        lods: { count: 3, reduction: [40, 15], keep_imported: true },
        collision: {
          type: 'convex',
          hull_count: 12,
          max_hull_verts: 24,
          hull_precision: 200_000,
          replace: true
        },
        save: false
      })
    )
    expect(params).toEqual({
      path: '/Game/SM_Wall',
      lods: { count: 3, reduction: [40, 15], keep_imported: true },
      collision: {
        type: 'convex',
        hull_count: 12,
        max_hull_verts: 24,
        hull_precision: 200_000,
        replace: true
      },
      save: false
    })
  })

  it('replace_imported 原样发给插件', () => {
    expect(
      toOptimizeParams(parse({ path: '/Game/SM_Wall', lods: { count: 4, replace_imported: true } }))
    ).toEqual({ path: '/Game/SM_Wall', lods: { count: 4, replace_imported: true } })
  })

  it('keep_imported 和 replace_imported 同时为 true：拒绝，并说明互斥', () => {
    const result = OptimizeInput.safeParse({
      path: '/Game/SM_Wall',
      lods: { count: 4, keep_imported: true, replace_imported: true }
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain('互斥')
  })

  it('其中一个显式为 false 不算冲突', () => {
    expect(
      OptimizeInput.safeParse({
        path: '/Game/SM_Wall',
        lods: { count: 4, keep_imported: false, replace_imported: true }
      }).success
    ).toBe(true)
  })

  it('只给 collision 时不带 lods 键', () => {
    const params = toOptimizeParams(
      parse({ path: '/Game/SM_Crate', collision: { type: 'box', replace: false } })
    )
    expect(params).toEqual({ path: '/Game/SM_Crate', collision: { type: 'box', replace: false } })
    expect(params).not.toHaveProperty('lods')
  })

  it.each([
    ['两项都没给', { path: '/Game/SM_Rock' }],
    ['count 超出 2–8', { path: '/Game/SM_Rock', lods: { count: 9 } }],
    ['count 只有 1 级', { path: '/Game/SM_Rock', lods: { count: 1 } }],
    [
      'reduction 长度不是 count-1',
      { path: '/Game/SM_Rock', lods: { count: 4, reduction: [50, 25] } }
    ],
    ['reduction 超过 100%', { path: '/Game/SM_Rock', lods: { count: 2, reduction: [120] } }],
    ['reduction 为 0', { path: '/Game/SM_Rock', lods: { count: 2, reduction: [0] } }],
    ['未知碰撞类型', { path: '/Game/SM_Rock', collision: { type: 'mesh' } }],
    ['凸包参数给了盒体', { path: '/Game/SM_Rock', collision: { type: 'box', hull_count: 8 } }],
    [
      '凸包数超出编辑器范围',
      { path: '/Game/SM_Rock', collision: { type: 'convex', hull_count: 65 } }
    ],
    ['顶点上限低于 6', { path: '/Game/SM_Rock', collision: { type: 'convex', max_hull_verts: 4 } }]
  ])('拒绝：%s', (_label, input) => {
    expect(OptimizeInput.safeParse(input).success).toBe(false)
  })
})

const lodsBefore = [{ index: 0, triangles: 12_000, source: 'imported' as const, screen_size: 1 }]

const success = (over: Partial<MeshOptimizeResponse> = {}): MeshOptimizeResponse => ({
  ok: true,
  path: '/Game/Props/SM_Rock.SM_Rock',
  name: 'SM_Rock',
  nanite: false,
  succeeded_count: 2,
  failed_count: 0,
  changed: true,
  saved: true,
  dirty: false,
  lods: {
    ok: true,
    requested_count: 3,
    auto_screen_size: true,
    before: lodsBefore,
    after: [
      { index: 0, triangles: 12_000, source: 'imported', screen_size: 1 },
      { index: 1, triangles: 6_010, source: 'generated', reduction_percent: 50, screen_size: 0.42 },
      { index: 2, triangles: 3_002, source: 'generated', reduction_percent: 25, screen_size: 0.18 }
    ]
  },
  collision: {
    ok: true,
    type: 'convex',
    replaced: true,
    before: {
      box: 1,
      sphere: 0,
      capsule: 0,
      convex: 0,
      total: 1,
      complexity: 'simple_and_complex'
    },
    after: { box: 0, sphere: 0, capsule: 0, convex: 4, total: 4, complexity: 'simple_and_complex' }
  },
  ...over
})

describe('回执 —— 全部成功', () => {
  it('第一句说两项都做完了，逐项给「之前 → 之后」', () => {
    const text = summarizeOptimize(success())
    const [first] = text.split('\n')
    expect(first).toContain('SM_Rock')
    expect(first).toContain('已完成')
    expect(first).not.toContain('⚠️')
    expect(text).toContain('LOD：1 级 [L0 12,000 面(导入)] → 3 级')
    expect(text).toContain('L1 6,010 面(生成 50%)')
    expect(text).toContain('碰撞（凸包分解，原有简单碰撞已删掉）：盒 1 → 凸包 4')
    expect(text).toContain('已存盘')
  })

  /*
   * 引擎读回来的值和请求不一样时，回执跟引擎走。
   * 这里请求的是 50% / 25%（默认链），引擎实际存的是 37.5% / 20%（比如被 LOD 组改写），
   * 面数也和「12,000 的一半」对不上 —— 回执里只能出现引擎的数。
   */
  it('数字跟引擎读回的走，不按请求推算', () => {
    const text = summarizeOptimize(
      success({
        lods: {
          ok: true,
          requested_count: 3,
          before: lodsBefore,
          after: [
            { index: 0, triangles: 12_000, source: 'imported' },
            { index: 1, triangles: 4_480, source: 'generated', reduction_percent: 37.5 },
            { index: 2, triangles: 2_391, source: 'generated', reduction_percent: 20 }
          ]
        }
      })
    )
    expect(text).toContain('L1 4,480 面(生成 37.5%)')
    expect(text).toContain('L2 2,391 面(生成 20%)')
    expect(text).not.toContain('6,000')
    expect(text).not.toContain('生成 50%')
  })

  it('生成的级面数没比上一级少：⚠️ 说这一级白加了', () => {
    const text = summarizeOptimize(
      success({
        lods: {
          ok: true,
          before: lodsBefore,
          after: [
            { index: 0, triangles: 12_000, source: 'imported' },
            { index: 1, triangles: 12_000, source: 'generated', reduction_percent: 50 }
          ]
        }
      })
    )
    expect(text).toMatch(/⚠️ L1 有 12,000 面，不比上一级/)
  })

  it('开着 Nanite 生成 LOD：说明这些 LOD 用在哪、L0 面数是回退网格的', () => {
    const text = summarizeOptimize(success({ nanite: true }))
    expect(text).toMatch(/⚠️ 网格开着 Nanite/)
    expect(text).toContain('回退网格')
  })

  it('复杂度是 complex_as_simple：⚠️ 简单碰撞不生效，并点名怎么改', () => {
    const response = success()
    response.collision!.after!.complexity = 'complex_as_simple'
    const text = summarizeOptimize(response)
    expect(text).toMatch(/⚠️ 碰撞复杂度是 complex_as_simple/)
    expect(text).toContain('ue_content_set_properties')
  })

  it('save=false：提示之后用 ue_save', () => {
    expect(summarizeOptimize(success({ saved: false }))).toContain('ue_save')
  })

  it('存盘失败：照实说没存上', () => {
    const text = summarizeOptimize(success({ saved: false, save_error: 'file read-only' }))
    expect(text).toContain('没存上：file read-only')
  })
})

describe('回执 —— 部分失败', () => {
  const partial = (): MeshOptimizeResponse =>
    success({
      succeeded_count: 1,
      failed_count: 1,
      lods: {
        ok: false,
        reason: 'refused: LOD1, LOD2 are imported (artist-made). Ask the user first.',
        before: [
          { index: 0, triangles: 12_000, source: 'imported' },
          { index: 1, triangles: 5_000, source: 'imported' },
          { index: 2, triangles: 2_000, source: 'imported' }
        ],
        after: [
          { index: 0, triangles: 12_000, source: 'imported' },
          { index: 1, triangles: 5_000, source: 'imported' },
          { index: 2, triangles: 2_000, source: 'imported' }
        ]
      }
    })

  it('第一句是「部分完成」，不是成功', () => {
    const [first] = summarizeOptimize(partial()).split('\n')
    expect(first).toBe('⚠️ 部分完成：1 项操作成功 / 1 项操作失败。')
  })

  it('拒绝原因排在任何「之前 → 之后」前面', () => {
    const text = summarizeOptimize(partial())
    const reason = text.indexOf('LOD1, LOD2 are imported')
    expect(reason).toBeGreaterThan(0)
    // 行首的那两行才是「之前 → 之后」；失败清单里的「- 生成 LOD：」不算
    expect(text.indexOf('\nLOD：')).toBeGreaterThan(0)
    expect(reason).toBeLessThan(text.indexOf('\nLOD：'))
    expect(reason).toBeLessThan(text.indexOf('\n碰撞（'))
  })

  it('被拒的那项仍给出现状（导入的级），成功的那项照常给前后', () => {
    const text = summarizeOptimize(partial())
    expect(text).toContain('L1 5,000 面(导入)')
    expect(text).toContain('盒 1 → 凸包 4')
  })
})

describe('回执 —— replace_imported', () => {
  it('点名被换掉的导入级', () => {
    const text = summarizeOptimize(
      success({
        lods: {
          ok: true,
          before: [
            { index: 0, triangles: 12_000, source: 'imported' },
            { index: 1, triangles: 5_000, source: 'imported' },
            { index: 2, triangles: 2_000, source: 'imported' }
          ],
          after: [
            { index: 0, triangles: 11_200, source: 'imported' },
            { index: 1, triangles: 5_590, source: 'generated', reduction_percent: 50 },
            { index: 2, triangles: 2_801, source: 'generated', reduction_percent: 25 }
          ],
          replaced_imported: [1, 2]
        }
      })
    )
    expect(text).toContain('导入的 L1、L2 已被生成的 LOD 换掉')
    expect(text).toContain('L1 5,590 面(生成 50%)')
  })
})

describe('回执 —— 全部失败', () => {
  it('抛错，原因在 message 里', () => {
    const response: MeshOptimizeResponse = {
      ok: false,
      path: '/Game/Props/SM_Rock.SM_Rock',
      succeeded_count: 0,
      failed_count: 1,
      changed: false,
      lods: {
        ok: false,
        reason: 'refused: LOD1 is imported',
        before: lodsBefore,
        after: lodsBefore
      }
    }
    expect(() => summarizeOptimize(response)).toThrow(/一项都没做成[\s\S]*LOD1 is imported/)
  })

  it('动了但没成（引擎少建了几级）：抛错里带上现状', () => {
    const response: MeshOptimizeResponse = {
      ok: false,
      path: '/Game/Props/SM_Rock.SM_Rock',
      succeeded_count: 0,
      failed_count: 1,
      changed: true,
      lods: {
        ok: false,
        reason: 'asked for 4 LODs but the engine built 2',
        before: lodsBefore,
        after: [
          { index: 0, triangles: 12_000, source: 'imported' },
          { index: 1, triangles: 6_000, source: 'generated', reduction_percent: 50 }
        ]
      }
    }
    expect(() => summarizeOptimize(response)).toThrow(/网格已经被改动过[\s\S]*2 级/)
  })
})
