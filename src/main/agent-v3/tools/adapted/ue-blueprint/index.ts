/**
 * UE Blueprint 蓝图工具模块入口
 * 提供虚幻引擎蓝图开发工具
 */

/**
 * ## 写图只有一个工具
 *
 * `applyBlueprintGraph` 取代了此前六个节点级写图工具（add_node /
 * connect_pins / set_pin_value / delete_node / add_timeline /
 * createBlueprintGraph）。那些文件已经删掉 —— 留着「以防万一」只会让它们
 * 重新出现在工具池里，而工具池里有六个功能重叠的写工具本身就是缺陷：
 * 真机评测里模型选对了批量那个，被插件顶回来后退回逐节点，
 * 三十分钟写了十个节点。
 *
 * 要改图：`getBlueprintGraph` 读 → 改 → `applyBlueprintGraph` 整份写回。
 * 不知道函数叫什么、有哪些引脚：先 `searchBlueprintNodes`。
 */
export { createDescribeBlueprintTool } from './describeBlueprint'
export { createBlueprintTool } from './createBlueprint'
export { createAddComponentToBlueprintTool } from './addComponentToBlueprint'
export { createSetBlueprintPropertyTool } from './setBlueprintProperty'
export { createCompileBlueprintTool } from './compileBlueprint'
export { createCreateBlueprintFunctionTool } from './createBlueprintFunction'
export { createAddBlueprintVariableTool } from './addBlueprintVariable'
export { createGetBlueprintGraphTool } from './getBlueprintGraph'
export { createSearchBlueprintNodesTool } from './searchBlueprintNodes'
export { createApplyBlueprintGraphTool } from './applyBlueprintGraph'
export { createCompileAllBlueprintsTool } from './compileAllBlueprints'
export { createTidyBlueprintGraphTool } from './tidyBlueprintGraph'

/**
 * ## 成员的「调」与「删」
 *
 * 上面那批只能**加**成员。这三个补上调整和删除 —— 尤其是变量元数据：
 * 建出来的变量默认不暴露给实例，而「让策划在场景里逐个实例调」
 * 才是蓝图变量最常见的用途。
 */
export {
  createSetBlueprintVariableMetaTool,
  createRemoveBlueprintVariableTool,
  createBlueprintEventDispatcherTool,
  createBlueprintComponentEventTool,
  createBlueprintFunctionSignatureTool,
  createSetBlueprintParentClassTool
} from './blueprintMembers'

/** 图编辑的两个逆操作：删节点、断连线。理由见 graphEditing.ts 文件头 */
export { createDeleteBlueprintNodeTool, createDisconnectBlueprintPinsTool } from './graphEditing'
