/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => ({ text: '{}', failWrite: false }))
vi.mock('electron', () => ({ app: { getPath: () => '/test-settings' } }))
vi.mock('./services', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('fs', () => ({
  existsSync: () => true,
  readFileSync: () => disk.text,
  writeFileSync: (_path: string, text: string) => {
    if (disk.failWrite) throw new Error('disk full')
    disk.text = text
  }
}))

beforeEach(() => {
  vi.resetModules()
  disk.text = '{}'
  disk.failWrite = false
})

describe('Beta 开关落盘', () => {
  it('旧设置默认关闭；重启读回用户保存的选择', async () => {
    const { appSettingsManager: first } = await import('./appSettingsManager')
    expect(first.getSettings().agentToolSearchEnabled).toBe(false)
    first.setAgentToolSearchEnabled(true)
    expect(JSON.parse(disk.text).agentToolSearchEnabled).toBe(true)
    vi.resetModules()
    const { appSettingsManager: restarted } = await import('./appSettingsManager')
    expect(restarted.getSettings().agentToolSearchEnabled).toBe(true)
    restarted.setAgentToolSearchEnabled(false)
    expect(JSON.parse(disk.text).agentToolSearchEnabled).toBe(false)
  })
  it('磁盘写入失败时不改变运行模式', async () => {
    const { appSettingsManager } = await import('./appSettingsManager')
    disk.failWrite = true
    expect(() => appSettingsManager.setAgentToolSearchEnabled(true)).toThrow('disk full')
    expect(appSettingsManager.getSettings().agentToolSearchEnabled).toBe(false)
  })
  it('旧配置里的非布尔值不能意外开启 Beta', async () => {
    disk.text = '{"agentToolSearchEnabled":"true"}'
    const { appSettingsManager } = await import('./appSettingsManager')
    expect(appSettingsManager.getSettings().agentToolSearchEnabled).toBe(false)
  })
})

describe('工具开关落盘', () => {
  it('两份名单默认是空的：什么都没设置过就等于全部打开', async () => {
    const { appSettingsManager } = await import('./appSettingsManager')
    expect(appSettingsManager.getSettings().agentDisabledTools).toEqual([])
    expect(appSettingsManager.getSettings().agentResidentTools).toEqual({})
  })

  it('两份名单各存各的，重启后都读得回来', async () => {
    const { appSettingsManager: first } = await import('./appSettingsManager')
    first.setAgentDisabledTools(['ue_pcg_run'])
    first.setAgentResidentTools({ ue_add_node: true })
    vi.resetModules()
    const { appSettingsManager: restarted } = await import('./appSettingsManager')
    expect(restarted.getSettings().agentDisabledTools).toEqual(['ue_pcg_run'])
    expect(restarted.getSettings().agentResidentTools).toEqual({ ue_add_node: true })
  })

  it('配置被手改坏时退回「什么都没关」，而不是让助手空着手上阵', async () => {
    disk.text = '{"agentDisabledTools":{"a":1},"agentResidentTools":["ue_add_node"]}'
    const { appSettingsManager } = await import('./appSettingsManager')
    expect(appSettingsManager.getSettings().agentDisabledTools).toEqual([])
    expect(appSettingsManager.getSettings().agentResidentTools).toEqual({})
  })

  it('名单里混进非法项只丢掉那一项', async () => {
    disk.text = '{"agentDisabledTools":["ue_pcg_run",7],"agentResidentTools":{"a":true,"b":"yes"}}'
    const { appSettingsManager } = await import('./appSettingsManager')
    expect(appSettingsManager.getSettings().agentDisabledTools).toEqual(['ue_pcg_run'])
    expect(appSettingsManager.getSettings().agentResidentTools).toEqual({ a: true })
  })

  it('磁盘写入失败时不改变已生效的名单', async () => {
    const { appSettingsManager } = await import('./appSettingsManager')
    disk.failWrite = true
    expect(() => appSettingsManager.setAgentDisabledTools(['ue_pcg_run'])).toThrow('disk full')
    expect(appSettingsManager.getSettings().agentDisabledTools).toEqual([])
  })
})
