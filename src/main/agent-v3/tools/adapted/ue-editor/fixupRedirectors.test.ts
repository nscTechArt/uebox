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
      broken_left: 0,
      // fixed 不含删掉的断链：3 个里修了 2 个、删了 1 个，加起来才是 3
      fixed: 2,
      remaining: 0,
      deleted_broken: 1,
      dry_run: false,
      dirty_after: 2,
      redirectors: []
    })

    const result = await run({ delete_broken: true })

    expect(callRequest.mock.calls[0][1]).toEqual({ delete_broken: true })
    expect(result.deleted_broken).toBe(1)
    expect(String(result.summary)).toContain('2/3')
    expect(String(result.summary)).toContain('删除断链的 1 个')
    expect(String(result.summary)).not.toContain('原地未动')
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
  it('预演带出 checkout，摘要点名被谁签出、对应的那几条会留在原地', async () => {
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
    // 这条命令没有闸：引擎逐条处理，动不了的那几条留在原地，其余照清
    expect(summary).toContain('对应的那几条重定向器会留在原地')
    expect(summary).not.toContain('整批都不会动')
    expect(summary).not.toContain('on_blocked')
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
      // ≤5.3 的 FixupReferencers 把失败原因写进 FMessageLog("EditorErrors")，镜像到日志的类别就是它
      engine_log: [
        '[EditorErrors] Warning: /Game/Old/SM_A - Referencing package /Game/Maps/Main was not checked out'
      ]
    })
    const result = await run({})
    expect(result.engine_log).toEqual([
      '[EditorErrors] Warning: /Game/Old/SM_A - Referencing package /Game/Maps/Main was not checked out'
    ])
  })
})

describe('ue_fixup_redirectors：失败与超时', () => {
  it('插件 409 拒绝时把 details（how_to）和错误码一起带给模型', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: 'Refusing to fix up redirectors: ...',
      code: 409,
      details: { found: 3, how_to: "right-click the folder and pick 'Fix Up Redirectors'" }
    })
    const result = await run({})
    expect(result.success).toBe(false)
    expect(result.code).toBe(409)
    expect(result.details).toEqual({
      found: 3,
      how_to: "right-click the folder and pick 'Fix Up Redirectors'"
    })
  })

  it('RPC 超时保住超时码，不报成确定失败', async () => {
    const { WebSocketServiceError, WebSocketErrorCode } = await import(
      '../../../../services/websocket/types'
    )
    callRequest.mockRejectedValue(
      new WebSocketServiceError(WebSocketErrorCode.E_TIMEOUT, '请求超时: content.fixup_redirectors')
    )
    const result = await run({})
    expect(result.success).toBe(false)
    expect(result.code).toBeDefined()
  })

  it('中止信号跟着 RPC 一起下去', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: '/Game',
      found: 0,
      fixed: 0,
      dry_run: true,
      redirectors: []
    })
    const controller = new AbortController()
    await (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(
      { dry_run: true },
      { abortSignal: controller.signal }
    )
    expect(callRequest.mock.calls[0][4]).toBe(controller.signal)
  })

  it('执行后按 broken_left 说「原地未动」，listed_note 与 load_failed 进摘要', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: '/Game',
      found: 300,
      broken_count: 2,
      broken_left: 1,
      fixed: 296,
      remaining: 4,
      deleted_broken: 1,
      dry_run: false,
      redirectors: [],
      listed_note: 'Listing 200 of 300.',
      load_failed: ['/Game/Old/SM_Corrupt', '/Game/Old/SM_Corrupt2']
    })
    const result = await run({ delete_broken: true })
    const summary = String(result.summary)
    expect(summary).toContain('296/300')
    expect(summary).toContain('删除断链的 1 个')
    expect(summary).toContain('1 个断链的原地未动')
    expect(summary).toContain('2 个加载失败没处理')
    expect(summary).toContain('Listing 200 of 300.')
    expect(result.load_failed).toHaveLength(2)
  })

  it('引用者有未保存改动时预演就点名', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: '/Game',
      found: 1,
      fixed: 0,
      dry_run: true,
      redirectors: ['/Game/Old/SM_A'],
      dirty_referencers: ['/Game/Maps/Main']
    })
    const result = await run({ dry_run: true })
    expect(String(result.summary)).toContain('/Game/Maps/Main')
    expect(String(result.summary)).toContain('未保存的改动')
  })

  it('paths 里的空串不放行', async () => {
    const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ paths: [''] }).success).toBe(false)
  })
})
