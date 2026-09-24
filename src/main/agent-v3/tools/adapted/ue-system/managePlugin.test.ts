/**
 * @vitest-environment node
 *
 * `ue_manage_plugin` 的回读校验测试。
 *
 * 这个工具出过一次真机事故（2026-08-31，UE 5.7）：对 PCG 执行 Enable 回了
 * 「Plugin enabled. Restart required.」，用户重启两次都没生效，打开
 * `.uproject` 一看 Plugins 数组里根本没有这一条。引擎侧的
 * `IProjectManager::SetPluginEnabled` 只改内存不落盘，而返回文案是无条件的成功。
 *
 * 所以这里锁死一条纪律：**改完必须回读 `.uproject`，读不到就不许报成功**。
 * 用真的临时文件而不是 mock fs —— 要测的就是「真的去磁盘看了一眼」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

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
  createManagePluginTool,
  isDiskStateConsistent,
  pluginStateIn,
  readUprojectPluginState
} from './managePlugin'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createManagePluginTool() as unknown as Executable).execute(input)

let dir: string
let uprojectPath: string

/** 写一份 .uproject，Tab 缩进，和 UE 自己写的格式一致 */
async function writeUproject(plugins: Array<{ Name: string; Enabled?: boolean }>): Promise<void> {
  await fs.writeFile(
    uprojectPath,
    JSON.stringify({ FileVersion: 3, EngineAssociation: '5.7', Plugins: plugins }, null, '\t'),
    'utf8'
  )
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ual-manage-plugin-'))
  uprojectPath = join(dir, 'Demo.uproject')
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('pluginStateIn', () => {
  it('没有这一条就是 absent', () => {
    expect(pluginStateIn({}, 'PCG')).toBe('absent')
    expect(pluginStateIn({ Plugins: [] }, 'PCG')).toBe('absent')
    expect(pluginStateIn({ Plugins: [{ Name: 'USDImporter', Enabled: true }] }, 'PCG')).toBe(
      'absent'
    )
  })

  it('Enabled 只有严格 true 才算启用 —— 省略字段不等于 true', () => {
    expect(pluginStateIn({ Plugins: [{ Name: 'PCG', Enabled: true }] }, 'PCG')).toBe('enabled')
    expect(pluginStateIn({ Plugins: [{ Name: 'PCG', Enabled: false }] }, 'PCG')).toBe('disabled')
    expect(pluginStateIn({ Plugins: [{ Name: 'PCG' }] }, 'PCG')).toBe('disabled')
  })

  it('名字大小写不敏感 —— 用户手改过的项目文件里什么都可能有', () => {
    expect(pluginStateIn({ Plugins: [{ Name: 'pcg', Enabled: true }] }, 'PCG')).toBe('enabled')
  })
})

describe('isDiskStateConsistent', () => {
  it('磁盘上写着什么就认什么', () => {
    expect(isDiskStateConsistent('enabled', true)).toBe(true)
    expect(isDiskStateConsistent('enabled', false)).toBe(false)
    expect(isDiskStateConsistent('disabled', false)).toBe(true)
    expect(isDiskStateConsistent('disabled', true)).toBe(false)
  })

  it('条目不存在时，只有默认状态等于目标状态才算数', () => {
    // UE 在「目标状态 == 默认状态」时会把条目删掉，这时候没有条目是对的
    expect(isDiskStateConsistent('absent', true, true)).toBe(true)
    expect(isDiskStateConsistent('absent', false, false)).toBe(true)
    expect(isDiskStateConsistent('absent', true, false)).toBe(false)
  })

  it('引擎没给默认值（旧插件包）时，条目不存在一律按没写进去处理', () => {
    expect(isDiskStateConsistent('absent', true, undefined)).toBe(false)
    expect(isDiskStateConsistent('absent', false, undefined)).toBe(false)
  })
})

describe('readUprojectPluginState', () => {
  it('读得到就给状态', async () => {
    await writeUproject([{ Name: 'PCG', Enabled: true }])
    expect(await readUprojectPluginState(uprojectPath, 'PCG')).toEqual({ state: 'enabled' })
  })

  it('文件不存在时交代原因，而不是当成 absent', async () => {
    const result = await readUprojectPluginState(join(dir, 'Nope.uproject'), 'PCG')
    expect(result).toHaveProperty('error')
  })

  it('文件坏了也走 error，不能把解析失败当成「没这一条」', async () => {
    await fs.writeFile(uprojectPath, '{ 不是 JSON', 'utf8')
    expect(await readUprojectPluginState(uprojectPath, 'PCG')).toHaveProperty('error')
  })
})

describe('ue_manage_plugin 的回读校验', () => {
  it('引擎报成功但 .uproject 里没写进去 —— 必须报失败，这就是那次事故', async () => {
    await writeUproject([{ Name: 'USDImporter', Enabled: true }])
    callRequest.mockResolvedValueOnce({
      plugin_name: 'PCG',
      is_enabled: false,
      requires_restart: true,
      message: 'Plugin enabled. Restart required.',
      uproject_path: uprojectPath,
      default_enabled: false
    })

    const r = await run({ plugin_name: 'PCG', action: 'Enable' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('没有这一条')
    // 用户白重启两次就是因为文案在这里撒了谎
    expect(String(r.error)).toContain('重启编辑器不会有任何效果')
    expect(r.uproject_state).toBe('absent')
  })

  it('.uproject 里写着 Enabled:false 时同样报失败', async () => {
    await writeUproject([{ Name: 'PCG', Enabled: false }])
    callRequest.mockResolvedValueOnce({
      plugin_name: 'PCG',
      is_enabled: false,
      requires_restart: true,
      uproject_path: uprojectPath,
      default_enabled: false
    })

    const r = await run({ plugin_name: 'PCG', action: 'Enable' })

    expect(r.success).toBe(false)
    expect(r.uproject_state).toBe('disabled')
  })

  it('真的写进去了才报成功，并说明是回读文件确认过的', async () => {
    await writeUproject([{ Name: 'PCG', Enabled: true }])
    callRequest.mockResolvedValueOnce({
      plugin_name: 'PCG',
      // 引擎运行时状态仍是 false —— UE 不能热加载新插件，要重启
      is_enabled: false,
      requires_restart: true,
      uproject_path: uprojectPath,
      uproject_verified: true,
      default_enabled: false
    })

    const r = await run({ plugin_name: 'PCG', action: 'Enable' })

    expect(r.success).toBe(true)
    expect(r.requires_restart).toBe(true)
    expect(String(r.message)).toContain('已回读文件确认')
    expect(r.uproject_path).toBe(uprojectPath)
  })

  it('禁用：条目被 UE 删掉且默认就是关的，算成功', async () => {
    await writeUproject([{ Name: 'USDImporter', Enabled: true }])
    callRequest.mockResolvedValueOnce({
      plugin_name: 'PCG',
      is_enabled: true, // 禁用后运行时状态要等重启才变
      requires_restart: true,
      uproject_path: uprojectPath,
      default_enabled: false
    })

    const r = await run({ plugin_name: 'PCG', action: 'Disable' })

    expect(r.success).toBe(true)
    expect(String(r.message)).toContain('禁用')
  })

  it('拿不到 .uproject 路径时不许报成功', async () => {
    callRequest
      .mockResolvedValueOnce({
        plugin_name: 'PCG',
        is_enabled: false,
        requires_restart: true,
        message: 'Plugin enabled. Restart required.'
      })
      // 老插件包：回落到 system.get_project_info 也拿不到路径
      .mockResolvedValueOnce({ ok: true })

    const r = await run({ plugin_name: 'PCG', action: 'Enable' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('无法确认')
  })

  it('老插件包没有 uproject_path 时，回落到 system.get_project_info', async () => {
    await writeUproject([{ Name: 'PCG', Enabled: true }])
    callRequest
      .mockResolvedValueOnce({ plugin_name: 'PCG', is_enabled: false, requires_restart: true })
      .mockResolvedValueOnce({ ok: true, project_path: uprojectPath })

    const r = await run({ plugin_name: 'PCG', action: 'Enable' })

    expect(r.success).toBe(true)
    expect(callRequest.mock.calls[1][0]).toBe('system.get_project_info')
  })

  it('Query 不碰磁盘 —— 它什么都没改，没有可校验的落盘动作', async () => {
    callRequest.mockResolvedValueOnce({
      plugin_name: 'PCG',
      is_enabled: true,
      requires_restart: false
    })

    const r = await run({ plugin_name: 'PCG', action: 'Query' })

    expect(r.success).toBe(true)
    expect(r.is_enabled).toBe(true)
    expect(callRequest).toHaveBeenCalledTimes(1)
  })

  /**
   * 以前「运行时已是目标状态」就跳过回读。刚 disable 过、还没重启时 is_enabled 仍是 true，
   * 再 enable 就被当成「已启用」—— 磁盘上那条 disable 还挂着，重启后插件照样被关。
   * 这里模拟老插件：它同样按内存判断、没写盘就回了成功。
   */
  it('运行时已启用、但 .uproject 里挂着 disable 时，Enable 不许报成功', async () => {
    await writeUproject([{ Name: 'PythonScriptPlugin', Enabled: false }])
    callRequest.mockResolvedValueOnce({
      plugin_name: 'PythonScriptPlugin',
      is_enabled: true,
      requires_restart: false,
      uproject_path: uprojectPath,
      default_enabled: false
    })

    const r = await run({ plugin_name: 'PythonScriptPlugin', action: 'Enable' })

    expect(r.success).toBe(false)
    expect(r.uproject_state).toBe('disabled')
  })

  it('Enable 一个本来就启用着的插件：回读磁盘确认，不要求重启', async () => {
    await writeUproject([{ Name: 'PythonScriptPlugin', Enabled: true }])
    callRequest.mockResolvedValueOnce({
      plugin_name: 'PythonScriptPlugin',
      is_enabled: true,
      requires_restart: false,
      uproject_path: uprojectPath,
      default_enabled: false
    })

    const r = await run({ plugin_name: 'PythonScriptPlugin', action: 'Enable' })

    expect(r.success).toBe(true)
    expect(r.requires_restart).toBe(false)
    expect(String(r.message)).toContain('不用重启')
  })

  it('老插件包不给默认状态、条目又不存在时，运行时已是目标就不判失败，但标明未确认', async () => {
    await writeUproject([])
    callRequest.mockResolvedValueOnce({
      plugin_name: 'Niagara',
      is_enabled: true,
      requires_restart: false,
      uproject_path: uprojectPath
    })

    const r = await run({ plugin_name: 'Niagara', action: 'Enable' })

    expect(r.success).toBe(true)
    expect(r.uproject_verified).toBe(false)
    expect(String(r.message)).toContain('没法确认')
  })

  it('引擎侧自己报了失败（落盘失败/只读文件）时原样透传', async () => {
    callRequest.mockResolvedValueOnce({
      ok: false,
      message: 'Failed to write .uproject: file is read-only',
      error: 'Failed to write .uproject: file is read-only',
      __rpc: { code: 500 }
    })

    const r = await run({ plugin_name: 'PCG', action: 'Enable' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('read-only')
  })

  it('没有连接的引擎时直接说清楚', async () => {
    getConnectionCount.mockReturnValue(0)
    const r = await run({ plugin_name: 'PCG', action: 'Enable' })
    expect(r.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})
