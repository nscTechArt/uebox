/**
 * 工具的「大类」。设置页按它折叠，主进程和渲染层共用同一张表。
 *
 * ## 为什么不直接把命名空间当大类
 *
 * 命名空间是给**运行时**用的：动态过滤、审批策略、MCP 暴露范围，
 * 所以它按「谁实现的」切分 —— `ue.mesh` 和 `ue.animation` 各走各的通道。
 * 用户不这么想事情：他要么在做动画，不会因为网格走的是另一条 RPC
 * 就把它当成另一件事。
 *
 * 所以这张表把命名空间**合并**成大类，一条命名空间只能进一个大类。
 * 表里没写的命名空间落到 `other`，不会从清单上消失 —— 一个开关页最不能出现的
 * 失效方向，就是「有个工具在跑，但设置页里找不到它」。
 *
 * ## 虚幻的按摊分，盒子自己的合成一类
 *
 * `ue.*` 那几摊各是各的工作（改蓝图、摆场景、写 C++），用户按这个找。
 * 而素材库、本机文件、联网、知识库、工程管理这些是**盒子自己的能力**，
 * 不属于虚幻里的任何一摊 —— 上一版把它们摊成六个大类，结果清单顶上一半是
 * 只有两三条工具的分组头，反而把真正大的那几摊挤下去了。合成一类。
 *
 * 生成（AIGC）是其中唯一分出来的：它不是「把已有的东西找出来、搬过去」，
 * 而是凭空造新素材，也是唯一一摊按次向外部厂商花钱的。
 *
 * ## 第三方 MCP 不在这儿
 *
 * 那些工具归「MCP」设置页管（接哪台服务器、开不开放写操作）。同一批工具
 * 两个页面各有一个开关，用户关了一个发现还在，只会以为开关坏了。
 */

/** 一个大类：id 用来取 i18n 文案，namespaces 是归它管的命名空间 */
export interface ToolCategory {
  id: string
  namespaces: readonly string[]
}

/** 表里没有的命名空间落到这一类。放在最后 */
export const OTHER_TOOL_CATEGORY = 'other'

/**
 * 大类清单。顺序就是设置页里的显示顺序：
 * 先是虚幻里最常动的那几摊，再是生成，最后是盒子自己的那一堆。
 */
export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  // 蓝图和材质各成一类。它们是两件活：一个改逻辑，一个调外观，
  // 用户来这一页找的时候想的是其中一件，合在一起只会让他在 39 条里翻
  { id: 'blueprint', namespaces: ['ue.blueprint'] },
  { id: 'material', namespaces: ['ue.material'] },
  { id: 'scene', namespaces: ['ue.actor', 'ue.level'] },
  { id: 'content', namespaces: ['ue.content'] },
  { id: 'editor', namespaces: ['ue.editor', 'ue.input'] },
  { id: 'ui', namespaces: ['ue.widget'] },
  { id: 'cinematic', namespaces: ['ue.sequencer', 'ue.animation', 'ue.mesh'] },
  { id: 'pcg', namespaces: ['ue.pcg'] },
  { id: 'cpp', namespaces: ['ue.cpp'] },
  { id: 'system', namespaces: ['ue.system'] },
  // 生成单独一类。它和下面那堆不是一回事：别的都是「把已有的东西找出来、
  // 搬过去、读一读」，这一摊是**凭空造新素材**（图、视频、三维、成片），
  // 也是唯一一摊会按次向外部厂商花钱的。混进「盒子自己的工具」里找不着
  { id: 'aigc', namespaces: ['aigc', 'video.production'] },
  // 盒子自己的能力，合成一类：素材库、蓝图/材质库、工程、本机文件与命令行、
  // 联网与浏览器、知识库
  {
    id: 'box',
    namespaces: [
      'asset',
      'library',
      'project',
      'local',
      'local.shell',
      'web',
      'browser',
      'notebook',
      'note'
    ]
  }
]

const CATEGORY_BY_NAMESPACE = new Map<string, string>(
  TOOL_CATEGORIES.flatMap((category) =>
    category.namespaces.map((namespace) => [namespace, category.id] as const)
  )
)

/** 这个命名空间归哪个大类。表里没有就归 `other` */
export function toolCategoryId(namespace: string): string {
  return CATEGORY_BY_NAMESPACE.get(namespace) ?? OTHER_TOOL_CATEGORY
}

/** 设置页要显示的一条工具。`defaultResident` 由主进程算好，见 `toolSearch.ts` */
export interface ToolSummary {
  name: string
  namespace: string
  description: string
  risk: string
  defaultResident: boolean
}

export interface ToolCategoryGroup<T> {
  id: string
  tools: T[]
}

/**
 * 按大类分组。空的大类不返回 —— 装没装 PCG 插件是另一回事，
 * 但一个一条工具都没有的分组头只会让人以为清单坏了。
 */
export function groupToolsByCategory<T extends { namespace: string }>(
  tools: readonly T[]
): ToolCategoryGroup<T>[] {
  const buckets = new Map<string, T[]>()
  for (const tool of tools) {
    const id = toolCategoryId(tool.namespace)
    const bucket = buckets.get(id)
    if (bucket) bucket.push(tool)
    else buckets.set(id, [tool])
  }

  // 按表里的顺序，杂项垫底
  const ordered = [...TOOL_CATEGORIES.map((category) => category.id), OTHER_TOOL_CATEGORY]
  return ordered.flatMap((id) => {
    const tools = buckets.get(id)
    return tools ? [{ id, tools }] : []
  })
}

/**
 * 大类开关此刻该显示成什么样。
 *
 * `some` 是**部分打开**：大类开关画成半开（indeterminate），点它会把整组打开。
 * 没有这一档的话，三个小类开着两个时大类只能二选一地撒谎。
 */
export type CategoryToggleState = 'all' | 'none' | 'some'

export function categoryToggleState<T>(
  tools: readonly T[],
  isOn: (tool: T) => boolean
): CategoryToggleState {
  if (tools.length === 0) return 'none'
  let on = 0
  for (const tool of tools) if (isOn(tool)) on += 1
  if (on === 0) return 'none'
  return on === tools.length ? 'all' : 'some'
}

/**
 * 点大类开关之后，整组该变成开还是关。
 *
 * 部分打开时点一下是**全开**而不是全关：这个开关最常见的用途是「把这一摊全给它」，
 * 而误点全关的代价（模型突然不会做这类事，且用户不知道为什么）比误点全开大得多。
 */
export function nextCategoryValue(state: CategoryToggleState): boolean {
  return state !== 'all'
}
