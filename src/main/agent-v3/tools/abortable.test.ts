import { describe, expect, it, vi } from 'vitest'

import { runAbortable, ToolAbortedError } from './abortable'

/**
 * 这一层要挡住的现象：用户点了停止，界面还要转十几秒。
 *
 * 原因见 `abortable.ts` —— pi 检查中止意图的时机在工具返回**之后**，
 * 所以工具不肯提前返回，停止就等于没按。
 */
describe('runAbortable', () => {
  const never = (): Promise<never> => new Promise(() => {})

  it('没给信号时原样跑完', async () => {
    await expect(runAbortable('t', undefined, async () => 42)).resolves.toBe(42)
  })

  it('工具先跑完就返回工具的结果，不受后来的中止影响', async () => {
    const controller = new AbortController()
    const result = await runAbortable('t', controller.signal, async () => 'done')
    controller.abort()
    expect(result).toBe('done')
  })

  it('工具还在等的时候按停止，当场抛出而不是等它', async () => {
    const controller = new AbortController()
    const pending = runAbortable('ue_screenshot', controller.signal, never)

    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(ToolAbortedError)
  })

  // 已经停了还去发一条命令，等于用户按了停止、引擎那边又多做了一件事
  it('信号已经中止时根本不调用工具', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = vi.fn(async () => 'ran')

    await expect(runAbortable('t', controller.signal, run)).rejects.toBeInstanceOf(ToolAbortedError)
    expect(run).not.toHaveBeenCalled()
  })

  /**
   * 措辞是有讲究的：这条会留在 transcript 里，用户下次接着聊时模型看得见。
   * 写成「已取消」会让它以为那一步没发生，然后重做一遍 —— 真机上那意味着
   * 多出第二个 Actor（同 `engineErrors.ts` 开头记的那笔）。
   */
  it('错误信息说的是「结局不明」，不是「没执行」', async () => {
    const controller = new AbortController()
    const pending = runAbortable('ue_spawn_actor', controller.signal, never)
    controller.abort()

    await expect(pending).rejects.toThrow(/ue_spawn_actor/)
    await expect(pending).rejects.toThrow(/不代表它没执行/)
  })

  // 一整轮对话共用一个信号，几十次调用就是几十个监听器
  it('跑完之后把监听器摘干净', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')

    await runAbortable('t', controller.signal, async () => 'ok')

    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  // 工具赢了赛跑之后才失败也一样：race 已经给两边都挂了处理函数，
  // 不会漏成主进程里的 unhandledRejection
  it('中止之后工具才失败，不产生未处理的拒绝', async () => {
    const controller = new AbortController()
    let fail: (error: Error) => void = () => {}
    const pending = runAbortable(
      't',
      controller.signal,
      () => new Promise<never>((_, reject) => (fail = reject))
    )

    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(ToolAbortedError)

    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    fail(new Error('引擎超时'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    process.off('unhandledRejection', unhandled)

    expect(unhandled).not.toHaveBeenCalled()
  })
})

describe('原生 AbortError 的收口', () => {
  it('工具体自己抛出的原生中止，换成写清楚了的那条消息', async () => {
    const controller = new AbortController()
    const native = Object.assign(new Error('Operation aborted'), { name: 'AbortError' })

    await expect(
      runAbortable('ue_spawn_actor', controller.signal, async () => {
        controller.abort()
        // 工具体内部的 fetch/callRequest 看见同一个 signal，比我们的监听器早一步
        throw native
      })
    ).rejects.toBeInstanceOf(ToolAbortedError)
  })

  it('中止的同时真失败了，保留真实原因', async () => {
    const controller = new AbortController()

    // 只判 signal.aborted 的话这条会被吞成「用户停止了」，把真实原因弄丢
    await expect(
      runAbortable('blueprint_compile', controller.signal, async () => {
        controller.abort()
        throw new Error('蓝图编译未通过（状态 Error）')
      })
    ).rejects.toThrow('蓝图编译未通过')
  })

  it('没中止时的失败原样抛出，不碰', async () => {
    const controller = new AbortController()
    await expect(
      runAbortable('t', controller.signal, async () => {
        throw new Error('引擎没有响应')
      })
    ).rejects.toThrow('引擎没有响应')
  })
})
