import { describe, expect, it } from 'vitest'

import { buildImportStatusSummary, parseImports, type ImportStatusAsset } from './importStatus'

describe('parseImports', () => {
  it('读 JSON 字符串形式的字符串数组', () => {
    expect(parseImports('["/Game/A/T_One","/Game/B/T_Two"]')).toEqual([
      '/Game/A/T_One',
      '/Game/B/T_Two'
    ])
  })

  it('读已经是数组的情况', () => {
    expect(parseImports(['/Game/A/T_One'])).toEqual(['/Game/A/T_One'])
  })

  it('元素是对象时取 path，没有 path 才退到 name', () => {
    expect(parseImports([{ path: '/Game/A' }, { name: '/Game/B' }])).toEqual(['/Game/A', '/Game/B'])
  })

  it('坏 JSON 当没有依赖处理，不往外抛', () => {
    // 一条坏数据不该让整个详情面板打不开
    expect(parseImports('{不是 JSON')).toEqual([])
  })

  it('空值和非数组都返回空', () => {
    expect(parseImports(null)).toEqual([])
    expect(parseImports(undefined)).toEqual([])
    expect(parseImports('{"a":1}')).toEqual([])
  })

  it('滤掉空元素', () => {
    expect(parseImports(['', '/Game/A', {}])).toEqual(['/Game/A'])
  })
})

describe('buildImportStatusSummary', () => {
  const inVault: ImportStatusAsset = {
    assetKey: 'key-1',
    assetName: 'T_MountainMask_02',
    softPath: '/Game/EasyFog/Textures/Mountain/T_MountainMask_02',
    className: 'Texture2D',
    folderKey: 'folder-1'
  }

  it('库里有的标成 in-vault，并带上跳转要用的 key', () => {
    const summary = buildImportStatusSummary([inVault.softPath!], [inVault])

    expect(summary.total).toBe(1)
    expect(summary.unresolvedCount).toBe(0)
    expect(summary.items[0]).toMatchObject({
      status: 'in-vault',
      name: 'T_MountainMask_02',
      folder: '/Game/EasyFog/Textures/Mountain',
      assetKey: 'key-1',
      className: 'Texture2D',
      folderKey: 'folder-1'
    })
  })

  it('库里没有的标成 unresolved，并计入 unresolvedCount', () => {
    const summary = buildImportStatusSummary(['/Game/Gone/T_Missing'], [])

    expect(summary.unresolvedCount).toBe(1)
    expect(summary.items[0]).toEqual({
      softPath: '/Game/Gone/T_Missing',
      name: 'T_Missing',
      folder: '/Game/Gone',
      status: 'unresolved'
    })
  })

  it('unresolved 不带 assetKey —— 界面靠它决定这一行能不能点', () => {
    const summary = buildImportStatusSummary(['/Game/Gone/T_Missing'], [])
    expect(summary.items[0].assetKey).toBeUndefined()
  })

  it('顺序跟着资产声明的 imports 走，不跟着数据库返回顺序走', () => {
    const second: ImportStatusAsset = {
      assetKey: 'key-2',
      assetName: 'T_Second',
      softPath: '/Game/B/T_Second'
    }
    const first: ImportStatusAsset = {
      assetKey: 'key-3',
      assetName: 'T_First',
      softPath: '/Game/A/T_First'
    }

    // 查询结果故意反着给
    const summary = buildImportStatusSummary(
      ['/Game/A/T_First', '/Game/B/T_Second'],
      [second, first]
    )

    expect(summary.items.map((item) => item.name)).toEqual(['T_First', 'T_Second'])
  })

  it('同一条 softPath 命中多个资产时只取第一个', () => {
    const dup: ImportStatusAsset = { assetKey: 'key-dup', softPath: inVault.softPath }
    const summary = buildImportStatusSummary([inVault.softPath!], [inVault, dup])

    expect(summary.items).toHaveLength(1)
    expect(summary.items[0].assetKey).toBe('key-1')
  })

  it('命中资产没有 assetName 时退回软路径末段', () => {
    const noName: ImportStatusAsset = { assetKey: 'key-4', softPath: '/Game/A/T_NoName' }
    const summary = buildImportStatusSummary(['/Game/A/T_NoName'], [noName])

    expect(summary.items[0].name).toBe('T_NoName')
  })

  it('混合场景：总数和未找到数分别对得上', () => {
    const summary = buildImportStatusSummary(
      [inVault.softPath!, '/Game/Gone/T_A', '/Game/Gone/T_B'],
      [inVault]
    )

    expect(summary.total).toBe(3)
    expect(summary.unresolvedCount).toBe(2)
  })

  it('没有依赖时返回空汇总', () => {
    expect(buildImportStatusSummary([], [])).toEqual({
      total: 0,
      unresolvedCount: 0,
      items: []
    })
  })
})
