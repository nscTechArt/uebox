import { describe, expect, it } from 'vitest'
import {
  beginAssetImport,
  finishAssetImport,
  cancelAssetImport,
  beginImportVaultSwitch,
  finishImportVaultSwitch
} from './importControl'

describe('import lifetime isolation', () => {
  it('cancellation does not release the vault until in-flight work has settled', () => {
    const a = beginAssetImport('a')
    const b = beginAssetImport('b')
    try {
      expect(cancelAssetImport('a')).toBe(true)
      expect(a.signal.aborted).toBe(true)
      expect(b.signal.aborted).toBe(false)
      expect(() => beginImportVaultSwitch()).toThrow('资产正在导入')
      finishAssetImport('a', a)
      expect(() => beginImportVaultSwitch()).toThrow('资产正在导入')
    } finally {
      finishAssetImport('a', a)
      finishAssetImport('b', b)
    }
    beginImportVaultSwitch()
    try {
      expect(() => beginAssetImport('c')).toThrow('正在切换保管库')
    } finally {
      finishImportVaultSwitch()
    }
    const c = beginAssetImport('c')
    finishAssetImport('c', c)
    expect(cancelAssetImport('c')).toBe(false)
  })
})
