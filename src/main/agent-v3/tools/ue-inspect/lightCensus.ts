/**
 * `ue_light_census` —— 灯光普查，只读。
 *
 * 渲染线程 / GPU 瓶颈的「为什么」常常在灯上：点光源的阴影按立方体六个面画；
 * 灯的半径里压着可移动物体、或用了 World Position Offset 的材质，那盏灯的阴影缓存
 * 就留不住、要反复重画。性能专家讲清原因靠的就是这张普查表，而此前我们的工具只数网格
 * （`ue_find_heavy_assets` 把灯光放进 not_ranked_by_class 只报个数）。
 *
 * 只报引擎里的数，不判「灯太多」—— 多少算多取决于平台和画面目标，同
 * `ue_find_heavy_assets` 的 min_triangles 不给默认值。
 *
 * 引擎侧见 `UAL_LevelCommands.cpp` 的 `level.light_census`，字段名逐字对应。
 */

import { z } from 'zod'

import { PLUGIN_UPDATE_HINT } from '../adapted/project/pluginUpdateHint'
import { callUe } from '../defineUeTool'
import { defineTool, type UnrealAgentTool } from '../defineTool'

const InputSchema = z.object({
  world: z
    .enum(['auto', 'editor'])
    .default('auto')
    .describe('auto = 游戏在跑就读游戏世界（PIE），否则编辑器世界；editor = 总是读关卡里的摆放'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(30)
    .describe('最多列几盏灯的明细（按半径里的投影物体数排序）。总数统计不受它影响'),
  label_contains: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('只看名字（Actor 标签或组件名）含这段文字的灯，如 "Lamp"')
})

type Input = z.infer<typeof InputSchema>

interface TopMesh {
  mesh?: string
  component_class?: string
  primitives: number
  instances: number
  movable: number
  wpo: number
  nanite?: boolean
}

interface Census {
  primitives: number
  movable: number
  stationary: number
  static: number
  wpo: number
  /**
   * 5.1+ 才有：带 WPO 材质、但静态网格组件上关了 bEvaluateWorldPositionOffset 的个数。
   * 5.0 那个开关只管光追，插件不报；5.1–5.3 引擎注释写着只在 r.OptimizedWPO=1 时生效
   */
  wpo_evaluation_off?: number
  nanite: number
  non_nanite: number
  /** 非静态网格的投影图元（骨骼网格、地形…），没有 Nanite 这个口径 */
  other: number
  instanced_components: number
  instances: number
  instances_upper_bound?: boolean
  top_meshes: TopMesh[]
  distinct_meshes?: number
}

export interface LightEntry {
  label: string
  component: string
  type: 'directional' | 'point' | 'spot' | 'rect' | 'sky' | 'other'
  class?: string
  mobility: 'static' | 'stationary' | 'movable'
  in_scene: boolean
  cast_shadows: boolean
  cast_dynamic_shadows: boolean
  intensity: number
  intensity_units?: string
  attenuation_radius?: number
  max_draw_distance?: number
  max_draw_distance_set?: boolean
  location?: [number, number, number]
  census?: Census
  census_skipped?: 'not_in_scene' | 'limit'
}

/** 字段名与 `UAL_LevelCommands.cpp` 的 `Handle_LightCensus` 逐字对应 */
export interface LightCensusOutput {
  world?: string
  world_note?: string
  play_world_count?: number
  label_contains?: string
  totals: {
    lights: number
    in_scene: number
    shadow_casting: number
    shadow_casting_local: number
    shadow_casting_local_without_max_draw_distance: number
    radius_census_done: number
    shadow_casting_primitives: number
    by_type: Record<string, number>
    by_mobility: Record<string, number>
  }
  lights: LightEntry[]
  lights_truncated?: boolean
  radius_census_skipped?: number
  primitives_truncated?: boolean
  primitives_examined?: number
  instance_budget_exhausted?: boolean
  shaders_compiling?: number
  limits?: Record<string, number>
  elapsed_ms?: number
}

const TYPE_NAMES: Record<string, string> = {
  point: '点光源',
  spot: '聚光灯',
  rect: '矩形光',
  directional: '平行光',
  sky: '天光',
  other: '其他'
}

const MOBILITY_NAMES: Record<string, string> = {
  movable: '可移动',
  stationary: '固定',
  static: '静态'
}

function n(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

function counts(map: Record<string, number>, names: Record<string, string>): string {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${names[key] ?? key} ${n(count)}`)
    .join('、')
}

function settingsLine(light: LightEntry): string {
  const parts = [TYPE_NAMES[light.type] ?? light.type]
  if (light.class) parts.push(light.class)
  parts.push(MOBILITY_NAMES[light.mobility] ?? light.mobility)
  if (!light.in_scene) parts.push('未进渲染场景（关了 / 隐藏 / 强度为 0）')
  parts.push(
    light.cast_shadows ? (light.cast_dynamic_shadows ? '投影' : '投影（关了动态阴影）') : '不投影'
  )
  parts.push(`强度 ${light.intensity}${light.intensity_units ? ` ${light.intensity_units}` : ''}`)
  if (light.attenuation_radius !== undefined) parts.push(`半径 ${n(light.attenuation_radius)}`)
  if (light.max_draw_distance !== undefined)
    parts.push(
      light.max_draw_distance_set
        ? `最大绘制距离 ${n(light.max_draw_distance)}`
        : '最大绘制距离未设（任何距离都画）'
    )
  return parts.join('，')
}

function censusLines(c: Census, indent: string): string[] {
  const wpo =
    c.wpo_evaluation_off !== undefined && c.wpo > 0
      ? `带 WPO ${n(c.wpo)}（其中 ${n(c.wpo_evaluation_off)} 个组件关了 Evaluate World Position Offset）`
      : `带 WPO ${n(c.wpo)}`
  const lines = [
    `${indent}半径内投影物体 ${n(c.primitives)}：可移动 ${n(c.movable)}、固定 ${n(c.stationary)}、静态 ${n(c.static)}；${wpo}；` +
      `Nanite ${n(c.nanite)} / 非 Nanite ${n(c.non_nanite)} / 非静态网格 ${n(c.other)}`
  ]
  if (c.instanced_components > 0)
    lines.push(
      `${indent}实例化组件 ${n(c.instanced_components)} 个，半径内 ${n(c.instances)} 个实例` +
        (c.instances_upper_bound ? '（逐实例预算用完，部分按整组件计入，是上界）' : '')
    )
  if (c.top_meshes.length > 0) {
    const top = c.top_meshes.map((m) => {
      const name = m.mesh ?? `(${m.component_class})`
      const tags = [
        m.instances !== m.primitives ? `${n(m.instances)} 实例` : `${n(m.primitives)} 个`,
        m.nanite === undefined ? '' : m.nanite ? 'Nanite' : '非 Nanite',
        m.movable ? `可移动 ${n(m.movable)}` : '',
        m.wpo ? `WPO ${n(m.wpo)}` : ''
      ].filter(Boolean)
      return `${name}（${tags.join('，')}）`
    })
    const more = c.distinct_meshes ? `，共 ${n(c.distinct_meshes)} 种` : ''
    lines.push(`${indent}最多的：${top.join('；')}${more}`)
  }
  return lines
}

export function formatLightCensus(data: LightCensusOutput): string {
  const t = data.totals
  const lines: string[] = []
  const world =
    data.world === 'pie'
      ? '正在运行的游戏世界（PIE）'
      : data.world === 'editor'
        ? '编辑器世界'
        : '当前世界'
  const filter = data.label_contains ? `（只看名字含「${data.label_contains}」的）` : ''
  lines.push(`读的是${world}${filter}。${data.world_note ?? ''}`.trim())
  if (data.play_world_count && data.play_world_count > 1)
    lines.push(`当前有 ${data.play_world_count} 个游戏实例，这份普查只针对其中一个。`)

  if (t.lights === 0) {
    lines.push('没有找到灯光组件。')
    return lines.join('\n')
  }

  lines.push(
    `共 ${n(t.lights)} 盏灯：${counts(t.by_type, TYPE_NAMES)}；${counts(t.by_mobility, MOBILITY_NAMES)}；` +
      `进了渲染场景的 ${n(t.in_scene)} 盏，投影的 ${n(t.shadow_casting)} 盏。`
  )
  lines.push(
    `投影局部光（点 / 聚光 / 矩形）${n(t.shadow_casting_local)} 盏，其中没设最大绘制距离的 ` +
      `${n(t.shadow_casting_local_without_max_draw_distance)} 盏；做了半径普查的 ${n(t.radius_census_done)} 盏。` +
      `整个世界投动态阴影的图元共 ${n(t.shadow_casting_primitives)} 个。`
  )

  lines.push('', `## 各灯（按半径里的投影物体数排序，列了 ${data.lights.length} 盏）`)
  for (const light of data.lights) {
    lines.push(
      `- ${light.label}${light.component ? ` / ${light.component}` : ''}：${settingsLine(light)}`
    )
    if (light.census) lines.push(...censusLines(light.census, '  '))
    else if (light.census_skipped === 'limit')
      lines.push('  没做半径普查：投影局部光太多，超过了单次上限')
    else if (light.type === 'directional' && light.cast_shadows)
      lines.push('  平行光的阴影不受半径约束，不做半径普查')
  }

  const caveats: string[] = []
  if (data.lights_truncated)
    caveats.push(`灯太多，只列了 ${data.lights.length} 盏明细；上面的总数是全部灯的。`)
  if (data.radius_census_skipped)
    caveats.push(
      `还有 ${n(data.radius_census_skipped)} 盏投影局部光没做半径普查（单次上限 ${data.limits?.radius_census_lights ?? '?'} 盏），可用 label_contains 分批看。`
    )
  if (data.primitives_truncated)
    caveats.push(
      `投影图元太多，只拿前 ${n(data.primitives_examined ?? 0)} 个做半径判定，半径内的数是下限。`
    )
  if (data.instance_budget_exhausted)
    caveats.push('逐实例判距离的预算用完了，标「上界」的那几盏灯实例数按整组件计入。')
  if (data.shaders_compiling)
    caveats.push(
      `还有 ${n(data.shaders_compiling)} 个着色器在编译。WPO 读的是编译好的着色器，没编完的材质引擎也答「不带 WPO」，所以 WPO 数现在是下限，编完再查一次。`
    )
  if (data.lights.some((l) => l.type === 'spot' && l.census))
    caveats.push('聚光灯按整个衰减半径球算，不按锥体裁，半径内的数是上界。')
  if (caveats.length) lines.push('', ...caveats.map((c) => `⚠️ ${c}`))
  return lines.join('\n').trim()
}

/** 老插件没有这条命令 —— 原文「Unknown method」对谁都没意义 */
function translateOldPlugin(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('Unknown method'))
    throw new Error('这个工程里装的虚幻盒子插件太旧，还不会做灯光普查。' + PLUGIN_UPDATE_HINT)
  throw error
}

export function createLightCensusTool(): UnrealAgentTool<LightCensusOutput> {
  return defineTool({
    name: 'ue_light_census',
    namespace: 'ue.level',
    risk: 'safe',
    concurrency: 'parallel',
    description: `关卡灯光普查，只读。渲染线程 / GPU 是瓶颈时，用它讲清「为什么」—— ue_find_heavy_assets 只数网格，不数灯。

每盏灯：类型（点 / 聚光 / 矩形 / 平行 / 天光）、移动性、投不投影、强度和单位、衰减半径、最大绘制距离（0 = 没设，任何距离都画）。
每盏投影局部光再数半径里的投影物体：几个可移动、几个材质带 World Position Offset、Nanite / 非 Nanite、实例化组件（植被）里有多少实例落在半径内、最多的是哪几个网格。

为什么看这些：点光源的阴影按立方体六个面画；半径里有可移动物体或带 WPO 的材质时，这盏灯的阴影缓存留不住、要反复重画。

口径：
- 只报引擎里的数，不判「灯太多」，多少算多由项目定
- WPO 读编译好的着色器；返回说还有着色器在编译时，WPO 数是下限
- 半径用包围球判，聚光灯按整球算（上界）；只数已加载的 Actor（World Partition 未加载的格子不在内）
- 普查是推断的依据，不是证据：要证明是某盏灯，关掉它的阴影前后各测一次`,
    input: InputSchema,
    execute: async (input: Input) => {
      let data: LightCensusOutput
      try {
        data = await callUe<LightCensusOutput>(
          'level.light_census',
          {
            world: input.world,
            limit: input.limit,
            ...(input.label_contains ? { label_contains: input.label_contains } : {})
          },
          { timeoutMs: 120_000 }
        )
      } catch (error) {
        return translateOldPlugin(error)
      }
      if (!data?.totals || !Array.isArray(data.lights)) {
        return { text: '灯光普查失败：引擎没有返回结果', isError: true }
      }
      return { text: formatLightCensus(data), details: data }
    }
  })
}
