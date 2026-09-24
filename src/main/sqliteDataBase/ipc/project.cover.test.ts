import { beforeEach, expect, it, vi } from 'vitest'
import { registerProjectIPC } from './project'

const { handlers, save, update } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  save: vi.fn(),
  update: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('../index', () => ({ getPublicDatabase: vi.fn() }))
vi.mock('../models/project', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../models/project')>()),
  updateProject: update
}))
vi.mock('../../appSettingsManager', () => ({ appSettingsManager: {} }))
vi.mock('../../utils/fileProcessor/UnrealAssetProcessor', () => ({ UnrealAssetProcessor: vi.fn() }))
vi.mock('../../utils/UnrealPathManager', () => ({ default: {} }))
vi.mock('../../utils/UnrealProcessDetector', () => ({ default: {} }))
vi.mock('../../services/project/projectCoverRuntime', () => ({
  getProjectCoverService: () => ({ save })
}))

beforeEach(() => {
  handlers.clear()
  save.mockReset().mockResolvedValue('cover.jpg')
  update.mockReset().mockReturnValue(true)
  registerProjectIPC()
})

function saveCover(image: unknown): Promise<unknown> {
  const handler = handlers.get('db:project:saveCover')
  if (!handler) throw new Error('Cover handler not registered')
  return handler(undefined, 'project-one', image)
}

it('accepts cloned byte views without including bytes outside the view', async () => {
  const image = structuredClone(new Uint8Array([99, 0, 128, 255, 99]).subarray(1, 4))
  expect(await saveCover(image)).toEqual({ success: true, data: 'cover.jpg' })
  expect(save).toHaveBeenCalledWith('project-one', new Uint8Array([0, 128, 255]))
})

it.each([
  null,
  [0, 128, 255],
  new Uint16Array([256]),
  new ArrayBuffer(3),
  new Uint8Array(),
  new Uint8Array(32 * 1024 * 1024 + 1)
])('rejects malformed, empty, or oversized payload %# before writing', async (image) => {
  expect(await saveCover(image)).toEqual({ success: false, data: '', error: 'Invalid cover image' })
  expect(save).not.toHaveBeenCalled()
})

it('accepts the existing 32 MiB size limit', async () => {
  expect(await saveCover(new Uint8Array(32 * 1024 * 1024))).toEqual({
    success: true,
    data: 'cover.jpg'
  })
})

it('returns a storage failure without reporting a saved cover', async () => {
  save.mockRejectedValueOnce(new Error('Storage unavailable'))
  expect(await saveCover(new Uint8Array([1]))).toEqual({
    success: false,
    data: '',
    error: 'Storage unavailable'
  })
})

it('generic project updates cannot change the cover behind the cover service', async () => {
  const handler = handlers.get('db:project:update')
  if (!handler) throw new Error('Update handler not registered')
  const updates = { projectName: 'Renamed', image: 'elsewhere.png', coverMode: 'custom' }
  expect(await handler(undefined, 'project-one', updates)).toEqual({ success: true, data: true })
  expect(update).toHaveBeenCalledWith(undefined, 'project-one', { projectName: 'Renamed' })
})
