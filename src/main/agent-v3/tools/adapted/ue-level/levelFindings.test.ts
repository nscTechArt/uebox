/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { classifyAsset, summarize, triangleShares } from './levelFindings'

describe('分类只用引擎算好的量、调用方给的门槛，和数据内部的比例', () => {
  it('缺碰撞是玩法问题，不是性能问题', () => {
    const [f] = classifyAsset({ missing_collision: true }, undefined)

    expect(f!.code).toBe('missing_collision')
    expect(f!.severity).toBe('breaks_gameplay')
  })

  it('高面数要同时满足：过了调用方的门槛、且没开 Nanite', () => {
    const stats = { triangles: 150_000, nanite: false }

    expect(classifyAsset(stats, undefined, 100_000)[0]!.code).toBe('high_triangles_no_nanite')
    // 开了 Nanite 就不是问题
    expect(classifyAsset({ ...stats, nanite: true }, undefined, 100_000)).toHaveLength(0)
    // 没到门槛不算
    expect(classifyAsset(stats, undefined, 200_000)).toHaveLength(0)
  })

  /**
   * 没有门槛就没有「高」。替调用方定义什么算高是越界 ——
   * 它没问，我们就不该报。
   */
  it('调用方没给门槛时不产出面数类结论', () => {
    expect(classifyAsset({ triangles: 5_000_000, nanite: false }, undefined)).toHaveLength(0)
  })

  it('大贴图按**面积**判，口径和 ue_content_audit_optimization 一致', () => {
    // 4096×2048 是门槛本身
    expect(
      classifyAsset({ max_texture_pixels: 4096 * 2048, max_texture_edge: 4096 }, undefined)[0]!.code
    ).toBe('large_texture')
    expect(classifyAsset({ max_texture_pixels: 2048 * 2048 }, undefined)).toHaveLength(0)
  })

  /**
   * 按单边判会把 4096×1 的分隔条报成「超大贴图」——
   * 它实际只有几 KB，而用户会去改它。
   */
  it('细长贴图不算超大贴图', () => {
    expect(
      classifyAsset({ max_texture_pixels: 4096, max_texture_edge: 4096 }, undefined)
    ).toHaveLength(0)
  })

  it('没有贴图数据时不猜', () => {
    expect(classifyAsset({ max_texture_pixels: undefined }, undefined)).toHaveLength(0)
  })
})

describe('占比结论：不需要外部阈值就能判轻重', () => {
  it('一个资产吃掉大半面数时点名它', () => {
    const [f] = classifyAsset(
      { triangles: 4000, total_triangles: 2_000_000, instance_count: 500 },
      undefined,
      undefined,
      0.63
    )

    expect(f!.code).toBe('dominates_level_triangles')
    expect(f!.evidence).toContain('500 份')
    expect(f!.evidence).toContain('63%')
  })

  it('只摆了一份的不报 —— 那说明关卡小，不说明这个资产有问题', () => {
    expect(
      classifyAsset({ triangles: 4000, instance_count: 1 }, undefined, undefined, 0.9)
    ).toHaveLength(0)
  })

  it('没传占比就不产出占比类结论', () => {
    expect(classifyAsset({ triangles: 4000, instance_count: 500 }, undefined)).toHaveLength(0)
  })
})

describe('引擎那句 suggestion 的去处', () => {
  it('一条都没认出来时原话留着 —— 丢掉等于丢信息', () => {
    const [f] = classifyAsset({}, 'Some new advice from a future plugin')

    expect(f!.code).toBe('engine_suggestion')
    expect(f!.evidence).toContain('future plugin')
  })

  it('已经认出来了就不重复 —— 同一件事说两遍像是两个问题', () => {
    const findings = classifyAsset({ missing_collision: true }, 'Missing collision. Add simple...')

    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('missing_collision')
  })
})

describe('面数占比', () => {
  /**
   * 分母是本次返回的这批资产，不是整张关卡 ——
   * 关卡里还有没进榜的东西，拿它们不存在的面数当分母只会把比例算虚。
   */
  it('用总面数算，不是单份面数', () => {
    const shares = triangleShares([
      { stats: { triangles: 100, total_triangles: 300 } },
      { stats: { triangles: 700, total_triangles: 700 } }
    ])

    expect(shares[0]).toBeCloseTo(0.3)
    expect(shares[1]).toBeCloseTo(0.7)
  })

  it('没有总面数时退回单份面数', () => {
    expect(triangleShares([{ stats: { triangles: 50 } }, { stats: { triangles: 50 } }])).toEqual([
      0.5, 0.5
    ])
  })

  it('一个面数都没有时全是 0，不是除零出 NaN', () => {
    expect(triangleShares([{ stats: {} }, {}])).toEqual([0, 0])
  })
})

describe('汇总', () => {
  it('按严重度归拢，给出先看哪几个', () => {
    const findings = [
      ...classifyAsset({ missing_collision: true }, undefined),
      ...classifyAsset({ max_texture_pixels: 8192 * 8192 }, undefined),
      ...classifyAsset({}, '随便一句话')
    ]

    expect(summarize(findings)).toEqual({
      breaks_gameplay: 1,
      costs_frame_time: 1,
      info: 1
    })
  })

  it('一条结论都没有时三档都是 0，不是缺字段', () => {
    expect(summarize([])).toEqual({ breaks_gameplay: 0, costs_frame_time: 0, info: 0 })
  })
})
