import { describe, expect, it } from 'vitest'
import { GENERATED_CATALOG } from '@core/main/ai/catalog.generated'
import zhCN from '@renderer/i18n/locales/zh-CN'
import enUS from '@renderer/i18n/locales/en-US'
import {
  ALL_SECTION_KEYS,
  SECTION_ORDER,
  sectionOf,
  TAB_ORDER,
  TAB_SECTIONS,
  tabOfSection
} from './providerCatalogSections'

/**
 * 「添加服务商」弹窗按分页 → 分区渲染，两张表都是**写死的白名单**
 * （providerCatalogSections.ts）。目录里出现了白名单没有的分区，
 * 那一区会**整区不显示，而且不报错**。
 *
 * 分区键有两个来源：对话类按 `CatalogGroup`（从哪儿买算力），其余按
 * `ProviderKind`（用途）。两边都要登记，而且都要归到某个分页底下 ——
 * 加了分区却没归页，等于没加。
 *
 * 这不是假设。「向量化」那一组加进目录之后就正好这样漏了一次：7 家厂商 20 个模型
 * 全都在 catalog.generated.ts 里，能力位也都标对了，界面上却一个都找不到 ——
 * 表现和「根本没加」完全一样，只能靠人肉点开弹窗才发现。
 *
 * 所以这里不测渲染，只测**几张表对得上**。和从前那版相比，守的范围从
 * 「目录里已经出现过的分区」扩到了**类型里所有可能的分区** —— 也就是说
 * 新增一种能力的那一刻就会红，不必等到第一家厂商进目录。
 */
describe('Provider 目录的分区白名单', () => {
  it('类型里每一个可能的分区都归进了某个分页', () => {
    const missing = ALL_SECTION_KEYS.filter((section) => !tabOfSection(section))

    expect(missing, `这些分区没归进任何分页，界面上会整区消失：${missing.join(', ')}`).toEqual([])
  })

  it('同一个分区不会被两个分页抢走', () => {
    const seen = new Set<string>()
    const duplicated: string[] = []
    for (const section of SECTION_ORDER) {
      if (seen.has(section)) duplicated.push(section)
      seen.add(section)
    }

    expect(
      duplicated,
      `这些分区在 TAB_SECTIONS 里出现了不止一次：${duplicated.join(', ')}`
    ).toEqual([])
  })

  it('目录里出现的每个分区，弹窗都渲染得出来', () => {
    const inCatalog = [...new Set(GENERATED_CATALOG.map(sectionOf))]
    const missing = inCatalog.filter((section) => !SECTION_ORDER.includes(section))

    expect(
      missing,
      `这些分区在目录里有厂商，但白名单里没有，界面上会整组消失：${missing.join(', ')}`
    ).toEqual([])
  })

  it('每个分页底下都真的有厂商', () => {
    // 空分页是个死按钮：点进去只有一句「没有匹配的厂商」，而用户什么都没搜
    const counts = Object.fromEntries(TAB_ORDER.map((tab) => [tab, 0])) as Record<string, number>
    for (const entry of GENERATED_CATALOG) {
      const tab = tabOfSection(sectionOf(entry))
      if (tab) counts[tab] += 1
    }
    const empty = TAB_ORDER.filter((tab) => counts[tab] === 0)

    expect(empty, `这些分页一家厂商都没有：${empty.join(', ')}`).toEqual([])
  })

  it('分区和分页两份 i18n 都有文案', () => {
    for (const [name, locale] of [
      ['zh-CN', zhCN],
      ['en-US', enUS]
    ] as const) {
      const catalog = (
        locale as {
          aiProvider?: {
            catalog?: { group?: Record<string, string>; tab?: Record<string, string> }
          }
        }
      ).aiProvider?.catalog

      const missingSections = SECTION_ORDER.filter((section) => !catalog?.group?.[section])
      expect(missingSections, `${name} 缺这些分区的文案：${missingSections.join(', ')}`).toEqual([])

      const missingTabs = TAB_ORDER.filter((tab) => !catalog?.tab?.[tab])
      expect(missingTabs, `${name} 缺这些分页的文案：${missingTabs.join(', ')}`).toEqual([])
    }
  })

  /** 漏了这一条就说明向量化那批厂商又被挡在界面外面了 */
  it('向量化分区确实能显示出来', () => {
    expect(TAB_SECTIONS.retrieval).toContain('embedding')
    expect(GENERATED_CATALOG.some((entry) => entry.kind === 'embedding')).toBe(true)
    expect(GENERATED_CATALOG.some((entry) => entry.id === 'jina')).toBe(true)
  })
})
