/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelAssetImport } from '../../../services/asset/importControl'

type ScanResult = {
  success: boolean
  cancelled?: boolean
  data: Array<{ path: string }>
  diagnostics: { skippedItems: Array<{ path: string }> }
}
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<ScanResult>>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<ScanResult>) =>
      handlers.set(name, handler)
  }
}))
vi.mock('../../../utils/fileProcessor/FileProcessorManager', () => ({
  FileProcessorManager: class {}
}))
const { registerAssetFsIPC } = await import('./fsHandlers')
registerAssetFsIPC()
let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'scan-regression-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

describe('complete scan result', () => {
  it.each([299, 300, 301])('returns every file at the streaming boundary %s', async (count) => {
    await Promise.all(
      Array.from({ length: count }, (_, i) => fs.writeFile(join(root, `${i}.txt`), 'a'))
    )
    await fs.mkdir(join(root, 'nested'))
    await fs.writeFile(join(root, 'nested', 'child.txt'), 'b')
    const send = vi.fn()
    const result = await handlers.get('fs:readFolderContentsRecursive')!(
      { sender: { send } },
      root,
      { taskId: 'scan' }
    )
    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(count + 2)
    expect(new Set(result.data.map((item) => item.path)).size).toBe(count + 2)
    expect(send.mock.calls.every(([, payload]) => payload.taskId === 'scan')).toBe(true)
  })

  it('reports an unreadable directory without inventing the number of files inside', async () => {
    const missing = join(root, 'unavailable')
    const result = await handlers.get('fs:readFolderContentsRecursive')!(
      { sender: { send: vi.fn() } },
      missing,
      { taskId: 'scan' }
    )
    expect(result.data).toEqual([])
    expect(result.diagnostics.skippedItems[0].path).toBe(missing)
  })

  it('cancellation during a batch stops the scan and releases its lifetime', async () => {
    await fs.mkdir(join(root, 'nested'))
    const result = await handlers.get('fs:readFolderContentsRecursive')!(
      { sender: { send: () => cancelAssetImport('scan') } },
      root,
      { taskId: 'scan' }
    )
    expect(result.cancelled).toBe(true)
    expect(cancelAssetImport('scan')).toBe(false)
  })
})
