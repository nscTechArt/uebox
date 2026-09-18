/**
 * 库工具 —— 蓝图库 / 材质库和 agent 之间的那根线。
 *
 * 三个工具合起来是一个闭环：
 *   library_search        找片段（只读本地包目录）
 *   blueprint_library_save 从活的工程里存一段（读引擎，写本地）
 *   blueprint_library_apply 放回工程（**唯一会改用户工程的一步**）
 *
 * 存和放走的都是引擎自己的节点序列化（T3D，编辑器 Ctrl+C / Ctrl+V 那对函数），
 * 盒子不重建节点、不翻译。设计与支持范围。
 */

export { createLibrarySearchTool } from './searchLibrary'
export { createBlueprintLibrarySaveTool } from './saveBlueprintSnippet'
export { createBlueprintLibraryApplyTool } from './applyBlueprintSnippet'
