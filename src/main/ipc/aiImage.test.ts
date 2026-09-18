/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 注册时被 ipcMain.handle 收走的那些处理函数，按频道名存起来 */
const handlers = new Map<string, (event: unknown, params: unknown) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, params: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }
  }
}))

vi.mock('../sqliteDataBase', () => ({ getPublicDatabase: () => ({}) }))
vi.mock('../sqliteDataBase/models/aiImageGeneration', () => ({
  listAiImageGenerations: () => [],
  getAiImageGenerationByTaskId: () => null,
  deleteAiImageGeneration: () => undefined,
  updateAiImageGeneration: () => undefined,
  countAiImageGenerations: () => 0
}))

const startGeneration = vi.fn()

vi.mock('../services/imagePollingService', () => ({
  imagePollingService: {
    startGeneration: (...args: unknown[]) => startGeneration(...args)
  }
}))

const { registerAiImageIPC } = await import('./aiImage')

registerAiImageIPC()

const event = { sender: { id: 1 } }

beforeEach(() => {
  startGeneration.mockReset()
  startGeneration.mockResolvedValue({ success: true })
})

/** 生图 IPC 不读取或转发应用账户令牌，模型凭据由主进程配置解析。 */
describe('图片生成 IPC 的参数边界', () => {
  it('令牌是空串时照常发起生成，而不是挡在门口', async () => {
    const result = await handlers.get('image:startGeneration')!(event, {
      taskId: 't1',
      prompt: '一把中世纪的剑',
      token: ''
    })

    expect(result).toMatchObject({ success: true })
    expect(startGeneration, '空令牌被挡下了，本地生图这条路走不通').toHaveBeenCalledTimes(1)
  })

  it('丢弃旧调用方的账户令牌，仅转发生图参数和窗口 ID', async () => {
    await handlers.get('image:startGeneration')!(event, {
      taskId: 't2',
      prompt: 'x',
      token: 'legacy-test-session'
    })

    expect(startGeneration.mock.calls[0]).toHaveLength(3)
    expect(startGeneration.mock.calls[0][1]).not.toHaveProperty('token')
    expect(startGeneration.mock.calls[0][2]).toBe(event.sender.id)
  })

  /** 该挡的还是要挡：没有提示词是真的没法出图，与令牌无关 */
  it('提示词为空时仍然挡下来', async () => {
    const result = await handlers.get('image:startGeneration')!(event, {
      taskId: 't4',
      prompt: '   ',
      token: ''
    })

    expect(result).toMatchObject({ success: false })
    expect(startGeneration).not.toHaveBeenCalled()
  })
})
