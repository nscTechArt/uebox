import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GENERATED_CATALOG } from '@core/main/ai/catalog.generated'
import zhCN from '@renderer/i18n/locales/zh-CN'
import enUS from '@renderer/i18n/locales/en-US'

/**
 * 「添加 Provider」弹窗按分区渲染，分区顺序是一张**写死的白名单**
 * （ProviderCatalogModal.vue 的 GROUP_ORDER）。目录里出现了白名单没有的分区，
 * 那一区会**整区不显示，而且不报错**。
 *
 * 分区键有两个来源：对话类按 `CatalogGroup`（从哪儿买算力），其余按
 * `ProviderKind`（用途）。两边都要在白名单里。
 *
 * 这不是假设。「向量化」那一组加进目录之后就正好这样漏了一次：7 家厂商 20 个模型
 * 全都在 catalog.generated.ts 里，能力位也都标对了，界面上却一个都找不到 ——
 * 表现和「根本没加」完全一样，只能靠人肉点开弹窗才发现。
 *
 * 所以这里不测渲染，只测**两张表对得上**：目录里有的组，白名单要有；
 * 白名单里有的组，两份 i18n 都要有对应文案。
 */

const MODAL_PATH = join(__dirname, 'ProviderCatalogModal.vue')

/**
 * 从源码里把 GROUP_ORDER 抠出来。
 *
 * 直接 import 那个 .vue 要拉起整个组件依赖（ant-design-vue、图标包），
 * 而这条断言只关心一个字符串数组 —— 读源码比把组件挂起来便宜得多，
 * 也不会因为组件依赖变动而假红。
 */
function readGroupOrder(): string[] {
  const source = readFileSync(MODAL_PATH, 'utf-8')
  // 类型名跟着「模态上移到 ProviderKind」那次重构从 CatalogGroup 变成了
  // SectionKey，所以这里不锚类型名 —— 锚的是变量名本身
  const match = /const GROUP_ORDER: \w+\[\] = \[([\s\S]*?)\]/.exec(source)
  if (!match) throw new Error('没能在 ProviderCatalogModal.vue 里找到 GROUP_ORDER')
  // 组名里可能带数字（model3d），`[a-z]+` 会**静默漏掉**它 —— 那正好是这条
  // 测试要防的那种「不报错的缺失」，只不过发生在守门人自己身上
  return Array.from(match[1].matchAll(/'([a-z0-9]+)'/g)).map((item) => item[1])
}

describe('Provider 目录的分组白名单', () => {
  const groupOrder = readGroupOrder()

  it('目录里出现的每个分组，弹窗都渲染得出来', () => {
    // 没写 group 的条目按 'cloud' 处理，与弹窗里的取值逻辑保持一致
    const inCatalog = [
      ...new Set(
        GENERATED_CATALOG.map((entry) =>
          entry.kind === 'chat' ? (entry.group ?? 'cloud') : entry.kind
        )
      )
    ]
    const missing = inCatalog.filter((group) => !groupOrder.includes(group))

    expect(
      missing,
      `这些分组在目录里有厂商，但 GROUP_ORDER 里没有，界面上会整组消失：${missing.join(', ')}`
    ).toEqual([])
  })

  it('白名单里的每个分组两份 i18n 都有文案', () => {
    for (const [name, locale] of [
      ['zh-CN', zhCN],
      ['en-US', enUS]
    ] as const) {
      const labels =
        (locale as { aiProvider?: { catalog?: { group?: Record<string, string> } } }).aiProvider
          ?.catalog?.group ?? {}
      const missing = groupOrder.filter((group) => !labels[group])

      expect(missing, `${name} 缺这些分组的文案：${missing.join(', ')}`).toEqual([])
    }
  })

  /** 漏了这一条就说明向量化那批厂商又被挡在界面外面了 */
  it('向量化分组确实能显示出来', () => {
    expect(groupOrder).toContain('embedding')
    expect(GENERATED_CATALOG.some((entry) => entry.kind === 'embedding')).toBe(true)
    expect(GENERATED_CATALOG.some((entry) => entry.id === 'jina')).toBe(true)
  })
})
