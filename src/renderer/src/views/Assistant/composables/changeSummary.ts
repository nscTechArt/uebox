import type { AgentProcessItem } from '../components/AgentProcessLog.types'

export type ToolRisk = 'safe' | 'mutating' | 'destructive'

/**
 * 台账里的一条改动 —— 一次真的动了东西的工具调用。
 *
 * 台账是**全的**，它会落盘给「用量」页统计；面板显示的是它的一个子集，
 * 哪些不上面板见 `PANEL_HIDDEN_TOOLS`。所以下面这些字段（命令原文、
 * 能不能撤回）对本地命令行照样成立，只是用户在「本轮改动」里看不到那几行。
 */
export interface ChangeEntry {
  /** 工具名，界面按它取展示文案 */
  toolName: string
  risk: ToolRisk
  /** 改的是哪个东西：蓝图路径 / 资产路径 / 文件路径 / Actor 名，取不到就空串 */
  target: string
  /**
   * 同一个工具的多次调用可能干着不同的事，target 表达不了的那部分放这里：
   * shell / 脚本 / 控制台命令是命令原文，插件管理是 Enable/Disable 方向。
   * 取不到就省略。没有它，「执行命令行 ×2」到底跑了什么就永远是个黑盒。
   */
  detail?: string
  /** 这一步能不能撤回。shell 命令干了什么我们无从得知，只能标成不可回滚 */
  reversible: boolean
  /** 执行失败的调用也列出来，但标明没生效 */
  failed: boolean
}

/**
 * 从参数里挑出「改的是什么」。
 *
 * 三十多个工具各有各的参数名，逐个写映射会变成一张没人维护的表；
 * 这里只按常见键名找第一个像目标的字符串，找不到就不显示目标。
 */
const TARGET_KEYS = [
  'blueprintPath',
  'blueprint_path',
  'materialPath',
  'material_path',
  'material_name',
  'assetPath',
  'asset_path',
  'targetPath',
  'target_path',
  'folderPath',
  'folder_path',
  'actorName',
  'actor_name',
  'levelPath',
  'level_path',
  // ue_set_level_streaming 的参数就叫 level。没有它，一轮改三个子关卡
  // 会缩成一行没有名字的「改子关卡加载方式 ×3」，用户看不出动了哪几层
  'level',
  // 新建关卡把路径放在 save_as 里。没有它，清单上是一行光秃秃的「新建关卡」——
  // 用户不知道那个关卡叫什么，也就没法回去找
  'save_as',
  'path',
  'name',
  // spawn 的实例用 asset_id 指定要放什么（别名/路径/类名），没有单独的 name 时用它
  'asset_id',
  // ue_manage_plugin 动的就是这个插件；通用的 name 键帮不上它
  'plugin_name',
  // 浏览器：`browser_open` 给 url，`browser_interact` 给已被主进程核对过的
  // 元素标签。**不取 value** —— 用户输入的内容在审批弹窗里已经看过一遍，
  // 没有理由再长期挂在台账上
  'url',
  'label'
] as const

/**
 * 「名字」和「放哪个文件夹」分成两个参数的工具。
 *
 * `material_create` 收的是 `material_name` + `destination_path`，而后续所有
 * 材质工具收的是拼好的 `material_path`。**不拼起来，同一个材质会在清单上
 * 占两行**：一行「材质 M_GlowBreath 新建」，一行「材质 M_GlowBreath 修改」——
 * 用户看着像建了两个东西。
 *
 * 只列**明确的**名字键，不含通用的 `name`：`name` + `destination_path` 同时
 * 出现在别的工具上时拼出来的未必是资产路径。
 */
const NAME_KEYS = [
  'material_name',
  'instance_name',
  'asset_name',
  'blueprint_name',
  'widget_name',
  'level_name'
] as const
const FOLDER_KEYS = ['destination_path', 'destinationPath', 'package_path'] as const

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 结构化参数可能是对象，也可能是模型塞过来的 JSON 字符串 —— Actor 那几个工具
 * 自己也是两种都收（见 `setProperty.ts` 的 `parseTargetsInput`）。只认对象的话，
 * 模型改用字符串形式传参的那些轮次会整轮从台账上消失。
 */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/**
 * Actor 类工具的统一选择器 `{ selection?, names?, paths?, filter? }`。
 *
 * **目标埋在第二层，顶层白名单扫不到。** 不拆开的话 `ue_set_property` 在清单上
 * 就是光秃秃一行「Actor 修改属性」——动的是哪个 Actor，用户无从知道。
 *
 * 只取第一个：参数说的是**想改谁**，真正改到了谁由工具返回值给准信，
 * 见 `extractChangeOutcomes`。这里是拿不到返回值时（调用失败）的兜底。
 * `selection`（改用户此刻选中的那些）在参数里根本没有名字，返回空串。
 */
function targetFromSelector(raw: unknown): string {
  const selector = parseMaybeJson(raw)
  if (!isPlainObject(selector)) return ''

  const first = (value: unknown): string =>
    Array.isArray(value) && typeof value[0] === 'string' ? value[0].trim() : ''

  return first(selector.names) || first(selector.paths)
}

export function extractChangeTarget(args: unknown): string {
  if (!args || typeof args !== 'object') return ''

  let record = args as Record<string, unknown>

  // MCP 的 `call_tool` 是个派发器：它自己永远叫 call_tool，真正干了什么
  // 在参数里。不拆开的话，一轮里改了 Niagara、改了 PCG、改了动画，
  // 清单上会是三行一模一样的「call_tool」—— 等于没写。
  const toolName = record.tool_name ?? record.toolName
  if (typeof toolName === 'string' && toolName.trim()) {
    const toolset = record.toolset_name ?? record.toolsetName
    const scope =
      typeof toolset === 'string' && toolset.trim()
        ? // Epic 的工具集名形如 `NiagaraToolsets.NiagaraToolset_System`，
          // 前半段是插件名、后半段才是人看的那个，取后半段
          toolset.trim().split('.').pop()
        : ''
    return scope ? `${scope}.${toolName.trim()}` : toolName.trim()
  }

  // `ue_set_property` / `ue_set_transform` 用 `targets` 选择器指定改谁
  const selected = targetFromSelector(record.targets)
  if (selected) return selected

  // `ue_spawn_actor` 收的是 `instances: [{asset_id, name, …}]` 这样一批。
  // 不拆开的话顶层一个像目标的键都没有，清单上只剩「创建 Actor」四个字 ——
  // 放了什么、叫什么，全看不见。
  const batch = record.instances ?? record.batch
  if (Array.isArray(batch) && batch[0] && typeof batch[0] === 'object') {
    record = { ...(batch[0] as Record<string, unknown>), ...record }
  }

  const name = firstString(record, NAME_KEYS)
  const folder = firstString(record, FOLDER_KEYS)
  if (name && folder) return `${folder.replace(/\/+$/, '')}/${name}`

  return firstString(record, TARGET_KEYS)
}

/** MCP 工具名前缀，见主进程 `McpClientManager.toSafeToolName` */
const MCP_PREFIX = 'mcp_'

/**
 * 这条改动是不是经 MCP server 做的。
 *
 * 界面要据此换一套说法：`mcp_ue-official_call_tool` 这种名字对用户毫无意义，
 * 而「虚幻引擎工具集」是他能对上号的东西（设置页里就是这么叫的）。
 */
export function isMcpChange(entry: Pick<ChangeEntry, 'toolName'>): boolean {
  return String(entry.toolName ?? '').startsWith(MCP_PREFIX)
}

/**
 * 工具名 → 界面文案的 i18n key。
 *
 * ## 为什么是查表 + 回退，而不是硬编码一张全表
 *
 * 有名字的工具八十多个，其中会进「本轮改动」的（非只读）约四十个。
 * 硬写一张全表，漏一个就是界面上冒出个 `undefined`；靠命名规则拼接，
 * 又会在 `ue_content_audit_optimization` 这种名字上拼出病句。
 *
 * 所以：**有翻译就用翻译，没有就原样显示工具名**。新增工具时忘了配文案，
 * 退化成今天的样子（能看懂的英文标识），而不是坏掉。
 */
export function changeLabelKey(toolName: string): string {
  return `assistant.changes.tools.${toolName}`
}

/** 盘符路径（`C:\` `C:/`）或 UNC 网络路径（`\\server\share\`） */
const LOCAL_FILE_TARGET = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])/

/**
 * 这条改动动的是不是硬盘上的文件。
 *
 * 「本轮改动」里混着两类东西：写本地文件，和改引擎里的蓝图 / 材质 / Actor。
 * 后者的 target 是 `/Game/...` 这种引擎内路径，套不进「N 个文件已更改」，
 * 也没有资源管理器和编辑器可以打开，所以界面上分成两组。
 *
 * @param entry 一条改动
 */
export function isLocalFileChange(entry: Pick<ChangeEntry, 'target'>): boolean {
  return LOCAL_FILE_TARGET.test(String(entry.target ?? '').trim())
}

/**
 * 这个 target 是不是引擎内的资产路径（`/Game/…`、`/Engine/…`、插件挂载点）。
 *
 * 清单里的 target 混着三种东西：资产路径、Actor 名（`Cube`）、本地文件路径。
 * 只有第一种能在编辑器里打开，界面据此决定要不要给「在编辑器中打开」按钮。
 *
 * 主进程 `openAsset.ts` 里有一份同样的判断 —— 那边是入参防线（不信任传进去的
 * 字符串），这边是显示判断（不给点不动的按钮）。两边各自成立，不是可以合并的重复。
 */
export function isEngineAssetPath(target: string): boolean {
  return /^\/[A-Za-z0-9_]+\/.+/.test(String(target ?? '').trim())
}

/**
 * 一个资产在这一轮里的净结果。
 *
 * 只有三种，因为用户只会问这三个问题：这东西是新出现的、原来就有被改了、
 * 还是没了。中间过程（加了几个节点、连了几条线）不在这个维度上。
 */
export type ChangeAction = 'created' | 'modified' | 'deleted' | 'enabled' | 'disabled'

/** 动的是哪类东西。认不出来时是空串 —— 不显示类型，好过显示一个猜的 */
export type ChangeKind =
  | 'material'
  | 'blueprint'
  | 'widget'
  | 'level'
  | 'actor'
  | 'asset'
  | 'folder'
  | 'file'
  | 'note'
  | 'web'
  | 'plugin'

/** 一类步骤，同工具名且同 detail 的合并计数（加十个节点是一条 ×10，不是十行） */
export interface ChangeStep {
  toolName: string
  /** 这几步共同的差异信息（命令原文 / 启停方向），见 ChangeEntry.detail */
  detail?: string
  count: number
  /** 这一类里失败了几次 */
  failedCount: number
}

/** 一个被动过的东西 —— 界面上的一行 */
export interface ChangeGroup {
  /** 分组键，同时用作列表 key */
  key: string
  /** 完整目标路径；万能工具（`ue_run_python_script`）取不到，为空串 */
  target: string
  /** 硬盘上的文件（可以打开、定位）还是引擎里的东西 */
  local: boolean
  action: ChangeAction
  kind: ChangeKind | ''
  /** 这一组一共几步 */
  stepCount: number
  /** 其中失败几步 */
  failedCount: number
  /** 其中撤不回去几步 */
  irreversibleCount: number
  /** 明细，展开后才显示 */
  steps: ChangeStep[]
}

/**
 * 建出一个**资产**的工具。
 *
 * 只列资产级的新建：`blueprint_add_variable` 建的是蓝图里面的东西，
 * 那个蓝图本身是「被修改」，不是「被新建」。
 *
 * 用显式集合而不是 `endsWith('_create')` 之类的规则 —— `material_delete_node`
 * 删的是节点不是材质，任何按名字猜的规则都会在这种地方翻车。
 */
const CREATE_TOOLS = new Set([
  'material_create',
  'material_create_instance',
  'blueprint_create',
  'widget_create',
  'ue_new_level',
  'ue_spawn_actor',
  'ue_content_import',
  'create_folders',
  'create_note'
])

/** 同理，删掉整个东西的工具（不含删节点、删组件这种局部操作） */
const DELETE_TOOLS = new Set([
  'ue_destroy_actor',
  'ue_content_delete',
  'delete_note',
  'delete_assets',
  // 删文件夹连里面的资产一起软删，净结果就是「这个文件夹没了」
  'delete_folders'
])

/**
 * 收尾内务 —— 这些**永远不单独占一行**。
 *
 * ## 判据：用户能不能在自己工程里指着它说「这个」
 *
 * 「材质 M_GlowBreath」可以，「新建关卡」可以。而「保存」「编译」「整理连线」
 * 「运行试玩」不行 —— 它们是 agent 干活的过程，不是工程里多出来的东西。
 * 用户从来没要求过「整理一下连线」，那是模型自己的收尾习惯。
 *
 * 真机截图里，一轮「建个呼吸发光材质」的改动清单有 7 行，其中
 * 「保存 ×2」「保存关卡」「运行试玩」占了 3 行 —— **一半的篇幅在讲用户
 * 不关心的事**，而真正的那个材质还被拆成了两行。
 *
 * ## 它们没有被丢掉
 *
 * 能对上某个资产的（`material_compile` 带着材质路径）照常并进那个资产的
 * 展开区，在「这个材质上做了哪几件事」里显示。只有对不上任何资产的
 * （`ue_save` 不带参数）才真的不显示 —— 那种情况下它本来也说不出改了什么。
 *
 * 整轮只有内务时清单为空，面板不显示。这是对的：用户说「保存一下」，
 * 你保存了，正文回一句就够了，不需要再给他一张台账。
 */
const BOOKKEEPING_TOOLS = new Set([
  'ue_save',
  'ue_save_level',
  'ue_collect_garbage',
  'ue_playtest',
  'blueprint_compile',
  'blueprint_compile_all',
  'blueprint_tidy_graph',
  'material_compile',
  'material_tidy_graph'
])

/**
 * 记进台账、但不在「本轮改动」面板上显示的工具。
 *
 * ## 为什么本地命令行不显示
 *
 * 这个面板回答的是「我的工程里变了什么」。`run_shell_command` 跑在用户自己的
 * 电脑上，既不是工程里的资产，也没有可打开、可审查的目标 —— 它在清单上只能
 * 原样贴一条命令，而那条命令多半是 `where ffmpeg`、`ls -l` 这种探路，却照样
 * 顶着一个「不可回滚」的红标。真机上一轮五条探路命令就是五行「不可回滚」，
 * 把真正改了工程的那几行挤了出去：狼来了喊多了，红标本身就失效了。
 *
 * **命令没有因此消失。** 三个本地工具都定成 destructive（见 `localShell.ts`），
 * 每一条都要用户在审批弹窗里点头才跑得起来，过程日志里也一字不落地留着原文。
 * 面板不必再抄第三遍。
 *
 * ## 为什么只在这一层挡，不在 `summarizeChanges()` 里挡
 *
 * 那一步的产物会**落盘**进 `responseMetadata.changes`，而「用量」页正是拿它算
 * 改动总数和按工具排行（见 `Usage/usageStats.ts`）。在写入侧挡掉，等于顺手把
 * 统计口径也改了：改动之前的日子照常计命令行，之后一条不计，同一张图前后半段
 * 对不上。这里只是**不显示**，台账本身仍然完整。
 *
 * UE 的控制台命令和 Python 脚本不在此列 —— 它们动的就是这个工程本身。
 */
const PANEL_HIDDEN_TOOLS = new Set(['run_shell_command'])

/**
 * 这一步能不能不单独占一行。
 *
 * **destructive 的一律占一行**，哪怕它长得像内务。`ue_open_level` 和
 * `ue_restart_editor` 会丢掉用户没保存的改动，`ue_fixup_redirectors` 会改一批
 * 资产的引用 —— 这些正是用户最需要在清单上看见的。漏报一次不可逆的操作，
 * 比多显示一行糟得多：用户会以为那一步什么都没干。
 *
 * 判据交给风险表而不是我这份名单，将来某个工具被重新定级，这里自动跟着变。
 */
function isBookkeeping(entry: ChangeEntry): boolean {
  return entry.risk !== 'destructive' && BOOKKEEPING_TOOLS.has(entry.toolName)
}

/**
 * 工具名 → 类型。按前缀匹配，第一条命中的算数，所以**顺序有意义**：
 * `material_set_property` 必须先撞上 `material_`，不能落到后面的 `ue_set_property`。
 *
 * 认不出来就没有类型标签。这里宁可少标也不要标错 —— 一个错的类型比没有类型更误导。
 */
const KIND_RULES: ReadonlyArray<readonly [string, ChangeKind]> = [
  ['material_', 'material'],
  ['blueprint_', 'blueprint'],
  ['widget_', 'widget'],
  ['ue_new_level', 'level'],
  ['ue_open_level', 'level'],
  ['ue_save_level', 'level'],
  ['ue_set_level_streaming', 'level'],
  ['level_organize_actors', 'level'],
  ['ue_spawn_actor', 'actor'],
  ['ue_destroy_actor', 'actor'],
  ['ue_set_transform', 'actor'],
  ['ue_set_property', 'actor'],
  ['ue_manage_plugin', 'plugin'],
  ['ue_content_', 'asset'],
  ['annotate_asset', 'asset'],
  ['delete_assets', 'asset'],
  ['restore_assets', 'asset'],
  ['move_assets', 'asset'],
  ['create_folders', 'folder'],
  ['rename_folder', 'folder'],
  ['delete_folders', 'folder'],
  ['write_local_file', 'file'],
  ['edit_local_file', 'file'],
  ['create_note', 'note'],
  ['update_note', 'note'],
  ['delete_note', 'note'],
  // 浏览器操作也进台账：用户该看得见 agent 打开了哪个网站、点了什么。
  // 只有 open / interact 会到这里 —— 读取、滚动、截图是 safe，进不了台账
  ['browser_', 'web']
]

export function changeKindOf(toolName: string): ChangeKind | '' {
  const rule = KIND_RULES.find(([prefix]) => toolName.startsWith(prefix))
  return rule ? rule[1] : ''
}

/**
 * shell 跑了什么我们不知道，永远标成不可回滚；其余写操作原则上可回滚。
 *
 * 网页交互同理，而且更彻底：点出去的那一下发生在别人的服务器上，
 * 盒子这边没有任何东西可以撤。
 */
const IRREVERSIBLE_TOOLS = new Set(['run_shell_command', 'browser_interact'])

export function isReversibleTool(toolName: string): boolean {
  return !IRREVERSIBLE_TOOLS.has(toolName)
}

/**
 * 有些工具**同一个名字**下有的调用撤得回、有的撤不回。
 *
 * `ue_set_level_streaming` 就是：改几个标志是普通属性改动，进撤销栈；换流送方式
 * 走的是「摘掉旧对象、按新类重加一个」，Ctrl+Z 接不住。按工具名一刀切的话，
 * 要么整类误报（改个标志也吓唬人），要么整类漏报 —— 而漏报的后果是正文里
 * 写着「Ctrl+Z 撤不回来」，旁边的台账却把这一步标成可回滚，用户照着台账去撤，
 * 什么也没发生。
 *
 * 所以这类工具自己在返回里说。没说的按工具名判，行为和以前一样。
 */
function readUndoableFlag(result: unknown): boolean | null {
  if (!isPlainObject(result)) return null
  const undoable = (result as { undoable?: unknown }).undoable
  return typeof undoable === 'boolean' ? undoable : null
}

/**
 * 这几个工具「具体干了什么」target 装不下 —— 命令原文不是工程里的路径，
 * 塞进 target 会被当成资产去分组、去判断能不能打开。单独抽进 detail：
 * shell / 脚本 / 控制台命令是命令原文，插件管理是启停方向。
 *
 * 没有它，界面只能写「执行命令行 ×2」「启用/停用插件」——
 * 哪两条命令、启了还是停了，用户一样也答不出来。
 */
const DETAIL_KEYS: Record<string, readonly string[]> = {
  run_shell_command: ['command'],
  ue_run_console_command: ['command'],
  ue_run_python_script: ['script'],
  ue_manage_plugin: ['action']
}

/**
 * 同上，但「干了什么」是一坨键值对而不是一个字符串。
 *
 * `ue_set_property` 收 `properties: { Intensity: 10000 }`，`ue_set_transform`
 * 收 `operation: { set: { location: {…} } }`。这两个原来一个 detail 都抽不出来，
 * 于是清单上永远只有「修改属性」「调整位置/旋转/缩放」——**改成什么了，
 * 这个面板从来没回答过**，而那正是用户唯一想知道的事。
 */
const DETAIL_OBJECT_KEYS: Record<string, readonly string[]> = {
  ue_set_property: ['properties'],
  ue_set_transform: ['operation']
}

/** 一个值压成一行能读的样子：数组 `[1, 2]`，向量/颜色 `(0, 0, 100)` */
function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return `[${value.map(formatScalar).join(', ')}]`
  if (typeof value === 'object') {
    return `(${Object.values(value as Record<string, unknown>)
      .map(formatScalar)
      .join(', ')})`
  }
  return String(value)
}

/**
 * detail 的长度上限。
 *
 * 它随聊天记录写进 localStorage（配额只有几 MB），而 `properties` 理论上
 * 能有任意多个键 —— 不封顶的话一次批量改属性就能把存储撑掉一块。
 * 界面那边还会再截到 80 字显示，这里管的是**存进去多少**。
 */
const MAX_DETAIL_LENGTH = 120

function flattenInto(value: unknown, prefix: string, out: string[]): void {
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    // 向量 / 颜色这种「一组数字」压成 (0, 0, 100)：键名（x/y/z、r/g/b）本来
    // 就是位置约定，写出来只是噪音。顶层不这么压 —— 那一层的键是属性名，
    // 恰恰是要显示的东西
    if (prefix && entries.length > 0 && entries.every(([, item]) => !isPlainObject(item))) {
      out.push(`${prefix}=${formatScalar(value)}`)
      return
    }
    for (const [key, item] of entries) flattenInto(item, prefix ? `${prefix}.${key}` : key, out)
    return
  }
  out.push(`${prefix}=${formatScalar(value)}`)
}

/** 键值对拍平成 `Intensity=10000, LightColor=(255, 0, 0)`。语言无关，直接显示 */
export function formatChangeProperties(properties: unknown): string {
  const parsed = parseMaybeJson(properties)
  if (!isPlainObject(parsed)) return ''

  const parts: string[] = []
  flattenInto(parsed, '', parts)

  const text = parts.join(', ')
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text
}

export function extractChangeDetail(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>

  const keys = DETAIL_KEYS[toolName]
  if (keys) return firstString(record, keys)

  for (const key of DETAIL_OBJECT_KEYS[toolName] ?? []) {
    const text = formatChangeProperties(record[key])
    if (text) return text
  }
  return ''
}

/**
 * 一次调用**实际动到的一样东西**，从工具返回值里读出来。
 *
 * 参数说的是「想改谁、想改成什么」，返回值说的是「真改了谁、真写进去了什么」。
 * 两者不一定一致：`targets.selection` 在参数里根本没有名字，批量改属性时
 * 一半成功一半报错，spawn 出来的 Actor 会被引擎改名（`Cube` → `Cube_2`）。
 * 台账要的是后者。
 */
export interface ChangeOutcome {
  target: string
  detail?: string
  /** 这一样东西上什么都没改成（别的可能改成了，所以整次调用未必算失败） */
  failed?: boolean
}

/**
 * 一次调用最多展开成几行。
 *
 * 清单的行数应当等于「我的工程里变了几样东西」，所以一次改三个 Actor
 * 就该是三行。但按 `filter` 批量改属性可以一次命中几十上百个，那时逐行列出来
 * 只会把面板变成一堵墙 —— 超过上限就退回一行，宁可粗，不要不可读。
 * 退回的那一行仍然带着参数里的属性清单，不会变回黑盒。
 */
const MAX_OUTCOME_ROWS = 8

/** 返回值里一条 Actor 记录的名字。引擎给的 `path` 是极长的对象路径，名字优先 */
function outcomeName(item: Record<string, unknown>): string {
  return firstString(item, ['name', 'path', 'asset_id'])
}

function readActorList(list: unknown): ChangeOutcome[] {
  if (!Array.isArray(list)) return []
  // spawn 失败的项是 null（`created` 与输入等长，保持顺序）
  return list.filter(isPlainObject).map((item) => ({ target: outcomeName(item) }))
}

/**
 * `ue_set_property` 的返回值：`actors: [{ name, updated, errors }]`。
 *
 * `updated` 是**引擎确认写进去了的那些属性** —— 报错的属性不在里面。
 * 所以这里得到的 detail 比参数里的那份准：用户看到的是真生效的东西。
 */
function readSetProperty(result: Record<string, unknown>): ChangeOutcome[] {
  const actors = result.actors
  if (!Array.isArray(actors)) return []

  return actors.filter(isPlainObject).map((actor) => {
    const updated = isPlainObject(actor.updated) ? actor.updated : {}
    const applied = Object.keys(updated).length > 0
    const detail = formatChangeProperties(updated)

    const outcome: ChangeOutcome = { target: outcomeName(actor) }
    if (detail) outcome.detail = detail
    // 这个 Actor 上一个属性都没改成。整次调用可能仍算成功（别的 Actor 改成了），
    // 但这一行必须标出来，否则用户以为它也改了
    if (!applied) outcome.failed = true
    return outcome
  })
}

/**
 * 工具名 → 怎么从它的返回值里读出「动了哪几样东西」。
 *
 * 显式表而不是通用规则：`actors` / `created` 这些键名各家不同，靠猜会在
 * 某个返回同名字段但含义不同的工具上翻车。漏配一个只是退回参数那套，不会坏。
 */
const OUTCOME_READERS: Record<string, (result: Record<string, unknown>) => ChangeOutcome[]> = {
  ue_set_property: readSetProperty,
  ue_set_transform: (result) => readActorList(result.actors),
  ue_spawn_actor: (result) => readActorList(result.created)
}

export function extractChangeOutcomes(toolName: string, result: unknown): ChangeOutcome[] {
  const read = OUTCOME_READERS[toolName]
  if (!read || !isPlainObject(result)) return []

  const outcomes = read(result).filter((outcome) => outcome.target)
  return outcomes.length > MAX_OUTCOME_ROWS ? [] : outcomes
}

function readToolCall(item: AgentProcessItem): { name: string; args: unknown } | null {
  const data = item.data as
    | { function?: { name?: unknown; arguments?: unknown }; name?: unknown; args?: unknown }
    | undefined
  if (!data) return null

  const name =
    typeof data.function?.name === 'string'
      ? data.function.name
      : typeof data.name === 'string'
        ? data.name
        : ''
  if (!name) return null

  let args: unknown = data.args
  const rawArgs = data.function?.arguments
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs)
    } catch {
      args = undefined
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs
  }

  return { name, args }
}

/**
 * 从这一轮的过程日志里挑出「真的动了东西」的调用。
 *
 * 只读工具（risk === 'safe'）不算改动 —— 把三十次查询混进来，
 * 用户就看不见那一次真正改了蓝图的调用了。
 *
 * 调用和结果按**工具名出现的先后**配对：过程日志的结果项里没有 toolCallId，
 * 同名工具的第 n 次调用对应第 n 条结果。顺序错配只影响「成功/失败」这一个标记，
 * 不影响改动清单本身。
 */
export function summarizeChanges(
  items: AgentProcessItem[],
  riskTable: Record<string, ToolRisk>
): ChangeEntry[] {
  // 配对时连返回值一起留着：改了哪几个 Actor、哪几个属性真写进去了，
  // 只有返回值知道。原来这里只取了 isError 一个布尔，等于把答案扔了
  const resultsByTool = new Map<string, Array<{ isError: boolean; result: unknown }>>()
  for (const item of items) {
    if (item.type !== 'tool-result') continue

    const data = item.data as
      | { toolName?: unknown; isError?: unknown; result?: unknown }
      | undefined
    const toolName = typeof data?.toolName === 'string' ? data.toolName : ''
    if (!toolName) continue

    const list = resultsByTool.get(toolName) || []
    list.push({ isError: data?.isError === true, result: data?.result })
    resultsByTool.set(toolName, list)
  }

  const seenByTool = new Map<string, number>()
  const entries: ChangeEntry[] = []

  for (const item of items) {
    if (item.type !== 'tool-call') continue

    const call = readToolCall(item)
    if (!call) continue

    const risk = riskTable[call.name]
    if (!risk || risk === 'safe') continue

    const detail = extractChangeDetail(call.name, call.args)

    // `ue_manage_plugin` 的 Query 是只读查询，什么都没改。风险表按工具定级，
    // 看不见参数里的方向 —— 不在这里挡一下，一次查询也会以「启用/停用插件」
    // 的面目进台账，用户还以为插件被动过了
    if (call.name === 'ue_manage_plugin' && detail !== 'Enable' && detail !== 'Disable') continue
    // 同理：dry_run=true 的预演（清理重定向器、删资产、搬迁……）什么都没改
    if ((call.args as { dry_run?: unknown } | undefined)?.dry_run === true) continue

    const index = seenByTool.get(call.name) ?? 0
    seenByTool.set(call.name, index + 1)

    const paired = resultsByTool.get(call.name)?.[index]
    const failed = paired?.isError === true

    const entry: ChangeEntry = {
      toolName: call.name,
      risk,
      target: extractChangeTarget(call.args),
      // 工具自己报了 undoable 就以它为准 —— 同一个工具的不同调用可撤销性不同
      reversible: readUndoableFlag(paired?.result) ?? isReversibleTool(call.name),
      failed
    }
    // detail 挂在后面而不是放进字面量：历史消息里存的是没有 detail 的旧条目，
    // 两边结构要保持「可选字段缺席」一致
    if (detail) entry.detail = detail

    // 返回值是事实，参数只是意图。有返回值就按它展开 —— 一次调用动了三个 Actor
    // 就是三行，每行带着那个 Actor 上真写进去的属性。失败的调用没有返回值可读，
    // 退回参数那一行（它本来也什么都没改）
    const outcomes = failed ? [] : extractChangeOutcomes(call.name, paired?.result)
    if (outcomes.length === 0) {
      entries.push(entry)
      continue
    }

    for (const outcome of outcomes) {
      const expanded: ChangeEntry = {
        ...entry,
        target: outcome.target,
        failed: outcome.failed === true
      }
      const outcomeDetail = outcome.detail ?? detail
      if (outcomeDetail) expanded.detail = outcomeDetail
      else delete expanded.detail
      entries.push(expanded)
    }
  }

  return entries
}

/**
 * 裸名字 → 完整路径的对照表。
 *
 * 同一个资产在不同工具的参数里有两种写法：`material_create` 只给名字
 * （`M_GlowBreath`），其余材质工具给完整路径（`/Game/GlowDemo/M_GlowBreath`）。
 * `extractChangeTarget` 已经在能拼的时候拼好了，但工具没传保存路径时拼不出来 ——
 * 那时就靠这张表把裸名字并到同一行去，否则用户会看见两个 M_GlowBreath。
 *
 * **同名不同目录的两个资产不合并**：`/Game/A/M_X` 和 `/Game/B/M_X` 都叫 M_X，
 * 这时无法判断裸名字指的是哪个，宁可让它单独占一行，也不能把两个资产并成一个。
 */
function buildTargetAliases(entries: ChangeEntry[]): Map<string, string> {
  const byBasename = new Map<string, string | null>()

  for (const entry of entries) {
    if (!entry.target.includes('/')) continue
    const base = entry.target.split('/').pop() || ''
    if (!base) continue
    const known = byBasename.get(base)
    // 已经记过一个不同的路径 → 这个名字有歧义，标成 null 不再用它合并
    byBasename.set(base, known === undefined || known === entry.target ? entry.target : null)
  }

  const aliases = new Map<string, string>()
  for (const entry of entries) {
    if (entry.target.includes('/') || !entry.target) continue
    const full = byBasename.get(entry.target)
    if (full) aliases.set(entry.target, full)
  }
  return aliases
}

/**
 * 把逐次调用的改动清单，按「动的是哪个东西」聚合成一行一个。
 *
 * ## 为什么必须聚合
 *
 * 原来是一次工具调用一行。而做一个材质是三十多次调用（建资产、加十个节点、
 * 连九条线、编译、整理连线），于是清单长这样：
 *
 *     给材质加节点  /Game/GlowDemo/M_GlowBreath
 *     给材质加节点  /Game/GlowDemo/M_GlowBreath
 *     …（再来七行一模一样的）
 *     连接材质引脚  /Game/GlowDemo/M_GlowBreath
 *     …（再来八行一模一样的）
 *
 * 用户看完这三十六行，知道的还是只有「材质被改了」。因为**行数是 agent 的
 * 施工步数，不是他工程里变了几样东西**，而这两个数没有关系：同一件事换个
 * 实现可能 3 步也可能 300 步，用户关心的始终是前者。
 *
 * 聚合之后一行一个资产，行数就等于「我的工程里多了/变了几样东西」，而且
 * 天然有上限 —— 一轮里人不会让 agent 动五十个资产，但工具调用数没有上限。
 * 「不爆炸」靠的是这个上限，不是靠折叠。
 *
 * ## 施工步骤没有丢
 *
 * 它们进了 `steps`，同名的合并计数（「给材质加节点 ×10」），由界面收在
 * 每一行的展开区里。排查问题时要看的就是它，但日常不该占着视野。
 *
 * @param input `summarizeChanges()` 的结果
 */
export function groupChanges(input: ChangeEntry[]): ChangeGroup[] {
  // 不该上面板的先滤掉（见 PANEL_HIDDEN_TOOLS）。挡在这一层而不是写入那一层：
  // 聚合本来就放在渲染侧做，换了规则立刻对历史对话生效，而落盘的台账保持完整，
  // 「用量」页的统计口径不受影响
  const entries = input.filter((entry) => !PANEL_HIDDEN_TOOLS.has(entry.toolName))

  const canonical = buildTargetAliases(entries)
  const targetOf = (entry: ChangeEntry): string => canonical.get(entry.target) ?? entry.target
  // 取不到目标的（`ue_run_python_script` 这种能干任何事的工具）按工具名归一组，
  // 否则跑六次脚本又是六行一模一样的字 —— 那正是这个函数要解决的问题。
  // 带 detail 的再按 detail 拆：跑两条不同的命令是两件事，并成一行「执行命令行
  // ×2」的话，命令原文就再也看不到了
  const keyOf = (entry: ChangeEntry): string =>
    targetOf(entry) || (entry.detail ? `${entry.toolName}::${entry.detail}` : entry.toolName)

  // 第一遍只决定「清单上有哪几行」。内务操作不开新行，见 BOOKKEEPING_TOOLS。
  // 分成两遍是为了跟顺序无关：编译碰巧跑在第一次编辑之前，也不该凭空多出一行
  const groups = new Map<string, ChangeGroup>()
  for (const entry of entries) {
    if (isBookkeeping(entry)) continue

    const key = keyOf(entry)
    if (groups.has(key)) continue

    const target = targetOf(entry)
    groups.set(key, {
      key,
      target,
      local: isLocalFileChange({ target }),
      action: 'modified',
      kind: changeKindOf(entry.toolName),
      stepCount: 0,
      failedCount: 0,
      irreversibleCount: 0,
      steps: []
    })
  }

  // 第二遍把每一步归进去。对不上任何一行的内务操作（不带参数的 `ue_save`）
  // 就此不显示 —— 它本来也说不出改了什么
  for (const entry of entries) {
    const group = groups.get(keyOf(entry))
    if (!group) continue

    group.stepCount += 1
    if (entry.failed) group.failedCount += 1
    // 失败的那步什么都没干，也就没什么可回滚的，不该计入「撤不回去」
    else if (!entry.reversible) group.irreversibleCount += 1

    // 一组里第一步可能是看不出类型的内务操作（`ue_save`），让后面的步骤补上
    if (!group.kind) group.kind = changeKindOf(entry.toolName)

    // 新建 / 删除按**最后一次**为准：先建后删，净结果是没了；
    // 先删后建（重做一个），净结果是新建。失败的那步不改变结论。
    if (!entry.failed) {
      if (CREATE_TOOLS.has(entry.toolName)) group.action = 'created'
      else if (DELETE_TOOLS.has(entry.toolName)) group.action = 'deleted'
      // 插件的净结果是「现在是启用还是停用」。先停后启，最后它开着
      else if (entry.toolName === 'ue_manage_plugin')
        group.action = entry.detail === 'Disable' ? 'disabled' : 'enabled'
    }

    const step = group.steps.find(
      (item) => item.toolName === entry.toolName && item.detail === entry.detail
    )
    if (step) {
      step.count += 1
      if (entry.failed) step.failedCount += 1
    } else {
      const step: ChangeStep = {
        toolName: entry.toolName,
        count: 1,
        failedCount: entry.failed ? 1 : 0
      }
      if (entry.detail) step.detail = entry.detail
      group.steps.push(step)
    }
  }

  return [...groups.values()]
}
