/**
 * 工程信息接口
 * 描述一个已连接的 Unreal Engine 工程项目
 */
export interface ProjectInfo {
  /** WebSocket 连接 ID */
  connectionId: string
  /** 项目名称 */
  projectName: string
  /** 项目版本 */
  projectVersion: string
  /** 引擎版本 */
  engineVersion: string
  /** 项目根目录路径（包含 .uproject 文件的文件夹） */
  projectPath: string
  /** 默认地图路径 */
  defaultMap: string
  /** 启用的插件列表 */
  enabledPlugins: string[]
  /** 连接时间戳 */
  connectedAt: number
  /** 连接状态 */
  isConnected?: boolean
  /**
   * 这个连接背后是不是「用户面前那个编辑器」。
   *
   * 插件在 commandlet / `-unattended` / `-nullrhi` 里也照样连上来（见
   * `plugin/.../UAL_EditorCommands.cpp` 的 runMode）。那种进程是我们自己跑的
   * 批处理，不是用户打开的工程 —— 把它当「当前工程」的话，模型会对着一个
   * 用户早就关掉的工程说「现在连着的是它」。
   *
   * 旧插件不报这个字段，缺省按 true 处理：行为和改动之前一模一样。
   */
  interactive: boolean
  /** 插件报上来的运行模式原文：editor / commandlet / unattended / headless。只用于日志和排查 */
  runMode?: string
}

/**
 * project.info 响应数据
 */
export interface ProjectInfoResponse {
  projectName: string
  projectVersion: string
  engineVersion: string
  projectPath?: string
  defaultMap: string
  /**
   * 启用的插件列表（兼容多种格式）：
   * - 新格式：enabledPluginNames: string[]
   * - 旧/扩展格式：enabledPlugins 可能是 string[] 或 {name: string}[]
   */
  enabledPlugins?: string[] | Array<{ name?: string }>
  enabledPluginNames?: string[]
  /** 有没有可交互的编辑器界面。旧插件不发，缺省按 true */
  interactive?: boolean
  /** 运行模式原文：editor / commandlet / unattended / headless */
  runMode?: string
}
