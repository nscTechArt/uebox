/**
 * `sequence_audit` —— 出片前体检。
 *
 * ## 定位：不是交付前的 QA 报告，是「我现在按渲染键会不会白等」
 *
 * 五位资深用户评审一致把它排在第一优先级。价值量化（ArchViz 方向）：
 * 一版 60 秒 4K 25fps 的室内漫游在 4090 上是隔夜；凌晨渲完发现有黑帧 =
 * 损失一晚 + 客户 deadline 顺延一天。**渲染前 10 秒的体检 vs 渲完 8 小时才发现，
 * 价值差一个数量级。**
 *
 * 而且这条和「不做渲染出片」是完美互补的：我们不替用户按渲染键，
 * 但保证他按下去之后不会白等。
 *
 * ## 三条硬要求（达不到就没价值）
 *
 * 1. **只读、秒级。** 体检本身不能改任何东西，也不能让人等
 * 2. **一次能跑 N 条序列。** 一轮要出的是 24 个 job，逐个体检等于没体检
 * 3. **输出 PASS/FAIL，不是散文。** 「看起来大体没问题，但建议检查一下」
 *    是负价值 —— 用户读完还是不知道该不该按渲染键
 *
 * ## 为什么和 `sequence_describe` 分开
 *
 * `describe` 是「这条序列长什么样」，一次一条、会展开结构。
 * `audit` 是「这批序列能不能渲」，一次 N 条、只报问题不报结构。
 * 合成一个的话，查 24 条的返回里会混进 24 份结构树，直接撑爆上下文。
 *
 * ## 递归子序列
 *
 * 默认递归。master sequence 上体检通过、某个 shot 里的相机绑定断了，
 * 是最典型的漏检 —— 而那正是用户最需要提前知道的。
 */

import { z } from 'zod'

import { callUe } from '../defineUeTool'
import { defineTool, type UnrealAgentTool } from '../defineTool'
import { formatReports, verdictOf, type Finding, type SequenceReport } from './findings'

const NAMESPACE = 'ue.sequencer'

const InputSchema = z.object({
  sequence_paths: z
    .array(z.string().trim().min(1))
    .min(1)
    // 上限 50：每条要跑一遍全树遍历（含递归子序列），命令在游戏线程上执行，
    // 数量太多会让编辑器可见地卡住。50 覆盖绝大多数「一轮出片」的规模
    .max(50)
    .describe(
      '要体检的 Level Sequence 路径，一次最多 50 条。可以一次传多条 —— 一轮出片通常是十几到几十个镜头'
    ),
  recursive: z
    .boolean()
    .default(true)
    .describe('是否递归检查子序列。默认 true —— 父层通过、子镜头里绑定断了是最典型的漏检'),
  only_blockers: z
    .boolean()
    .default(false)
    .describe('只报会导致渲染失败的问题，忽略提示类。赶时间时用')
})

interface AuditOutput {
  reports: SequenceReport[]
  capabilities?: { engine_version?: string; binding_resolution?: boolean }
}

export function createSequenceAuditTool(): UnrealAgentTool<AuditOutput> {
  return defineTool({
    name: 'sequence_audit',
    namespace: NAMESPACE,
    risk: 'safe',
    concurrency: 'parallel',
    description: `出片前体检：一次检查 N 条 Level Sequence，告诉用户现在渲出去会不会有问题。

【和 sequence_describe 的分工】本工具一次 **N 条**、只报问题不报结构、给 PASS/FAIL。
要看**某一条**长什么样（有哪些绑定、轨道、关键帧）用 sequence_describe，它会展开结构。
两边的体检是各自实现的，结论一致时以本工具的 PASS/FAIL 为准 —— 它是为「按不按渲染键」这一个决定写的。

【回答的是「我按下渲染键会不会白等」】
渲一版 4K 漫游可能是隔夜的事。渲完发现中间有黑帧 = 损失一晚。
本工具在 10 秒内指出会不会黑、为什么黑、他自己怎么改。

【查什么】
- 相机切轨：不存在 / 是空的 / 没覆盖播放范围 / 段之间有空隙 / 段重叠 —— 这几项直接导致黑帧
- 绑定失效：静默失败，轨道看着在、播放时什么都不做
- 段落越界、子序列时长与父层对不上、空轨道、无轨道的绑定
- 相机同时以 spawnable 和 possessable 存在（切点上会渲错实例）

【结论是 PASS / FAIL，不是建议】
只有「会导致渲染失败」的问题才判 FAIL。默认递归子序列 ——
父层通过、某个 shot 里绑定断了是最典型的漏检。

【本工具只诊断不渲染】
渲染要花几小时机器时间和几十 GB 磁盘，编解码和采样直接挂在交付物上，
这个决定和执行都由用户自己来。不要提议帮他渲。`,
    input: InputSchema,
    execute: async (input) => {
      // 上限由 schema 的 .max() 把关，这里不再重复判 —— 重复的校验迟早会漂移
      const data = await callUe<AuditOutput>(
        'sequence.audit',
        { paths: input.sequence_paths, recursive: input.recursive },
        { timeoutMs: 120_000 }
      )

      if (!Array.isArray(data?.reports)) {
        return { text: '体检失败：引擎没有返回结果', isError: true }
      }

      let hidden = 0
      const reports = input.only_blockers
        ? data.reports.map((r) => {
            const kept = r.findings.filter((f: Finding) => f.severity === 'breaks_render')
            hidden += r.findings.length - kept.length
            return { ...r, findings: kept }
          })
        : data.reports

      const failed = reports.filter((r) => !r.error && verdictOf(r.findings) === 'FAIL').length
      const header =
        reports.length > 1 ? `体检了 ${reports.length} 条序列，${failed} 条不通过。\n\n` : ''

      // 拿不到编辑器世界时绑定检查根本没跑。不说的话用户会把
      // 「没报绑定问题」理解成「绑定都好着」，那是假话
      const caveat =
        data.capabilities?.binding_resolution === false
          ? '\n\n⚠️ 这次拿不到编辑器世界，**绑定有效性检查没有执行** —— ' +
            '上面没报绑定问题不等于绑定都是好的。打开对应关卡、退出 PIE 之后再查一次。'
          : ''

      // 过滤掉的也要交代。不说的话 formatReports 会对空 findings 打印
      // 「没有发现问题」—— 把「这次没看」说成了「看了没问题」
      const filtered =
        hidden > 0
          ? `\n\n（本次只看阻塞项，另有 ${hidden} 项非阻塞提示未显示。去掉 only_blockers 可以看全。）`
          : ''

      return { text: header + formatReports(reports) + caveat + filtered, details: data }
    }
  })
}
