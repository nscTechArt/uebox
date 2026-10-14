/**
 * @vitest-environment node
 *
 * `ue_run_console_command` 的设置账本：改 cvar / ShowFlag 前记下原值，
 * `restore_all` 按账改回去。
 *
 * 要锁住的是这几件事：
 * - 先查原值再改，查的命令不带参数（不带参数才回 `名字 = "值"`）
 * - 同一项改多次，账上留的是第一次的原值
 * - 模型自己改回原值也算销账，不会在 restore_all 时再改一遍
 * - 值不是数字、名字不在前缀里的命令一律不查——那可能是个命令，不带参数执行它不一定安全
 * - ShowFlag 的原值通常是 2（不覆盖），还原就该是 2 而不是 1
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

import { createRunConsoleCommandTool } from './runConsoleCommand'
import { listModified, parseCvarValue, resetLedgersForTest } from './consoleSettingLedger'

describe('parseCvarValue', () => {
  // 2026-10-14 UE 5.6 真机探针抓到的原样输出：改过一次之后，值那一行前面会多一段
  // 没有换行分隔的 HISTORY 前缀，里面不带等号，所以第一个 `= "…"` 仍然是当前值
  it('认得真机输出，包括带 HISTORY 前缀的', () => {
    expect(parseCvarValue('ShowFlag.DynamicShadows = "2"      LastSetBy: Constructor')).toBe('2')
    expect(
      parseCvarValue(
        'HISTORYConstructor: 0.000000Scalability: 100.000000r.ScreenPercentage = "100"      LastSetBy: Scalability'
      )
    ).toBe('100')
  })

  it('没有值那一行就回 null', () => {
    expect(parseCvarValue(undefined)).toBeNull()
    expect(parseCvarValue("Command not recognized: 'r.NoSuchThing'")).toBeNull()
  })
})

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createRunConsoleCommandTool() as unknown as Executable).execute(input)

/** 假引擎：认识几个 cvar，查询回 UE 的打印格式，设置就改值 */
function fakeEngine(initial: Record<string, string>): Record<string, string> {
  const values = { ...initial }
  callRequest.mockImplementation(async (_method: string, payload: { command: string }) => {
    const [name, value] = payload.command.trim().split(/\s+/)
    if (!(name! in values)) return { result: 'OK' }
    if (value === undefined) {
      return { result: 'OK', output: `${name} = "${values[name!]}"      LastSetBy: Constructor` }
    }
    values[name!] = value
    return { result: 'OK' }
  })
  return values
}

const sentCommands = (): string[] =>
  callRequest.mock.calls.map((c) => (c[1] as { command: string }).command)

beforeEach(() => {
  callRequest.mockReset()
  resetLedgersForTest()
})

describe('ue_run_console_command 设置账本', () => {
  it('改设置前先不带参数查一次原值，再执行', async () => {
    fakeEngine({ 'r.ScreenPercentage': '100' })
    const result = await run({ command: 'r.ScreenPercentage 50' })
    expect(sentCommands()).toEqual(['r.ScreenPercentage', 'r.ScreenPercentage 50'])
    expect(result.modified_settings).toEqual([{ name: 'r.ScreenPercentage', original: '100' }])
    expect(result.message).toContain('restore_all')
  })

  it('同一项改两次，账上留第一次的原值，第二次不再查', async () => {
    fakeEngine({ 'r.ScreenPercentage': '100' })
    await run({ command: 'r.ScreenPercentage 50' })
    await run({ command: 'r.ScreenPercentage 150' })
    expect(sentCommands()).toEqual([
      'r.ScreenPercentage',
      'r.ScreenPercentage 50',
      'r.ScreenPercentage 150'
    ])
    expect(listModified('conn-1')).toEqual([{ name: 'r.ScreenPercentage', original: '100' }])
  })

  it('模型自己改回原值就销账', async () => {
    fakeEngine({ 'r.ScreenPercentage': '100' })
    await run({ command: 'r.ScreenPercentage 50' })
    const result = await run({ command: 'r.ScreenPercentage 100.0' })
    expect(listModified('conn-1')).toEqual([])
    expect(result.modified_settings).toBeUndefined()
  })

  it('restore_all 把 ShowFlag 改回 2、cvar 改回原值，并清空账本', async () => {
    const engine = fakeEngine({ 'ShowFlag.DynamicShadows': '2', 'r.ScreenPercentage': '75' })
    await run({ command: 'ShowFlag.DynamicShadows 0' })
    await run({ command: 'r.ScreenPercentage 50' })
    callRequest.mockClear()

    const result = await run({ restore_all: true })
    expect(sentCommands()).toEqual(['ShowFlag.DynamicShadows 2', 'r.ScreenPercentage 75'])
    expect(engine).toEqual({ 'ShowFlag.DynamicShadows': '2', 'r.ScreenPercentage': '75' })
    expect(result.success).toBe(true)
    expect(listModified('conn-1')).toEqual([])
  })

  it('还原失败的那项留在账上，并如实报出来', async () => {
    fakeEngine({ 'r.ScreenPercentage': '100' })
    await run({ command: 'r.ScreenPercentage 50' })
    callRequest.mockResolvedValueOnce({ result: 'Failed', error: 'boom' })

    const result = await run({ restore_all: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('还原失败')
    expect(listModified('conn-1')).toHaveLength(1)
  })

  it('值不是数字、名字不在前缀里的命令不查原值', async () => {
    fakeEngine({})
    await run({ command: 'r.SetRes 1920x1080' })
    await run({ command: 'stat unit' })
    await run({ command: 'HighResShot 2' })
    expect(sentCommands()).toEqual(['r.SetRes 1920x1080', 'stat unit', 'HighResShot 2'])
    expect(listModified('conn-1')).toEqual([])
  })

  it('查询输出读不出值（不是 cvar）就不记账', async () => {
    callRequest.mockResolvedValue({ result: 'OK' })
    await run({ command: 'r.SomeCommand 1' })
    expect(listModified('conn-1')).toEqual([])
  })

  it('命令本身失败不记账', async () => {
    callRequest
      .mockResolvedValueOnce({ result: 'OK', output: 'r.ScreenPercentage = "100"' })
      .mockResolvedValueOnce({ result: 'Failed', error: 'nope' })
    const result = await run({ command: 'r.ScreenPercentage 50' })
    expect(result.success).toBe(false)
    expect(listModified('conn-1')).toEqual([])
  })

  it('没有要还原的就直说', async () => {
    const result = await run({ restore_all: true })
    expect(result.success).toBe(true)
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('既没有 command 也没有 restore_all 时报错，不发请求', async () => {
    const result = await run({})
    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})
