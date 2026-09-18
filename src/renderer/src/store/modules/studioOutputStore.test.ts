/**
 * 产出 store 的**不丢东西**部分。
 *
 * 这里测的三件事都是「用户花钱生成的报告／信息图会不会凭空消失」，
 * 所以每一条都直接对着一种丢失路径写。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const apiMocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  remove: vi.fn()
}))

vi.mock('@renderer/api/studioOutputs', () => ({
  studioOutputsAPI: {
    read: apiMocks.read,
    write: apiMocks.write,
    remove: apiMocks.remove
  }
}))

import { useStudioOutputStore, type StudioOutput } from './studioOutputStore'

/** 一份已经生成完的报告 */
function doneReport(id: string): StudioOutput {
  return {
    id,
    type: 'report',
    title: `报告 ${id}`,
    sourceCount: 1,
    createdAt: new Date().toISOString(),
    reportContent: '正文',
    status: 'completed'
  }
}

/** 一份正在生成的报告：status 没设、内容还空着 —— 和「被刷新中断」长得一样 */
function generatingReport(id: string): StudioOutput {
  return {
    id,
    type: 'report',
    title: `报告 ${id}`,
    sourceCount: 1,
    createdAt: new Date().toISOString()
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  apiMocks.read.mockReset()
  apiMocks.write.mockReset()
  apiMocks.remove.mockReset()
  apiMocks.write.mockResolvedValue(undefined)
  apiMocks.remove.mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

// 装上的 spy 要收回去：全局 setup 只 clearAllMocks，不 restore，
// 断言失败时留着的桩会把这个文件后面的用例一起带歪
afterEach(() => {
  vi.restoreAllMocks()
})

describe('读盘失败之后不许再写', () => {
  /*
    读失败**不等于**没有产出：磁盘上那份可能好着，只是被杀软占着或者 JSON 坏了。
    此时内存里是空的，照着空的往下写，一份新产出就会把用户此前所有的报告顶掉。
  */
  it('读失败后再生成产出，不会拿空的盖掉磁盘上那份', async () => {
    apiMocks.read.mockRejectedValue(new Error('EBUSY'))
    const store = useStudioOutputStore()

    await store.loadNotebook('nb-1')

    store.addOutput('nb-1', doneReport('r1'))
    await vi.waitFor(() => expect(store.saveFailed).toBe(true))

    // 一次写都不许发出去
    expect(apiMocks.write).not.toHaveBeenCalled()
  })

  it('读失败要把「没存上」讲出来，不能只留一行 console', async () => {
    apiMocks.read.mockRejectedValue(new Error('坏 JSON'))
    const store = useStudioOutputStore()

    await store.loadNotebook('nb-1')

    expect(store.saveFailed).toBe(true)
  })

  it('读成功（哪怕是空的）照常能写', async () => {
    apiMocks.read.mockResolvedValue(null)
    const store = useStudioOutputStore()

    await store.loadNotebook('nb-1')
    store.addOutput('nb-1', doneReport('r1'))

    await vi.waitFor(() => expect(apiMocks.write).toHaveBeenCalledTimes(1))
    expect(store.saveFailed).toBe(false)
  })

  /*
    这条是上一版漏掉的那一格，而它恰好是最常见的路径。

    「读失败 → 拒绝写入」的解锁原来写在「读回来是空文件」那条分支下面，于是
    读成功**且有内容**时压根走不到 —— 一次偶发的读失败会把这个知识库锁成
    整个会话只读：用户生成报告、界面显示已完成、重启之后发现没了。
    上一版只测了「读回来是空」，所以这个 bug 是绿着过去的。
  */
  it('读失败之后重试读成功（有内容），要能重新写入', async () => {
    const store = useStudioOutputStore()

    apiMocks.read.mockRejectedValueOnce(new Error('EBUSY'))
    await store.loadNotebook('nb-1')
    expect(store.saveFailed).toBe(true)

    // 磁盘恢复了，再进一次这个知识库
    apiMocks.read.mockResolvedValue(JSON.stringify([doneReport('old')]))
    await store.loadNotebook('nb-1')

    store.addOutput('nb-1', doneReport('new'))
    await vi.waitFor(() => expect(apiMocks.write).toHaveBeenCalledTimes(1))
    expect(store.saveFailed).toBe(false)
    // 旧的那份还在，新的加在前面 —— 没有被顶掉
    expect(store.getOutputs('nb-1').map((o) => o.id)).toEqual(['new', 'old'])
  })
})

describe('清理未完成的产出只能动当前这个知识库', () => {
  /*
    判断依据是「状态不是终态、数据又是空的」，而**正在生成**的产出长得一模一样。
    进知识库 B 时顺手扫全量，就会把 A 里正在跑的那份改成「刷新导致中断」，
    用户看见失败又点一次重新生成，白花一次钱。
  */
  it('打开另一个知识库不会把正在生成的那份判成失败', async () => {
    const store = useStudioOutputStore()

    // A 里有一份正在生成
    store.addOutput('nb-A', generatingReport('running'))
    await vi.waitFor(() => expect(apiMocks.write).toHaveBeenCalled())

    // 第一次打开 B，B 磁盘上有一份已完成的
    apiMocks.read.mockResolvedValue(JSON.stringify([doneReport('b1')]))
    await store.loadNotebook('nb-B')

    /*
      这里要跨过一个宏任务再断言。

      上一版没跨，于是 store 建好时那个 `setTimeout(…, 0)` 的全量清理压根没轮到 ——
      测试是靠「时机没到」而不是靠「逻辑对」才绿的，加一个 1ms 的等待就会翻红。
      那个定时器已经删掉了（它扫的是全量，正是会误判别的库的那一份），
      所以现在等一拍之后结论必须还成立。
    */
    await new Promise((resolve) => setTimeout(resolve, 1))

    const stillRunning = store.getOutputs('nb-A')[0]
    expect(stillRunning.status).toBeUndefined()
    expect(stillRunning.errorMessage).toBeUndefined()
  })

  it('被打开的那个知识库里，残留的「生成中」照样要判失败', async () => {
    const store = useStudioOutputStore()

    apiMocks.read.mockResolvedValue(JSON.stringify([generatingReport('stale')]))
    await store.loadNotebook('nb-B')

    expect(store.getOutputs('nb-B')[0].status).toBe('failed')
  })
})

describe('换保管库', () => {
  /*
    产出文件跟着保管库走。切库之后内存里那份属于上一个库 ——
    不清的话用户会在新库里看到旧库的产出，再生成一份还会把旧库那些写进新库。
  */
  it('切库后内存清空，并且会重新读盘', async () => {
    const store = useStudioOutputStore()

    apiMocks.read.mockResolvedValue(JSON.stringify([doneReport('old')]))
    await store.loadNotebook('nb-1')
    expect(store.getOutputs('nb-1')).toHaveLength(1)

    store.resetForVaultSwitch()
    expect(store.getOutputs('nb-1')).toHaveLength(0)

    // 读盘状态也清了，所以同一个知识库会再读一次 —— 读到的是新库那份
    apiMocks.read.mockResolvedValue(JSON.stringify([doneReport('new')]))
    await store.loadNotebook('nb-1')
    expect(store.getOutputs('nb-1')[0].id).toBe('new')
  })

  /*
    清内存会把「生成中」的占位一起带走，那次生成跑完时 `updateOutput` 找不到列表、
    直接 return —— 用户花钱买的报告无声无息地没了。救不回来（结果属于上一个库），
    但必须数出来告诉调用方，不能当没发生。
  */
  it('切库时正在生成的那些要数出来', async () => {
    const store = useStudioOutputStore()

    store.addOutput('nb-A', generatingReport('running'))
    store.addOutput('nb-A', doneReport('done'))
    store.addOutput('nb-B', generatingReport('running-too'))

    expect(store.resetForVaultSwitch()).toBe(2)
  })

  it('没有正在生成的就别瞎报', async () => {
    const store = useStudioOutputStore()

    store.addOutput('nb-A', doneReport('done'))

    expect(store.resetForVaultSwitch()).toBe(0)
  })
})
