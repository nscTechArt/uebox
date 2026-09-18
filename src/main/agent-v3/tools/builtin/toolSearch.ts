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
export function isDefaultResidentTool(name: string): boolean {
  return CORE_NAMES.has(name)
}

// 只用于检索，不替代工具原文。新命名空间不需要进这张表也会自动被索引。
const DOMAIN_TERMS: Record<string, string> = {
  'ue.blueprint': '蓝图 逻辑 节点 变量 事件 函数 blueprint graph node logic event function',
  'ue.material': '材质 材质实例 表面 颜色 贴图 纹理 material shader color surface texture',
  'ue.actor': '物体 场景 对象 位置 旋转 缩放 移动 灯光 actor transform spawn light',
  'ue.content': '内容浏览器 工程资产 导入 整理 依赖 重命名 删除 content asset import organize',
  'ue.editor': '编辑器 截图 保存 撤销 运行 测试 editor screenshot save undo playtest',
  'ue.level': '关卡 场景 大纲 世界 分区 流送 level world outliner streaming',
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
  aigc: '生成 图片 视频 三维 generate image video 3d',
  browser: '浏览器 网页 点击 输入 browser webpage click',
  local: '本机 文件 目录 搜索 读写 local file directory search read write',
  web: '联网 搜索 网页 文档 web search read documentation'
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
  bytes: number
  frequencies: Map<string, number>
  length: number
}

/** 截图和聚焦跟随场景操作，不单独制造一次发现往返。其余按领域/服务器聚合。 */
export function toolSearchGroup(tool: UnrealAgentTool<never>): string {
  return tool.name === 'ue_screenshot' || tool.name === 'ue_focus_viewport'
    ? 'ue.actor'
    : tool.unrealBox.namespace
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

const searchInput = z.object({
  query: z.string().trim().max(500).optional().describe('任务或能力，用中英文均可；精确工具名也可'),
  names: z
    .array(z.string().trim().min(1))
    .max(8)
    .optional()
    .describe('按已知工具名精确定位并加载所属工具组'),
  namespace: z
    .string()
    .trim()
    .optional()
    .describe('限定目录。空参数查询可浏览目录；目录下也支持分页'),
  offset: z.number().int().min(0).max(100000).default(0).describe('下一页从返回的 nextOffset 继续'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(5)
    .describe('一页最多几个候选工具，默认 5；候选命中后按整组加载')
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
    const text = [
      ...Array<string>(4).fill(tool.name),
      tool.unrealBox.namespace,
      DOMAIN_TERMS[tool.unrealBox.namespace] ?? '',
      tool.description,
      JSON.stringify(tool.parameters)
    ].join(' ')
    const tokens = terms(text)
    const frequencies = new Map<string, number>()
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    return { tool, bytes: toolDefinitionBytes(tool), frequencies, length: tokens.length }
  })
  const byName = new Map(entries.map((entry) => [entry.tool.name, entry]))
  const active = new Map<string, Entry>()

  /** 这个工具此刻在不在常驻区。常驻的不进搜索加载区，也不必被搜出来 */
  const isResident = (name: string): boolean =>
    ALWAYS_RESIDENT_TOOL_NAMES.has(name) ? true : (residentOverrides[name] ?? CORE_NAMES.has(name))

  const allowedEntries = (): Entry[] =>
    available().flatMap((tool) => {
      const entry = byName.get(tool.name)
      return entry ? [entry] : []
    })

  const load = (selected: Entry[], allowed: Entry[]): LoadResult => {
    const groups = [
      ...new Set(
        selected
          .filter((entry) => !isResident(entry.tool.name))
          .map((entry) => toolSearchGroup(entry.tool))
      )
    ]
    const added: Entry[] = []
    for (const group of groups) {
      const additions = allowed
        .filter(
          (entry) =>
            !isResident(entry.tool.name) &&
            !active.has(entry.tool.name) &&
            toolSearchGroup(entry.tool) === group
        )
        .sort((a, b) => a.tool.name.localeCompare(b.tool.name))
      for (const entry of additions) active.set(entry.tool.name, entry)
      added.push(...additions)
    }
    const details: LoadDetails = {
      loadedToolNames: [...active.keys()],
      loadedGroups: [...new Set([...active.values()].map((entry) => toolSearchGroup(entry.tool)))]
    }
    const loaded = selected.filter(
      (entry) => isResident(entry.tool.name) || active.has(entry.tool.name)
    )
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
      'query 搜索候选并加载所属组的完整定义；names 精确定位后也加载整组；空参数浏览目录；namespace + offset 可逐页发现全部工具。' +
      '首次没找到不等于没有能力，可改词、浏览目录再找。返回后下一轮才能调用新工具，执行权限不变。',
    input: searchInput,
    execute: async ({ query, names, namespace, offset, limit }) => {
      const allowed = allowedEntries()
      if (!query && !names?.length && !namespace) {
        const counts = new Map<string, number>()
        for (const entry of allowed) {
          const key = entry.tool.unrealBox.namespace
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        const directories = [...counts].sort(([a], [b]) => a.localeCompare(b))
        return {
          text: JSON.stringify({
            directories: directories.slice(offset, offset + limit).map(([id, count]) => ({
              namespace: id,
              count,
              capabilities: DOMAIN_TERMS[id] ?? id
            })),
            nextOffset: offset + limit < directories.length ? offset + limit : null,
            hint: '用 query 搜索，或指定 namespace 浏览并加载其中的工具。'
          })
        }
      }

      let candidates = allowed.filter(
        (entry) => !namespace || entry.tool.unrealBox.namespace === namespace
      )
      const missing: string[] = []
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
        candidates = candidates
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
          .map(({ entry }) => entry)
      } else candidates.sort((a, b) => a.tool.name.localeCompare(b.tool.name))

      const selected = candidates.slice(offset, offset + limit)
      const outcome = load(selected, allowed)
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
          nextOffset: offset + limit < candidates.length ? offset + limit : null,
          hint: selected.length
            ? outcome.hint
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
        ...allowed.filter((entry) => isResident(entry.tool.name)).map((entry) => entry.tool),
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
          if (!entry || isResident(name) || active.has(name)) continue
          const group = toolSearchGroup(entry.tool)
          if (attempted.has(group)) continue
          attempted.add(group)
          // 注册表升级/权限变化后重新计算整组预算，不能恢复半组。
          load([entry], entries)
        }
      }
    }
  }
}
