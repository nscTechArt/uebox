/** @vitest-environment node */
import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ dir: '', records: new Map<string, { assetKey: string }>() }))
vi.mock('../aigcVaultService', () => ({
  assertAIGCVaultLocalWritesAllowed: vi.fn(),
  ensureAIGCDirectory: async (): Promise<string> => state.dir,
  ensureFolderRecord: vi.fn(),
  getAIGCSubdirName: (): string => '音乐',
  withAIGCVaultDatabase: async (operation: (db: unknown) => unknown): Promise<unknown> =>
    operation({
      prepare: () => ({ get: (path: string) => state.records.get(path) })
    })
}))
vi.mock('../../sqliteDataBase/models/assetData', () => ({
  createAssetData: vi.fn((_db: unknown, asset: { filePath: string; assetKey: string }) => {
    state.records.set(asset.filePath, asset)
  })
}))
import { saveLocalMusicAsset } from './assetSaver'

afterEach(async () => {
  if (state.dir) await fs.rm(state.dir, { recursive: true, force: true })
  state.records.clear()
})

it('keeps same-named tracks with different content separate and reuses identical audio on retry', async () => {
  state.dir = await fs.mkdtemp(join(tmpdir(), 'music-vault-test-'))
  await fs.mkdir(join(state.dir, 'first'))
  await fs.mkdir(join(state.dir, 'second'))
  const first = join(state.dir, 'first', 'same-title.mp3')
  const second = join(state.dir, 'second', 'same-title.mp3')
  await fs.writeFile(first, Buffer.from([1, 2]))
  await fs.writeFile(second, Buffer.from([3, 4]))
  const a = await saveLocalMusicAsset(first, 'calm')
  const b = await saveLocalMusicAsset(second, 'calm')
  expect(a.filePath).not.toBe(b.filePath)
  expect(await fs.readFile(a.filePath)).toEqual(await fs.readFile(first))
  expect(await fs.readFile(b.filePath)).toEqual(await fs.readFile(second))
  expect(await saveLocalMusicAsset(first, 'calm')).toEqual(a)
  expect(state.records.size).toBe(2)
})
