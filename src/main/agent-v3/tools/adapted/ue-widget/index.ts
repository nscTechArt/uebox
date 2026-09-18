/**
 * Widget 工具集入口
 * 导出所有 UMG Widget 相关的工具定义
 */

// Phase 1: 只读能力
export { getWidgetHierarchyTool } from './getWidgetHierarchy'

export { createWidgetTool } from './createWidget'

// Phase 3: 通用子控件添加（替代所有专用命令）
export { addChildTool } from './addChild'

// 加完还得挪得动：改已有控件的槽位，不用删了重加
export { setSlotTool } from './setSlot'

// Phase 4: 预览渲染
export { previewWidgetTool } from './previewWidget'

// Phase 5: 事件绑定
export { makeVariableTool } from './makeVariable'
export { setPropertyTool } from './setProperty'
