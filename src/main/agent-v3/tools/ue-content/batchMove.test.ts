/**
 * @vitest-environment node
 *
 * 批量移动。守三件事：
 *   1. 分批 —— 每批只带自己那份 moves，批数对得上，进度有上报
 *   2. 全有或全无 —— on_conflict=fail 且多批时先全预演，任何冲突都一个不动
 *   3. 本地查重 —— 两个源搬到同一个名字、同一个源出现两次，不发给引擎
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
// 默认没绑工程：盒子侧的文本扫描和账本都走「没工程」分支，不碰磁盘。
// 要测那两条路的用例自己把 projectPath 换成有值的。
const projectPath = vi.fn<() => string | undefined>(() => undefined)
vi.mock('../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1',
  getTargetProjectPath: () => projectPath()
}))
const scanProjectPathRefs = vi.fn()
vi.mock('./projectPathRefs', () => ({
  buildTargets: (input: unknown) => input,
  resolveProjectDir: (p: string) => p,
  scanProjectPathRefs: (...args: unknown[]) => scanProjectPathRefs(...args)
}))
const recordMoveLedger = vi.fn()
const finalizeLedger = vi.fn()
vi.mock('./ledger', () => ({
  entriesFromItems: (items: { status: string }[]) => items.filter((i) => i.status === 'moved'),
  recordMoveLedger: (...args: unknown[]) => recordMoveLedger(...args),
  finalizeLedger: (...args: unknown[]) => finalizeLedger(...args)
}))

import { WebSocketErrorCode, WebSocketServiceError } from '../../../services/websocket/types'
import { batchMoveTool, chunk, findLocalDuplicates } from './batchMove'
import type { BatchMoveResponse } from './types'

const noHits = { hits: [], scanned_files: 3, skipped_files: 0, truncated: false, note: '候选清单' }

function ok(partial: Partial<BatchMoveResponse> = {}): BatchMoveResponse {
  return {
    ok: true,
    dry_run: false,
    planned: 1,
    moved: 1,
    skipped: 0,
    errors: 0,
    failed: 0,
    conflicts: [],
    on_conflict: 'fail',
    items: [{ source: '/Game/A', destination: '/Game/B/A', referencers: 0, status: 'moved' }],
    redirectors_found: 1,
    redirectors_fixed: 1,
    saved_count: 2,
    dirty_after: 0,
    elapsed_ms: 10,
    notes: [],
    ...partial
  }
}

const sentParams = (i: number): Record<string, unknown> =>
  callRequest.mock.calls[i][1] as Record<string, unknown>

const text = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => ('text' in c ? c.text : '')).join('')

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
  projectPath.mockReset().mockReturnValue(undefined)
  scanProjectPathRefs.mockReset().mockResolvedValue(noHits)
  recordMoveLedger.mockReset().mockResolvedValue({ id: '2026-09-03T14-22-08-move-ab12' })
  finalizeLedger.mockReset().mockResolvedValue({ id: '2026-09-03T14-22-08-move-ab12' })
})

describe('本地查重', () => {
  it('两个源搬到同一个目标', () => {
    expect(
      findLocalDuplicates([
        { source: '/Game/A', destination: '/Game/X/Same' },
        { source: '/Game/B', destination: '/Game/X/Same' }
      ])
    ).toHaveLength(1)
  })

  it('目录形式的目标按源资产名展开后再比', () => {
    expect(
      findLocalDuplicates([
        { source: '/Game/A/Rock', destination: '/Game/X/' },
        { source: '/Game/B/Rock', destination: '/Game/X/Rock' }
      ])
    ).toHaveLength(1)
  })

  it('同一个源出现两次', () => {
    expect(
      findLocalDuplicates([
        { source: '/Game/A', destination: '/Game/X/A1' },
        { source: '/Game/A.A', destination: '/Game/X/A2' }
      ])
    ).toHaveLength(1)
  })

  it('正常的一批不报', () => {
    expect(
      findLocalDuplicates([
        { source: '/Game/A', destination: '/Game/X/A' },
        { source: '/Game/B', destination: '/Game/X/B' }
      ])
    ).toHaveLength(0)
  })

  it('chunk 切得整齐', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
})

describe('ue_content_move', () => {
  it('是 mutating、串行、名字沿用旧工具', () => {
    expect(batchMoveTool.name).toBe('ue_content_move')
    expect(batchMoveTool.unrealBox.risk).toBe('mutating')
    expect(batchMoveTool.unrealBox.namespace).toBe('ue.content')
  })

  it('一对路径也走 batch_move，默认值不传、三个 on_* 明确传 fail', async () => {
    callRequest.mockResolvedValueOnce(ok())
    await batchMoveTool.execute('c1', {
      moves: [{ source: '/Game/A', destination: '/Game/B/A' }]
    })
    expect(callRequest).toHaveBeenCalledTimes(1)
    expect(callRequest.mock.calls[0][0]).toBe('content.batch_move')
    expect(sentParams(0)).toEqual({
      on_conflict: 'fail',
      on_blocked: 'fail',
      on_cdo_refs: 'fail',
      moves: [{ source: '/Game/A', destination: '/Game/B/A' }],
      dry_run: false
    })
  })

  it('什么都没给直接报错，不打引擎', async () => {
    await expect(batchMoveTool.execute('c1', {})).rejects.toThrow('至少要给一个')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('本地查出冲突就一个都不发', async () => {
    await expect(
      batchMoveTool.execute('c1', {
        moves: [
          { source: '/Game/A', destination: '/Game/X/Same' },
          { source: '/Game/B', destination: '/Game/X/Same' }
        ]
      })
    ).rejects.toThrow('互相冲突')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('按 batch_size 分批，每批只带自己那份，并上报进度', async () => {
    callRequest.mockResolvedValue(ok())
    const onUpdate = vi.fn()
    const moves = [1, 2, 3].map((i) => ({ source: `/Game/A${i}`, destination: `/Game/B/A${i}` }))

    const result = await batchMoveTool.execute(
      'c1',
      // 闸放行，这条只看分批本身（多批 + 任一闸是 fail 会先预演一遍，见「三道闸」）
      { moves, batch_size: 2, on_conflict: 'skip', on_blocked: 'proceed', on_cdo_refs: 'proceed' },
      undefined,
      onUpdate
    )

    expect(callRequest).toHaveBeenCalledTimes(2)
    expect((sentParams(0).moves as unknown[]).length).toBe(2)
    expect((sentParams(1).moves as unknown[]).length).toBe(1)
    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(text(result)).toContain('已移动 2/2')
    expect(text(result)).toContain('分 2 批')
  })

  it('on_conflict=fail 且多批：先全预演，有冲突就一个都不动', async () => {
    callRequest.mockResolvedValueOnce(ok({ dry_run: true, moved: 0 })).mockResolvedValueOnce(
      ok({
        dry_run: true,
        moved: 0,
        conflicts: [{ source: '/Game/A2', destination: '/Game/B/A2' }]
      })
    )
    const moves = [1, 2].map((i) => ({ source: `/Game/A${i}`, destination: `/Game/B/A${i}` }))

    await expect(batchMoveTool.execute('c1', { moves, batch_size: 1 })).rejects.toThrow(
      '整批没有移动'
    )

    // 两次预演之后没有任何一次真的搬
    expect(callRequest).toHaveBeenCalledTimes(2)
    expect(sentParams(0).dry_run).toBe(true)
    expect(sentParams(1).dry_run).toBe(true)
  })

  it('on_conflict=fail 且多批：预演干净才真搬', async () => {
    callRequest
      .mockResolvedValueOnce(ok({ dry_run: true, moved: 0 }))
      .mockResolvedValueOnce(ok({ dry_run: true, moved: 0 }))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
    const moves = [1, 2].map((i) => ({ source: `/Game/A${i}`, destination: `/Game/B/A${i}` }))

    const result = await batchMoveTool.execute('c1', { moves, batch_size: 1 })

    expect(callRequest).toHaveBeenCalledTimes(4)
    expect(sentParams(2).dry_run).toBe(false)
    expect(text(result)).toContain('已移动 2/2')
  })

  it('folder_moves 单独一次调用，超时更长', async () => {
    callRequest.mockResolvedValueOnce(ok({ planned: 40, moved: 40 }))
    await batchMoveTool.execute('c1', {
      folder_moves: [{ source_folder: '/Game/Temp', destination_folder: '/Game/Props' }]
    })
    expect(callRequest).toHaveBeenCalledTimes(1)
    expect(sentParams(0).folder_moves).toEqual([
      { source_folder: '/Game/Temp', destination_folder: '/Game/Props' }
    ])
    expect(callRequest.mock.calls[0][3]).toBe(30 * 60 * 1000)
  })

  it('预演的摘要明说没有改动，并列出被引用的资产数', async () => {
    callRequest.mockResolvedValueOnce(
      ok({
        dry_run: true,
        moved: 0,
        items: [{ source: '/Game/A', destination: '/Game/B/A', referencers: 3, status: 'planned' }]
      })
    )
    const result = await batchMoveTool.execute('c1', {
      moves: [{ source: '/Game/A', destination: '/Game/B/A' }],
      dry_run: true
    })
    expect(text(result)).toContain('预演，没有改动')
    expect(text(result)).toContain('1 个资产被其他资产引用')
  })

  it('一批里有一条失败：不抛、如实报，引擎日志带出来，成功的那条照记账本', async () => {
    projectPath.mockReturnValue('D:/P/P.uproject')
    callRequest.mockResolvedValueOnce(
      ok({
        ok: false,
        planned: 2,
        moved: 1,
        failed: 1,
        items: [
          { source: '/Game/A', destination: '/Game/B/A', referencers: 0, status: 'moved' },
          {
            source: '/Game/C',
            destination: '/Game/B/C',
            referencers: 2,
            status: 'failed',
            error: 'Not checked-out or writable.'
          }
        ],
        engine_log: ['[LogAssetTools] Error: /Game/C - Not checked-out or writable.']
      })
    )

    const result = await batchMoveTool.execute('c1', {
      moves: [
        { source: '/Game/A', destination: '/Game/B/A' },
        { source: '/Game/C', destination: '/Game/B/C' }
      ]
    })

    expect(text(result)).toContain('已移动 1/2')
    expect(text(result)).toContain('Not checked-out or writable')
    expect(text(result)).toContain('引擎日志')
    expect(text(result)).toContain('账本已记')

    // 账本分两步：发出去之前先落一份 pending（记下打算搬什么），
    // 引擎回话之后再补上逐条结果。中途崩掉时留下的就是那份 pending。
    expect(recordMoveLedger).toHaveBeenCalledTimes(1)
    expect(recordMoveLedger.mock.calls[0][0]).toMatchObject({
      projectPath: 'D:/P/P.uproject',
      tool: 'ue_content_move',
      saved: true,
      status: 'pending',
      planned: [
        { from: '/Game/A', to: '/Game/B/A' },
        { from: '/Game/C', to: '/Game/B/C' }
      ]
    })
    expect(finalizeLedger).toHaveBeenCalledTimes(1)
    expect(finalizeLedger.mock.calls[0][2]).toMatchObject({
      status: 'done',
      entries: [expect.objectContaining({ source: '/Game/A' })]
    })
  })

  /**
   * 引擎在执行途中把编辑器搞崩：RPC 抛异常，结果**未知**。
   * 真机三次崩溃里改名其实都已经做完了，所以这里既不能报成功也不能报失败，
   * 必须留下账本 + 告诉模型去核对，而不是让它原样重试。
   */
  it('执行中连接断了：账本标成 interrupted，错误里给出核对的下一步', async () => {
    projectPath.mockReturnValue('D:/P/P.uproject')
    callRequest.mockRejectedValueOnce(
      new WebSocketServiceError(
        WebSocketErrorCode.E_CONNECTION_CLOSED,
        '引擎在执行 content.batch_move 的过程中断开了连接'
      )
    )

    await expect(
      batchMoveTool.execute('c1', { moves: [{ source: '/Game/A', destination: '/Game/B/A' }] })
    ).rejects.toThrow(/action=verify/)

    expect(finalizeLedger).toHaveBeenCalledTimes(1)
    expect(finalizeLedger.mock.calls[0][2]).toMatchObject({ status: 'interrupted' })
  })

  it('中断时不把结果说死 —— 不报「没搬」也不报「搬完了」', async () => {
    projectPath.mockReturnValue('D:/P/P.uproject')
    callRequest.mockRejectedValueOnce(
      new WebSocketServiceError(WebSocketErrorCode.E_TIMEOUT, '请求超时')
    )

    const error = await batchMoveTool
      .execute('c1', { moves: [{ source: '/Game/A', destination: '/Game/B/A' }] })
      .catch((e: Error) => e)

    expect(String(error)).toContain('未知')
    expect(String(error)).toContain('2026-09-03T14-22-08-move-ab12')
  })

  /**
   * 「命令压根没发出去」和「发出去了结果不知道」是两回事。
   * 等注册表超时、没连引擎抛的都是普通 Error，底层那句话已经明说「命令没有发出」——
   * 再套一层「结果未知、去 verify」等于当面否掉一句确定的事实，
   * 还会在账本目录里留一份假的「中断」记录。
   */
  it('命令没发出去时原样抛，不谎报「结果未知」，也不留假的中断账本', async () => {
    projectPath.mockReturnValue('D:/P/P.uproject')
    callRequest.mockRejectedValueOnce(new Error('已取消：引擎仍在扫描资产，命令没有发出。'))

    const error = await batchMoveTool
      .execute('c1', { moves: [{ source: '/Game/A', destination: '/Game/B/A' }] })
      .catch((e: Error) => e)

    expect(String(error)).toContain('命令没有发出')
    expect(String(error)).not.toContain('action=verify')
    expect(finalizeLedger.mock.calls[0][2]).toMatchObject({ status: 'done', entries: [] })
  })

  it('用户按停止时说清是他按的，但仍然要核对（那一批已经发出去了）', async () => {
    projectPath.mockReturnValue('D:/P/P.uproject')
    callRequest.mockRejectedValueOnce(
      new WebSocketServiceError(WebSocketErrorCode.E_ABORTED, '调用方已停止等待')
    )

    const error = await batchMoveTool
      .execute('c1', { moves: [{ source: '/Game/A', destination: '/Game/B/A' }] })
      .catch((e: Error) => e)

    expect(String(error)).toContain('你按了停止')
    expect(String(error)).toContain('action=verify')
  })

  it('引擎说搬了但一个都没到位 → 报失败，不报成功', async () => {
    callRequest.mockResolvedValueOnce(
      ok({
        ok: false,
        moved: 0,
        failed: 1,
        items: [
          {
            source: '/Game/A',
            destination: '/Game/B/A',
            referencers: 0,
            status: 'failed',
            error: 'x'
          }
        ]
      })
    )
    await expect(
      batchMoveTool.execute('c1', { moves: [{ source: '/Game/A', destination: '/Game/B/A' }] })
    ).rejects.toThrow()
  })
})

// 三道闸：签出预检和 CDO 引用在插件里守，这里只看「透传参数、讲清原因、多批全有或全无」；
// 工程文本引用在盒子侧守，这里要看它真的拦、真的放。
describe('三道闸', () => {
  const blocked = (): BatchMoveResponse =>
    ok({
      ok: false,
      moved: 0,
      reason: 'checkout_blocked',
      items: [{ source: '/Game/A', destination: '/Game/B/A', referencers: 1, status: 'planned' }],
      checkout: {
        scc_enabled: true,
        scc_provider: 'Perforce',
        scc_available: true,
        checked: 2,
        blocked: 1,
        blocking: [
          {
            package: '/Game/Maps/Main',
            filename: 'D:/P/Content/Maps/Main.umap',
            state: 'checked_out_other',
            checked_out_by: 'zhangsan',
            blocks: true,
            role: 'referencer',
            for: ['/Game/A']
          }
        ]
      }
    })

  it('on_blocked / on_cdo_refs 默认 fail 且原样透传给插件', async () => {
    callRequest.mockResolvedValueOnce(ok())
    await batchMoveTool.execute('c1', {
      moves: [{ source: '/Game/A', destination: '/Game/B/A' }],
      on_cdo_refs: 'proceed'
    })
    expect(sentParams(0)).toMatchObject({ on_blocked: 'fail', on_cdo_refs: 'proceed' })
  })

  it('插件被签出预检拦下：报失败，点名文件和签出的人，说明整批没动', async () => {
    callRequest.mockResolvedValueOnce(blocked())
    const error = await batchMoveTool
      .execute('c1', { moves: [{ source: '/Game/A', destination: '/Game/B/A' }] })
      .catch((e: Error) => e)

    const msg = (error as Error).message
    expect(msg).toContain('整批没有移动')
    expect(msg).toContain('/Game/Maps/Main')
    expect(msg).toContain('zhangsan')
    expect(msg).toContain('它引用了 /Game/A')
    expect(recordMoveLedger).not.toHaveBeenCalled()
  })

  it('多批：预演时第二批有 CDO 引用，一批都不真搬', async () => {
    callRequest.mockResolvedValueOnce(ok({ dry_run: true, moved: 0 })).mockResolvedValueOnce(
      ok({
        dry_run: true,
        moved: 0,
        cdo_refs: {
          checked: 1200,
          hits: [
            {
              asset: '/Game/A2',
              class: 'ATP_GameMode',
              property: 'DefaultPawnClass',
              kind: 'hard'
            }
          ]
        }
      })
    )
    const moves = [1, 2].map((i) => ({ source: `/Game/A${i}`, destination: `/Game/B/A${i}` }))

    const error = await batchMoveTool
      .execute('c1', { moves, batch_size: 1, on_conflict: 'skip' })
      .catch((e: Error) => e)

    expect((error as Error).message).toContain('C++ 类')
    expect((error as Error).message).toContain('ATP_GameMode::DefaultPawnClass')
    expect(callRequest).toHaveBeenCalledTimes(2)
    expect(sentParams(0).dry_run).toBe(true)
    expect(sentParams(1).dry_run).toBe(true)
  })

  it('多批：闸都是 proceed 时不预演，直接搬', async () => {
    callRequest.mockResolvedValue(ok())
    const moves = [1, 2].map((i) => ({ source: `/Game/A${i}`, destination: `/Game/B/A${i}` }))
    await batchMoveTool.execute('c1', {
      moves,
      batch_size: 1,
      on_conflict: 'skip',
      on_blocked: 'proceed',
      on_cdo_refs: 'proceed'
    })
    expect(callRequest).toHaveBeenCalledTimes(2)
    expect(sentParams(0).dry_run).toBe(false)
  })

  it('预演时闸的结果只是提醒，不算失败', async () => {
    callRequest.mockResolvedValueOnce({ ...blocked(), dry_run: true, reason: undefined })
    const result = await batchMoveTool.execute('c1', {
      moves: [{ source: '/Game/A', destination: '/Game/B/A' }],
      dry_run: true
    })
    expect(text(result)).toContain('预演，没有改动')
    expect(text(result)).toContain('zhangsan')
    expect(text(result)).toContain('整批都不会动')
  })

  describe('工程文本引用（盒子侧）', () => {
    const hit = {
      file: 'Source/P/PGameMode.cpp',
      line: 10,
      text: 'x',
      token: '/Game/A',
      package: '/Game/A',
      target: '/Game/A',
      kind: 'exact',
      suggested_token: '/Game/B/A'
    }

    it('没绑工程：扫描不跑，摘要如实说，不当成「没有引用」', async () => {
      callRequest.mockResolvedValueOnce(ok())
      const result = await batchMoveTool.execute('c1', {
        moves: [{ source: '/Game/A', destination: '/Game/B/A' }]
      })
      expect(scanProjectPathRefs).not.toHaveBeenCalled()
      expect(text(result)).toContain('工程文本扫描没跑')
    })

    it('有命中且默认 fail：不打引擎，列出文件行号和建议改法', async () => {
      projectPath.mockReturnValue('D:/P/P.uproject')
      scanProjectPathRefs.mockResolvedValue({ ...noHits, hits: [hit] })

      const error = await batchMoveTool
        .execute('c1', { moves: [{ source: '/Game/A', destination: '/Game/B/A' }] })
        .catch((e: Error) => e)

      expect(callRequest).not.toHaveBeenCalled()
      const msg = (error as Error).message
      expect(msg).toContain('工程文本')
      expect(msg).toContain('Source/P/PGameMode.cpp:10')
      expect(msg).toContain('建议改成 /Game/B/A')
      expect(msg).toContain('不代改源码')
    })

    it('on_external_refs=proceed：照搬，摘要里仍然提醒', async () => {
      projectPath.mockReturnValue('D:/P/P.uproject')
      scanProjectPathRefs.mockResolvedValue({ ...noHits, hits: [hit] })
      callRequest.mockResolvedValueOnce(ok())

      const result = await batchMoveTool.execute('c1', {
        moves: [{ source: '/Game/A', destination: '/Game/B/A' }],
        on_external_refs: 'proceed'
      })

      expect(callRequest).toHaveBeenCalledTimes(1)
      expect(text(result)).toContain('已移动 1/1')
      expect(text(result)).toContain('Source/P/PGameMode.cpp:10')
    })

    it('预演：有命中也只是提醒', async () => {
      projectPath.mockReturnValue('D:/P/P.uproject')
      scanProjectPathRefs.mockResolvedValue({ ...noHits, hits: [hit] })
      callRequest.mockResolvedValueOnce(ok({ dry_run: true, moved: 0 }))

      const result = await batchMoveTool.execute('c1', {
        moves: [{ source: '/Game/A', destination: '/Game/B/A' }],
        dry_run: true
      })

      expect(text(result)).toContain('预演，没有改动')
      expect(text(result)).toContain('搬走会断')
    })

    it('扫描本身抛了：不拦、不装作没引用', async () => {
      projectPath.mockReturnValue('D:/P/P.uproject')
      scanProjectPathRefs.mockRejectedValue(new Error('EACCES'))
      callRequest.mockResolvedValueOnce(ok())

      const result = await batchMoveTool.execute('c1', {
        moves: [{ source: '/Game/A', destination: '/Game/B/A' }]
      })
      expect(text(result)).toContain('工程文本扫描没跑：EACCES')
    })
  })

  it('账本写不进去：搬迁照样算成功，但说明不能回滚', async () => {
    projectPath.mockReturnValue('D:/P/P.uproject')
    recordMoveLedger.mockRejectedValue(new Error('EPERM'))
    callRequest.mockResolvedValueOnce(ok())

    const result = await batchMoveTool.execute('c1', {
      moves: [{ source: '/Game/A', destination: '/Game/B/A' }]
    })
    expect(text(result)).toContain('已移动 1/1')
    expect(text(result)).toContain('账本没写成')
    expect(text(result)).toContain('EPERM')
  })

  it('预演不记账本', async () => {
    projectPath.mockReturnValue('D:/P/P.uproject')
    callRequest.mockResolvedValueOnce(ok({ dry_run: true, moved: 0 }))
    await batchMoveTool.execute('c1', {
      moves: [{ source: '/Game/A', destination: '/Game/B/A' }],
      dry_run: true
    })
    expect(recordMoveLedger).not.toHaveBeenCalled()
  })

  it('替用户回答过的弹窗全部列出来', async () => {
    callRequest.mockResolvedValueOnce(
      ok({
        auto_answered_dialogs: [
          {
            type: 'OkCancel',
            title: 'Message',
            message: 'Source code ... Continue with rename?',
            answer: 'Ok'
          }
        ]
      })
    )
    const result = await batchMoveTool.execute('c1', {
      moves: [{ source: '/Game/A', destination: '/Game/B/A' }],
      on_cdo_refs: 'proceed'
    })
    expect(text(result)).toContain('替你回答了 1 个引擎弹窗')
    expect(text(result)).toContain('Continue with rename')
  })
})
