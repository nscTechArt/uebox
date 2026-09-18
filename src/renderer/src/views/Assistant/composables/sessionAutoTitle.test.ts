import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * 取名这条路唯一的硬要求是「失败了什么都不做」：截断标题已经在侧边栏上了，
 * 模型没配 / 超时 / 吐废话，都不许把它弄没，更不许盖掉用户手动改的名字。
 *
 * 替身要在 import 之前装好：被测模块顶层 import 了 aiAPI。
 */
const generateSessionTitle = vi.hoisted(() => vi.fn())
vi.mock('../../../api/ai', () => ({ aiAPI: { generateSessionTitle } }))

import {
  autoNameSession,
  resetAutoNameStateForTest,
  type AutoNameSessionDeps
} from './sessionAutoTitle'

function makeStore(initialTitle: string): {
  titles: Map<string, string>
  deps: AutoNameSessionDeps
} {
  const titles = new Map<string, string>([['s1', initialTitle]])
  return {
    titles,
    deps: {
      getTitle: (id: string) => titles.get(id),
      applyTitle: (id: string, title: string) => {
        titles.set(id, title)
      }
    }
  }
}

/** 让 `void (async ...)` 里的 await 链跑完 */
const flush = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0))

describe('会话自动取名', () => {
  beforeEach(() => {
    resetAutoNameStateForTest()
    generateSessionTitle.mockReset()
    // 没有这座桥就整条路不走，所以每个用例都要先把它架上
    ;(window as unknown as { api: unknown }).api = { ai: { chatCompletion: vi.fn() } }
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('模型给出标题后换掉截断标题', async () => {
    generateSessionTitle.mockResolvedValue('蓝图编译报错排查')
    const { titles, deps } = makeStore('我的蓝图编译报错了，说 LNK2019')

    autoNameSession(
      's1',
      '我的蓝图编译报错了，说 LNK2019 无法解析的外部符号',
      '我的蓝图编译报错了，说 LNK2019',
      deps
    )
    await flush()

    expect(titles.get('s1')).toBe('蓝图编译报错排查')
    expect(generateSessionTitle).toHaveBeenCalledWith({
      firstMessage: '我的蓝图编译报错了，说 LNK2019 无法解析的外部符号'
    })
  })

  it('这几秒里用户手动改了名，就不覆盖', async () => {
    let resolveTitle: (value: string) => void = () => {}
    generateSessionTitle.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveTitle = resolve
      })
    )
    const { titles, deps } = makeStore('占位标题')

    autoNameSession('s1', '第一条消息', '占位标题', deps)
    titles.set('s1', '我自己起的名字')
    resolveTitle('模型起的名字')
    await flush()

    expect(titles.get('s1')).toBe('我自己起的名字')
  })

  it('模型没配 / 调用抛错时保留截断标题', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    generateSessionTitle.mockRejectedValue(new Error('未绑定轻量任务模型'))
    const { titles, deps } = makeStore('占位标题')

    autoNameSession('s1', '第一条消息', '占位标题', deps)
    await flush()

    expect(titles.get('s1')).toBe('占位标题')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('模型吐空串时保留截断标题', async () => {
    generateSessionTitle.mockResolvedValue('')
    const { titles, deps } = makeStore('占位标题')

    autoNameSession('s1', '第一条消息', '占位标题', deps)
    await flush()

    expect(titles.get('s1')).toBe('占位标题')
  })

  it('同一条会话在途时不重复发起', async () => {
    generateSessionTitle.mockResolvedValue('标题')
    const { deps } = makeStore('占位标题')

    autoNameSession('s1', '第一条消息', '占位标题', deps)
    autoNameSession('s1', '第一条消息', '占位标题', deps)
    await flush()

    expect(generateSessionTitle).toHaveBeenCalledTimes(1)
  })

  it('主进程桥不在时整条路不走', async () => {
    delete (window as unknown as { api?: unknown }).api
    const { deps } = makeStore('占位标题')

    autoNameSession('s1', '第一条消息', '占位标题', deps)
    await flush()

    expect(generateSessionTitle).not.toHaveBeenCalled()
  })

  it('空消息不发起调用', async () => {
    const { deps } = makeStore('占位标题')

    autoNameSession('s1', '   ', '占位标题', deps)
    await flush()

    expect(generateSessionTitle).not.toHaveBeenCalled()
  })
})
