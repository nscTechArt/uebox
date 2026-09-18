/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

let root: string
vi.mock('../PathManager', () => ({
  PathManager: {
    getInstance: () => ({
      getAssetDataPath: () => root,
      getRelativeToVault: (path: string) => relative(root, path)
    })
  }
}))
import { AssetBackupManager } from './AssetBackupManager'

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'backup-safety-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})
describe('backup safety', () => {
  it('maps a drive-root source to a filename rather than a drive segment', () => {
    expect(new AssetBackupManager().parseSoftPath('C:/asset')).toEqual(['asset'])
  })
  it('a read failure removes only the file reserved by this copy', async () => {
    const manager = new AssetBackupManager()
    const target = await manager.createTimestampFolder()
    const source = join(root, 'unreadable.uasset')
    await fs.mkdir(source)
    await expect(manager.backupAssetFile(source, target, '/Game/unreadable')).rejects.toThrow()
    expect(await fs.readdir(join(target, 'Game'))).toEqual([])
  })
  it.each([
    '/Game/../../escaped/a',
    '/Game/..\\..\\escaped/a',
    '/Game/C:/escaped/a',
    '/Game/.. /escaped/a'
  ])('rejects unsafe metadata paths before writing: %s', async (softPath) => {
    const manager = new AssetBackupManager()
    const target = await manager.createTimestampFolder()
    const source = join(root, 'a.uasset')
    await fs.writeFile(source, 'source')
    await expect(manager.backupAssetFile(source, target, softPath)).rejects.toThrow()
    expect(await fs.readdir(target)).toEqual([])
  })
  it('concurrent batches never share a timestamp directory', async () => {
    const manager = new AssetBackupManager()
    const paths = await Promise.all([
      manager.createTimestampFolder(),
      manager.createTimestampFolder()
    ])
    expect(paths[0]).not.toBe(paths[1])
  })
  it('a second source cannot overwrite a package with the same destination', async () => {
    const manager = new AssetBackupManager()
    const target = await manager.createTimestampFolder()
    await fs.mkdir(join(root, 'a'))
    await fs.mkdir(join(root, 'b'))
    const first = join(root, 'a', 'asset.uasset'),
      second = join(root, 'b', 'asset.uasset')
    await fs.writeFile(first, 'first')
    await fs.writeFile(second, 'second')
    const saved = await manager.backupAssetFile(first, target, '/Game/asset')
    await expect(manager.backupAssetFile(second, target, '/Game/asset')).rejects.toThrow()
    expect(await fs.readFile(saved, 'utf8')).toBe('first')
  })
  it('a cancelled batch starts no further files', async () => {
    const controller = new AbortController()
    controller.abort()
    const manager = new AssetBackupManager()
    await expect(
      manager.batchBackupAssets(
        [{ sourcePath: 'missing', softPath: '/Game/a', assetKey: 'a' }],
        root,
        undefined,
        controller.signal
      )
    ).rejects.toThrow()
    expect(await fs.readdir(root)).toEqual([])
  })
})
