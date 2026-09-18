/**
 * 这层翻译错一个字段，浏览器里就是「东西不见了」或者「点开是别的蓝图」。
 * 重点钉住两条容易错的：没归集合的要落在根目录，类型选项要从真实数据里现算。
 */
import { describe, expect, it } from 'vitest'

import { buildTypeFacet, toBrowserFolders, toBrowserItems } from './blueprintBrowser'
import type { Blueprint, BlueprintCollection } from '../types/blueprint'

function makeBp(overrides: Partial<Blueprint> & { id: string }): Blueprint {
  return {
    name: overrides.id,
    blueprintType: 'Actor',
    engineVersion: '5.5',
    description: '',
    tags: [],
    createdAt: 1,
    updatedAt: 2,
    isFavorite: false,
    status: 'draft',
    graphs: [],
    functions: [],
    variables: [],
    components: [],
    eventDispatchers: [],
    macros: [],
    ...overrides
  } as Blueprint
}

const stats = (): string => '1 图表'

describe('toBrowserItems', () => {
  it('带上原对象，编辑器和筛选还要拿它', () => {
    const bp = makeBp({ id: 'a', name: '跳跃逻辑' })
    const [item] = toBrowserItems([bp], stats)

    expect(item).toMatchObject({ id: 'a', name: '跳跃逻辑', kind: 'blueprint' })
    expect(item.source).toBe(bp)
  })

  it('没归集合的落在根目录 —— 否则它在树上哪儿都找不到', () => {
    expect(toBrowserItems([makeBp({ id: 'a' })], stats)[0].folderKey).toBe('')
  })

  it('归了集合的用集合 id 当 folderKey', () => {
    const items = toBrowserItems([makeBp({ id: 'a', collectionId: 'col-1' })], stats)
    expect(items[0].folderKey).toBe('col-1')
  })

  it('副标题带类型和引擎版本；没版本时不留一个孤零零的分隔符', () => {
    expect(toBrowserItems([makeBp({ id: 'a' })], stats)[0].subtitle).toContain('UE 5.5')
    const noVersion = toBrowserItems([makeBp({ id: 'b', engineVersion: '' })], stats)[0]
    expect(noVersion.subtitle).not.toContain('·')
  })

  it('tags 缺失时给空数组 —— 卡片会直接 .length，undefined 会炸', () => {
    const bp = makeBp({ id: 'a' })
    delete (bp as { tags?: string[] }).tags
    expect(toBrowserItems([bp], stats)[0].tags).toEqual([])
  })
})

describe('toBrowserFolders', () => {
  it('集合变成平铺的一层文件夹', () => {
    const collections: BlueprintCollection[] = [
      { id: 'c1', name: '角色', blueprintIds: [], createdAt: 0 }
    ]
    expect(toBrowserFolders(collections)).toEqual([{ key: 'c1', name: '角色', parentKey: null }])
  })
})

describe('buildTypeFacet', () => {
  it('选项从真实数据里现算 —— 写死枚举会让导入的旧类型筛不出来', () => {
    const facet = buildTypeFacet([
      makeBp({ id: 'a', blueprintType: 'Actor' }),
      makeBp({ id: 'b', blueprintType: 'Widget' as Blueprint['blueprintType'] }),
      makeBp({ id: 'c', blueprintType: 'Actor' })
    ])
    expect(facet.options.map((o) => o.value)).toEqual(['Actor', 'Widget'])
  })

  it('可以补上代码里预置的类型，即使一个蓝图都还没有', () => {
    const facet = buildTypeFacet([], ['Actor', 'Pawn'])
    expect(facet.options.map((o) => o.value)).toEqual(['Actor', 'Pawn'])
  })
})
