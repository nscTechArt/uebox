import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDefaultNetworkVaultCopyDeps, runNetworkVaultCopy } from './networkVaultCopy'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-copy-content-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('network copy content verification', () => {
  it('two sources cannot silently overwrite the same destination in a new directory', async () => {
    const a = join(dir, 'a.bin'),
      b = join(dir, 'b.bin')
    writeFileSync(a, 'first')
    writeFileSync(b, 'second')
    const confirmOverwrite = vi.fn(async () => ({ action: 'skip' as const }))
    const target = join(dir, 'new-target')
    const report = await runNetworkVaultCopy(
      {
        files: [
          { name: 'asset.bin', path: a },
          { name: 'asset.bin', path: b }
        ],
        networkPath: target,
        rootFolderPath: 'ALL',
        targetFolderFullPath: '',
        concurrency: 2
      },
      createDefaultNetworkVaultCopyDeps({ confirmOverwrite, onProgress: () => undefined })
    )
    expect(report.copied).toBe(1)
    expect(report.skipped).toBe(1)
    expect(confirmOverwrite).toHaveBeenCalledOnce()
    expect(readFileSync(join(target, 'asset.bin'), 'utf8')).toBe('first')
  })

  it.each([false, true])(
    'compares bytes outside sampled regions (identical=%s)',
    async (identical) => {
      const source = join(dir, 'source.bin')
      const targetDir = join(dir, 'target')
      const target = join(targetDir, 'asset.bin')
      mkdirSync(targetDir)
      const original = Buffer.alloc(1024 * 1024, 42)
      const incoming = Buffer.from(original)
      if (!identical) incoming[256 * 1024] = 99
      writeFileSync(source, incoming)
      writeFileSync(target, original)
      const confirmOverwrite = vi.fn(async () => ({ action: 'overwrite' as const }))

      const result = await runNetworkVaultCopy(
        {
          files: [{ name: 'asset.bin', path: source }],
          networkPath: targetDir,
          rootFolderPath: 'ALL',
          targetFolderFullPath: '',
          concurrency: 1
        },
        createDefaultNetworkVaultCopyDeps({ confirmOverwrite, onProgress: () => undefined })
      )

      expect(result.identical).toBe(identical ? 1 : 0)
      expect(result.copied).toBe(identical ? 0 : 1)
      expect(confirmOverwrite).toHaveBeenCalledTimes(identical ? 0 : 1)
      expect(readFileSync(target).equals(incoming)).toBe(true)
    }
  )
})
