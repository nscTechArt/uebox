/**
 * 模块机制的价值全在「隔离」上：一个模块写崩了，只能崩它自己。
 * 所以这里重点不是「正常情况能挂上按钮」，而是**每一处回调抛异常时的兜底**——
 * 那才是把资产库那堆云盘代码摘出去之后，真正会救命的东西。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import {
  collectBulkActions,
  collectContextMenuItems,
  collectDetailTabs,
  collectSidebarPanels,
  collectToolbarActions,
  getDefaultEnabledModuleIds,
  getRegisteredModules,
  isActionEnabled,
  registerBrowserModule,
  resetBrowserModules,
  resolveActiveModules,
  type BrowserActionContext,
  type BrowserModule
} from './moduleRegistry'
import type { BrowserContext, BrowserItem, BrowserScope } from './types'

const Stub = defineComponent({ name: 'Stub', template: '<div />' })

function makeItem(id: string): BrowserItem {
  return {
    id,
    name: id,
    kind: 'blueprint',
    folderKey: '',
    tags: [],
    isFavorite: false,
    createdAt: 0,
    updatedAt: 0,
    source: null
  }
}

const scope: BrowserScope = { id: 'blueprint', title: 'menu.blueprintLib', kinds: [], facets: [] }

function makeCtx(selection: BrowserItem[] = []): BrowserActionContext {
  return { scope, folderKey: '', selection, items: [], target: null }
}

function makeModule(overrides: Partial<BrowserModule> & { id: string }): BrowserModule {
  return {
    title: 'x',
    description: 'x',
    enabledByDefault: false,
    ...overrides
  }
}

beforeEach(() => {
  resetBrowserModules()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('注册', () => {
  it('注册进去就能拿出来', () => {
    registerBrowserModule(makeModule({ id: 'baidu' }))
    expect(getRegisteredModules().map((m) => m.id)).toEqual(['baidu'])
  })

  it('重复 id 直接抛 —— 静默覆盖会变成「我的按钮怎么没了」这种查半天的问题', () => {
    registerBrowserModule(makeModule({ id: 'baidu' }))
    expect(() => registerBrowserModule(makeModule({ id: 'baidu' }))).toThrow(/重复/)
  })

  it('没有 id 直接抛', () => {
    expect(() => registerBrowserModule(makeModule({ id: '' }))).toThrow()
  })

  it('默认开启的那批能单独拿出来', () => {
    registerBrowserModule(makeModule({ id: 'a', enabledByDefault: true }))
    registerBrowserModule(makeModule({ id: 'b' }))
    expect(getDefaultEnabledModuleIds()).toEqual(['a'])
  })
})

describe('resolveActiveModules', () => {
  it('没启用的不生效', () => {
    registerBrowserModule(makeModule({ id: 'a' }))
    registerBrowserModule(makeModule({ id: 'b' }))
    expect(resolveActiveModules(makeCtx(), ['a']).map((m) => m.id)).toEqual(['a'])
  })

  it('启用了但当前场景不适用，也不生效 —— 本地保管库里不该出现网络库同步状态', () => {
    registerBrowserModule(makeModule({ id: 'netsync', isAvailable: () => false }))
    expect(resolveActiveModules(makeCtx(), ['netsync'])).toEqual([])
  })

  it('isAvailable 抛异常时按不适用处理，不带崩整个浏览器', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerBrowserModule(
      makeModule({
        id: 'broken',
        isAvailable: () => {
          throw new Error('模块写崩了')
        }
      })
    )
    registerBrowserModule(makeModule({ id: 'ok' }))

    expect(resolveActiveModules(makeCtx(), ['broken', 'ok']).map((m) => m.id)).toEqual(['ok'])
  })
})

describe('收集插槽内容', () => {
  it('工具栏动作带上来源模块，方便出问题时定位', () => {
    registerBrowserModule(
      makeModule({
        id: 'baidu',
        toolbarActions: [{ id: 'upload', label: 'x', run: () => {} }]
      })
    )
    const actions = collectToolbarActions(resolveActiveModules(makeCtx(), ['baidu']), makeCtx())
    expect(actions[0]).toMatchObject({ id: 'upload', moduleId: 'baidu' })
  })

  it('按 order 排序，没填 order 的排在后面且保持注册顺序', () => {
    registerBrowserModule(
      makeModule({
        id: 'a',
        toolbarActions: [
          { id: 'no-order-1', label: 'x', run: () => {} },
          { id: 'last', label: 'x', order: 30, run: () => {} }
        ]
      })
    )
    registerBrowserModule(
      makeModule({
        id: 'b',
        toolbarActions: [
          { id: 'first', label: 'x', order: 10, run: () => {} },
          { id: 'no-order-2', label: 'x', run: () => {} }
        ]
      })
    )

    const actions = collectToolbarActions(resolveActiveModules(makeCtx(), ['a', 'b']), makeCtx())
    expect(actions.map((a) => a.id)).toEqual(['first', 'last', 'no-order-1', 'no-order-2'])
  })

  it('isVisible 说不显示就不显示', () => {
    registerBrowserModule(
      makeModule({
        id: 'a',
        contextMenuItems: [
          { id: 'hidden', label: 'x', isVisible: () => false, run: () => {} },
          { id: 'shown', label: 'x', run: () => {} }
        ]
      })
    )
    const items = collectContextMenuItems(resolveActiveModules(makeCtx(), ['a']), makeCtx())
    expect(items.map((i) => i.id)).toEqual(['shown'])
  })

  it('isVisible 抛异常时只让它自己消失', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerBrowserModule(
      makeModule({
        id: 'a',
        toolbarActions: [
          {
            id: 'broken',
            label: 'x',
            isVisible: () => {
              throw new Error('崩')
            },
            run: () => {}
          },
          { id: 'ok', label: 'x', run: () => {} }
        ]
      })
    )
    const actions = collectToolbarActions(resolveActiveModules(makeCtx(), ['a']), makeCtx())
    expect(actions.map((a) => a.id)).toEqual(['ok'])
  })

  it('侧栏区块和详情页签同样能挂', () => {
    registerBrowserModule(
      makeModule({
        id: 'dep',
        sidebarPanels: [{ id: 'tree', component: Stub }],
        detailTabs: [{ id: 'deps', label: 'x', component: Stub }]
      })
    )
    const active = resolveActiveModules(makeCtx(), ['dep'])
    const ctx: BrowserContext = { scope, folderKey: '', selection: [], items: [] }

    expect(collectSidebarPanels(active, ctx).map((p) => p.id)).toEqual(['tree'])
    expect(collectDetailTabs(active, ctx).map((t) => t.id)).toEqual(['deps'])
  })
})

describe('批量操作', () => {
  it('没选中东西时一个都不出现 —— 摆一个必然点不动的按钮只是噪音', () => {
    registerBrowserModule(
      makeModule({ id: 'a', bulkActions: [{ id: 'bulk', label: 'x', run: () => {} }] })
    )
    const active = resolveActiveModules(makeCtx(), ['a'])
    expect(collectBulkActions(active, makeCtx([]))).toEqual([])
  })

  it('选中了才出现', () => {
    registerBrowserModule(
      makeModule({ id: 'a', bulkActions: [{ id: 'bulk', label: 'x', run: () => {} }] })
    )
    const ctx = makeCtx([makeItem('1'), makeItem('2')])
    const active = resolveActiveModules(ctx, ['a'])
    expect(collectBulkActions(active, ctx).map((x) => x.id)).toEqual(['bulk'])
  })
})

describe('isActionEnabled', () => {
  it('没写 isEnabled 就是能点', () => {
    expect(isActionEnabled({ id: 'a', label: 'x', run: () => {} }, makeCtx())).toBe(true)
  })

  it('写了就听它的', () => {
    expect(
      isActionEnabled({ id: 'a', label: 'x', isEnabled: () => false, run: () => {} }, makeCtx())
    ).toBe(false)
  })

  it('抛异常时按点不动处理 —— 让用户点一个会炸的按钮更糟', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      isActionEnabled(
        {
          id: 'a',
          label: 'x',
          isEnabled: () => {
            throw new Error('崩')
          },
          run: () => {}
        },
        makeCtx()
      )
    ).toBe(false)
  })
})
