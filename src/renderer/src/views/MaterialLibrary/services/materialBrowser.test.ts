/**
 * 跟蓝图那层一样：翻译错一个字段就是「东西不见了」或者「点开是别的材质」。
 * 材质这边多一条要钉：筛选选项来自引擎取值，不能在代码里写死一张表。
 */
import { describe, expect, it } from 'vitest'

import { buildMaterialFacets, toBrowserFolders, toBrowserItems } from './materialBrowser'
import { createEmptyGraphSummary, type MaterialEntry } from '../types/material'

function makeEntry(overrides: Partial<MaterialEntry> & { id: string }): MaterialEntry {
  return {
    name: overrides.id,
    entryType: 'material',
    assetPath: '/Game/Materials/M_Test',
    engineVersion: '5.5',
    description: '',
    tags: [],
    coverStyle: 'background: #123',
    createdAt: 1,
    updatedAt: 2,
    isFavorite: false,
    status: 'draft',
    materialDomain: 'Surface',
    blendMode: 'Opaque',
    shadingModel: 'DefaultLit',
    twoSided: false,
    usageFlags: [],
    compileStatus: 'success',
    compileDiagnostics: [],
    nodeCount: 0,
    connectionCount: 0,
    graphSummary: createEmptyGraphSummary(),
    graphBlueprintCode: null,
    scalarParameters: [],
    vectorParameters: [],
    textureParameters: [],
    staticSwitchParameters: [],
    textureDependencies: [],
    functionDependencies: [],
    parameterCollectionDependencies: [],
    missingDependencies: [],
    childInstancePaths: [],
    referencedByPaths: [],
    sourceOrigin: 'live',
    liveDataState: 'full',
    syncIssues: [],
    liveRefreshAvailable: true,
    ...overrides
  } as MaterialEntry
}

const stats = (): string => '3 参数'

describe('toBrowserItems', () => {
  it('带上原对象', () => {
    const entry = makeEntry({ id: 'a', name: '苔藓石头' })
    const [item] = toBrowserItems([entry], stats)

    expect(item).toMatchObject({ id: 'a', name: '苔藓石头', kind: 'material' })
    expect(item.source).toBe(entry)
  })

  it('没归集合的落在根目录', () => {
    expect(toBrowserItems([makeEntry({ id: 'a' })], stats)[0].folderKey).toBe('')
  })

  it('归了集合的用集合 id 当 folderKey', () => {
    const items = toBrowserItems([makeEntry({ id: 'a', collectionId: 'c1' })], stats)
    expect(items[0].folderKey).toBe('c1')
  })

  it('副标题拼类型、混合模式、着色模型；缺哪个不留孤零零的分隔符', () => {
    expect(toBrowserItems([makeEntry({ id: 'a' })], stats)[0].subtitle).toContain('Opaque')
    const sparse = toBrowserItems([makeEntry({ id: 'b', blendMode: '', shadingModel: '' })], stats)
    expect(sparse[0].subtitle).not.toContain('·')
  })
})

describe('toBrowserFolders', () => {
  it('集合变成平铺的一层文件夹', () => {
    expect(toBrowserFolders([{ id: 'c1', name: '金属', entryIds: [], createdAt: 0 }])).toEqual([
      { key: 'c1', name: '金属', parentKey: null }
    ])
  })
})

describe('buildMaterialFacets', () => {
  const labels = { entryType: 'a', blendMode: 'b', shadingModel: 'c' }

  it('三个筛选字段，取值从真实数据里现算', () => {
    const facets = buildMaterialFacets(
      [
        makeEntry({ id: 'a', blendMode: 'Opaque', shadingModel: 'DefaultLit' }),
        makeEntry({ id: 'b', blendMode: 'Masked', shadingModel: 'DefaultLit' })
      ],
      labels
    )

    expect(facets.map((f) => f.key)).toEqual(['entryType', 'blendMode', 'shadingModel'])
    expect(facets[1].options.map((o) => o.value)).toEqual(['Masked', 'Opaque'])
    // 去重：两条都是 DefaultLit，只该出现一次
    expect(facets[2].options).toHaveLength(1)
  })

  it('空库时每个字段都是空选项，不报错', () => {
    expect(buildMaterialFacets([], labels).every((f) => f.options.length === 0)).toBe(true)
  })
})
