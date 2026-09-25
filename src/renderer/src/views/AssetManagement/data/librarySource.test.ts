/**
 * 数据源接缝：本地库原样转发（参数个数都不变），服务器库把 catalog 的数据翻成本地库的形状。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const local = vi.hoisted(() => ({
  folder: {
    getRootFolders: vi.fn(async () => []),
    getByFatherKey: vi.fn(async () => []),
    getByKey: vi.fn(async () => undefined),
    getChildCount: vi.fn(async () => 3),
    getPathArray: vi.fn(async () => ['ALL'])
  },
  data: {
    getByFolderKey: vi.fn(async () => []),
    getCountByFolderKey: vi.fn(async () => 7),
    getById: vi.fn(async () => undefined),
    getImportStatus: vi.fn(async () => ({ total: 0, unresolvedCount: 0, items: [] })),
    getDistinctAssetTypes: vi.fn(async () => [])
  }
}))
vi.mock('@renderer/api/assetFolder', () => ({
  assetFolderAPI: local.folder,
  default: local.folder
}))
vi.mock('@renderer/api/assetData', () => ({ default: local.data, assetDataAPI: local.data }))

import { localLibrarySource, LOCAL_CAPABILITIES } from './LocalLibrarySource'
import {
  ServerLibrarySource,
  dirIdOf,
  folderKeyOf,
  importStatusOf,
  mapAsset,
  serverCapabilities,
  softPathOf
} from './ServerLibrarySource'
import { getActiveLibrarySource, setActiveLibrarySource } from './activeLibrarySource'
import { catalogErrorOf, catalogErrorText } from '../catalog/catalogErrors'
import { CatalogApiError } from '@renderer/api/catalogLibrary'
import { classIcon, displayName, formatSize, shortFingerprint } from '../catalog/catalogDisplay'

const folder = (
  dirId: number,
  path: string,
  extra: Partial<Record<string, number>> = {}
): Record<string, unknown> => ({
  dirId,
  path,
  name: path.split('/').pop() ?? '',
  nDirect: 2,
  nSubtree: 10,
  bytes: 100,
  nDirs: 1,
  ...extra
})

let bridge: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  bridge = {
    folders: vi.fn(async (_key: string, parent: number) => ({
      success: true,
      data:
        parent === 0
          ? { folder: folder(0, '', { nDirs: 1 }), items: [folder(1, 'Content')], stale: false }
          : {
              folder: folder(parent, 'Content'),
              items: [folder(5, 'Content/Props', { nDirs: 0 })],
              stale: false
            }
    })),
    folderByPath: vi.fn(async (_key: string, path: string) => ({
      success: true,
      data: folder(path === 'Content' ? 1 : 5, path)
    })),
    listWindow: vi.fn(async () => ({
      success: true,
      data: {
        start: 0,
        items: [
          {
            id: 42,
            path: 'Content/Props/SM_Chair.uasset',
            name: 'SM_Chair.uasset',
            dirId: 5,
            repository: 'repo-a',
            ext: '.uasset',
            class: 'StaticMesh',
            engine: '5.4',
            size: 2048,
            modifiedMs: 1_700_000_000_000,
            tags: ['wood'],
            previewUrl: 'uebox-preview://thumb/ab/s256?l=k&u=x'
          }
        ],
        total: { value: 1, exact: true }
      }
    })),
    facets: vi.fn(async () => ({
      success: true,
      data: {
        total: { value: 1, exact: true },
        facets: { class: [{ value: 'StaticMesh', n: 3 }], engine: [{ value: '5.4', n: 2 }] }
      }
    })),
    detail: vi.fn(async () => ({
      success: true,
      data: {
        id: 42,
        path: 'Content/Props/SM_Chair.uasset',
        name: 'SM_Chair.uasset',
        dirId: 5,
        repository: 'repo-a',
        ext: '.uasset',
        class: 'StaticMesh',
        engine: '5.4',
        size: 2048,
        modifiedMs: 1,
        tags: [],
        hash: 'ab'.repeat(32),
        dependencies: [{ id: 7, path: 'Content/Props/M_Wood.uasset' }],
        dependenciesTruncated: false,
        dependentsCount: 0,
        annotations: { tags: ['wood', 'hero'], note: 'use in the harbour' }
      }
    })),
    editAnnotations: vi.fn(async () => ({ success: true, data: { accepted: 1, journalSeq: 3 } }))
  }
  ;(window as unknown as { api: unknown }).api = { catalogLibrary: bridge }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
  setActiveLibrarySource(null)
})

describe('LocalLibrarySource', () => {
  it('forwards every call unchanged, argument count included', async () => {
    await localLibrarySource.folders.getByFatherKey('ALL')
    expect(local.folder.getByFatherKey).toHaveBeenLastCalledWith('ALL')
    await localLibrarySource.folders.getByFatherKey('F', 'assetName', 'asc', 100, 0)
    expect(local.folder.getByFatherKey).toHaveBeenLastCalledWith('F', 'assetName', 'asc', 100, 0)
    expect(await localLibrarySource.assets.getCountByFolderKey('F', true)).toBe(7)
    expect(local.data.getCountByFolderKey).toHaveBeenLastCalledWith('F', true)
    expect(localLibrarySource.capabilities).toBe(LOCAL_CAPABILITIES)
    expect(LOCAL_CAPABILITIES.canEditStructure && LOCAL_CAPABILITIES.vaultFeatures).toBe(true)
  })

  it('is the default data source', () => {
    expect(getActiveLibrarySource()).toBe(localLibrarySource)
  })
})

describe('server rows in the local shape', () => {
  it('maps keys, paths and fields the way the existing views read them', () => {
    expect(folderKeyOf(0)).toBe('ALL')
    expect(folderKeyOf(12)).toBe('d12')
    expect(dirIdOf('d12')).toBe(12)
    expect(dirIdOf('ALL')).toBe(0)
    expect(dirIdOf('someLocalKey')).toBe(0)
    expect(softPathOf('Content/Props/SM_Chair.uasset')).toBe('/Game/Props/SM_Chair')
    expect(softPathOf('Plugins/Forest/Content/Trees/SM_Pine.uasset')).toBe('/Forest/Trees/SM_Pine')
    const row = mapAsset({
      id: 3,
      path: 'Content/A/T_Rock.uasset',
      name: 'T_Rock.uasset',
      dirId: 9,
      repository: 'repo',
      ext: '.uasset',
      class: 'Texture2D',
      engine: '5.3',
      size: 10,
      modifiedMs: 0,
      tags: [],
      previewUrl: null
    })
    expect(row).toMatchObject({
      assetKey: 'a3',
      folderKey: 'd9',
      assetName: 'T_Rock',
      fileExtension: 'uasset',
      className: 'Texture2D',
      classNameCn: 'Texture2D',
      engineVersion: '5.3',
      softPath: '/Game/A/T_Rock',
      thumbnailUrl: null,
      catalogId: 3
    })
    expect(row.updated_at).toBeUndefined()
  })

  it('turns one-hop dependencies into the import list, all clickable', () => {
    const status = importStatusOf({
      id: 1,
      path: 'Content/A.uasset',
      name: 'A.uasset',
      dirId: 1,
      repository: 'r',
      ext: '.uasset',
      class: null,
      engine: null,
      size: 0,
      modifiedMs: 0,
      tags: [],
      hash: '',
      dependencies: [{ id: 2, path: 'Content/Mat/M_B.uasset' }],
      dependenciesTruncated: false,
      dependentsCount: 0
    })
    expect(status).toEqual({
      total: 1,
      unresolvedCount: 0,
      items: [
        {
          softPath: '/Game/Mat/M_B',
          name: 'M_B',
          folder: '/Game/Mat',
          status: 'in-vault',
          assetKey: 'a2'
        }
      ]
    })
  })

  it('derives what a server library can do from its state', () => {
    const writer = serverCapabilities({ annotations: true, lore: true, online: true })
    expect(writer).toMatchObject({
      tagModel: 'names',
      canEditNotes: true,
      canImport: true,
      canEditStructure: false,
      vaultFeatures: false
    })
    const offline = serverCapabilities({ annotations: true, lore: true, online: false })
    expect(offline).toMatchObject({ tagModel: 'none', canImport: false })
    expect(offline.reasons.canImport).toBe('catalogLibrary.reasons.offline')
    const reader = serverCapabilities({ annotations: false, lore: false, online: true })
    expect(reader.reasons.tagModel).toBe('catalogLibrary.reasons.annotations')
    expect(reader.reasons.canImport).toBe('catalogLibrary.reasons.lore')
  })
})

describe('ServerLibrarySource', () => {
  const source = (): ServerLibrarySource =>
    new ServerLibrarySource('srv:lab', () =>
      serverCapabilities({ annotations: true, lore: true, online: true })
    )

  it('serves the tree from ALL with lazy children keyed by folder id', async () => {
    const server = source()
    const roots = await server.folders.getRootFolders()
    expect(roots).toMatchObject([{ folderKey: 'ALL', folderName: 'ALL', hasChildren: true }])
    const children = await server.folders.getByFatherKey('ALL')
    expect(children).toMatchObject([{ folderKey: 'd1', folderName: 'Content', fatherKey: 'ALL' }])
    expect(await server.folders.getChildCount('d1')).toBe(1)
    expect(await server.assets.getCountByFolderKey('d5')).toBe(2)
    expect(await server.folders.getPathArray('d5')).toEqual(['ALL', 'd1', 'd5'])
  })

  it('pages assets by offset and searches with the filters of the existing filter bar', async () => {
    const server = source()
    const rows = await server.assets.getByFolderKey('d5', 'modifiedTime', 'desc', true, 100, 200)
    expect(rows[0]).toMatchObject({
      assetKey: 'a42',
      thumbnailUrl: expect.stringContaining('uebox-preview://')
    })
    expect(bridge.listWindow).toHaveBeenLastCalledWith(
      'srv:lab',
      { dir: 5, recursive: false, sort: 'modified', order: 'desc' },
      200,
      100
    )
    await server.search.assets({
      folderKey: 'd1',
      includeSubfolders: true,
      keyword: ' 椅子 ',
      classNameCnFilters: ['StaticMesh'],
      fileExtensions: ['uasset'],
      engineVersions: ['5.4'],
      limit: 50,
      offset: 50
    })
    expect(bridge.listWindow).toHaveBeenLastCalledWith(
      'srv:lab',
      expect.objectContaining({
        dir: 1,
        recursive: true,
        q: '椅子',
        class: ['StaticMesh'],
        ext: ['.uasset'],
        engine: ['5.4']
      }),
      50,
      50
    )
    expect(await server.search.folders({ keyword: 'x' })).toEqual([])
  })

  it('reads and writes annotations by path', async () => {
    const server = source()
    expect(await server.annotations!.get({ assetKey: 'a42' })).toEqual({
      tags: ['wood', 'hero'],
      note: 'use in the harbour'
    })
    expect(
      await server.annotations!.edit({ assetKey: 'a42' }, { addTags: ['metal'], note: 'x' })
    ).toEqual({ ok: true, error: undefined })
    expect(bridge.editAnnotations).toHaveBeenLastCalledWith('srv:lab', [
      { path: 'Content/Props/SM_Chair.uasset', set: { note: 'x' }, addTags: ['metal'] }
    ])
  })

  it('gives class options and engine values with counts from facets', async () => {
    const server = source()
    expect(await server.assets.getDistinctAssetTypes()).toEqual([
      { className: 'StaticMesh', classNameCn: 'StaticMesh', count: 3 }
    ])
    expect(await server.facets!.engines({})).toEqual([{ value: '5.4', n: 2 }])
  })
})

describe('catalog error and display helpers', () => {
  const t = (key: string): string => `t:${key}`

  it('translates known codes and keeps raw text for unknown ones', () => {
    expect(catalogErrorText(t, 'fingerprint-mismatch', 'x')).toBe(
      't:catalogLibrary.errors.fingerprint-mismatch'
    )
    expect(catalogErrorText(t, 'network', 'ECONNREFUSED')).toBe(
      't:catalogLibrary.errors.network（ECONNREFUSED）'
    )
    expect(catalogErrorText(t, 'weird', 'raw words')).toBe('raw words')
    expect(catalogErrorText(t, null, null)).toBe('t:catalogLibrary.errors.unknown')
    expect(catalogErrorOf(t, new CatalogApiError('m', 'signed-out'))).toBe(
      't:catalogLibrary.errors.signed-out'
    )
  })

  it('formats names, sizes and fingerprints', () => {
    expect(displayName('SM_Chair.uasset')).toBe('SM_Chair')
    expect(formatSize(undefined)).toBe('—')
    expect(formatSize(2048)).toBe('2 KB')
    expect(shortFingerprint('ab'.repeat(32))).toBe('AB:AB:AB:AB…AB:AB:AB:AB')
    expect(classIcon('StaticMesh')).not.toBe(classIcon('Texture2D'))
  })
})
