/**
 * 把「这次写入用哪条连接」解析成一个**明确的 id**。
 *
 * ## 为什么 `getTargetConnectionId()` 不够
 *
 * 它可能返回 `undefined` —— 外部 MCP 客户端没指定工程时，那就是正常路径。
 * 而 `undefined` 传给 `callRequest` 之后，底层 `pickDefaultConnectionId()`
 * 会在**每一次请求时**重新挑一遍（`websocket/server.ts:263`）。
 *
 * 于是这一幕会发生：能力探测挑中了新版连接，中间连接重连，写入挑中了另一条
 * 装着旧插件的连接 —— 探过的和写的不是同一个对象，`require_empty` 被静默忽略，
 * 而工具最后照样报成功。这不是假想，隔离验证复现过。
 *
 * ## 所以
 *
 * 会改用户资产的工具**必须先解析出一个具体 id**，然后全程用它。
 * 解析不出来（没连、或者连着好几个但没说要哪个）就**拒绝**，
 * 不留「让底层去猜」这条路。
 */

import { projectManager } from '../../../../services/project/projectManager'
import { getTargetConnectionId } from '../../../core/projectTargetContext'

export type ResolvedConnection = { connectionId: string } | { error: string }

/**
 * 解析本次写入要钉死的连接。
 *
 * 顺序：
 *   1. 执行上下文里指定了目标工程 → 用它（这是最确定的）
 *   2. 只有一个交互式编辑器连着 → 用它
 *   3. 一个都没有 / 有好几个 → 拒绝，把原因说清楚
 */
export function resolveWriteConnection(): ResolvedConnection {
  const fromContext = getTargetConnectionId()
  if (fromContext) return { connectionId: fromContext }

  // 只认交互式编辑器 —— 无头进程（commandlet、-unattended）也占一条套接字，
  // 但往那上面写资产不是用户想要的
  const live = projectManager.getInteractiveProjects()

  if (live.length === 0) {
    return {
      error: '没有连上虚幻编辑器。请打开工程，并确认 UnrealAgentLink 插件已连接。'
    }
  }

  if (live.length > 1) {
    const names = live.map((project) => project.projectName || project.projectPath).join('、')
    return {
      error:
        `有 ${live.length} 个工程同时连着（${names}），不知道该写哪个。` +
        '请在助手里先指定目标工程再试。'
    }
  }

  return { connectionId: live[0].connectionId }
}
