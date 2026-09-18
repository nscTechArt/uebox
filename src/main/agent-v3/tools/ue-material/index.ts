/**
 * UE 材质工具集（V3）。
 *
 * 从 `agent-v3/tools/adapted/ue-material/` 迁移。**Zod schema 与 RPC 方法名逐字保留** ——
 * 引擎侧插件不变，任何 schema 漂移都会变成运行时的参数不匹配。
 *
 * 相比 V2 的变化只有形态：
 *   - 15 个文件 → 1 个文件（每个工具的 60 行 RPC 样板由 defineUeTool 收敛）
 *   - `strict: true` 去掉 —— pi 按 JSON Schema 校验，Zod 再校验一次，比 AI SDK 的
 *     strict 模式更严，且不依赖厂商是否支持 structured outputs
 *   - 增加 `risk` 声明，只读工具不再触发审批
 *
 * `materialValueSchema` 已随 `adapted/ue-material/` 的删除一并移入本目录 ——
 * 那个目录迁移后没人引用了，只剩这一个模块还被指着，是最后一根牵连。
 *
 * ## 别再漏注册引擎已经实现的命令
 *
 * 插件 `RegisterCommands` 注册了 15 条 `material.*`，这里长期只暴露了 10 条。
 * 漏掉的那几条不是边角料 —— `material.create_instance` 是 UE 材质工作流的主干
 * （母材质 + 实例），功能在插件里躺着可用，而 skill 文档因为看不见它，
 * 一直在教模型「没有创建材质实例的工具，让用户自己去编辑器里手建」。
 *
 * 现补齐 create_instance 和 set_property 两条。其余两条不暴露：
 *   - `material.preview` —— 它给的属性已经并进 `material.describe` 了。
 *     两个职责重叠的只读工具，模型每次都要先挑一个，而挑错没有任何提示
 *   - `material.list` —— `ue_content_search` 带 filter_class 已经覆盖
 *
 * `material.duplicate` 原来也在这一列，理由是「复制母材质等于多编译一套 shader，
 * 这个需求由 create_instance 满足更好」。那句话只说中了一半：**参数变体**确实该走
 * 实例，但「照着这张图改一版、原来那份留着」和「大改之前留个备份」不是参数变体 ——
 * 实例改不了图，这两件事底下没有任何工具能做，只能新建一个再把几十个节点重连一遍。
 * 引擎里右键 Duplicate 就是一下的事，工具层不该比它窄。现在补上，
 * 并把「什么时候不该用它」写进工具描述，而不是靠不给工具来强制。
 *
 * ## 写图只剩 material_apply_graph 一条路
 *
 * `material_add_node` / `material_connect_pins` 已下线。它们本身没坏，坏在
 * **那条路上没有排版**：模型用 apply_graph 建完一张排好的图，之后每次修改都
 * 退回逐节点，交付的就是一团叠在一起的节点。理由和真机证据写在
 * `applyGraph.ts` 的模块注释里。
 *
 * 这不是「不给工具来强制」的反例 —— 上面 duplicate 那段说的是**能力**该不该给，
 * 这里两个工具的能力 apply_graph 一样不少（两端都收真实 node_id / guid，
 * `nodes: []` 只发连线也合法），下线掉的只是一条必然排不了版的写法。
 */

import { z } from 'zod'

import {
  MaterialParamListSchema,
  materialParamEntriesToRecord,
  MaterialValueSchema
} from './materialValueSchema'
import { createMaterialApplyGraphTool } from './applyGraph'
import { layoutMaterialNodes } from './layout'
import { searchMaterialNodes } from './searchNodes'
import { describeWorld, type WorldScopedResponse } from '../worldScope'
import { describeUnmatchedTargets, type UnmatchedTargetsResponse } from '../unmatchedTargets'
import { callUe, defineUeTool } from '../defineUeTool'
import { defineTool, type UnrealAgentTool } from '../defineTool'

const NAMESPACE = 'ue.material'

/**
 * 混合模式 / 着色模型的合法取值 —— 与引擎侧 `ParseBlendMode` /
 * `ParseShadingModel` 认得的集合逐字对齐。
 *
 * 用 enum 而不是自由字符串，是因为引擎侧**认不出来的值会被静默忽略**：
 * 不报错、不回退、响应里也不提，材质就那么保持原样。写 `"Transparent"`
 * （正确拼法是 `Translucent`）的下场是「设置成功」四个字加一个仍然不透明的材质。
 * 卡在 schema 上，模型至少当场就能看见自己写错了。
 */
const BLEND_MODES = ['Opaque', 'Masked', 'Translucent', 'Additive', 'Modulate'] as const
const SHADING_MODELS = [
  'DefaultLit',
  'Unlit',
  'Subsurface',
  'ClearCoat',
  'TwoSidedFoliage'
] as const

/**
 * 模型侧一律用 `path` 指「这个工具操作的那个资产」，插件侧的键名各不相同
 * （`material_path` / `parent_path` / `asset_path`），在这里换一次。
 *
 * 以前是把插件的键名直接透给模型，于是同一件事有四种叫法，
 * skill 里不得不用一整节列表告诉模型「哪个工具用哪个名字」——
 * 那是 schema 不一致的成本，被转嫁成了每次材质任务都要付的上下文。
 *
 * 现在的规则一句话说得完，不用记表：
 *   · `path`             —— 这个工具操作的资产
 *   · `destination_path` —— 新建的东西存到哪
 *   · `texture_path` / `function_path` / `collection_path` —— 被引用的资产
 */
function renamePath(wireKey: string) {
  return (args: unknown): Record<string, unknown> => {
    const { path, ...rest } = args as { path: string } & Record<string, unknown>
    return { [wireKey]: path, ...rest }
  }
}

const toMaterialPath = renamePath('material_path')
const toParentPath = renamePath('parent_path')
const toAssetPath = renamePath('asset_path')
const toSourcePath = renamePath('source_path')

interface CreateMaterialResponse {
  material_name: string
  material_path: string
  material_type: string
  blend_mode: string
  two_sided: boolean
  available_pins?: string[]
}

const createMaterial = defineUeTool<z.ZodTypeAny, CreateMaterialResponse>({
  name: 'material_create',
  namespace: NAMESPACE,
  method: 'material.create',
  risk: 'mutating',
  description: `创建 UMaterial（母材质）。

创建后用 material_apply_graph 一次写完节点和连线 —— 它自己排版、自己编译，不用再单独调 material_compile。
需要带贴图的材质时，节点上直接传 texture_path 一步到位，不要建完再单独设值。`,
  input: z.object({
    material_name: z
      .string()
      .describe(
        '材质名称（必填），如 "M_MyMaterial"。' +
          '同名材质会被就地覆盖（引擎侧建对象时不查重），先用 ue_content_search 确认名字没被占用'
      ),
    destination_path: z
      .string()
      .optional()
      .default('/Game/Materials')
      .describe('材质保存路径（可选，默认 /Game/Materials）'),
    blend_mode: z.enum(BLEND_MODES).optional().describe('混合模式（可选，默认 Opaque）'),
    shading_model: z.enum(SHADING_MODELS).optional().describe('着色模型（可选，默认 DefaultLit）'),
    two_sided: z.boolean().optional().describe('是否双面渲染（可选，默认 false）')
  }),
  toOutcome: (r) => ({
    text: `已创建母材质 ${r.material_name}（${r.material_path}）。可用引脚：${r.available_pins?.join(', ') || '未返回'}`,
    details: r
  })
})

interface CreateInstanceResponse {
  instance_path: string
  instance_name: string
  parent_path: string
  available_params?: {
    scalar_params?: string[]
    vector_params?: string[]
    texture_params?: string[]
  }
}

const createMaterialInstance = defineUeTool<z.ZodTypeAny, CreateInstanceResponse>({
  name: 'material_create_instance',
  namespace: NAMESPACE,
  method: 'material.create_instance',
  risk: 'mutating',
  description: `基于一个母材质创建 MaterialInstanceConstant（材质实例）。

「同一种材质要几个颜色 / 几档粗糙度」的标准做法：母材质里放 ScalarParameter、
VectorParameter 节点，然后用本工具建实例，再用 material_set_param 逐个调参数。
不要为每个变体复制一份母材质 —— 每一份都会单独编译一套 shader。

返回的 instance_path 可以直接喂给 material_set_param 和 material_apply。`,
  input: z.object({
    path: z.string().describe('母材质路径，如 /Game/Materials/M_Wood'),
    instance_name: z
      .string()
      .optional()
      .describe(
        '实例名称（可选，默认 MI_<母材质名>）。同名资产会被就地覆盖，连同它已有的参数改动一起没'
      ),
    destination_path: z.string().optional().describe('保存路径（可选，默认与母材质同目录）')
  }),
  toParams: toParentPath,
  /**
   * 把父材质暴露的参数名原样报给模型。
   *
   * 这不是锦上添花 —— `material_set_param` 底下的引擎接口
   * (`SetScalarParameterValueEditorOnly`) **不校验参数名**：名字拼错了它照样
   * 往实例里塞一条谁也不读的记录，然后回一个成功。
   * 参数名只能从这里（或 material_describe）拿，不能猜。
   *
   * 父材质一个参数都没暴露的情况也要点破：实例建得出来，但上面没有任何旋钮，
   * 后续 set_param 会「全部成功」而画面纹丝不动。
   */
  toOutcome: (r) => {
    const scalars = r.available_params?.scalar_params ?? []
    const vectors = r.available_params?.vector_params ?? []
    const textures = r.available_params?.texture_params ?? []

    const lines = [
      `已创建材质实例 ${r.instance_name}（${r.instance_path}），父材质 ${r.parent_path}。`
    ]

    if (scalars.length + vectors.length + textures.length === 0) {
      lines.push(
        '⚠️ 父材质没有暴露任何参数，这个实例上没有可调的东西 —— 现在对它调 material_set_param ' +
          '会「成功」但毫无效果。要让它可调，先用 material_apply_graph 把母材质里的常量节点换成 ' +
          'ScalarParameter / VectorParameter（节点上用 node_name 指定参数名）。'
      )
    } else {
      lines.push('可调参数（material_set_param 只认这些名字，不要自己猜）：')
      if (scalars.length) lines.push(`  标量：${scalars.join('、')}`)
      if (vectors.length) lines.push(`  向量/颜色：${vectors.join('、')}`)
      if (textures.length) lines.push(`  贴图：${textures.join('、')}`)
    }

    return { text: lines.join('\n'), details: r }
  }
})

interface DuplicateMaterialResponse {
  source_path: string
  new_path: string
  new_name: string
}

/**
 * 整份复制一个材质 / 材质实例。
 *
 * 插件侧（`material.duplicate`）一直有，工具这边一直没有 —— 于是「照着这个材质
 * 改一版」只能新建一个再把整张图重连一遍，几十个节点全靠手搓，而引擎里
 * 右键 Duplicate 就是一下的事。
 *
 * 描述里必须把「什么时候**不该**用它」写在前面：同一种材质要几个颜色/粗糙度
 * 档位，正确做法是母材质开参数 + material_create_instance，复制母材质会让每一份
 * 单独编译一套 shader。这条 create_instance 的描述里已经写了，两边要一致。
 */
const duplicateMaterial = defineUeTool<z.ZodTypeAny, DuplicateMaterialResponse>({
  name: 'material_duplicate',
  namespace: NAMESPACE,
  method: 'material.duplicate',
  risk: 'mutating',
  description: `整份复制一个材质或材质实例（等同于内容浏览器里的 Duplicate）。

【什么时候用】
- 要在现有材质上改一版、但原来那份得留着（改坏了还能回去）
- 大改一张材质图之前先留个备份
- 拿一个做好的材质当模板，改几个节点变成另一种材质

【什么时候**不要**用】同一种材质只是要几个颜色 / 几档粗糙度 —— 那要的是
  material_create_instance。复制母材质会让每一份单独编译一套 shader，
  变体一多编译时间和包体都跟着涨。

【名字冲突】目标名被占用时会自动加后缀（_1、_2…），返回里的 new_path 才是
  真正落地的路径，照它往下走，别用你请求时的名字。`,
  input: z.object({
    path: z.string().describe('要复制的材质 / 材质实例路径，如 /Game/Materials/M_Wood'),
    new_name: z.string().optional().describe('新资产名（可选，默认 <原名>_Copy）'),
    destination_path: z.string().optional().describe('保存路径（可选，默认与原材质同目录）')
  }),
  toParams: toSourcePath,
  toOutcome: (r) => ({
    text:
      `已复制 ${r.source_path} → ${r.new_path}。` +
      '后续对副本的操作都用这个新路径；原材质没有任何改动。',
    details: r
  })
})

const applyMaterial = defineUeTool({
  name: 'material_apply',
  namespace: NAMESPACE,
  method: 'material.apply',
  risk: 'mutating',
  description: `把材质应用到场景中一个或多个 Actor 的网格组件材质槽。静态网格和骨骼网格都行。

只认**关卡里的 Actor**。要改的是蓝图资产里组件的默认材质（比如让所有金币都变金色），
用 blueprint_set_property：component_name 填组件名，properties 填
{ "OverrideMaterials": ["/Game/Materials/M_Gold"] }。

被跳过的 Actor 会连原因一起回来（没有网格组件、还没指定网格、槽位越界），照着原因改。`,
  input: z.object({
    targets: z
      .object({
        names: z.array(z.string()).optional().describe('Actor 名称列表'),
        paths: z.array(z.string()).optional().describe('Actor 完整路径列表'),
        filter: z
          .object({
            class: z.string().optional().describe('Actor 类名过滤'),
            name_pattern: z.string().optional().describe('名称通配符匹配')
          })
          .optional()
          .describe('过滤条件')
      })
      .describe('目标 Actor 选择器'),
    path: z.string().describe('材质资产路径，如 /Game/Materials/MI_Wood'),
    slot_index: z.number().int().min(0).optional().default(0).describe('材质槽索引，默认 0'),
    component_name: z
      .string()
      .optional()
      .describe(
        '只改这个网格组件（组件名，如 Mesh）。省略则按优先级挑一个（根组件 → 骨骼网格 → 其余），' +
          '并在回执里告诉你挑中了哪个、旁边还有哪些。UI 组件（WidgetComponent）不会被自动挑中，要刷它就在这里点名'
      )
  }),
  toParams: toMaterialPath,
  /**
   * 匹配到的 Actor 数和真正应用成功的数**经常不一样**：没有网格组件、
   * 组件上没有网格、槽位越界的 Actor 会被引擎侧跳过。
   *
   * 真机上一次 `filter: {class:'StaticMeshActor'}` 匹配到 4 个、只应用了 1 个，
   * 而返回体里只列出成功的那 1 个 —— 不点破的话模型会向用户汇报
   * 「材质已应用」，另外 3 个没应用上，谁也不知道。现在插件把每个跳过的
   * 原因都回在 skipped 里，这里逐条转给模型。
   */
  toOutcome: (
    r: {
      applied_count?: number
      target_count?: number
      actors?: Array<{
        name?: string
        /** Actor 的完整路径。名字（编辑器标签）不唯一，重试要按路径点名 */
        path?: string
        component?: string
        /** 这个 Actor 上一共几个**可渲染**网格组件。>1 说明只刷了其中一个 */
        mesh_component_count?: number
        /** 没被刷到的那几个的名字，已封顶。要改刷它们就把名字填进 component_name */
        other_components?: string
      }>
      /** path 和成功名单那边同理：标签不唯一，重试要按路径点名 */
      skipped?: Array<{ name?: string; path?: string; reason?: string }>
      skipped_count?: number
      /** 按原因归类的完整汇总（逐条明细封了顶，这个没有） */
      skipped_summary?: string
    } & WorldScopedResponse &
      UnmatchedTargetsResponse
  ) => {
    const applied = r.applied_count ?? 0
    const targets = r.target_count ?? applied
    const actors = r.actors ?? []
    /*
     * 刷到了**哪个组件**要说出来。
     *
     * 一个 Actor 上不止一个网格组件时（角色的身体 + 武器、模块化的门框 + 门板），
     * 不指定 component_name 就由引擎按优先级挑一个。只报 Actor 名的话，
     * 挑错了没人看得出来 —— 而组件名恰恰是重试时要填进 component_name 的那个词。
     *
     * 重名的时候报**路径**。`GetActorFriendlyName` 回的是编辑器标签，标签不唯一：
     * `filter: {name_pattern:'Cube*'}` 刷中三个都叫 Cube，只报名字的话调用方
     * 既分不清哪三个成了，也没法给没成的那两个拼一次 `targets.paths` 重试。
     *
     * 成功名单也要**封顶**。跳过名单封了顶、成功名单不封是本末倒置：
     * 成功那条路跑得多得多，而这一版每条还更长了（多了组件名）。
     * 一个 filter 命中 300 个 Actor，全量列出来就是两万字符糊进上下文。
     */
    const MAX_ACTOR_NAMES = 20
    const labelCounts = new Map<string, number>()
    for (const a of actors) {
      if (a.name) labelCounts.set(a.name, (labelCounts.get(a.name) ?? 0) + 1)
    }
    // 标签重名就改用路径。成功名单和下面的「只刷了一个」名单**共用**这一个规则 ——
    // 各写各的话，最需要点名重试的那一份反而只有重名的标签
    const labelOf = (a: { name?: string; path?: string }): string => {
      if (!a.name) return a.path ?? '?'
      return (labelCounts.get(a.name) ?? 0) > 1 && a.path ? a.path : a.name
    }
    const names = actors.flatMap((a) => {
      if (!a.name) return []
      const label = labelOf(a)
      return [a.component ? `${label}（${a.component}）` : label]
    })
    const nameList =
      names.length > MAX_ACTOR_NAMES
        ? `${names.slice(0, MAX_ACTOR_NAMES).join('、')}…（共 ${names.length} 个）`
        : names.join('、')

    // 只刷到了多组件 Actor 的其中一个 —— 「1/1 成功」读起来是全做完了，
    // 而门框刷了门板没刷。旁边还有谁、下次该填哪个名字，都得说出来
    const partial = actors.filter((a) => (a.mesh_component_count ?? 0) > 1)

    /*
     * 插件对逐条明细封了顶（前 20 条），另给总数和一份**按原因归类的完整汇总**。
     *
     * 这里一度自己拼一句「…还有 N 个，原因多半和上面重复」—— 那是猜的：
     * 引擎的截断是按顺序截的，不是按原因截的，前 20 个都是「没有网格组件」
     * 不代表第 21 个不是「槽位越界」。改成直接转述引擎给的汇总。
     */
    const skipped = r.skipped ?? []
    const skippedTotal = r.skipped_count ?? skipped.length
    /*
     * 明细在**这一侧**也要封顶。
     *
     * 20 条这个上限只存在于新编的插件里，而插件装在用户的 UE 工程里、
     * 不随盒子升级。盒子更新了插件没更新的用户，跳过 299 个就是 299 行
     * 直接进上下文 —— 而同一个函数里成功名单老老实实封在 20 条。
     */
    const shownSkipped = skipped.slice(0, MAX_ACTOR_NAMES)
    /*
     * 跳过名单也走 `labelOf`，理由和成功名单一模一样。
     *
     * `filter: {name_pattern:'Cube*'}` 命中五个都叫 Cube、跳了两个，只印标签的话
     * 是两行一模一样的 `- Cube：…` —— 既分不清是哪两个，也没法拿 `targets.paths`
     * 单独重试它们。而「重试没成的那几个」正是引擎侧在 skipped 里补上 path 的理由，
     * 这半边比成功那半边更需要它。
     *
     * 重名判定用跳过名单自己的标签计数：成功名单里的 Cube 和跳过名单里的 Cube
     * 是不同的 Actor，混在一起数会把「只跳了一个 Cube」也判成重名而印出长路径。
     */
    const skippedLabelCounts = new Map<string, number>()
    for (const s of skipped) {
      if (s.name) skippedLabelCounts.set(s.name, (skippedLabelCounts.get(s.name) ?? 0) + 1)
    }
    const skippedLabelOf = (s: { name?: string; path?: string }): string => {
      if (!s.name) return s.path ?? '?'
      return (skippedLabelCounts.get(s.name) ?? 0) > 1 && s.path ? s.path : s.name
    }
    const skippedLines = shownSkipped.map(
      (s) => `  - ${skippedLabelOf(s)}：${s.reason ?? '未说明原因'}`
    )
    if (skippedTotal > shownSkipped.length) {
      skippedLines.push(
        r.skipped_summary
          ? `  …还有 ${skippedTotal - shownSkipped.length} 个。全部原因归类：${r.skipped_summary}`
          : `  …还有 ${skippedTotal - shownSkipped.length} 个（这个插件版本没回归类汇总）`
      )
    }

    /*
     * `skipped` 是新插件才有的字段，而插件装在**用户的 UE 工程**里、
     * 不随盒子一起升级。只认它的话，老插件上「4 个匹配、1 个应用成功」
     * 会一句警告都不报 —— 比这个字段出现之前还糟。
     * 拿不到明细就退回按数字算，宁可少说原因，不能不说这件事发生了。
     *
     * 而且这两者不是互斥的：`applied + skipped` 对不上 `target_count` 时，
     * 差额那几个既没成功也没被解释，那种沉默正是这套回报要消灭的。
     */
    const unexplained = targets - applied - skippedTotal

    const lines = [
      `材质已应用到 ${applied}/${targets} 个 Actor${nameList ? `：${nameList}` : ''}。`
    ]
    if (partial.length > 0) {
      lines.push(`⚠️ 其中 ${partial.length} 个 Actor 身上不止一个网格组件，只刷了挑中的那一个：`)
      for (const a of partial.slice(0, 5)) {
        lines.push(
          `  - ${labelOf(a)}：刷了 ${a.component ?? '?'}，没刷 ${a.other_components ?? '?'}` +
            `（共 ${a.mesh_component_count} 个）`
        )
      }
      if (partial.length > 5) lines.push(`  …还有 ${partial.length - 5} 个同样情况`)
      lines.push('  要刷别的组件就把它的名字填进 component_name 再调一次。')
    }
    // `skippedLines` 为空就说明 skippedTotal 也是 0（那一行只有在
    // skippedTotal > 已列条数时才会 push），所以这里不需要第二个分支
    if (skippedLines.length > 0) {
      lines.push(`⚠️ 有 ${skippedTotal} 个匹配到的 Actor 被跳过，别当成已经全部应用：`)
      lines.push(...skippedLines)
    }
    if (unexplained > 0) {
      lines.push(
        `⚠️ 还有 ${unexplained} 个匹配到的 Actor 既没应用上、也没给出原因` +
          '（这个插件版本没回跳过明细）—— 通常是没有网格组件、组件上还没指定网格、' +
          '或者槽位越界。用 ue_get_actor 逐个确认，别当成已经全部应用。'
      )
    }

    /*
     * PIE 里刷的材质**停止运行就没了**。
     *
     * `Handle_ApplyMaterial` 走的是 `GetLiveWorld()`，没有 RefuseDuringPlay，
     * 所以 PIE 是够得着的；插件也一直在回 world / world_note，只是这里没读。
     * 不说的话，用户按了 Play、让改材质，工具答「已应用到 12/12」，
     * 停下来一看全变回去了 —— 又是一次「成功」读成了永久生效。
     * spawn/destroy/transform 那几个工具早就在用同一个 describeWorld。
     */
    // 点名的 Actor 里有关卡里根本没有的，也要说 —— 它既不在 applied 里，
    // 也不在 skipped 里，`target_count` 更是从来没算过它
    return {
      text: lines.join('\n') + describeUnmatchedTargets(r) + describeWorld(r),
      details: r
    }
  }
})

const describeMaterial = defineUeTool({
  name: 'material_describe',
  namespace: NAMESPACE,
  method: 'material.describe',
  // 只读 —— 不触发审批
  risk: 'safe',
  description: `读取材质的**属性和参数**：类型（母材质/实例）、混合模式、着色模型、双面、
父材质、节点数，以及标量/向量/贴图三类参数的名字和当前值。

**它不回图里的内容。** 节点、连线、以及写死在 Constant 节点上的值都不在返回里 ——
「这个材质现在长什么样」「那个颜色是在哪个节点上写死的」要用 material_get_graph
（带 include_values）。拿本工具的返回当整张图的现状会漏掉一大半。

修改材质前先用它确认现状。material_set_param 只认这里列出来的参数名 ——
引擎侧不校验名字，拼错了会「成功」但毫无效果。`,
  input: z.object({
    path: z.string().describe('材质资产路径，如 /Game/Materials/MI_Wood')
  })
})

interface SetMaterialPropertyResponse {
  material_path: string
  updated_properties?: string[]
  failed_properties?: Array<{ name?: string; error?: string; valid_values?: string[] }>
  current_state?: { blend_mode?: string; two_sided?: boolean }
}

const setMaterialProperty = defineUeTool<z.ZodTypeAny, SetMaterialPropertyResponse>({
  name: 'material_set_property',
  namespace: NAMESPACE,
  method: 'material.set_property',
  risk: 'mutating',
  // 和图表编辑改的是同一个材质对象，并发会互相覆盖
  concurrency: 'sequential',
  description: `修改已有母材质的混合模式 / 着色模型 / 双面渲染。

只能改 UMaterial（母材质）；材质实例的这些属性跟着父材质走，改不了。
改完要 material_compile 才会生效。

做半透明要**两步**：blend_mode 设成 Translucent，再把不透明度接到主节点的 Opacity 引脚。
只设 blend_mode 而不接 Opacity，材质依然是全不透明的 —— 这一步漏掉不会有任何报错。`,
  input: z.object({
    path: z.string().describe('母材质路径，如 /Game/Materials/M_Glass'),
    properties: z
      .object({
        blend_mode: z.enum(BLEND_MODES).optional().describe('混合模式'),
        shading_model: z.enum(SHADING_MODELS).optional().describe('着色模型'),
        two_sided: z.boolean().optional().describe('是否双面渲染')
      })
      // 一项都不填时引擎侧回 400，而那条 400 里没有 message 字段，
      // 传到模型手上只剩「未提供失败原因」。挡在这里给的信息比它多。
      .refine((p) => Object.values(p).some((v) => v !== undefined), {
        message: 'properties 至少要填 blend_mode / shading_model / two_sided 其中一项'
      })
      .describe('要修改的属性，至少填一项')
  }),
  toOutcome: (r) => {
    const updated = r.updated_properties ?? []
    const failed = r.failed_properties ?? []

    const lines = [
      `${r.material_path} 已更新 ${updated.length} 项${updated.length ? `：${updated.join('、')}` : ''}。`
    ]
    for (const f of failed) {
      lines.push(
        `❌ ${f.name ?? '未知属性'}：${f.error ?? '未说明原因'}` +
          (f.valid_values?.length ? `（合法值：${f.valid_values.join('、')}）` : '')
      )
    }
    lines.push('改动要 material_compile 之后才生效。')

    return { text: lines.join('\n'), details: r }
  }
})

const setMaterialParam = defineUeTool({
  name: 'material_set_param',
  namespace: NAMESPACE,
  method: 'material.set_param',
  risk: 'mutating',
  description:
    '批量设置 MaterialInstanceConstant 的参数值。value 支持数值、布尔、贴图路径、颜色对象或向量对象。',
  input: z.object({
    path: z.string().describe('MaterialInstanceConstant 资产路径'),
    params: MaterialParamListSchema.describe(
      '参数更新列表。每项包含 name 和 value，value 支持数值、布尔、贴图路径、颜色对象或向量对象'
    )
  }),
  /**
   * 引擎侧要的是**字典** `{"Roughness": 0.3}`，模型侧给的是**数组**
   * `[{name, value}]`（数组的 schema 对模型更清楚，也能保住顺序）。
   *
   * 漏掉这次转换的后果是这个工具**永远不可能成功**：插件用
   * `TryGetObjectField("params")` 取值，拿到数组会判定为「字段缺失」，
   * 回一句 `Missing required field: params` —— 而模型明明传了 params，
   * 于是只会换着花样重发，直到撞上熔断。
   *
   * `materialParamEntriesToRecord` 本来就是为这件事写的，
   * 迁移到 defineUeTool 时没接上。真机验证时这个工具 100% 失败才发现。
   */
  toParams: ({ path, params }) => ({
    path,
    params: materialParamEntriesToRecord(params)
  })
})

interface GraphNode {
  node_id: string
  class?: string
  guid?: string
  value?: unknown
  /** 节点上的注释（引擎侧的 `Expression->Desc`）。手搓的图里这是唯一的自然语言线索 */
  description?: string
  inputs?: Array<{ name: string; is_connected?: boolean; type?: string }>
  outputs?: Array<{ name: string; index?: number; type?: string }>
  reroute_kind?: string
  reroute_name?: string
  reroute_declaration_node?: string
  reroute_error?: string
}

interface GetGraphResponse {
  material_name?: string
  material_path?: string
  nodes?: GraphNode[]
  node_count?: number
  connections?: Array<{
    from_node?: string
    from_pin?: string
    from_output?: number
    to_node?: string
    /** 目标**输入**引脚。引擎侧的键名是 `to_input`，不是和 `from_pin` 对称的 `to_pin` */
    to_input?: string
    from_type?: string
    to_type?: string
  }>
  connection_count?: number
  material_pins?: string[]
  use_material_attributes?: boolean
  note?: string
}

/**
 * 节点当前值压成一行。贴图节点回的是路径字符串，颜色回 {r,g,b}，UV 回 {u_tiling,…}。
 *
 * **空串要说出来，不能当成「没有值」。** 引擎对两种情况恰好回空串：
 * 没挂贴图的 TextureSample / TextureObject，和四位全 0 的 ComponentMask。
 * 把它们跟 Add / Multiply 这种本来就没有值的节点渲染成一样，
 * 「这五个 TextureSample 里哪个还没挂图」就答不上来了 —— 而那正是这个回显存在的理由。
 */
function formatNodeValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value === '' ? '(未设置)' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** `Coordinates float2` —— 引脚名带上类型，没有类型就只给名字 */
function formatPin(pin: { name: string; type?: string }): string {
  return pin.type ? `${pin.name} ${pin.type}` : pin.name
}

const getMaterialGraph = defineUeTool<z.ZodTypeAny, GetGraphResponse>({
  name: 'material_get_graph',
  namespace: NAMESPACE,
  method: 'material.get_graph',
  risk: 'safe',
  description: `读取材质图表的全部节点与连线。改图之前**必须**先调它拿到真实的 node_id，不要凭猜测连线。

排查已有材质时看这三样，比读连线本身有用：

- **引脚类型**：每个 inputs/outputs 带 type，连线带 from_type / to_type。
  复杂材质最常见的编译错误就是类型不匹配（float3 接进只吃 float 的引脚），
  图上完全看不出来，只有对比类型才看得见。
- **use_material_attributes**：为 true 时主节点上只有 MaterialAttributes 那一根有效，
  往 BaseColor 上连线会「成功」但毫无效果。
- **reroute_declaration_node**：命名重定向的 usage 指向哪个 declaration。
  顺着连线往回追，追到 usage 不算断，接着从 declaration 往上走。

每个节点还带一个 **guid**。node_id 是按数组下标编的，**删掉任何一个节点，
后面所有节点的 node_id 都会往前挪一位** —— 拿着删除或撤销之前读到的 node_id
回来改图，改中的是另一个节点，而且不会报错。跨过删除/撤销之后一律用 guid，
两种 id 传哪个都认。`,
  input: z.object({
    path: z.string().describe('材质资产路径，如 /Game/Materials/M_Wood'),
    include_values: z.boolean().optional().default(true).describe('是否包含节点当前值')
  }),

  /**
   * 排过版的读图结果，不是一坨 `JSON.stringify`。
   *
   * 这里以前没有 toOutcome，走的是 defineUeTool 的默认分支 ——
   * 整张图序列化成一行 JSON 丢给模型。三十个节点起就没法读了：真机上一个
   * 子 agent 要找五张贴图分别挂在哪个 TextureSample 上，在那坨里没找着，
   * 于是**猜了节点编号**（报 `_8/_25/_58/_75/_85`，实际是 `_0/_4/_5/_9/_10`），
   * 最后还得另外写 Python 遍历一遍才拿到。
   *
   * 贴图路径其实一直在返回体里（引擎侧 `ReadNodeValue` 对贴图节点回完整路径，
   * `include_values` 默认就是 true）——**读不出来不等于没给**。所以这里修的不是
   * 缺字段，是可读性。
   *
   * 三样东西必须留在正文里，不能只躺在 details（模型看不到 details）：
   *   · guid —— 跨过删除/撤销之后唯一指得准的 id
   *   · 每个节点的值 / 贴图路径 —— 判断「这张图在干什么」的主要依据
   *   · 输出引脚名 —— 从这个节点接出去时要写的名字（R/G/B 这些）
   */
  toOutcome: (r) => {
    const nodes = r.nodes ?? []
    const connections = r.connections ?? []
    const name = r.material_name ?? r.material_path ?? '材质'

    const lines = [`${name}：${nodes.length} 个节点，${connections.length} 根连线。`]

    // 开着材质属性时，主节点那一排引脚全是摆设 —— 往上连线会「成功」但毫无效果
    if (r.use_material_attributes) {
      lines.push(
        '⚠️ use_material_attributes=true：主节点上只有 MaterialAttributes 那一根有效，' +
          '往 BaseColor / Roughness 上连线会成功但没有任何效果。'
      )
    }
    if (r.note) lines.push(r.note)

    /*
     * 封顶，但**不能封掉 id**。
     *
     * 这个 toOutcome 是为了「三十个节点起就没法读了」写的，可它自己一开始一个上限
     * 都没有：一张量产母材质四百个节点、六百根线，每个节点行都带全部输入输出引脚
     * 加类型加 guid，一次工具结果十万字符起。
     *
     * 但直接 `slice(0, 60)` 是另一个极端：61 号之后的 node_id 和 guid 就**再也拿不到了**
     * —— 这个工具没有 node_id / offset 入参，别的工具也读不了图的一段，而
     * material_apply_graph 的描述又让模型「先用 material_get_graph 拿 node_id」。
     * 等于把它逼回猜编号，正是本文件上面那段注释里记的那次事故。
     *
     * 所以分两段：前 60 个给全貌（引脚、类型、值、注释），之后的只给
     * `node_id ｜ 类型 ｜ guid` 三件套 —— 一行几十个字符，四百个节点也就两万字符，
     * 尽量多留 id（拿着 id 能直接改值、删、断线、连线），但**不保证全留** ——
     * 八百个节点的图，任何一个说得过去的额度都列不完，那就如实说没列完；
     * 唯独「只读某一个节点」没有工具（本工具就是唯一的读图入口），
     * 所以下面那句提示里别写「拿 id 去读这个节点」—— 引脚要按类型去
     * material_search_nodes 查，那才是真能调的。
     */
    const MAX_GRAPH_NODES = 60
    const MAX_GRAPH_CONNECTIONS = 80
    /**
     * 简表按**字符**封顶，不按条数。
     *
     * 这里前后估错过两次：先估一行 50 字符、改成按条数封顶时又估 95 ——
     * 实测是 **203**（同一次改动把 value 加进了这一行，而 Megascans 的贴图路径
     * 单独就有 140 字符）。800 个节点实测下来：不列简表 15,781 字符、
     * 列 60 条 27,922、120 条 40,103、240 条 64,463。
     *
     * 条数根本不可能封住输出：行长取决于 value 这个长度不受控的字符串。
     * 所以改成累加字符、到额度就停 —— 这是真的上限，不是估出来的。
     * 配套有一条按实测字符数断言的用例，改坏了会红。
     */
    /**
     * 详列这半边也要按字符封顶，不能只封条数。
     *
     * 之前只给简表上了额度，可实测详列才是大头（60 条约 15.8k，简表 12k），
     * 而且它每行带 value、全部引脚名和类型，还可能跟一行长度不受控的节点注释 ——
     * 「条数封不住输出」这个理由对它只会更成立。800 节点带注释实测能到 36.7k。
     */
    const DETAIL_CHAR_BUDGET = 14_000
    /** 连线这一段的字符额度。理由同上：行长由两端 node_id 决定，条数封不住 */
    const CONNECTION_CHAR_BUDGET = 6_000
    const BRIEF_CHAR_BUDGET = 12_000
    const shownNodes = nodes.slice(0, MAX_GRAPH_NODES)
    /** 详列实际列了几个。字符额度可能比条数上限先到，剩下的全进简表 */
    let detailCount = 0

    /*
     * 连主节点的那些线要**单独拎出来先印**。
     *
     * 引擎侧 Handle_GetMaterialGraph 是先遍历每个表达式的输入、**最后**才补
     * UAL_CollectRootInputs（`to_node === "Material"` 那一批）。也就是说
     * `Material.BaseColor ←` 这几行永远排在数组最末尾 —— 一个 `slice(0, 80)`
     * 砍掉的恰恰是它们，而那正是读一张材质图的起点（从主节点倒着往回追）。
     * 主节点输入就那十几根，不占预算，全印。
     */
    const rootConnections = connections.filter((c) => c.to_node === 'Material')
    const innerConnections = connections.filter((c) => c.to_node !== 'Material')
    const shownInner = innerConnections.slice(0, MAX_GRAPH_CONNECTIONS)
    const shownConnections = [...rootConnections, ...shownInner]

    if (shownNodes.length > 0) {
      lines.push(
        '',
        '节点（node_id ｜ 类型 ｜ 值 ｜ 输入引脚（*=已接线）｜ 输出引脚 ｜ guid）。引脚名后面跟的是类型：'
      )
      let detailChars = 0
      for (const node of shownNodes) {
        const before = lines.length
        const value = formatNodeValue(node.value)
        /*
         * 引脚**带类型**，而且**已接线的输入也要列出来**。
         *
         * 类型：material_compile 编译失败时的那句提示（还有本工具自己的描述）
         * 都叫模型「回来看 inputs/outputs 里的 type」—— 只印名字的话那是条死路，
         * 类型只剩在 details 里，而 details 不进模型上下文。
         *
         * 已接线的输入：这里一度只印空着的。可「把这根线改接到别处」是常规操作，
         * 需要的正是那个**已经占着**的引脚名；而全部接满的 MaterialFunctionCall
         * 连 material_search_nodes 也帮不上（它的引脚来自函数资产，CDO 上是空的），
         * 读图是唯一的来源。所以全列，用 * 标出哪些已经接了。
         */
        const outputs = (node.outputs ?? []).map(formatPin).join(', ')
        const inputs = (node.inputs ?? [])
          .map((pin) => `${formatPin(pin)}${pin.is_connected ? '*' : ''}`)
          .join(', ')

        const parts = [`  ${node.node_id}`, node.class ?? '?']
        if (value) parts.push(value)
        if (inputs) parts.push(`in: ${inputs}`)
        if (outputs) parts.push(`out: ${outputs}`)
        if (node.guid) parts.push(node.guid)
        lines.push(parts.join(' ｜ '))

        // 节点上的注释是手搓材质里唯一的自然语言线索（「湿度遮罩，别动」
        // 「由 MPC_Weather 驱动」）。丢掉它，改图的人就会径直改过去
        // 注释是设计师随手写的自由文本，没有长度上限 —— 截一下，
        // 否则详列这半边（本来就是更大的一半）照样可以无限长
        if (node.description) {
          // 判长度和切的必须是**同一个单位**。上一版判 `.length`（UTF-16 码元）、
          // 切 `[...]`（码点），于是 125 个 emoji（250 码元 / 125 码点）走进截断分支、
          // 一个字都没切掉，却挂上了「（截断）」—— 模型以为有内容被藏了，
          // 而这个工具没有「只读一个节点」的入口，它找不回来。顺带上限也虚了一倍。
          const chars = [...node.description]
          const note =
            chars.length > 200 ? `${chars.slice(0, 200).join('')}…（截断）` : node.description
          lines.push(`      ※ 节点注释：${note}`)
        }

        // 命名重定向：图上是两个孤立节点，实际是一根线的两头。
        // 顺着连线追到 usage 就断了，得从它对应的 declaration 接着往上走
        if (node.reroute_kind === 'usage') {
          lines.push(
            `      ↳ 重定向 usage「${node.reroute_name ?? '?'}」，` +
              (node.reroute_error
                ? `❌ ${node.reroute_error}`
                : `接着从 ${node.reroute_declaration_node ?? '?'} 往上追`)
          )
        }

        detailCount++
        // 按这个节点**实际吐了多少字**计费：一个节点可能吐 1~3 行
        // （主行 + 注释 + 重定向），行长又取决于引脚数和 value，条数算不出来
        for (let i = before; i < lines.length; i++) detailChars += lines[i].length + 1
        if (detailChars > DETAIL_CHAR_BUDGET) break
      }
      const briefNodes = nodes.slice(detailCount)
      if (briefNodes.length > 0) {
        /*
         * 这句话里只准出现**真的能调**的东西。
         *
         * 没有「只读一个节点」的工具（全套材质工具里唯一的读图入口就是本工具，
         * 而它没有 node_id 入参）。所以别写「拿 node_id 去读这个节点」——
         * 那是条死路，模型会照着试然后卡住。
         * 真正能做的是：引脚按**类型**查（material_search_nodes，引脚是类的属性
         * 不是实例的），上下游看下面的连线，改值/删/断线都用这个 node_id 直接下手。
         */
        /*
         * 先按字符额度攒出简表，再决定标题里写几条。
         *
         * 值**要带上**，别只给 id 和类型：这个文件开头记的那次事故就是
         * 「五张贴图分别挂在哪个 TextureSample 上」，而贴图路径正存在 value 里。
         * 引脚还能按类型去 search_nodes 查，值没有任何别的来源 ——
         * 所以值要留，代价则由下面这个额度兜住。
         */
        const briefLines: string[] = []
        let briefChars = 0
        for (const node of briefNodes) {
          const value = formatNodeValue(node.value)
          const parts = [`  ${node.node_id}`, node.class ?? '?']
          if (value) parts.push(value)
          if (node.guid) parts.push(node.guid)
          const line = parts.join(' ｜ ')
          /*
           * break 不是 continue：**列出来的必须是一段连续的前缀**。
           *
           * 一度改成 continue（「长行不该把后面的短行挤掉」），但那样跳掉的恰恰是
           * 最长的那些行 —— 也就是带 Megascans 贴图路径的节点，而简表加上 value
           * 就是为了留住它们。而且列出来的成了断续的：读到 Node_81、Node_83，
           * 谁都会以为 Node_82 不存在，本文件开头记的就是模型猜节点号那次事故。
           * 下面那句「还有 N 个没列」说的是一条尾巴，break 才让这句话是真的。
           *
           * +1 是每行拼接时多花的那个换行符。
           */
          if (briefChars + line.length + 1 > BRIEF_CHAR_BUDGET) break
          briefLines.push(line)
          briefChars += line.length + 1
        }

        lines.push(
          `  （下面 ${briefLines.length} 个节点只给 node_id ｜ 类型 ｜ 值 ｜ guid，引脚没展开。` +
            '这些 id 照样能直接用于 material_set_node_value / material_delete_node / ' +
            'material_disconnect_pins 和 material_apply_graph 的连线；' +
            '想知道某一类的引脚名，把类名去掉 MaterialExpression 前缀拿去 material_search_nodes 查）：'
        )
        lines.push(...briefLines)

        /*
         * 额度用完了只能如实说「读不完」。
         *
         * 本工具没有 offset / 过滤入参，给不出「接着读下一段」的办法，
         * 那就别编一个 —— 能给的真办法是从连线往回缩小范围。
         */
        if (briefNodes.length > briefLines.length) {
          lines.push(
            `  …还有 ${briefNodes.length - briefLines.length} 个节点连简表都没列（全图共 ${nodes.length} 个）。` +
              '这张图超出了一次能读完的规模：先看下面的连线，从主节点往回锁定你关心的那一段，' +
              '再按那几个 node_id 动手。'
          )
        }
      }
    }

    if (shownConnections.length > 0) {
      lines.push('', '连线：')
      /*
       * 连线这一段也按字符封顶。
       *
       * 前两段（详列、简表）都上了额度，唯独这里还只有条数上限 ——
       * 而行长取决于两端的 node_id，节点名长起来一根线就上百字符：
       * 800 节点 600 连线实测能给整段输出再加 7.6k，直接顶穿总量断言。
       * 「条数封不住输出」这个理由对它和对前两段一样成立。
       *
       * 主节点那几根仍然优先：它们排在 shownConnections 前面，
       * 额度先花在它们身上，用完了截掉的是节点间的连线。
       */
      let connChars = 0
      let connShown = 0
      for (const conn of shownConnections) {
        /*
         * 两端的类型如实并列，**不替调用方判「这算不算不匹配」**。
         *
         * 这里一度是「两端不一样就打个 ⚠️」。真机上第一次跑就证明那样会喊狼来了：
         * `Constant3Vector` 的 G 输出（1 个通道）引擎回的 from_type 是 `float3`，
         * 接进 Roughness 就被标成「float3 → float 不匹配」—— 而那根线完全正确。
         * 引擎的类型标注对带 mask 的输出本来就不精确，自动转换规则也有一堆特例。
         * 假警报比不报更糟：模型会掉头去查一个不存在的问题。
         *
         * 插件侧对这件事早有结论（AddConnection 的注释），这里跟它保持一致。
         */
        const types =
          conn.from_type && conn.to_type ? `  [${conn.from_type} → ${conn.to_type}]` : ''
        // 四个字段都是可选的。老插件只回 from_output 不回 from_pin，
        // 不兜一下就是满屏 `….undefined → Material.BaseColor` ——
        // 而引脚名恰恰是重接时要填的那个词
        const fromPin =
          conn.from_pin ?? (conn.from_output !== undefined ? `<${conn.from_output}>` : '?')
        const line = `  ${conn.from_node ?? '?'}.${fromPin} → ${conn.to_node ?? '?'}.${conn.to_input ?? '?'}${types}`
        if (connChars + line.length + 1 > CONNECTION_CHAR_BUDGET) break
        lines.push(line)
        connChars += line.length + 1
        connShown++
      }
      const connOmitted = connections.length - connShown
      if (connOmitted > 0) {
        lines.push(
          `  …另有 ${connOmitted} 根连线没列（共 ${connections.length} 根）。` +
            '上面连主节点的那几根优先列，从它们往回追。'
        )
      }
    }

    if (r.material_pins?.length) {
      lines.push('', `主节点可用引脚：${r.material_pins.join('、')}`)
    }

    lines.push(
      '',
      '改图用 material_apply_graph，两端填上面的 node_id（或 guid）加引脚名。' +
        '不认识某个节点类型的引脚就先 material_search_nodes 查，别猜。'
    )

    return { text: lines.join('\n'), details: r }
  }
})

const compileMaterial = defineUeTool({
  name: 'material_compile',
  namespace: NAMESPACE,
  method: 'material.compile',
  risk: 'mutating',
  concurrency: 'sequential',
  // 编译是材质里最慢的一步，30s 不够
  timeoutMs: 120_000,
  description: `编译材质。改完图表或改完 material_set_property 之后**都要**调它，否则改动不生效。

注意编译错误是**会随改动出现的**：一条接在 Opacity 上的链，混合模式是 Opaque 时不参与
编译（不报错），改成 Translucent 之后同一张图就会报错。所以改完属性要重新编译一次。

编译不落盘，完事记得 ue_save。`,
  input: z.object({
    path: z.string().describe('材质资产路径，如 /Game/Materials/M_Wood'),
    force_recompile: z
      .boolean()
      .optional()
      .default(false)
      .describe('是否强制重新编译（即使材质未修改）')
  }),
  /**
   * 编译失败不是异常，是一个 200 加一个 `compiled: false` —— 埋在 JSON 里
   * 模型多半会略过去，然后拿着一个编不过的材质继续往下做。
   * 把错误顶到最前面，别让它看起来像成功。
   */
  toOutcome: (r: {
    material_name?: string
    compiled?: boolean
    errors?: string[]
    warnings?: string[]
    error_nodes?: { node_id?: string; class?: string; error?: string; note?: string }[]
  }) => {
    const errors = r.errors ?? []
    const warnings = r.warnings ?? []
    const errorNodes = r.error_nodes ?? []

    const lines =
      r.compiled === false || errors.length > 0
        ? [
            `❌ ${r.material_name} 编译失败，${errors.length} 个错误：`,
            ...errors.map((e) => `  ${e}`)
          ]
        : [`✅ ${r.material_name} 编译通过。`]

    /*
     * 错误文本只说得出「哪个引脚不对」，说不出是哪个节点 —— 上百个节点的图里
     * 光靠引脚名找不到人，只能挨个猜着试。引擎自己知道是谁（材质编辑器就是
     * 靠这份列表标红的），把它顶到摘要里，省掉那一轮猜。
     */
    if (errorNodes.length) {
      lines.push(`出错的节点（${errorNodes.length} 个）：`)
      for (const node of errorNodes) {
        lines.push(
          `  ${node.node_id ?? '未知节点'}（${node.class ?? '未知类型'}）` +
            (node.error ? `：${node.error}` : '') +
            (node.note ? ` ※ ${node.note}` : '')
        )
      }
      lines.push(
        '用 material_get_graph 看这几个节点的引脚类型（inputs/outputs 里的 type），' +
          '对不上的那根线才是要改的地方 —— 不要凭引脚名猜。'
      )
    }

    if (warnings.length) {
      lines.push(`⚠️ ${warnings.length} 个警告：`, ...warnings.map((w) => `  ${w}`))
    }

    return { text: lines.join('\n'), details: r }
  }
})

const setMaterialNodeValue = defineUeTool({
  name: 'material_set_node_value',
  namespace: NAMESPACE,
  method: 'material.set_node_value',
  risk: 'mutating',
  concurrency: 'sequential',
  description: `修改材质图表中某个已有节点的值。

能设值的节点：Constant、Constant2/3/4Vector、ScalarParameter、VectorParameter、
TextureSample、TextureObject、TextureCoordinate、ComponentMask。
纯运算节点（Add、Multiply、Sine…）没有值可设，对它们调这个工具会返回 400。
拿不准某个类型能不能设值，用 material_search_nodes 看它的 has_value。

**ComponentMask 的「值」是取哪几个通道**，写成 "R" / "RG" / "RGB" / "A"
（xyzw 拼法也认）。取 float2 的 x 就是 value="R"，取 y 就是 value="G" ——
不要再用 DotProduct 绕。**通道只能升序不重复** —— "GR" / "RR" 会被拒，那个节点底下只有四个开关，换不了序。**回读一律用 RGBA 拼法**：传 "XY" 回来的是 "RG"，
那是同一件事，不是没设上。

返回体里的 new_value 是**回读**出来的实际值，不是把入参原样回显 —— 可以直接拿它确认改动落上了。`,
  input: z.object({
    path: z.string().describe('材质资产路径，如 /Game/Materials/M_Wood'),
    node_id: z.string().describe('节点 ID（引擎生成，猜不出来 —— 用 material_get_graph 读）'),
    value: MaterialValueSchema.describe(
      '要设置的值：数值（标量节点）、贴图路径字符串（贴图节点）、' +
        '{r,g,b,a?} 或 {x,y,z?,w?} 或 [r,g,b] 数组（颜色/向量节点）、' +
        '{u_tiling,v_tiling}（TextureCoordinate）。给颜色节点一个数值会按灰度铺开'
    )
  }),
  toParams: toMaterialPath
})

const deleteMaterialNode = defineUeTool({
  name: 'material_delete_node',
  namespace: NAMESPACE,
  method: 'material.delete_node',
  // 删节点不可逆
  risk: 'destructive',
  concurrency: 'sequential',
  description: `从材质图表中删除一个节点。指向它的连线会一并断开。

删完要 material_compile 才知道图还成不成立。`,
  input: z.object({
    path: z.string().describe('材质资产路径，如 /Game/Materials/M_Wood'),
    node_id: z.string().describe('要删除的节点 ID（引擎生成，用 material_get_graph 读）')
  }),
  toParams: toMaterialPath,
  /*
   * 断了几根线要说出来。
   *
   * 这里以前是「删了就完事」：引擎侧根本没断线，返回里 disconnected_count 恒为 0，
   * 图里留下指向已删节点的悬空连线，材质从此编不过 —— 而删除报的是成功。
   * 现在真断了，就把数字给出来，让调用方知道自己顺带改了几根线。
   */
  toOutcome: (r: { node_id?: string; disconnected_count?: number }) => {
    const disconnected = r.disconnected_count ?? 0
    return {
      text:
        `已删除节点 ${r.node_id}，disconnected_count = ${disconnected}` +
        (disconnected > 0
          ? `（断开了 ${disconnected} 根连到它的线，这些引脚现在是空的，需要的话重新接）。`
          : '（没有线连到它）。') +
        '\n删完用 material_compile 确认图还编得过。',
      details: r
    }
  }
})

interface MaterialGraphResponse {
  nodes?: Array<{ node_id: string; class?: string }>
  connections?: Array<{ from_node: string; to_node: string }>
  material_node_position?: { x: number; y: number }
}

/**
 * `material_tidy_graph` —— 把一张材质图重新排版。
 *
 * 蓝图有 `blueprint_tidy_graph`，材质一直没有。而 `material_add_node` 不传
 * `position` 时坐标是 (0,0)，所以**照着工具链一步步建出来的材质，节点全叠在原点**
 * ——功能上没问题，打开一看是一坨。用户要接着手改的时候，先得自己拖半天。
 *
 * 两次 RPC 加中间一次排版，所以走 defineTool 而不是 defineUeTool（后者只做一次调用）。
 */
const TidyGraphSchema = z.object({
  path: z.string().describe('材质资产路径，如 /Game/Materials/M_Wood')
})

interface TidyGraphDetails {
  moved?: number
  not_found?: string[]
  positions?: Array<{ node_id: string; x: number; y: number }>
  nodes?: Array<{ node_id: string }>
}

const tidyMaterialGraph = defineTool<typeof TidyGraphSchema, TidyGraphDetails>({
  name: 'material_tidy_graph',
  namespace: NAMESPACE,
  risk: 'mutating',
  // 改的是同一份图表的坐标，并发会互相覆盖
  concurrency: 'sequential',
  description: `把一张材质图重新排版，让它顺着数据流从左到右排、材质主节点在最右边。

**只挪位置，不改任何节点、连线和数值。** 材质本身一个字都不会变，也不需要重新编译。

什么时候用：
- 图看起来乱：节点重叠、连线到处交叉
- 用户手搓的材质想整理一下

**material_apply_graph 写完的图不用再排** —— 它自己排过了，这里只对付别处来的乱图。

**别拿 material_apply_graph 当排版用。** 它不传 nodes 也确实会排，但 compile 默认开着，
于是「只想理一理」会顺带重新编译一次材质；而排版本身根本不需要编译。要排版就用这个。

排完可以用 ue_screenshot 看效果。改动可撤销（Ctrl+Z）。`,
  input: TidyGraphSchema,
  execute: async ({ path }, ctx) => {
    // signal 往下传：不传的话用户按停止只是把结果丢掉，
    // 这两条 RPC 还在暂存池里各占满一个超时
    const graph = await callUe<MaterialGraphResponse>(
      'material.get_graph',
      { path, include_values: false },
      { signal: ctx.signal }
    )

    const nodes = graph.nodes ?? []
    if (nodes.length === 0) {
      return { text: `${path} 里没有任何节点，不用排版。`, details: { moved: 0, nodes: [] } }
    }

    const positions = await layoutMaterialNodes(
      nodes,
      graph.connections ?? [],
      // 主节点的位置就是锚点：排完它原地不动，表达式全排到它左边。
      // 拿不到就退回 (0,0)（新建的材质主节点就在那儿）
      graph.material_node_position ?? { x: 0, y: 0 }
    )

    const applied = await callUe<{ moved?: number; not_found?: string[] }>(
      'material.set_node_positions',
      { material_path: path, positions },
      { signal: ctx.signal }
    )

    const notFound = applied.not_found ?? []
    return {
      text:
        `已重排 ${applied.moved ?? 0}/${nodes.length} 个节点，材质主节点保持原位。` +
        (notFound.length
          ? `\n⚠️ ${notFound.length} 个节点没找到（图在这中间被改过？）：${notFound.join('、')}`
          : ''),
      details: { positions, ...applied }
    }
  }
})

/**
 * 断线。
 *
 * 在它之前图**只能往上加，不能往回收** —— 接错一根线只有两条路：
 * 把节点整个删了重建（顺带丢掉它身上其他正确的连线），或者留着不管（编译失败）。
 * 两条都不对，而「接错一根线」在边试边搭的过程里几乎必然发生。
 */
const disconnectMaterialPins = defineUeTool({
  name: 'material_disconnect_pins',
  namespace: NAMESPACE,
  method: 'material.disconnect_pins',
  risk: 'mutating',
  description: `断开材质图里的一条连线。

断的是**输入端**：一个输入只能接一根线，指定输入就唯一确定了这根线。
输出端可以同时接出去好几根，光说「断开某个输出」是有歧义的，所以不支持。

target_node 填 "Material" 断的是材质主节点上的输入（BaseColor / Roughness 等），
填 node_id 断的是普通节点上的输入。target_pin 省略时断第一个输入。

本来就没接线不算失败 —— 想「确保这里是断的」时直接调即可，
不用先查一遍再决定。

断完要 material_compile 才生效。`,
  input: z.object({
    path: z.string().describe('材质资产路径，如 /Game/Materials/M_Wood'),
    target_node: z
      .string()
      .describe(
        '要断开输入的那个节点。材质主节点填 "Material"，其余填 material_get_graph 读到的 node_id'
      ),
    target_pin: z
      .string()
      .optional()
      .describe(
        '输入引脚名。主节点如 BaseColor / Roughness / EmissiveColor；' +
          '普通节点如 A / B / Alpha。省略时断第一个输入（单输入节点直接省略即可）'
      )
  }),
  toParams: toMaterialPath
})

/**
 * 清理死节点。
 *
 * 边试边搭出来的图里总会剩下一堆没接上的节点。它们不影响渲染，但
 * 每次 `material_get_graph` 都要重读一遍，而且模型会被这些无主节点带偏
 * （「这个 Multiply 是干嘛的？要不要接上？」）。
 *
 * **默认只报不删**：删除不可逆，而模型「顺手清理一下」时很容易把自己
 * 下一步还要用的中间节点一起清掉。
 */
const deleteUnusedMaterialNodes = defineUeTool({
  name: 'material_delete_unused_nodes',
  namespace: NAMESPACE,
  method: 'material.delete_unused_nodes',
  // dry_run 默认为真，但这个工具**能**删东西，风险按最坏情况声明
  risk: 'destructive',
  description: `找出并删除对最终输出没有贡献的材质节点。

从材质主节点的各个输入反向走一遍，走不到的就是死节点。

**默认 dry_run=true，只报不删。** 先看一眼名单，确认里面没有你下一步还要用的
中间节点，再用 dry_run=false 调一次。

图搭完之后清理一次很值：之后每次 material_get_graph 都少读一批无关节点。`,
  input: z.object({
    path: z.string().describe('材质资产路径，如 /Game/Materials/M_Wood'),
    dry_run: z
      .boolean()
      .optional()
      .default(true)
      .describe('true（默认）只列出不删除；确认名单之后传 false 才真的删')
  }),
  toParams: toMaterialPath
})

/**
 * 材质参数集合（MPC）。
 *
 * 「一个开关控制全场景材质」的标准做法：昼夜、季节、队伍配色、受击闪白。
 * 参数放在一个 MPC 资产里，任意数量的材质引用它，运行时改一处全场景跟着变。
 *
 * 没有它的时候，这类需求只能退化成「逐个材质实例去改参数」——
 * 材质一多就不可行，而且**运行时根本改不了**（材质实例的参数是编辑期的）。
 */
const materialParameterCollection = defineUeTool<
  z.ZodTypeAny,
  {
    collection_path: string
    collection_name: string
    created?: boolean
    scalars: Array<{ name: string; value: number }>
    vectors: Array<{ name: string; value: { r: number; g: number; b: number; a: number } }>
    scalar_slots_left: number
    vector_slots_left: number
    rejected?: string
  }
>({
  name: 'material_parameter_collection',
  namespace: NAMESPACE,
  method: 'material.parameter_collection',
  risk: 'mutating',
  description: `材质参数集合（MaterialParameterCollection，MPC）：建 / 查 / 改。

**「一个开关控制全场景材质」就用它。** 昼夜变化、季节、队伍配色、全场受击闪白 ——
参数放在一个 MPC 里，多少个材质引用它都行，运行时改一处全场景跟着变。

不要用「逐个材质实例改参数」代替：材质一多就不可行，而且实例参数是编辑期的，
运行时改不了。

三个动作：
- create：建一个新的 MPC，可以顺便把参数一起建了
- list：看里面有哪些参数、当前默认值、还剩几个位置
- set：改默认值，或往已有的 MPC 里加参数

**建完还有一步**：用 material_apply_graph 往材质里加一个 CollectionParameter 节点，
节点上带 collection_path 和 node_name（参数名）。
不做这步的话 MPC 建了也不影响任何东西。

标量和向量各最多 16 个，这是引擎的硬上限，超了会被拒绝并在 rejected 里说明。`,
  input: z.object({
    action: z.enum(['create', 'list', 'set']).describe('create 新建；list 只读查看；set 改参数'),
    collection_path: z
      .string()
      .optional()
      .describe('MPC 资产路径，action 是 list/set 时必填，如 /Game/Materials/MPC_Weather'),
    collection_name: z
      .string()
      .optional()
      .describe('新建时的资产名，action=create 时必填。习惯以 MPC_ 开头'),
    destination_path: z.string().optional().describe('新建时的保存路径，默认 /Game/Materials'),
    scalars: z
      .array(
        z.object({
          name: z.string().describe('参数名，如 Wetness'),
          value: z.number().describe('默认值')
        })
      )
      .optional()
      .describe('标量参数。名字已存在就改值，不存在就新增'),
    vectors: z
      .array(
        z.object({
          name: z.string().describe('参数名，如 SkyTint'),
          value: MaterialValueSchema.describe('默认值：{r,g,b,a?} 或 [r,g,b,a?]')
        })
      )
      .optional()
      .describe('向量/颜色参数。名字已存在就改值，不存在就新增')
  }),
  /**
   * 把「还剩几个位置」和「哪些被拒了」顶到前面。
   *
   * 16 个是引擎硬上限，超了引擎会静默丢弃 —— 调用方拿到一个「成功」，
   * 然后在材质里怎么也引用不到那个参数，而错误现场早就过去了。
   */
  toOutcome: (r) => {
    const lines = [
      `${r.created ? '已创建' : '已更新'}参数集合 ${r.collection_name}（${r.collection_path}）。`
    ]

    if (r.scalars.length) {
      lines.push(`标量：${r.scalars.map((s) => `${s.name}=${s.value}`).join('、')}`)
    }
    if (r.vectors.length) {
      lines.push(`向量：${r.vectors.map((v) => v.name).join('、')}`)
    }
    if (!r.scalars.length && !r.vectors.length) {
      lines.push('里面还没有任何参数。')
    }

    if (r.rejected) {
      lines.push(`⚠️ 有参数没加上：${r.rejected}`)
    }
    lines.push(`剩余位置：标量 ${r.scalar_slots_left}，向量 ${r.vector_slots_left}（各上限 16）。`)
    lines.push(
      '下一步：material_apply_graph 加一个节点 node_type="CollectionParameter"，' +
        `collection_path="${r.collection_path}"，node_name=参数名。`
    )

    return { text: lines.join('\n'), details: r }
  }
})

/**
 * 材质函数。
 *
 * 同一串节点用在三个材质里就该抽成函数：改一次三个都跟着变。
 * 此前只能在每个材质里重搭一遍 —— 搭得越多越不敢改。
 */
const createMaterialFunction = defineUeTool<
  z.ZodTypeAny,
  { function_path: string; function_name: string }
>({
  name: 'material_create_function',
  namespace: NAMESPACE,
  method: 'material.create_function',
  risk: 'mutating',
  description: `创建材质函数（MaterialFunction）——一组节点的可复用封装。

同一串节点要用在多个材质里就抽成函数：改一次，所有引用它的材质都跟着变。
不抽的话每个材质各搭一遍，搭得越多越不敢改。

**建出来是空的，而且这套工具现在填不了它。** 图表类命令（material_apply_graph /
material_get_graph）只认 UMaterial，传函数路径一律回 "Material not found"；
FunctionOutput 也不在可建的节点类型里。所以别去试，会白跑好几轮还在用户工程里
留下一个永远空着的函数资产。

现在能走通的只有两条路：
- 让用户在材质编辑器里手工填这个函数（建好之后告诉他路径）；
- 或者干脆别抽函数 —— 在每个材质里用 material_apply_graph 把那串节点搭出来。

已经填好的函数照样能用：material_apply_graph 加一个 node_type="MaterialFunctionCall"，
function_path 填这里返回的路径。`,
  input: z.object({
    function_name: z.string().describe('函数名，习惯以 MF_ 开头，如 MF_Wetness'),
    destination_path: z.string().optional().describe('保存路径，默认 /Game/Materials'),
    description: z.string().optional().describe('函数说明，会显示在材质编辑器的节点菜单里')
  }),
  toOutcome: (r) => ({
    text:
      `已创建材质函数 ${r.function_name}（${r.function_path}），当前是空的。\n` +
      '⚠️ 这套工具**填不了它**：图表命令只认 UMaterial，拿这个路径去调 ' +
      'material_apply_graph 会回 "Material not found"。要么请用户在材质编辑器里手工填，' +
      '要么改用「在每个材质里直接搭那串节点」。\n' +
      `填好之后在材质里引用：material_apply_graph 加一个节点 node_type="MaterialFunctionCall"，function_path="${r.function_path}"。`,
    details: r
  })
})

/**
 * 反查谁在用这个资产。
 *
 * 改之前问一句、删之前问一句。此前只能靠人去编辑器里点「引用查看器」，
 * 于是模型改一个被十几个材质引用的母材质时，完全不知道自己动了多大范围。
 */
const getMaterialReferencers = defineUeTool<
  z.ZodTypeAny,
  {
    asset_path: string
    referencer_count: number
    referencers: Array<{ path: string; class?: string }>
    truncated: boolean
    unsaved_package_count?: number
    incomplete_reason?: string
  }
>({
  name: 'material_get_referencers',
  namespace: NAMESPACE,
  method: 'material.get_referencers',
  risk: 'safe',
  description: `查一个资产被哪些别的资产引用了（材质、贴图、材质函数、参数集合都能查）。

**改母材质或删资产之前先问一句。** 一个母材质可能被十几个材质实例继承，
改它的参数结构会一起影响到；一张贴图没人用了才能安全删。

返回带上每个引用者的类型，方便区分「被材质实例引用」和「被关卡引用」。

【和另外两个查引用的分工】三者读的是**同一份**资产注册表，不会互相矛盾，差别在形状：
- 本工具：**一层**引用者 + 未保存包的警告。「这张贴图能不能删」问它，那句警告是关键
- ue_content_dependencies：**递归整条链**，还分内部/外部、列断链。整理或搬迁目录时用它
- ue_content_describe：资产总览里顺带给一层，你本来就在读这个资产时用它，不必再单调一次

**未保存的资产查不到。** 引用关系是从已落盘的包里读的 —— 刚建好或刚改完还没存的
引用不在索引里。所以拿这个结果去决定删不删之前，先 ue_save 把**你自己改的**存下来
（默认档就是这个意思）。存完还有未保存的包，那是用户手改到一半的东西：
用 ue_list_unsaved 看是哪些，**问他**，不要自己上 scope=all 替他按「保存全部」。
有未保存的包时返回里会带 unsaved_package_count 和警告，别忽略。

只读，不改任何东西。`,
  input: z.object({
    path: z.string().describe('要查的资产路径，如 /Game/Materials/M_Wood'),
    limit: z.number().int().optional().describe('最多回几条，默认 50，上限 500')
  }),
  toParams: toAssetPath,
  /**
   * 「没人引用」这个答案最危险。
   *
   * 引用关系是从**已落盘的包**里读的，刚建好或刚改完还没存的引用不在里面。
   * 于是「这张贴图还有人用吗」会答「没有」，用户照着删掉，下次打开工程
   * 一片丢失引用。真机验证第一次跑就撞上了这个。
   *
   * 所以有未保存的包时，绝不能说「删掉不会影响别的东西」——
   * 那句话在那个前提下是假的。
   */
  toOutcome: (r) => {
    const stale = (r.unsaved_package_count ?? 0) > 0

    if (r.referencer_count === 0) {
      return {
        text: stale
          ? `${r.asset_path} 在**已保存的资产**里没有被引用。\n` +
            `⚠️ 但工程里还有 ${r.unsaved_package_count} 个未保存的包，它们的引用关系还不在索引里 —— ` +
            '**这个结论现在不能用来决定删不删**。先 ue_save 存下你自己改的，再查一次；' +
            '还剩未保存的就用 ue_list_unsaved 看是哪些，那是用户的改动，问他。'
          : `${r.asset_path} 没有被任何资产引用 —— 删掉它不会影响别的东西。`,
        details: r
      }
    }

    // 计数和明细分别来自响应里的两个字段。老插件（或将来某次改动）只回计数不回
    // 明细时，直接遍历会抛「not iterable」—— 一次本可以正常作答的查询变成工具报错
    const referencers = r.referencers ?? []
    const lines = [`${r.asset_path} 被 ${r.referencer_count} 个资产引用：`]
    for (const item of referencers) {
      lines.push(`  ${item.path}${item.class ? `（${item.class}）` : ''}`)
    }
    if (referencers.length === 0) {
      lines.push('  （引擎只回了数量，没回具体是哪些）')
    }
    if (r.truncated) {
      lines.push(`…还有更多，只显示了 ${referencers.length} 条。`)
    }
    lines.push('改动会影响到上面这些，删除会让它们失效。')
    if (stale) {
      lines.push(
        `⚠️ 还有 ${r.unsaved_package_count} 个未保存的包，可能有更多引用者没算进来。` +
          '先 ue_save 存下你自己改的，再查一次；还剩未保存的用 ue_list_unsaved 看是哪些，问用户。'
      )
    }

    return { text: lines.join('\n'), details: r }
  }
})

/** 材质工具集。注册表按 namespace 取用。 */
export const materialTools: readonly UnrealAgentTool<never>[] = Object.freeze([
  createMaterial,
  createMaterialInstance,
  duplicateMaterial,
  searchMaterialNodes,
  createMaterialApplyGraphTool(),
  applyMaterial,
  describeMaterial,
  setMaterialProperty,
  setMaterialParam,
  getMaterialGraph,
  compileMaterial,
  setMaterialNodeValue,
  deleteMaterialNode,
  disconnectMaterialPins,
  deleteUnusedMaterialNodes,
  materialParameterCollection,
  createMaterialFunction,
  getMaterialReferencers,
  tidyMaterialGraph
] as unknown as UnrealAgentTool<never>[])
