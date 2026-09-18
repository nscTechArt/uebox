/**
 * ue_content_naming_audit —— 命名规范体检。
 *
 * 只读注册表，不加载资产，整个 /Game 几秒钟。规则表在插件里
 * （`UAL_ContentOrganizeCommands.cpp`，以 Epic 官方推荐前缀为底），这里只透传参数、
 * 把结果压成模型能直接用的几行。
 */

import { z } from 'zod'

import { defineUeTool } from '../defineUeTool'
import { applyProjectNamingRules } from './projectRules'
import { resolveUserNamingPolicy } from './namingPolicy'
import { summarizeNamingAudit } from './summaries'
import type { NamingAuditResponse } from './types'

export const NAMESPACE = 'ue.content'

/**
 * 一次调用只读一遍用户配置。
 *
 * `toParams` 和 `toOutcome` 之间隔着一次最长 180 秒的 RPC，各读一遍的话中间用户在
 * 设置页动一下手，两次读到的就不是同一份配置：`toParams` 按「没有自定义规则」决定
 * 不要合规清单，`toOutcome` 却按「有规则」去套 —— `response.compliant` 是 undefined，
 * `compliant_truncated` 因此判成 false，摘要于是说「没有截断」，而按规则改名那部分
 * 覆盖了零个合规资产。
 *
 * `defineUeTool` 把**同一个** args 对象交给两个钩子（`defineUeTool.ts:359`、`:365`），
 * 所以拿它当键就够，不用另造一个调用 id。WeakMap 也省得自己清。
 */
const POLICY_BY_ARGS = new WeakMap<object, ReturnType<typeof resolveUserNamingPolicy>>()

function policyFor(args: object): ReturnType<typeof resolveUserNamingPolicy> {
  const cached = POLICY_BY_ARGS.get(args)
  if (cached) return cached
  const policy = resolveUserNamingPolicy()
  POLICY_BY_ARGS.set(args, policy)
  return policy
}

/**
 * `details` 只给宿主界面，但它照样要过 IPC、进聊天记录、每次界面更新还被
 * `JSON.stringify` 一遍。整份 enriched 实测 114 KB（默认）到 1.87 MB（limit=2000），
 * 一个 30 步的会话光在渲染进程上就白扔几十毫秒和几十兆临时字符串，还会被写进磁盘上的
 * 聊天历史。界面上并没有东西在渲染这些清单，所以只留数字和一小段样本。
 */
const DETAIL_SAMPLE = 20

function slimDetails(r: NamingAuditResponse): NamingAuditResponse {
  const slim: NamingAuditResponse = {
    ...r,
    violations: r.violations.slice(0, DETAIL_SAMPLE),
    ...(r.project_rule_renames
      ? { project_rule_renames: r.project_rule_renames.slice(0, DETAIL_SAMPLE) }
      : {})
  }
  // 合规清单整份不要：它是「看得见前缀合规但仍要改的资产」的手段，
  // 界面上没有东西在渲染它，而它就是那 1.87 MB 的大头
  delete slim.compliant
  return slim
}

const NamingAuditInput = z.object({
  path: z.string().optional().describe('要体检的目录，默认 /Game'),
  recursive: z.boolean().optional().describe('是否包含子目录，默认 true'),
  class_filter: z.string().optional().describe('只查某一类，如 StaticMesh / Texture2D / Blueprint'),
  rules: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      '自定义或覆盖前缀规则：{ "SoundWave": "S_", "Blueprint": "BP_" }。键是资产类名（引擎类名，' +
        '如 Texture2D / MaterialInstanceConstant），值是前缀（含下划线）。' +
        '默认表以 Epic 官方推荐为底；表里没有的类型不会被检查，会列在 unknown_classes 里，用这个参数补上。' +
        '**补一个没规则的类型是安全的；覆盖一个已有规则的类型会连带后果**：插件的覆盖是整条替换，' +
        '旧前缀会从「认识的前缀」里消失，于是那一类里本来命名正确的资产（T_Rock）会被判成缺前缀、' +
        '建议改成「新前缀+旧名字」（TX_T_Rock），而这种条目不带任何警告标记。要覆盖就先跟用户确认。'
    ),
  ignore_classes: z
    .array(z.string())
    .optional()
    .describe('跳过这些类，如 ["World", "ObjectRedirector"]'),
  ignore_paths: z
    .array(z.string())
    .optional()
    .describe(
      '跳过这些目录（含子目录），如 ["/Game/StarterContent", "/Game/Mannequin"]。' +
        '模板、Marketplace、第三方目录用的是它们自己的命名惯例，逐条报只会淹没项目自己的资产。' +
        '没有默认豁免 —— 哪些是模板只有你知道。'
    ),
  pascal_case: z
    .boolean()
    .optional()
    .describe('建议名的主体部分首字母改大写（sm_rock → SM_Rock），默认 false'),
  include_compliant: z.boolean().optional().describe('结果里也列出合规的资产，默认 false'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      '最多列出多少条，默认 200。**违规清单和合规清单共用这一个上限**，所以它也决定了' +
        '「按用户自己的规则要改」和归属目录这两项能覆盖多少个资产。摘要正文最多列 200 条，' +
        '调大只多花引擎那边的时间，不会把上下文撑爆 —— 被截断时可以放心往上调。'
    ),
  use_project_rules: z
    .boolean()
    .optional()
    .describe(
      '把用户自己写的改名规则和归属目录叠到官方规范上，默认 true。' +
        '底始终是 Epic 官方推荐那一套。注意**前缀不在其中**：用户改过的前缀只会在摘要里' +
        '报给你，要不要按它审由你跟用户确认后用 rules 显式传 —— 直接发过去会让插件把旧前缀' +
        '整个忘掉，于是每个本来命名正确的资产都被建议改成「新前缀 + 旧名字」。'
    ),
  check_directory: z
    .boolean()
    .optional()
    .describe(
      '同时检查资产放的目录对不对，按用户在「偏好设置 → 命名规则 → 资产归属目录」里' +
        '**自己改过**的条目判，默认 false。他没改过任何一条、或者他配的那几类这次一个都' +
        '没扫到，就一个资产的位置都查不了 —— 摘要里会明说这件事，别把沉默当成「位置都对」。'
    )
})

export const namingAuditTool = defineUeTool<typeof NamingAuditInput, NamingAuditResponse>({
  name: 'ue_content_naming_audit',
  namespace: NAMESPACE,
  method: 'content.naming_audit',
  risk: 'safe',
  timeoutMs: 180_000,
  description: `按类型前缀规范体检一个目录里的资产命名，给出每个违规资产的建议新名字。

规则表以 Epic 官方《Recommended Asset Naming Conventions》为底：T_ 贴图、SM_ 静态网格、
SK_ 骨骼网格、M_ 材质、MI_ 材质实例、BP_ 蓝图、AC_ 组件蓝图、BI_ 蓝图接口、WBP_ 控件蓝图、
ABP_ 动画蓝图、AS_ 动画序列、AM_ 蒙太奇、BS_ 混合空间、DT_ 数据表、E_ 枚举、F_ 结构体、
FXS_/FXE_ Niagara、LS_ 关卡序列 …… 另补了 MF_ 材质函数、MPC_ 参数集、RT_ 渲染目标。

**表里没有的类型不检查也不猜**（音频、字体等各家风格不一），会在 unknown_classes 里报出来；
项目有自己的规范就用 rules 传进来覆盖。

只读注册表，不加载资产，整个工程也只要几秒。

违规分三种：missing_prefix（没前缀）、wrong_prefix（挂了别的类型的前缀）、
prefix_case（大小写不对）。每条都给 suggested_path，可以直接喂给 ue_content_move 批量改名；
conflict=true 表示建议名已被占用，要先另想名字。

**返回的是全量清单，不需要你自己复刻规则。** 结果里会把每一条违规都列出来
（不是只列前几条）。条目多到被截断时会明说，并告诉你怎么拿剩下的。

**标了「有歧义」的别照单执行。** 名字开头那段是别的类型的前缀，但在这里可能是
有意义的词 —— 动画名里的 MF_ 通常是「女版」不是材质函数，照建议改会把语义弄丢、
还可能让男女两套动画撞名。这种条目会同时给出保留原词的候选，拿不准就问用户。

**模板和第三方目录用 ignore_paths 排除掉**，否则它们的命名惯例会淹没你真正要改的东西。`,
  input: NamingAuditInput,
  toParams: (args) => {
    const { use_project_rules, check_directory, ...engineArgs } = args
    const params: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(engineArgs)) {
      if (value !== undefined) params[key] = value
    }

    // 这两个是盒子侧的开关，插件不认识，别透传过去
    const useProjectRules = use_project_rules !== false
    if (!useProjectRules) return params

    const policy = policyFor(args)

    // **用户改过的前缀不再自动并进 rules**（原因见 namingPolicy.ts 的
    // describeCustomPrefixes：插件的 override 是整条替换，会把旧前缀从
    // KnownPrefixes 里抹掉，于是每个本来命名正确的资产都被建议改成「新前缀+旧名字」）。
    // 它只在摘要里报给模型，由模型跟用户确认之后自己传 rules。
    // 上面那个 for 循环已经把 rules 抄进 params 了，这里不用再抄一遍

    // 自定义规则和目录检查都要看「前缀合规但仍然要改」的那些资产，
    // 而它们只在 include_compliant 时才回来。这一步只多读注册表，不加载资产。
    //
    // **不替模型决定 limit。** limit 在插件里同时管 violations 和 compliant 两个数组，
    // 顶到 2000 能让这两项覆盖十倍的资产，而摘要正文有自己的 200 条上限兜着，
    // 所以调大不会把上下文撑爆。以前这里悄悄顶到 2000 是因为摘要还会全量打印；
    // 现在两头都改了，这个决定交回模型 —— 截断会如实报出来，参数说明里也写清了能调。
    const needsCompliant =
      policy.customRules.length > 0 ||
      (check_directory === true && Object.keys(policy.directories).length > 0)
    if (needsCompliant) params.include_compliant = true

    return params
  },
  toOutcome: (response, args) => {
    const enriched =
      args.use_project_rules === false
        ? {
            ...response,
            // 关掉项目规则不等于「位置都对」。要了目录检查却什么都没查，
            // 这件事必须说出来 —— 沉默会被读成「查过了，没问题」
            ...(args.check_directory === true
              ? { directory_check: 'requested_but_rules_disabled' as const }
              : {})
          }
        : applyProjectNamingRules(response, {
            policy: policyFor(args),
            checkDirectory: args.check_directory === true,
            // 我们为了看「合规但仍要改」的资产自己打开过 include_compliant，
            // 模型没主动要就别把那份清单倒给它
            keepCompliant: args.include_compliant === true
          })
    return {
      text: summarizeNamingAudit(enriched),
      details: slimDetails(enriched)
    }
  }
})
