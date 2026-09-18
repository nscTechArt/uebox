/**
 * @vitest-environment node
 *
 * ue_fixup_redirectors 这一轮加的两样：只清指定的几个（paths）、认出断链的
 * 重定向器并按 delete_broken 决定删不删。基础用例在 editorLifecycle.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1',
  setTargetConnectionId: () => true
}))
vi.mock('../../../../services/project', () => ({
  projectManager: { getProject: () => undefined, getConnectionIdByPath: () => undefined }
}))

import { createFixupRedirectorsTool } from './editorLifecycle'

const tool = createFixupRedirectorsTool()
const run = (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('ue_fixup_redirectors：指定路径与断链', () => {
  it('paths 原样透传，空数组不传', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: '(paths)',
      found: 0,
      fixed: 0,
      dry_run: true,
      redirectors: []
    })

    await run({ paths: ['/Game/Old/SM_A', '/Game/Old/'], dry_run: true })
    expect(callRequest.mock.calls[0][1]).toEqual({
      paths: ['/Game/Old/SM_A', '/Game/Old/'],
      dry_run: true
    })

    callRequest.mockClear()
    await run({ paths: [], dry_run: true })
    expect('paths' in (callRequest.mock.calls[0][1] as Record<string, unknown>)).toBe(false)
  })

  it('预演时把每条指向哪、哪些断了带回去，并在摘要里点出断链数', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: '/Game',
      found: 2,
      broken_count: 1,
      fixed: 0,
      dry_run: true,
      redirectors: ['/Game/Old/SM_A', '/Game/Old/SM_B'],
      details: [
        { path: '/Game/Old/SM_A', target: '/Game/New/SM_A.SM_A' },
        { path: '/Game/Old/SM_B', broken: true }
      ]
    })

    const result = await run({ dry_run: true })

    expect(result.broken_count).toBe(1)
    expect(result.details).toHaveLength(2)
    expect(String(result.summary)).toContain('其中 1 个已断链')
    expect(String(result.summary)).toContain('没有改动')
  })

  it('delete_broken 透传，删了多少要报出来', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: '/Game',
      found: 3,
      broken_count: 1,
      fixed: 3,
      remaining: 0,
      deleted_broken: 1,
      dry_run: false,
      dirty_after: 2,
      redirectors: []
    })

    const result = await run({ delete_broken: true })

    expect(callRequest.mock.calls[0][1]).toEqual({ delete_broken: true })
    expect(result.deleted_broken).toBe(1)
    expect(String(result.summary)).toContain('删除断链的 1 个')
    expect(String(result.summary)).toContain('2 个包待保存')
  })

  it('没开 delete_broken 时，断链的原地未动要说清楚', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: '/Game',
      found: 3,
      broken_count: 1,
      fixed: 2,
      remaining: 1,
      deleted_broken: 0,
      dry_run: false,
      redirectors: []
    })

    const result = await run({})

    expect(String(result.summary)).toContain('2/3')
    expect(String(result.summary)).toContain('1 个断链的原地未动')
  })
})

// 安全网 §2.3：引用者被别人签出着，FixupReferencers 改不了它。预演就要点名到文件和人
describe('ue_fixup_redirectors：签出预检', () => {
  it('预演带出 checkout，摘要点名被谁签出、执行时整批不会动', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: '/Game',
      found: 1,
      fixed: 0,
      dry_run: true,
      redirectors: ['/Game/Old/SM_A'],
      checkout: {
        scc_enabled: true,
        scc_provider: 'Perforce',
        scc_available: true,
        checked: 3,
        blocked: 1,
        blocking: [
          {
            package: '/Game/Maps/Main',
            state: 'checked_out_other',
            checked_out_by: 'lisi',
            blocks: true,
            role: 'referencer',
            for: ['/Game/Old/SM_A']
          }
        ]
      }
    })

    const result = await run({ dry_run: true })
    expect(result.checkout).toBeDefined()
    const summary = result.summary as string
    expect(summary).toContain('/Game/Maps/Main')
    expect(summary).toContain('lisi')
    expect(summary).toContain('执行时整批都不会动')
  })

  it('执行后把引擎日志带回去', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: '/Game',
      found: 1,
      fixed: 0,
      remaining: 1,
      dry_run: false,
      redirectors: ['/Game/Old/SM_A'],
      engine_log: [
        '[LogAssetTools] Warning: package /Game/Maps/Main is already checked out by someone'
      ]
    })
    const result = await run({})
    expect(result.engine_log).toEqual([
      '[LogAssetTools] Warning: package /Game/Maps/Main is already checked out by someone'
    ])
  })
})
