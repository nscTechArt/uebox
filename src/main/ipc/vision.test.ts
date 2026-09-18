/** @vitest-environment node */
import { beforeEach, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const handlers = new Map<string, IpcHandler>()
const mocks = vi.hoisted(() => ({
  analyzeConfigured: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }
  },
  net: { request: vi.fn() }
}))
vi.mock('../services/configuredImageAnalysis', () => ({
  analyzeImageWithConfiguredModel: vi.fn(),
  hasConfiguredVisionModel: vi.fn().mockResolvedValue(false),
  NO_VISION_MODEL_HINT: 'no-vision-model-hint'
}))
vi.mock('../services/videoAnalysis/configuredVideoAnalysis', () => ({
  analyzeVideoWithConfiguredModel: (...args: unknown[]) => mocks.analyzeConfigured(...args)
}))

const { registerVisionIPC } = await import('./vision')
registerVisionIPC()

beforeEach(() => {
  mocks.analyzeConfigured.mockReset()
})

it('视频附件优先交给用户勾选的视频模型', async () => {
  mocks.analyzeConfigured.mockResolvedValue({
    success: true,
    markdown: '本地模型结果',
    content: '本地模型结果'
  })

  const result = await handlers.get('vision:analyze')!(
    {},
    {
      mediaUrl: 'data:video/mp4;base64,AAAA',
      mediaType: 'video'
    }
  )

  expect(result).toMatchObject({ success: true, markdown: '本地模型结果' })
  expect(mocks.analyzeConfigured).toHaveBeenCalledWith({
    data: 'AAAA',
    mimeType: 'video/mp4',
    prompt: undefined
  })
})
