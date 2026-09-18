/**
 * @vitest-environment node
 *
 * 回滚。守五件事：
 *   1. 反向 —— 发给引擎的 moves 是账本里 from / to 对调后的，preview 带 dry_run=true
 *   2. 指纹 —— 被改过的跳过并报出来，force 才带上；文件不在了永远跳过；没指纹默认跳过
 *   3. 闸 —— 引擎回 reason 时一个都不动，把挡在哪些文件上说出来
 *   4. 全有或全无 —— on_conflict=fail 且多批时先全预演
 *   5. 回滚也记账 —— apply 成功后写一份带 rollback_of 的新账本
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'organize-rollback-'))
const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)
const state = vi.hoisted(() => ({
  projectPath: 'D:\\Projects\\Demo\\Demo.uproject' as string | undefined
}))

vi.mock('electron', () => ({ app: { getPath: (): string => root } }))
vi.mock('../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1',
  getTargetProjectPath: () => state.projectPath
}))

import { checkEntries, rollbackTool, type RollbackDetails } from './rollback'
import { listLedgers, readLedger, recordMoveLedger, type LedgerEntry } from './ledger'
import type { BatchMoveItem, BatchMoveResponse } from './types'

const PROJECT = 'D:\\Projects\\Demo\\Demo.uproject'
const ASSETS = join(root, 'assets')

/** 造一个真实文件并按它的现状生成指纹 */
function asset(
  name: string,
  content = 'uasset-bytes'
): LedgerEntry['fingerprint'] & { file: string } {
  mkdirSync(ASSETS, { recursive: true })
  const file = join(ASSETS, `${name}.uasset`)
  writeFileSync(file, content)
  const st = statSync(file)
  return { file, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() }
}

function entry(from: string, to: string, fingerprint?: LedgerEntry['fingerprint']): LedgerEntry {
  return { from, to, status: 'moved', auto_renamed: false, ...(fingerprint ? { fingerprint } : {}) }
}

async function seedLedger(
  entries: LedgerEntry[],
  extra: { saved?: boolean; irreversible?: { kind: string; path: string; note: string }[] } = {}
): Promise<string> {
  const ledger = await recordMoveLedger({
    projectPath: PROJECT,
    tool: 'ue_content_move',
    args_summary: { on_conflict: 'fail', fixup_redirectors: true, save: true },
    saved: extra.saved ?? true,
    entries,
    ...(extra.irreversible ? { irreversible: extra.irreversible } : {})
  })
  return ledger.id
}

function movedItem(source: string, destination: string): BatchMoveItem {
  return {
    source,
    destination,
    referencers: 0,
    status: 'moved',
    file: join(ASSETS, 'back.uasset'),
    bytes: 1,
    mtime: '2026-09-03T00:00:00.000Z'
  }
}

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
    items: [movedItem('/Game/Props/SM_Rock', '/Game/Temp/rock')],
    redirectors_found: 1,
    redirectors_fixed: 1,
    saved_count: 2,
    dirty_after: 0,
    elapsed_ms: 10,
    notes: [],
    ...partial
  }
}

/** 引擎按发来的 moves 回一份「全搬成了」的响应 */
function echoMoved(): void {
  callRequest.mockImplementation(
    async (
      _m: string,
      params: { moves: { source: string; destination: string }[]; dry_run: boolean }
    ) =>
      ok({
        dry_run: params.dry_run,
        planned: params.moves.length,
        moved: params.dry_run ? 0 : params.moves.length,
        items: params.moves.map((mv) =>
          params.dry_run
            ? { source: mv.source, destination: mv.destination, referencers: 0, status: 'planned' }
            : movedItem(mv.source, mv.destination)
        )
      })
  )
}

const sentParams = (i: number): Record<string, unknown> =>
  callRequest.mock.calls[i][1] as Record<string, unknown>

const text = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => ('text' in c ? c.text : '')).join('')

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
  state.projectPath = PROJECT
  rmSync(join(root, 'organize-ledger'), { recursive: true, force: true })
  rmSync(ASSETS, { recursive: true, force: true })
})

describe('ue_content_rollback 元数据', () => {
  it('mutating、串行、在 ue.content 下', () => {
    expect(rollbackTool.name).toBe('ue_content_rollback')
    expect(rollbackTool.unrealBox.risk).toBe('mutating')
    expect(rollbackTool.unrealBox.namespace).toBe('ue.content')
    expect(rollbackTool.executionMode).toBe('sequential')
  })

  it('没绑工程直接报错，不碰引擎', async () => {
    state.projectPath = undefined
    await expect(rollbackTool.execute('c1', { action: 'list' })).rejects.toThrow('没有绑定工程')
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('list', () => {
  it('没有账本时说明账本是怎么来的', async () => {
    const result = await rollbackTool.execute('c1', { action: 'list' })
    expect(text(result)).toContain('还没有账本')
    expect((result.details as RollbackDetails).ledgers).toEqual([])
  })

  it('列出 id、条数、可回滚与否', async () => {
    const fp = asset('SM_Rock')
    const good = await seedLedger([entry('/Game/Temp/rock', '/Game/Props/SM_Rock', fp)])
    const unsaved = await seedLedger([entry('/Game/A', '/Game/B')], { saved: false })

    const result = await rollbackTool.execute('c1', { action: 'list' })
    const out = text(result)
    expect(out).toContain(good)
    expect(out).toContain(unsaved)
    expect(out).toContain('可回滚')
    expect(out).toContain('未落盘')
    expect((result.details as RollbackDetails).ledgers).toHaveLength(2)
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('preview / apply 的前置检查', () => {
  it('没给 id 报错', async () => {
    await expect(rollbackTool.execute('c1', { action: 'preview' })).rejects.toThrow('需要 id')
  })

  it('找不到的 id 和穿越的 id 都报找不到', async () => {
    await expect(rollbackTool.execute('c1', { action: 'apply', id: 'nope' })).rejects.toThrow(
      '找不到账本'
    )
    await expect(rollbackTool.execute('c1', { action: 'apply', id: '../x' })).rejects.toThrow(
      '找不到账本'
    )
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('save=false 的账本拒绝回滚并说明原因', async () => {
    const id = await seedLedger([entry('/Game/A', '/Game/B')], { saved: false })
    await expect(rollbackTool.execute('c1', { action: 'apply', id })).rejects.toThrow('save=false')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('含 irreversible 的账本拒绝回滚并逐条说明', async () => {
    const fp = asset('SM_Rock')
    const id = await seedLedger([entry('/Game/Temp/rock', '/Game/Props/SM_Rock', fp)], {
      irreversible: [{ kind: 'redirector_deleted', path: '/Game/Old/Thing', note: '删了就没了' }]
    })
    await expect(rollbackTool.execute('c1', { action: 'apply', id })).rejects.toThrow(
      '/Game/Old/Thing'
    )
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('preview', () => {
  it('把 from / to 对调后以 dry_run=true 发给引擎，闸的参数固定', async () => {
    const rock = asset('SM_Rock')
    const wall = asset('SM_Wall')
    const id = await seedLedger([
      entry('/Game/Temp/rock', '/Game/Props/SM_Rock', rock),
      entry('/Game/Temp/wall', '/Game/Props/SM_Wall', wall)
    ])
    echoMoved()

    const result = await rollbackTool.execute('c1', { action: 'preview', id })

    expect(callRequest).toHaveBeenCalledTimes(1)
    expect(callRequest.mock.calls[0][0]).toBe('content.batch_move')
    expect(sentParams(0)).toEqual({
      on_conflict: 'fail',
      save: true,
      dry_run: true,
      moves: [
        { source: '/Game/Props/SM_Rock', destination: '/Game/Temp/rock' },
        { source: '/Game/Props/SM_Wall', destination: '/Game/Temp/wall' }
      ]
    })
    expect(callRequest.mock.calls[0][3]).toBe(10 * 60 * 1000)

    const out = text(result)
    expect(out).toContain('预演')
    expect(out).toContain('可回滚 2')
    const details = result.details as RollbackDetails
    expect(details.ledger_id).toBe(id)
    expect(details.checks.map((c) => c.status)).toEqual(['ok', 'ok'])
    expect(details.responses).toHaveLength(1)
    // 预演不写账本
    expect(await listLedgers(PROJECT)).toHaveLength(1)
  })
})

describe('指纹', () => {
  it('字节数变了 → 跳过并报出来；on_modified=force 才带上', async () => {
    const rock = asset('SM_Rock')
    const wall = asset('SM_Wall')
    const id = await seedLedger([
      entry('/Game/Temp/rock', '/Game/Props/SM_Rock', rock),
      entry('/Game/Temp/wall', '/Game/Props/SM_Wall', wall)
    ])
    appendFileSync(wall.file, 'user edited this')
    echoMoved()

    const result = await rollbackTool.execute('c1', { action: 'apply', id })
    expect(sentParams(0).moves).toEqual([
      { source: '/Game/Props/SM_Rock', destination: '/Game/Temp/rock' }
    ])
    const out = text(result)
    expect(out).toContain('被改过 1')
    expect(out).toContain('/Game/Props/SM_Wall')
    expect(out).toContain('字节')
    expect(out).toContain('on_modified=force')

    callRequest.mockClear()
    const forced = await rollbackTool.execute('c1', { action: 'apply', id, on_modified: 'force' })
    expect((sentParams(0).moves as unknown[]).length).toBe(2)
    expect(text(forced)).toContain('强制带上')
  })

  it('mtime 差超过 2 秒也算改过；2 秒以内不算', async () => {
    const rock = asset('SM_Rock')
    const entries = [entry('/Game/Temp/rock', '/Game/Props/SM_Rock', rock)]
    expect((await checkEntries(entries, 'skip'))[0].status).toBe('ok')

    const within = new Date(Date.parse(rock.mtime) + 1500)
    utimesSync(rock.file, within, within)
    expect((await checkEntries(entries, 'skip'))[0].status).toBe('ok')

    const beyond = new Date(Date.parse(rock.mtime) + 10_000)
    utimesSync(rock.file, beyond, beyond)
    const checks = await checkEntries(entries, 'skip')
    expect(checks[0].status).toBe('modified')
    expect(checks[0].included).toBe(false)
    expect((await checkEntries(entries, 'force'))[0].included).toBe(true)
  })

  it('文件不在了 → 永远跳过，force 也不带', async () => {
    const rock = asset('SM_Rock')
    const wall = asset('SM_Wall')
    const id = await seedLedger([
      entry('/Game/Temp/rock', '/Game/Props/SM_Rock', rock),
      entry('/Game/Temp/wall', '/Game/Props/SM_Wall', wall)
    ])
    unlinkSync(wall.file)
    echoMoved()

    const result = await rollbackTool.execute('c1', { action: 'apply', id, on_modified: 'force' })
    expect(sentParams(0).moves).toEqual([
      { source: '/Game/Props/SM_Rock', destination: '/Game/Temp/rock' }
    ])
    expect(text(result)).toContain('文件缺失 1')
  })

  it('没有指纹的条目默认跳过，force 带上', async () => {
    const id = await seedLedger([entry('/Game/Temp/rock', '/Game/Props/SM_Rock')])
    echoMoved()

    await expect(rollbackTool.execute('c1', { action: 'apply', id })).rejects.toThrow(
      '没有可回滚的条目'
    )
    expect(callRequest).not.toHaveBeenCalled()

    // 预演时「没有可回滚的条目」不算失败，只是告诉你
    const preview = await rollbackTool.execute('c1', { action: 'preview', id })
    expect(text(preview)).toContain('无指纹 1')

    await rollbackTool.execute('c1', { action: 'apply', id, on_modified: 'force' })
    expect(callRequest).toHaveBeenCalledTimes(1)
  })

  it('账本里状态不是 moved 的条目不进反向 moves', async () => {
    const rock = asset('SM_Rock')
    const entries = [
      entry('/Game/Temp/rock', '/Game/Props/SM_Rock', rock),
      { ...entry('/Game/Temp/x', '/Game/Props/X', rock), status: 'failed' as unknown as 'moved' }
    ]
    expect(await checkEntries(entries, 'force')).toHaveLength(1)
  })
})

describe('apply', () => {
  it('搬成了 → 写一份带 rollback_of 的新账本，条目来自引擎响应', async () => {
    const rock = asset('SM_Rock')
    const id = await seedLedger([entry('/Game/Temp/rock', '/Game/Props/SM_Rock', rock)])
    echoMoved()

    const result = await rollbackTool.execute('c1', { action: 'apply', id, on_conflict: 'skip' })
    expect(sentParams(0).dry_run).toBe(false)
    expect(sentParams(0).on_conflict).toBe('skip')

    const out = text(result)
    expect(out).toContain('已执行回滚')
    expect(out).toContain('已移动 1/1')
    expect(out).toContain('回滚本身也记了账本')

    const details = result.details as RollbackDetails
    expect(details.rollback_ledger_id).toBeDefined()
    const ledger = await readLedger(PROJECT, details.rollback_ledger_id!)
    expect(ledger?.tool).toBe('ue_content_rollback')
    expect(ledger?.args_summary).toEqual({
      rollback_of: id,
      on_modified: 'skip',
      on_conflict: 'skip'
    })
    expect(ledger?.saved).toBe(true)
    expect(ledger?.reversible).toBe(true)
    expect(ledger?.entries).toEqual([
      {
        from: '/Game/Props/SM_Rock',
        to: '/Game/Temp/rock',
        status: 'moved',
        auto_renamed: false,
        fingerprint: {
          file: join(ASSETS, 'back.uasset'),
          bytes: 1,
          mtime: '2026-09-03T00:00:00.000Z'
        }
      }
    ])
    expect(await listLedgers(PROJECT)).toHaveLength(2)
  })

  it('引擎回 checkout_blocked → 报错并列出挡住的文件，不写新账本', async () => {
    const rock = asset('SM_Rock')
    const id = await seedLedger([entry('/Game/Temp/rock', '/Game/Props/SM_Rock', rock)])
    callRequest.mockResolvedValueOnce(
      ok({
        ok: false,
        moved: 0,
        reason: 'checkout_blocked',
        items: [],
        checkout: {
          scc_enabled: true,
          scc_provider: 'Perforce',
          checked: 2,
          blocked: 1,
          blocking: [
            {
              package: '/Game/Props/SM_Rock',
              filename: 'D:/Projects/Demo/Content/Props/SM_Rock.uasset',
              state: 'checked_out_other',
              checked_out_by: 'alice',
              blocks: true
            }
          ]
        }
      })
    )

    let message = ''
    try {
      await rollbackTool.execute('c1', { action: 'apply', id })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('签出预检')
    expect(message).toContain('/Game/Props/SM_Rock')
    expect(message).toContain('alice')
    expect(await listLedgers(PROJECT)).toHaveLength(1)
  })

  it('引擎回 cdo_referenced → 报错并列出命中的 C++ 属性', async () => {
    const rock = asset('BP_Char')
    const id = await seedLedger([entry('/Game/Temp/BP_Char', '/Game/Blueprints/BP_Char', rock)])
    callRequest.mockResolvedValueOnce(
      ok({
        ok: false,
        moved: 0,
        reason: 'cdo_referenced',
        items: [],
        cdo_refs: {
          checked: 1,
          hits: [
            {
              asset: '/Game/Blueprints/BP_Char',
              class: 'ADemoGameMode',
              property: 'DefaultPawnClass',
              kind: 'hard'
            }
          ]
        }
      })
    )
    await expect(rollbackTool.execute('c1', { action: 'apply', id })).rejects.toThrow(
      'DefaultPawnClass'
    )
  })

  it('一个都没搬成又不是预演 → 失败', async () => {
    const rock = asset('SM_Rock')
    const id = await seedLedger([entry('/Game/Temp/rock', '/Game/Props/SM_Rock', rock)])
    callRequest.mockResolvedValueOnce(
      ok({
        ok: false,
        moved: 0,
        failed: 1,
        items: [
          {
            source: '/Game/Props/SM_Rock',
            destination: '/Game/Temp/rock',
            referencers: 0,
            status: 'failed',
            error: 'RenameAssets failed'
          }
        ]
      })
    )
    await expect(rollbackTool.execute('c1', { action: 'apply', id })).rejects.toThrow(
      'RenameAssets failed'
    )
    expect(await listLedgers(PROJECT)).toHaveLength(1)
  })
})

describe('多批', () => {
  const many = (n: number, fp: LedgerEntry['fingerprint']): LedgerEntry[] =>
    Array.from({ length: n }, (_, i) => entry(`/Game/Temp/a${i}`, `/Game/Props/A${i}`, fp))

  it('on_conflict=fail 且多批：先全预演，有冲突就一个都不动', async () => {
    const fp = asset('shared')
    const id = await seedLedger(many(101, fp))
    callRequest
      .mockResolvedValueOnce(ok({ dry_run: true, moved: 0, planned: 100, items: [] }))
      .mockResolvedValueOnce(
        ok({
          dry_run: true,
          moved: 0,
          planned: 1,
          items: [],
          conflicts: [{ source: '/Game/Props/A100', destination: '/Game/Temp/a100' }]
        })
      )

    await expect(rollbackTool.execute('c1', { action: 'apply', id })).rejects.toThrow('已被占用')
    expect(callRequest).toHaveBeenCalledTimes(2)
    expect(sentParams(0).dry_run).toBe(true)
    expect(sentParams(1).dry_run).toBe(true)
    expect((sentParams(0).moves as unknown[]).length).toBe(100)
    expect((sentParams(1).moves as unknown[]).length).toBe(1)
  })

  it('预演里被闸挡下也一个都不动', async () => {
    const fp = asset('shared')
    const id = await seedLedger(many(101, fp))
    callRequest
      .mockResolvedValueOnce(ok({ dry_run: true, moved: 0, planned: 100, items: [] }))
      .mockResolvedValueOnce(
        ok({
          ok: false,
          dry_run: true,
          moved: 0,
          planned: 1,
          items: [],
          reason: 'checkout_blocked',
          checkout: {
            scc_enabled: true,
            checked: 1,
            blocked: 1,
            blocking: [{ package: '/Game/Props/A100', state: 'readonly_no_scc' }]
          }
        })
      )
    await expect(rollbackTool.execute('c1', { action: 'apply', id })).rejects.toThrow(
      '/Game/Props/A100'
    )
    expect(callRequest).toHaveBeenCalledTimes(2)
  })

  it('预演干净才真搬，每批上报进度，账本收全部条目', async () => {
    const fp = asset('shared')
    const id = await seedLedger(many(101, fp))
    echoMoved()
    const onUpdate = vi.fn()

    const result = await rollbackTool.execute('c1', { action: 'apply', id }, undefined, onUpdate)

    expect(callRequest).toHaveBeenCalledTimes(4)
    expect(sentParams(2).dry_run).toBe(false)
    expect(sentParams(3).dry_run).toBe(false)
    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(text(result)).toContain('已移动 101/101')

    const details = result.details as RollbackDetails
    const ledger = await readLedger(PROJECT, details.rollback_ledger_id!)
    expect(ledger?.entries).toHaveLength(101)
  })
})

/**
 * 崩溃恢复。这是整个账本机制存在的理由：
 * 引擎在执行途中把编辑器搞崩时，RPC 只抛一个异常，结果**未知**——
 * 真机三次崩溃里改名其实都已经做完了。verify 只查磁盘，引擎没起来照样能跑。
 */
describe('verify', () => {
  const VERIFY_PROJECT = join(root, 'proj', 'Demo.uproject')

  function contentFile(packagePath: string, bytes: number, ext = '.uasset'): void {
    const file = join(root, 'proj', 'Content', ...packagePath.slice('/Game/'.length).split('/'))
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(`${file}${ext}`, Buffer.alloc(bytes, 1))
  }

  async function seedPending(
    planned: { from: string; to: string }[],
    status: 'pending' | 'interrupted' = 'interrupted'
  ): Promise<string> {
    const ledger = await recordMoveLedger({
      projectPath: VERIFY_PROJECT,
      tool: 'ue_content_move',
      args_summary: {},
      saved: true,
      entries: [],
      status,
      planned
    })
    return ledger.id
  }

  beforeEach(() => {
    state.projectPath = VERIFY_PROJECT
    rmSync(join(root, 'proj'), { recursive: true, force: true })
  })

  it('全部搬到位时直说「不用重试」，一次引擎调用都没有', async () => {
    contentFile('/Game/Props/SM_Rock', 25_600)
    const id = await seedPending([{ from: '/Game/Temp/rock', to: '/Game/Props/SM_Rock' }])

    const result = await rollbackTool.execute('c1', { action: 'verify', id })

    expect(text(result)).toContain('已搬到位 1')
    expect(text(result)).toContain('不用重试')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('旧位置留着重定向器也算搬到位，并说清那是什么', async () => {
    contentFile('/Game/Props/SM_Rock', 25_600)
    contentFile('/Game/Temp/rock', 1300)
    const id = await seedPending([{ from: '/Game/Temp/rock', to: '/Game/Props/SM_Rock' }])

    const result = await rollbackTool.execute('c1', { action: 'verify', id })

    expect(text(result)).toContain('已搬到位 1')
    expect(text(result)).toContain('重定向器')
  })

  it('没搬的那几条单独列出来，并叫人只补发这几条', async () => {
    contentFile('/Game/Props/SM_Rock', 25_600)
    contentFile('/Game/Temp/tree', 8000)
    const id = await seedPending([
      { from: '/Game/Temp/rock', to: '/Game/Props/SM_Rock' },
      { from: '/Game/Temp/tree', to: '/Game/Props/SM_Tree' }
    ])

    const result = await rollbackTool.execute('c1', { action: 'verify', id })

    expect(text(result)).toContain('没有搬 1')
    expect(text(result)).toContain('/Game/Temp/tree → /Game/Props/SM_Tree')
    expect(text(result)).toContain('别把整批重来一遍')
  })

  it('中断的账本不许直接回滚，先叫人去 verify', async () => {
    const id = await seedPending([{ from: '/Game/Temp/rock', to: '/Game/Props/SM_Rock' }])

    await expect(rollbackTool.execute('c1', { action: 'apply', id })).rejects.toThrow(
      /action=verify/
    )
    expect(callRequest).not.toHaveBeenCalled()
  })

  /**
   * 分批搬迁崩在第二批时，账本里躺着第一批已回读的 entries。
   * 拿 entries 去核对会得出「全搬到位、不用重试」，而真正结果未知的
   * 第二三批一条都没查 —— 正好在最需要它的场景骗人。
   */
  it('中断的账本按 planned 全量核对，不能只查已经回来的那几条', async () => {
    contentFile('/Game/Props/SM_A', 20_000)
    contentFile('/Game/Temp/b', 8_000)
    const ledger = await recordMoveLedger({
      projectPath: VERIFY_PROJECT,
      tool: 'ue_content_move',
      args_summary: {},
      saved: true,
      // 第一批回来了
      entries: [
        { from: '/Game/Temp/a', to: '/Game/Props/SM_A', status: 'moved', auto_renamed: false }
      ],
      status: 'interrupted',
      planned: [
        { from: '/Game/Temp/a', to: '/Game/Props/SM_A', kind: 'asset' },
        { from: '/Game/Temp/b', to: '/Game/Props/SM_B', kind: 'asset' }
      ]
    })

    const result = await rollbackTool.execute('c1', { action: 'verify', id: ledger.id })

    expect(text(result)).toContain('核对 2 条')
    expect(text(result)).toContain('没有搬 1')
    expect(text(result)).toContain('/Game/Temp/b → /Game/Props/SM_B')
  })

  /**
   * 目录搬迁的 from / to 是目录不是包。按资产那套去查永远查不到，
   * 一次成功的目录搬迁会被核对成「两边都没有」，把恢复带到反方向。
   */
  it('整目录搬迁按目录核对，不会把搬成功的说成「两边都没有」', async () => {
    contentFile('/Game/Props/SM_Rock', 20_000)
    contentFile('/Game/Props/SM_Tree', 20_000)
    const ledger = await recordMoveLedger({
      projectPath: VERIFY_PROJECT,
      tool: 'ue_content_move',
      args_summary: {},
      saved: true,
      entries: [],
      status: 'interrupted',
      planned: [{ from: '/Game/Temp', to: '/Game/Props', kind: 'folder' }]
    })

    const result = await rollbackTool.execute('c1', { action: 'verify', id: ledger.id })

    expect(text(result)).toContain('已搬到位 1')
    expect(text(result)).toContain('全部做完了')
  })

  it('list 把没跑完的账本标出来', async () => {
    await seedPending([{ from: '/Game/Temp/rock', to: '/Game/Props/SM_Rock' }])

    const result = await rollbackTool.execute('c1', { action: 'list' })

    expect(text(result)).toContain('中断了，结果未知')
    expect(text(result)).toContain('action=verify')
  })
})
