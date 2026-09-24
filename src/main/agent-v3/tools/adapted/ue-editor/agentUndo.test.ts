/**
 * @vitest-environment node
 *
 * `ue_undo_history` / `ue_undo` 的契约测试。
 *
 * 重点在几条**说错了不会报错、只会让模型判断失误**的性质：
 *   - 不填 steps 就是「全撤」，app 侧不能偷偷塞个默认值
 *   - 没有可撤的步骤不是失败
 *   - 撤完必须提醒去 ue_save，否则模型会以为磁盘上也回退了
 *   - direction 决定打哪个插件命令，撤销和重做不能串
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

import { createUndoHistoryTool, createUndoTool } from './agentUndo'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const history = (input: unknown = {}): Promise<ToolResult> =>
  (createUndoHistoryTool() as unknown as Executable).execute(input)
const undo = (input: unknown = {}): Promise<ToolResult> =>
  (createUndoTool() as unknown as Executable).execute(input)

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('ue_undo_history', () => {
  it('把每一步动过的资产原样带上来', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      undoable: 2,
      redoable: 0,
      returned: 2,
      entries: [
        { step: 0, title: '创建材质', context: 'MaterialEditor', packages: ['/Game/M_A'] },
        { step: 1, title: '移动 Actor', context: 'LevelEditor', packages: ['/Game/Maps/Main'] }
      ]
    })

    const result = await history()

    expect(callRequest.mock.calls[0][0]).toBe('editor.undo_history')
    expect(result.entries).toHaveLength(2)
    expect(String(result.summary)).toContain('2 步可撤销')
  })

  it('不填 limit 时不塞默认值 —— 默认由插件端定', async () => {
    callRequest.mockResolvedValue({ ok: true, undoable: 0, redoable: 0, returned: 0, entries: [] })

    await history({})

    expect(callRequest.mock.calls[0][1]).toEqual({})
  })

  it('limit 为 0 也要发下去（0 表示全要，不是没填）', async () => {
    callRequest.mockResolvedValue({ ok: true, undoable: 0, redoable: 0, returned: 0, entries: [] })

    await history({ limit: 0 })

    expect(callRequest.mock.calls[0][1]).toEqual({ limit: 0 })
  })

  /** 被截断了必须说出来，否则模型会以为自己看到了全部 */
  it('只回了一部分时点明是最近几步', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      undoable: 100,
      redoable: 0,
      returned: 20,
      entries: []
    })

    const result = await history()

    expect(String(result.summary)).toContain('最近 20 步')
  })

  it('没有可撤的但有可重做的时候，把重做也说出来', async () => {
    callRequest.mockResolvedValue({ ok: true, undoable: 0, redoable: 3, returned: 0, entries: [] })

    const result = await history()

    expect(result.success).toBe(true)
    expect(String(result.summary)).toContain('3 步可以重做')
  })

  it('没连引擎时不发请求', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await history()

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('ue_undo', () => {
  const okResponse = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
    ok: true,
    action: 'undo',
    steps_applied: 2,
    step_titles: ['移动 Actor', '创建材质'],
    remaining: 0,
    redoable: 2,
    affected_packages: ['/Game/M_A', '/Game/Maps/Main'],
    ...over
  })

  /**
   * 「把刚才做的全撤了」是最常被要的语义，对应 steps 不填。
   * app 侧塞个默认 1 的话，用户说「全撤了」只会撤掉一步。
   */
  it('不填 steps 时什么都不发，全撤由插件端兜底', async () => {
    callRequest.mockResolvedValue(okResponse())

    await undo({})

    expect(callRequest.mock.calls[0][0]).toBe('editor.undo')
    expect(callRequest.mock.calls[0][1]).toEqual({})
  })

  it('direction=redo 打的是另一个命令', async () => {
    callRequest.mockResolvedValue(okResponse({ action: 'redo', redoable: 0, remaining: 2 }))

    const result = await undo({ direction: 'redo', steps: 1 })

    expect(callRequest.mock.calls[0][0]).toBe('editor.redo')
    expect(callRequest.mock.calls[0][1]).toEqual({ steps: 1 })
    expect(String(result.summary)).toContain('已重做')
  })

  /**
   * 撤销只改内存。不提醒保存的话，模型会以为磁盘上也回退了，
   * 然后跟用户说「已经改回去了」—— 而文件其实还是撤销前的样子。
   */
  it('撤完提醒去保存，并列出受影响的资产', async () => {
    callRequest.mockResolvedValue(okResponse())

    const result = await undo({})

    expect(result.affected_packages).toEqual(['/Game/M_A', '/Game/Maps/Main'])
    expect(String(result.summary)).toContain('ue_save')
  })

  /**
   * 2026-09-16 的用户反馈：撤销三步把关卡里的宝箱一起撤没了，返回体里一个字都没提，
   * 紧接着一次保存就落盘了。对象名必须进正文 —— 只放在字段里，只读 summary 的模型看不到。
   */
  it('把这次动到的对象列进正文，并提醒关卡 Actor 可能被撤没', async () => {
    callRequest.mockResolvedValue(
      okResponse({
        affected_packages: ['/Game/DoorDemo/L_DoorDemo'],
        affected_objects: ['TreasureChest', 'BP_TreasureChest']
      })
    )

    const result = await undo({ steps: 3 })

    expect(result.affected_objects).toEqual(['TreasureChest', 'BP_TreasureChest'])
    expect(String(result.summary)).toContain('TreasureChest')
    expect(String(result.summary)).toContain('查一遍实际状态')
  })

  /** 旧插件没有这个字段，不能因此多出一句空的「动到的对象：」 */
  it('插件没给 affected_objects 时正文里不出现这一段', async () => {
    callRequest.mockResolvedValue(okResponse())

    const result = await undo({})

    expect(result.affected_objects).toBeUndefined()
    expect(String(result.summary)).not.toContain('动到的对象')
  })

  it('对象太多时只列前 8 个并给出总数', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `Actor_${i}`)
    callRequest.mockResolvedValue(okResponse({ affected_objects: many }))

    const result = await undo({})

    expect(String(result.summary)).toContain('Actor_7')
    expect(String(result.summary)).not.toContain('Actor_8')
    expect(String(result.summary)).toContain('等 12 个')
  })

  it('一步都没撤不算失败', async () => {
    callRequest.mockResolvedValue(
      okResponse({ steps_applied: 0, step_titles: [], remaining: 0, redoable: 0 })
    )

    const result = await undo({})

    expect(result.success).toBe(true)
    expect(String(result.summary)).toContain('没有可撤销的步骤')
  })

  /**
   * 撤了 1 步然后停住：不能报成失败。失败在适配层只剩 error，「已经撤了 1 步」就丢了，
   * 模型以为一步没撤、重试，于是多撤一步（AGENTS.md §5 第 14 条）。
   */
  it('中途撤不动时：第一句说部分完成，先说撤了几步，再带上插件给的原因', async () => {
    callRequest.mockResolvedValue(
      okResponse({ ok: false, steps_applied: 1, remaining: 1, error: 'Stopped after 1 of 2 steps' })
    )

    const result = await undo({ steps: 2 })

    expect(result.success).toBe(true)
    expect(result.steps_applied).toBe(1)
    expect(result.steps_requested).toBe(2)
    const summary = String(result.summary)
    expect(summary.split('\n')[0]).toBe('⚠️ 部分完成：1 步成功 / 1 步失败。')
    expect(summary).toContain('已撤销 1 步')
    expect(summary).toContain('Stopped after 1 of 2 steps')
    // summary 是返回对象的第一个键 —— 适配层 JSON 化后模型第一眼看到的就是它
    expect(Object.keys(result)[0]).toBe('summary')
  })

  it('要的比栈上多：撤了能撤的，缺口算进失败', async () => {
    callRequest.mockResolvedValue(
      okResponse({
        ok: false,
        steps_applied: 2,
        remaining: 0,
        error: 'Requested 5 steps but only 2 were available; undid 2.'
      })
    )

    const result = await undo({ steps: 5 })

    expect(String(result.summary).split('\n')[0]).toBe('⚠️ 部分完成：2 步成功 / 3 步失败。')
    expect(String(result.summary)).toContain('only 2 were available')
  })

  it('栈上还有步骤却一步都没撤动：这是真失败', async () => {
    callRequest.mockResolvedValue(
      okResponse({
        ok: false,
        steps_applied: 0,
        step_titles: [],
        remaining: 3,
        error: 'Stopped after 0 of 3 steps - the editor refused to undo further.'
      })
    )

    const result = await undo({})

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('refused')
  })

  it('新插件在栈空时带 error：仍不算失败，但正文说清楚一步没撤', async () => {
    callRequest.mockResolvedValue(
      okResponse({
        ok: false,
        steps_applied: 0,
        step_titles: [],
        remaining: 0,
        redoable: 0,
        error: 'Nothing to undo: 3 step(s) requested, 0 available on the agent undo stack.'
      })
    )

    const result = await undo({ steps: 3 })

    expect(result.success).toBe(true)
    expect(String(result.summary)).toContain('没有撤销任何步骤')
    expect(String(result.summary)).toContain('3 step(s) requested')
  })

  it('插件没响应时报错而不是当成撤了 0 步', async () => {
    callRequest.mockResolvedValue(null)

    const result = await undo({})

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('editor.undo')
  })

  it('没连引擎时不发请求', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await undo({})

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})
