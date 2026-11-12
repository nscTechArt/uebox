/**
 * 编辑器是不是还在加载：连接表里还没有它，但进程已经起来了（或者盒子刚启动过它）。
 *
 * ## 它修的是哪个洞
 *
 * `open_project` 只看连接表判「开没开」。编辑器从启动到插件连上要几十秒到几分钟，
 * 这段时间连接表里没有它，再调一次 `open_project` 就会再拉一个编辑器。2026-10-24 联调时
 * 制作人每 25 秒问一次「开好没」，一个工程开出了三个编辑器：三条连接、三份内存里的关卡，
 * 队员各改各的，互相覆盖。
 *
 * 所以没连上时还要看进程：同一个 .uproject 的编辑器进程在，就是在加载，不再启动。
 * 进程刚拉起来的头几秒可能还查不到，查进程本身也可能失败（WMI 坏了、超时）——
 * 这两种情况靠「盒子刚启动过它」兜底：刚启动不久就当它在加载。
 */

import { projectPathKey } from '../../../core/projectPathKey'

/** 刚启动、进程可能还没出现在进程表里的那一小段 */
export const PROCESS_APPEAR_MS = 30_000

/** 查不了进程时，启动后多久之内都当它还在加载。超过就照常启动：多半是加载中途崩了 */
export const LAUNCH_GRACE_MS = 5 * 60_000

const launchedAt = new Map<string, number>()

/** 盒子刚把这个工程交给系统打开 */
export function noteEditorLaunch(uprojectPath: string, now: number = Date.now()): void {
  launchedAt.set(projectPathKey(uprojectPath), now)
}

export interface EditorLoadingDeps {
  /**
   * 这个工程的编辑器进程在不在。查不了（命令失败、超时）就抛，
   * 和「查过了、不在」分开：前者要靠启动记录兜底，后者不用
   */
  findProcess: (uprojectPath: string) => Promise<unknown>
  now?: () => number
}

export async function editorStillLoading(
  uprojectPath: string,
  deps: EditorLoadingDeps
): Promise<boolean> {
  const now = (deps.now ?? Date.now)()
  const launched = launchedAt.get(projectPathKey(uprojectPath))
  const since = launched === undefined ? Infinity : now - launched
  let found: boolean | undefined
  try {
    found = Boolean(await deps.findProcess(uprojectPath))
  } catch {
    found = undefined
  }
  if (found) return true
  return since < (found === undefined ? LAUNCH_GRACE_MS : PROCESS_APPEAR_MS)
}

/** 测试用 */
export function resetEditorLaunchesForTest(): void {
  launchedAt.clear()
}
