/**
 * `sequence_describe` —— 读懂一条 Level Sequence。
 *
 * ## 为什么它先于其余 Sequencer 工具实现
 *
 * 它是所有 Sequencer 工作流的**眼睛和验收手段**：改之前要知道现状，改之后要能验证。
 * 工作流清单还在评审，但无论最终砍掉哪条、
 * 加上哪条，「读取序列结构」都跑不掉。所以不等评审先做。
 *
 * ## 上下文预算：默认摘要，按需下钻
 *
 * 量产序列动辄几百个绑定、上千个关键帧。全量返回会**一次调用吃掉整个上下文**，
 * 之后模型什么也干不了 —— 而它当时只是想知道「这条序列有几个镜头」。
 *
 * 所以分三层，由 `detail` 控制：
 *
 *   - `outline`（默认）—— 只有序列本身 + 绑定名/类型 + 每个绑定的轨道数
 *   - `tracks`         —— 加上每条轨道的段、时间范围、通道名
 *   - `keys`           —— 加上关键帧。**必须点名 `bindings`**，否则拒绝
 *
 * 最后一条是刻意的：`detail: 'keys'` 不限定范围地打全序列，正是会撑爆上下文的
 * 那个调用。宁可让模型多问一次「哪个绑定」，也不要给它一把随时会走火的枪。
 *
 * ## 帧边界
 *
 * 段的范围一律按**闭开区间** `[start, end)` 上报，并在文本里写明。
 * UE 内部这件事不一致（MRQ 渲染不含末帧，AnimSequence 首尾都含，
 * 播放头落在交界处显示下一段），是穿帮和错帧的常见来源。
 * —— **算术归工具，不能让模型自己推**。
 *
 * ## 顺带做出片体检
 *
 * `describe` 返回里带一段 `readiness`：有没有相机切轨、切轨有没有覆盖播放范围、
 * 有没有失效绑定。这三条正是「渲出来是黑的」的主要根因（§3.1）。
 *
 * 放在 describe 里而不是单独一个工具，是因为模型**每次动手前都会先 describe**，
 * 而它不会主动想到去调一个叫 `check_render_readiness` 的工具 ——
 * 那类信息必须搭车，不能等人来问。
 */

import { z } from 'zod'

import { callUe } from '../defineUeTool'
import { defineTool, type UnrealAgentTool } from '../defineTool'

const NAMESPACE = 'ue.sequencer'

const InputSchema = z.object({
  sequence_path: z
    .string()
    .trim()
    .min(1)
    .describe('Level Sequence 的资产路径，如 /Game/Cinematics/Shot_01.Shot_01'),
  detail: z
    .enum(['outline', 'tracks', 'keys'])
    .default('outline')
    .describe(
      'outline=只有绑定和轨道数（默认，最省上下文）；tracks=加上段与时间范围；keys=加上关键帧，必须同时指定 bindings'
    ),
  bindings: z
    .array(z.string().trim().min(1))
    .optional()
    .describe('只看这几个绑定（按名字）。detail=keys 时必填，避免一次拉出上千个关键帧')
})

type Input = z.infer<typeof InputSchema>

/**
 * 引擎侧回传的形状。
 *
 * **字段名与 `UAL_SequencerCommands.cpp` 的 `Handle_Describe` 逐字对应。**
 * 这份 interface 就是那条 RPC 的契约 —— 漂一个字，下面的格式化函数就白留了。
 */
interface DescribeOutput {
  sequence: {
    path: string
    display_rate: string
    playback_start: number
    playback_end: number
    duration_frames: number
  }
  bindings: Array<{
    name: string
    id: string
    type: string
    bound_to: string | null
    /**
     * 组件绑定的父级绑定名。
     *
     * Sequencer 里调灯光强度会产生两条绑定：Actor 一条、它的组件一条。
     * 光看到「LightComponent0」看不出它是谁身上的，带上父级才认得出来。
     */
    parent?: string
    track_count: number
    tracks?: Array<{
      name: string
      type: string
      sections: Array<{
        start: number | null
        end: number | null
        channels?: Array<{ name: string; key_count: number; keys?: Array<[number, unknown]> }>
      }>
    }>
  }>
  camera_cuts: {
    exists: boolean
    section_count: number
    covers_playback: boolean
    /** 段与段之间的空隙 `[前一段末帧, 后一段首帧)`。哪怕一帧，那一帧就没有相机 */
    gaps?: Array<[number, number]>
  }
  broken_bindings: string[]
  /**
   * 判不出解析结果的绑定。
   *
   * **和 broken 分开报是刻意的。** 拿不到编辑器世界、World Partition 里 actor
   * 没加载、PIE 世界不是编辑器世界，都会让好绑定看起来是坏的。报一个假的
   * 「已失效」会让用户去修一个没坏的东西，比不报更糟。
   */
  unresolved_bindings?: string[]
  /** 这台引擎实际支持什么。跨 5.0–5.8 时模型据此知道自己站在什么地基上 */
  capabilities?: {
    engine_version?: string
    tracks_api?: string
    spawnable_detection?: boolean
    binding_resolution?: boolean
  }
  truncated: boolean
}

/**
 * 单次调用允许回传的绑定上限。
 *
 * 超出就截断并如实告知，而不是**悄悄少给** —— 模型拿到一份不完整但看起来完整的
 * 结构，会基于「这条序列只有 60 个绑定」做后续决策，错得无声无息。
 */
const MAX_BINDINGS = 60

/** 关键帧层每个通道回传的上限，同上，超出如实告知 */
const MAX_KEYS_PER_CHANNEL = 200

/**
 * 出片体检结论。
 *
 * 只诊断，不渲染 —— 渲染是不可逆的资源消耗，由用户全权决定
 * 。
 */
function readinessLines(data: DescribeOutput, filtered: boolean): string[] {
  const lines: string[] = []
  const { camera_cuts: cuts, broken_bindings: broken } = data

  if (!cuts.exists) {
    lines.push('- ❌ 没有相机切轨（Camera Cuts）。这样渲染出来会是黑画面。')
  } else if (cuts.section_count === 0) {
    lines.push('- ❌ 相机切轨是空的。这样渲染出来会是黑画面。')
  } else if (!cuts.covers_playback) {
    lines.push('- ⚠️ 相机切轨没有覆盖完整播放范围，没被覆盖的那段会是黑画面。')
  } else {
    lines.push('- ✅ 相机切轨覆盖了完整播放范围。')
  }

  // 空隙单独报：肉眼在时间线上看不出来，但每个空隙就是渲出来的一段黑帧
  for (const [from, to] of cuts.gaps ?? []) {
    lines.push(`- ❌ 相机切轨在第 ${from}–${to} 帧之间有空隙，这几帧没有相机，会是黑画面。`)
  }

  if (broken.length > 0) {
    lines.push(
      `- ❌ ${broken.length} 个绑定已失效（${broken.slice(0, 5).join('、')}${broken.length > 5 ? ' 等' : ''}）。` +
        '失效的绑定不会报错，只是什么都不做 —— 对应的轨道等于没有效果。' +
        '可以在 Level Sequence 编辑器里用 Actions → Advanced → Rebind Possessable References 修复。'
    )
  } else if (filtered) {
    // 用 bindings 点名时只查了那几个。说「没有失效的绑定」是假话 ——
    // 没被点到的绑定这次根本没看
    lines.push('- ℹ️ 你点名的这几个绑定没问题，**其余绑定这次没查**（用 bindings 过滤了）。')
  } else {
    lines.push('- ✅ 没有失效的绑定。')
  }

  // 「判不出来」必须和「已失效」分开说。混为一谈会让用户去修一个没坏的东西
  const unresolved = data.unresolved_bindings ?? []
  if (unresolved.length > 0) {
    lines.push(
      `- ℹ️ ${unresolved.length} 个绑定无法判定（${unresolved.slice(0, 5).join('、')}${unresolved.length > 5 ? ' 等' : ''}）。` +
        '**这不代表它们坏了** —— World Partition 里没加载的 Actor、正在 PIE、' +
        '或者拿不到编辑器世界，都会让好绑定看起来解析不了。要确认请打开对应关卡后再查一次。'
    )
  }

  return lines
}

/**
 * 版本能力说明。
 *
 * 跨 5.0–5.8 时，同一条命令在不同版本上能做的事不一样。**静默降级是不行的**：
 * 用户在 5.3 上跑出和 5.6 不一样的结果而工具不说，他下次就不会再用。
 */
function capabilityLines(data: DescribeOutput): string[] {
  const cap = data.capabilities
  if (!cap) return []

  const lines: string[] = []
  if (cap.spawnable_detection === false) {
    lines.push('- 这个引擎版本上分不出 spawnable / possessable，绑定类型标为 unknown。')
  }
  if (cap.binding_resolution === false) {
    lines.push('- 拿不到编辑器世界，无法判定绑定是否失效（上面的失效检查这次没跑）。')
  }
  return lines.length > 0 ? ['', `引擎能力（${cap.engine_version ?? '版本未知'}）：`, ...lines] : []
}

function formatOutcome(data: DescribeOutput, detail: Input['detail'], filtered: boolean): string {
  const s = data.sequence
  const lines = [
    `序列 ${s.path}`,
    `帧率 ${s.display_rate}，播放范围 [${s.playback_start}, ${s.playback_end})，共 ${s.duration_frames} 帧`,
    `绑定 ${data.bindings.length} 个`,
    '',
    '出片体检：',
    ...readinessLines(data, filtered),
    ...capabilityLines(data),
    ''
  ]

  for (const b of data.bindings) {
    const parent = b.parent ? `${b.parent} 的组件，` : ''
    lines.push(`## ${b.name}（${parent}${b.type}，${b.track_count} 条轨道）`)
    if (b.bound_to) lines.push(`  绑定到 ${b.bound_to}`)
    for (const t of b.tracks ?? []) {
      const secs = t.sections.map((sec) => `[${sec.start ?? '−∞'}, ${sec.end ?? '+∞'})`).join(' ')
      lines.push(`  - ${t.name}（${t.type}）${secs}`)
      for (const sec of t.sections) {
        for (const ch of sec.channels ?? []) {
          const keys = ch.keys ? ch.keys.map(([f, v]) => `${f}=${String(v)}`).join(' ') : ''
          lines.push(`      ${ch.name}: ${ch.key_count} 个关键帧${keys ? ` → ${keys}` : ''}`)
        }
      }
    }
  }

  if (data.truncated) {
    // 悄悄少给比报错更危险：模型会拿一份不完整却看起来完整的结构做决策
    lines.push(
      '',
      `⚠️ 结果已截断（单次最多 ${MAX_BINDINGS} 个绑定 / 每通道 ${MAX_KEYS_PER_CHANNEL} 个关键帧）。` +
        '用 bindings 参数点名你要看的绑定，拿到的才是完整数据。'
    )
  }

  if (detail === 'outline') {
    lines.push(
      '',
      '（这是概览。要看轨道和时间范围用 detail="tracks"，要看关键帧用 detail="keys" 并指定 bindings）'
    )
  }

  return lines.join('\n')
}

export function createSequenceDescribeTool(): UnrealAgentTool<DescribeOutput> {
  return defineTool({
    name: 'sequence_describe',
    namespace: NAMESPACE,
    risk: 'safe',
    concurrency: 'parallel',
    description: `读取一条 Level Sequence 的结构：绑定、轨道、段、关键帧，并附带出片体检。

【一条还是一批】本工具一次**一条**，会展开结构，附带的体检是顺手给的。
要问「这批能不能渲」用 sequence_audit：一次 N 条、只报问题不报结构、给 PASS/FAIL。
量产时别拿本工具逐条查 —— 24 条的结构树会把上下文撑爆，那正是 audit 存在的理由。

【分层读取，控制上下文】
- detail="outline"（默认）：绑定名/类型 + 轨道数。量产序列先用这个
- detail="tracks"：加上每条轨道的段和时间范围
- detail="keys"：加上关键帧，**必须同时用 bindings 点名**，否则会拒绝

【时间约定】
所有段的范围按闭开区间 [start, end) 上报。注意 UE 内部并不一致：
Movie Render Queue 渲染不含末帧，AnimSequence 首尾都含。**不要自己推算帧边界**。

【出片体检】
返回里会指出「渲染出来会不会是黑画面」的三个主要根因：没有相机切轨、
切轨没覆盖播放范围、绑定失效。这是社区里最高频的问题。
本工具只诊断不渲染 —— 渲染由用户自己在编辑器里决定和执行。`,
    input: InputSchema,
    execute: async (input) => {
      if (input.detail === 'keys' && !input.bindings?.length) {
        // 不限范围地拉全序列关键帧，正是会一次吃掉整个上下文的那个调用。
        // 宁可让模型多问一次，也不给它一把随时走火的枪。
        return {
          text:
            'detail="keys" 时必须用 bindings 点名要看哪几个绑定。' +
            '不限范围地读取整条序列的关键帧会占满上下文。' +
            '先用 detail="outline" 看有哪些绑定，再挑你需要的。',
          isError: true
        }
      }

      const data = await callUe<DescribeOutput>(
        'sequence.describe',
        {
          sequence_path: input.sequence_path,
          detail: input.detail,
          ...(input.bindings?.length ? { bindings: input.bindings } : {}),
          max_bindings: MAX_BINDINGS,
          max_keys: MAX_KEYS_PER_CHANNEL
        },
        { timeoutMs: 60_000 }
      )

      if (!data?.sequence) {
        return { text: '读取序列失败：引擎没有返回结构数据', isError: true }
      }

      return {
        text: formatOutcome(data, input.detail, (input.bindings?.length ?? 0) > 0),
        details: data
      }
    }
  })
}
