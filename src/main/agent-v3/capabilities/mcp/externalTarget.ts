/**
 * 外部调用的目标工程解析。
 *
 * ## 在修的是什么
 *
 * 在这个文件之前，对外 MCP 服务**根本没有绑定工程**：`McpServerHost` 的调用
 * handler 直接 `tool.execute()`，外面没有任何 `runWithTargetConnectionId`。
 * 于是每一次外部调用都掉进 `WebSocketService.pickDefaultConnectionId()` 的
 * 「恰好一个连接才回退」——
 *
 *   - 只开一个工程：碰巧能用；
 *   - **同时开两个工程：一条引擎命令都发不出去**，而界面上两个都显示已连接。
 *
 * 它拒绝猜测（这是对的，静默发错工程比报错糟糕得多），但外部客户端此前
 * 连「说清楚我要哪个」的办法都没有。这里补上那个办法。
 *
 * ## 为什么是工程路径而不是 connectionId
 *
 * `connectionId` 是**一次连接**的 id，编辑器重启一次就换一个（见
 * `core/projectTargetContext.ts` 的文件头）。让外部脚本把它写死在命令行里，
 * 等于让那个脚本在用户重启一次编辑器之后就失效。
 *
 * 工程根目录跨重启稳定，所以协议里传的是它。connectionId 由这一侧当场查出来。
 *
 * ## 三条边界
 *
 * - 没传目标就**不绑定**：工具清单、诊断这类操作与工程无关，强绑只会让它们
 *   在没连引擎时也失败。旧的第三方客户端（Claude Code / Cursor）不传这个字段，
 *   行为与改动之前完全一致。
 * - 传了但那个工程没连着 → `PROJECT_NOT_CONNECTED`。**绝不因为旁边有另一个
 *   工程在线就改发给它**。
 * - 同一路径匹配到多条交互式连接 → `PROJECT_AMBIGUOUS`，不取最近那条。
 */

import { platform } from 'node:process'

import { projectManager } from '../../../services/project/projectManager'
import type { TargetProjectRef } from '../../core/projectTargetContext'

/**
 * CLI 契约版本。
 *
 * 外部客户端按它判断这个盒子认不认「显式指定工程」这套约定；不认的旧盒子
 * 会缺失整个 `capabilities.experimental.unrealBox`，客户端据此报
 * `INCOMPATIBLE_SERVER`，而不是径直把 `--project` 发出去然后被忽略。
 */
export const CLI_CONTRACT_VERSION = 1

/**
 * 初始化响应里声明的能力。
 *
 * 放在 `experimental` 下而不是自造顶层字段：`ServerCapabilitiesSchema` 只给
 * `experimental` 留了任意键，写在别处会被 SDK 的 schema 直接丢掉。
 */
export const UNREAL_BOX_CAPABILITY = {
  cliContractVersion: CLI_CONTRACT_VERSION,
  projectTargeting: true,
  publicResults: true
} as const

/** 错误码与 的退出码表一一对应 */
export type ExternalTargetErrorCode =
  | 'INVALID_ARGUMENT'
  | 'PROJECT_NOT_CONNECTED'
  | 'PROJECT_AMBIGUOUS'

/**
 * 目标解析失败。
 *
 * `code` 会随 `tools/call` 的结果发到 `_meta.unrealBox.errorCode` ——
 * 文本给人看，码给 CLI 看。让 CLI 去猜中文字符串是那种今天能跑、
 * 改一个字就静默失效的做法。
 */
export class ExternalTargetError extends Error {
  constructor(
    readonly code: ExternalTargetErrorCode,
    message: string,
    readonly hint?: string
  ) {
    super(message)
    this.name = 'ExternalTargetError'
  }
}

/**
 * 路径归一：斜杠方向、结尾斜杠、以及**按平台决定的**大小写。
 *
 * Windows 的文件系统不区分大小写，一律转小写是对的；Linux/macOS 上
 * `/home/a/Demo` 和 `/home/a/demo` 是两个不同的目录，无条件转小写会让
 * 两个真实存在的工程被认成同一个 —— 那正是「静默发错工程」。
 *
 * `core/projectTargetContext.ts` 里那个归一函数一律转小写。不去改它：
 * 它服务的是「同一条执行流里认回自己那个工程」，比这里宽松只会多认回自己，
 * 不会认到别人头上；而且它有自己的测试。这里是外部输入的入口，从严。
 */
export function normalizeProjectPath(value: string): string {
  let unified = value.trim().replace(/\\/g, '/')

  // 容忍传进来的是 `.uproject` 文件。协议里说好了传工程根目录（§5），
  // 但第三方客户端很容易把用户手上那个文件路径原样发过来，
  // 而在这里砍掉文件名不可能砍错 —— 报一个「找不到工程」让人自己去查
  // 差在哪，没有任何价值。
  if (/\.uproject$/i.test(unified)) {
    /*
     * `cut > 0` 这道守卫不能省。
     *
     * 裸文件名（第三方客户端直接把 `MyGame.uproject` 发过来）没有分隔符，
     * `lastIndexOf` 回 -1，`slice(0, -1)` 把它啃成 `MyGame.uprojec` ——
     * 一个非空的垃圾键，过得了下面「空就拒绝」那道闸，然后和谁都比不上：
     * 一个明明连着的工程回 `PROJECT_NOT_CONNECTED`。
     * 同 `core/projectPathKey.ts`，那边有这一条的用例。
     */
    const cut = unified.lastIndexOf('/')
    if (cut > 0) unified = unified.slice(0, cut)
  }

  unified = unified.replace(/\/+$/, '')
  return platform === 'win32' ? unified.toLowerCase() : unified
}

/** `_meta.unrealBox` 的形状。多余的键忽略，不做未知字段拒绝 */
interface UnrealBoxMeta {
  cliContractVersion?: unknown
  projectPath?: unknown
}

/**
 * 从 `tools/call` 的请求元数据里解出这次的目标工程。
 *
 * @returns 绑定用的目标；`undefined` 表示这次调用不指定工程（与旧行为一致）
 * @throws {ExternalTargetError} 指定了但定不下来
 */
export function resolveExternalTarget(raw: unknown): TargetProjectRef | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ExternalTargetError('INVALID_ARGUMENT', '_meta.unrealBox 必须是一个对象。')
  }

  const meta = raw as UnrealBoxMeta

  // 版本只在给了的时候校验：没给等于「没打算用这套约定」，按不绑定处理。
  if (meta.cliContractVersion !== undefined && meta.cliContractVersion !== CLI_CONTRACT_VERSION) {
    throw new ExternalTargetError(
      'INVALID_ARGUMENT',
      `不支持的 cliContractVersion：${String(meta.cliContractVersion)}（本服务是 ${CLI_CONTRACT_VERSION}）。`,
      '升级虚幻盒子或改用与它同版本的 CLI。'
    )
  }

  if (meta.projectPath === undefined || meta.projectPath === null) return undefined
  if (typeof meta.projectPath !== 'string' || meta.projectPath.trim() === '') {
    throw new ExternalTargetError(
      'INVALID_ARGUMENT',
      '_meta.unrealBox.projectPath 必须是非空字符串。'
    )
  }

  return resolveByProjectPath(meta.projectPath)
}

/**
 * 按工程根目录找当前在线的那条连接。
 *
 * 只认**完全相等**的归一化路径，不做前缀匹配 —— `D:/Games/Demo` 不能匹配上
 * `D:/Games/Demo2`，更不能匹配上 `D:/Games`。
 */
function resolveByProjectPath(projectPath: string): TargetProjectRef {
  const wanted = normalizeProjectPath(projectPath)
  if (!wanted) {
    throw new ExternalTargetError('INVALID_ARGUMENT', `无法从 "${projectPath}" 解析出工程根目录。`)
  }

  let candidates: { connectionId: string; projectPath: string }[]
  try {
    candidates = projectManager
      .getInteractiveProjects()
      .filter((project) => normalizeProjectPath(project.projectPath) === wanted)
      .map((project) => ({ connectionId: project.connectionId, projectPath: project.projectPath }))
  } catch (error) {
    // 工程服务没起来时说不清楚，就说说不清楚，别把它报成「工程没连」——
    // 那会把用户支去检查一个其实是好的编辑器
    throw new ExternalTargetError(
      'PROJECT_NOT_CONNECTED',
      `查询已连接工程失败：${(error as Error).message}`
    )
  }

  if (candidates.length === 0) {
    throw new ExternalTargetError(
      'PROJECT_NOT_CONNECTED',
      `工程 ${projectPath} 当前没有连接到虚幻盒子。`,
      '打开该工程的虚幻编辑器并确认 UnrealAgentLink 插件已启用；其他工程在线不影响这一条。'
    )
  }

  if (candidates.length > 1) {
    throw new ExternalTargetError(
      'PROJECT_AMBIGUOUS',
      `工程 ${projectPath} 匹配到 ${candidates.length} 条交互式连接，无法确定目标。`,
      '关掉重复打开的编辑器实例后重试。这一条不猜，取错了会改到另一个编辑器里的内容。'
    )
  }

  // 路径给 `getTargetConnectionId()` 的自愈用：编辑器中途重启时，
  // 它靠这个路径认回新连接（见 core/projectTargetContext.ts）
  return { connectionId: candidates[0].connectionId, projectPath: candidates[0].projectPath }
}
