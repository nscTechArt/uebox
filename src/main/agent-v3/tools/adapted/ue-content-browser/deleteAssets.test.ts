/**
 * @vitest-environment node
 *
 * `ue_content_delete` 的目录展开与超时。
 *
 * 2026-09-22 的反馈：工具说明写「列出资产再逐个删」，模型照做走了 Python 循环
 * `delete_asset`，282 次 GC 把编辑器占死 15 分钟。这里守的是修完之后的三件事：
 *
 * - 目录路径在盒子这边展开成对象路径，和显式资产合成**一批**发给 `content.delete`；
 * - 不带点的路径搜不到东西时**原样交给引擎**（它可能是资产的包路径），不在盒子里判死；
 * - 超时随批量放大，超时那一档保住 code 并告诉模型别重发。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRequest, getConnectionCount, releaseProtectionBeforeDelete } = vi.hoisted(() => ({
  callRequest: vi.fn(),
  getConnectionCount: vi.fn(),
  releaseProtectionBeforeDelete: vi.fn()
}))

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ getConnectionCount, callRequest })
  }
}))
vi.mock('../../../core/projectTargetContext', () => ({ getTargetConnectionId: () => 'conn-1' }))
vi.mock('../../../core/assetLockEnforcement', () => ({ releaseProtectionBeforeDelete }))

import { WebSocketErrorCode, WebSocketServiceError } from '../../../../services/websocket/types'
import { V2_TIMEOUT_CODE } from '../../engineErrors'
import {
  FOLDER_EXPAND_LIMIT,
  createDeleteAssetsTool,
  deleteTimeoutMs,
  isMountRoot,
  looksLikeFolder
} from './deleteAssets'

type Result = Record<string, unknown>
const tool = createDeleteAssetsTool()
const run = (input: Record<string, unknown>): Promise<Result> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Result>)(input, {})

const callsTo = (method: string): unknown[][] =>
  callRequest.mock.calls.filter((call) => call[0] === method)

const DELETED_OK = (paths: string[]): Result => ({
  ok: true,
  deleted_count: paths.length,
  requested_count: paths.length,
  deleted: paths
})

beforeEach(() => {
  getConnectionCount.mockReset().mockReturnValue(1)
  releaseProtectionBeforeDelete.mockReset().mockResolvedValue(undefined)
  callRequest.mockReset()
})

describe('looksLikeFolder', () => {
  it('带点的是对象路径，不是目录', () => {
    expect(looksLikeFolder('/Game/Temp/A.A')).toBe(false)
  })
  it('不带点的可能是目录', () => {
    expect(looksLikeFolder('/Game/ThirdParty/AnimeGirl')).toBe(true)
    expect(looksLikeFolder('/Game/ThirdParty/AnimeGirl/')).toBe(true)
  })
  it('不以 / 开头的不当目录', () => {
    expect(looksLikeFolder('AnimeGirl')).toBe(false)
  })
})

describe('目录展开', () => {
  it('目录搜出来的资产和显式资产合成一批，只发一次 content.delete', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'content.search') {
        return {
          ok: true,
          count: 2,
          total: 2,
          truncated: false,
          results: [
            { name: 'SK_Girl', path: '/Game/ThirdParty/AnimeGirl/SK_Girl', class: 'SkeletalMesh' },
            { name: 'M_Hair', path: '/Game/ThirdParty/AnimeGirl/Mat/M_Hair', class: 'Material' }
          ]
        }
      }
      return DELETED_OK([
        '/Game/ThirdParty/AnimeGirl/SK_Girl.SK_Girl',
        '/Game/ThirdParty/AnimeGirl/Mat/M_Hair.M_Hair',
        '/Game/Temp/A.A'
      ])
    })

    const result = await run({ paths: ['/Game/ThirdParty/AnimeGirl/', '/Game/Temp/A.A'] })

    const searches = callsTo('content.search')
    expect(searches).toHaveLength(1)
    expect(searches[0][1]).toEqual({
      query: '*',
      path: '/Game/ThirdParty/AnimeGirl',
      limit: FOLDER_EXPAND_LIMIT
    })

    const deletes = callsTo('content.delete')
    expect(deletes).toHaveLength(1)
    expect((deletes[0][1] as { paths: string[] }).paths).toEqual([
      '/Game/ThirdParty/AnimeGirl/SK_Girl.SK_Girl',
      '/Game/ThirdParty/AnimeGirl/Mat/M_Hair.M_Hair',
      '/Game/Temp/A.A'
    ])

    expect(result.success).toBe(true)
    expect(result.expanded_folders).toEqual({ '/Game/ThirdParty/AnimeGirl': 2 })
    expect(String(result.message)).toContain('/Game/ThirdParty/AnimeGirl 2 个')
  })

  it('搜不到东西的不带点路径原样交给引擎 —— 它可能是资产的包路径', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'content.search') {
        return { ok: true, count: 0, total: 0, truncated: false, results: [] }
      }
      return DELETED_OK(['/Game/Temp/Standalone'])
    })

    const result = await run({ paths: ['/Game/Temp/Standalone'] })

    expect((callsTo('content.delete')[0][1] as { paths: string[] }).paths).toEqual([
      '/Game/Temp/Standalone'
    ])
    expect(result.success).toBe(true)
    expect(result.expanded_folders).toBeUndefined()
  })

  it('目录被截断时什么都不删，让调用方按子目录分批', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'content.search') {
        return {
          ok: true,
          count: FOLDER_EXPAND_LIMIT,
          total: 812,
          truncated: true,
          results: [{ name: 'A', path: '/Game/Big/A', class: 'Texture2D' }]
        }
      }
      throw new Error('不该走到删除')
    })

    const result = await run({ paths: ['/Game/Big'] })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('812')
    expect(String(result.error)).toContain('什么都没删')
    expect(callsTo('content.delete')).toHaveLength(0)
  })

  it('挂载根一律拒绝，一个搜索都不发', async () => {
    expect(isMountRoot('/Game')).toBe(true)
    expect(isMountRoot('/Game/')).toBe(true)
    expect(isMountRoot('/Game/Dir')).toBe(false)

    const result = await run({ paths: ['/Game', '/Game/Dir/A.A'] })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('挂载根')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('dry_run 只展开不删，回清单', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'content.search') {
        return {
          ok: true,
          count: 1,
          total: 1,
          truncated: false,
          results: [{ name: 'A', path: '/Game/Dir/A', class: 'Texture2D' }]
        }
      }
      throw new Error('不该走到删除')
    })

    const result = await run({ paths: ['/Game/Dir'], dry_run: true })

    expect(result.success).toBe(true)
    expect(result.dry_run).toBe(true)
    expect(result.would_delete).toEqual(['/Game/Dir/A.A'])
    expect(callsTo('content.delete')).toHaveLength(0)
  })

  it('包路径和目录展开出的对象路径是同一个资产，只发对象路径那份', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'content.search') {
        return {
          ok: true,
          count: 1,
          total: 1,
          truncated: false,
          results: [{ name: 'A', path: '/Game/Dir/A', class: 'Texture2D' }]
        }
      }
      return DELETED_OK(['/Game/Dir/A.A'])
    })

    await run({ paths: ['/Game/Dir/A', '/Game/Dir'] })

    expect((callsTo('content.delete')[0][1] as { paths: string[] }).paths).toEqual([
      '/Game/Dir/A.A'
    ])
  })

  it('嵌套目录只搜外层一次', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'content.search') {
        return {
          ok: true,
          count: 1,
          total: 1,
          truncated: false,
          results: [{ name: 'B', path: '/Game/Pack/Anim/B', class: 'AnimSequence' }]
        }
      }
      return DELETED_OK(['/Game/Pack/Anim/B.B'])
    })

    await run({ paths: ['/Game/Pack', '/Game/Pack/Anim'] })

    expect(callsTo('content.search')).toHaveLength(1)
    expect(callsTo('content.search')[0][1]).toMatchObject({ path: '/Game/Pack' })
  })

  it('旧插件不回 results 字段时当空目录处理，不炸', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'content.search') return { ok: true, count: 0 }
      return DELETED_OK(['/Game/Old'])
    })

    const result = await run({ paths: ['/Game/Old'] })

    expect(result.success).toBe(true)
    expect((callsTo('content.delete')[0][1] as { paths: string[] }).paths).toEqual(['/Game/Old'])
  })

  it('同一资产既被点名又在目录里只算一份', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'content.search') {
        return {
          ok: true,
          count: 1,
          total: 1,
          truncated: false,
          results: [{ name: 'A', path: '/Game/Dir/A', class: 'Texture2D' }]
        }
      }
      return DELETED_OK(['/Game/Dir/A.A'])
    })

    await run({ paths: ['/Game/Dir/A.A', '/Game/Dir'] })

    expect((callsTo('content.delete')[0][1] as { paths: string[] }).paths).toEqual([
      '/Game/Dir/A.A'
    ])
  })
})

describe('超时', () => {
  it('随批量放大，封顶 10 分钟', () => {
    expect(deleteTimeoutMs(1)).toBe(32_000)
    expect(deleteTimeoutMs(282)).toBe(30_000 + 282 * 2_000)
    expect(deleteTimeoutMs(10_000)).toBe(600_000)
  })

  it('发给 content.delete 的超时按展开后的条数算', async () => {
    callRequest.mockResolvedValue(DELETED_OK(['/Game/A.A', '/Game/B.B']))

    await run({ paths: ['/Game/A.A', '/Game/B.B'] })

    expect(callsTo('content.delete')[0][3]).toBe(deleteTimeoutMs(2))
  })

  it('等引擎超时了：保住 code，并告诉模型别重发、先回读', async () => {
    callRequest.mockRejectedValue(
      new WebSocketServiceError(WebSocketErrorCode.E_TIMEOUT, '请求超时: content.delete (x)')
    )

    const result = await run({ paths: ['/Game/A.A'] })

    expect(result.success).toBe(false)
    expect(result.code).toBe(V2_TIMEOUT_CODE)
    expect(String(result.error)).toContain('不要重发')
    expect(String(result.error)).toContain('ue_content_search')
  })
})

describe('说明', () => {
  it('不再让模型「逐个删」', () => {
    const text = tool.description + JSON.stringify(tool.inputSchema)
    expect(text).not.toContain('逐个删')
    expect(tool.description).toContain('delete_asset')
  })
})
