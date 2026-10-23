/**
 * 外部团队的通行证（team_seat）在执行流上怎么传。
 *
 * MCP 服务从 `_meta.unrealBox.teamSeat` 读出来放进执行流，`externalTeamTools.ts` 的门从这里取。
 * 单独一个文件：MCP 服务那头只要这两个函数，不该为此把整套团队工具拖进来。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const metaSeat = new AsyncLocalStorage<string>()

export function runWithTeamSeat<T>(seat: string | undefined, fn: () => T): T {
  return seat ? metaSeat.run(seat, fn) : fn()
}

export function getMetaTeamSeat(): string | undefined {
  return metaSeat.getStore()
}

/** 从 `_meta.unrealBox` 里取通行证。没有、不是字符串都当没带 */
export function readTeamSeat(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  const seat = (meta as { teamSeat?: unknown }).teamSeat
  return typeof seat === 'string' && seat.trim() ? seat.trim() : undefined
}
