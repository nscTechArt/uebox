/**
 * 地形（Landscape）与地形 RVT 工具集。
 *
 * 走插件 RPC（`landscape.*`），C++ 实现 —— UE 的 Python 建不出地形：
 * `ALandscapeProxy::Import` 只有 C++ 能调。流程照抄编辑器的「新建地形」按钮和
 * 「创建 RVT 体积」按钮，5.0–5.8 逐版本核过，见插件侧文件头。
 *
 * ## 已注册
 *
 *   - `landscape_create`     新建地形（平地 / 高度图），可顺带配 RVT
 *   - `landscape_setup_rvt`  给已有地形配颜色 RVT 和/或高度 RVT
 *   - `landscape_list`       列出地形，连同 RVT 五项体检
 *
 * ## 两条裁决
 *
 * 1. **尺寸由插件换算，不让模型猜。** 地形只有编辑器下拉框里那几档合法组合，
 *    模型给「1 公里」，插件挑最近的合法组合，回执里如实说「实际 1008 米」。
 * 2. **RVT 体检放在这一层**（`rvtHealth.ts`）。插件只回原始事实，判据是纯函数，
 *    能单测，改判据不用重编插件。
 */

import { z } from 'zod'

import { defineUeTool } from '../defineUeTool'
import { CM_FIELD_NOTE, formatCmWithMeters } from '../ueUnits'
import { withPartialHeadline, type PartialFailure } from '../partialResult'
import type { UnrealAgentTool } from '../defineTool'
import { describeRvtDiagnoses, diagnoseRvt, PROJECT_VT_OFF } from './rvtHealth'
import type {
  LandscapeCreateResponse,
  LandscapeInfo,
  LandscapeListResponse,
  LandscapeSetupRvtResponse,
  LevelFacts,
  RvtSetupResult
} from './types'

const NAMESPACE = 'ue.landscape'

/**
 * 每个方向最多多少格。插件那侧的 `MaxResolutionPerAxis`（8161 个顶点）减一，
 * 两边必须一致：再大就进了编辑器「分区域建」的范围（要先存盘、不能撤销），第一版不做。
 */
export const MAX_QUADS_PER_AXIS = 8160

/** 大地形导入要几十秒到几分钟 */
const CREATE_TIMEOUT_MS = 300_000

const fmt = (n: number, digits = 0): string =>
  Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : String(n)

// ======================================================================
// 参数
// ======================================================================

const RvtAssetSchema = z.union([
  z.boolean(),
  z.object({
    asset_path: z
      .string()
      .trim()
      .min(1)
      .describe('用已有的 RVT 资产（类型要对得上），或在这个路径新建，如 /Game/Landscape/RVT_Color')
  })
])

const RvtFields = {
  color: RvtAssetSchema.optional().describe(
    '颜色 RVT（Base Color, Normal, Roughness, Specular）：网格/草和地面融合、远处地形省性能。true = 按默认路径新建'
  ),
  height: RvtAssetSchema.optional().describe(
    '高度 RVT（World Height）：草、水、贴花按地形高度对齐。true = 按默认路径新建'
  ),
  asset_folder: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('新建 RVT 资产放哪个目录，默认 /Game/Landscape/RVT。给了 asset_path 的那一类不看它')
}

const wantsRvt = (value: unknown): boolean =>
  value === true || (typeof value === 'object' && value !== null)

const CreateSchema = z
  .object({
    size_x_m: z
      .number()
      .positive()
      .optional()
      .describe('X 方向边长，**米**。平地必填；给了 heightmap_path 时忽略（尺寸跟着图走）'),
    size_y_m: z
      .number()
      .positive()
      .optional()
      .describe('Y 方向边长，米。省略 = 和 X 一样（正方形）'),
    heightmap_path: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        '本机高度图文件的绝对路径：16 位灰度 PNG、.r16 或 .raw。给了就按图建，不给就是平地'
      ),
    location: z
      .object({ x: z.number().default(0), y: z.number().default(0), z: z.number().default(0) })
      .optional()
      .describe(`地形**中心**的位置，${CM_FIELD_NOTE}。默认原点`),
    quad_size_m: z
      .number()
      .min(0.1)
      .max(10)
      .optional()
      .describe('每格边长（米），默认 1。越小越精细、顶点越多'),
    height_range_m: z
      .number()
      .positive()
      .max(20000)
      .optional()
      .describe(
        '高度图从最黑到最白对应的总落差（米），默认 512（中间灰是 0 高度，上下各一半）。' +
          '这不是地形的实际高低差 —— 平地不用填；用高度图时按图的设计落差填'
      ),
    material: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('地形材质路径，如 /Game/Materials/M_Landscape'),
    label: z.string().trim().min(1).optional().describe('大纲里的名字，默认 Landscape'),
    wp_grid_size: z
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe('仅 World Partition 关卡：每块流送代理包几个地形块（每边），默认 2，与编辑器一致'),
    rvt: z
      .object(RvtFields)
      .optional()
      .describe('建好后顺带配 RVT。等价于随后调一次 landscape_setup_rvt')
  })
  .refine((a) => a.heightmap_path !== undefined || a.size_x_m !== undefined, {
    message: '平地要给 size_x_m（米）；按图建要给 heightmap_path'
  })
  .refine(
    (a) =>
      a.heightmap_path !== undefined ||
      Math.max(a.size_x_m ?? 0, a.size_y_m ?? 0) / (a.quad_size_m ?? 1) <= MAX_QUADS_PER_AXIS,
    {
      message: `每个方向最多 ${fmt(MAX_QUADS_PER_AXIS)} 格（每格 quad_size_m 米）。要更大就调大 quad_size_m`
    }
  )

const SetupRvtSchema = z
  .object({
    landscape: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('地形的大纲名字。关卡里只有一块地形时可省略'),
    ...RvtFields
  })
  .refine((a) => wantsRvt(a.color) || wantsRvt(a.height), {
    message: 'color 和 height 至少要一个'
  })

const ListSchema = z.object({})

// ======================================================================
// 回执
// ======================================================================

function describeLevel(level: LevelFacts): string {
  return (
    `关卡 ${level.level_package}（${level.world_partition ? 'World Partition' : '普通关卡'}）` +
    (level.project_virtual_texturing ? '' : '；项目未开虚拟纹理支持')
  )
}

/** 一块地形的实际状态，全部来自引擎读回 */
export function describeLandscape(land: LandscapeInfo): string {
  const lines: string[] = []
  const size = land.size_m
  const extent = land.loaded_extent
  lines.push(
    `地形「${land.label}」：` +
      (size ? `${fmt(size.x, 1)} × ${fmt(size.y, 1)} 米` : '尺寸未知') +
      (extent
        ? `，分辨率 ${fmt(extent.resolution.x)} × ${fmt(extent.resolution.y)}，` +
          `${extent.component_count.x} × ${extent.component_count.y} 块`
        : '') +
      `（每块 ${land.sections_per_component} × ${land.sections_per_component} 分区、每分区 ${land.quads_per_section} 格），` +
      `每格 ${fmt(land.quad_size_m, 2)} 米`
  )
  if (land.bounds) {
    const { min, max } = land.bounds
    const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 }
    lines.push(
      `中心 ${formatCmWithMeters(center)}；世界范围 ${formatCmWithMeters(min)} → ${formatCmWithMeters(max)}`
    )
  } else {
    lines.push(`地形原点（左下角）${formatCmWithMeters(land.location)}`)
  }
  lines.push(`高度图满量程落差 ${fmt(land.heightmap_range_m, 1)} 米`)
  lines.push(land.material ? `材质：${land.material}` : '材质：未挂（显示引擎默认的网格材质）')
  if (land.streaming_proxies_loaded > 0) {
    lines.push(`已切成流送代理，当前加载 ${land.streaming_proxies_loaded} 块`)
  }
  return lines.join('\n')
}

function rvtFailures(results: readonly RvtSetupResult[]): PartialFailure[] {
  return results
    .filter((r) => !r.ok)
    .map((r) => ({ item: `${r.kind === 'color' ? '颜色' : '高度'} RVT`, reason: r.error }))
}

function describeRvtResult(r: RvtSetupResult): string {
  const name = r.kind === 'color' ? '颜色' : '高度'
  if (!r.ok) return `- ${name} RVT：没配成`
  const volume = r.volume
  return (
    `- ${name} RVT ${r.asset_path}（${r.asset_created ? '新建' : '复用'}，类型 ${r.material_type}）：` +
    `${r.proxies_with}/${r.proxies_total} 块地形往里画；` +
    (volume
      ? `体积 ${volume.label}（${volume.created ? '新建' : '复用'}）罩住了整块地形`
      : '没有体积')
  )
}

/**
 * RVT 那一段：逐条结果 + 五项体检。
 *
 * 插件判失败的只有「资产 / 挂到地形 / 体积」这几步。项目开关和材质节点插件不改，
 * 那两项没对上时 RVT 照样不会有效果 —— 所以体检的结论必须跟在后面，而且要说
 * 「现在还不会有效果」，不能让模型把「配置写好了」读成「能用了」。
 */
function describeRvtSection(
  level: LevelFacts,
  land: LandscapeInfo,
  results: readonly RvtSetupResult[]
): string {
  // 没配成的那一类已经在失败清单里了，不再体检一遍 —— 同一件事换个说法报两次，
  // 模型会以为坏了两处
  const kinds = results.filter((r) => r.ok).map((r) => r.kind)
  const diagnoses = diagnoseRvt(level, land, kinds)
  const pending = diagnoses.filter((d) => d.problems.length > 0)
  const lines = ['RVT：', ...results.map(describeRvtResult)]
  if (pending.length > 0) {
    lines.push('还有没对上的，RVT 现在还不会有效果：', describeRvtDiagnoses(pending))
  } else if (kinds.length > 0) {
    lines.push('五项检查都对上了（项目开关、资产、地形、体积、材质输出）。')
  }
  return lines.join('\n')
}

export function summarizeCreate(response: LandscapeCreateResponse): string {
  const land = response.landscape
  const req = response.requested
  const parts: string[] = []

  let head = `地形已建好（${describeLevel(response)}，可撤销）。`
  if (req.size_x_m !== undefined && land.size_m) {
    const asked = `${fmt(req.size_x_m)} × ${fmt(req.size_y_m ?? req.size_x_m)} 米`
    const got = `${fmt(land.size_m.x, 1)} × ${fmt(land.size_m.y, 1)} 米`
    head += ` 要的是 ${asked}，实际 ${got} —— 地形只能按块取整。`
  }
  parts.push(head, describeLandscape(land))

  const hm = response.heightmap
  if (hm) {
    parts.push(
      `高度图 ${hm.path}：原图 ${hm.source_resolution.x} × ${hm.source_resolution.y}` +
        (hm.resampled
          ? `，已重采样到 ${hm.resolution.x} × ${hm.resolution.y}（最近的合法尺寸）`
          : '，尺寸正好合法，没有重采样') +
        (hm.candidate_resolutions > 1
          ? `。这是无文件头的格式，引擎猜出 ${hm.candidate_resolutions} 种可能的尺寸，取了第一种 —— 形状不对就换 PNG`
          : '') +
        (hm.engine_message ? `。引擎提示：${hm.engine_message}` : '')
    )
  }
  if (response.wp_grid_size !== undefined) {
    parts.push(
      `World Partition：已按每 ${response.wp_grid_size} × ${response.wp_grid_size} 块切成流送代理。`
    )
  }
  if (req.material && !land.material) {
    parts.push(`⚠️ 请求的材质 ${req.material} 读回来是空的，地形现在没有材质。`)
  }
  const results = response.rvt_results ?? []
  if (results.length > 0) {
    parts.push(describeRvtSection(response, land, results))
  }

  const body = parts.join('\n')
  if (response.failed_count <= 0) return body
  return withPartialHeadline(
    body,
    {
      succeeded: results.length - response.failed_count,
      failed: response.failed_count,
      unit: '项 RVT'
    },
    rvtFailures(results)
  )
}

export function summarizeSetupRvt(response: LandscapeSetupRvtResponse): string {
  const results = response.rvt_results
  const failures = rvtFailures(results)
  if (results.length > 0 && failures.length === results.length) {
    // 全部没配成按错误抛（AGENTS.md §5 第 14 条）
    throw new Error(
      `地形 RVT 一项都没配成：\n${failures.map((f) => `- ${f.item}：${f.reason ?? '未给原因'}`).join('\n')}`
    )
  }
  const body = [
    `${describeLevel(response)}。地形「${response.landscape.label}」`,
    describeRvtSection(response, response.landscape, results)
  ].join('\n')
  return withPartialHeadline(
    body,
    { succeeded: results.length - failures.length, failed: failures.length, unit: '项 RVT' },
    failures
  )
}

export function summarizeList(response: LandscapeListResponse): string {
  const lines = [describeLevel(response)]
  if (response.landscapes.length === 0) {
    lines.push('关卡里没有地形。要建一块用 landscape_create。')
    return lines.join('\n')
  }
  for (const land of response.landscapes) {
    lines.push('', describeLandscape(land))
    const diagnoses = diagnoseRvt(response, land)
    lines.push(diagnoses.length === 0 ? 'RVT：没挂' : `RVT：\n${describeRvtDiagnoses(diagnoses)}`)
  }
  if (!response.project_virtual_texturing) {
    lines.push('', `注意：${PROJECT_VT_OFF}。`)
  }
  return lines.join('\n')
}

// ======================================================================
// 工具
// ======================================================================

const landscapeCreate = defineUeTool<typeof CreateSchema, LandscapeCreateResponse>({
  name: 'landscape_create',
  namespace: NAMESPACE,
  method: 'landscape.create',
  risk: 'mutating',
  concurrency: 'sequential',
  timeoutMs: CREATE_TIMEOUT_MS,
  description: `在当前关卡新建一块地形（Landscape）：平地，或者从高度图文件建。可以顺带配好 RVT。

- **尺寸按米给**（size_x_m），插件换算成编辑器里最近的合法组合 —— 地形只能按块取整，
  「1000 米」实际会是 1008 米。回执里的尺寸是引擎读回的实际值，以它为准。
- 用高度图时尺寸跟着图走；图的尺寸不合法会重采样到最近的合法尺寸，回执会说。
- World Partition 关卡会自动切成流送代理（和编辑器新建时一样），PCG 能直接在上面采样。
- 能 Ctrl+Z 撤销。游戏运行（PIE）时拒绝。

不做：雕刻、刷材质图层、超过 ${fmt(MAX_QUADS_PER_AXIS)} 格每边的超大地形。
给已有地形配 RVT 用 landscape_setup_rvt；看关卡里有哪些地形用 landscape_list。`,
  input: CreateSchema,
  toOutcome: (response) => ({ text: summarizeCreate(response), details: response })
})

const landscapeSetupRvt = defineUeTool<typeof SetupRvtSchema, LandscapeSetupRvtResponse>({
  name: 'landscape_setup_rvt',
  namespace: NAMESPACE,
  method: 'landscape.setup_rvt',
  risk: 'mutating',
  concurrency: 'sequential',
  description: `给已有地形配 RVT（运行时虚拟纹理）：颜色 RVT、高度 RVT，或两种都配。

每一种做三件事：RVT 资产（没有就新建）→ 挂到地形和每一块流送代理 → RVT 体积罩住整块地形
（已有指向这张 RVT 的体积就复用，只重算边界）。能 Ctrl+Z 撤销。

RVT 要五件事同时成立才有效果，**少一件引擎不报错，只是黑一块**。这个工具做其中三件，另外两件只检查不改：
- 项目设置里的虚拟纹理开关：改了要重启编辑器、影响整个项目，由用户决定
- 地形材质里的 Runtime Virtual Texture Output 节点：用材质工具去加
回执末尾会列出还没对上的项。`,
  input: SetupRvtSchema,
  toOutcome: (response) => ({ text: summarizeSetupRvt(response), details: response })
})

const landscapeList = defineUeTool<typeof ListSchema, LandscapeListResponse>({
  name: 'landscape_list',
  namespace: NAMESPACE,
  method: 'landscape.list',
  risk: 'safe',
  description: `列出当前关卡里的地形：实际尺寸、分辨率、分块、材质、流送代理，以及 RVT 五项体检
（项目开关、资产、地形是否往里画、体积是否罩住、材质有没有 RVT 输出节点）。

用户说「RVT 是黑的」「融合没效果」「地形边缘发黑」时先调它，它会直接指出哪一项没对上。`,
  input: ListSchema,
  toOutcome: (response) => ({ text: summarizeList(response), details: response })
})

export function landscapeTools(): UnrealAgentTool<never>[] {
  // 工具带自己的 details 类型，注册表要的是统一的 never —— 与 ue-mesh 同一处理
  return [landscapeCreate, landscapeSetupRvt, landscapeList] as unknown as UnrealAgentTool<never>[]
}
