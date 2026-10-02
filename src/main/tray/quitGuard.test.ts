/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import { confirmTrayQuit, createTrayQuitGuard, type TrayQuitDeps } from './quitGuard'

/**
 * 托盘「退出」的拦截线：有任务在跑就得先问一句，
 * 默认和取消都指向「取消」—— 拍空格、按 Esc 都不该把活带走。
 */

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}(${params.count})` : key

function deps(overrides: Partial<TrayQuitDeps> = {}): {
  deps: TrayQuitDeps
  showDialog: ReturnType<typeof vi.fn>
  reportDialogError: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
} {
  const showDialog = vi.fn(async () => 1)
  const reportDialogError = vi.fn()
  const quit = vi.fn()
  return {
    deps: { countActiveOperations: () => 0, showDialog, reportDialogError, quit, t, ...overrides },
    showDialog,
    reportDialogError,
    quit
  }
}

describe('托盘退出确认', () => {
  it('没有任务在跑：直接退，不弹框', async () => {
    const { deps: d, showDialog, quit } = deps()
    await confirmTrayQuit(d)

    expect(quit).toHaveBeenCalledTimes(1)
    expect(showDialog).not.toHaveBeenCalled()
  })

  it('有任务在跑：弹出确认框，默认和取消都在「取消」上', async () => {
    const { deps: d, showDialog } = deps({ countActiveOperations: () => 2 })
    await confirmTrayQuit(d)

    expect(showDialog).toHaveBeenCalledWith({
      message: 'tray.quitConfirm(2)',
      buttons: ['tray.quitConfirmOk', 'tray.quitConfirmCancel'],
      defaultId: 1,
      cancelId: 1
    })
  })

  it('用户按了取消：不退', async () => {
    const { deps: d, quit } = deps({
      countActiveOperations: () => 1,
      showDialog: vi.fn(async () => 1)
    })
    await confirmTrayQuit(d)

    expect(quit).not.toHaveBeenCalled()
  })

  it('用户按了仍然退出：退', async () => {
    const { deps: d, quit } = deps({
      countActiveOperations: () => 3,
      showDialog: vi.fn(async () => 0)
    })
    await confirmTrayQuit(d)

    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('确认框弹着期间再点：不叠第二个框', async () => {
    let resolveDialog!: (value: number) => void
    const myDialog = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveDialog = resolve
        })
    )
    const { deps: d } = deps({ countActiveOperations: () => 1, showDialog: myDialog })
    const confirm = createTrayQuitGuard(d)

    const pending = confirm()
    await confirm() // 框还弹着：这一次直接落定，不再弹框

    expect(myDialog).toHaveBeenCalledTimes(1)

    resolveDialog(1)
    await pending
  })

  it('确认框落定之后再点：正常再问一次', async () => {
    const myDialog = vi.fn(async () => 1)
    const { deps: d } = deps({ countActiveOperations: () => 1, showDialog: myDialog })
    const confirm = createTrayQuitGuard(d)

    await confirm()
    await confirm()

    expect(myDialog).toHaveBeenCalledTimes(2)
  })

  it('确认框彻底弹不出来：记一笔，按用户意图直接退出；inFlight 放开下一次还能弹', async () => {
    const error = new Error('dialog gone')
    const myDialog = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(1)
    const {
      deps: d,
      reportDialogError,
      quit
    } = deps({
      countActiveOperations: () => 1,
      showDialog: myDialog
    })
    const confirm = createTrayQuitGuard(d)

    await confirm()

    expect(reportDialogError).toHaveBeenCalledTimes(1)
    expect(reportDialogError).toHaveBeenCalledWith(error)
    expect(quit).toHaveBeenCalledTimes(1)

    await confirm()
    expect(myDialog).toHaveBeenCalledTimes(2)
  })
})
