/**
 * 托盘「退出」之前先看一眼还有没有任务在跑。
 *
 * 只挡**托盘**这一条退出路径：系统关机、Cmd+Q、`before-quit` 那套是用户
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
