/**
 * @vitest-environment node
 *
 * widget_preview 要把插件实际用的 DPI 缩放说出来。
 *
 * 游戏里 UMG 按项目 DPI 曲线缩放（默认按短边），1280x720 下 1080p 的布局会整体缩到 2/3。
 * 预览按同一条曲线画，文案里不说缩放，模型看到字变小会去「修」字号。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRequest, getConnectionCount } = vi.hoisted(() => ({
  callRequest: vi.fn(),
  getConnectionCount: vi.fn()
}))

vi.mock('../../../../services', () => ({
  serviceManager: { getWebSocketService: () => ({ getConnectionCount, callRequest }) }
}))
vi.mock('../../../core/projectTargetContext', () => ({ getTargetConnectionId: () => undefined }))
vi.mock('../../contextImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contextImage')>()),
  compressForContext: vi.fn(async () => ({ data: 'ZmFrZQ==', mimeType: 'image/jpeg' }))
}))
vi.mock('fs', () => ({ promises: { readFile: vi.fn(async () => Buffer.from('png')) } }))

import { previewWidgetTool } from './previewWidget'

type Result = Record<string, unknown>
const run = (input: Record<string, unknown>): Promise<Result> =>
  (previewWidgetTool().execute as (i: unknown, o: unknown) => Promise<Result>)(input, {})

beforeEach(() => {
  getConnectionCount.mockReset().mockReturnValue(1)
  callRequest.mockReset()
})

describe('widget_preview 的 DPI 缩放', () => {
  it('插件回了 dpi_scale：透传字段，文案写出缩放', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: 'C:/P/Saved/Screenshots/UAL/widget_preview_WBP_Hud_1.png',
      width: 1280,
      height: 720,
      dpi_scale: 0.6666667
    })

    const r = await run({ path: '/Game/UI/WBP_Hud', width: 1280, height: 720 })

    expect(r.ok).toBe(true)
    expect(r.dpi_scale).toBeCloseTo(0.6667, 3)
    expect(String(r.message)).toContain('1280x720')
    expect(String(r.message)).toContain('DPI 缩放 0.667')
  })

  it('旧插件不回 dpi_scale：不编一个缩放出来', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: 'C:/P/Saved/Screenshots/UAL/widget_preview_WBP_Hud_1.png',
      width: 1920,
      height: 1080
    })

    const r = await run({ path: '/Game/UI/WBP_Hud' })

    expect(r.ok).toBe(true)
    expect(r).not.toHaveProperty('dpi_scale')
    expect(String(r.message)).not.toContain('DPI')
  })
})
