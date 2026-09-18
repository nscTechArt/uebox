/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

vi.mock('../sqliteDataBase', () => ({
  getPublicDatabase: () => null,
  getVaultDatabase: () => null
}))
vi.mock('../sqliteDataBase/index', () => ({
  getPublicDatabase: () => null,
  getVaultDatabase: () => null
}))
vi.mock('../sqliteDataBase/models/project', () => ({ searchProjects: vi.fn() }))
vi.mock('../sqliteDataBase/models/assetData', () => ({ searchAssetDataByName: vi.fn() }))
vi.mock('../services', () => ({ logger: { debug: vi.fn() } }))

const { registerSpotlightIPC } = await import('./spotlight')
registerSpotlightIPC()

describe('Spotlight 搜索结果', () => {
  it('不再提供保存到知识库选项', async () => {
    const response = await handlers.get('spotlight:search')!({}, '55')

    expect(response).toMatchObject({
      success: true,
      data: [{ type: 'ai' }]
    })
    expect(JSON.stringify(response)).not.toContain('保存到知识库')
    expect(JSON.stringify(response)).not.toContain('knowledge')
  })
})
