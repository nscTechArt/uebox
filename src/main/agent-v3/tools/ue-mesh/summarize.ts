/**
 * 把 `mesh.describe` 的响应压成给模型看的一段话。
 *
 * ## 为什么不直接把 JSON 丢给模型
 *
 * 一个网格的完整信息有五六十个字段。原样序列化模型要自己去比
 * 「lightmap.coordinate_index 是不是小于 lod0_uv_channels」才知道有没有问题 ——
 * 那是领域知识，属于工具的责任，不是模型该猜的。
 *
 * 所以这里把**判断**也一起给出：⚠️ 开头的行是「这个资产有问题」，
 * 不是「这里有个数字」。判断依据。
 *
 * 纯函数，没有 IO —— 这是这一层能被真正测试的原因。
 */

import type { MeshDescribeResponse, MeshLod } from './types'
import { formatMeters } from '../ueUnits'

/** 面数超过这个值还只有一级 LOD、且没开 Nanite，就值得提一句 */
const DENSE_LOD0_TRIANGLES = 20_000

/** 判「原点贴着这一端」「原点在正中」的容差：1 厘米或该轴长度的 2%，取大的那个 */
function tolerance(length: number): number {
  return Math.max(1, Math.abs(length) * 0.02)
}

/**
 * 一个轴上原点落在哪：贴着负端 / 贴着正端 / 居中 / 偏了多少。
 *
 * 这是**拼模块化套件的前提**，不是锦上添花。同一套废土素材里，地板常常是
 * 原点在角点向 +X/+Y 展开，墙和天花板却是居中的 —— 按同一个假设摆，
 * 天花板会悬在墙外面。真机上为了反推这件事绕了 8 次往返，
 * 而当时唯一能拿到角点的路是 ue_focus_viewport，那会把用户的镜头飞走。
 */
function describeAxisPivot(axis: string, min: number, max: number): string {
  const size = max - min
  const tol = tolerance(size)

  if (Math.abs(min) <= tol && max > tol) return `${axis} 贴负端（几何体向 +${axis} 展开）`
  if (Math.abs(max) <= tol && min < -tol) return `${axis} 贴正端（几何体向 -${axis} 展开）`
  if (Math.abs(min + max) <= tol) return `${axis} 居中`
  return `${axis} 偏移（min ${min.toFixed(1)} / max ${max.toFixed(1)}）`
}

/**
 * 原点相对几何体在哪。没有 min/max（老插件）就返回空串 —— 不猜。
 */
export function describePivot(bounds: MeshDescribeResponse['bounds']): string {
  const min = bounds?.min
  const max = bounds?.max
  if (!min || !max) return ''

  const axes = [
    describeAxisPivot('X', min.x, max.x),
    describeAxisPivot('Y', min.y, max.y),
    describeAxisPivot('Z', min.z, max.z)
  ]

  return (
    `原点（资产空间，厘米）：${axes.join('、')}\n` +
    `  角点 min (${min.x.toFixed(1)}, ${min.y.toFixed(1)}, ${min.z.toFixed(1)}) ` +
    `→ max (${max.x.toFixed(1)}, ${max.y.toFixed(1)}, ${max.z.toFixed(1)})。` +
    'spawn 时填的 location 就是原点的落点：Z 贴负端的网格放在 z=0 正好站在地面上，' +
    'Z 居中的要抬高半个高度。'
  )
}

function num(value: number | undefined): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : '?'
}

function round(value: number | undefined, digits = 2): string {
  return typeof value === 'number' ? value.toFixed(digits) : '?'
}

function describeLods(lods: MeshLod[]): string {
  const parts = lods.map((lod) => {
    const src = lod.source === 'imported' ? '导入' : lod.source === 'generated' ? '生成' : ''
    // 顶点数、分段数、UV 通道数都要印出来。它们进 details 只到宿主界面，
    // 模型看到的只有这段文本 —— 工具描述承诺了这些数据，不印等于没给。
    // 分段数尤其重要：那是这一级 LOD 的 draw call 数。
    const detail = [
      `${num(lod.triangles)} 面`,
      typeof lod.vertices === 'number' ? `${num(lod.vertices)} 顶点` : null,
      typeof lod.sections === 'number' ? `${lod.sections} 段` : null,
      typeof lod.uv_channels === 'number' ? `${lod.uv_channels}UV` : null
    ]
      .filter(Boolean)
      .join('/')
    return `L${lod.index}=${detail}${src ? `(${src})` : ''}`
  })
  const screens = lods
    .map((lod) => (typeof lod.screen_size === 'number' ? round(lod.screen_size) : null))
    .filter((s): s is string => s !== null)

  return (
    `LOD ${lods.length} 级：${parts.join(' / ')}` +
    (screens.length === lods.length ? `\n屏占比：${screens.join(' → ')}` : '')
  )
}

/**
 * 屏占比必须逐级递减。不递减意味着 LOD 切换会跳变或某一级永远不显示 ——
 * 这是配置错误，不是风格选择，所以报 ⚠️ 而不是陈述。
 */
function screenSizeIsMonotonic(lods: MeshLod[]): boolean {
  const sizes = lods.map((lod) => lod.screen_size).filter((s): s is number => typeof s === 'number')
  if (sizes.length < 2) return true
  return sizes.every((size, i) => i === 0 || size < sizes[i - 1])
}

function summarizeStatic(r: MeshDescribeResponse, warnings: string[]): string[] {
  const lines: string[] = []
  const lods = r.lods ?? []

  if (lods.length > 0) lines.push(describeLods(lods))

  const collision = r.collision
  if (collision) {
    lines.push(
      `碰撞：${collision.primitives ?? 0} 个图元` +
        (collision.convex_hulls ? `（凸包 ${collision.convex_hulls}）` : '') +
        `，复杂度 ${collision.complexity ?? '未知'}`
    )
    if (collision.has_any === false) {
      // 静默失败：引擎不报错，角色会直接走在整个物体上面。见设计文档 §4.1
      warnings.push(
        '没有任何碰撞。引擎不会为此报错 —— 症状是角色/射线直接穿过或走在整个包围盒上面。' +
          '常见根因是 FBX 里 UCX_ 命名没对上，或一个文件里多个网格时只有第一个的碰撞被导入。'
      )
    }
  }

  if (r.nanite) lines.push(`Nanite：${r.nanite.enabled ? '开' : '关'}`)

  const lm = r.lightmap
  if (lm) {
    lines.push(
      `光照贴图 UV：通道 ${lm.coordinate_index ?? '?'} / LOD0 共 ${lm.lod0_uv_channels ?? '?'} 通道` +
        (lm.index_valid === false ? ' ✗' : '')
    )
    if (lm.index_valid === false) {
      warnings.push(
        `光照贴图通道索引 ${lm.coordinate_index} 指向不存在的 UV 通道` +
          `（LOD0 只有 ${lm.lod0_uv_channels} 个）。烘焙光照会报 overlapping UV 或直接出错。` +
          '注意：提高光照贴图分辨率修不好这个，那只影响渗色。'
      )
    }
  }

  const lod0 = lods[0]
  if (
    lods.length === 1 &&
    typeof lod0?.triangles === 'number' &&
    lod0.triangles > DENSE_LOD0_TRIANGLES &&
    r.nanite?.enabled === false
  ) {
    // 只陈述事实，不下「应该开 Nanite」的结论 —— 社区有实证反对无脑开启。见设计文档 §4.4
    warnings.push(
      `只有一级 LOD，${num(lod0.triangles)} 面，且 Nanite 未开启。` +
        '这不一定是问题（取决于实例数、材质复杂度和目标平台），但远处渲染没有任何降级。'
    )
  }

  return lines
}

function summarizeSkeletal(r: MeshDescribeResponse, warnings: string[]): string[] {
  const lines: string[] = []
  const lods = r.lods ?? []

  if (lods.length > 0) lines.push(describeLods(lods))
  if (r.skeleton) lines.push(`骨架：${r.skeleton}`)

  if (r.bones) {
    lines.push(
      `骨骼：${r.bones.count ?? '?'} 根` +
        (r.bones.root ? `，根 ${r.bones.root}` : '') +
        (typeof r.bones.max_depth === 'number' ? `，最深 ${r.bones.max_depth} 层` : '')
    )
  }

  // 朝向要进正文，不能只留在原始返回里 —— 「这个角色哪边是脸」是摆放的第一步，
  // 拿不到就只能截图目测，而 T-pose 和运行时姿势不一样，目测会判错
  if (r.facing?.known) {
    const offset = r.facing.yaw_offset ?? 0
    lines.push(
      `朝向：正面偏离网格 +X 轴 ${offset.toFixed(1)}°（依据 ${r.facing.from_bones} 两根骨骼）。` +
        `要让他朝某个世界方向走，Actor 的 yaw 填「方向角 ${offset >= 0 ? '−' : '+'} ${Math.abs(offset).toFixed(1)}」`
    )
  } else if (r.facing) {
    lines.push(
      `朝向：认不出来（${r.facing.reason ?? '骨骼名字不是常见人形命名'}），只能靠正前方机位截图看`
    )
  }

  lines.push(`物理资产：${r.has_physics_asset ? r.physics_asset : '无'}`)
  if (r.has_physics_asset === false) {
    // 同样是静默失败。见设计文档 §4.5
    warnings.push(
      '没有物理资产。布娃娃、逐骨骼命中检测、准确包围盒都不会工作，而引擎不报错，' +
        '表现是「没反应」。注意 Per Poly Collision 不能替代它 —— 那个不能用于模拟。'
    )
  }

  const morphs = r.morph_targets ?? []
  if (morphs.length > 0) {
    const shown = morphs.slice(0, 8)
    lines.push(
      `Morph Target ${morphs.length} 个：${shown.join('、')}` +
        (morphs.length > shown.length ? ` …（还有 ${morphs.length - shown.length} 个）` : '')
    )
  }

  return lines
}

export function summarizeMesh(r: MeshDescribeResponse): string {
  const warnings: string[] = []
  const head = `${r.path ?? r.name ?? '(未知路径)'}（${
    r.type === 'skeletal' ? '骨骼网格' : r.type === 'static' ? '静态网格' : '未知类型'
  }）`

  const body = r.type === 'skeletal' ? summarizeSkeletal(r, warnings) : summarizeStatic(r, warnings)

  const slots = r.material_slots ?? []
  if (slots.length > 0) {
    // 槽名之外必须带上材质资产路径 —— 只给槽名的话，
    // 「这个网格现在挂的是什么材质」这个最常见的问题工具答不上来。
    // 空槽单独标出来：那是网格显示成默认灰的直接原因。
    const names = slots.map((s) => {
      const slot = s.slot_name || `#${s.index}`
      return s.material ? `${slot}→${s.material}` : `${slot}→(空)`
    })
    body.push(`材质槽 ${slots.length} 个：${names.join('、')}`)
  }

  const sockets = r.sockets ?? []
  if (sockets.length > 0) {
    const names = sockets.map((s) => (s.bone ? `${s.name}@${s.bone}` : s.name)).filter(Boolean)
    body.push(`Socket ${sockets.length} 个：${names.join('、')}`)
  }

  const pivot = describePivot(r.bounds)
  if (pivot) body.push(pivot)

  const size = r.bounds?.size
  if (size) {
    // 量纲必须写出来。这个数一直是对的（厘米），但报成裸数字时，
    // 调用方拿它去和同样裸着的 Actor 坐标对照，两边都读成米也「自洽」——
    // 100 倍缩放事故就是这么躲过好几轮自检的（见 tools/ueUnits.ts 文件头）
    body.push(
      `包围盒（asset 资产空间）：${round(size.x, 1)} × ${round(size.y, 1)} × ${round(size.z, 1)} 厘米` +
        `（${formatMeters(size)}）`
    )
  }

  const lods = r.lods ?? []
  if (lods.length > 1 && !screenSizeIsMonotonic(lods)) {
    warnings.push('LOD 屏占比不是逐级递减的。这会导致切换跳变，或某一级永远不显示 —— 是配置错误。')
  }

  return [head, ...body, ...warnings.map((w) => `\n⚠️ ${w}`)].join('\n')
}
