// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ statfs: vi.fn(), exec: vi.fn() }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, statfsSync: mocks.statfs }
})
vi.mock('child_process', () => ({ execSync: mocks.exec }))
vi.mock('better-sqlite3', () => ({ default: vi.fn() }))
import { getAvailableDiskSpace } from './utils'

beforeEach(() => {
  mocks.statfs.mockReset()
  mocks.exec.mockReset()
})
afterEach(() => vi.restoreAllMocks())

it('queries the target volume on Mac and uses space available to the current user', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  mocks.statfs.mockReturnValue({ bsize: 4096n, bavail: 100n, bfree: 200n })
  expect(getAvailableDiskSpace('/Volumes/中文 Backup')).toBe(409600)
  expect(mocks.statfs).toHaveBeenCalledWith('/Volumes/中文 Backup', { bigint: true })
  expect(mocks.exec).not.toHaveBeenCalled()
})

it('reports a full volume as zero and query failures as unknown', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  mocks.statfs.mockReturnValue({ bsize: 4096n, bavail: 0n })
  expect(getAvailableDiskSpace('/backup')).toBe(0)
  mocks.statfs.mockImplementation(() => {
    throw new Error('EACCES')
  })
  expect(getAvailableDiskSpace('/backup')).toBe(-1)
})

it('keeps oversized values within safe numeric bounds and rejects invalid values', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  mocks.statfs.mockReturnValue({ bsize: 4096n, bavail: BigInt(Number.MAX_SAFE_INTEGER) })
  expect(getAvailableDiskSpace('/backup')).toBe(Number.MAX_SAFE_INTEGER)
  mocks.statfs.mockReturnValue({ bsize: 4096n, bavail: -1n })
  expect(getAvailableDiskSpace('/backup')).toBe(-1)
})

it('retains the Windows query and result interpretation', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  mocks.exec.mockReturnValue('FreeSpace=123456789\r\n')
  expect(getAvailableDiskSpace('D:\\Backup')).toBe(123456789)
  expect(mocks.exec).toHaveBeenCalledWith(
    expect.stringContaining("DeviceID='D:'"),
    expect.any(Object)
  )
  expect(mocks.statfs).not.toHaveBeenCalled()
  mocks.exec.mockImplementation(() => {
    throw new Error('wmic unavailable')
  })
  expect(getAvailableDiskSpace('D:\\Backup')).toBe(-1)
})
