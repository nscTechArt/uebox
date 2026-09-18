/**
 * @vitest-environment node
 *
 * 切换活跃保管库。
 *
 * 这个工具存在的理由是那条**故意的**边界：读跨库，写不跨库。
 * 东西在别的库里而要改它时，唯一的出路是换库 —— 而换库是用户的决定
 * （应用整个界面会跟着换），所以它挂在审批门后面（risk: mutating）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { vaultManager } = vi.hoisted(() => ({
  vaultManager: {
    getAllVaults: vi.fn(),
    getCurrentVault: vi.fn(),
    switchToVault: vi.fn()
  }
}))

vi.mock('../../../../sqliteDataBase', () => ({
  getDatabaseManager: () => ({ getVaultManager: () => vaultManager })
}))

const { createSwitchVaultTool } = await import('./switchVault')

const tool = createSwitchVaultTool()
const run = (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

const DEFAULT_VAULT = { id: 'v_default', name: '默认保管库' }
const AIGC_VAULT = { id: 'v_aigc', name: 'AIGC 资产库' }

/** 当前站在 AIGC 库上；switchToVault 成功后当前库真的变了 */
let current: { id: string; name: string } = AIGC_VAULT

beforeEach(() => {
  current = AIGC_VAULT
  vaultManager.getAllVaults.mockReset().mockReturnValue([DEFAULT_VAULT, AIGC_VAULT])
  vaultManager.getCurrentVault.mockReset().mockImplementation(() => current)
  vaultManager.switchToVault.mockReset().mockImplementation(async (id: string) => {
    current = [DEFAULT_VAULT, AIGC_VAULT].find((v) => v.id === id)!
    return { success: true }
  })
})

describe('切库', () => {
  it('按库名切，并说清楚从哪切到了哪', async () => {
    const r = await run({ vault: '默认保管库' })

    expect(vaultManager.switchToVault).toHaveBeenCalledWith('v_default')
    expect(r.success).toBe(true)
    expect(r.vault).toBe('默认保管库')
    expect(r.previous_vault).toBe('AIGC 资产库')
  })

  it('按 id 切也行', async () => {
    const r = await run({ vault: 'v_default' })

    expect(r.success).toBe(true)
    expect(vaultManager.switchToVault).toHaveBeenCalledWith('v_default')
  })

  it('已经在那个库上就不白切一趟', async () => {
    const r = await run({ vault: 'AIGC 资产库' })

    expect(vaultManager.switchToVault).not.toHaveBeenCalled()
    expect(r.already_active).toBe(true)
  })

  it('明确交代事情做完不用切回去 —— 偷偷切回来是第二次意外', async () => {
    const r = await run({ vault: '默认保管库' })

    expect(String(r.message)).toContain('不用切回去')
  })
})

describe('切不过去的时候', () => {
  it('库名不存在就报错，并把有哪些库列出来', async () => {
    const r = await run({ vault: '不存在的库' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('默认保管库')
    expect(vaultManager.switchToVault).not.toHaveBeenCalled()
  })

  it('底层报失败就照实说，不算切成功', async () => {
    vaultManager.switchToVault.mockResolvedValue({ success: false, error: '库文件不存在' })

    const r = await run({ vault: '默认保管库' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('库文件不存在')
  })

  /**
   * 这条最要紧：切换命令跑完了但活跃库其实没变，还报成功的话，
   * 后面每一个写操作都会打在用户以为已经离开的那个库上。
   */
  it('回读对不上就不许报成功，并且叫停后续改动', async () => {
    vaultManager.switchToVault.mockResolvedValue({ success: true }) // 但 current 没变

    const r = await run({ vault: '默认保管库' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('没有确认切过去')
    expect(String(r.error)).toContain('别在这个状态下继续做改动')
  })

  it('网络库启动有问题时照样算切成功，但要把警告带出来', async () => {
    vaultManager.switchToVault.mockImplementation(async (id: string) => {
      current = [DEFAULT_VAULT, AIGC_VAULT].find((v) => v.id === id)!
      return { success: true, networkError: '同步服务没起来' }
    })

    const r = await run({ vault: '默认保管库' })

    expect(r.success).toBe(true)
    expect(r.network_warning).toBe('同步服务没起来')
  })
})
