/**
 * @vitest-environment node
 *
 * `ue_save` / `ue_list_unsaved` 的契约测试。
 *
 * 重点在几条**说错了不会报错、只会让模型判断失误**的性质：
 *   - 没东西可存不是失败
 *   - 存完还剩脏的要说出来，否则模型会以为工程干净了
 *   - 默认只存自己改的，这个边界不能被悄悄放宽
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
  getTargetConnectionId: () => 'conn-1'
}))

import { createSaveChangesTool, createListUnsavedTool } from './saveChanges'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const save = (input: unknown = {}): Promise<ToolResult> =>
  (createSaveChangesTool() as unknown as Executable).execute(input)
const listUnsaved = (): Promise<ToolResult> =>
  (createListUnsavedTool() as unknown as Executable).execute({})

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('ue_save', () => {
  it('默认 scope 交给插件决定，不在 app 侧写死', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      scope: 'touched',
      saved_count: 2,
      saved: [
        { package: '/Game/A', is_level: false },
        { package: '/Game/B', is_level: false }
      ],
      still_dirty_count: 0
    })

    await save({})

    const [command, params] = callRequest.mock.calls[0]
    expect(command).toBe('editor.save')
    // 没传就是没传 —— app 侧塞一个默认值等于把默认行为分散到两处
    expect(params).toEqual({})
  })

  it('scope=list 时把资产清单发下去', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      scope: 'list',
      saved_count: 1,
      saved: [{ package: '/Game/BP_Door', is_level: false }],
      still_dirty_count: 0
    })

    await save({ scope: 'list', assets: ['/Game/BP_Door'] })

    expect(callRequest.mock.calls[0][1]).toEqual({
      scope: 'list',
      assets: ['/Game/BP_Door']
    })
  })

  /**
   * 没有需要保存的东西是**正常状态**，不是错误。
   * 报成失败会让模型去排查一个不存在的问题，甚至反复重试。
   */
  it('没东西可存时算成功', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      scope: 'touched',
      saved_count: 0,
      saved: [],
      still_dirty_count: 0
    })

    const result = await save({})

    expect(result.success).toBe(true)
    expect(String(result.summary)).toContain('没有需要保存')
  })

  /**
   * 「刚改完却说没东西可存」几乎只有一个原因：那次改动走的是 Python，漏了标脏。
   *
   * 提示不能按 still_dirty_count 收窄：没标脏的包压根不计入那个数，所以
   * 「用户另开着一张改了一半的关卡」时反而不出现 —— 而那正是丢数据的场景。
   */
  it('没存出任何东西时提示标脏，哪怕工程里还有别人的脏改动', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      scope: 'touched',
      saved_count: 0,
      saved: [],
      still_dirty_count: 3
    })

    const result = await save({})

    expect(result.success).toBe(true)
    expect(String(result.summary)).toContain('asset.modify()')
  })

  it('点名保存一张干净的关卡不提标脏 —— 那本来就该是「已经存过了」', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      scope: 'list',
      saved_count: 0,
      saved: [],
      still_dirty_count: 0
    })

    const result = await save({ scope: 'list', paths: ['/Game/Maps/Main'] })

    expect(String(result.summary)).not.toContain('asset.modify()')
  })

  /**
   * 默认只存自己改的，用户手改的会留着脏 —— 那是对的行为。
   * 但必须说出来：不说的话模型看到「成功」就以为工程干净了，
   * 然后可能去做打开别的关卡这种会丢东西的事。
   */
  it('还剩别人改的没存时，要在结论里点明', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      scope: 'touched',
      saved_count: 0,
      saved: [],
      still_dirty_count: 3
    })

    const result = await save({})

    expect(result.success).toBe(true)
    expect(result.still_dirty_count).toBe(3)
    expect(String(result.summary)).toContain('3')
    expect(String(result.summary)).toContain('不是你改的')
  })

  it('存成功但有剩余时也要带上剩余数', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      scope: 'touched',
      saved_count: 2,
      saved: [
        { package: '/Game/A', is_level: false },
        { package: '/Game/B', is_level: true }
      ],
      still_dirty_count: 1
    })

    const result = await save({})

    expect(result.saved).toEqual(['/Game/A', '/Game/B'])
    expect(String(result.summary)).toContain('已保存 2 个')
    expect(String(result.summary)).toContain('另有 1 处未保存')
  })

  it('有失败项时整体算失败，并把失败原因带上', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      scope: 'touched',
      saved_count: 1,
      saved: [{ package: '/Game/A', is_level: false }],
      failed: [{ package: '/Game/B', error: 'read-only' }],
      still_dirty_count: 1
    })

    const result = await save({})

    expect(result.success).toBe(false)
    expect(result.failed).toHaveLength(1)
    expect(String(result.summary)).toContain('1 个失败')

    // 原因必须落在顶层 error 上 —— describeV2Failure 只认这个字段，
    // 只放进 failed[] 的话模型看到的是「未提供失败原因」
    expect(String(result.error)).toContain('/Game/B')
    expect(String(result.error)).toContain('read-only')
  })

  it('失败项很多时只列前 10 条，并说明还有多少', async () => {
    const failed = Array.from({ length: 13 }, (_, i) => ({
      package: `/Game/F${i}`,
      error: 'read-only'
    }))
    callRequest.mockResolvedValue({
      ok: false,
      scope: 'all',
      saved_count: 0,
      saved: [],
      failed,
      still_dirty_count: 13
    })

    const result = await save({ scope: 'all' })

    expect(String(result.error)).toContain('/Game/F9')
    expect(String(result.error)).not.toContain('/Game/F10')
    expect(String(result.error)).toContain('另有 3 个同样失败')
  })

  /**
   * 插件用 code>=400 报错时，callRequest 归一出来的对象**没有 saved 数组**。
   * 不先拦住它，下面那句 `response.saved.map()` 会抛 TypeError，
   * 模型收到的是一条 JS 栈而不是原因 —— 2026-09-09 真机撞到过。
   */
  it('插件回错误响应（没有 saved 数组）时不崩，把原因讲清楚', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      success: false,
      code: 404,
      error:
        'None of the listed assets are loaded in memory, so none of them have unsaved changes.',
      details: { not_loaded: ['/Game/Maps/L_LakeVilla'] },
      __rpc: { code: 404 }
    })

    const result = await save({ scope: 'list', assets: ['/Game/Maps/L_LakeVilla'] })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('L_LakeVilla')
    expect(result.not_loaded).toEqual(['/Game/Maps/L_LakeVilla'])
  })

  it('scope=list 全都不脏时，不说「那些不是你改的」', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      scope: 'list',
      saved_count: 0,
      saved: [],
      still_dirty_count: 2
    })

    const result = await save({ scope: 'list', assets: ['/Game/A'] })

    expect(result.success).toBe(true)
    expect(String(result.summary)).toContain('已经是存过的状态')
    expect(String(result.summary)).not.toContain('不是你改的')
  })

  it('没连引擎时不发请求', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await save({})

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('ue_list_unsaved', () => {
  it('把「你改的」和「别人改的」分开回', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      touched_count: 2,
      other_count: 1,
      touched: [
        { package: '/Game/A', is_level: false },
        { package: '/Game/B', is_level: false }
      ],
      other: [{ package: '/Game/UserEdited', is_level: false }]
    })

    const result = await listUnsaved()

    expect(result.touched).toEqual(['/Game/A', '/Game/B'])
    expect(result.other).toEqual(['/Game/UserEdited'])
    expect(String(result.summary)).toContain('你改的 2 处')
    expect(String(result.summary)).toContain('别处改的 1 处')
  })

  /**
   * 空清单不能说成「工程是干净的」。
   *
   * 这份清单只含 ue_save 存得了的包，`/Temp/` 下没落过盘的临时包不在里面，
   * 但它们照样会拦住换关卡和重启。说得太满的话，模型拿着「没有未保存的改动」
   * 撞上 ue_open_level 的 409，会以为两个工具在打架，然后直奔 force=true ——
   * 那会把清单外的东西一起丢掉。
   */
  it('全干净时说清楚「干净」的范围，不说成整个工程没东西', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      touched_count: 0,
      other_count: 0,
      touched: [],
      other: []
    })

    const result = await listUnsaved()

    const summary = String(result.summary)
    expect(summary).toContain('ue_save 能存')
    expect(summary).toContain('临时包不在这份清单里')
  })
})
