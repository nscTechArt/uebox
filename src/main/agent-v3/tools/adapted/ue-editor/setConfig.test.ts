/**
 * @vitest-environment node
 *
 * `ue_set_config` 的回执契约（AGENTS.md §5 第 14 条）：
 * 回执里的值来自引擎回读，不回显请求；回读不上、没写到磁盘都不许说成功。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))

import { createSetConfigTool } from './setConfig'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const INPUT = {
  config_name: 'Engine',
  section: '/Script/Engine.RendererSettings',
  key: 'r.Nanite.ProjectEnabled',
  value: 'True'
}

const run = (input: unknown = INPUT): Promise<ToolResult> =>
  (createSetConfigTool() as unknown as Executable).execute(input)

const BASE = {
  config_name: 'Engine',
  section: INPUT.section,
  key: INPUT.key,
  file_path: 'Engine'
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('ue_set_config', () => {
  it('回读成功且落盘时，报的是引擎读回的值', async () => {
    callRequest.mockResolvedValue({
      ...BASE,
      requested_value: 'True',
      read_back: true,
      value: 'True',
      persisted: true
    })

    const r = await run()

    expect(r.success).toBe(true)
    expect(r.verified).toBe(true)
    expect(String(r.message)).toContain('引擎读回的值: True')
  })

  it('引擎读回的值和请求不同时，不许报成功，报的是引擎的值', async () => {
    callRequest.mockResolvedValue({
      ...BASE,
      requested_value: 'True',
      read_back: true,
      value: 'False',
      persisted: true
    })

    const r = await run()

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('引擎读回的是 False')
  })

  it('只改在内存、没写到磁盘时不许报成功', async () => {
    callRequest.mockResolvedValue({
      ...BASE,
      read_back: true,
      value: 'True',
      persisted: false
    })

    const r = await run()

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('没写到磁盘')
  })

  it('插件回错时把 details 里的回读值带给模型', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: 'project.set_config: wrote "True" but the engine reads back "False"',
      details: { read_back: true, value: 'False', persisted: true }
    })

    const r = await run()

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('引擎里现在的值：False')
  })

  it('老插件（没有 read_back）回显的 value 不当成引擎的值报', async () => {
    callRequest.mockResolvedValue({ ...BASE, value: 'True' })

    const r = await run()

    expect(r.success).toBe(true)
    expect(r.verified).toBe(false)
    expect(r.value).toBeUndefined()
    expect(String(r.message)).toContain('未经引擎确认')
  })
})

/**
 * 2026-09-26 科幻塔防：默认 GameMode 设了三遍，工程的 DefaultEngine.ini 里一个字都没有 ——
 * 老插件写的是本机那一层（Saved/Config），不进打包。新插件写工程的 Default*.ini 并从磁盘读回。
 */
describe('ue_set_config 写工程设置文件', () => {
  const GM = {
    config_name: 'Engine',
    section: '/Script/EngineSettings.GameMapsSettings',
    key: 'GlobalDefaultGameMode',
    value: '/Game/Core/BP_GM.BP_GM_C'
  }

  it('走设置类写进 Default*.ini：说清写到哪个文件、编辑器里已经生效', async () => {
    callRequest.mockResolvedValue({
      ...GM,
      requested_value: GM.value,
      read_back: true,
      value: GM.value,
      persisted: true,
      file_path: 'I:/Proj/Config/DefaultEngine.ini',
      via: 'settings_object',
      applied_live: true
    })
    const r = await run(GM)
    expect(r.success).toBe(true)
    expect(String(r.message)).toContain('DefaultEngine.ini')
    expect(String(r.message)).toContain('已经生效')
  })

  it('规范写法和请求不逐字相同（true → True）也算成功：插件已按规范写法核对', async () => {
    callRequest.mockResolvedValue({
      ...BASE,
      requested_value: 'true',
      read_back: true,
      value: 'True',
      persisted: true,
      file_path: 'I:/Proj/Config/DefaultEngine.ini',
      via: 'settings_object',
      applied_live: true
    })
    const r = await run({ ...INPUT, value: 'true' })
    expect(r.success).toBe(true)
    expect(r.value).toBe('True')
  })

  it('只写了文件里的一个键：说清已加载的设置要重启才看得到', async () => {
    callRequest.mockResolvedValue({
      ...BASE,
      requested_value: 'True',
      read_back: true,
      value: 'True',
      persisted: true,
      file_path: 'I:/Proj/Config/DefaultEngine.ini',
      via: 'ini',
      applied_live: false
    })
    const r = await run()
    expect(r.success).toBe(true)
    expect(String(r.message)).toContain('重启编辑器')
  })
})
