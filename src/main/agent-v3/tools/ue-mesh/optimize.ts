/**
 * mesh_optimize —— 给静态网格生成 LOD 和简单碰撞。
 *
 * 以前技能让模型写 Python：`StaticMeshEditorSubsystem.set_lods`（会把导入的 LOD 一并丢掉）、
 * `set_convex_decomposition_collisions`。引擎侧现在是 `UAL_MeshCommands.cpp` 的 `mesh.optimize`：
 * LOD 走和 SetLods 同一条构建路（改 SourceModel 的 ReductionSettings → PostEditChange），
 * 碰撞走网格编辑器 Collision 菜单背后的 `UStaticMeshEditorSubsystem`。
 *
 * 回执的 before / after 都是引擎重建完之后读回来的（AGENTS.md §5 第 14 条）；
 * 有一项没成，第一句就是「部分完成」，拒绝原因排在数字前面。
 */

import { z } from 'zod'

import { defineUeTool } from '../defineUeTool'
import { describeFailures, partialHeadline, type PartialFailure } from '../partialResult'
import type {
  MeshCollisionFacts,
  MeshOptimizeCollisionResult,
  MeshOptimizeLod,
  MeshOptimizeLodsResult,
  MeshOptimizeResponse
} from './types'

/** 与 index.ts 同一个命名空间（用户可见的分类）；加载粒度另在 toolSearch.ts 里拆 */
const NAMESPACE = 'ue.mesh'

/** 网格编辑器「Auto Convex Collision」面板的范围（StaticMeshEditorTools.cpp，5.0 与 5.8 一致） */
const HULL_COUNT = { min: 1, max: 64 }
const HULL_VERTS = { min: 6, max: 32 }
const HULL_PRECISION = { min: 10_000, max: 1_000_000 }

const LodsInput = z.object({
  count: z.number().int().min(2).max(8).describe('做完后的 LOD 总级数，含 LOD0（2–8）'),
  reduction: z
    .array(z.number().positive().max(100))
    .optional()
    .describe(
      'LOD1 起每级保留 LOD0 面数的百分比，长度 = count-1，如 [50, 25, 12.5]。' +
        '省略时逐级减半（50、25、12.5…，引擎自带 LOD 组就是这么配的）'
    ),
  keep_imported: z
    .boolean()
    .optional()
    .describe(
      '网格已有导入的 LOD（美术做的）时：true = 保留它们，只在后面追加生成的级。' +
        '不给时这一项会被拒绝 —— 先问用户'
    ),
  replace_imported: z
    .boolean()
    .optional()
    .describe(
      '用生成的 LOD 换掉导入的 LOD（LOD1 起全部重建，导入的级删掉、回不来）。' +
        '只有用户明确同意才用，比如布尔挖洞之后导入的 LOD 还是旧几何。和 keep_imported 互斥'
    )
})

const CollisionInput = z.object({
  type: z
    .enum(['box', 'sphere', 'capsule', 'convex'])
    .describe('box / sphere / capsule 拟合一个包住整个网格的形状；convex 是凸包分解，凹的物体用它'),
  hull_count: z
    .number()
    .int()
    .min(HULL_COUNT.min)
    .max(HULL_COUNT.max)
    .optional()
    .describe('仅 convex：凸包个数，默认 4。门洞、拱这类凹处被封住就加大'),
  max_hull_verts: z
    .number()
    .int()
    .min(HULL_VERTS.min)
    .max(HULL_VERTS.max)
    .optional()
    .describe('仅 convex：每个凸包的顶点上限，默认 16'),
  hull_precision: z
    .number()
    .int()
    .min(HULL_PRECISION.min)
    .max(HULL_PRECISION.max)
    .optional()
    .describe('仅 convex：体素精度，默认 100000；越大越贴合、越慢'),
  replace: z
    .boolean()
    .optional()
    .describe(
      '默认 true：先删掉现有的全部简单碰撞（包括 FBX 带进来的 UCX）再生成。' +
        'false 为追加；convex 是引擎整体替换，网格已有简单碰撞时不能追加'
    )
})

export const OptimizeInput = z
  .object({
    path: z.string().min(1).describe('静态网格资产路径，如 /Game/Props/SM_Rock'),
    lods: LodsInput.optional().describe('生成 LOD。LOD0 原样保留'),
    collision: CollisionInput.optional().describe('生成简单碰撞'),
    save: z.boolean().optional().describe('做完立刻存盘，默认 true')
  })
  .superRefine((args, ctx) => {
    if (!args.lods && !args.collision) {
      ctx.addIssue({ code: 'custom', message: 'lods 和 collision 至少给一项' })
    }
    if (args.lods?.keep_imported && args.lods.replace_imported) {
      ctx.addIssue({
        code: 'custom',
        path: ['lods'],
        message: 'keep_imported 和 replace_imported 互斥：要么保留导入的 LOD，要么换掉，只能选一个'
      })
    }
    const reduction = args.lods?.reduction
    if (args.lods && reduction && reduction.length !== args.lods.count - 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['lods', 'reduction'],
        message: `reduction 要 count-1 = ${args.lods.count - 1} 项（LOD1 起每级一项），给了 ${reduction.length} 项`
      })
    }
    const collision = args.collision
    if (
      collision &&
      collision.type !== 'convex' &&
      (collision.hull_count !== undefined ||
        collision.max_hull_verts !== undefined ||
        collision.hull_precision !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['collision'],
        message: `hull_count / max_hull_verts / hull_precision 只对 convex 有用，${collision.type} 不吃这几个参数`
      })
    }
  })

export type OptimizeArgs = z.infer<typeof OptimizeInput>

/** LOD 重建、凸包分解在大网格上都要几分钟；编辑器在这期间是卡住的 */
const OPTIMIZE_TIMEOUT_MS = 10 * 60 * 1000

/** Zod 解析后的参数 → 插件 payload。没给的字段不发，让插件用它自己的默认值 */
export function toOptimizeParams(args: OptimizeArgs): Record<string, unknown> {
  const params: Record<string, unknown> = { path: args.path }
  if (args.lods) {
    params.lods = {
      count: args.lods.count,
      ...(args.lods.reduction ? { reduction: args.lods.reduction } : {}),
      ...(args.lods.keep_imported !== undefined ? { keep_imported: args.lods.keep_imported } : {}),
      ...(args.lods.replace_imported !== undefined
        ? { replace_imported: args.lods.replace_imported }
        : {})
    }
  }
  if (args.collision) {
    const c = args.collision
    params.collision = {
      type: c.type,
      ...(c.hull_count !== undefined ? { hull_count: c.hull_count } : {}),
      ...(c.max_hull_verts !== undefined ? { max_hull_verts: c.max_hull_verts } : {}),
      ...(c.hull_precision !== undefined ? { hull_precision: c.hull_precision } : {}),
      ...(c.replace !== undefined ? { replace: c.replace } : {})
    }
  }
  if (args.save !== undefined) params.save = args.save
  return params
}

// ────────────────────────────────────────────────────────────────────────────
// 回执
// ────────────────────────────────────────────────────────────────────────────

const COLLISION_LABEL: Record<string, string> = {
  box: '盒体',
  sphere: '球体',
  capsule: '胶囊体',
  convex: '凸包分解'
}

function num(value: number | undefined): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : '?'
}

function percent(value: number): string {
  // 12.5 → 12.5，50.0000001 → 50
  return `${Number(value.toFixed(2))}%`
}

function meshLabel(r: MeshOptimizeResponse): string {
  const path = r.path ?? ''
  return path.split('/').pop()?.split('.')[0] || r.name || path || '(未知网格)'
}

function lodList(lods: MeshOptimizeLod[] | undefined): string {
  if (!lods || lods.length === 0) return '0 级'
  const parts = lods.map((lod) => {
    const tag =
      lod.source === 'imported'
        ? '导入'
        : lod.source === 'generated'
          ? `生成${typeof lod.reduction_percent === 'number' ? ` ${percent(lod.reduction_percent)}` : ''}`
          : ''
    return `L${lod.index} ${num(lod.triangles)} 面${tag ? `(${tag})` : ''}`
  })
  return `${lods.length} 级 [${parts.join(' / ')}]`
}

function collisionList(facts: MeshCollisionFacts | undefined): string {
  if (!facts) return '?'
  const counted: [string, number | undefined][] = [
    ['盒', facts.box],
    ['球', facts.sphere],
    ['胶囊', facts.capsule],
    ['凸包', facts.convex]
  ]
  const parts = counted.filter(([, n]) => (n ?? 0) > 0).map(([name, n]) => `${name} ${n}`)
  // 锥形胶囊、水平集这些不单列，但总数里有，差额照实报
  const other = (facts.total ?? 0) - counted.reduce((sum, [, n]) => sum + (n ?? 0), 0)
  if (other > 0) parts.push(`其他 ${other}`)
  return parts.length > 0 ? parts.join('、') : '无简单碰撞'
}

/** 生成的级里面数没比上一级少 —— 减面没生效或已到极限，引擎不会为此报错 */
function lodWarnings(result: MeshOptimizeLodsResult): string[] {
  const after = result.after ?? []
  const warnings: string[] = []
  for (let i = 1; i < after.length; i++) {
    const lod = after[i]
    const prev = after[i - 1]
    if (lod.source !== 'generated') continue
    if (typeof lod.triangles !== 'number' || typeof prev.triangles !== 'number') continue
    if (lod.triangles >= prev.triangles) {
      warnings.push(
        `L${lod.index} 有 ${num(lod.triangles)} 面，不比上一级（${num(prev.triangles)}）少：` +
          '这一级等于白加。可能是比例给大了、网格已经简单到减不动，或者减面模块没加载（看输出日志）。'
      )
    }
  }
  return warnings
}

function describeLodsOp(result: MeshOptimizeLodsResult): string[] {
  const lines = [`LOD：${lodList(result.before)} → ${lodList(result.after)}`]
  if (result.kept_imported && result.kept_imported > 1) {
    lines.push(`  导入的 L0–L${result.kept_imported - 1} 原样保留，只在后面追加了生成的级。`)
  }
  if (result.replaced_imported && result.replaced_imported.length > 0) {
    const names = result.replaced_imported.map((index) => `L${index}`).join('、')
    lines.push(`  导入的 ${names} 已被生成的 LOD 换掉（原来那几级删了，撤销之外找不回来）。`)
  }
  const screens = (result.after ?? [])
    .map((lod) => lod.screen_size)
    .filter((s): s is number => typeof s === 'number')
  if (result.ok && screens.length > 1) {
    lines.push(
      `  屏占比：${screens.map((s) => s.toFixed(2)).join(' → ')}` +
        (result.auto_screen_size === false
          ? '（自动屏占比关着，新级按上一级减半）'
          : '（引擎自动计算）')
    )
  }
  return lines
}

function describeCollisionOp(result: MeshOptimizeCollisionResult): string {
  const label = result.type ? (COLLISION_LABEL[result.type] ?? result.type) : '碰撞'
  const replaced = result.replaced ? '，原有简单碰撞已删掉' : ''
  const complexity = result.after?.complexity ?? result.before?.complexity
  return (
    `碰撞（${label}${replaced}）：${collisionList(result.before)} → ${collisionList(result.after)}` +
    (complexity ? `（复杂度 ${complexity}）` : '')
  )
}

function describeSave(r: MeshOptimizeResponse): string {
  if (!r.changed) return '网格没有被改动，未存盘。'
  if (r.saved) return '已存盘。'
  if (r.save_error) return `没存上：${r.save_error}`
  return '未存盘（save=false），完事用 ue_save 保存。'
}

interface Op {
  label: string
  ok: boolean
  reason?: string
  body: string[]
}

function operations(r: MeshOptimizeResponse): Op[] {
  const ops: Op[] = []
  if (r.lods) {
    ops.push({
      label: '生成 LOD',
      ok: r.lods.ok,
      reason: r.lods.reason,
      body: describeLodsOp(r.lods)
    })
  }
  if (r.collision) {
    ops.push({
      label: `生成碰撞${r.collision.type ? `（${COLLISION_LABEL[r.collision.type] ?? r.collision.type}）` : ''}`,
      ok: r.collision.ok,
      reason: r.collision.reason,
      body: [describeCollisionOp(r.collision)]
    })
  }
  return ops
}

function warningsOf(r: MeshOptimizeResponse): string[] {
  const warnings: string[] = []
  if (r.lods?.ok) {
    warnings.push(...lodWarnings(r.lods))
    if (r.lods.nanite || r.nanite) {
      warnings.push(
        '网格开着 Nanite：这些 LOD 只在不走 Nanite 的地方用（不支持 Nanite 的平台、回退网格）。' +
          'L0 的面数是 Nanite 回退网格的面数，不是源模型的。'
      )
    }
  }
  if (r.collision?.ok && r.collision.after?.complexity === 'complex_as_simple') {
    warnings.push(
      '碰撞复杂度是 complex_as_simple：刚生成的简单碰撞不参与碰撞查询，角色还是按逐面碰撞走。' +
        '要它生效，用 ue_content_set_properties 把 BodySetup.CollisionTraceFlag 改成 CTF_UseDefault。'
    )
  }
  return warnings
}

/**
 * 给模型看的回执。顺序是钉死的：
 * 第一句（有失败就是「部分完成」）→ 失败/拒绝原因 → 每项「之前 → 之后」→ ⚠️ → 存盘。
 * 全部失败时抛错 —— 插件那边已经回 ok:false 被 defineUeTool 拦下，这里兜底。
 */
export function summarizeOptimize(r: MeshOptimizeResponse): string {
  const ops = operations(r)
  const succeeded = ops.filter((op) => op.ok)
  const failed = ops.filter((op) => !op.ok)
  const failures: PartialFailure[] = failed.map((op) => ({ item: op.label, reason: op.reason }))

  if (succeeded.length === 0) {
    const reasons = describeFailures(failures, '原因')
    // 拒绝之外也可能是「动了但没成」（比如引擎只建出 2 级）。那时网格已经变了，现状要说出来
    const state = r.changed
      ? `\n网格已经被改动过，现状：\n${ops.flatMap((op) => op.body).join('\n')}`
      : ''
    throw new Error(
      `${meshLabel(r)}：${ops.length} 项操作一项都没做成。${reasons ? `\n${reasons}` : ''}${state}`
    )
  }

  const headline =
    partialHeadline({ succeeded: succeeded.length, failed: failed.length, unit: '项操作' }) ||
    `${meshLabel(r)}：${succeeded.map((op) => op.label).join('、')}已完成。`

  const lines = [headline]
  if (failed.length > 0) {
    lines.push(describeFailures(failures))
    lines.push(`网格：${r.path ?? meshLabel(r)}`)
  }
  for (const op of ops) lines.push(...op.body)
  for (const warning of warningsOf(r)) lines.push(`⚠️ ${warning}`)
  lines.push(describeSave(r))
  if (r.reopened_editor) lines.push('（静态网格编辑器为重建临时关掉又打开了）')
  return lines.join('\n')
}

export const optimizeMesh = defineUeTool<typeof OptimizeInput, MeshOptimizeResponse>({
  name: 'mesh_optimize',
  namespace: NAMESPACE,
  method: 'mesh.optimize',
  risk: 'mutating',
  concurrency: 'sequential',
  timeoutMs: OPTIMIZE_TIMEOUT_MS,
  description: `给静态网格生成 LOD 和简单碰撞 —— 网格编辑器里那两处菜单的同一套实现，不用再写 Python 脚本。两项互相独立，可以只给一项。默认存盘；回执逐项给「之前 → 之后」，数字都是引擎重建完读回来的。

- lods：LOD0 原样保留，LOD1 起按 LOD0 面数的百分比自动减面。网格已有导入的 LOD（美术做的）时这一项会被拒绝 —— 覆盖掉就回不来了；先问用户：同意保留就传 keep_imported:true，只在后面追加；只有用户明确同意换掉（比如布尔挖洞之后导入的 LOD 还是旧几何）才传 replace_imported:true，从 LOD1 起全部重建，回执点名换掉了哪几级。两个开关互斥。开着 Nanite 也能生成（给不支持 Nanite 的平台和回退路径用）。
- collision：box / sphere / capsule 拟合一个包住整个网格的形状；凹的物体（门洞、拱、L 形墙）用 convex 凸包分解。replace 默认 true，会先删掉现有简单碰撞（包括 FBX 带进来的 UCX）。

改的是原资产，摆了它的每个关卡都跟着变。碰撞复杂度、Nanite、LOD 组这些是属性，走 ue_content_set_properties。只支持静态网格；PIE 运行中不能用。整次调用是撤销栈上的一步。`,
  input: OptimizeInput,
  toParams: toOptimizeParams,
  toOutcome: (response) => ({
    text: summarizeOptimize(response),
    details: response
  })
})
