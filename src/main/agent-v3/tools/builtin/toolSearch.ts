/**
 * Beta 工具搜索：技能带组为主，搜索兜底。已加载定义按顺序保留，不做容量淘汰。
 * 不修改任何原始说明/schema/execute，不代理执行；审批和并发仍由原工具负责。
 * 预算按 UTF-8 字节约束，避免中文统一除以字符比例导致的系统性低估。
 */
import { z } from 'zod'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { defineTool, type ToolOutcome, type UnrealAgentTool } from '../defineTool'
import { BROWSER_TOOL_NAMES } from '../toolNames'

export const TOOL_SEARCH_NAME = 'search_tools'
/*
 * 这里曾经有一个 `LOADED_TOOL_BYTES = 64_000` 的加载区上限，2026-09-17 整个删掉。
 *
 * 删它的理由是这道闸**不可能防住任何事**：已加载 + 常驻永远是全库的子集，
 * 所以工具搜索的最坏情况恰好等于全量注入 —— 也就是关掉 Beta 的现状。
 * 一个永远不会让结果比现状更差的机制，不需要一道会让任务失败的闸。
 *
 * 而它的代价是真实的。实测：材质组 + 蓝图组被这道闸拒绝时，前缀是 56,605 token，
 * **只有全量注入（123,146）的 46%** —— 我们在一个仍然省一半的地方把任务判了死刑。
 * 而"蓝图 + 内容整理""场景 + 蓝图"等六种两组组合都会撞上，其中五种带蓝图组。
 *
 * 连带删掉的还有 `deferredGroups` / `capacityBlocked` 和那条"请关闭 Beta"的提示 ——
 * 容量既然不会不够，那条路径就是死的，留着只会让人以为它还在守什么。
 */

/**
 * docs/常驻工具集选定-2026-09-17.md §3。仅在原权限过滤后仍可用时常驻。
 *
 * 末尾三个（`ue_get_actor` / `ue_screenshot` / `ue_playtest`）是 2026-09-17 按
 * **「完全没有替代、且高频」** 这条判据补进来的，见文档 §4.2 / §4.3 ——
 * 纯按频次性价比排，这三个都在边缘甚至落选（`ue_screenshot` 0.5 pp 每千 token）。
 * 换判据的理由有两条：
 *
 * 1. 频次数据本身可疑。那 166 个会话是开发期测试记录，重心在蓝图和材质，
 *    actor / 关卡那几路被系统性压低了（文档 §5.7）。「有没有替代品」不随测试重心漂移。
 * 2. `ue_get_actor` 是 09-11 的头号混淆磁铁（22 次误伸里 10 次指向它），
 *    但那是**描述写太宽**造成的，已按文档 §6.5 改掉。藏起来不会让误用消失，
 *    只会换个形式落到别的常驻工具头上。
 */
export const RESIDENT_TOOL_NAMES = [
  'load_skill',
  'ue_get_project_info',
  'ue_content_search',
  'ue_get_current_level',
  'ue_session_health',
  'read_skill_resource',
  'project_list',
  'list_engines',
  'ue_get_selection',
  'read_local_file',
  'list_local_dir',
  'grep_local_files',
  'find_local_files',
  'write_local_file',
  'edit_local_file',
  'web_search',
  'web_read',
  'ue_run_python_script',
  'run_shell_command',
  'ue_run_console_command',
  'ue_save',
  'ue_list_unsaved',
  'ue_undo',
  'ue_undo_history',
  'search_assets',
  'library_overview',
  'task',
  // 见上面文件注释：按「没有替代品」补入，不是按频次
  'ue_get_actor',
  'ue_screenshot',
  'ue_playtest'
] as const

const CORE_NAMES = new Set<string>([
  ...RESIDENT_TOOL_NAMES,
  // 宿主交互能力按文档 §5.6 常驻；会话归属沿用首版 Beta 的常驻行为。
  'ask_user',
  'voice_report',
  'set_session_project',
  ...BROWSER_TOOL_NAMES
])

/**
 * 整组常驻的小组。2026-09-21 加。
 *
 * ## 这条线是怎么算出来的
 *
 * 折叠省的是**前缀字节**，但开了 prompt cache 之后前缀字节很便宜（首轮 1.25×
 * 写入，之后每轮 0.1× 读取），而**每加载一次组都让前缀变一次 = 作废整份缓存、
 * 全价重写一遍**。把一个组常驻 vs 折叠，跑一个 N 轮的会话：
 *
 * - 常驻：`1.25·g + 0.1·g·(N−1)`，N=10 时是 `2.15·g`
 * - 折叠且用到：比常驻多付 `1.25·P₀ − 0.1·g·(t−1)` ≈ `1.25·P₀`（P₀ 是底座前缀）
 *
 * 所以折叠划算的条件是 `p · 1.25·P₀ < (1−p) · g · 2.15`，其中 p 是「这个组在一条
 * 会话里被用到」的概率。P₀ ≈ 24,000 token 时右边那个阈值是 37,500 —— 一次加载事件
 * 顶得上 **17 轮**把这个组白带在前缀里。小组根本摊不平这笔钱。
 *
 * 逐组的盈亏平衡 p（`g × 2.15 / 37500`，g 取实测字节 ÷ 3.05 换成 token）。
 * **字节数测于 2026-09-21**，用 `TOOL_SEARCH_MEASURE=1` 跑
 * `toolSearchCatalog.test.ts` 的「记录各按需工具组的体积」可以复现 ——
 * 描述改一改这些数就会漂（本表成稿当天 `ue.sequencer` 就从 9,526 漂到 10,468），
 * 所以**重算这张表之前先重测一遍**，别拿今天的字节去比去年的行：
 *
 * | 组 | 字节 | 平衡 p | 取舍 |
 * |---|---:|---:|---|
 * | `local` | 1,129 | 2.1% | 常驻 |
 * | `mcp` | 3,187 | 6.0% | **留在折叠区**，见下 |
 * | `note` | 1,219 | 2.3% | 常驻 |
 * | `ue.mesh` | 1,309 | 2.5% | 常驻 |
 * | `ue.cpp` | 3,322 | 6.2% | 常驻 |
 * | `ue.animation` | 4,158 | 7.8% | 常驻 |
 * | `library` | 4,737 | 8.9% | 常驻 |
 * | `ue.input` | 5,331 | 10.0% | 常驻 |
 * | `ue.editor` | 6,098 | 11.5% | 常驻 |
 * | `ue.system` | 8,253 | 15.5% | **留在折叠区** |
 * | `video.production` | 9,521 | 17.9% | **留在折叠区** |
 * | `ue.sequencer` | 10,468 | 19.7% | **留在折叠区** |
 *
 * 线划在 6.1 KB 和 8.3 KB 之间，不是「小于 10 KB」这种整数 —— 上面三个的平衡 p
 * 已经进了 15%~20%，而 `ue.system` 在真实会话样本里是 12%（27/223 轮）。**它们是
 * 真正的边缘，留在折叠区等数据，不是被漏掉了。**
 *
 * `mcp`（2026-09-22 加）按平衡 p 排在 `ue.cpp` 和 `library` 之间，也就是这张表的
 * 常驻那一侧，但**没有放进来**：整组常驻另有一条 30,000 字节的线
 *（见 `toolSearchCatalog.test.ts` 的「测量完整真实定义」），此刻只剩约 1.5 KB 余量，
 * 放它进去就得抬那条线 —— 而那条线的规矩是「要抬先拿实测 p，不是改个数字」，
 * 我没有这个组的实测 p。折叠它的代价由另外两条路补上：`local-files` 技能正文里
 * 点了 `connect_mcp_server` 的名字（技能带组是主路径），系统提示词的 MCP 那一段
 * 也一直写着这个工具名（见 `capabilities/mcp/promptSection.ts`），
 * 所以模型不必靠 `search_tools` 撞才知道它存在。
 *
 * ## 这里的不确定性，别当它已经定了
 *
 * p 的分母是「会话」还是「轮次」会把结论翻过来：按轮次算，223 轮的样本里除
 * `ue.mesh`（7.2%）外这些组都 ≤5%，`ue.cpp` 往下那几个就该折叠。按会话算（一次
 * 加载事件本来就是会话级的），p 要乘 3~5 倍，整张表才都站得住。**我按会话算，
 * 因为付钱的单位是加载事件。**这个换算系数现在没有实测，拿到之后要回来重算。
 */
export const RESIDENT_TOOL_GROUPS = new Set<string>([
  'local',
  'note',
  'ue.mesh',
  'ue.cpp',
  'ue.animation',
  'library',
  'ue.input',
  'ue.editor'
])

/**
 * 用户在设置页里**改不动**的那几个。
 *
 * 它们是这套机制本身的一部分：`load_skill` / `read_skill_resource` / `search_tools`
 * 是唯一的加载入口，把它们挪出常驻区就没人能再加载任何工具；`ask_user` 是模型
 * 卡住时唯一能问人的通道；`task` 是派生子任务的入口。这几个被关掉的失败方式是
 * 「助手整个不动了，而设置页上看不出为什么」—— 不给这个开关。
 */
export const ALWAYS_RESIDENT_TOOL_NAMES = new Set<string>([
  'load_skill',
  'read_skill_resource',
  'search_tools',
  'ask_user',
  'task'
])

/** 没人动过设置时，这个工具是不是常驻。设置页拿它当每一条的默认值 */
export function isDefaultResidentTool(tool: GroupedTool): boolean {
  return CORE_NAMES.has(tool.name) || RESIDENT_TOOL_GROUPS.has(toolSearchGroup(tool))
}

/**
 * 只用于检索，不替代工具原文。
 *
 * 键是**工具组**（`toolSearchGroup`），不是命名空间 —— 两者从 2026-09-21 起会分叉
 * （见 `UE_CONTENT_SUBGROUPS`）。查不到会按 `a.b.c → a.b → a` 逐段回退，所以子组
 * 不写也能继承父段；`local.shell` 这种以前查不到的也跟着修好了。
 *
 * 表里缺一行的后果是无声的：那一组的中文查询只能指望描述里刚好有字面词。
 * `toolSearchCatalog.test.ts` 有一条门禁钉住「每个在用的组都回退得到一行」。
 */
const DOMAIN_TERMS: Record<string, string> = {
  'ue.blueprint': '蓝图 逻辑 节点 变量 事件 函数 blueprint graph node logic event function',
  'ue.material': '材质 材质实例 表面 颜色 贴图 纹理 material shader color surface texture',
  'ue.actor': '物体 场景 对象 位置 旋转 缩放 移动 灯光 actor transform spawn light',
  'ue.content': '内容浏览器 工程资产 内容 资产 content asset',
  'ue.content.import': '导入 导入资产 fbx 贴图 外部文件 入库 import ingest',
  'ue.content.organize': '整理 重命名 移动 删除 重定向 清理 organize rename move delete redirector',
  'ue.content.audit': '体检 依赖 引用 占用 体积 排行 报错日志 audit dependency size reference log',
  'ue.editor': '编辑器 截图 保存 撤销 运行 测试 重启 editor screenshot save undo playtest restart',
  'ue.editor.autoplay':
    '试玩 自动试玩 机器人 按键 操作 走到 目标 autoplay bot play input objective',
  'ue.level': '关卡 场景 大纲 世界 分区 流送 level world outliner streaming',
  'ue.landscape':
    '地形 地表 高度图 虚拟纹理 rvt 融合 landscape terrain heightmap virtual texture blend',
  'ue.system': '性能 崩溃 日志 插件 控制台 脚本 卡顿 crash log performance plugin python',
  'ue.widget': '界面 控件 按钮 文本 布局 widget umg ui layout button text',
  'ue.animation': '动画 骨骼 运动 animation skeleton motion',
  'ue.sequencer': '过场 镜头 摄像机 时间轴 序列 sequencer camera cinematic timeline',
  'ue.pcg': '程序化 散布 植被 pcg procedural scatter foliage',
  'ue.mesh': '网格 几何 模型 mesh geometry model',
  'ue.cpp': '代码 编译 类 模块 c++ compile code module',
  'ue.input': '输入 按键 操作 映射 input action key mapping',
  asset: '盒子素材库 保管库 标签 文件夹 asset library vault tag folder',
  library: '蓝图库 材质库 片段 收藏 snippet library',
  project: '工程 项目 创建 打开 启动 project create open launch',
  engine: '引擎 版本 安装 路径 engine version install path',
  aigc: '生成 图片 视频 三维 generate image video 3d',
  'video.production': '剪辑 成片 字幕 配音 合成 时间线 video edit subtitle voiceover render',
  note: '笔记 记事 待办 摘录 note todo memo',
  notebook: '知识库 笔记本 wiki 文档库 notebook knowledge wiki',
  browser: '浏览器 网页 点击 输入 browser webpage click',
  local: '本机 文件 目录 搜索 读写 local file directory search read write',
  'local.shell': '命令行 终端 脚本 执行 shell terminal command run',
  mcp: 'mcp 接入 连接 服务 第三方 集成 插件 server connect integration',
  host: '宿主 提问 播报 会话 host ask report session',
  core: '技能 加载 搜索 子任务 skill load search task',
  web: '联网 搜索 网页 文档 web search read documentation'
}

/**
 * 这个组的领域词。查不到就按 `.` 逐段往上回退，都没有返回空串。
 *
 * 回退而不是「每个子组抄一遍父段」：子组是为了**加载粒度**切的，它们在语义上
 * 仍然属于同一摊，抄一遍只会多三份要同步的文本。
 */
export function groupDomainTerms(group: string): string {
  /*
   * 第三方 MCP 的组（`mcp.<server>`）不往上找：`mcp` 那条说的是「接 MCP 这件事」
   * （接入、连接、插件、server…），摊给每个第三方组的话，搜「启用插件」会把它们全捞上来，
   * 目录里它们的名字也被这串通用词顶掉、看不出是哪台 server
   */
  if (group.startsWith('mcp.')) return ''
  let key = group
  for (;;) {
    // `Object.hasOwn` 的理由同 `toolSearchGroup`：命名空间叫 `constructor`
    // 的话，直接下标会返回原型链上的函数而不是这张表里的字符串
    if (Object.hasOwn(DOMAIN_TERMS, key)) return DOMAIN_TERMS[key]
    const cut = key.lastIndexOf('.')
    if (cut < 0) return ''
    key = key.slice(0, cut)
  }
}

export function toolDefinitionBytes(tool: UnrealAgentTool<never>): number {
  return Buffer.byteLength(
    JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
    'utf8'
  )
}

function terms(text: string): string[] {
  const result: string[] = []
  for (const match of text.toLowerCase().matchAll(/[a-z0-9]+|[\u3400-\u9fff]+/g)) {
    const word = match[0]
    if (/^[a-z0-9]/.test(word)) result.push(word)
    else {
      for (let i = 0; i < word.length; i++) {
        result.push(word[i])
        if (i + 1 < word.length) result.push(word.slice(i, i + 2))
      }
    }
  }
  return result
}

interface Entry {
  tool: UnrealAgentTool<never>
  /** 加载粒度。算一次存下来 —— 打分、去重、分页每一步都要用 */
  group: string
  bytes: number
  frequencies: Map<string, number>
  length: number
}

/**
 * `ue.content` 拆成三组。2026-09-21 加。
 *
 * 整组 41,099 字节是全表第二大，而实测「一次检索摊给几个工具」只有 **1.6**
 * （`docs/常驻工具集选定-2026-09-17.md` §5.3）—— 每个真正用上的工具要摊 25.7 KB，
 * 是全表最差的一组。这一摊本来就不是一件活：导入外部文件、清理工程、查依赖体积，
 * 三件事之间没有共用的上下文，凑在一起纯粹因为它们都由内容浏览器实现。
 *
 * 切在 `toolSearchGroup` 而不是改 `namespace`：命名空间是**用户可见**的分类
 * （`src/shared/toolCategories.ts` 按它折叠设置页，还有对应的 i18n 文案），
 * 而这里要改的只是加载粒度。改 `namespace` 会让设置页凭空多两个分组头。
 *
 * 新加的 `ue.content` 工具落回 `ue.content` 本身，由 `toolSearchCatalog.test.ts`
 * 的一条门禁把它拦下来，逼着加进这张表 —— 无声落进一个没有技能引用的组，
 * 表现是「模型永远搜不到它」，那种缺陷不该靠人眼发现。
 */
const UE_CONTENT_SUBGROUPS: Record<string, string> = {
  /*
   * 导入单独一组，哪怕它只有一个成员 —— 单成员组按 §5.3 是最差的形状（摊薄 1.0）。
   * 这里认的是另一笔账：`ue_content_import` 被 6 个技能引用（图片生成、素材库、
   * 三维资产生产…），那些技能要的只是「把文件放进工程」。跟整理并成一组的话，
   * 用户让它生成一张图，`ue_content_delete` 和 `ue_fixup_redirectors` 会跟着进来。
   */
  ue_content_import: 'ue.content.import',
  // 搬迁那一摊：改名、移动、迁出、回滚、删除，外加两个配套的（搬完查断链、
  // 搬之前查命名）。它们在同一次任务里连着用，分开就是白多一次往返
  ue_content_move: 'ue.content.organize',
  ue_content_migrate: 'ue.content.organize',
  ue_content_rollback: 'ue.content.organize',
  ue_content_delete: 'ue.content.organize',
  ue_fixup_redirectors: 'ue.content.organize',
  ue_project_path_refs: 'ue.content.organize',
  ue_content_naming_audit: 'ue.content.organize',
  // 只读的查看一摊：找资产、看资产、查依赖和体积、读报错
  ue_content_search: 'ue.content.audit',
  ue_content_describe: 'ue.content.audit',
  ue_content_dependencies: 'ue.content.audit',
  ue_content_audit_optimization: 'ue.content.audit',
  ue_project_asset_ranking: 'ue.content.audit',
  ue_asset_size_map: 'ue.content.audit',
  ue_message_log: 'ue.content.audit'
}

/** 分组只看名字和命名空间，不必造一个完整工具 */
export interface GroupedTool {
  name: string
  unrealBox: { namespace: string }
}

/**
 * 按**组**翻页：`ranked` 是排好序的工具，取第 `offset` 个组开始的 `limit` 个组，
 * 每组回最多 `PREVIEW_PER_GROUP` 个成员当预览。
 *
 * 组的先后按它第一次出现的名次 —— `ranked` 已经排好，所以这就是组内最高分的名次。
 * 一并返回组总数：调用方要拿它算 `nextOffset`，而这里已经分好组了，
 * 让外面再 `new Set(...)` 数一遍是白跑一趟。
 */
function pickGroups(
  ranked: Entry[],
  offset: number,
  limit: number
): { selected: Entry[]; groupCount: number } {
  const order: string[] = []
  const members = new Map<string, Entry[]>()
  for (const entry of ranked) {
    const bucket = members.get(entry.group)
    if (bucket) bucket.push(entry)
    else {
      members.set(entry.group, [entry])
      order.push(entry.group)
    }
  }
  return {
    selected: order
      .slice(offset, offset + limit)
      .flatMap((group) => members.get(group)!.slice(0, PREVIEW_PER_GROUP)),
    groupCount: order.length
  }
}

/**
 * 截图和聚焦跟随场景操作，不单独制造一次发现往返。其余按领域/服务器聚合。
 *
 * `Object.hasOwn` 不是洁癖：工具名只受 `registry.ts` 的 `VALID_TOOL_NAME`
 * （`^[a-zA-Z0-9_-]{1,64}$`）约束，`toString` / `constructor` / `valueOf` 全是合法名字。
 * 直接下标会拿到 `Object.prototype` 上的**函数**，而它不是 nullish，`??` 兜不住 ——
 * 那个函数会一路流进 `entry.group`、Map 的键、`loadedGroups` 的 JSON，
 * 以及落盘的 `details.toolSearch` 恢复路径。
 */
export function toolSearchGroup(tool: GroupedTool): string {
  if (tool.name === 'ue_screenshot' || tool.name === 'ue_focus_viewport') return 'ue.actor'
  // 实验性、说明又长（约 5 KB），不跟 ue.editor 整组常驻，要用时 search_tools 按名加载
  if (tool.name === 'ue_autoplay') return 'ue.editor.autoplay'
  if (tool.unrealBox.namespace === 'ue.content' && Object.hasOwn(UE_CONTENT_SUBGROUPS, tool.name))
    return UE_CONTENT_SUBGROUPS[tool.name]
  return tool.unrealBox.namespace
}

interface LoadDetails {
  /** 实际加载顺序的快照；用来跨用户轮次/重启恢复，仍须重新过权限和预算。 */
  loadedToolNames: string[]
  loadedGroups: string[]
}

interface LoadResult {
  addedToolNames: string[]
  details: LoadDetails
  loaded: Entry[]
  hint: string
}

/**
 * 一组在结果里预览几个成员。
 *
 * 整组都加载了，但把二十条说明原样倒回去是白烧上下文；而只回一条又看不出
 * 这组到底拿到了什么。回分数最高的几条 + `addedToolNames` 的完整名单。
 */
const PREVIEW_PER_GROUP = 5

/**
 * 组分数低于头名这个比例就不带上。
 *
 * 为什么要有这道线：`limit` 是上限不是配额，没有它就**每次都凑满**，
 * 而每多加载一组就多作废一次 prompt cache（约 1.25×P₀，见 `RESIDENT_TOOL_GROUPS`
 * 的算式）。凑一个不相关的组进来，代价比少搜一次大得多。
 *
 * 0.35 是拍的，还没有用评测集校准过 —— 现在也没有评测集可用。等那 223 条
 * (query, 组集合) 的标注落地之后，这个数应该按组级 recall 调，别凭手感改。
 */
const GROUP_SCORE_FLOOR = 0.35

/** `query` 一页最多加载几个**工具组**。每多一组就多作废一次 prompt cache，所以小 */
const GROUP_PAGE = 3

/**
 * 浏览目录一页几个**条目**。
 *
 * 和 `GROUP_PAGE` 分开是因为两者数的东西不一样：那个数「加载几组」，有真金白银的
 * 缓存代价；这个只是列一张表，一条都不加载。拆组之后目录条目还变多了，而浏览目录
 * 正是排序失灵时的逃生口 —— 跟着 `GROUP_PAGE` 一起收窄，等于把逃生口也焊小了。
 */
const DIRECTORY_PAGE = 5

const searchInput = z.object({
  query: z.string().trim().max(500).optional().describe('任务或能力，用中英文均可；精确工具名也可'),
  names: z
    .array(z.string().trim().min(1))
    .max(16)
    .optional()
    .describe('按已知工具名精确定位。全部命中并加载所属工具组，不受 limit 限制'),
  namespace: z
    .string()
    .trim()
    .optional()
    .describe('限定目录，也接受父目录名。空参数查询可浏览目录；目录下按工具分页'),
  offset: z.number().int().min(0).max(100000).default(0).describe('下一页从返回的 nextOffset 继续'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe('query 检索一页最多加载几个工具组（默认 3）；浏览目录时是几个条目（默认 5）')
})

export const TOOL_SEARCH_RULES = `
<tool_search_beta>
Common tools and host interaction tools are already loaded. For a task matching a skill, call load_skill first: it loads both the instructions and the authorized tool groups referenced there. read_skill_resource also loads groups referenced in that resource. Use those tools directly on the next response; no separate search is needed for successfully loaded groups.
search_tools is the fallback when no skill matches or a needed group is still absent. Use an already loaded tool directly when it fits; search before deciding a capability is unavailable or writing a shell/Python workaround.
Search with a short task description; use names for exact tool names from skills/history. An empty call lists capability directories; namespace and offset browse all entries without relying on ranking. Try another query or browse a directory if the first search misses.
Tool names appearing in system instructions, skills or earlier messages describe workflows, not initial availability: your current list is the only authority on what you can call right now. Most domain tools (blueprint, material, widget, sequencer, PCG, content organizing, level editing and the writing side of scene editing) start inside groups and are absent until loaded. Load the matching skill or search by name. Never call a tool absent from the current list, including in the same batch as its loader.
Loading adds original complete tool groups for the NEXT response. Definitions remain loaded across this conversation, restored from its surviving history, subject to current permissions and engine connectivity.
Loaded groups are never evicted, and there is no cap on how many you may load: a cross-domain task should simply load every group it needs. All normal permissions, validation and execution rules still apply.
</tool_search_beta>`

export function createToolSearch(
  catalog: UnrealAgentTool<never>[],
  available: () => UnrealAgentTool<never>[],
  /**
   * 用户在设置页里把哪些工具改成了常驻 / 搜索加载。只存差量，见
   * `appSettingsManager` 的 `agentResidentTools`：没写的按内置清单走，
   * 所以以后调整内置常驻清单，没点过开关的用户会自动跟上。
   */
  residentOverrides: Record<string, boolean> = {}
): {
  tool: UnrealAgentTool<never>
  getTools: () => UnrealAgentTool<never>[]
  loadFromSkill: (content: string) => ToolOutcome<LoadDetails>
  restore: (messages: AgentMessage[]) => void
} {
  const entries = catalog.map((tool): Entry => {
    const group = toolSearchGroup(tool)
    const text = [
      ...Array<string>(4).fill(tool.name),
      tool.unrealBox.namespace,
      group,
      groupDomainTerms(group),
      tool.description,
      JSON.stringify(tool.parameters)
    ].join(' ')
    const tokens = terms(text)
    const frequencies = new Map<string, number>()
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    return { tool, group, bytes: toolDefinitionBytes(tool), frequencies, length: tokens.length }
  })
  const byName = new Map(entries.map((entry) => [entry.tool.name, entry]))
  const active = new Map<string, Entry>()

  /**
   * 这个工具此刻在不在常驻区。常驻的不进搜索加载区，也不占检索名额。
   *
   * 用 `entry.group` 而不是转手 `isDefaultResidentTool(entry.tool)` —— 后者会再算一遍
   * `toolSearchGroup`，而 `Entry.group` 正是为了「算一次存下来」才存的。`getTools()`
   * 每轮对每个工具调一次这里，`load()` 每组调两遍，白算之外还让同一个事实有了两条
   * 来路。`isDefaultResidentTool` 留给设置页 —— 那条路径手上只有工具，没有 Entry。
   */
  const isResident = (entry: Entry): boolean =>
    ALWAYS_RESIDENT_TOOL_NAMES.has(entry.tool.name)
      ? true
      : (residentOverrides[entry.tool.name] ??
        (CORE_NAMES.has(entry.tool.name) || RESIDENT_TOOL_GROUPS.has(entry.group)))

  const allowedEntries = (): Entry[] =>
    available().flatMap((tool) => {
      const entry = byName.get(tool.name)
      return entry ? [entry] : []
    })

  const load = (selected: Entry[], allowed: Entry[]): LoadResult => {
    const groups = [...new Set(selected.filter((entry) => !isResident(entry)).map((e) => e.group))]
    const added: Entry[] = []
    for (const group of groups) {
      const additions = allowed
        .filter(
          (entry) => !isResident(entry) && !active.has(entry.tool.name) && entry.group === group
        )
        .sort((a, b) => a.tool.name.localeCompare(b.tool.name))
      for (const entry of additions) active.set(entry.tool.name, entry)
      added.push(...additions)
    }
    const details: LoadDetails = {
      loadedToolNames: [...active.keys()],
      loadedGroups: [...new Set([...active.values()].map((entry) => entry.group))]
    }
    const loaded = selected.filter((entry) => isResident(entry) || active.has(entry.tool.name))
    return {
      addedToolNames: added.map((entry) => entry.tool.name),
      details,
      loaded,
      hint: '完整工具组已就绪，下一次模型响应直接调用，无需再次搜索。'
    }
  }

  const tool = defineTool({
    name: TOOL_SEARCH_NAME,
    namespace: 'core',
    risk: 'safe',
    concurrency: 'sequential',
    description:
      '技能未覆盖时发现并加载工具组。优先 load_skill，它会同时加载正文涉及的领域工具组。UE、盒子素材库、生成工具和第三方 MCP 都可检索。' +
      'query 一次可加载多个相关工具组的完整定义（默认最多 3 组），跨领域任务写一句完整的任务描述即可，不必一组搜一次；' +
      'names 精确定位，列几个就全加载；空参数浏览目录；namespace + offset 可逐页发现全部工具。' +
      '首次没找到不等于没有能力，可改词、浏览目录再找。返回后下一轮才能调用新工具，执行权限不变。',
    input: searchInput,
    execute: async ({ query, names, namespace, offset, limit }) => {
      const allowed = allowedEntries()
      if (!query && !names?.length && !namespace) {
        const counts = new Map<string, number>()
        for (const entry of allowed) counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1)
        const directories = [...counts].sort(([a], [b]) => a.localeCompare(b))
        // 目录页不跟着 query 的 3 走：那个 3 数的是「一次加载几个组」，
        // 而这里数的是「一次看几个条目」。浏览目录是排序失灵时的逃生口，
        // 拆组之后条目还变多了 —— 逃生口不该跟着变窄
        const page = limit ?? DIRECTORY_PAGE
        return {
          text: JSON.stringify({
            directories: directories.slice(offset, offset + page).map(([id, count]) => ({
              namespace: id,
              count,
              capabilities: groupDomainTerms(id) || id
            })),
            nextOffset: offset + page < directories.length ? offset + page : null,
            hint: '用 query 搜索，或指定 namespace 浏览并加载其中的工具。'
          })
        }
      }

      /*
       * 目录名就是组名，父目录（`ue.content`）也认 —— 模型手里可能是拆组之前的
       * 那份记忆，或者它本来就只想说「内容浏览器那一摊」。
       *
       * 认的是**真实存在的命名空间**，不是任意字符串前缀。`startsWith` 会让
       * `namespace: 'ue'` 一口咬住全部 UE 工具：那条路径没有打分，按名字排完
       * `slice(0, limit)` 取到的是字母序最靠前的几个，于是**整组整组地**加载
       * 模型压根没要的东西 —— 一次三份前缀重写，正是这套改动要省的那笔钱。
       * 拆组之前 `'ue'` 精确匹配不到任何命名空间，返回的是一句无害的未命中。
       */
      let candidates = allowed.filter(
        (entry) =>
          !namespace || entry.group === namespace || entry.tool.unrealBox.namespace === namespace
      )
      const missing: string[] = []
      /** 命中但已经常驻的工具。只用来回话，不占名额 —— 见下面那段 */
      const residentHits: { entry: Entry; score: number }[] = []
      /** query 路径按**组**分页；names 和浏览目录按工具，理由见 `selected` 那段 */
      let groupPaged = false
      if (names?.length) {
        const selected = new Map(candidates.map((entry) => [entry.tool.name, entry]))
        candidates = [...new Set(names)].flatMap((name) => {
          const entry = selected.get(name)
          if (!entry) missing.push(name)
          return entry ? [entry] : []
        })
      } else if (query) {
        const queryTerms = [...new Set(terms(query))]
        const averageLength =
          candidates.reduce((sum, entry) => sum + entry.length, 0) / (candidates.length || 1)
        const frequency = new Map(
          queryTerms.map((term) => [
            term,
            candidates.filter((entry) => entry.frequencies.has(term)).length
          ])
        )
        const scored = candidates
          .map((entry) => {
            let score = entry.tool.name.toLowerCase() === query.toLowerCase() ? 10000 : 0
            for (const term of queryTerms) {
              const tf = entry.frequencies.get(term) ?? 0
              const idf = Math.log(
                1 +
                  (candidates.length - (frequency.get(term) ?? 0) + 0.5) /
                    ((frequency.get(term) ?? 0) + 0.5)
              )
              const weight = /^[\u3400-\u9fff]$/.test(term) ? 0.25 : 1
              score +=
                (weight * idf * (tf * 2.2)) /
                (tf + 1.2 * (0.25 + (0.75 * entry.length) / (averageLength || 1)))
            }
            return { entry, score }
          })
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score || a.entry.tool.name.localeCompare(b.entry.tool.name))
        /*
         * **\u5e38\u9a7b\u5de5\u5177\u4e0d\u5360\u540d\u989d\uff0c\u4e5f\u4e0d\u5f53\u5206\u6bcd\u3002**
         *
         * \u5b83\u4eec\u672c\u6765\u5c31\u5728\u6e05\u5355\u91cc\uff0c\u641c\u51fa\u6765\u4e00\u4e2a\u65b0\u5de5\u5177\u90fd\u5e26\u4e0d\u6765\u3002\u6df7\u5728\u4e00\u8d77\u6392\u7684\u8bdd\u6709\u4e24\u79cd\u8f93
         * \u6cd5\uff0c\u800c\u4e14\u8fd9\u5957\u6539\u52a8\u628a\u4e24\u79cd\u90fd\u653e\u5927\u4e86\uff088 \u4e2a\u7ec4\u6539\u6210\u6574\u7ec4\u5e38\u9a7b\uff0c\u540d\u989d\u4ece 5 \u4e2a\u5de5\u5177\u6536
         * \u5230 3 \u4e2a\u7ec4\uff09\uff1a\u4e00\u662f\u5e38\u9a7b\u7ec4\u5403\u6389\u4e00\u4e2a\u540d\u989d\uff0c\u4e8c\u662f\u5e38\u9a7b\u7ec4\u5f53\u4e86\u5934\u540d\uff0c\u628a\u771f\u6b63\u8981\u7684\u90a3
         * \u4e2a\u6298\u53e0\u7ec4\u538b\u5230 `GROUP_SCORE_FLOOR` \u4e4b\u4e0b\u76f4\u63a5\u7b5b\u6ca1\u3002\u6a21\u578b\u6536\u5230\u7684\u662f\u4e00\u4efd
         * `addedToolNames` \u4e3a\u7a7a\u7684\u7ed3\u679c \u2014\u2014 \u90a3\u770b\u8d77\u6765\u50cf\u300c\u6ca1\u641c\u7740\u300d\uff0c\u4e8e\u662f\u5b83\u518d\u641c\u4e00\u6b21\uff0c
         * \u6b63\u597d\u662f\u8fd9\u5957\u6539\u52a8\u8981\u6d88\u706d\u7684\u8fde\u53d1\u3002
         *
         * \u547d\u4e2d\u7684\u5e38\u9a7b\u5de5\u5177\u4ecd\u7136\u56de\u5728 `loaded` \u91cc\uff08\u9644\u5728\u6298\u53e0\u7ec4\u540e\u9762\uff09\uff0c\u56e0\u4e3a\u300c\u4f60\u5df2\u7ecf\u6709
         * \u8fd9\u4e2a\u4e86\u300d\u662f\u6a21\u578b\u9700\u8981\u77e5\u9053\u7684\u4e8b\uff1b\u53ea\u662f\u5b83\u4e0d\u53c2\u4e0e\u5206\u7ec4\u3001\u4e0d\u5360\u540d\u989d\u3001\u4e0d\u8bbe\u5730\u677f\u3002
         */
        const foldable: { entry: Entry; score: number }[] = []
        for (const hit of scored) (isResident(hit.entry) ? residentHits : foldable).push(hit)
        const best = new Map<string, number>()
        for (const { entry, score } of foldable)
          if (!best.has(entry.group)) best.set(entry.group, score)
        const top = Math.max(0, ...best.values())
        candidates = foldable
          .filter(({ entry }) => (best.get(entry.group) ?? 0) >= top * GROUP_SCORE_FLOOR)
          .map(({ entry }) => entry)
        groupPaged = true
      } else candidates.sort((a, b) => a.tool.name.localeCompare(b.tool.name))

      /*
       * \u5206\u9875\u7684\u5355\u4f4d\u5206\u4e09\u79cd\uff0c\u56e0\u4e3a\u8fd9\u4e09\u4ef6\u4e8b\u95ee\u7684\u4e0d\u662f\u540c\u4e00\u4e2a\u95ee\u9898\u3002
       *
       * **query \u6309\u7ec4**\uff1a\u52a0\u8f7d\u672c\u6765\u5c31\u662f\u6574\u7ec4\u7684\uff0c\u540c\u7ec4\u7684\u7b2c\u4e8c\u4e2a\u5019\u9009\u4e00\u4e2a\u65b0\u5de5\u5177\u90fd\u5e26\u4e0d\u6765\u3002
       * \u6309\u5de5\u5177\u5207\u7684\u65f6\u5019 `limit` \u7684\u771f\u5b9e\u542b\u4e49\u662f\u300c\u6211\u613f\u610f\u6d6a\u8d39\u51e0\u4e2a\u540d\u989d\u300d\u2014\u2014 \u4e00\u4e2a\u4e2d\u6587\u67e5\u8be2
       * \u649e\u4e0a\u9886\u57df\u8bcd\u8868\uff0c\u6574\u7ec4\u540c\u5206\u5e76\u5217\uff0c5 \u4e2a\u540d\u989d\u88ab\u4e00\u4e2a\u7ec4\u5403\u5149\uff0c\u7b2c\u4e8c\u4e2a\u7ec4\u8fd8\u8981\u518d\u641c\u4e00\u6b21\u3002
       * \u800c\u771f\u5b9e\u8f6e\u6b21\u91cc **44% \u9700\u8981 \u22652 \u4e2a\u7ec4\u300113% \u9700\u8981 \u22654 \u4e2a**\uff0ctrace \u91cc\u5df2\u7ecf\u80fd\u770b\u5230
       * \u4e00\u6b21\u4efb\u52a1\u8fde\u53d1 5~9 \u6b21\u641c\u7d22\u3001\u4e00\u6b21\u6361\u4e00\u4e2a\u7ec4\u3002\u5176\u4f59\u4e24\u79cd\u89c1\u4e0b\u9762\u5404\u81ea\u90a3\u884c\u3002
       */
      const page = limit ?? GROUP_PAGE
      const paged = groupPaged
        ? pickGroups(candidates, offset, page)
        : // names 全要，不分页：精确点名不是检索结果，截断只会无声丢掉后面几个
          // （旧默认 `limit` 是 5，报 8 个名字就哑掉 3 个，返回里还什么都不说）
          names?.length
          ? { selected: candidates, groupCount: 0 }
          : // 浏览目录按工具：一个目录本来就是一个组，按组分页等于永远只有一页
            { selected: candidates.slice(offset, offset + page), groupCount: candidates.length }
      // 命中的常驻工具垫在后面：告诉模型「这些你已经有了」，但它们不进 `load`
      // 的分组（`load` 自己会把常驻的滤掉），所以既不占名额也不作废缓存
      const selected = [...paged.selected, ...residentHits.map(({ entry }) => entry)]
      const outcome = load(selected, allowed)
      const nextOffset = offset + page < paged.groupCount ? offset + page : null
      return {
        addedToolNames: outcome.addedToolNames,
        details: { toolSearch: outcome.details },
        text: JSON.stringify({
          loaded: outcome.loaded.map((entry) => ({
            name: entry.tool.name,
            description: entry.tool.description.slice(0, 180)
          })),
          missing,
          addedToolNames: outcome.addedToolNames,
          loadedGroups: outcome.details.loadedGroups,
          nextOffset,
          hint: paged.selected.length
            ? outcome.hint
            : residentHits.length
              ? // 这句不能说成「未命中」：命中的工具此刻就在清单里，再搜一次
                // 还是这个结果。09-11 那轮的连发搜索就是这么来的
                '命中的工具已经在你的清单里，直接调用即可。要别的能力就换关键词或浏览目录。'
              : '未命中。换关键词、用精确 names，或空参数浏览目录后按 namespace 查找。'
        })
      }
    }
  }) as unknown as UnrealAgentTool<never>

  return {
    tool,
    getTools: () => {
      const allowed = allowedEntries()
      const names = new Set(allowed.map((entry) => entry.tool.name))
      return [
        tool,
        ...allowed.filter((entry) => isResident(entry)).map((entry) => entry.tool),
        ...[...active.values()]
          .filter((entry) => names.has(entry.tool.name))
          .map((entry) => entry.tool)
      ]
    },
    loadFromSkill: (content) => {
      const mentioned = new Set(content.match(/[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [])
      const allowed = allowedEntries()
      // 精确匹配正文中的已授权工具名；用户/插件技能同样适用，未知名字不触发猜测。
      const selected = [...mentioned].flatMap((name) =>
        allowed.filter((entry) => entry.tool.name === name)
      )
      const outcome = load(selected, allowed)
      return {
        addedToolNames: outcome.addedToolNames,
        details: outcome.details,
        text: JSON.stringify({
          toolGroups: outcome.details.loadedGroups,
          addedToolNames: outcome.addedToolNames,
          hint: selected.length
            ? outcome.hint
            : '正文未引用当前可加载的工具名；若任务仍需要其他能力，可用 search_tools 查找。'
        })
      }
    },
    restore: (messages) => {
      // 只回放真实工具结果；删消息/分支自然只恢复保留下来的加载点，不另存可漂移的全局状态。
      const attempted = new Set<string>()
      for (const message of messages) {
        if (message.role !== 'toolResult' || message.isError) continue
        const state = message.details as { toolSearch?: Partial<LoadDetails> } | undefined
        const names = state?.toolSearch?.loadedToolNames ?? message.addedToolNames ?? []
        if (!Array.isArray(names)) continue
        for (const name of names) {
          const entry = byName.get(name)
          if (!entry || isResident(entry) || active.has(name)) continue
          if (attempted.has(entry.group)) continue
          attempted.add(entry.group)
          // 注册表升级/权限变化后重新计算整组预算，不能恢复半组。
          load([entry], entries)
        }
      }
    }
  }
}
