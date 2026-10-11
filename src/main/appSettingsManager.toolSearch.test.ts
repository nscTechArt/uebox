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

describe('工具搜索开关落盘', () => {
  it('默认打开；用户拨过之后重启读回他的选择', async () => {
    const { appSettingsManager: first } = await import('./appSettingsManager')
    expect(first.getSettings().agentToolSearchEnabled).toBe(true)
    first.setAgentToolSearchEnabled(false)
    expect(JSON.parse(disk.text)).toMatchObject({
      agentToolSearchEnabled: false,
      agentToolSearchUserSet: true
    })
    vi.resetModules()
    const { appSettingsManager: restarted } = await import('./appSettingsManager')
    expect(restarted.getSettings().agentToolSearchEnabled).toBe(false)
    restarted.setAgentToolSearchEnabled(true)
    expect(JSON.parse(disk.text).agentToolSearchEnabled).toBe(true)
  })

  it('老用户文件里的 false 只是当年的默认值（没拨过）：跟着新默认打开', async () => {
    disk.text = '{"agentToolSearchEnabled":false,"language":"zh-CN"}'
    const { appSettingsManager } = await import('./appSettingsManager')
    expect(appSettingsManager.getSettings().agentToolSearchEnabled).toBe(true)
  })

  it('磁盘写入失败时不改变运行模式', async () => {
    const { appSettingsManager } = await import('./appSettingsManager')
    disk.failWrite = true
    expect(() => appSettingsManager.setAgentToolSearchEnabled(false)).toThrow('disk full')
    expect(appSettingsManager.getSettings().agentToolSearchEnabled).toBe(true)
  })

  it('拨过的配置里写坏成非布尔值：按关处理，不替用户打开', async () => {
    disk.text = '{"agentToolSearchEnabled":"true","agentToolSearchUserSet":true}'
    const { appSettingsManager } = await import('./appSettingsManager')
    expect(appSettingsManager.getSettings().agentToolSearchEnabled).toBe(false)
  })
})

describe('自动断点续传开关', () => {
  it('默认打开；旧配置里没有这个字段也算开', async () => {
    const { appSettingsManager } = await import('./appSettingsManager')
    expect(appSettingsManager.getSettings().agentPersistentAutoResume).toBe(true)
  })

  it('用户关掉之后重启还是关的', async () => {
    const { appSettingsManager: first } = await import('./appSettingsManager')
    first.setAgentPersistentAutoResume(false)
    vi.resetModules()
    const { appSettingsManager: restarted } = await import('./appSettingsManager')
    expect(restarted.getSettings().agentPersistentAutoResume).toBe(false)
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

describe('资产只读锁与浏览器局域网访问', () => {
  it('默认都关；拨开后落盘，重启读回', async () => {
    const { appSettingsManager: first } = await import('./appSettingsManager')
    expect(first.getAssetReadonlyLock()).toBe(false)
    expect(first.getAgentBrowserAllowLocalNetwork()).toBe(false)

    first.setAssetReadonlyLock(true)
    first.setAgentBrowserAllowLocalNetwork(true)
    expect(JSON.parse(disk.text)).toMatchObject({
      assetReadonlyLock: true,
      agentBrowserAllowLocalNetwork: true
    })

    vi.resetModules()
    const { appSettingsManager: restarted } = await import('./appSettingsManager')
    expect(restarted.getAssetReadonlyLock()).toBe(true)
    expect(restarted.getAgentBrowserAllowLocalNetwork()).toBe(true)
  })

  // 一个改用户文件属性、一个放开内网访问：写坏的值不能被当成开
  it('配置里写坏成非布尔值时按关处理', async () => {
    disk.text = '{"assetReadonlyLock":"true","agentBrowserAllowLocalNetwork":1}'
    const { appSettingsManager } = await import('./appSettingsManager')
    expect(appSettingsManager.getAssetReadonlyLock()).toBe(false)
    expect(appSettingsManager.getAgentBrowserAllowLocalNetwork()).toBe(false)
  })
})
