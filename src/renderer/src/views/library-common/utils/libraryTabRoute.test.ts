import { describe, expect, it } from 'vitest'
import { createLibraryTabRouteFactory } from './libraryTabRoute'

describe('createLibraryTabRouteFactory', () => {
  it('生成带领域前缀且不重复的 tab id', () => {
    const { createTabId } = createLibraryTabRouteFactory({
      tabIdPrefix: 'bp-tab',
      routeName: 'BlueprintEditor'
    })
    const id1 = createTabId()
    const id2 = createTabId()
    expect(id1).toMatch(/^bp-tab-[a-z0-9]+-[a-z0-9]+$/)
    expect(id1).not.toBe(id2)
  })

  it('构建携带 _tab_id 的编辑器路由', () => {
    const { buildEditorRoute } = createLibraryTabRouteFactory({
      tabIdPrefix: 'material-tab',
      routeName: 'MaterialEditor'
    })
    const route = buildEditorRoute('material-1')
    expect(route.name).toBe('MaterialEditor')
    expect(route.params).toEqual({ id: 'material-1' })
    expect(route.query._tab_id).toMatch(/^material-tab-/)
  })
})
