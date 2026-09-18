/**
 * 内容浏览器整理工具集的引擎侧响应形状。
 *
 * 字段名和插件 `UAL_ContentOrganizeCommands.cpp` 一一对应（snake_case 原样透传），
 * 这里只声明、不转换 —— 两边各起一套名字就是漂移的起点。
 */

export interface NamingViolation {
  path: string
  name: string
  class: string
  expected_prefix: string
  reason: 'missing_prefix' | 'wrong_prefix' | 'prefix_case' | string
  suggested_name: string
  suggested_path: string
  conflict?: boolean
  rule_source?: 'extended'
  /**
   * 剥掉的开头那一段是**别的类型**的前缀，可能其实是有意义的词
   * （动画名里的 `MF_` 多半是「女版」，不是材质函数）。
   * 这种条目要人看一眼再改，不能照单执行。
   */
  ambiguous?: boolean
  /** ambiguous 时的另一个候选：保留原词，只在前面加规范前缀 */
  suggested_name_keep?: string
  suggested_path_keep?: string
  /** 第二候选的名字也已经被占了 */
  conflict_keep?: boolean

  // ── 以下是盒子侧按用户自己的命名规则补上的，插件不产出 ──

  /**
   * 命中的自定义改名规则（「偏好设置 → 命名规则 → 自定义规则」里那些）。
   * 有这一项说明 `suggested_name` 已经被我们改写过，不是插件原来给的那个。
   */
  custom_rules?: { rule: string; before: string; after: string }[]
  /**
   * 冲突未知。
   *
   * 插件的 `conflict` 是拿**它自己**算的建议名查注册表得来的；名字被自定义规则或
   * 归属目录改写之后那个结论就不作数了，而我们在这一层查不了注册表。
   * 这类条目必须先跑 `ue_content_move` 的 `dry_run`。
   */
  conflict_unknown?: boolean
  /** 同上，但说的是第二候选 `suggested_name_keep`。两个候选各有各的「查过没有」 */
  conflict_keep_unknown?: boolean
  /** 按用户的归属目录，这个资产应该在哪。只有当前位置不在那个目录下面时才有 */
  directory_expected?: string
}

/**
 * 只按用户自己的规则才要改的资产 —— 前缀是合规的，但撞上了自定义规则或放错了目录。
 *
 * 单列一组而不是混进 `violations`：那一组的语义是「不合 Epic 前缀规范」，
 * 混进去会让「违规 N 个」这个数变成两套标准的混合体，用户对不上账。
 */
export interface ProjectRuleRename {
  path: string
  class: string
  suggested_path: string
  /** 命中的自定义规则；只因为目录不对而入选时是空的 */
  custom_rules: { rule: string; before: string; after: string }[]
  /** 按用户的归属目录该在哪。只因为名字入选时没有这一项 */
  directory_expected?: string
  /** 同上：这一层查不了注册表，冲突得靠 dry_run */
  conflict_unknown: true
}

export interface NamingAuditResponse {
  ok: boolean
  path: string
  scanned: number
  compliant_count: number
  violation_count: number
  conflict_count: number
  /** 建议里有几条剥掉的前缀可能是语义词，需要人定夺 */
  ambiguous_count?: number
  skipped_count: number
  violations: NamingViolation[]
  compliant?: { path: string; class: string }[]
  by_reason: Record<string, number>
  by_class: Record<string, number>
  unknown_classes: Record<string, number>
  rules_used: string[]
  truncated: boolean
  rules_source: string
  note: string

  // ── 以下是盒子侧补的（见 namingPolicy.ts）──

  /** 前缀合规、但撞上用户自定义规则或放错目录的那些 */
  project_rule_renames?: ProjectRuleRename[]
  /** 放错目录的条数。violations 那边的 + project_rule_renames 那边的，两组互不相交 */
  directory_mismatch_count?: number
  /**
   * 归属目录到底查了没有。
   *
   * `not_requested` 调用方没要；`checked` 真比对过至少一个资产的位置；
   * `requested_but_no_table` 要了但一次都没比成 —— 用户没配归属目录，或者他配的那几类
   * 这次一个都没扫到（配了 SoundWave 而插件根本不检查音频，或者 class_filter 只要了别的类）；
   * `requested_but_directories_invalid` 要了、用户也配了，但他配的那些**不是包路径**，
   * 一条都用不了（见 `rejected_directories`）—— 和上一档分开，是因为那一档的文案会说
   * 「用户没改过任何一条」，而这里他明明改过；
   * `requested_but_rules_disabled` 要了，但同时传了 use_project_rules:false，整层没跑。
   *
   * 后三档和「查了，位置都对」在别的字段上长得一模一样，必须单独说得出来。
   */
  directory_check?:
    | 'not_requested'
    | 'checked'
    | 'requested_but_no_table'
    | 'requested_but_directories_invalid'
    | 'requested_but_rules_disabled'
  /**
   * 插件按 limit 截断了合规清单。
   *
   * 插件自己的 `truncated` 只反映 violations，合规那头不报，所以这条是盒子按
   * `compliant_count` 和数组长度自己对出来的。为真时 `project_rule_renames` 和
   * `directory_mismatch_count` 都只覆盖了返回来的那一截，不是全工程。
   */
  compliant_truncated?: boolean
  /** 这次没生效的自定义规则：没起名字（unnamed），或者要找的原文是空的（empty） */
  rejected_custom_rules?: { rule: string; reason: 'unnamed' | 'empty' }[]
  /**
   * 用户填的归属目录里没法用的那些 —— 不是 `/Game/…` 这种包路径。
   *
   * 这类值比对出来的结论执行不了（`ue_content_move` 会整批拒掉），所以既不算「查过」
   * 也不能悄悄跳过：跳过的话摘要会说「用户没配归属目录」，而他明明配了。
   */
  rejected_directories?: { type: string; value: string }[]
  /** 这次用了用户的哪些规则，写给模型看 */
  project_rules_applied?: {
    /**
     * 用户改过的前缀，形如 `Texture → TX_`。**只是报告，没有参与这次审计** ——
     * 发给插件会让它把旧前缀整个忘掉，于是命名正确的资产反被建议改成「新前缀+旧名字」。
     */
    custom_prefixes: string[]
    custom_rules: number
  }
}

export interface BatchMoveItem {
  source: string
  destination?: string
  class?: string
  referencers: number
  status: 'planned' | 'skipped' | 'error' | 'moved' | 'failed' | string
  error?: string
  auto_renamed?: boolean
  /** 落盘后的目标文件指纹（安全网 §4），只在 moved 且 save=true 时有 */
  file?: string
  bytes?: number
  mtime?: string
}

/**
 * 签出预检里一个包的状态（安全网 §2.3）。
 * `state` 五种里后三种加 `scc_unavailable` 会让整批不动，插件用 `blocks` 明说。
 */
export interface PackageWriteState {
  package: string
  filename?: string
  state:
    | 'writable'
    | 'needs_checkout'
    | 'checked_out_other'
    | 'not_at_head'
    | 'readonly_no_scc'
    | 'scc_unavailable'
    | string
  checked_out_by?: string
  blocks?: boolean
  /** 这个包是被搬的资产（source）还是它的引用者（referencer） */
  role?: 'source' | 'referencer' | string
  /** role=referencer 时：它引用的是这一批里的哪些源 */
  for?: string[]
}

export interface CheckoutPreflight {
  scc_enabled: boolean
  scc_provider?: string
  scc_available?: boolean
  checked: number
  blocked: number
  blocking: PackageWriteState[]
  states?: PackageWriteState[]
  states_truncated?: boolean
  note?: string
}

/** 一条被原生 C++ 类默认值（CDO）引用的记录（安全网 §3.3） */
export interface CdoRef {
  asset: string
  class: string
  property: string
  kind: 'hard' | 'soft' | string
}

export interface CdoRefs {
  checked: number
  hits: CdoRef[]
  note?: string
}

/** on_cdo_refs=proceed 时命令替用户回答过的引擎弹窗，一次都不藏 */
export interface AutoAnsweredDialog {
  type: string
  title?: string
  message: string
  answer?: string
}

export interface BatchMoveResponse {
  ok: boolean
  dry_run: boolean
  planned: number
  moved: number
  skipped: number
  errors: number
  failed?: number
  conflicts: { source: string; destination: string }[]
  on_conflict: string
  items: BatchMoveItem[]
  items_truncated?: boolean
  redirectors_found?: number
  redirectors_fixed?: number
  saved_count?: number
  save_failed?: string[]
  dirty_after?: number
  elapsed_ms: number
  notes?: string[]
  error?: string
  /** 整批没动的原因：签出预检有阻塞 / 有 CDO 引用（默认 fail 时） */
  reason?: 'checkout_blocked' | 'cdo_referenced' | string
  checkout?: CheckoutPreflight
  cdo_refs?: CdoRefs
  /** RenameAssets / FixupReferencers 期间 LogAssetTools 的 Warning 及以上行 */
  engine_log?: string[]
  auto_answered_dialogs?: AutoAnsweredDialog[]
}

export interface DependencyNode {
  path: string
  class: string
  depth: number
  disk_size: number
  external?: boolean
}

export interface DependencyWalk {
  count: number
  total_disk_size: number
  max_depth_reached: number
  truncated: boolean
  by_class: Record<string, number>
  nodes: DependencyNode[]
  nodes_truncated: boolean
  external_count?: number
  external?: DependencyNode[]
  missing?: string[]
  edges?: { from: string; to: string }[]
  edges_truncated?: boolean
}

export interface DependenciesResponse {
  ok: boolean
  root: string
  scope_is_folder: boolean
  root_count: number
  root_asset_count: number
  direction: string
  hard_only: boolean
  dependencies?: DependencyWalk
  referencers?: DependencyWalk
  unreferenced?: { path: string; class: string; disk_size: number }[]
  unreferenced_count?: number
  unreferenced_disk_size?: number
  unreferenced_truncated?: boolean
  notes: string[]
}

export interface MigrateFile {
  package: string
  status: 'planned' | 'copied' | 'skipped_exists' | 'failed' | 'external_skipped' | string
  destination_file?: string
  bytes: number
  is_root: boolean
  error?: string
}

export interface MigrateResponse {
  ok: boolean
  dry_run: boolean
  destination_content_dir: string
  root_count: number
  planned: number
  copied: number
  skipped: number
  failed: number
  external_skipped: number
  total_bytes: number
  files: MigrateFile[]
  files_truncated: boolean
  missing?: string[]
  not_found?: string[]
  unsaved_sources?: string[]
  save_failed?: string[]
  notes: string[]
  elapsed_ms: number
}
