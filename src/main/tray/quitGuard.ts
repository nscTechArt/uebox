/**
 * 托盘「退出」之前先看一眼还有没有任务在跑。
 *
 * 挡的是应用自己发起的退出：托盘「退出」、安装更新、界面的 `app-quit`（后两条
 * 经 `requestGuardedQuit` 走托盘同一套问法）。系统关机、Cmd+Q、`before-quit` 那套是用户
 * 对整个操作系统层面的决定，别去插嘴。托盘不一样 —— 用户右键托盘多半
 * 是顺手关个图标，很可能忘了刚才派出去的活还没跑完；悄没声地退出，agent
 * 改到一半的工程就撂在那儿了。
 *
 * 怎么问交给调用方（`trayController.ts`）：先让界面弹应用里统一的确认框，
 * 界面没接住才退回系统原生框。这个文件只管「要不要问」，可以进 vitest。
 */
export interface TrayQuitDeps {
  /** 还没收摊的会话操作数：AI 轮次 + 分叉/压缩这类历史操作（`countActiveSessionOperations`） */
  countActiveOperations: () => number
  /** 有操作没收摊：问用户。用户确认后由问的那一方自己调 `quit` */
  askConfirm: (count: number) => void
  /** 真正退出（`app.quit()` —— `before-quit` 会置 `__forceQuit__`） */
  quit: () => void
}

export function confirmTrayQuit(deps: TrayQuitDeps): void {
  const active = deps.countActiveOperations()
  if (active <= 0) {
    deps.quit()
    return
  }
  deps.askConfirm(active)
}

/**
 * 为什么退：托盘 / 窗口那颗退出按钮是 `quit`，「重启安装更新」是 `update` ——
 * 问的是同一个框，只有标题和确认按钮跟着换
 */
export type GuardedQuitReason = 'quit' | 'update'

/** 真正去问的那一方：有会话操作就问，确认了（或压根不用问）调 `proceed` */
export type QuitGuardHandler = (proceed: () => void, reason: GuardedQuitReason) => void

let guardHandler: QuitGuardHandler | null = null

/**
 * 托盘起来时把自己那套「先交界面、界面接不住退回原生框」挂上来
 * （`trayController.ts`）。全进程一份 —— 会话操作数本来就是进程级的，
 * 独立对话窗口里跑的轮次也数在里面。
 */
export function setQuitGuard(handler: QuitGuardHandler | null): void {
  guardHandler = handler
}

/**
 * 托盘以外的退出路径（安装更新、`app-quit`）走这里，和托盘问同一个框。
 *
 * 托盘没起来（初始化失败）就没人能问，按原来的样子直接走 —— 用户点的是
 * 明确的退出，拦下来又不给任何说法更糟。
 */
export function requestGuardedQuit(proceed: () => void, reason: GuardedQuitReason = 'quit'): void {
  if (!guardHandler) {
    proceed()
    return
  }
  guardHandler(proceed, reason)
}
