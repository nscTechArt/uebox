/**
 * 关卡资产体检结论 → 可测的分类。
 *
 * ## 为什么不直接用插件回的那句 suggestion
 *
 * 插件曾经每个资产回一句现成的话
 * （"Missing collision. Add simple collision or enable complex-as-simple."）。
 * 那是**建议**不是数据，而且是一段没有结构的散文：判不了轻重、统计不了、
 * 换个引擎版本措辞变了就全对不上。
 *
 * Sequencer 那边（`ue-sequencer/findings.ts`）早就走通了另一条路：判断可以放进工具，
 * 但**必须先固化成能穷举测的分类** —— 稳定的 `code` 加一个分档的严重度。
 * 这个文件是同一件事在关卡资产上的版本。
 *
 * ## 阈值从哪来
 *
 * 这里**不发明新阈值**。分类只用三种依据：
 *   1. 引擎已经算好的布尔量（`missing_collision`、`nanite`）；
 *   2. 调用方自己传进来的门槛（`conditions.min_triangles`）——
 *      它问的就是「超过这个数的给我」，那超过就是它要的发现；
 *   3. **数据内部的相对关系**（这个资产占了本次统计面数的百分之多少）——
 *      占比不需要任何外部阈值就能判轻重，"一个资产吃掉六成面数"
 *      本身就是结论。
 *
 * 唯一一个写死的数是贴图 4096×2048，理由是它跟 `ue_content_audit_optimization`
 * 判「大贴图」的口径一致 —— 两个工具对同一件事给不同答案比给错答案更难查。
 * 注意是**面积**不是单边：4096×1 的分隔条按单边算会被报成超大贴图。
 */

/** 大贴图门槛（像素总数）。与 ue_content_audit_optimization 的口径保持一致 */
const LARGE_TEXTURE_PIXELS = 4096 * 2048

/**
 * 「一个资产吃掉了大半个关卡」的门槛。
 *
 * 不是性能阈值，是**注意力分配**的阈值：占比过半意味着先改它的收益
 * 大于改其余全部之和。这个判断只用本次统计内部的比例，
 * 不依赖任何关于「多少面算多」的外部假设。
 */
const DOMINANT_SHARE = 0.5

export type LevelFindingCode =
  | 'missing_collision'
  | 'high_triangles_no_nanite'
  | 'large_texture'
  | 'dominates_level_triangles'
  | 'engine_suggestion'

export type LevelFindingSeverity =
  /** 玩法会坏：玩家会穿过去、会掉下去。和快不快无关 */
  | 'breaks_gameplay'
  /** 每帧都在付的开销 */
  | 'costs_frame_time'
  /** 只是信息，不一定要改 */
  | 'info'

export interface LevelFinding {
  code: LevelFindingCode
  severity: LevelFindingSeverity
  /** 具体到数字或名字，越具体越好 */
  evidence: string
}

export interface AssetStats {
  /** LOD0 面数，**单份** */
  triangles?: number
  /** 单份面数 × 实例数 —— 这个资产在关卡里真正贡献的面数 */
  total_triangles?: number
  /** 实际画出来多少份（实例化组件按实例数算） */
  instance_count?: number
  nanite?: boolean
  missing_collision?: boolean
  /** 这个网格用到的最大那张贴图的像素总数 */
  max_texture_pixels?: number
  /** 同上，长边。用来把结论说得具体 */
  max_texture_edge?: number
  [key: string]: unknown
}

/**
 * 把一个资产的统计量翻成结论。
 *
 * @param minTriangles 调用方这次问的面数门槛。没传就不产出面数类结论 ——
 *        没有门槛就没有「高」，替调用方定义什么算高是越界。
 * @param triangleShare 这个资产占本次统计总面数的比例（0–1）。
 *        调用方算好了传进来；不传就不产出占比类结论。
 */
export function classifyAsset(
  stats: AssetStats | undefined,
  suggestion: string | undefined,
  minTriangles?: number,
  triangleShare?: number
): LevelFinding[] {
  const findings: LevelFinding[] = []
  const s = stats ?? {}

  if (s.missing_collision === true) {
    findings.push({
      code: 'missing_collision',
      severity: 'breaks_gameplay',
      evidence: '没有碰撞体：玩家和物理对象会直接穿过去'
    })
  }

  if (
    typeof s.triangles === 'number' &&
    typeof minTriangles === 'number' &&
    s.triangles >= minTriangles &&
    s.nanite === false
  ) {
    findings.push({
      code: 'high_triangles_no_nanite',
      severity: 'costs_frame_time',
      evidence: `${s.triangles} 个三角形且没开 Nanite（你问的门槛是 ${minTriangles}）`
    })
  }

  // 占比是本次统计内部的比例，不需要外部阈值。
  // 只有在真的摆了不止一份时才说 —— 一份的资产占比高只说明关卡小。
  if (
    typeof triangleShare === 'number' &&
    triangleShare >= DOMINANT_SHARE &&
    typeof s.instance_count === 'number' &&
    s.instance_count > 1
  ) {
    const percent = Math.round(triangleShare * 100)
    findings.push({
      code: 'dominates_level_triangles',
      severity: 'costs_frame_time',
      evidence:
        `摆了 ${s.instance_count} 份，占本次统计总面数的 ${percent}%` +
        (typeof s.triangles === 'number' ? `（单份 ${s.triangles} 面）` : '')
    })
  }

  if (typeof s.max_texture_pixels === 'number' && s.max_texture_pixels >= LARGE_TEXTURE_PIXELS) {
    findings.push({
      code: 'large_texture',
      severity: 'costs_frame_time',
      evidence: `用到了超大贴图，最大一张长边 ${s.max_texture_edge ?? '?'}`
    })
  }

  // 引擎给了话、但我们一条都没认出来时，把原话留着 —— 丢掉它等于丢信息。
  // 认出来了就不重复：同一件事说两遍会让调用方以为是两个问题。
  if (suggestion && findings.length === 0) {
    findings.push({ code: 'engine_suggestion', severity: 'info', evidence: suggestion })
  }

  return findings
}

/** 按严重度归拢，给调用方一个「先看哪几个」的入口 */
export function summarize(all: LevelFinding[]): Record<LevelFindingSeverity, number> {
  const counts: Record<LevelFindingSeverity, number> = {
    breaks_gameplay: 0,
    costs_frame_time: 0,
    info: 0
  }
  for (const f of all) counts[f.severity]++
  return counts
}

/**
 * 每个资产占总面数的比例。
 *
 * 分母是**本次返回的这批资产**的总面数，不是整张关卡 —— 关卡里还有没进榜的
 * 东西（灯光、骨骼网格），拿它们不存在的面数当分母只会把比例算虚。
 * 结论里也要照这个口径说：「占本次统计总面数的 63%」。
 */
export function triangleShares(assets: { stats?: AssetStats }[]): number[] {
  const totals = assets.map((a) => {
    const stats = a.stats ?? {}
    if (typeof stats.total_triangles === 'number') return stats.total_triangles
    return typeof stats.triangles === 'number' ? stats.triangles : 0
  })
  const sum = totals.reduce((acc, n) => acc + n, 0)
  if (sum <= 0) return totals.map(() => 0)
  return totals.map((n) => n / sum)
}
