/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import { createLaunchTracker, withProjectState } from './launchTracker'
import {
  getTrayRecentCandidates,
  runningProjectKeys,
  type ProjectRecordLike,
  type RecentEntry,
  type RunningProjectsDeps,
  type TrayRecentCandidatesDeps
} from './recentProjects'

/**
 * 「最近项目」的挑选规则：
 * - 只收 `isImported` 的（没进库的点开也接不上插件反馈）
 * - 显示名和打开路径都用**库记录**的，不用 UE 名单里的原始写法
 * - 同一工程按 projectKey 去重，留最近打开的那条
 * - 按 lastOpenTime 倒序，封顶 3 条
 * - 引擎正连着的标 running（插件报的路径可能是目录，也可能是 .uproject）——
 *   这层由 `withProjectState` 叠，不进候选名单
 */

function deps(
  overrides: Partial<TrayRecentCandidatesDeps & RunningProjectsDeps> = {}
): TrayRecentCandidatesDeps & RunningProjectsDeps {
  return {
    listRecent: vi.fn(async () => []),
    findRecord: vi.fn(() => undefined),
    interactiveProjectPaths: vi.fn(() => []),
    fileExists: vi.fn(() => true),
    ...overrides
  }
}

function entry(overrides: Partial<RecentEntry> = {}): RecentEntry {
  return {
    projectPath: 'D:/Alpha/Alpha.uproject',
    projectName: 'Alpha',
    lastOpenTime: '2025-09-11T02:17:54',
    isImported: true,
    ...overrides
  }
}

const record = (overrides: Partial<ProjectRecordLike> = {}): ProjectRecordLike => ({
  projectKey: 'key-alpha',
  projectName: '库里的名字',
  originPath: 'D:/Alpha/Alpha.uproject',
  ...overrides
})

describe('托盘最近项目', () => {
  it('没收进库的直接丢', async () => {
    const d = deps({ listRecent: async () => [entry({ isImported: false })] })
    expect(await getTrayRecentCandidates(d)).toEqual([])
  })

  it('库里查不到记录的直接丢', async () => {
    const d = deps({
      listRecent: async () => [entry()],
      findRecord: () => undefined
    })
    expect(await getTrayRecentCandidates(d)).toEqual([])
  })

  it('记录里的 originPath 已经不在盘上的直接丢', async () => {
    const d = deps({
      listRecent: async () => [entry()],
      findRecord: () => record(),
      fileExists: () => false
    })
    expect(await getTrayRecentCandidates(d)).toEqual([])
  })

  it('显示名和打开路径用库记录的，不用 UE 名单里那份', async () => {
    const d = deps({
      listRecent: async () => [
        entry({ projectPath: 'd:\\alpha\\Alpha.uproject', projectName: 'Alpha' })
      ],
      findRecord: () => record({ projectName: '正式名', originPath: 'D:\\Alpha\\Alpha.uproject' })
    })

    const [item] = await getTrayRecentCandidates(d)
    expect(item.name).toBe('正式名')
    expect(item.originPath).toBe('D:\\Alpha\\Alpha.uproject')
    expect(item.projectKey).toBe('key-alpha')
  })

  it('按项目目录查库记录：UE 名单给的是 .uproject 路径，取的是 dirname', async () => {
    const findRecord = vi.fn(() => record())
    const d = deps({
      listRecent: async () => [entry({ projectPath: 'D:/Alpha/Alpha.uproject' })],
      findRecord
    })

    await getTrayRecentCandidates(d)
    expect(findRecord).toHaveBeenCalledWith('D:/Alpha')
  })

  it('同一个工程在多个引擎版本各记一条：按 projectKey 去重留最新', async () => {
    const d = deps({
      listRecent: async () => [
        entry({ lastOpenTime: '2025-01-01T00:00:00' }),
        entry({ lastOpenTime: '2025-06-01T00:00:00' }),
        entry({ lastOpenTime: '2025-03-01T00:00:00' })
      ],
      findRecord: () => record()
    })

    const items = await getTrayRecentCandidates(d)
    expect(items).toHaveLength(1)
    expect(items[0].projectKey).toBe('key-alpha')
  })

  it('重复记录里的最新时间参与排序：A 一月+六月两条、B 三月一条，哪种顺序都 A 在前', async () => {
    const records: Record<string, ReturnType<typeof record>> = {
      'D:/A': record({ projectKey: 'k-a', projectName: 'A', originPath: 'D:/A/A.uproject' }),
      'D:/B': record({ projectKey: 'k-b', projectName: 'B', originPath: 'D:/B/B.uproject' })
    }
    const aJan = entry({ projectPath: 'D:/A/A.uproject', lastOpenTime: '2025-01-01T00:00:00' })
    const aJun = entry({ projectPath: 'D:/A/A.uproject', lastOpenTime: '2025-06-01T00:00:00' })
    const bMar = entry({ projectPath: 'D:/B/B.uproject', lastOpenTime: '2025-03-01T00:00:00' })

    for (const listRecent of [async () => [aJan, bMar, aJun], async () => [aJun, bMar, aJan]]) {
      const d = deps({ listRecent, findRecord: (dir) => records[dir] })
      const items = await getTrayRecentCandidates(d)
      expect(items.map((item) => item.projectKey)).toEqual(['k-a', 'k-b'])
    }
  })

  it('按 lastOpenTime 倒序，封顶 3 条', async () => {
    const records: Record<string, ReturnType<typeof record>> = {
      'D:/A': record({ projectKey: 'k-a', projectName: 'A', originPath: 'D:/A/A.uproject' }),
      'D:/B': record({ projectKey: 'k-b', projectName: 'B', originPath: 'D:/B/B.uproject' }),
      'D:/C': record({ projectKey: 'k-c', projectName: 'C', originPath: 'D:/C/C.uproject' }),
      'D:/D': record({ projectKey: 'k-d', projectName: 'D', originPath: 'D:/D/D.uproject' })
    }
    const d = deps({
      listRecent: async () => [
        entry({ projectPath: 'D:/A/A.uproject', lastOpenTime: '2025-01-01T00:00:00' }),
        entry({ projectPath: 'D:/B/B.uproject', lastOpenTime: '2025-04-01T00:00:00' }),
        entry({ projectPath: 'D:/C/C.uproject', lastOpenTime: '2025-03-01T00:00:00' }),
        entry({ projectPath: 'D:/D/D.uproject', lastOpenTime: '2025-02-01T00:00:00' })
      ],
      findRecord: (dir) => records[dir]
    })

    const items = await getTrayRecentCandidates(d)
    expect(items.map((item) => item.projectKey)).toEqual(['k-b', 'k-c', 'k-d'])
  })

  it('引擎报的是项目目录：对上记录的标 running', async () => {
    const d = deps({
      listRecent: async () => [entry()],
      findRecord: () => record(),
      interactiveProjectPaths: () => ['D:/Alpha']
    })

    const tracker = createLaunchTracker()
    const [item] = withProjectState(
      await getTrayRecentCandidates(d),
      runningProjectKeys(d),
      tracker
    )
    expect(item.running).toBe(true)
  })

  it('引擎报的是 .uproject 文件路径：取 dirname 再比，照样认出 running', async () => {
    const d = deps({
      listRecent: async () => [entry()],
      findRecord: () => record(),
      interactiveProjectPaths: () => ['D:/Alpha/Alpha.uproject']
    })

    const tracker = createLaunchTracker()
    const [item] = withProjectState(
      await getTrayRecentCandidates(d),
      runningProjectKeys(d),
      tracker
    )
    expect(item.running).toBe(true)
  })

  it('引擎连着的工程和菜单这条对不上：不标 running', async () => {
    const findRecord = vi.fn((dir: string) =>
      dir === 'D:/Alpha' ? record() : record({ projectKey: 'key-other' })
    )
    const d = deps({
      listRecent: async () => [entry()],
      findRecord,
      interactiveProjectPaths: () => ['D:/Elsewhere']
    })

    const tracker = createLaunchTracker()
    const [item] = withProjectState(
      await getTrayRecentCandidates(d),
      runningProjectKeys(d),
      tracker
    )
    expect(item.running).toBe(false)
  })

  it('候选名单只有 key/名字/路径：running/launching 那层每次建菜单现叠', async () => {
    const d = deps({
      listRecent: async () => [entry()],
      findRecord: () => record(),
      interactiveProjectPaths: () => ['D:/Alpha']
    })

    // 引擎明明连着它，候选阶段也不标 —— 标了就会被名单缓存钉住十秒
    const [item] = await getTrayRecentCandidates(d)
    expect(item).toEqual({
      projectKey: 'key-alpha',
      name: '库里的名字',
      originPath: 'D:/Alpha/Alpha.uproject'
    })
  })

  it('runningProjectKeys：插件报路径、认的是 projectKey，目录和 .uproject 写法都认', () => {
    const records: Record<string, ReturnType<typeof record>> = {
      'D:/Alpha': record(),
      'D:/Beta': record({ projectKey: 'key-beta' })
    }
    const d = deps({
      findRecord: (dir) => records[dir],
      interactiveProjectPaths: () => ['D:/Alpha/Alpha.uproject', 'D:/Beta', 'D:/Ghost']
    })

    expect([...runningProjectKeys(d)].sort()).toEqual(['key-alpha', 'key-beta'])
  })
})
