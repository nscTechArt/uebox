import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  createEmptyGraphSummary,
  type MaterialEntry
} from '@renderer/views/MaterialLibrary/types/material'
import { useMaterialLibraryStore } from './materialLibraryStore'

function createEntry(overrides: Partial<MaterialEntry> = {}): MaterialEntry {
  const entryType = overrides.entryType || 'material'

  return {
    id: overrides.id || 'material-entry-1',
    name: overrides.name || 'M_Test',
    entryType,
    assetPath: overrides.assetPath || '/Game/Materials/M_Test',
    engineVersion: overrides.engineVersion || '5.x',
    description: overrides.description || '',
    tags: overrides.tags || [],
    thumbnail: overrides.thumbnail,
    coverStyle: overrides.coverStyle || 'background: #000;',
    createdAt: overrides.createdAt || 100,
    updatedAt: overrides.updatedAt || 100,
    isFavorite: overrides.isFavorite || false,
    status: overrides.status || 'draft',
    materialDomain: overrides.materialDomain || 'Surface',
    blendMode: overrides.blendMode || 'Opaque',
    shadingModel: overrides.shadingModel || 'DefaultLit',
    twoSided: overrides.twoSided || false,
    usageFlags: overrides.usageFlags || [],
    compileStatus: overrides.compileStatus || 'success',
    compileDiagnostics: overrides.compileDiagnostics || [],
    lastHealthCheckAt: overrides.lastHealthCheckAt,
    nodeCount: overrides.nodeCount || 0,
    connectionCount: overrides.connectionCount || 0,
    graphSummary: overrides.graphSummary || createEmptyGraphSummary(),
    graphBlueprintCode: overrides.graphBlueprintCode ?? null,
    scalarParameters: overrides.scalarParameters || [],
    vectorParameters: overrides.vectorParameters || [],
    textureParameters: overrides.textureParameters || [],
    staticSwitchParameters: overrides.staticSwitchParameters || [],
    textureDependencies: overrides.textureDependencies || [],
    functionDependencies: overrides.functionDependencies || [],
    parameterCollectionDependencies: overrides.parameterCollectionDependencies || [],
    missingDependencies: overrides.missingDependencies || [],
    parentMaterialPath: overrides.parentMaterialPath,
    childInstancePaths: overrides.childInstancePaths || [],
    referencedByPaths: overrides.referencedByPaths || [],
    collectionId: overrides.collectionId,
    sourceOrigin: overrides.sourceOrigin || 'live',
    liveDataState: overrides.liveDataState || 'full',
    syncIssues: overrides.syncIssues || [],
    lastSyncedAt: overrides.lastSyncedAt,
    lastSyncAttemptAt: overrides.lastSyncAttemptAt,
    liveRefreshAvailable: overrides.liveRefreshAvailable ?? true,
    legacyKey: overrides.legacyKey
  } as MaterialEntry
}

describe('materialLibraryStore', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('preserves local curation fields when a live entry is refreshed', () => {
    const store = useMaterialLibraryStore()
    const original = createEntry({
      id: 'material-1',
      assetPath: '/Game/Materials/M_Master',
      tags: ['hero', 'metal'],
      isFavorite: true,
      collectionId: 'collection-a',
      description: 'Original description',
      updatedAt: 10
    })

    const refreshed = createEntry({
      id: 'material-1-new',
      assetPath: '/Game/Materials/M_Master',
      tags: [],
      isFavorite: false,
      collectionId: undefined,
      description: '',
      updatedAt: 20,
      blendMode: 'Masked'
    })

    store.upsertEntries([original])
    store.upsertEntries([refreshed])

    expect(store.entries).toHaveLength(1)
    expect(store.entries[0]?.id).toBe('material-1')
    expect(store.entries[0]?.tags).toEqual(['hero', 'metal'])
    expect(store.entries[0]?.isFavorite).toBe(true)
    expect(store.entries[0]?.collectionId).toBe('collection-a')
    expect(store.entries[0]?.description).toBe('Original description')
    expect(store.entries[0]?.blendMode).toBe('Masked')
  })

  it('manages collection lifecycle and clears assignments on deletion', () => {
    const store = useMaterialLibraryStore()
    const entry = createEntry({ id: 'material-2' })

    store.upsertEntries([entry])
    const created = store.createCollection(' Metals ')

    expect(created?.name).toBe('Metals')

    store.assignToCollection('material-2', created?.id || null)
    expect(store.entries[0]?.collectionId).toBe(created?.id)
    expect(store.getCollectionEntries(created?.id || '')).toHaveLength(1)

    expect(store.renameCollection(created?.id || '', 'Hero Metals')).toBe(true)
    expect(store.collections[0]?.name).toBe('Hero Metals')

    store.updateFilters({ activeCollectionId: created?.id || null })
    store.deleteCollection(created?.id || '')

    expect(store.collections).toHaveLength(0)
    expect(store.entries[0]?.collectionId).toBeUndefined()
    expect(store.filters.activeCollectionId).toBeNull()
  })

  it('filters entries by favorite and collection state', () => {
    const store = useMaterialLibraryStore()
    const favoriteEntry = createEntry({
      id: 'material-3',
      name: 'M_Favorite',
      collectionId: 'collection-gold',
      isFavorite: true
    })
    const regularEntry = createEntry({
      id: 'material-4',
      name: 'M_Regular',
      assetPath: '/Game/Materials/M_Regular',
      isFavorite: false
    })

    store.upsertEntries([favoriteEntry, regularEntry])
    store.updateFilters({ favoriteState: 'favorite' })
    expect(store.filteredEntries.map((item) => item.id)).toEqual([])

    store.updateFilters({ searchQuery: 'favorite' })
    expect(store.filteredEntries.map((item) => item.id)).toEqual(['material-3'])

    store.updateFilters({ favoriteState: 'all', activeCollectionId: 'collection-gold' })
    expect(store.filteredEntries.map((item) => item.id)).toEqual(['material-3'])
  })

  it('hides collection members from the main gallery unless searching or viewing the collection', () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createEntry({
        id: 'material-5',
        name: 'M_Grouped_A',
        assetPath: '/Game/Materials/M_Grouped_A'
      }),
      createEntry({
        id: 'material-6',
        name: 'M_Grouped_B',
        assetPath: '/Game/Materials/M_Grouped_B'
      }),
      createEntry({ id: 'material-7', name: 'M_Free', assetPath: '/Game/Materials/M_Free' })
    ])

    const collection = store.createCollection('Grouped', ['material-5', 'material-6'])

    expect(collection?.entryIds).toEqual(['material-5', 'material-6'])
    expect(store.filteredEntries.map((item) => item.id)).toEqual(['material-7'])

    store.updateFilters({ searchQuery: 'grouped' })
    expect(store.filteredEntries.map((item) => item.id)).toEqual(['material-5', 'material-6'])

    store.updateFilters({ searchQuery: '', activeCollectionId: collection?.id || null })
    expect(store.filteredEntries.map((item) => item.id)).toEqual(['material-5', 'material-6'])
  })

  it('dissolves material collections when removal leaves one entry', () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createEntry({ id: 'material-8', name: 'M_Left', assetPath: '/Game/Materials/M_Left' }),
      createEntry({ id: 'material-9', name: 'M_Right', assetPath: '/Game/Materials/M_Right' })
    ])
    const collection = store.createCollection('Pair', ['material-8', 'material-9'])
    store.updateFilters({ activeCollectionId: collection?.id || null })

    store.assignToCollection('material-8', null)

    expect(store.collections).toHaveLength(0)
    expect(store.entries.find((entry) => entry.id === 'material-8')?.collectionId).toBeUndefined()
    expect(store.entries.find((entry) => entry.id === 'material-9')?.collectionId).toBeUndefined()
    expect(store.filters.activeCollectionId).toBeNull()
  })

  it('creates a local draft material entry without Unreal connectivity', () => {
    const store = useMaterialLibraryStore()

    const created = store.createDraftMaterial({
      name: 'M_LocalDraft',
      destinationPath: '/Game/Materials',
      blendMode: 'Opaque',
      shadingModel: 'DefaultLit',
      twoSided: false
    })

    expect(created).toEqual(
      expect.objectContaining({
        name: 'M_LocalDraft',
        assetPath: '/Game/Materials/M_LocalDraft',
        sourceOrigin: 'local',
        liveRefreshAvailable: false,
        graphBlueprintCode: ''
      })
    )
    expect(store.entries[0]?.id).toBe(created?.id)
    expect(store.entries[0]?.syncIssues).toEqual(['离线草稿，可保存材质节点文本。'])
  })

  it('backfills editable node values when loading persisted graph entries', async () => {
    const graphBlueprintCode = [
      'Begin Object Class="/Script/Engine.MaterialExpressionConstant" Name="MaterialExpressionConstant_0"',
      '    CustomProperties Pin (PinId=A,PinName="Value",Direction="EGPD_Input",DefaultValue="1.0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)',
      'End Object',
      'Begin Object Class="/Script/Engine.MaterialExpressionTextureCoordinate" Name="MaterialExpressionTextureCoordinate_0"',
      '    CustomProperties Pin (PinId=B,PinName="CoordinateIndex",PinFriendlyName="Coordinate Index",Direction="EGPD_Input",DefaultValue="0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)',
      '    CustomProperties Pin (PinId=C,PinName="UTiling",PinFriendlyName="U Tiling",Direction="EGPD_Input",DefaultValue="2.0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)',
      '    CustomProperties Pin (PinId=D,PinName="VTiling",PinFriendlyName="V Tiling",Direction="EGPD_Input",DefaultValue="2.0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)',
      '    CustomProperties Pin (PinId=E,PinName="UnMirrorU",PinFriendlyName="Un Mirror U",Direction="EGPD_Input",DefaultValue="False",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)',
      '    CustomProperties Pin (PinId=F,PinName="UnMirrorV",PinFriendlyName="Un Mirror V",Direction="EGPD_Input",DefaultValue="False",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)',
      'End Object'
    ].join('\n')

    localStorage.setItem(
      'material-library-v2-state',
      JSON.stringify({
        entries: [
          createEntry({
            id: 'material-persisted-graph',
            graphBlueprintCode,
            scalarParameters: []
          })
        ]
      })
    )

    const store = useMaterialLibraryStore()
    // 数据现在存保管库里的 .uematerial 包，读取走异步 IPC；
    // 没有 preload 时退回只读 localStorage 里的旧数据
    await store.ready

    expect(store.entries[0]?.scalarParameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Constant_0.Value',
          overrideValue: 1,
          source: 'nodeProperty'
        }),
        expect.objectContaining({
          name: 'TextureCoordinate_0.Coordinate Index',
          overrideValue: 0,
          source: 'nodeProperty'
        }),
        expect.objectContaining({
          name: 'TextureCoordinate_0.U Tiling',
          overrideValue: 2,
          source: 'nodeProperty'
        }),
        expect.objectContaining({
          name: 'TextureCoordinate_0.V Tiling',
          overrideValue: 2,
          source: 'nodeProperty'
        })
      ])
    )
    expect(store.entries[0]?.staticSwitchParameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'TextureCoordinate_0.Un Mirror U',
          overrideValue: false,
          source: 'nodeProperty'
        }),
        expect.objectContaining({
          name: 'TextureCoordinate_0.Un Mirror V',
          overrideValue: false,
          source: 'nodeProperty'
        })
      ])
    )
  })

  it('persists edited graph code and refreshes graph statistics', () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createEntry({
        id: 'material-graph-1',
        sourceOrigin: 'local',
        graphBlueprintCode: ''
      })
    ])

    const nextCode = [
      'Begin Object Class="/Script/Engine.MaterialExpressionTextureSample" Name="MaterialExpressionTextureSample_0"',
      `    Texture=Texture2D'/Game/Textures/T_Test.T_Test'`,
      '    CustomProperties Pin (PinId=A,PinName="Output 1",Direction="EGPD_Output",LinkedTo=(MaterialExpressionMaterialFunctionCall_0 B,),PersistentGuid=00000000000000000000000000000000,bHidden=False,bNotConnectable=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)',
      'End Object',
      'Begin Object Class="/Script/Engine.MaterialExpressionMaterialFunctionCall" Name="MaterialExpressionMaterialFunctionCall_0"',
      `    MaterialFunction=MaterialFunction'/Game/Functions/MF_Test.MF_Test'`,
      'End Object',
      'Begin Object Class="/Script/Engine.MaterialExpressionConstant" Name="MaterialExpressionConstant_0"',
      '    CustomProperties Pin (PinId=C,PinName="Value",Direction="EGPD_Input",DefaultValue="1.0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)',
      'End Object',
      'Begin Object Class="/Script/Engine.MaterialExpressionTextureCoordinate" Name="MaterialExpressionTextureCoordinate_0"',
      '    CustomProperties Pin (PinId=D,PinName="CoordinateIndex",PinFriendlyName="Coordinate Index",Direction="EGPD_Input",DefaultValue="0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)',
      '    CustomProperties Pin (PinId=E,PinName="UTiling",PinFriendlyName="U Tiling",Direction="EGPD_Input",DefaultValue="2.0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)',
      '    CustomProperties Pin (PinId=F,PinName="VTiling",PinFriendlyName="V Tiling",Direction="EGPD_Input",DefaultValue="2.0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)',
      'End Object'
    ].join('\n')

    store.updateGraphCode('material-graph-1', nextCode)

    const updated = store.entries[0]
    expect(updated?.graphBlueprintCode).toBe(nextCode)
    expect(updated?.graphSummary.nodeCount).toBe(4)
    expect(updated?.graphSummary.textureNodeCount).toBe(1)
    expect(updated?.graphSummary.functionCallCount).toBe(1)
    expect(updated?.nodeCount).toBe(4)
    expect(updated?.connectionCount).toBe(1)
    expect(updated?.scalarParameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Constant_0.Value',
          overrideValue: 1,
          source: 'nodeProperty'
        }),
        expect.objectContaining({
          name: 'TextureCoordinate_0.Coordinate Index',
          overrideValue: 0,
          source: 'nodeProperty'
        }),
        expect.objectContaining({
          name: 'TextureCoordinate_0.U Tiling',
          overrideValue: 2,
          source: 'nodeProperty'
        }),
        expect.objectContaining({
          name: 'TextureCoordinate_0.V Tiling',
          overrideValue: 2,
          source: 'nodeProperty'
        })
      ])
    )
    expect(updated?.textureDependencies.map((item) => item.path)).toEqual(['/Game/Textures/T_Test'])
    expect(updated?.functionDependencies.map((item) => item.path)).toEqual([
      '/Game/Functions/MF_Test'
    ])
  })

  it('rebuilds graph-derived parameters even when saved graph text is unchanged', () => {
    const store = useMaterialLibraryStore()
    const graphBlueprintCode = [
      'Begin Object Class="/Script/Engine.MaterialExpressionTextureCoordinate" Name="MaterialExpressionTextureCoordinate_0"',
      '    CustomProperties Pin (PinId=A,PinName="CoordinateIndex",PinFriendlyName="Coordinate Index",Direction="EGPD_Input",DefaultValue="0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)',
      '    CustomProperties Pin (PinId=B,PinName="UTiling",PinFriendlyName="U Tiling",Direction="EGPD_Input",DefaultValue="2.0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)',
      'End Object'
    ].join('\n')

    store.upsertEntries([
      createEntry({
        id: 'material-graph-stale-params',
        graphBlueprintCode,
        scalarParameters: [
          {
            name: 'TextureCoordinate_0.Coordinate Index',
            type: 'scalar',
            overrideValue: 0,
            source: 'nodeProperty'
          }
        ]
      })
    ])

    store.updateGraphCode('material-graph-stale-params', graphBlueprintCode)

    expect(store.entries[0]?.scalarParameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'TextureCoordinate_0.U Tiling',
          overrideValue: 2,
          source: 'nodeProperty'
        })
      ])
    )
  })

  // 存盘是二十多个用户操作的最后一步，让它把整个操作带崩，等于"存不下就什么都干不了"。
  // 以前的雷是 localStorage 写满抛 QuotaExceededError；现在写 SQLite 没有那个上限，
  // 但 IPC 仍然可能失败，所以这条不变式要继续守住。
  it('存盘失败时不把用户的操作一起带崩', async () => {
    // 保管库能扫、但写不进去（磁盘满、权限不足、网络库掉线都长这样）
    const create = vi.fn(async () => {
      throw new Error('写盘挂了')
    })
    const libraryPackage = {
      scan: vi.fn(async () => ({ success: true, data: { entries: [], problems: [] } })),
      readMeta: vi.fn(async () => ({
        success: true,
        data: JSON.stringify({ migrated: { material: true } })
      })),
      writeMeta: vi.fn(async () => ({ success: true, data: true })),
      create,
      update: vi.fn(async () => ({ success: true, data: null })),
      rename: vi.fn(async () => ({ success: true, data: null })),
      delete: vi.fn(async () => ({ success: true, data: true })),
      writeFile: vi.fn(async () => ({ success: true, data: true })),
      readFile: vi.fn(async () => ({ success: true, data: null }))
    }
    vi.stubGlobal('api', { libraryPackage })

    try {
      const store = useMaterialLibraryStore()
      await store.ready

      expect(() => store.setViewMode('list')).not.toThrow()
      expect(store.viewMode).toBe('list')

      // 落盘是防抖的，等它真的把失败吞掉，同样不该抛
      await expect(store.flushPersistence()).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('界面偏好留在 localStorage，不写进保管库', async () => {
    const store = useMaterialLibraryStore()
    await store.ready

    store.setViewMode('list')
    await store.flushPersistence()

    expect(JSON.parse(localStorage.getItem('material-library-ui') || '{}')).toMatchObject({
      viewMode: 'list'
    })
  })
})
