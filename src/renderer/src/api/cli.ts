/**
 * uebox 命令行的渲染层 API。
 *
 * 渲染层不直接碰 `ipcRenderer`（AGENTS.md 硬规则 5），一律走这里。
 *
 * 这一层不做 `unwrapResult()`：主进程这几个接口回的本来就是
 * `{ ok, status, message }` 这种自带成败的形状，再包一层只会多一次拆包。
 */

import type { CliPathChangeResult, CliStatus } from '../../../shared/cli'

export type { CliPathChangeResult, CliStatus }

export const cliAPI = {
  /** 命令行装了没有、在哪、在不在 PATH 里 */
  status: (): Promise<CliStatus> => window.api.cli.status(),

  /** 把命令行目录加进用户级 PATH。幂等，点第二下不会加重复 */
  addToPath: (): Promise<CliPathChangeResult> => window.api.cli.addToPath(),

  /** 从用户级 PATH 里摘掉。只摘这一条，别的条目不动 */
  removeFromPath: (): Promise<CliPathChangeResult> => window.api.cli.removeFromPath(),

  /** 在文件管理器里定位到它（不是运行它） */
  reveal: (): Promise<{ ok: boolean; message?: string }> => window.api.cli.reveal()
}
