/**
 * 插件的清单格式与权限模型。
 *
 * ## 插件是什么
 *
 * 插件是 **skill + MCP server** 的打包分发单元 —— 不是新的扩展机制，
 * 而是把已有的两套机制装进一个可安装、可停用、可卸载的目录：
 *
 * ```
 * <userData>/plugins/<id>/
 *   plugin.json       清单：身份、权限、内容声明
 *   skills/           同内置 skill 格式，装上后进入 skill 发现路径
 *   mcp.json          该插件自带的 MCP server，装上后进入 MCP 连接列表
 * ```
 *
 * ## 沙箱：不允许注入任意 JS
 *
 * 插件**不能**往主进程里塞代码。能力只有两条路：
 *
 *   1. **MCP server 子进程** —— OS 级进程隔离，崩了不影响盒子
 *   2. **skill** —— 纯文本指引，本身没有执行能力
 *
 * 这条约束是刻意的。允许插件 `require` 进主进程等于把整个应用的权限
 * （文件系统、数据库、引擎连接）无条件交给第三方代码，而用户在安装时
 * 根本无从判断风险。
 *
 * ## 权限：**目前只是清单里的一句声明，没有任何效力**
 *
 * 这个字段设计上是要在安装时逐条展示给用户确认、并约束插件带来的 MCP 工具的。
 * 那两件事**都还没做**。今天的实际行为是：只要插件目录在 `<userData>/plugins/`
 * 里且没被停用，下次开会话时它 `mcp.json` 里写的命令就会被拉成子进程 ——
 * 声明了 `shell` 和什么都没声明，行为完全一样。
 *
 * 所以插件**没有渲染层入口**：一个「从文件夹安装」按钮，实质是一键执行
 * 第三方写的命令行而不作任何提示。要把入口放出来，先得补上两样：
 *
 *   1. 安装确认 —— 把 `mcp.json` 里将要执行的命令和这里声明的权限摊开给用户
 *   2. 运行期约束 —— 让声明的权限真的能挡住工具调用
 *
 * 字段本身保留：它是 `plugin.json` 的磁盘格式，先落地格式、后落地执行，
 * 比将来改格式让老插件全部失效要好。
 */

/** 插件声明它需要什么。**当前只被解析和保存，不展示也不约束**（见文件头） */
export type PluginPermission =
  /** 读取虚幻引擎项目状态 */
  | 'ue:read'
  /** 修改虚幻引擎项目（创建/修改/删除资产） */
  | 'ue:write'
  /** 读取资产库 */
  | 'vault:read'
  /** 修改资产库 */
  | 'vault:write'
  /** 访问网络。高危：数据可能被送出本机 */
  | 'net'
  /** 执行 shell 命令。最高危 */
  | 'shell'

export const ALL_PERMISSIONS: readonly PluginPermission[] = Object.freeze([
  'ue:read',
  'ue:write',
  'vault:read',
  'vault:write',
  'net',
  'shell'
])

export interface PluginManifest {
  /** 唯一标识。会成为目录名和 MCP serverId 前缀，所以字符受限 */
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 主页 / 仓库地址，用户判断是否可信的依据之一 */
  homepage?: string
  /** 需要的权限。空数组表示只带 skill、不带任何可执行能力 */
  permissions?: PluginPermission[]
}

/** 装好之后的插件 */
export interface InstalledPlugin {
  manifest: PluginManifest
  /** 插件目录的绝对路径 */
  path: string
  /** 用户停用了它。目录还在，但不参与 skill 发现和 MCP 连接 */
  disabled: boolean
  /** 该插件是否带 skills 目录 */
  hasSkills: boolean
  /** 该插件自带的 MCP server 数 */
  mcpServerCount: number
  /** 清单有问题时的说明。此时插件不会被启用 */
  error?: string
}

/**
 * 插件 id 的字符约束。
 *
 * 它会成为**目录名**（路径穿越风险）和 **MCP serverId 前缀**
 * （厂商要求工具名 `^[a-zA-Z0-9_-]+$`），两头都要求安全字符。
 */
export const VALID_PLUGIN_ID = /^[a-zA-Z0-9_-]{1,48}$/

/** 解析并校验清单。返回 null 表示这不是一个合法插件 */
export function parseManifest(raw: unknown): { manifest: PluginManifest } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'plugin.json 不是一个对象' }
  const source = raw as Record<string, unknown>

  const id = typeof source.id === 'string' ? source.id.trim() : ''
  if (!id) return { error: 'plugin.json 缺少 id' }
  if (!VALID_PLUGIN_ID.test(id)) {
    return { error: `id "${id}" 非法：只允许字母、数字、下划线、连字符，最长 48 位` }
  }

  const name = typeof source.name === 'string' ? source.name.trim() : ''
  if (!name) return { error: 'plugin.json 缺少 name' }

  const version = typeof source.version === 'string' ? source.version.trim() : ''
  if (!version) return { error: 'plugin.json 缺少 version' }

  // 认不出的权限直接丢弃而不是报错整个插件 —— 以后新增权限时，
  // 老版本盒子装新插件应当降级运行（少给权限），而不是装不上
  const declared = Array.isArray(source.permissions) ? source.permissions : []
  const permissions = declared.filter((p): p is PluginPermission =>
    ALL_PERMISSIONS.includes(p as PluginPermission)
  )
  const unknown = declared.filter((p) => !permissions.includes(p as PluginPermission))
  if (unknown.length > 0) {
    console.warn(`[AgentV3][Plugin] "${id}" 声明了本版本不认识的权限，已忽略:`, unknown)
  }

  return {
    manifest: {
      id,
      name,
      version,
      ...(typeof source.description === 'string' ? { description: source.description } : {}),
      ...(typeof source.author === 'string' ? { author: source.author } : {}),
      ...(typeof source.homepage === 'string' ? { homepage: source.homepage } : {}),
      ...(permissions.length > 0 ? { permissions } : {})
    }
  }
}

// 权限的展示文案不在这里 —— 安装确认弹窗还没有，写一份没人用的标签表，
// 下一个读到的人会以为这套权限已经在界面上生效了。等做确认弹窗时随它一起写。
