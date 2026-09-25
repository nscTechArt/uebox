/**
 * 地形 RVT 体检：五件事对不上哪一件。
 *
 * ## 为什么要单独做
 *
 * RVT 要五件事同时成立才有效果，少任何一件引擎都**不报错**，只是黑一块或者没效果：
 *
 *   1. 项目设置开了虚拟纹理（`r.VirtualTextures`，改了要重启编辑器）
 *   2. 有 RVT 资产（颜色或高度）
 *   3. 地形（World Partition 下是每一块流送代理）声明往这张 RVT 里画
 *   4. 场景里有 RVT 体积，罩住整块地形（高度 RVT 还要罩住全部高度）
 *   5. 地形材质里有 Runtime Virtual Texture Output 节点，对应引脚接上了
 *
 * 插件只回原始事实（`landscape.list` 的 `rvt` 字段），判断放在这里 —— 纯函数，
 * 能单测，改判据不用重编插件。
 */

import type { LandscapeInfo, LevelFacts, RvtAssignment, RvtKind } from './types'

export interface RvtDiagnosis {
  kind: RvtKind
  /** 挂着的是哪张 RVT；地形根本没挂这一类时为空 */
  asset?: string
  /** 空数组 = 五件事都对上了 */
  problems: string[]
}

const KIND_NAME: Record<RvtKind, string> = { color: '颜色', height: '高度' }

export const PROJECT_VT_OFF =
  '项目没开虚拟纹理支持：项目设置 → 引擎 → 渲染 → Virtual Textures → 勾上 Enable virtual texture support，' +
  '改完必须重启编辑器才生效。这是整个项目的设置，要不要改让用户决定'

function materialProblems(land: LandscapeInfo, kind: RvtKind): string[] {
  const output = land.rvt?.material_output
  if (!output) return []
  if (output.searched === 'no_material') {
    return ['地形没挂材质，没有东西写进 RVT']
  }
  if (!output.found) {
    return [
      `地形材质 ${output.material} 里没找到 Runtime Virtual Texture Output 节点` +
        `（搜了材质图和 ${output.functions_searched ?? 0} 个材质函数，材质图层里的没搜），RVT 会是空的。` +
        '用材质工具在材质里加这个节点并接上引脚'
    ]
  }
  const pins = output.pins
  if (!pins) return []
  if (kind === 'color' && !pins.base_color) {
    return ['材质里的 Runtime Virtual Texture Output 节点 BaseColor 引脚没接，颜色 RVT 会是空的']
  }
  if (kind === 'height' && !pins.world_height) {
    return [
      '材质里的 Runtime Virtual Texture Output 节点 WorldHeight 引脚没接（通常接 Absolute World Position 的 Z），高度 RVT 会是空的'
    ]
  }
  return []
}

function assignmentProblems(a: RvtAssignment): string[] {
  const problems: string[] = []
  if (a.proxies_total === 0) {
    problems.push('地形没有已加载的地形块，没法确认它往这张 RVT 里画')
  } else if (a.proxies_with < a.proxies_total) {
    problems.push(`只有 ${a.proxies_with}/${a.proxies_total} 块地形往这张 RVT 里画，其余区域是空的`)
  }
  if (a.volumes.length === 0) {
    problems.push('场景里没有指向这张 RVT 的 RVT 体积，RVT 是空的')
  } else {
    if (!a.volumes.some((v) => v.covers_xy)) {
      problems.push('RVT 体积没罩住整块地形，罩不到的地方会发黑')
    }
    if (a.kind === 'height' && !a.volumes.some((v) => v.covers_z)) {
      problems.push('RVT 体积没罩住地形的全部高度，超出去的高度会被截断')
    }
  }
  return problems
}

/**
 * @param kinds 要检查哪几类。省略时只查地形上已经挂着的那几类 ——
 *              没挂 RVT 不是毛病，只有用户要它的时候才算缺
 */
export function diagnoseRvt(
  level: Pick<LevelFacts, 'project_virtual_texturing'>,
  land: LandscapeInfo,
  kinds?: readonly RvtKind[]
): RvtDiagnosis[] {
  const assigned = land.rvt?.assigned ?? []
  const wanted: RvtKind[] = kinds
    ? [...kinds]
    : (['color', 'height'] as const).filter((k) => assigned.some((a) => a.kind === k))

  const projectProblems = level.project_virtual_texturing ? [] : [PROJECT_VT_OFF]
  const result: RvtDiagnosis[] = []
  for (const kind of wanted) {
    const ofKind = assigned.filter((a) => a.kind === kind)
    if (ofKind.length === 0) {
      result.push({
        kind,
        problems: [...projectProblems, `地形没往任何${KIND_NAME[kind]} RVT 里画`]
      })
      continue
    }
    for (const a of ofKind) {
      result.push({
        kind,
        asset: a.asset,
        problems: [...projectProblems, ...assignmentProblems(a), ...materialProblems(land, kind)]
      })
    }
  }
  return result
}

/** 一段给模型看的体检结论。没有要查的就返回空串 */
export function describeRvtDiagnoses(diagnoses: readonly RvtDiagnosis[]): string {
  return diagnoses
    .map((d) => {
      const head = `${KIND_NAME[d.kind]} RVT${d.asset ? ` ${d.asset}` : ''}`
      if (d.problems.length === 0) return `✅ ${head}：五项都对上了`
      return `⚠️ ${head}：\n${d.problems.map((p) => `  - ${p}`).join('\n')}`
    })
    .join('\n')
}
