/**
 * 托盘「退出」之前先看一眼还有没有任务在跑。
 *
 * 只挡**托盘**这一条退出路径：系统关机、Cmd+Q、`before-quit` 那套是用户
 * 对整个操作系统层面的决定，别去插嘴。托盘不一样 —— 用户右键托盘多半
 * 是顺手关个图标，很可能忘了刚才派出去的活还没跑完；悄没声地退出，agent
 * 改到一半的工程就撂在那儿了。
 *
 * 依赖全注入，Electron 的 `dialog` / `app` 留在调用方（`trayController.ts`），
 * 这个文件本身可以进 vitest。
 */
import type { MainTranslator } from '../i18n'

export interface TrayQuitDialogOptions {
  message: string
  buttons: string[]
  /** 默认聚焦「取消」：误按回车不该把跑着的任务一起带走 */
  defaultId: number
  cancelId: number
}

export interface TrayQuitDeps {
  /** 还没收摊的会话操作数：AI 轮次 + 分叉/压缩这类历史操作（`countActiveSessionOperations`） */
  countActiveOperations: () => number
  /** 弹确认框，回传用户按下的按钮下标 */
  showDialog: (options: TrayQuitDialogOptions) => Promise<number>
  /** 框彻底弹不出来时记一笔；随后按用户意图直接退出 */
  reportDialogError: (error: unknown) => void
  /** 真正退出（`app.quit()` —— `before-quit` 会置 `__forceQuit__`） */
  quit: () => void
  t: MainTranslator
}

export async function confirmTrayQuit(deps: TrayQuitDeps): Promise<void> {
  const active = deps.countActiveOperations()
  if (active <= 0) {
    deps.quit()
    return
  }

  let response: number
  try {
    response = await deps.showDialog({
      message: deps.t('tray.quitConfirm', { count: active }),
      buttons: [deps.t('tray.quitConfirmOk'), deps.t('tray.quitConfirmCancel')],
      // 「仍然退出」是 0 号，但默认和取消都指到 1 号 —— 拍空格、按 Esc 都是取消
      defaultId: 1,
      cancelId: 1
    })
  } catch (error) {
    // 确认框防的是「顺手退出」；框根本弹不出来时把用户明确的退出也拦下更糟
    // —— Windows 上托盘「退出」几乎是唯一的退出入口。
    // 这里只接得到调用时抛出的异常：Electron 的原生对话框不会以 reject 报失败，
    // Windows 上弹不出来按取消落定，表现为点了「退出」没有反应
    deps.reportDialogError(error)
    deps.quit()
    return
  }
  if (response === 0) deps.quit()
}

/**
 * 给菜单用的入口：确认框弹着期间再点「退出」不叠第二个框。
 *
 * `countActiveOperations` 仍每次进 `confirmTrayQuit` 现查，不会因为包了一层就拿
 * 旧快照 —— 这里钉住的只是「此刻已经有个框在等答复」这一件事。
 */
export function createTrayQuitGuard(deps: TrayQuitDeps): () => Promise<void> {
  let inFlight = false
  return async () => {
    if (inFlight) return
    inFlight = true
    try {
      await confirmTrayQuit(deps)
    } finally {
      inFlight = false
    }
  }
}
