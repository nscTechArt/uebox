/**
 * 共享库（NAS）删文件夹：文件先删，库记录后删，失败要如实回报。
 *
 * 红灯用例来自一次评审：原实现是「删库记录 → 立即 return success → setImmediate 里删文件
 * → 失败只 console.warn」。断网或 NAS 只读时，界面显示删完了、库里记录没了，
 * 而 NAS 上的目录还在，成了谁都再也找不到的孤儿。
 *
 * 磁盘上的文件才是唯一真相源，数据库只是能重建的索引（AGENTS §5 第 10 条），
 * 所以顺序只能是「先删文件，删成了才删索引」。这里锁两件事：
 *   1. 删失败必须回报，不能吞掉；
 *   2. 两个删除处理器里，删目录的调用必须排在数据库删除之前，且不再有后台 rm 网络目录。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi, beforeEach } from 'vitest'

const rmMock = vi.fn()
const existsSyncMock = vi.fn()

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, existsSync: (p: string) => existsSyncMock(p) }
})
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return { ...actual, rm: (p: string, opts: unknown) => rmMock(p, opts) }
})

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { removeNetworkDirectories } = await import('./assetFolder')

describe('removeNetworkDirectories', () => {
  beforeEach(() => {
    rmMock.mockReset()
    existsSyncMock.mockReset()
    existsSyncMock.mockReturnValue(true)
  })

  it('目录删掉了就报成功', async () => {
    rmMock.mockResolvedValue(undefined)

    const result = await removeNetworkDirectories(['\\\\nas\\vault\\Props'])

    expect(result.ok).toBe(true)
    expect(result.failed).toEqual([])
    expect(rmMock).toHaveBeenCalledWith('\\\\nas\\vault\\Props', {
      recursive: true,
      force: true
    })
  })

  it('目录不存在算删掉了 —— 目标状态就是「它不在了」', async () => {
    existsSyncMock.mockReturnValue(false)

    const result = await removeNetworkDirectories(['\\\\nas\\vault\\Gone'])

    expect(result.ok).toBe(true)
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('删不掉时报失败并带上原因，不能吞掉', async () => {
    rmMock.mockRejectedValue(new Error('EPERM: operation not permitted'))

    const result = await removeNetworkDirectories(['\\\\nas\\vault\\Locked'])

    expect(result.ok).toBe(false)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].path).toBe('\\\\nas\\vault\\Locked')
    expect(result.failed[0].reason).toContain('EPERM')
  })

  it('一批里只要有一个删不掉，整批就算失败', async () => {
    rmMock.mockImplementation((p: string) =>
      p.includes('Locked') ? Promise.reject(new Error('EBUSY')) : Promise.resolve(undefined)
    )

    const result = await removeNetworkDirectories([
      '\\\\nas\\vault\\Ok',
      '\\\\nas\\vault\\Locked',
      '\\\\nas\\vault\\AlsoOk'
    ])

    expect(result.ok).toBe(false)
    expect(result.failed.map((f) => f.path)).toEqual(['\\\\nas\\vault\\Locked'])
  })

  it('没有目录要删时直接成功，不去碰文件系统', async () => {
    const result = await removeNetworkDirectories([])

    expect(result.ok).toBe(true)
    expect(existsSyncMock).not.toHaveBeenCalled()
  })
})

describe('两个删除处理器的执行顺序', () => {
  const source = readFileSync(join(__dirname, 'assetFolder.ts'), 'utf8')

  /**
   * 顺序是这条修复的全部意义所在，而它只体现在语句的先后上 —— 类型和单测都拦不住
   * 「有人为了让删除更快，又把 rm 挪回 setImmediate」。所以在源码层面钉一道。
   */
  it('删目录排在数据库删除之前（单个删除）', () => {
    const handler = source.slice(source.indexOf("ipcMain.handle('db:assetFolder:delete'"))
    const removalAt = handler.indexOf('await removeNetworkDirectories(')
    const dbDeleteAt = handler.indexOf('DELETE FROM assetData WHERE folderKey IN')

    expect(removalAt).toBeGreaterThan(-1)
    expect(dbDeleteAt).toBeGreaterThan(-1)
    expect(removalAt).toBeLessThan(dbDeleteAt)
  })

  it('删目录排在数据库删除之前（批量删除）', () => {
    const handler = source.slice(source.indexOf("ipcMain.handle('db:assetFolder:batchDelete'"))
    const removalAt = handler.indexOf('await removeNetworkDirectories(')
    const dbDeleteAt = handler.indexOf('const success = await transaction(')

    expect(removalAt).toBeGreaterThan(-1)
    expect(dbDeleteAt).toBeGreaterThan(-1)
    expect(removalAt).toBeLessThan(dbDeleteAt)
  })

  it('后台任务里不再删网络目录，只清缩略图', () => {
    const backgroundBlocks = source.split('setImmediate(').slice(1)
    for (const block of backgroundBlocks) {
      const body = block.slice(0, block.indexOf('\n  })'))
      expect(body).not.toContain('recursive: true')
    }
  })
})
