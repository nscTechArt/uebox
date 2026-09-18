/**
 * MCP 配置的磁盘格式与共享词汇。
 *
 * 配置形状**刻意对齐 Claude Desktop 的 `mcpServers`** —— 用户可以把已有配置
 * 直接粘过来，不用为盒子再学一套。
 */

/** 本地进程形态：盒子把 server 作为子进程拉起来，走 stdio 通信 */
export interface StdioServerConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  /** 工作目录。省略则用应用的 cwd */
  cwd?: string
}

/** 远程形态：走 Streamable HTTP */
export interface HttpServerConfig {
  type: 'http'
  url: string
  /** 附加请求头，通常是鉴权 */
  headers?: Record<string, string>
}

export type McpServerConfig = (StdioServerConfig | HttpServerConfig) & {
  /** 关掉但保留配置。默认启用 */
  disabled?: boolean
  /**
   * 只暴露这些工具。
   *
   * 有的 server 提供几十个工具，全塞进上下文既占 token 又增加误调概率。
   */
  allowedTools?: string[]
  /**
   * 按名字点名、降级为 `safe`（不弹审批）的工具。
   *
   * 默认所有 MCP 工具都是 `destructive`（见 McpClientManager 文件头），这是对的 ——
   * server 自报的 `readOnlyHint` 不可信。但纯发现类工具是个例外：模型**每次动手前**
   * 都得先调它们查一遍能力，全弹审批的话，用户在真正的操作出现之前就已经点了两三次
   * 确认，很快就会养成闭眼点「允许」的习惯 —— **审批门被点烦了就等于没有**。
   *
   * 所以这里是**点名制而不是信任制**：只有明确写进名单的那几个工具降级，
   * 同一个 server 的其余工具照样 `destructive`。名单进 `mcp.json`，可审计。
   *
   * 典型用法见 `epicToolsets.ts`：UE 5.8 官方 server 的 `list_toolsets` /
   * `describe_toolset` 降级，真正干活的 `call_tool` 不降。
   */
  readOnlyTools?: string[]
}

/** `mcp.json` 的完整结构 */
export interface McpSettings {
  version: 1
  /** 键是 serverId，会成为工具名前缀 */
  mcpServers: Record<string, McpServerConfig>
}

export const EMPTY_MCP_SETTINGS: McpSettings = Object.freeze({
  version: 1,
  mcpServers: {}
})

/**
 * 一个 server 的连接状态。
 *
 * 给设置界面看，**也进系统提示词** —— 见 `promptSection.ts`。模型知道
 * 「你配了 filesystem 但它连不上」和「你没配过 filesystem」是两件事，
 * 才不会在用户问起时答一句「我没有这个能力」。
 */
export interface McpServerStatus {
  id: string
  connected: boolean
  /** 连上之后拿到的工具数 */
  toolCount: number
  /** 连接失败的原因。连上时为空 */
  error?: string
  /**
   * 用户在配置里主动停用了它。
   *
   * 和「连不上」是两回事：停用是用户自己的选择，让他去排查连接问题
   * 只会浪费时间，正确的话是「你把它停用了，要用就去设置里打开」。
   */
  disabled?: boolean
  /** server 自报的名字与版本 */
  serverName?: string
  serverVersion?: string
}

export function isHttpConfig(config: McpServerConfig): config is HttpServerConfig & {
  disabled?: boolean
  allowedTools?: string[]
  readOnlyTools?: string[]
} {
  return (config as HttpServerConfig).type === 'http'
}
