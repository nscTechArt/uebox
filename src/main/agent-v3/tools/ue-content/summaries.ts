/**
 * 引擎响应 → 给模型看的文字。
 *
 * 结构化数据整份放 `details`（不进上下文），这里只写模型做决定需要的那几行：
 * 数量、前几条、下一步该调什么。几千条 items 逐条列出来只会把上下文撑爆，
 * 而模型真正要的是「有多少、都在哪、能不能直接做」。
 *
 * ## 千万别写「完整列表在 details.X」
 *
 * `details` **只给宿主界面，不进模型上下文**（`defineTool.ts:34`）。
 * 这里原来有 10 处这么写，对模型来说全是死路 —— 它照着去找，什么都拿不到。
 * 2026-09-09 真机上，命名体检只列了前 20 条、指着 `details.violations` 说
 * 「完整列表在这儿」，模型拿不到，只好用 Python 把整套命名规则**重写了一遍**
 * 才凑齐 123 条。
 *
 * 所以截断的地方一律给**模型自己能执行的下一步**（收窄 path、调大 limit、
 * 去哪个日志看），或者干脆把全量写进 text —— 两三百行文字远比重造一个工具便宜。
 */

import { humanBytes } from '../adapted/ue-content-browser/formatBytes'
import type {
  AutoAnsweredDialog,
  BatchMoveResponse,
  CdoRefs,
  CheckoutPreflight,
  DependenciesResponse,
  DependencyWalk,
  MigrateResponse,
  NamingAuditResponse,
  PackageWriteState
} from './types'

const SAMPLE = 20

/**
 * 一次摘要里最多逐条列多少个资产。
 *
 * limit 最大到 2000，两个清单全量打进正文实测能吐出十几万到三十几万 token ——
 * 比上下文窗口还大，而这是个 risk:'safe' 的工具，模型会试探性地调。
 *
 * **两个清单共用这一份预算**，不是各自 200。各自算的话上限其实是 400 行、实测
 * 三万五 token，本文件开头那段说的预算是「两三百行」，翻一倍就不算预算了。
 */
const MAX_LISTED = 200

function countMap(map: Record<string, number> | undefined): string {
  if (!map) return ''
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return ''
  return entries.map(([k, v]) => `${k} ${v}`).join('、')
}

export function summarizeNamingAudit(r: NamingAuditResponse): string {
  const lines: string[] = []
  lines.push(
    `${r.path} 下扫描了 ${r.scanned} 个资产：合规 ${r.compliant_count}，违规 ${r.violation_count}` +
      (r.conflict_count > 0 ? `（其中 ${r.conflict_count} 个建议名已被占用）` : '')
  )
  const byReason = countMap(r.by_reason)
  if (byReason) lines.push(`违规原因：${byReason}`)
  const byClass = countMap(r.by_class)
  if (byClass) lines.push(`按类型：${byClass}`)

  // 两个清单共用 MAX_LISTED，谁少谁让出来；都超了就各占一半
  const renames = r.project_rule_renames ?? []
  const half = Math.floor(MAX_LISTED / 2)
  const violationBudget =
    renames.length > 0 ? Math.max(half, MAX_LISTED - renames.length) : MAX_LISTED
  const renameBudget = MAX_LISTED - Math.min(r.violations.length, violationBudget)

  if (r.violations.length > 0) {
    lines.push('')
    // 尽量全量列出来。这份清单就是下一步要喂给 ue_content_move 的东西，
    // 少一条就得有人再造一遍轮子（见文件顶部注释）
    const shown = r.violations.slice(0, violationBudget)
    // **「全部列在这里」要跟全工程的数比，不是跟手里这一页比。**
    // 插件自己的 limit 默认也是 200，于是一个 5000 条违规的工程回来 200 条
    // （`truncated: true`），拿 `shown.length < violations.length` 一比是「没截断」，
    // 摘要就写成「建议改名（200 条，全部列在这里）」，两行之后又说「一共 5000 条」，
    // 自己打自己。projectRules.ts 开头那条规矩就是为这个立的
    const listedAll = shown.length >= r.violation_count && !r.truncated
    lines.push(
      listedAll
        ? `建议改名（${r.violation_count} 条，全部列在这里）：`
        : `建议改名（共 ${r.violation_count} 条，下面列 ${shown.length} 条）：`
    )
    for (const v of shown) {
      // 改了目录的条目要把整条 suggested_path 打出来。只写新名字的话，模型只能拿
      // 源目录去拼目标路径，于是名字改了、位置没搬 —— 而这一层刚刚才把目录算进去
      const target = v.directory_expected ? v.suggested_path : v.suggested_name
      lines.push(
        `- ${v.path} → ${target}` +
          (v.conflict ? ' ⚠️ 目标名已存在' : '') +
          (v.conflict_unknown ? ' ⚠️ 撞名未查（按你的规则改写过，必须先 dry_run）' : '') +
          (v.rule_source === 'extended' ? '（非 Epic 官方前缀）' : '') +
          (v.ambiguous
            ? `  ⚠️ 有歧义，另一个候选：${v.suggested_path_keep ?? v.suggested_name_keep}` +
              (v.conflict_keep ? '（这个名字也已被占用）' : '') +
              (v.conflict_keep_unknown ? '（这个候选也被改写过，同样要先 dry_run）' : '')
            : '')
      )
    }
    if (!listedAll) {
      lines.push(
        `… 一共 ${r.violation_count} 条。要拿更多：把 limit 调大（最多 2000，正文这边最多` +
          `列 ${MAX_LISTED} 条，调大不会把上下文撑爆），再不够就用 path 按目录分几次查。`
      )
    }
  }

  if ((r.ambiguous_count ?? 0) > 0) {
    lines.push('')
    lines.push(
      `其中 ${r.ambiguous_count} 条标了「有歧义」：名字开头那一段是**别的类型**的前缀，` +
        '但在这里可能是有意义的词（动画名里的 MF_ 多半是「女版」，不是材质函数）。' +
        '照 suggested_name 改会把那个词弄丢，两套动画还可能撞名。' +
        '这几条要么用 suggested_name_keep（保留原词），要么问用户，别自己拍板。'
    )
  }

  const unknown = countMap(r.unknown_classes)
  if (unknown) {
    lines.push('')
    lines.push(`没有前缀规则、**未检查**的类型：${unknown}。要审它们请通过 rules 传前缀。`)
  }

  // ── 用户自己的规则那一段。全量进正文：只写在 details 里等于没写 ──
  const applied = r.project_rules_applied
  if (applied) {
    lines.push('')
    // 归属目录那句由下面 directory_check 那段专门说清楚，这里不再含糊地写「已检查」
    lines.push(
      applied.custom_rules > 0
        ? `规范以虚幻官方推荐那一套为底，另外叠了用户自己写的 ${applied.custom_rules} 条改名规则。`
        : '规范用的是虚幻官方推荐那一套。'
    )
    // 前缀单独说，而且要说清「没生效」。自动发过去会让插件把旧前缀忘掉，于是命名
    // 本来就对的资产反被建议改成「新前缀 + 旧名字」，还不带任何警告标记
    if (applied.custom_prefixes.length > 0) {
      lines.push(
        `用户在命名规则页改过这些前缀：${applied.custom_prefixes.join('、')} —— ` +
          '**这次审计没有按它们来**，上面的违规判定用的是官方前缀。' +
          '要按他的规范审，先跟他确认，然后用 rules 显式传（键写引擎类名，如 Texture2D），' +
          '并且提醒他：改过前缀的类型，原来那批命名正确的资产也会被一并列成待改名。'
      )
    }
  }

  if (renames.length > 0) {
    lines.push('')
    const shownRenames = renames.slice(0, renameBudget)
    lines.push(
      shownRenames.length < renames.length
        ? `另有 ${renames.length} 个资产**前缀是合规的**，但按用户自己的规则仍然要动（下面列 ${shownRenames.length} 条）：`
        : `另有 ${renames.length} 个资产**前缀是合规的**，但按用户自己的规则仍然要动（全部列在这里）：`
    )
    for (const item of shownRenames) {
      // 只换名字的条目写新名字就够。整条 suggested_path 里的目录部分和 item.path 一模一样，
      // 每行白搭三十来个字符，两百行就是两千个 token
      const target = item.directory_expected
        ? item.suggested_path
        : item.suggested_path.slice(item.suggested_path.lastIndexOf('/') + 1)
      const why = [
        ...item.custom_rules.map((h) => `规则「${h.rule}」`),
        ...(item.directory_expected ? [`应放在 ${item.directory_expected}`] : [])
      ].join('，')
      lines.push(`- ${item.path} → ${target}（${why}）`)
    }
    if (shownRenames.length < renames.length) {
      lines.push(
        `… 这一组一共 ${renames.length} 条，上面只列了 ${shownRenames.length} 条。` +
          '要拿剩下的，用 path 按目录分几次查 —— 别只改看得见的这些就报「整理完了」。'
      )
    }
  }

  // 「没查」和「查了没问题」必须分开说：两者在别的字段上长得一样
  if (r.directory_check === 'requested_but_rules_disabled') {
    lines.push('')
    lines.push(
      '你要求检查归属目录，但同时传了 use_project_rules:false —— 那一层整个没跑，' +
        '**一个资产的位置都没查**。别把这条当成「位置都对」。'
    )
  } else if (r.directory_check === 'requested_but_no_table') {
    lines.push('')
    lines.push(
      '你要求检查归属目录，但**一个资产的位置都没查**：要么用户没在「偏好设置 → 命名规则 → ' +
        '资产归属目录」里改过任何一条，要么他配的那几类这次一个都没扫到' +
        '（比如配了音频，而插件根本不检查音频）。别把这条当成「位置都对」。'
    )
  } else if (r.directory_check === 'requested_but_directories_invalid') {
    lines.push('')
    lines.push(
      '你要求检查归属目录，用户也确实配过，但他填的**没有一条是包路径**，所以' +
        '**一个资产的位置都没查**。别说他没配 —— 他配了，只是填法不对，' +
        '具体哪几条见下面那段。别把这条当成「位置都对」。'
    )
  } else if (r.directory_check === 'checked') {
    lines.push('')
    lines.push(
      r.directory_mismatch_count && r.directory_mismatch_count > 0
        ? `位置不对的有 ${r.directory_mismatch_count} 个，分散在上面两组里。` +
            '违规那一组里，箭头右边是**整条路径**的就是要换目录的；' +
            '第二组里带「应放在 …」的是。只按用户改过的那几类判，其余类型没查。'
        : '位置都对 —— 但只覆盖用户改过的那几类归属目录，其余类型没查。'
    )
  }

  if (r.compliant_truncated) {
    lines.push('')
    lines.push(
      `插件按 limit 截断了合规资产清单（共 ${r.compliant_count} 个），所以上面` +
        '「前缀合规但要改」那一组和位置检查都只覆盖了这一截，不是全工程。' +
        `要覆盖全工程：把 limit 调大（最多 2000，正文这边最多列 ${MAX_LISTED} 条，` +
        '所以调大只多花引擎那边的时间，不会把上下文撑爆），2000 还不够就用 path 按目录分几次查。'
    )
  }

  const rejected = r.rejected_custom_rules ?? []
  if (rejected.length > 0) {
    lines.push('')
    const unnamed = rejected.filter((x) => x.reason === 'unnamed').length
    const empty = rejected.filter((x) => x.reason === 'empty').map((x) => x.rule)
    if (unnamed > 0) {
      lines.push(
        `有 ${unnamed} 条自定义规则没起名字，这次**没有生效**。让用户去「偏好设置 → 命名规则」` +
          '里给它们填上名称 —— 规则本身可能是对的，只是没名字没法引用。'
      )
    }
    if (empty.length > 0) {
      lines.push(
        `这几条自定义规则没填「要找的原文」，这次**没有生效**：${empty.join('、')}。` +
          '空的原文在任何名字里都算匹配，套上去等于给每个资产都插一段。照实告诉用户。'
      )
    }
  }

  const badDirs = r.rejected_directories ?? []
  if (badDirs.length > 0) {
    lines.push('')
    lines.push(
      '用户在「资产归属目录」里填的这几条不是包路径，这次**没有参与检查**：' +
        `${badDirs.map((d) => `${d.type} → ${d.value}`).join('、')}。` +
        '包路径要以 / 开头（如 /Game/Meshes）—— 照现在这样填，就算比出结果，' +
        'ue_content_move 也会整批拒掉。告诉用户补上开头的 /Game。'
    )
  }

  const hasRewritten =
    renames.length > 0 ||
    r.violations.some((v) => v.conflict_unknown === true || v.conflict_keep_unknown === true)
  if (hasRewritten) {
    lines.push('')
    lines.push(
      '标了 conflict_unknown 的条目：建议名是按用户规则改写过的，插件没拿这个名字查过注册表，' +
        '所以「会不会撞名」这一项这里给不出结论。这些必须先跑 ue_content_move 的 dry_run。'
    )
  }

  lines.push('')
  const total = r.violation_count + renames.length
  if (total > 0) {
    lines.push(
      '下一步：把 {source: path, destination: suggested_path} 交给 ue_content_move 批量改名（先 dry_run）。conflict=true 的要先换名字。'
    )
  } else {
    // **「都合规」是个全工程结论，只有这次真的看全了才说得出口。**
    // 上面刚说完「合规清单被截断了」「归属目录一个都没查」，末尾再来一句「都已合规」，
    // 模型就照着这句去回话 —— 一个 4800 个合规资产的工程里只看了 200 个，
    // 报出去的是「你的项目命名很规范」。这句话不能由 total === 0 单独决定
    const gaps: string[] = []
    if (r.compliant_truncated) gaps.push('合规清单被截断了')
    if (r.truncated) gaps.push('违规清单被截断了')
    if (
      r.directory_check &&
      r.directory_check !== 'checked' &&
      r.directory_check !== 'not_requested'
    )
      gaps.push('归属目录一个都没查')
    if (rejected.length > 0) gaps.push('有自定义规则没生效')
    if (badDirs.length > 0) gaps.push('有归属目录填得不对')

    lines.push(
      gaps.length === 0
        ? '有规则的类型都已合规。'
        : `**看到的这部分**没发现要改的，但这次没看全（${gaps.join('、')}），` +
            '所以还不能说整个工程都合规。要给结论，先按上面说的把没覆盖到的补齐。'
    )
  }
  return lines.join('\n')
}

/** 盒子侧文本扫描（ue_project_path_refs）的一条命中，摘要只用这几个字段 */
export interface ExternalRefHit {
  file: string
  line: number
  token: string
  suggested_token?: string
}

export interface ExternalRefsSummary {
  hits: ExternalRefHit[]
  scanned_files: number
  truncated: boolean
  note: string
  /** 扫描本身没跑成（没绑工程之类），原因写这里，不当成「没有引用」 */
  skipped_reason?: string
}

export interface BatchMoveAggregate {
  dry_run: boolean
  chunks: number
  planned: number
  moved: number
  skipped: number
  errors: number
  failed: number
  conflicts: { source: string; destination: string }[]
  items: BatchMoveResponse['items']
  items_truncated: boolean
  redirectors_found: number
  redirectors_fixed: number
  saved_count: number
  save_failed: string[]
  dirty_after: number
  elapsed_ms: number
  notes: string[]
  ok: boolean
  /** 整批没动的原因（插件的闸）；盒子侧的文本扫描拦下时是 external_refs */
  reason?: string
  checkout?: CheckoutPreflight
  cdo_refs?: CdoRefs
  engine_log: string[]
  auto_answered_dialogs: AutoAnsweredDialog[]
  external_refs?: ExternalRefsSummary
  /** 非预演成功落盘后写的账本 id，回滚用 */
  ledger_id?: string
}

const STATE_TEXT: Record<string, string> = {
  writable: '可写',
  needs_checkout: '需要签出（引擎会自动签出）',
  checked_out_other: '被别人签出着',
  not_at_head: '不是最新版本',
  readonly_no_scc: '只读文件（没开源码管理）',
  scc_unavailable: '源码管理连不上'
}

function describeState(s: PackageWriteState): string {
  const base = STATE_TEXT[s.state] ?? s.state
  const who = s.state === 'checked_out_other' && s.checked_out_by ? `（${s.checked_out_by}）` : ''
  const role =
    s.role === 'referencer' && s.for && s.for.length > 0
      ? `，它引用了 ${s.for.slice(0, 3).join('、')}${s.for.length > 3 ? ' 等' : ''}`
      : ''
  return `${base}${who}${role}`
}

/**
 * 一道闸在摘要里的口吻：预演时是「执行会怎样」，被拦下时是「为什么没动」，
 * proceed 放行时是「替你做了什么 / 后果自负」。
 */
export type GateMode = 'preview' | 'blocked' | 'proceeded'

const GATE_TAIL: Record<GateMode, string> = {
  preview: '，执行时整批都不会动（默认 fail）',
  blocked: '，整批都不会动',
  proceeded: '（proceed，照发了，引擎会整批拒绝）'
}

/** 签出预检那一段。有阻塞时点名到文件和人；没阻塞时一句话带过 */
export function checkoutLines(c: CheckoutPreflight | undefined, mode: GateMode): string[] {
  if (!c) return []
  const lines: string[] = []
  if (c.blocked > 0) {
    lines.push(
      `⛔ 签出预检：这一批要动 ${c.checked} 个文件，其中 ${c.blocked} 个动不了${GATE_TAIL[mode]}：`
    )
    for (const s of c.blocking.slice(0, SAMPLE)) {
      lines.push(`- ${s.package}：${describeState(s)}${s.filename ? `  ${s.filename}` : ''}`)
    }
    if (c.blocking.length > SAMPLE)
      lines.push(
        `… 只列了前 ${SAMPLE} 个，一共 ${c.blocked} 个动不了。分批调用（batch_size 小一点）能逐批看全。`
      )
    lines.push(
      c.scc_enabled && c.scc_available === false
        ? '源码管理开着但连不上，先把 Provider 连好再试。'
        : '先去签出 / 同步 / 去掉只读，或者联系签出的人；确认无误也可以 on_blocked=proceed。'
    )
  } else if (c.scc_enabled) {
    const needs = (c.states ?? []).filter((s) => s.state === 'needs_checkout').length
    lines.push(
      `签出预检通过：源码管理 ${c.scc_provider ?? ''}`.trimEnd() +
        `，${c.checked} 个文件` +
        (needs > 0 ? `，其中 ${needs} 个引擎会自动签出` : '，都可写')
    )
  }
  return lines
}

/** CDO 引用那一段 */
export function cdoLines(c: CdoRefs | undefined, mode: GateMode): string[] {
  if (!c || c.hits.length === 0) return []
  const lines: string[] = []
  const assets = new Set(c.hits.map((h) => h.asset))
  lines.push(
    `⛔ ${assets.size} 个资产被 C++ 类的默认值引用` +
      (mode === 'proceeded' ? '（proceed，命令替你点了确定）' : GATE_TAIL[mode]) +
      '：'
  )
  for (const h of c.hits.slice(0, SAMPLE)) {
    lines.push(`- ${h.asset} ← ${h.class}::${h.property}（${h.kind === 'soft' ? '软' : '硬'}引用）`)
  }
  if (c.hits.length > SAMPLE)
    lines.push(
      `… 只列了前 ${SAMPLE} 条，一共 ${c.hits.length} 条。要看全的话，把这批 moves 拆小分几次 dry_run。`
    )
  if (mode !== 'proceeded') {
    lines.push(
      '引擎改名前会弹一个确认框；无人值守下它会被自动取消，整批一个都不动。' +
        '先把代码里的路径改掉（ue_project_path_refs 能列出在哪），或者用 on_cdo_refs=proceed 让命令替你点「确定」。'
    )
  }
  return lines
}

/** 盒子侧文本扫描那一段 */
export function externalRefLines(e: ExternalRefsSummary | undefined, mode: GateMode): string[] {
  if (!e) return []
  const lines: string[] = []
  if (e.skipped_reason) {
    lines.push(`工程文本扫描没跑：${e.skipped_reason}`)
    return lines
  }
  if (e.hits.length === 0) {
    lines.push(
      `工程文本扫描（${e.scanned_files} 个文件）：没有发现按路径引用这批资产的代码 / 配置。${e.note}`
    )
    return lines
  }
  lines.push(
    `⚠️ 工程文本里有 ${e.hits.length}${e.truncated ? '+' : ''} 处按路径引用这批资产，搬走会断` +
      (mode === 'proceeded' ? '（proceed，已经搬了，这些引用现在是断的）' : GATE_TAIL[mode]) +
      '：'
  )
  for (const h of e.hits.slice(0, SAMPLE)) {
    lines.push(
      `- ${h.file}:${h.line}  ${h.token}` +
        (h.suggested_token ? `  → 建议改成 ${h.suggested_token}` : '')
    )
  }
  if (e.hits.length > SAMPLE)
    lines.push(
      `… 只列了前 ${SAMPLE} 条，一共 ${e.hits.length} 条。用 ue_project_path_refs 单独扫这批路径能拿到全量。`
    )
  lines.push(
    e.note +
      (mode === 'proceeded'
        ? ' 本工具不代改源码，上面的建议要自己改。'
        : ' 改完这些文本再搬，或者 on_external_refs=proceed 先搬再改。本工具不代改源码。')
  )
  return lines
}

export function summarizeBatchMove(a: BatchMoveAggregate): string {
  const lines: string[] = []
  const blockedBatch = !a.dry_run && a.reason !== undefined
  const modeFor = (reason: string): GateMode =>
    a.dry_run ? 'preview' : a.reason === reason ? 'blocked' : 'proceeded'
  if (blockedBatch) {
    const why: Record<string, string> = {
      checkout_blocked: '签出预检有阻塞',
      cdo_referenced: '有资产被 C++ 类默认值引用',
      external_refs: '工程文本里有会断的引用'
    }
    lines.push(
      `【整批没有移动】原因：${why[a.reason ?? ''] ?? a.reason}。计划里有 ${a.planned} 个资产。`
    )
  } else if (a.dry_run) {
    lines.push(
      `【预演，没有改动任何东西】计划移动 ${a.planned} 个资产，跳过 ${a.skipped}，无法处理 ${a.errors}` +
        (a.conflicts.length > 0 ? `，目标冲突 ${a.conflicts.length}` : '')
    )
  } else {
    lines.push(
      `已移动 ${a.moved}/${a.planned} 个资产` +
        (a.failed > 0 ? `，失败 ${a.failed}` : '') +
        (a.skipped > 0 ? `，跳过 ${a.skipped}` : '') +
        (a.errors > 0 ? `，无法处理 ${a.errors}` : '') +
        `，耗时 ${Math.round(a.elapsed_ms)}ms` +
        (a.chunks > 1 ? `（分 ${a.chunks} 批）` : '')
    )
    lines.push(
      `落盘 ${a.saved_count} 个包` +
        (a.save_failed.length > 0 ? `，${a.save_failed.length} 个保存失败` : '') +
        (a.dirty_after > 0 ? `，仍有 ${a.dirty_after} 个包未保存` : '')
    )
    if (a.redirectors_found > 0) {
      // 这里不再清理重定向器：引擎的 FixupReferencers 在无人值守下必崩
      // （UE 5.4+ 那个「Redirector Update Report」模态框，见插件里的长注释）
      lines.push(
        `旧路径上留下了 ${a.redirectors_found} 个重定向器，**没有清理**。` +
          '引擎自己会跟着它们转发，工程照常能用，不影响打包。' +
          '要清掉的话用 ue_fixup_redirectors —— 那条命令会在编辑器里弹一个报告框，需要有人点一下。'
      )
    }
    if (a.ledger_id) {
      lines.push(`账本已记：${a.ledger_id}（搬错了用 ue_content_rollback 回滚）`)
    }
  }

  // 三道闸的结果：预演时是「提醒」，执行时是「为什么没动 / 替你做了什么」
  const gate = [
    ...checkoutLines(a.checkout, modeFor('checkout_blocked')),
    ...cdoLines(a.cdo_refs, modeFor('cdo_referenced')),
    ...externalRefLines(a.external_refs, modeFor('external_refs'))
  ]
  if (gate.length > 0) {
    lines.push('')
    lines.push(...gate)
  }
  if (a.auto_answered_dialogs.length > 0) {
    lines.push('')
    lines.push(`命令替你回答了 ${a.auto_answered_dialogs.length} 个引擎弹窗：`)
    for (const d of a.auto_answered_dialogs.slice(0, 5)) {
      lines.push(
        `- [${d.type}${d.answer ? ` → ${d.answer}` : ''}] ${d.message.replace(/\s+/g, ' ').slice(0, 200)}`
      )
    }
  }

  const problems = a.items.filter(
    (i) => i.status === 'error' || i.status === 'failed' || i.status === 'skipped'
  )
  if (problems.length > 0) {
    lines.push('')
    lines.push(`需要注意的条目（前 ${Math.min(SAMPLE, problems.length)} 条）：`)
    for (const p of problems.slice(0, SAMPLE)) {
      lines.push(`- ${p.source}：${p.status}${p.error ? ` —— ${p.error}` : ''}`)
    }
  }

  const referenced = a.items.filter(
    (i) => i.referencers > 0 && (i.status === 'planned' || i.status === 'moved')
  )
  if (a.dry_run && referenced.length > 0) {
    lines.push('')
    lines.push(
      `${referenced.length} 个资产被其他资产引用；移动后引用会经旧路径上的重定向器转发。` +
        '重定向器会留在原地（清理它需要人在编辑器里点一下确认框，见执行后的说明），引用不会断。'
    )
  }

  if (a.conflicts.length > 0) {
    lines.push('')
    lines.push(`目标已存在（前 ${Math.min(SAMPLE, a.conflicts.length)} 条）：`)
    for (const c of a.conflicts.slice(0, SAMPLE)) lines.push(`- ${c.source} → ${c.destination}`)
  }

  // 引擎日志只在有失败时给：成功的时候那几行 Warning 不是模型该看的
  if (a.engine_log.length > 0 && (a.failed > 0 || a.save_failed.length > 0)) {
    lines.push('')
    lines.push('引擎日志（LogAssetTools，Warning 及以上）：')
    for (const l of a.engine_log.slice(0, 10)) lines.push(`  ${l}`)
    if (a.engine_log.length > 10)
      lines.push(
        `  … 只列了前 10 行，一共 ${a.engine_log.length} 行；其余的在编辑器的 Output Log 里（筛 LogAssetTools）。`
      )
  }

  for (const note of a.notes) lines.push(note)
  if (a.items_truncated)
    lines.push(
      '（条目超过 500 条，只记录了前 500 条；账本和这份摘要都一样，要全量就把 moves 拆小分几次调。）'
    )
  return lines.join('\n')
}

function walkLines(title: string, w: DependencyWalk, isFolder: boolean): string[] {
  const lines: string[] = []
  lines.push(
    `${title}：${w.count} 个包，合计 ${humanBytes(w.total_disk_size)}，最深 ${w.max_depth_reached} 层` +
      (w.truncated ? '（已到 max_nodes 上限，是下限）' : '')
  )
  const byClass = countMap(w.by_class)
  if (byClass) lines.push(`  按类型：${byClass}`)
  if (isFolder && w.external_count !== undefined) {
    lines.push(`  在目录**外面**的：${w.external_count} 个`)
    for (const n of (w.external ?? []).slice(0, SAMPLE)) {
      lines.push(`  - ${n.path}（${n.class}，${humanBytes(n.disk_size)}）`)
    }
    if ((w.external_count ?? 0) > SAMPLE)
      lines.push(
        `  … 只列了前 ${SAMPLE} 个，一共 ${w.external_count} 个。对子目录逐个调一次能看全。`
      )
  } else {
    for (const n of w.nodes.slice(0, SAMPLE)) {
      lines.push(`  - [${n.depth}] ${n.path}（${n.class}，${humanBytes(n.disk_size)}）`)
    }
    if (w.count > SAMPLE)
      lines.push(
        `  … 只列了前 ${SAMPLE} 个，一共 ${w.count} 个。把 max_depth 调小、或者对子节点单独查能看全。`
      )
  }
  if (w.missing && w.missing.length > 0) {
    lines.push(`  ⚠️ 断链：${w.missing.length} 个依赖包不存在`)
    for (const m of w.missing.slice(0, SAMPLE)) lines.push(`  - ${m}`)
  }
  return lines
}

export function summarizeDependencies(r: DependenciesResponse): string {
  const lines: string[] = []
  lines.push(
    r.scope_is_folder
      ? `目录 ${r.root}（${r.root_asset_count} 个资产）`
      : `资产 ${r.root}` + (r.hard_only ? '，只看硬引用' : '')
  )
  if (r.dependencies) {
    lines.push('')
    lines.push(...walkLines('依赖（它用到了谁）', r.dependencies, r.scope_is_folder))
  }
  if (r.referencers) {
    lines.push('')
    lines.push(...walkLines('被引用（谁用到了它）', r.referencers, r.scope_is_folder))
  }
  if (r.unreferenced) {
    lines.push('')
    lines.push(
      `没有任何引用者的资产：${r.unreferenced_count ?? r.unreferenced.length} 个，合计 ${humanBytes(r.unreferenced_disk_size ?? 0)}`
    )
    for (const n of r.unreferenced.slice(0, SAMPLE)) {
      lines.push(`- ${n.path}（${n.class}，${humanBytes(n.disk_size)}）`)
    }
    if ((r.unreferenced_count ?? 0) > SAMPLE)
      lines.push(
        `… 只列了前 ${SAMPLE} 个，一共 ${r.unreferenced_count} 个。按目录分几次调（path 收窄）能逐批看全。`
      )
  }
  if (r.notes.length > 0) {
    lines.push('')
    for (const note of r.notes) lines.push(note)
  }
  return lines.join('\n')
}

export function summarizeMigrate(r: MigrateResponse): string {
  const lines: string[] = []
  if (r.dry_run) {
    lines.push(
      `【预演，没有拷贝任何文件】${r.root_count} 个根资产连同依赖共 ${r.planned} 个文件（${humanBytes(r.total_bytes)}）将拷到 ${r.destination_content_dir}` +
        (r.skipped > 0 ? `，${r.skipped} 个目标已存在将跳过` : '') +
        (r.external_skipped > 0 ? `，${r.external_skipped} 个插件内容目标工程没有对应插件` : '')
    )
  } else {
    lines.push(
      `已拷贝 ${r.copied} 个文件（${humanBytes(r.total_bytes)}）到 ${r.destination_content_dir}` +
        (r.skipped > 0 ? `，跳过 ${r.skipped}` : '') +
        (r.failed > 0 ? `，失败 ${r.failed}` : '') +
        (r.external_skipped > 0 ? `，插件内容跳过 ${r.external_skipped}` : '') +
        `，耗时 ${Math.round(r.elapsed_ms)}ms`
    )
  }
  const roots = r.files.filter((f) => f.is_root)
  if (roots.length > 0) {
    lines.push('')
    lines.push(`根资产（前 ${Math.min(SAMPLE, roots.length)} 条）：`)
    for (const f of roots.slice(0, SAMPLE)) lines.push(`- ${f.package}：${f.status}`)
  }
  const bad = r.files.filter((f) => f.status === 'failed' || f.status === 'external_skipped')
  if (bad.length > 0) {
    lines.push('')
    lines.push(`没拷成的（前 ${Math.min(SAMPLE, bad.length)} 条）：`)
    for (const f of bad.slice(0, SAMPLE))
      lines.push(`- ${f.package}：${f.status}${f.error ? ` —— ${f.error}` : ''}`)
  }
  if (r.missing && r.missing.length > 0) {
    lines.push('')
    lines.push(`⚠️ 断链依赖（本工程里就不存在，拷不了）：${r.missing.slice(0, SAMPLE).join('、')}`)
  }
  if (r.unsaved_sources && r.unsaved_sources.length > 0) {
    lines.push(`有未保存改动的源资产：${r.unsaved_sources.length} 个`)
  }
  if (r.notes.length > 0) {
    lines.push('')
    for (const note of r.notes) lines.push(note)
  }
  if (r.files_truncated) lines.push('（文件太多，details.files 只保留前 500 条）')
  return lines.join('\n')
}
