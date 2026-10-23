/**
 * 蓝图库 / 材质库共享壳层类型。
 *
 * 约定：library-common 只承载各库同构的"壳"（面板形态、tab 路由形状）。主要服务蓝图库和
 * 材质库；笔记本也在使用其中的嵌套 Layout 壳 useLibraryLayout。领域模型（Blueprint /
 * MaterialEntry 等）仍然留在各自模块，不在此处合并。
 */

/** AI 对话面板的展示形态：停靠 / 折叠 / 悬浮 */
export type AIPanelMode = 'docked' | 'collapsed' | 'overlay'
