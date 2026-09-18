// @vitest-environment node
import { mkdtemp, writeFile, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertFreshFile } from './assertFreshFile'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('assertFreshFile', () => {
  it('accepts a nonempty output at the boundary and rejects a stale one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ual-fresh-'))
    directories.push(dir)
    const path = join(dir, 'output.csv')
    await writeFile(path, 'new data')
    const since = 1_700_000_000_000
    await utimes(path, since / 1000, since / 1000)
    await expect(assertFreshFile(path, since)).resolves.toBeUndefined()
    await expect(assertFreshFile(path, since + 1)).rejects.toThrow('旧文件')
  })

  /**
   * 引擎给的路径可能是相对它自己安装目录的（CSV Profiler 就是）。
   * 按盒子的工作目录去解会拼出一个盘符不同、其余全对的路径 ——
   * 报「文件不存在」，没人看得出发生了什么。
   */
  it('相对路径当场报错，不拿盒子的工作目录去补', async () => {
    await expect(
      assertFreshFile('../../../GameJam/Proj/Saved/Profiling/CSV/Profile(1).csv', 0)
    ).rejects.toThrow('相对路径')
  })

  it('rejects absent, missing, empty and directory outputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ual-fresh-'))
    directories.push(dir)
    const empty = join(dir, 'empty')
    await writeFile(empty, '')
    await expect(assertFreshFile(undefined, 0)).rejects.toThrow('路径')
    await expect(assertFreshFile(join(dir, 'missing'), 0)).rejects.toThrow()
    await expect(assertFreshFile(empty, 0)).rejects.toThrow('非空文件')
    await expect(assertFreshFile(dir, 0)).rejects.toThrow('非空文件')
  })
})
