/**
 * `sequence_diff` —— 两条 Level Sequence 逐绑定、逐轨道对比。只读。
 *
 * 设计文档（sequencer-能力设计 §5.6）早就排了这一项：「改前改后逐轨对比，审批门的地基」。
 * 真把它排上日程的是 2026-09-24 的买量定序器反馈，两处卡在同一个比较上：
 *
 * 1. **受保护的原序列**：备份时记的 SHA256 和现在的文件对不上。哈希只能说字节不同，
 *    说不出是重存了元数据还是人手 K 的曲线被动了 —— 于是既不敢说「原版没动」，
 *    也不敢拿备份覆盖。这里给的是**语义差异**：帧率、范围、绑定、轨道、关键帧的值和切线。
 * 2. **风格迁移的覆盖**：旧角色身上的描边 Stencil、覆层材质、槽 7 / 槽 1 的溶解曲线，
 *    新换上的显示角色一条没接；`sequence_audit` 照样 PASS（它查的是能不能渲）。
 *    给 `binding_map` 时逐对判「已继承 / 已适配 / 缺失 / 无法判断」。
 *
 * 引擎侧实现与边界见 `UAL_SequenceDiffCommands.cpp` 开头。
 */

import { z } from 'zod'

import { callUe } from '../defineUeTool'
import { defineTool, type UnrealAgentTool } from '../defineTool'

const NAMESPACE = 'ue.sequencer'

const InputSchema = z.object({
  base_path: z.string().trim().min(1).describe('基准序列：备份 / 原版 / 参考序列的资产路径'),
  compare_path: z
    .string()
    .trim()
    .min(1)
    .describe(
      '对比序列：当前版本 / 副本 / 目标序列。可以和 base_path 相同（同一条序列里比两个绑定）'
    ),
  binding_map: z
    .array(
      z.object({
        base: z.string().trim().min(1).describe('基准序列里的绑定名（或「父级 / 组件」、或 GUID）'),
        compare: z.string().trim().min(1).describe('对比序列里对应的绑定')
      })
    )
    .max(50)
    .optional()
    .describe(
      '给了就是覆盖检查：每对绑定连同组件子绑定逐条轨道判 已继承/已适配/缺失/无法判断。不给就是逐绑定找差异'
    ),
  bindings: z
    .array(z.string().trim().min(1))
    .max(200)
    .optional()
    .describe('找差异时只看这几个绑定（按名字）')
})

type Input = z.infer<typeof InputSchema>

interface SequenceInfo {
  path: string
  display_rate: string
  tick_resolution: string
  playback_start: number
  playback_end: number
  duration_seconds: number
  binding_count: number
}

interface TrackEntry {
  track: string
  status:
    | 'changed'
    | 'only_in_base'
    | 'only_in_compare'
    | 'inherited'
    | 'adapted'
    | 'missing'
    | 'unknown'
  details?: string[]
}

/** 字段名与 `UAL_SequenceDiffCommands.cpp` 的 `Handle` 逐字对应 */
export interface DiffOutput {
  mode: 'diff' | 'coverage'
  base: SequenceInfo
  compare: SequenceInfo
  sequence_changes?: Array<{ field: string; base: string; compare: string }>
  root_tracks?: TrackEntry[]
  bindings?: Array<{
    base?: string
    compare?: string
    status: 'changed' | 'only_in_base' | 'only_in_compare'
    matched_by?: 'id' | 'name'
    track_count?: number
    binding_changes?: string[]
    tracks?: TrackEntry[]
  }>
  unchanged_bindings?: number
  filtered?: boolean
  coverage?: Array<{
    base: string
    compare: string
    status:
      | 'compared'
      | 'base_not_found'
      | 'base_ambiguous'
      | 'compare_not_found'
      | 'compare_ambiguous'
    candidates?: string[]
    items?: TrackEntry[]
    extra_in_compare?: string[]
  }>
  notes?: string[]
  truncated?: boolean
}

const FIELD_NAMES: Record<string, string> = {
  display_rate: '帧率',
  tick_resolution: 'Tick 分辨率',
  playback_range: '播放范围'
}

function trackLines(entries: TrackEntry[], indent: string): string[] {
  const lines: string[] = []
  for (const t of entries) {
    const tag =
      t.status === 'only_in_base'
        ? '只在基准里有（对比序列里没了）'
        : t.status === 'only_in_compare'
          ? '只在对比序列里有（新加的）'
          : '变了'
    lines.push(`${indent}- ${t.track}：${tag}`)
    for (const d of t.details ?? []) lines.push(`${indent}    ${d}`)
  }
  return lines
}

function formatDiff(data: DiffOutput): string {
  const lines: string[] = []
  const seqChanges = data.sequence_changes ?? []
  const roots = data.root_tracks ?? []
  const bindings = data.bindings ?? []

  for (const c of seqChanges) {
    lines.push(`- ${FIELD_NAMES[c.field] ?? c.field}：${c.base} → ${c.compare}`)
  }
  if (roots.length > 0) {
    lines.push('', '序列级轨道（相机切轨、子序列等）：', ...trackLines(roots, ''))
  }
  for (const b of bindings) {
    if (b.status === 'only_in_base') {
      lines.push('', `## ${b.base}：对比序列里没有这个绑定（原有 ${b.track_count ?? 0} 条轨道）`)
      continue
    }
    if (b.status === 'only_in_compare') {
      lines.push('', `## ${b.compare}：新加的绑定（${b.track_count ?? 0} 条轨道）`)
      continue
    }
    const name = b.base === b.compare ? b.base : `${b.base} ↔ ${b.compare}`
    lines.push('', `## ${name}${b.matched_by === 'name' ? '（按名字对上的，GUID 不同）' : ''}`)
    for (const c of b.binding_changes ?? []) lines.push(`- ${c}`)
    lines.push(...trackLines(b.tracks ?? [], ''))
  }

  const nothing = seqChanges.length === 0 && roots.length === 0 && bindings.length === 0
  const scope = data.filtered ? '点名的绑定里' : ''
  const head = nothing
    ? `✅ ${scope}没有语义差异：帧率、播放范围、绑定、轨道、段、关键帧的值与切线都一致。` +
      (data.filtered
        ? '其余绑定这次没比。'
        : '文件哈希对不上的话，差在序列内容以外（重新保存、编辑器元数据等），人手 K 的曲线没被动过。')
    : `${scope}有差异：${bindings.length} 个绑定${roots.length ? `、${roots.length} 条序列级轨道` : ''}${seqChanges.length ? `、${seqChanges.length} 项序列设置` : ''}。` +
      `另有 ${data.unchanged_bindings ?? 0} 个绑定完全一致。`
  return [head, ...lines].join('\n')
}

const COVERAGE_TAGS: Record<string, string> = {
  inherited: '已继承',
  adapted: '已适配（有这条轨道，内容不同）',
  missing: '缺失',
  unknown: '无法判断'
}

function formatCoverage(data: DiffOutput): string {
  const lines: string[] = []
  let missingTotal = 0
  let unknownTotal = 0
  for (const pair of data.coverage ?? []) {
    lines.push('', `## ${pair.base} → ${pair.compare}`)
    if (pair.status === 'base_not_found' || pair.status === 'base_ambiguous') {
      lines.push(
        pair.status === 'base_ambiguous'
          ? `- 基准序列里有多个叫这个名字的绑定，用 GUID 点名：${(pair.candidates ?? []).join('、')}`
          : '- 基准序列里找不到这个绑定。先用 sequence_describe(detail="names") 拿名单'
      )
      continue
    }
    if (pair.status === 'compare_ambiguous') {
      lines.push(
        `- 对比序列里有多个叫这个名字的绑定，用 GUID 点名：${(pair.candidates ?? []).join('、')}`
      )
      continue
    }
    const items = pair.items ?? []
    if (pair.status === 'compare_not_found') {
      unknownTotal += items.length
      lines.push(
        `- 对比序列里没有这个绑定，源绑定的 ${items.length} 条轨道**无法判断**：` +
          '状态可能由运行时逻辑（附着、状态同步组件）接管，序列里看不出来。' +
          '不要说成缺失，也不要说成已继承 —— 要确认就在编辑器 / PIE 里同帧回读目标对象的实际值。',
        ...items.map((t) => `    ${t.track}`)
      )
      continue
    }
    const count = (s: string): number => items.filter((t) => t.status === s).length
    missingTotal += count('missing')
    lines.push(
      `- 已继承 ${count('inherited')}，已适配 ${count('adapted')}，缺失 ${count('missing')}`
    )
    for (const t of items) {
      if (t.status === 'inherited') continue
      lines.push(`- ${t.track}：${COVERAGE_TAGS[t.status] ?? t.status}`)
      for (const d of t.details ?? []) lines.push(`    ${d}`)
    }
    if (pair.extra_in_compare?.length) {
      lines.push(
        `- 目标上另有 ${pair.extra_in_compare.length} 条源绑定没有的轨道：${pair.extra_in_compare.join('、')}`
      )
    }
  }
  const head =
    `覆盖检查：${(data.coverage ?? []).length} 对绑定，缺失 ${missingTotal} 条轨道` +
    (unknownTotal ? `，${unknownTotal} 条无法判断` : '') +
    '。轨道按「类型 + 属性路径 / 材质槽」对齐，组件子绑定合并进它的 Actor；' +
    '「已适配」只说明内容不同，改得对不对要看同帧画面或回读数值。'
  return [head, ...lines].join('\n')
}

export function formatDiffOutcome(data: DiffOutput): string {
  const header = [
    `基准 ${data.base.path}：${data.base.display_rate}，[${data.base.playback_start}, ${data.base.playback_end})，${data.base.binding_count} 个绑定`,
    `对比 ${data.compare.path}：${data.compare.display_rate}，[${data.compare.playback_start}, ${data.compare.playback_end})，${data.compare.binding_count} 个绑定`,
    ''
  ]
  const body = data.mode === 'coverage' ? formatCoverage(data) : formatDiff(data)
  const tail: string[] = []
  for (const note of data.notes ?? []) tail.push(`ℹ️ ${note}`)
  if (data.truncated) {
    // 悄悄少给比报错更危险：模型会拿一份不完整却看起来完整的结果做决策
    tail.push('⚠️ 有差异的绑定太多，只列了前 150 个。用 bindings 点名分批看。')
  }
  return [...header, body, ...(tail.length ? ['', ...tail] : [])].join('\n')
}

export function createSequenceDiffTool(): UnrealAgentTool<DiffOutput> {
  return defineTool({
    name: 'sequence_diff',
    namespace: NAMESPACE,
    risk: 'safe',
    concurrency: 'parallel',
    description: `对比两条 Level Sequence，只读。两种用法：

【找差异】不给 binding_map。按绑定 GUID 对齐（复制出来的副本保留 GUID），对不上的按名字。
报帧率、播放范围、相机切轨和子序列引用、每个绑定的轨道 / 段 / 关键帧的**值、插值和切线**。
- 受保护资产：备份 vs 当前，确认人手 K 的曲线有没有被动。文件哈希对不上时用它看差在哪
- 自己改完：改前副本 vs 改后，逐条核对只动了该动的

【覆盖检查】给 binding_map（源绑定 → 目标绑定）。每对连同组件子绑定，逐条轨道判
已继承 / 已适配 / 缺失；目标绑定不在序列里时判「无法判断」—— 状态可能由运行时逻辑接管。
风格迁移、换角色显示层之后用它确认：描边、覆层、材质槽参数、显隐这些原来有的状态新角色上还在不在。
材质轨道按槽位对齐（槽 7 和槽 1 是两条），属性轨道按属性路径对齐。

【边界】只比序列资产本身：子序列只比引用的是哪条，不递归；possessable 绑到关卡里哪个 Actor 不比。
两条都得是工程里的资产 —— 磁盘上的备份文件要先放进工程。不判断改得好不好看。`,
    input: InputSchema,
    execute: async (input: Input) => {
      const data = await callUe<DiffOutput>(
        'sequence.diff',
        {
          base_path: input.base_path,
          compare_path: input.compare_path,
          ...(input.binding_map?.length ? { binding_map: input.binding_map } : {}),
          ...(input.bindings?.length ? { bindings: input.bindings } : {})
        },
        { timeoutMs: 120_000 }
      )
      if (!data?.base || !data?.compare) {
        return { text: '对比失败：引擎没有返回结果', isError: true }
      }
      return { text: formatDiffOutcome(data), details: data }
    }
  })
}
