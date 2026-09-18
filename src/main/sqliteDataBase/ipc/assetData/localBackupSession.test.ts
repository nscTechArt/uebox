import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackupAssetInfo } from '../../../utils/assetBackup'

let root: string
vi.mock('../../../utils/PathManager', () => ({
  PathManager: {
    getInstance: () => ({
      getAssetDataPath: () => join(root, 'archive'),
      getCurrentVaultPath: () => root
    })
  }
}))
import { LocalBackupSession } from './localBackupSession'

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'local-backup-session-'))
})
afterEach(async () => {
  if (!root.startsWith(join(tmpdir(), 'local-backup-session-')))
    throw new Error('Unsafe test cleanup')
  await fs.rm(root, { recursive: true, force: true })
})
async function asset(name: string, imports: string[] = []): Promise<BackupAssetInfo> {
  const sourcePath = join(root, name + '.uasset')
  await fs.writeFile(sourcePath, name)
  return { sourcePath, assetKey: name, softPath: '/Game/' + name, imports }
}
const signal = (): AbortSignal => new AbortController().signal
const progress = (): void => {}

describe('local backup settlement', () => {
  it('settles package sidecars with their owner rather than splitting archives', async () => {
    const owner = await asset('owner')
    const sidecar = {
      ...owner,
      sourcePath: join(root, 'owner.ubulk'),
      assetKey: 'bulk',
      softPath: '/Other/owner'
    }
    await fs.writeFile(sidecar.sourcePath, 'bulk')
    const session = new LocalBackupSession(root)
    await session.prepare(
      [owner.sourcePath, sidecar.sourcePath],
      [owner, sidecar],
      [],
      signal(),
      progress
    )
    session.retain(owner.sourcePath)
    await session.cleanup()
    expect(
      await fs.readFile(join(root, session.paths.get('owner')!, '..', 'owner.ubulk'), 'utf8')
    ).toBe('bulk')
  })
  it('keeps a healthy asset while a missing dependency blocks only its owner', async () => {
    const healthy = await asset('healthy'),
      owner = await asset('owner', ['/Game/dep']),
      dep = await asset('dep')
    await fs.unlink(dep.sourcePath)
    const session = new LocalBackupSession(root)
    await session.prepare(
      [healthy.sourcePath, owner.sourcePath],
      [healthy, owner, dep],
      [],
      signal(),
      progress
    )
    expect(session.paths.has(healthy.assetKey)).toBe(true)
    expect(session.paths.has(owner.assetKey)).toBe(false)
    expect(session.failures[0]).toMatchObject({
      path: owner.sourcePath,
      error: expect.stringContaining(dep.sourcePath)
    })
    session.retain(healthy.sourcePath)
    await session.cleanup()
    const healthyPath = join(root, session.paths.get(healthy.assetKey)!)
    expect(await fs.readFile(healthyPath, 'utf8')).toBe('healthy')
    expect(await fs.readdir(join(healthyPath, '..'))).toEqual(['healthy.uasset'])
  })

  it('reuses a complete relative-path archive without allocating another batch', async () => {
    const owner = await asset('owner', ['/Game/dep.dep']),
      dep = await asset('dep')
    const first = new LocalBackupSession(root)
    await first.prepare([owner.sourcePath], [owner, dep], [], signal(), progress)
    first.retain(owner.sourcePath)
    await first.cleanup()
    const batches = await fs.readdir(join(root, 'archive'))
    const second = new LocalBackupSession(root)
    await second.prepare(
      [owner.sourcePath],
      [owner, dep],
      [{ originPath: owner.sourcePath, filePath: first.paths.get(owner.assetKey) }],
      signal(),
      progress
    )
    expect(second.paths.get(owner.assetKey)).toBe(first.paths.get(owner.assetKey))
    await second.cleanup()
    expect(await fs.readdir(join(root, 'archive'))).toEqual(batches)
  })

  it('does not reuse a root whose archived dependency is corrupt', async () => {
    const owner = await asset('owner', ['/Game/dep']),
      dep = await asset('dep')
    const first = new LocalBackupSession(root)
    await first.prepare([owner.sourcePath], [owner, dep], [], signal(), progress)
    first.retain(owner.sourcePath)
    await first.cleanup()
    const oldPath = first.paths.get(owner.assetKey)!
    await fs.writeFile(join(root, oldPath, '..', 'dep.uasset'), 'corrupt')
    const next = new LocalBackupSession(root)
    await next.prepare(
      [owner.sourcePath],
      [owner, dep],
      [{ originPath: owner.sourcePath, filePath: oldPath }],
      signal(),
      progress
    )
    expect(next.paths.get(owner.assetKey)).not.toBe(oldPath)
    next.retain(owner.sourcePath)
    await next.cleanup()
    expect(
      await fs.readFile(join(root, next.paths.get(owner.assetKey)!, '..', 'dep.uasset'), 'utf8')
    ).toBe('dep')
  })

  it('cleans all new copies after cancellation before database writes', async () => {
    const a = await asset('a'),
      b = await asset('b'),
      controller = new AbortController()
    const session = new LocalBackupSession(root)
    await expect(
      session.prepare([a.sourcePath, b.sourcePath], [a, b], [], controller.signal, () =>
        controller.abort()
      )
    ).rejects.toThrow()
    await session.cleanup()
    expect(await fs.readdir(join(root, 'archive'))).toEqual([])
    expect(await fs.readFile(a.sourcePath, 'utf8')).toBe('a')
  })

  it('cleans rejected database writes while preserving shared dependencies of accepted assets', async () => {
    const a = await asset('a', ['/Game/dep']),
      b = await asset('b', ['/Game/dep']),
      dep = await asset('dep')
    const session = new LocalBackupSession(root)
    await session.prepare([a.sourcePath, b.sourcePath], [a, b, dep], [], signal(), progress)
    session.retain(b.sourcePath)
    await session.cleanup()
    await expect(fs.stat(join(root, session.paths.get('a')!))).rejects.toThrow()
    expect(await fs.readFile(join(root, session.paths.get('b')!, '..', 'dep.uasset'), 'utf8')).toBe(
      'dep'
    )
  })

  it('imports an asset whose missing dependency is only a soft reference', async () => {
    // UE 允许软引用指向工程里没有的资产（引用 Epic 默认 Mannequin 的姿势资产就是这样），
    // 拿它拦截会把一批能用的资产整组拒收
    const owner = await asset('owner', ['/Game/hard', '/Game/soft'])
    owner.importsStrong = ['/Game/hard']
    const hard = await asset('hard')
    const session = new LocalBackupSession(root)
    await session.prepare([owner.sourcePath], [owner, hard], [], signal(), progress)

    expect(session.failures).toEqual([])
    expect(session.paths.has(owner.assetKey)).toBe(true)
    // 不拦截，但也不许悄悄吞掉
    expect([...session.softMisses]).toEqual(['/Game/soft'])
  })

  it('still blocks when the missing dependency is a hard reference', async () => {
    const owner = await asset('owner', ['/Game/hard'])
    owner.importsStrong = ['/Game/hard']
    const session = new LocalBackupSession(root)
    await session.prepare([owner.sourcePath], [owner], [], signal(), progress)

    expect(session.paths.has(owner.assetKey)).toBe(false)
    expect(session.failures[0]).toMatchObject({
      error: expect.stringContaining('/Game/hard')
    })
    expect([...session.softMisses]).toEqual([])
  })

  it('falls back to blocking on every missing dependency when importsStrong is absent', async () => {
    const owner = await asset('owner', ['/Game/dep'])
    const session = new LocalBackupSession(root)
    await session.prepare([owner.sourcePath], [owner], [], signal(), progress)

    expect(session.paths.has(owner.assetKey)).toBe(false)
    expect(session.failures).toHaveLength(1)
  })
})
