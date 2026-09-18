/**
 * networkVaultCopy.test.ts — SMB 网络库复制引擎
 *
 * 核心断言：**失败的文件绝不能进 networkPaths**。上游据此决定要不要写库，
 * 原实现在 catch 里照样往映射表里塞 key，于是「复制失败」被一路当成
 * 「导入成功」，界面报「导入完成」而文件其实没进库。
 */
import { sep } from 'path'
import { describe, expect, it, vi } from 'vitest'

import {
  classifyCopyError,
  createNetworkTargetPathResolver,
  runNetworkVaultCopy,
  type NetworkVaultCopyDeps
} from './networkVaultCopy'

const file = (name: string, dir = 'D:/src/11'): { name: string; path: string; size: number } => ({
  name,
  path: `${dir}/${name}`,
  size: 10
})

const makeDeps = (over: Partial<NetworkVaultCopyDeps> = {}): NetworkVaultCopyDeps => ({
  copyFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  removeFile: vi.fn(async () => {}),
  fileExists: vi.fn(() => false),
  fileSize: vi.fn(async () => 10),
  hashFile: vi.fn(async () => 'same'),
  confirmOverwrite: vi.fn(async () => ({ action: 'skip' as const })),
  onProgress: vi.fn(),
  sleep: vi.fn(async () => {}),
  ...over
})

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: boom`), { code })

const baseParams = {
  networkPath: '//nas/vault',
  rootFolderPath: 'D:/src/11',
  targetFolderFullPath: '',
  concurrency: 3
}

describe('复制失败的下场', () => {
  it.each(['overwrite', 'skip'] as const)(
    'applies %s-all to conflicts already queued',
    async (action) => {
      const deps = makeDeps({
        fileExists: () => true,
        hashFile: async (path) => path,
        confirmOverwrite: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
          return { action, applyToAll: true }
        })
      })
      const result = await runNetworkVaultCopy(
        { ...baseParams, files: [file('a'), file('b'), file('c')] },
        deps
      )
      expect(deps.confirmOverwrite).toHaveBeenCalledOnce()
      expect(action === 'overwrite' ? result.copied : result.skipped).toBe(3)
    }
  )
  it('cancellation settles the current file and starts no further copies', async () => {
    const controller = new AbortController()
    const deps = makeDeps({
      copyFile: vi.fn(async () => {
        controller.abort()
      })
    })
    const result = await runNetworkVaultCopy(
      { ...baseParams, concurrency: 1, signal: controller.signal, files: [file('a'), file('b')] },
      deps
    )
    expect(deps.copyFile).toHaveBeenCalledOnce()
    expect(result.copied).toBe(1)
    expect(result.aborted).toBe(true)
    expect(result.failures.map((failure) => failure.fileName)).toEqual(['b'])
  })

  it('失败必须计为 failed，且绝不进 networkPaths', async () => {
    const deps = makeDeps({
      copyFile: vi.fn(async () => {
        throw errno('ENOENT')
      })
    })

    const report = await runNetworkVaultCopy(
      { ...baseParams, files: [file('a.uasset')], sweepRounds: 0 },
      deps
    )

    expect(report.failed).toBe(1)
    expect(report.copied).toBe(0)
    // ← 这条是关键：上游据此拒绝写库
    expect(report.networkPaths.size).toBe(0)
    expect(report.failures[0]).toMatchObject({
      stage: 'copy_to_network',
      code: 'ENOENT',
      retriable: false,
      fileName: 'a.uasset'
    })
  })

  it('瞬时失败在补扫轮里被救回，最终算成功', async () => {
    let calls = 0
    const deps = makeDeps({
      copyFile: vi.fn(async () => {
        if (++calls === 1) throw errno('ETIMEDOUT')
      })
    })

    const report = await runNetworkVaultCopy(
      { ...baseParams, files: [file('a.uasset')], sweepRounds: 2 },
      deps
    )

    expect(report.copied).toBe(1)
    expect(report.failed).toBe(0)
    expect(report.networkPaths.size).toBe(1)
    expect(deps.sleep).toHaveBeenCalledTimes(1)
  })

  it('重试耗尽后如实记录 retriable 与 attempts', async () => {
    const deps = makeDeps({
      copyFile: vi.fn(async () => {
        throw errno('ECONNRESET')
      })
    })

    const report = await runNetworkVaultCopy(
      { ...baseParams, files: [file('a.uasset')], sweepRounds: 2 },
      deps
    )

    expect(report.failed).toBe(1)
    expect(report.failures[0].retriable).toBe(true)
    expect(report.failures[0].attempts).toBe(3)
  })

  it('磁盘满立刻中止，剩余文件也必须有下场（不许凭空消失）', async () => {
    const deps = makeDeps({
      copyFile: vi.fn(async () => {
        throw errno('ENOSPC')
      })
    })
    const files = [file('a.uasset'), file('b.uasset'), file('c.uasset')]

    const report = await runNetworkVaultCopy(
      { ...baseParams, files, concurrency: 1, sweepRounds: 0 },
      deps
    )

    expect(report.aborted).toBe(true)
    // 每个文件都要有归宿，加起来等于总数
    expect(report.copied + report.identical + report.skipped + report.failed).toBe(3)
    expect(report.failures).toHaveLength(3)
  })
})

describe('覆盖与跳过', () => {
  it('覆盖确认超时 = skipped/prompt_timeout，不是成功', async () => {
    const deps = makeDeps({
      fileExists: vi.fn(() => true),
      hashFile: vi.fn(async (p: string) => (p.includes('src') ? 'A' : 'B')),
      confirmOverwrite: vi.fn(async () => ({
        action: 'skip' as const,
        reason: 'prompt_timeout' as const
      }))
    })

    const report = await runNetworkVaultCopy(
      { ...baseParams, files: [file('a.uasset')], concurrency: 1, sweepRounds: 0 },
      deps
    )

    expect(report.skipped).toBe(1)
    expect(report.copied).toBe(0)
    expect(report.skips[0].reason).toBe('prompt_timeout')
    // 跳过的文件同样不该进 networkPaths
    expect(report.networkPaths.size).toBe(0)
  })

  it('内容相同自动跳过物理复制，但仍算成功并保留路径映射', async () => {
    const deps = makeDeps({ fileExists: vi.fn(() => true) })

    const report = await runNetworkVaultCopy(
      { ...baseParams, files: [file('a.uasset')], concurrency: 1, sweepRounds: 0 },
      deps
    )

    expect(report.identical).toBe(1)
    expect(deps.copyFile).not.toHaveBeenCalled()
    expect(report.networkPaths.size).toBe(1)
  })

  it('覆盖已有文件走临时文件 + rename，失败不毁旧文件', async () => {
    const deps = makeDeps({
      fileExists: vi.fn(() => true),
      hashFile: vi.fn(async (p: string) => (p.includes('src') ? 'A' : 'B')),
      confirmOverwrite: vi.fn(async () => ({ action: 'overwrite' as const })),
      copyFile: vi.fn(async () => {
        throw errno('ETIMEDOUT')
      })
    })

    await runNetworkVaultCopy(
      { ...baseParams, files: [file('a.uasset')], concurrency: 1, sweepRounds: 0 },
      deps
    )

    const written = (deps.copyFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(written.endsWith('.ubx-part')).toBe(true)
    // 半截文件被清掉，旧文件没被 rename 覆盖
    expect(deps.removeFile).toHaveBeenCalledWith(written)
    expect(deps.rename).not.toHaveBeenCalled()
  })

  it('forceOverwrite 时不再弹窗', async () => {
    const deps = makeDeps({
      fileExists: vi.fn(() => true),
      hashFile: vi.fn(async (p: string) => (p.includes('src') ? 'A' : 'B'))
    })

    const report = await runNetworkVaultCopy(
      {
        ...baseParams,
        files: [file('a.uasset')],
        concurrency: 1,
        sweepRounds: 0,
        forceOverwrite: true
      },
      deps
    )

    expect(deps.confirmOverwrite).not.toHaveBeenCalled()
    expect(report.copied).toBe(1)
    // 没问就把一个内容不同的已有文件盖掉了 —— 必须留痕。
    // 从复制失败到点重试之间，同事完全可能更新过网络盘上那个文件。
    expect(report.forcedOverwrites).toEqual([expect.objectContaining({ fileName: 'a.uasset' })])
  })

  it('forceOverwrite 下内容相同的文件不算「被覆盖」', async () => {
    const deps = makeDeps({
      fileExists: vi.fn(() => true),
      hashFile: vi.fn(async () => 'SAME')
    })

    const report = await runNetworkVaultCopy(
      {
        ...baseParams,
        files: [file('a.uasset')],
        concurrency: 1,
        sweepRounds: 0,
        forceOverwrite: true
      },
      deps
    )

    expect(report.identical).toBe(1)
    expect(report.forcedOverwrites).toEqual([])
  })

  it('正常导入（非重试）由用户确认的覆盖不进这份清单', async () => {
    const deps = makeDeps({
      fileExists: vi.fn(() => true),
      hashFile: vi.fn(async (p: string) => (p.includes('src') ? 'A' : 'B')),
      confirmOverwrite: vi.fn(async () => ({ action: 'overwrite' as const }))
    })

    const report = await runNetworkVaultCopy(
      { ...baseParams, files: [file('a.uasset')], concurrency: 1, sweepRounds: 0 },
      deps
    )

    expect(report.copied).toBe(1)
    expect(report.forcedOverwrites).toEqual([])
  })
})

describe('目标路径解析', () => {
  it('保留导入根目录名与子目录层级', () => {
    const resolve = createNetworkTargetPathResolver('//nas/vault', 'D:/src/11', '')
    const target = resolve({ name: 'x.uasset', path: 'D:\\src\\11\\Mesh\\x.uasset' })
    expect(target).toContain(`11${sep}`)
    expect(target).toContain(`Mesh${sep}`)
  })

  it('散文件导入落在目标文件夹根下', () => {
    const resolve = createNetworkTargetPathResolver('//nas/vault', 'ALL', 'Props')
    expect(resolve({ name: 'x.png', path: 'E:/whatever/x.png' })).toMatch(/Props[\\/]x\.png$/)
  })
})

describe('错误分级', () => {
  it.each([
    ['ETIMEDOUT', true, false],
    ['EBUSY', true, false],
    ['ENOSPC', false, true],
    ['ENOENT', false, false]
  ])('%s → retriable=%s fatal=%s', (code, retriable, fatal) => {
    expect(classifyCopyError(errno(code))).toMatchObject({ code, retriable, fatal })
  })
})
