import { describe, expect, it, vi } from 'vitest'

// 取消 tests/setup.ts 里对 better-sqlite3 的全局 mock —— 这里要真的读 pragma
vi.unmock('better-sqlite3')

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyVaultConnectionPragmas, isPathInside } from './vaultConnectionPragmas'

describe('applyVaultConnectionPragmas', () => {
  it('temp_store 放内存；内存映射只在明确允许时开', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-pragmas-'))
    try {
      const plain = new Database(join(dir, 'a.db'))
      applyVaultConnectionPragmas(plain)
      expect(plain.pragma('temp_store', { simple: true })).toBe(2)
      expect(plain.pragma('mmap_size', { simple: true })).toBe(0)
      expect(plain.pragma('journal_mode', { simple: true })).toBe('wal')
      plain.close()

      const mapped = new Database(join(dir, 'b.db'))
      applyVaultConnectionPragmas(mapped, { mmap: true })
      expect(Number(mapped.pragma('mmap_size', { simple: true }))).toBeGreaterThan(0)
      mapped.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('isPathInside', () => {
  const root = join('C:', 'Users', 'me', 'AppData', 'Roaming', 'unreal-box', 'database', 'vaults')

  it('userData 下的保管库算在里面', () => {
    expect(isPathInside(join(root, 'vault_1', 'vault-data.db'), root)).toBe(true)
  })

  it('自选目录、别的盘、往上跳出去的都不算（这些库不开内存映射）', () => {
    expect(isPathInside(join('D:', 'MyVaults', 'vault-data.db'), root)).toBe(false)
    expect(isPathInside(join(root, '..', 'other.db'), root)).toBe(false)
    expect(isPathInside(root, root)).toBe(false)
  })
})
