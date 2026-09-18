import { describe, expect, it } from 'vitest'
import { buildRemoteImportFilePath, findActiveRemoteAssetByPath } from './remoteImportPath'

describe('remote import path helpers', () => {
  it('builds the same remote path for folder-session uploads', () => {
    const remotePath = buildRemoteImportFilePath(
      { path: 'D:\\Projects\\角色\\日本病人01\\基础动画\\Idle.uasset', name: 'Idle.uasset' },
      'D:\\Projects\\角色\\日本病人01',
      '角色'
    )

    expect(remotePath).toBe('角色/日本病人01/基础动画/Idle.uasset')
  })

  it('builds target-scoped paths for single-file uploads', () => {
    const remotePath = buildRemoteImportFilePath(
      { path: 'D:\\Exports\\Idle.uasset', name: 'Idle.uasset' },
      'ALL',
      '角色/日本病人01/基础动画'
    )

    expect(remotePath).toBe('角色/日本病人01/基础动画/Idle.uasset')
  })

  it('finds an existing active asset by normalized remote path', () => {
    const row = { assetKey: 'asset_existing', filePath: '角色\\日本病人01\\基础动画\\Idle.uasset' }
    const observed: unknown[][] = []
    const db = {
      prepare: () => ({
        get: (...args: unknown[]) => {
          observed.push(args)
          return row
        }
      })
    }

    expect(findActiveRemoteAssetByPath(db as any, '角色/日本病人01/基础动画/Idle.uasset')).toBe(row)
    expect(observed[0]).toEqual([
      '角色/日本病人01/基础动画/Idle.uasset',
      '角色\\日本病人01\\基础动画\\Idle.uasset',
      '角色/日本病人01/基础动画/Idle.uasset',
      '角色\\日本病人01\\基础动画\\Idle.uasset'
    ])
  })
})
