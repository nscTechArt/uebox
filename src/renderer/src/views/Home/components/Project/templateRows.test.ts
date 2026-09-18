import { describe, expect, it } from 'vitest'
import type {
  CommunityFetchResult,
  CommunityTemplate,
  TemplateInfo
} from '@core/shared/projectTemplate'
import {
  buildTemplateRows,
  collectEngineVersions,
  filterAndSortRows,
  type RowFilter,
  type TemplateRow
} from './templateRows'

/**
 * 界面上只有「社区」和「我的」两种模板，同一个模板不许出现两行。
 *
 * 这里守的都是「用户会一眼看出不对」的东西：重复条目、按钮点不动、
 * 筛选之后模板凭空消失。
 */

function localTemplate(overrides: Partial<TemplateInfo> = {}): TemplateInfo {
  return {
    name: 'GameStart',
    path: 'C:/app/resources/project/GameStart.zip',
    size: 8703,
    modifiedTime: 1000,
    origin: 'community',
    category: 'game',
    engineVersion: '5.7',
    description: '空白游戏工程骨架',
    ...overrides
  }
}

function manifestResult(overrides: Partial<CommunityFetchResult> = {}): CommunityFetchResult {
  return {
    sourceId: 'official',
    sourceName: '官方社区库',
    skipped: 0,
    templates: [],
    ...overrides
  }
}

function manifestTemplate(
  id: string,
  name: string,
  extra: Partial<CommunityTemplate> = {}
): CommunityTemplate {
  return {
    id,
    name,
    description: '',
    category: 'game',
    engineVersion: '5.7',
    packageUrl: `packages/${id}.zip`,
    size: 8703,
    sha256: 'a'.repeat(64),
    version: '1.1.0',
    author: 'Unreal Box Team',
    license: 'Apache-2.0',
    ...extra
  }
}

describe('buildTemplateRows', () => {
  it('已下载的模板与清单里的同一条合成一行，不重复出现', () => {
    const rows = buildTemplateRows(
      [localTemplate({ sourceId: 'official', templateId: 'gamestart' })],
      [
        manifestResult({
          templates: [manifestTemplate('gamestart', 'GameStart 游戏启动工程')]
        })
      ]
    )

    expect(rows).toHaveLength(1)
    // 本地有 → 能直接建工程；清单也有 → 知道自己来自哪个源
    expect(rows[0].local).not.toBeNull()
    expect(rows[0].remote?.sourceId).toBe('official')
  })

  it('同一个模板在本地落成了两个文件时，用更新的那份', () => {
    const rows = buildTemplateRows(
      [
        localTemplate({
          sourceId: 'official',
          templateId: 'gamestart',
          path: 'C:/userData/templates/GameStart.zip',
          modifiedTime: 1000,
          version: '1.1.0'
        }),
        localTemplate({
          sourceId: 'official',
          templateId: 'gamestart',
          path: 'C:/userData/templates/GameStart_2.zip',
          modifiedTime: 9000,
          version: '2.0.0'
        })
      ],
      []
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe('2.0.0')
  })

  /**
   * 官方源有 GitHub 和国内镜像两份，装的是同一批包。两个都启用是默认行为
   * （「启用官方源」按钮一次开两个），不跨源去重的话每个模板都会出现两遍。
   */
  it('镜像源里 sha256 相同的条目只显示一行', () => {
    const rows = buildTemplateRows(
      [],
      [
        manifestResult({ templates: [manifestTemplate('gamestart', 'GameStart')] }),
        manifestResult({
          sourceId: 'mirror-cn',
          sourceName: '官方社区库（国内镜像）',
          templates: [manifestTemplate('gamestart', 'GameStart')]
        })
      ]
    )

    expect(rows).toHaveLength(1)
    // 先扫到的源赢，这里是 GitHub 那条
    expect(rows[0].remote?.sourceId).toBe('official')
  })

  it('已下载的那份能同时对上镜像源的条目，不会多出一行', () => {
    const rows = buildTemplateRows(
      [localTemplate({ sourceId: 'official', templateId: 'gamestart' })],
      [
        manifestResult({ templates: [manifestTemplate('gamestart', 'GameStart')] }),
        manifestResult({
          sourceId: 'mirror-cn',
          sourceName: '官方社区库（国内镜像）',
          templates: [manifestTemplate('gamestart', 'GameStart')]
        })
      ]
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].local).not.toBeNull()
  })

  it('sha256 不同就是两个模板，即使 id 一样', () => {
    const rows = buildTemplateRows(
      [],
      [
        manifestResult({ templates: [manifestTemplate('gamestart', '官方版')] }),
        manifestResult({
          sourceId: 'intranet',
          sourceName: '内网源',
          templates: [manifestTemplate('gamestart', '内网魔改版', { sha256: 'b'.repeat(64) })]
        })
      ]
    )

    expect(rows).toHaveLength(2)
  })

  it('清单里本地没有的条目单独成行，且带着下载入口', () => {
    const rows = buildTemplateRows(
      [],
      [manifestResult({ templates: [manifestTemplate('thirdperson', '第三人称起步工程')] })]
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].local).toBeNull()
    expect(rows[0].remote?.template.id).toBe('thirdperson')
    expect(rows[0].key).toBe('official/thirdperson')
  })

  it('自制模板没有源信息，永远独立成行', () => {
    const rows = buildTemplateRows(
      [
        localTemplate({ origin: 'user', name: '我的模板 A', path: 'C:/u/a.zip' }),
        localTemplate({ origin: 'user', name: '我的模板 B', path: 'C:/u/b.zip' })
      ],
      []
    )

    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.origin === 'user')).toBe(true)
  })

  it('不认识的分类归到 other，不会因为筛选而消失', () => {
    const rows = buildTemplateRows([localTemplate({ category: 'all' })], [])
    expect(rows[0].category).toBe('other')
  })
})

describe('collectEngineVersions', () => {
  it('按版本号从高到低排，不是按字符串', () => {
    const rows = ['5.4', '5.10', '5.7', '5.4'].map(
      (engineVersion) => ({ engineVersion }) as TemplateRow
    )
    expect(collectEngineVersions(rows)).toEqual(['5.10', '5.7', '5.4'])
  })
})

describe('filterAndSortRows', () => {
  const rows = buildTemplateRows(
    [
      localTemplate({
        name: 'RenderStart',
        path: 'C:/a.zip',
        category: 'render',
        engineVersion: '5.7',
        size: 6504,
        modifiedTime: 3000,
        description: '路径追踪已开'
      }),
      localTemplate({
        name: '我的工程模板',
        path: 'C:/b.zip',
        origin: 'user',
        category: 'game',
        engineVersion: '5.4',
        size: 90000,
        modifiedTime: 5000,
        description: '自己打的包'
      })
    ],
    [
      manifestResult({
        templates: [manifestTemplate('remote-only', 'CityStart', { engineVersion: '5.6' })]
      })
    ]
  )

  const noFilter: RowFilter = { keyword: '', sources: [], categories: [], engineVersions: [] }

  it('搜索跨所有来源，一个框搜到底', () => {
    const hit = filterAndSortRows(rows, { ...noFilter, keyword: 'citystart' }, 'name')
    expect(hit.map((r) => r.name)).toEqual(['CityStart'])
  })

  it('搜索也命中描述', () => {
    const hit = filterAndSortRows(rows, { ...noFilter, keyword: '路径追踪' }, 'name')
    expect(hit.map((r) => r.name)).toEqual(['RenderStart'])
  })

  it('来源筛选只留下那一类', () => {
    const mine = filterAndSortRows(rows, { ...noFilter, sources: ['user'] }, 'name')
    expect(mine.map((r) => r.name)).toEqual(['我的工程模板'])
  })

  it('多个筛选维度是叠加的', () => {
    const hit = filterAndSortRows(
      rows,
      { ...noFilter, sources: ['community'], engineVersions: ['5.7'] },
      'name'
    )
    expect(hit.map((r) => r.name)).toEqual(['RenderStart'])
  })

  it('推荐排序把还没下载的排到最后', () => {
    const sorted = filterAndSortRows(rows, noFilter, 'recommended')
    expect(sorted[sorted.length - 1].name).toBe('CityStart')
  })

  it('推荐排序里自制模板排在社区模板前面', () => {
    const sorted = filterAndSortRows(rows, noFilter, 'recommended')
    expect(sorted[0].name).toBe('我的工程模板')
  })

  it('按大小排是从大到小', () => {
    const sorted = filterAndSortRows(rows, noFilter, 'size')
    expect(sorted[0].name).toBe('我的工程模板')
  })

  it('筛选不改原数组', () => {
    const before = rows.map((r) => r.name)
    filterAndSortRows(rows, noFilter, 'size')
    expect(rows.map((r) => r.name)).toEqual(before)
  })
})
