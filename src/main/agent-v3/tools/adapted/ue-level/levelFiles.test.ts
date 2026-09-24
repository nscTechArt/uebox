/**
 * @vitest-environment node
 *
 * 关卡文件操作的契约测试。
 *
 * 最要紧的一条：`ue_open_level` / `ue_new_level` 会**不可撤销地丢掉**未保存的
 * 改动。插件端在有脏东西时回 409，这里必须把它翻译成「先去保存」——
 * 翻译成一句普通失败的话，模型下一步最可能干的事就是加 force 重试，
 * 那正好是会让用户丢工作的那条路。
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

import {
  createGetCurrentLevelTool,
  createSaveLevelTool,
  createOpenLevelTool,
  createNewLevelTool
} from './levelFiles'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const exec = (factory: () => unknown, input: unknown = {}): Promise<ToolResult> =>
  (factory() as unknown as Executable).execute(input)

/** 插件在有未保存改动时回的形状 */
const REFUSAL = {
  ok: false,
  __rpc: { code: 409 },
  details: {
    unsaved: ['/Game/A', '/Game/Maps/Current'],
    unsaved_count: 2,
    hint: 'Call editor.save first'
  }
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('ue_get_current_level', () => {
  it('回当前关卡、Actor 数和脏状态', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      package: '/Game/Maps/Main',
      name: 'Main',
      is_dirty: true,
      is_temporary: false,
      actor_count: 42
    })

    const result = await exec(createGetCurrentLevelTool)

    expect(result.package).toBe('/Game/Maps/Main')
    expect(String(result.summary)).toContain('42 个 Actor')
    expect(String(result.summary)).toContain('有未保存改动')
  })

  /**
   * 从没保存过的关卡存盘必须给路径。提前说出来，模型才不会先调一次
   * 无参保存、撞一个错、再回头找路径。
   */
  it('临时关卡要标出来', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      package: '/Temp/Untitled',
      name: 'Untitled',
      is_dirty: true,
      is_temporary: true,
      actor_count: 3
    })

    const result = await exec(createGetCurrentLevelTool)

    expect(result.is_temporary).toBe(true)
    expect(String(result.summary)).toContain('还没有文件')
  })
})

describe('ue_save_level', () => {
  it('不给路径就是原地保存', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      package: '/Game/Maps/Main',
      saved_as: '/Game/Maps/Main',
      actor_count: 1
    })

    await exec(createSaveLevelTool, {})

    expect(callRequest.mock.calls[0][0]).toBe('level.save')
    expect(callRequest.mock.calls[0][1]).toEqual({})
  })

  it('给了路径就是另存为', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      package: '/Game/Maps/Copy',
      saved_as: '/Game/Maps/Copy',
      actor_count: 1
    })

    const result = await exec(createSaveLevelTool, { path: '/Game/Maps/Copy' })

    expect(callRequest.mock.calls[0][1]).toEqual({ path: '/Game/Maps/Copy' })
    expect(String(result.summary)).toContain('/Game/Maps/Copy')
  })

  /**
   * SaveLevel 存的是「当前关卡」。当前关卡是子关卡时，插件报的是实际存下的
   * 子关卡包名 —— 回执要跟着引擎走，而且第一句不能说成「关卡已保存」。
   */
  it('当前关卡是子关卡时，第一句说只存了子关卡，包名跟引擎走', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      package: '/Game/Maps/Main',
      is_dirty: true,
      saved_as: '/Game/Maps/Main_Lighting',
      saved_file: 'D:/Proj/Content/Maps/Main_Lighting.umap',
      saved_level_is_persistent: false,
      actor_count: 10
    })

    const result = await exec(createSaveLevelTool, {})

    const summary = String(result.summary)
    expect(summary.startsWith('⚠️')).toBe(true)
    expect(summary).toContain('/Game/Maps/Main_Lighting')
    expect(summary).toContain('持久关卡 /Game/Maps/Main')
    expect(result.saved_as).toBe('/Game/Maps/Main_Lighting')
    expect(result.saved_file).toBe('D:/Proj/Content/Maps/Main_Lighting.umap')
    // 序列化后第一段就是 summary —— 适配层按键序 JSON 化给模型
    expect(Object.keys(result)[0]).toBe('summary')
  })
})

describe('ue_open_level — 会丢东西的操作', () => {
  /**
   * 这条是整个文件里最重要的测试。
   *
   * 拒绝要被翻译成「先保存」，并且**不能**把 force 说成解决办法。
   */
  it('有未保存改动时，把拒绝翻译成「先去保存」', async () => {
    callRequest.mockResolvedValue(REFUSAL)

    const result = await exec(createOpenLevelTool, { path: '/Game/Maps/Other' })

    expect(result.success).toBe(false)
    expect(result.needs_save_first).toBe(true)

    const message = String(result.error)
    expect(message).toContain('ue_save')
    expect(message).toContain('/Game/A')
    // 数量要在，否则模型不知道事情有多大
    expect(message).toContain('2')
    // force 只能作为"用户明确要求丢弃"时的选项出现，不能是推荐做法
    expect(message).toContain('用户明确说')
    expect(message).toContain('无法撤销')
  })

  it('正常打开时回新关卡信息', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      package: '/Game/Maps/Other',
      actor_count: 7
    })

    const result = await exec(createOpenLevelTool, { path: '/Game/Maps/Other' })

    expect(result.success).toBe(true)
    expect(String(result.summary)).toContain('7 个 Actor')
  })

  it('force 原样透传', async () => {
    callRequest.mockResolvedValue({ ok: true, package: '/Game/Maps/Other', actor_count: 0 })

    await exec(createOpenLevelTool, { path: '/Game/Maps/Other', force: true })

    expect(callRequest.mock.calls[0][1]).toEqual({ path: '/Game/Maps/Other', force: true })
  })
})

describe('ue_new_level', () => {
  it('同样把 409 翻译成先保存', async () => {
    callRequest.mockResolvedValue(REFUSAL)

    const result = await exec(createNewLevelTool, {})

    expect(result.success).toBe(false)
    expect(result.needs_save_first).toBe(true)
    expect(String(result.error)).toContain('ue_save')
  })

  /**
   * 不给 save_as 的话新关卡只在内存里。这件事必须说 —— 否则模型会以为
   * 关卡已经建好了，后面按路径去引用它会全部落空。
   */
  it('没落盘时明确说它还只在内存里', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      package: '/Temp/Untitled',
      saved: false,
      note: 'The new level exists in memory only.'
    })

    const result = await exec(createNewLevelTool, {})

    expect(result.saved).toBe(false)
    expect(String(result.summary)).toContain('仅在内存里')
  })

  it('给了 save_as 就顺手落盘', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      package: '/Game/Maps/New',
      saved: true
    })

    const result = await exec(createNewLevelTool, { save_as: '/Game/Maps/New' })

    expect(result.saved).toBe(true)
    expect(String(result.summary)).toContain('/Game/Maps/New')
  })

  it('存盘包名跟插件回读的 saved_as 走，不回显 save_as', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      package: '/Game/Maps/Renamed',
      saved: true,
      saved_as: '/Game/Maps/Renamed'
    })

    const result = await exec(createNewLevelTool, { save_as: '/Game/Maps/New.New' })

    expect(String(result.summary)).toContain('/Game/Maps/Renamed')
    expect(String(result.summary)).not.toContain('/Game/Maps/New.New')
  })

  /**
   * 给了 save_as 却没存上：新关卡已经建好（旧关卡已换掉），不能只回一句
   * 「已新建空关卡」—— 模型会以为照它给的路径存好了。
   */
  it('给了 save_as 但没存上时，第一句带 ⚠️ 和原因', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      package: '/Temp/Untitled_1',
      saved: false,
      save_error: 'saving it to /Game/Maps/New failed - read-only'
    })

    const result = await exec(createNewLevelTool, { save_as: '/Game/Maps/New' })

    const summary = String(result.summary)
    expect(summary.startsWith('⚠️')).toBe(true)
    expect(summary).toContain('/Game/Maps/New')
    expect(summary).toContain('read-only')
    expect(result.saved).toBe(false)
  })

  it('老插件没有 save_error 时，给了 save_as 没存上也不说成功落盘', async () => {
    callRequest.mockResolvedValue({ ok: true, package: '/Temp/Untitled_1', saved: false })

    const result = await exec(createNewLevelTool, { save_as: '/Game/Maps/New' })

    expect(String(result.summary).startsWith('⚠️')).toBe(true)
    expect(String(result.summary)).toContain('插件没给原因')
  })
})
