import { createLibraryTabRouteFactory } from '@renderer/views/library-common/utils/libraryTabRoute'

/** 蓝图编辑器"专用 tab"路由工具（实现见 library-common 工厂） */
const factory = createLibraryTabRouteFactory({
  tabIdPrefix: 'bp-tab',
  routeName: 'BlueprintEditor'
})

export function createBlueprintTabId(): string {
  return factory.createTabId()
}

export function buildBlueprintEditorRoute(id: string) {
  return factory.buildEditorRoute(id)
}
