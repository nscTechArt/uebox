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
import { acquire, releaseAll, runWithLockOwner } from '../../../core/assetLock'
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
const run = (
  input: Record<string, unknown>,
  options: { abortSignal?: AbortSignal } = {}
): Promise<Result> => (tool.execute as (i: unknown, o: unknown) => Promise<Result>)(input, options)

const callsTo = (method: string): unknown[][] =>
  callRequest.mock.calls.filter((call) => call[0] === method)

/** 展开目录用的那种搜索（query='*'），不含「是不是同名资产」那次追问 */
const expandSearches = (): unknown[][] =>
  callsTo('content.search').filter((call) => (call[1] as { query?: string }).query === '*')

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

  // content.search 不等注册表，扫到一半回的是半份清单；照着删就是「删完了」却还剩一半
  it('注册表还在扫时不展开、不删', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'content.registry_status') {
        return { ok: true, ready: false, progress: { total: 900, processed: 300 } }
      }
      return { ok: true, count: 1, total: 1, truncated: false, results: [] }
    })

    const result = await run({ paths: ['/Game/ThirdParty/AnimeGirl/'] })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('300/900')
    expect(callsTo('content.search')).toHaveLength(0)
    expect(callsTo('content.delete')).toHaveLength(0)
  })

  it('只点名资产、不展开目录时不问注册表', async () => {
    callRequest.mockImplementation(async () => DELETED_OK(['/Game/Temp/A.A']))

    await run({ paths: ['/Game/Temp/A.A'] })

    expect(callsTo('content.registry_status')).toHaveLength(0)
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

    expect(expandSearches()).toHaveLength(1)
    expect(expandSearches()[0][1]).toMatchObject({ path: '/Game/Pack' })
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

describe('展开之后、删除之前', () => {
  const folderWith =
    (results: Array<Record<string, string>>) =>
    async (method: string, params: { query?: string }): Promise<Result> => {
      if (method === 'content.search') {
        if (params.query !== '*') return { ok: true, count: 0, total: 0, results: [] }
        return { ok: true, count: results.length, total: results.length, truncated: false, results }
      }
      return DELETED_OK([])
    }

  it('同名的关卡和目录并存：分不清就不删，让调用方写清楚', async () => {
    callRequest.mockImplementation(async (method: string, params: { query?: string }) => {
      if (method !== 'content.search') throw new Error('不该走到删除')
      if (params.query === '*') {
        return {
          ok: true,
          count: 1,
          total: 1,
          truncated: false,
          results: [{ name: 'Sub', path: '/Game/Maps/Main/Sub', class: 'World' }]
        }
      }
      return {
        ok: true,
        count: 2,
        total: 2,
        truncated: false,
        results: [
          { name: 'Main', path: '/Game/Maps/Main', class: 'World' },
          { name: 'Sub', path: '/Game/Maps/Main/Sub', class: 'World' }
        ]
      }
    })

    const result = await run({ paths: ['/Game/Maps/Main'] })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('/Game/Maps/Main.Main')
    expect(String(result.error)).toContain('/Game/Maps/Main/')
    expect(callsTo('content.delete')).toHaveLength(0)
  })

  it('结尾带斜杠就是明说了目录，不再追问', async () => {
    callRequest.mockImplementation(
      folderWith([{ name: 'Sub', path: '/Game/Maps/Main/Sub', class: 'World' }])
    )

    await run({ paths: ['/Game/Maps/Main/'] })

    expect(callsTo('content.search')).toHaveLength(1)
    expect((callsTo('content.delete')[0][1] as { paths: string[] }).paths).toEqual([
      '/Game/Maps/Main/Sub.Sub'
    ])
  })

  it('目录里的重定向器不跟着删，回报出来并指向 ue_fixup_redirectors', async () => {
    callRequest.mockImplementation(
      folderWith([
        { name: 'A', path: '/Game/Old/A', class: 'Texture2D' },
        { name: 'Moved', path: '/Game/Old/Moved', class: 'ObjectRedirector' }
      ])
    )

    const result = await run({ paths: ['/Game/Old/'] })

    expect((callsTo('content.delete')[0][1] as { paths: string[] }).paths).toEqual([
      '/Game/Old/A.A'
    ])
    expect(result.skipped_redirectors).toEqual(['/Game/Old/Moved.Moved'])
    expect(String(result.message)).toContain('ue_fixup_redirectors')
  })

  it('另一条会话锁着目录里的资产：不撤它的保护、不删', async () => {
    callRequest.mockImplementation(
      folderWith([{ name: 'A', path: '/Game/Shared/A', class: 'Material' }])
    )
    expect(acquire('conn-1', 'other-session', ['/Game/Shared/A']).ok).toBe(true)
    try {
      const result = await runWithLockOwner('this-session', () => run({ paths: ['/Game/Shared/'] }))

      expect(result.success).toBe(false)
      expect(String(result.error)).toContain('另一条 AI 会话')
      expect(releaseProtectionBeforeDelete).not.toHaveBeenCalled()
      expect(callsTo('content.delete')).toHaveLength(0)
    } finally {
      releaseAll('other-session')
    }
  })

  it('展开时用户按了停止：一个都不删', async () => {
    const controller = new AbortController()
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'content.search') {
        controller.abort()
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

    const result = await run({ paths: ['/Game/Dir/'] }, { abortSignal: controller.signal })

    expect(result.success).toBe(false)
    expect(releaseProtectionBeforeDelete).not.toHaveBeenCalled()
    expect(callsTo('content.delete')).toHaveLength(0)
    // 停止信号也交给了引擎请求，不在盒子这边等完再发
    expect(callsTo('content.search')[0][4]).toBe(controller.signal)
  })

  it('展开那一步超时：说清删除还没发，不说「引擎还在删」', async () => {
    callRequest.mockRejectedValue(
      new WebSocketServiceError(WebSocketErrorCode.E_TIMEOUT, '请求超时: content.search (x)')
    )

    const result = await run({ paths: ['/Game/Dir'] })

    expect(result.success).toBe(false)
    expect(result.code).toBeUndefined()
    expect(String(result.error)).toContain('什么都没删')
    expect(String(result.error)).not.toContain('还在删')
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

/**
 * AGENTS.md §5 第 14 条：删掉一部分时第一句不能是「已删除」。
 * 以前失败数拼在一长串后面（「已删除 2/3 个资产，1 个失败」），模型读到开头就收工。
 */
describe('部分失败', () => {
  it('第一句是部分完成，失败原因逐条跟上，failed_count 透出', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      deleted_count: 2,
      requested_count: 3,
      failed_count: 1,
      deleted: ['/Game/A.A', '/Game/B.B'],
      failed: [{ path: '/Game/C.C', reason: 'still referenced by: /Game/Maps/Main' }]
    })

    const result = await run({ paths: ['/Game/A.A', '/Game/B.B', '/Game/C.C'] })

    expect(result.success).toBe(true)
    expect(result.failed_count).toBe(1)
    const message = String(result.message)
    expect(message.split('\n')[0]).toMatch(/^⚠️ 部分完成：2 个资产成功 \/ 1 个资产失败/)
    expect(message).toContain('/Game/C.C：still referenced by: /Game/Maps/Main')
  })

  it('旧插件不回 failed_count 时按 failed 数组数', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      deleted_count: 1,
      requested_count: 2,
      deleted: ['/Game/A.A'],
      failed: [{ path: '/Game/B.B', reason: 'read-only on disk' }]
    })

    const result = await run({ paths: ['/Game/A.A', '/Game/B.B'] })

    expect(result.failed_count).toBe(1)
    expect(String(result.message).startsWith('⚠️ 部分完成')).toBe(true)
  })

  it('全删掉了照常说已删除，不多出失败字段', async () => {
    callRequest.mockResolvedValue({ ...DELETED_OK(['/Game/A.A']), failed_count: 0 })

    const result = await run({ paths: ['/Game/A.A'] })

    expect(String(result.message).startsWith('已删除 1/1')).toBe(true)
    expect('failed_count' in result).toBe(false)
  })
})
