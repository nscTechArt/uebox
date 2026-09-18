/**
 * 蓝图库 / 材质库共享壳层类型。
 *
 * 约定：library-common 只承载两库同构的"壳"（面板形态、排序语义、tab 路由形状），
 * 领域模型（Blueprint / MaterialEntry 等）仍然留在各自模块，不在此处合并。
 */

/** AI 聊天面板的展示形态：停靠 / 折叠 / 悬浮 */
export type AIPanelMode = 'docked' | 'collapsed' | 'overlay'

/** Gallery 排序语义（两库行为一致：recent 按 updatedAt、name 按名称、created 按创建时间） */
export type LibrarySortType = 'recent' | 'name' | 'created'

/** Gallery 视图模式 */
export type LibraryViewMode = 'grid' | 'list'
