/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { dependenciesTool } from './dependencies'
import type { DependenciesResponse, DependencyWalk } from './types'

function walk(partial: Partial<DependencyWalk> = {}): DependencyWalk {
  return {
    count: 2,
    total_disk_size: 3 * 1024 * 1024,
    max_depth_reached: 2,
    truncated: false,
    by_class: { Texture2D: 1, Material: 1 },
    nodes: [
      { path: '/Game/Props/M_Rock', class: 'Material', depth: 1, disk_size: 1024 * 1024 },
      {
        path: '/Game/Shared/T_Rock',
        class: 'Texture2D',
        depth: 2,
        disk_size: 2 * 1024 * 1024,
        external: true
      }
    ],
    nodes_truncated: false,
    ...partial
  }
}

const run = async (
  input: Record<string, unknown>,
  out: Partial<DependenciesResponse>
): Promise<string> => {
  callRequest.mockResolvedValueOnce({
    ok: true,
    root: '/Game/Props',
    scope_is_folder: true,
    root_count: 5,
    root_asset_count: 5,
    direction: 'dependencies',
    hard_only: false,
    notes: [],
    ...out
  })
  const result = await dependenciesTool.execute('c1', { path: '/Game/Props', ...input })
  return result.content.map((c) => ('text' in c ? c.text : '')).join('')
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('ue_content_dependencies', () => {
  it('只读', () => {
    expect(dependenciesTool.unrealBox.risk).toBe('safe')
    expect(dependenciesTool.name).toBe('ue_content_dependencies')
  })

  it('参数原样透传，没给的不传', async () => {
    await run({ direction: 'both', hard_only: true }, {})
    expect(callRequest.mock.calls[0][0]).toBe('content.dependencies')
    expect(callRequest.mock.calls[0][1]).toEqual({
      path: '/Game/Props',
      direction: 'both',
      hard_only: true
    })
  })

  it('目录范围：摘要突出目录外面的依赖和断链', async () => {
    const text = await run(
      {},
      {
        dependencies: walk({
          external_count: 1,
          external: [walk().nodes[1]],
          missing: ['/Game/Gone/T_Old']
        }),
        notes: ['1 dependency package(s) do not exist']
      }
    )
    expect(text).toContain('目录 /Game/Props（5 个资产）')
    expect(text).toContain('在目录**外面**的：1 个')
    expect(text).toContain('/Game/Shared/T_Rock')
    expect(text).toContain('断链：1 个')
    expect(text).toContain('/Game/Gone/T_Old')
    expect(text).toContain('3.0 MB')
  })

  it('单资产：没人引用时明说可以删', async () => {
    const text = await run(
      { direction: 'referencers' },
      {
        scope_is_folder: false,
        root: '/Game/Props/SM_Rock',
        root_count: 1,
        root_asset_count: 1,
        direction: 'referencers',
        referencers: walk({
          count: 0,
          nodes: [],
          by_class: {},
          total_disk_size: 0,
          max_depth_reached: 0
        }),
        notes: ['Nothing references this asset']
      }
    )
    expect(text).toContain('资产 /Game/Props/SM_Rock')
    expect(text).toContain('被引用（谁用到了它）：0 个包')
    expect(text).toContain('Nothing references this asset')
  })

  it('unreferenced：列出清理候选和合计体积', async () => {
    const text = await run(
      { direction: 'unreferenced' },
      {
        direction: 'unreferenced',
        unreferenced: [
          { path: '/Game/Props/SM_Unused', class: 'StaticMesh', disk_size: 512 * 1024 }
        ],
        unreferenced_count: 1,
        unreferenced_disk_size: 512 * 1024,
        notes: ['confirm before deleting']
      }
    )
    expect(text).toContain('没有任何引用者的资产：1 个，合计 512 KB')
    expect(text).toContain('/Game/Props/SM_Unused')
  })
})
