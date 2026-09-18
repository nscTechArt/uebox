/**
 * 库类页面"专用编辑器 tab"路由的工厂。
 *
 * 蓝图库与材质库各自有一条 `列表页 + :id 编辑器子路由` 的路由结构，编辑器可携带
 * `_tab_id` 查询参数成为独立 tab 实例。两个库的 tabRoute 工具曾经是两份 100%
 * 同构的复制代码，现统一由本工厂生成。
 */

export interface LibraryTabRouteFactory {
  /** 生成一次性的 `_tab_id`（前缀 + 时间戳 + 随机串） */
  createTabId: () => string
  /** 构造打开编辑器并独占 tab 的路由位置对象（供 router.push 使用） */
  buildEditorRoute: (id: string) => LibraryEditorRouteLocation
}

export interface LibraryEditorRouteLocation {
  name: string
  params: { id: string }
  query: { _tab_id: string }
}

export function createLibraryTabRouteFactory(options: {
  tabIdPrefix: string
  routeName: string
}): LibraryTabRouteFactory {
  const { tabIdPrefix, routeName } = options

  function createTabId(): string {
    const timestamp = Date.now().toString(36)
    const randomSuffix = Math.random().toString(36).slice(2, 8)
    return `${tabIdPrefix}-${timestamp}-${randomSuffix}`
  }

  function buildEditorRoute(id: string): LibraryEditorRouteLocation {
    return {
      name: routeName,
      params: { id },
      query: {
        _tab_id: createTabId()
      }
    }
  }

  return { createTabId, buildEditorRoute }
}
