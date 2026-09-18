/**
 * 把用户自己的命名规则套在插件的审计结果上。
 *
 * 插件那边只认前缀（Epic 官方那张表 + 调用方传的 rules）。前缀表结构上表达不了的东西
 * 归这里：
 *
 * - **自定义改名规则**（正则 → 替换）：去掉 `_FINAL` / `_v2` / `_copy`、团队约定
 *   `Temp_` → `WIP_`、拼音残留清理。这些跟资产类型无关，前缀表放不进去。
 * - **归属目录**：名字对了但放错了地方。插件只看名字，不看位置。
 *
 * 两件事都可能落在插件认为「合规」的资产上，所以调用方在需要时会打开
 * `include_compliant`（见 namingAudit 的 toParams）。这一层只做字符串计算，
 * 不发 RPC、不读注册表。
 *
 * ## 为什么改写过的条目要标「冲突未知」
 *
 * 插件回的 `conflict` 是拿它自己算的建议名查注册表的结论。名字被这里改写之后那个
 * 结论就不作数了，而我们查不了注册表。所以标 `conflict_unknown`，让调用方靠
 * `ue_content_move` 的 `dry_run` 兜 —— 宁可说没确认上，不许假装查过。
 *
 * ## 「没检查」和「检查了没问题」必须分得开
 *
 * `directory_checked` / `compliant_truncated` 这些字段存在的唯一理由就是这个。
 * 用户没改过归属目录表 → `directories` 是空的 → 一个资产的位置都没查过，
 * 而这和「都查了，位置都对」在输出上长得一模一样。摘要必须说得出是哪一种。
 */

import {
  applyCustomRules,
  compileCustomRules,
  describeCustomPrefixes,
  directoryOf,
  joinPackage,
  lookupEntryByClass
} from './namingPolicy'
import type { UserNamingPolicy } from './namingPolicy'
import type { NamingAuditResponse, ProjectRuleRename } from './types'

export interface ApplyProjectRulesOptions {
  policy: UserNamingPolicy
  /** 调用方要不要检查归属目录 */
  checkDirectory: boolean
  /**
   * 模型自己要过 include_compliant 吗。
   *
   * 为了看「前缀合规但仍要改」的资产，我们会自己把 include_compliant 打开；
   * 那份合规清单是手段不是结果，几千条「没问题」倒给模型只会挤掉真正要看的东西。
   * 模型没要就在这里摘掉。
   */
  keepCompliant: boolean
}

/**
 * 返回一份新的响应，原对象不动 —— 调用方可能还要拿原始结果对账。
 */
export function applyProjectNamingRules(
  response: NamingAuditResponse,
  { policy, checkDirectory, keepCompliant }: ApplyProjectRulesOptions
): NamingAuditResponse {
  const { customRules, directories } = policy
  const compiled = compileCustomRules(customRules)

  // 「要查」和「查得了」是两件事：用户没改过归属目录表就没有可比的目标。
  // 两者都记下来，摘要才能把「没查」和「查了没问题」分开说
  const directoryRequested = checkDirectory
  const directoryTableEmpty = Object.keys(directories).length === 0
  const useDirectories = directoryRequested && !directoryTableEmpty

  /**
   * 合规清单被插件按 limit 截过没有。
   *
   * 插件的 `truncated` 只反映 violations，合规那一头它不报。自己按
   * `compliant_count` 对一下数组长度就知道 —— 截过就说截过，不许把「扫了前 200 个」
   * 说成「全部列在这里」。
   */
  const compliantReturned = response.compliant?.length ?? 0
  const compliantTruncated =
    response.compliant !== undefined && response.compliant_count > compliantReturned

  const rejectedRules = compiled.rejected
  let directoryMismatches = 0

  /**
   * 用户填的目标目录里没法用的那些。
   *
   * 这一格是自由填写的，`/Game/Meshes` 和 `Meshes` 长得差不多，而后者
   * `ue_content_move` 那边会**整批**拒掉（"Destination must be a package path like
   * /Game/Folder/Name"）。不报出来的话，一次说「查过了」的审计后面跟着一批一个都搬不动
   * 的移动请求，而错在哪只有插件知道。
   */
  const rejectedDirectories: { type: string; value: string }[] = []
  const seenBadDirectory = new Set<string>()

  /**
   * 真拿某个资产的位置比对过多少次。
   *
   * 「表非空」不等于「查过」：用户只配了 Texture，而这次扫的是 StaticMesh，
   * 或者他配的 SoundWave 根本没有插件规则（那类资产在插件那边就被跳过了，
   * 压根不会出现在结果里）—— 两种情况下一次比对都没发生，而
   * `directory_mismatch_count: 0` + 「位置都对」和真的都对长得一模一样。
   */
  let directoryComparisons = 0

  /**
   * 目标目录：真放错了才返回，放对了返回 undefined。
   *
   * **子目录算放对了。** 这里以前要求目录**完全相等**，于是
   * `/Game/Meshes/Props/SM_Door` 对上配置的 `/Game/Meshes` 就成了「放错」，而给出的
   * 修法是把它拍平到 `/Game/Meshes/SM_Door` —— 一个按 `<类别>/` 分过子目录的工程，
   * 八百个网格体会被建议全部倒进同一个文件夹，其中同名的那些还会在同一批里撞成一个
   * 目标路径（`/Game/Meshes/Props/SM_Door` 和 `/Game/Meshes/Env/SM_Door` 都指向
   * `/Game/Meshes/SM_Door`）。这一格的含义是「这类资产归到哪个根下面」，
   * 从来不是「不许再分子目录」。
   */
  const expectedDirectory = (path: string, cls: string): string | undefined => {
    if (!useDirectories) return undefined
    const entry = lookupEntryByClass(directories, cls)
    if (!entry?.value) return undefined
    const want = entry.value
    // 用户手填的路径没人校验过，前后空白和结尾斜杠都可能有
    const normalized = want.trim().replace(/\/+$/, '')
    if (!normalized) return undefined
    // 不是包路径的话，比出来的结论没法执行 —— 报成废条目，不当成「查过了」。
    // 报**配置键**（entry.key）而不是引擎类名：设置页那张表的行键是配置键，
    // 一条填错的 Texture 按引擎类名报会变成 Texture2D / TextureCube / VolumeTexture
    // 三条，让用户去那一页上找三行根本不存在的东西
    if (!normalized.startsWith('/')) {
      if (!seenBadDirectory.has(entry.key)) {
        seenBadDirectory.add(entry.key)
        rejectedDirectories.push({ type: entry.key, value: want.trim() })
      }
      return undefined
    }
    directoryComparisons++
    const dir = directoryOf(path)
    if (dir === normalized || dir.startsWith(`${normalized}/`)) return undefined
    return normalized
  }

  // 一条规则都没有时（只配了归属目录的那种）省掉整趟调用，不为几百个资产各造一个空 hits
  const applyRules = (name: string): ReturnType<typeof applyCustomRules> =>
    compiled.rules.length === 0 ? { name, hits: [] } : applyCustomRules(name, compiled)

  // ── 已有的违规条目：在插件的建议名上继续套自定义规则 ──
  let rewroteAnyViolation = false
  const violations = response.violations.map((v) => {
    const renamed = applyRules(v.suggested_name)
    // 第二候选（ambiguous 那条「保留原词」的建议）要**在早退之前**算。
    // 规则很可能只命中它而不命中主候选 —— MF_Walk 的主候选已经是 AS_Walk，
    // 「MF_ → Female_」压根匹配不上，可 AS_MF_Walk 匹配得上。按主候选判早退，
    // 恰恰在两个候选不一样的那种情况下把这一步跳过去了
    const keep = v.suggested_name_keep ? applyRules(v.suggested_name_keep) : undefined
    const wantDir = expectedDirectory(v.path, v.class)
    if (wantDir) directoryMismatches++

    const nameChanged = renamed.name !== v.suggested_name
    const keepChanged = keep !== undefined && keep.name !== v.suggested_name_keep
    if (!nameChanged && !keepChanged && !wantDir) return v

    rewroteAnyViolation = true
    const finalName = renamed.name
    const baseDir = wantDir ?? directoryOf(v.suggested_path)
    const next = {
      ...v,
      suggested_name: finalName,
      suggested_path: joinPackage(baseDir, finalName),
      ...(nameChanged ? { custom_rules: renamed.hits } : {}),
      ...(wantDir ? { directory_expected: wantDir } : {})
    }

    if (keep) {
      next.suggested_name_keep = keep.name
      next.suggested_path_keep = joinPackage(
        wantDir ?? directoryOf(v.suggested_path_keep ?? v.suggested_path),
        keep.name
      )
    }

    // 冲突结论只在**对应那个名字真被改写过**时才作废。
    //
    // 主候选没动（只有 keep 候选命中了规则）时，插件查的就是这个名字，它那个 conflict
    // 依然成立 —— 一并删掉的话表头少算一个占用、那一行也没了 ⚠️，模型把它当安全的发出去，
    // 整批被 on_conflict=fail 拒掉。
    if (nameChanged || wantDir) {
      delete next.conflict
      next.conflict_unknown = true
    }
    // 两个候选各有各的「查过没有」。只标主候选的话，被改写过的 keep 候选就成了
    // 一个既没有 conflict_keep、也没有任何警告标记的名字 —— 摘要照常把它当
    // 「另一个候选」列出来，模型挑了它、不走 dry_run 就搬，正好撞上。
    //
    // 前提是**真有第二候选**：插件只给 wrong_prefix 出 suggested_name_keep，而
    // wantDir 在 missing_prefix 上也为真，不加这道闸就会给一条根本没有 keep 候选的
    // 条目盖上「keep 候选没查过」，让「有这个标记 = 有第二候选」这条不变量当场作废
    if (keep && (keepChanged || wantDir)) {
      delete next.conflict_keep
      next.conflict_keep_unknown = true
    }
    return next
  })

  /**
   * 只有真动过、而且插件没截断时才重算 `conflict_count`。
   *
   * 插件那个数是**全量扫描**的（`ConflictCount` 在 `Violations.Num() < Limit` 那道闸
   * 之前就加了），而这里能数的只有回来的那一页。无条件重算 = 把 137 改写成 6，
   * 表头于是变成「违规 5000（其中 6 个已被占用）」，模型把另外 131 个当安全的发出去，
   * 整批被 on_conflict=fail 拒掉。
   *
   * 一条都没改写时更不该动它 —— 那时 `conflict` 一个都没删，插件的数本来就是对的。
   */
  const conflictCount =
    rewroteAnyViolation && !response.truncated
      ? violations.filter((v) => v.conflict === true).length
      : response.conflict_count

  // ── 前缀合规、但撞上自定义规则或放错目录的那些 ──
  const projectRuleRenames: ProjectRuleRename[] = []
  for (const asset of response.compliant ?? []) {
    const name = asset.path.slice(asset.path.lastIndexOf('/') + 1)
    const renamed = applyRules(name)
    const wantDir = expectedDirectory(asset.path, asset.class)
    if (wantDir) directoryMismatches++

    const nameChanged = renamed.name !== name
    if (!nameChanged && !wantDir) continue

    const baseDir = wantDir ?? directoryOf(asset.path)
    projectRuleRenames.push({
      path: asset.path,
      class: asset.class,
      suggested_path: joinPackage(baseDir, renamed.name),
      custom_rules: nameChanged ? renamed.hits : [],
      ...(wantDir ? { directory_expected: wantDir } : {}),
      conflict_unknown: true
    })
  }

  const enriched: NamingAuditResponse = {
    ...response,
    violations,
    conflict_count: conflictCount,
    ...(projectRuleRenames.length > 0 ? { project_rule_renames: projectRuleRenames } : {}),
    ...(useDirectories ? { directory_mismatch_count: directoryMismatches } : {}),
    ...(rejectedRules.length > 0 ? { rejected_custom_rules: rejectedRules } : {}),
    ...(rejectedDirectories.length > 0 ? { rejected_directories: rejectedDirectories } : {}),
    ...(compliantTruncated ? { compliant_truncated: true } : {}),
    // 一次比对都没发生时，「用户没配」和「他配了但全填坏了」是两个不同的原因，
    // 而 requested_but_no_table 那段文案只说得出前一个。全填坏了还报前一个，
    // 等于当着用户的面否认他刚填过的东西
    directory_check: !directoryRequested
      ? 'not_requested'
      : directoryComparisons > 0
        ? 'checked'
        : rejectedDirectories.length > 0
          ? 'requested_but_directories_invalid'
          : 'requested_but_no_table',
    project_rules_applied: {
      // 前缀只是「报告」，不参与审计（发给插件会把旧前缀抹掉，见 describeCustomPrefixes）
      custom_prefixes: describeCustomPrefixes(policy.prefixRules),
      custom_rules: compiled.rules.length
    }
  }

  // 合规清单是手段不是结果，模型没要就摘掉（见 keepCompliant 的注释）。
  // 用 delete 而不是赋 undefined：赋 undefined 这个键还在，`'compliant' in r`
  // 仍然为真，读起来像「返回了一份空的合规清单」而不是「没要过」
  if (!keepCompliant) delete enriched.compliant

  return enriched
}
