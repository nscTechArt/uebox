/**
 * `ue_inspect_components` —— 组件级只读回读。
 *
 * 2026-09-24 买量定序器反馈（缺口 4）：只读评审子任务要查新显示角色的描边 Stencil、
 * 覆层材质、Boss 每个材质槽实际用的材质、小怪 CDO 上的攻击动画映射，手上的只读工具
 * 都够不到 —— `ue_get_actor(properties)` 只收顶层名字、同名取第一个组件；
 * `blueprint_describe` 给组件树不给值。子任务只能回「需主流程用 Python 补读」。
 *
 * 放开只读子任务的 Python 不是答案，缺的是一个够细、且本身就只读的入口。
 * 引擎侧见 `UAL_ComponentInspectCommands.cpp`。
 */

import { z } from 'zod'

import { callUe } from '../defineUeTool'
import { defineTool, type UnrealAgentTool } from '../defineTool'

const InputSchema = z
  .object({
    targets: z
      .object({
        selection: z.boolean().optional().describe('true = 用户当前选中的 Actor'),
        names: z.array(z.string().min(1)).optional().describe('Actor 名称 / Label'),
        paths: z.array(z.string().min(1)).optional().describe('Actor 对象路径')
      })
      .strict()
      .optional()
      .describe('场景里的 Actor（PIE 在跑就读游戏里那份）。和 blueprint_path 二选一'),
    blueprint_path: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('蓝图资产路径：读类默认值（CDO）和组件模板。和 targets 二选一'),
    components: z
      .array(z.string().trim().min(1))
      .max(50)
      .optional()
      .describe('只看这些组件：组件名，或类名如 SkeletalMeshComponent。不给就是全部'),
    properties: z
      .array(z.string().trim().min(1))
      .max(40)
      .optional()
      .describe(
        '在每个选中的组件上读的属性，点路径，如 "BodyInstance.CollisionProfileName"、"OverrideMaterials[7]"'
      ),
    object_properties: z
      .array(z.string().trim().min(1))
      .max(40)
      .optional()
      .describe('在 Actor 本身 / 蓝图 CDO 上读的属性，点路径，如 "AttackMontages[0]"'),
    include_render_state: z
      .boolean()
      .default(true)
      .describe(
        '带上渲染状态：每个槽实际在用的材质、覆层、Custom Depth / Stencil、显隐、网格、动画蓝图'
      )
  })
  .refine((v) => Boolean(v.targets) !== Boolean(v.blueprint_path), {
    message: 'targets 和 blueprint_path 给且只给一个'
  })

type Input = z.infer<typeof InputSchema>

interface Render {
  visible?: boolean
  hidden_in_game?: boolean
  render_custom_depth?: boolean
  custom_depth_stencil?: number
  collision_profile?: string
  materials?: Array<{ slot: number; name?: string; material: string | null; overridden?: boolean }>
  material_slot_count?: number
  overlay_material?: string | null
  mesh?: string | null
  anim_class?: string | null
  animation_mode?: string
  anim_instance_class?: string
}

interface ComponentEntry {
  name: string
  class: string
  attach_parent?: string
  render?: Render
  properties?: Record<string, unknown>
  property_errors?: Record<string, string>
}

/** 字段名与 `UAL_ComponentInspectCommands.cpp` 逐字对应 */
export interface InspectOutput {
  targets: Array<{
    kind: 'actor' | 'blueprint_default'
    name: string
    class: string
    components: ComponentEntry[]
    available_components?: string[]
    properties?: Record<string, unknown>
    property_errors?: Record<string, string>
    truncated?: boolean
  }>
  world?: string
  world_note?: string
  note?: string
  truncated?: boolean
}

/** 单个属性值的字符上限：一个大数组整个倒进上下文，比读不到还难用 */
const MAX_VALUE_CHARS = 600

function short(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…（截断）` : text
}

function propertyLines(
  props: Record<string, unknown> | undefined,
  errors: Record<string, string> | undefined,
  indent: string
): string[] {
  const lines: string[] = []
  for (const [path, value] of Object.entries(props ?? {}))
    lines.push(`${indent}${path} = ${short(value)}`)
  for (const [path, error] of Object.entries(errors ?? {}))
    lines.push(`${indent}${path}：读不到（${error}）`)
  return lines
}

function renderLines(r: Render, indent: string): string[] {
  const lines: string[] = []
  const state = [
    r.visible === false ? '不可见' : '可见',
    r.hidden_in_game ? '游戏中隐藏' : '',
    r.render_custom_depth
      ? `Custom Depth 开，Stencil=${r.custom_depth_stencil}`
      : `Custom Depth 关（Stencil=${r.custom_depth_stencil}）`,
    r.collision_profile ? `碰撞 ${r.collision_profile}` : ''
  ].filter(Boolean)
  lines.push(`${indent}${state.join('；')}`)
  if (r.mesh !== undefined) lines.push(`${indent}网格 ${r.mesh ?? '(空)'}`)
  if (r.anim_class !== undefined || r.animation_mode) {
    const runtime = r.anim_instance_class ? `，运行中实例 ${r.anim_instance_class}` : ''
    lines.push(
      `${indent}动画 ${r.animation_mode ?? '?'}，AnimClass ${r.anim_class ?? '(空)'}${runtime}`
    )
  }
  // 覆层字段不存在 = 这版引擎没有覆层（5.0），和「有但没设」要分开说
  if (r.overlay_material !== undefined)
    lines.push(`${indent}覆层材质 ${r.overlay_material ?? '(无)'}`)
  for (const slot of r.materials ?? []) {
    const name = slot.name ? ` ${slot.name}` : ''
    lines.push(
      `${indent}槽 ${slot.slot}${name}：${slot.material ?? '(空)'}${slot.overridden ? '（组件上覆盖过）' : ''}`
    )
  }
  if (r.material_slot_count)
    lines.push(`${indent}……共 ${r.material_slot_count} 个槽，只列了前 64 个`)
  return lines
}

export function formatInspectOutcome(data: InspectOutput): string {
  const lines: string[] = []
  if (data.world === 'pie') lines.push(`读的是正在运行的游戏（PIE）。${data.world_note ?? ''}`)
  if (data.note) lines.push(data.note)
  for (const t of data.targets) {
    lines.push('', `## ${t.name}（${t.kind === 'actor' ? 'Actor' : '蓝图默认值'}，${t.class}）`)
    lines.push(...propertyLines(t.properties, t.property_errors, '  '))
    if (t.components.length === 0 && t.available_components) {
      lines.push(`  没有对上的组件。这个对象上有：${t.available_components.join('、')}`)
    }
    for (const c of t.components) {
      lines.push(
        `- ${c.name}（${c.class}${c.attach_parent ? `，挂在 ${c.attach_parent} 下` : ''}）`
      )
      if (c.render) lines.push(...renderLines(c.render, '    '))
      lines.push(...propertyLines(c.properties, c.property_errors, '    '))
    }
    if (t.truncated) lines.push('  ⚠️ 组件太多，只列了前 60 个。用 components 点名。')
  }
  if (data.truncated) lines.push('', '⚠️ 匹配的 Actor 太多，只读了前 20 个。')
  return lines.join('\n').trim()
}

export function createInspectComponentsTool(): UnrealAgentTool<InspectOutput> {
  return defineTool({
    name: 'ue_inspect_components',
    namespace: 'ue.actor',
    risk: 'safe',
    concurrency: 'parallel',
    description: `按组件读场景 Actor 或蓝图默认值，只读。ue_get_actor 读不到的都在这里：

- 每个材质槽**实际在用**的材质（槽号、槽名、是不是组件上覆盖的）、覆层材质
- Custom Depth / Stencil（描边）、显隐、碰撞预设、网格资产、动画蓝图和动画模式（PIE 里还有运行中的实例类）
- 任意属性的点路径：结构体、数组、对象引用，如 "BodyInstance.CollisionProfileName"
- 蓝图（blueprint_path）：CDO 上的值（object_properties，如攻击蒙太奇映射）和每个组件模板

同名组件不会混：按组件名或类名挑（components），每个组件单独报。
换显示层 / 风格迁移后核对「原来的描边、覆层、溶解材质新角色上有没有」，用它逐个组件对照，
不要写 Python。蓝图读的是默认值，构造脚本和 BeginPlay 之后的改动要对实例读。`,
    input: InputSchema,
    execute: async (input: Input) => {
      const data = await callUe<InspectOutput>(
        'actor.inspect_components',
        {
          ...(input.targets ? { targets: input.targets } : {}),
          ...(input.blueprint_path ? { blueprint_path: input.blueprint_path } : {}),
          ...(input.components?.length ? { components: input.components } : {}),
          ...(input.properties?.length ? { properties: input.properties } : {}),
          ...(input.object_properties?.length
            ? { object_properties: input.object_properties }
            : {}),
          render_state: input.include_render_state
        },
        { timeoutMs: 60_000 }
      )
      if (!Array.isArray(data?.targets)) {
        return { text: '读取失败：引擎没有返回结果', isError: true }
      }
      return { text: formatInspectOutcome(data), details: data }
    }
  })
}
