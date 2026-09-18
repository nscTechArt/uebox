/**
 * 蓝图库 v2 类型定义
 * 基于 UE 蓝图编辑器结构设计
 *
 * 层级关系：
 *   蓝图列表 (Gallery) → 蓝图详情 (Editor)
 *   一个蓝图 = 图表 + 函数 + 变量 + 组件 + 事件分发器 + 宏
 */

import meshBlue from '@renderer/assets/imgs/blueprint-covers/mesh-blue.png'
import meshPurple from '@renderer/assets/imgs/blueprint-covers/mesh-purple.png'
import meshGreen from '@renderer/assets/imgs/blueprint-covers/mesh-green.png'
import meshAmber from '@renderer/assets/imgs/blueprint-covers/mesh-amber.png'
import meshCyan from '@renderer/assets/imgs/blueprint-covers/mesh-cyan.png'
import meshLime from '@renderer/assets/imgs/blueprint-covers/mesh-lime.png'
import meshSlate from '@renderer/assets/imgs/blueprint-covers/mesh-slate.png'
import meshOrange from '@renderer/assets/imgs/blueprint-covers/mesh-orange.png'
import meshRose from '@renderer/assets/imgs/blueprint-covers/mesh-rose.png'

// ============================================================
//  蓝图（一级对象 — Gallery 里的卡片）
// ============================================================

/** 蓝图类型 */
export type BlueprintType =
  | 'BlueprintClass'
  | 'WidgetBlueprint'
  | 'LevelBlueprint'
  | 'AnimationBlueprint'
  | 'ActorComponentBlueprint'
  | 'GameModeBlueprint'
  | 'BlueprintInterface'
  | 'BlueprintMacroLibrary'
  | 'BlueprintFunctionLibrary'
  | string // 允许自定义类型

/** 蓝图状态 */
export type BlueprintStatus = 'draft' | 'verified' | 'archived'

/** 蓝图数据 */
export interface Blueprint {
  /** 唯一标识 */
  id: string
  /** 蓝图名称 */
  name: string
  /** 蓝图类型 */
  blueprintType: BlueprintType
  /** 引擎版本 */
  engineVersion: string
  /** 描述 */
  description: string
  /** 标签 */
  tags: string[]
  /** 封面/缩略图（base64 或 URL） */
  thumbnail?: string
  /** 封面渐变样式（无自定义图时的随机渐变） */
  coverStyle?: string
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
  /** 是否收藏 */
  isFavorite: boolean
  /** 状态 */
  status: BlueprintStatus

  // ---- 内部结构 ----
  /** 图表列表 */
  graphs: BlueprintGraph[]
  /** 函数列表 */
  functions: BlueprintFunction[]
  /** 变量列表 */
  variables: BlueprintVariable[]
  /** 组件列表 */
  components: BlueprintComponent[]
  /** 事件分发器列表 */
  eventDispatchers: BlueprintEventDispatcher[]
  /** 宏列表 */
  macros: BlueprintMacro[]

  // ---- 集合 ----
  /** 所属集合 ID（为空则不属于任何集合） */
  collectionId?: string
}

// ============================================================
//  图表（Event Graph / Construction Script / 自定义图表）
// ============================================================

/** 图表类型 */
export type GraphType = 'event' | 'construction' | 'custom'

/** 蓝图图表 */
export interface BlueprintGraph {
  /** 唯一标识 */
  id: string
  /** 图表名称（EventGraph / Construction Script / 自定义） */
  name: string
  /** 图表类型 */
  type: GraphType
  /** UE 蓝图导出代码（Begin Object ... End Object） */
  code: string
  /** 内部节点数量 */
  nodeCount: number
  /** 描述 */
  description: string
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

// ============================================================
//  函数
// ============================================================

/** 函数参数 */
export interface FunctionParam {
  /** 参数名 */
  name: string
  /** 参数类型（Boolean, Float, Vector, FString...） */
  type: string
  /** 默认值 */
  defaultValue?: string
}

/** 蓝图函数 */
export interface BlueprintFunction {
  /** 唯一标识 */
  id: string
  /** 函数名称 */
  name: string
  /** 输入参数 */
  inputs: FunctionParam[]
  /** 输出参数 */
  outputs: FunctionParam[]
  /** UE 蓝图导出代码 */
  code: string
  /** 描述 */
  description: string
  /** 是否纯函数（无副作用） */
  isPure: boolean
  /** 访问权限 */
  access: 'public' | 'protected' | 'private'
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

// ============================================================
//  变量
// ============================================================

/** UE 变量类型 */
export type VariableType =
  | 'Boolean'
  | 'Byte'
  | 'Integer'
  | 'Integer64'
  | 'Float'
  | 'Double'
  | 'Name'
  | 'String'
  | 'Text'
  | 'Vector'
  | 'Rotator'
  | 'Transform'
  | 'Color'
  | 'LinearColor'
  | 'Object'
  | 'Class'
  | 'Interface'
  | 'Enum'
  | 'Struct'
  | 'Array'
  | 'Set'
  | 'Map'
  | string // 自定义类型

/** 蓝图变量 */
export interface BlueprintVariable {
  /** 唯一标识 */
  id: string
  /** 变量名称 */
  name: string
  /** 变量类型 */
  type: VariableType
  /** 默认值 */
  defaultValue: string
  /** 是否可在编辑器中编辑 */
  isEditable: boolean
  /** 是否蓝图只读 */
  isBlueprintReadOnly: boolean
  /** 是否暴露到外部 */
  isExposedOnSpawn: boolean
  /** 分类 */
  category: string
  /** 描述 / 提示文字 */
  description: string
  /** 复制方式 */
  replication: 'none' | 'replicated' | 'repNotify'
  /** 创建时间 */
  createdAt: number
}

// ============================================================
//  组件
// ============================================================

/** 蓝图组件 */
export interface BlueprintComponent {
  /** 唯一标识 */
  id: string
  /** 组件名称 */
  name: string
  /** 组件类型（StaticMeshComponent, CapsuleComponent, ...） */
  componentClass: string
  /** 是否为根组件 */
  isRoot: boolean
  /** 父组件 ID（用于层级关系） */
  parentId?: string
  /** 是否继承自父类（在C++中编辑） */
  isInherited: boolean
  /** 描述 */
  description: string
}

// ============================================================
//  事件分发器 (Event Dispatchers)
// ============================================================

/** 蓝图事件分发器 */
export interface BlueprintEventDispatcher {
  /** 唯一标识 */
  id: string
  /** 分发器名称 */
  name: string
  /** 参数列表 */
  params: FunctionParam[]
  /** 描述 */
  description: string
  /** 创建时间 */
  createdAt: number
}

// ============================================================
//  宏 (Macros)
// ============================================================

/** 蓝图宏 */
export interface BlueprintMacro {
  /** 唯一标识 */
  id: string
  /** 宏名称 */
  name: string
  /** 输入参数 */
  inputs: FunctionParam[]
  /** 输出参数 */
  outputs: FunctionParam[]
  /** UE 蓝图导出代码 */
  code: string
  /** 描述 */
  description: string
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

// ============================================================
//  蓝图集合（Gallery 里的分组卡片）
// ============================================================

/** 蓝图集合（用于将多个蓝图归为一组） */
export interface BlueprintCollection {
  /** 唯一标识 */
  id: string
  /** 集合名称 */
  name: string
  /** 集合内蓝图 ID 列表 */
  blueprintIds: string[]
  /** 创建时间 */
  createdAt: number
}

// ============================================================
//  Gallery / UI 相关类型
// ============================================================

/** 列表视图模式 */
export type GalleryViewMode = 'grid' | 'list'

/** 列表分类筛选 */
export type GalleryCategory = 'all' | 'my' | 'featured'

/** 排序方式 */
export type GallerySortType = 'recent' | 'name' | 'created'

/** 蓝图内部元素类型（侧栏导航用） */
export type BlueprintElementType =
  | 'graph'
  | 'function'
  | 'variable'
  | 'component'
  | 'eventDispatcher'
  | 'macro'

/** 蓝图统计信息（Gallery 卡片展示） */
export interface BlueprintStats {
  graphCount: number
  functionCount: number
  variableCount: number
  componentCount: number
  eventDispatcherCount: number
  macroCount: number
}

/** 计算蓝图统计信息 */
export function getBlueprintStats(bp: Blueprint): BlueprintStats {
  return {
    graphCount: bp.graphs.length,
    functionCount: bp.functions.length,
    variableCount: bp.variables.length,
    componentCount: bp.components.length,
    eventDispatcherCount: bp.eventDispatchers.length,
    macroCount: bp.macros.length
  }
}

/** 蓝图类型中文名称映射 */
export const BLUEPRINT_TYPE_LABELS: Record<string, string> = {
  BlueprintClass: 'Actor 蓝图',
  WidgetBlueprint: '控件蓝图',
  LevelBlueprint: '关卡蓝图',
  AnimationBlueprint: '动画蓝图',
  ActorComponentBlueprint: '组件蓝图',
  GameModeBlueprint: '游戏模式蓝图',
  BlueprintInterface: '蓝图接口',
  BlueprintMacroLibrary: '蓝图宏库',
  BlueprintFunctionLibrary: '蓝图函数库'
}

/** 获取蓝图类型中文名（带兜底） */
export function getBlueprintTypeLabel(blueprintType: string): string {
  return BLUEPRINT_TYPE_LABELS[blueprintType] || blueprintType
}

// ============================================================
//  蓝图类型 → 封面网格渐变图（Apple Mesh Gradient 风格）
// ============================================================

/** 每种蓝图类型对应的封面网格渐变图 */
export const BLUEPRINT_TYPE_COVERS: Record<string, string> = {
  BlueprintClass: meshBlue,
  WidgetBlueprint: meshPurple,
  LevelBlueprint: meshGreen,
  AnimationBlueprint: meshAmber,
  ActorComponentBlueprint: meshCyan,
  GameModeBlueprint: meshLime,
  BlueprintInterface: meshSlate,
  BlueprintMacroLibrary: meshOrange,
  BlueprintFunctionLibrary: meshRose
}

/** 兜底封面 */
const COVER_FALLBACK = meshSlate

/** 获取蓝图类型对应的封面样式 */
export function getCoverForType(blueprintType: string): string {
  const img = BLUEPRINT_TYPE_COVERS[blueprintType] || COVER_FALLBACK
  return `background-image: url(${img}); background-size: cover; background-position: center`
}

/** Detect whether a cover source should be rendered as video. */
export function isBlueprintCoverVideo(source?: string): boolean {
  if (!source) return false
  if (source.startsWith('data:video/')) return true
  const normalized = source.toLowerCase().split('?')[0]
  return ['.mp4', '.webm', '.ogg', '.mov'].some((ext) => normalized.endsWith(ext))
}

/**
 * 封面样式里是否引用了只在某一次安装里有效的资源地址。
 *
 * coverStyle 曾被直接持久化（旧版导入、新建蓝图），里面带的是生成那一刻解析出的
 * 内置封面图地址 —— 打包产物里是 file:///...app.asar/...（换机器、dev 的 http 源
 * 都加载不了，控制台报 "Not allowed to load local resource"），dev 里是 /src/...
 * （打包后同样失效）。这类死链在渲染时一律忽略，回退到按 blueprintType 现取的封面。
 */
export function coverStyleHasDeadAssetUrl(coverStyle: string): boolean {
  return /url\(\s*['"]?(?:file:|\/assets\/|\/src\/)/i.test(coverStyle)
}

/** 获取蓝图卡片应展示的封面样式 */
export function getBlueprintCoverStyle(
  blueprint: Pick<Blueprint, 'blueprintType' | 'thumbnail' | 'coverStyle'>
): string {
  if (blueprint.thumbnail && !isBlueprintCoverVideo(blueprint.thumbnail)) {
    return `background-image: url(${blueprint.thumbnail}); background-size: cover; background-position: center`
  }
  if (blueprint.coverStyle?.trim() && !coverStyleHasDeadAssetUrl(blueprint.coverStyle)) {
    return blueprint.coverStyle
  }
  return getCoverForType(blueprint.blueprintType)
}

// ============================================================
//  蓝图类型 → SVG 图标路径
// ============================================================

/** 每种蓝图类型对应的 SVG path（viewBox 0 0 24 24） */
export const BLUEPRINT_TYPE_ICONS: Record<string, string> = {
  // Actor 蓝图 — 立方体
  BlueprintClass:
    'M21 16.5c0 .38-.21.71-.53.88l-7.9 4.44c-.16.12-.36.18-.57.18s-.41-.06-.57-.18l-7.9-4.44A.991.991 0 0 1 3 16.5v-9c0-.38.21-.71.53-.88l7.9-4.44c.16-.12.36-.18.57-.18s.41.06.57.18l7.9 4.44c.32.17.53.5.53.88v9z',
  // 控件蓝图 — 窗口/UI面板
  WidgetBlueprint:
    'M3 3h18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 4v12h16V7H4zm1-3v1h2V4H5zm4 0v1h2V4H9z',
  // 关卡蓝图 — 地球/世界
  LevelBlueprint:
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
  // 动画蓝图 — 运动/奔跑人形
  AnimationBlueprint:
    'M13.49 5.48c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm-3.6 13.9 1-4.4 2.1 2v6h2v-7.5l-2.1-2 .6-3c1.3 1.5 3.3 2.5 5.5 2.5v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1l-5.2 2.2v4.7h2v-3.4l1.8-.7-1.6 8.1-4.9-1-.4 2 7 1.4z',
  // 组件蓝图 — 拼图块
  ActorComponentBlueprint:
    'M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z',
  // 游戏模式蓝图 — 游戏手柄
  GameModeBlueprint:
    'M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
  // 蓝图接口 — 连接/接口
  BlueprintInterface: 'M18 4h2v16h-2zM4 4h2v16H4zm7 0h2v4h-2zm0 6h2v4h-2zm0 6h2v4h-2z',
  // 蓝图宏库 — 闪电/宏
  BlueprintMacroLibrary: 'M7 2v11h3v9l7-12h-4l4-8z',
  // 蓝图函数库 — 函数 f(x) 符号
  BlueprintFunctionLibrary:
    'M15.6 5.29c-1.1-.1-2.07.71-2.17 1.82L13.18 10H16v2h-3.07l-.39 4.07c-.2 2.01-1.86 3.58-3.88 3.58-.11 0-.22 0-.33-.02-2.02-.2-3.5-1.97-3.3-3.99l.3-3.15L3.4 12l.18-1.82 1.55.16.42-4.36c.2-2.01 1.86-3.58 3.88-3.58.11 0 .22.01.33.02 2.02.2 3.5 1.97 3.3 3.99l-.25 2.59h3.77l-.18 1.82H12.6l-.26 2.72c-.08.82.53 1.55 1.35 1.63.05 0 .1.01.15.01.77 0 1.42-.56 1.54-1.31l.64-6.65c.08-.82-.53-1.55-1.35-1.63-.09-.01-.18-.02-.27-.01h-.15z'
}

/** 兜底图标 — 蓝图/文档 */
const ICON_FALLBACK =
  'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z'

/** 获取蓝图类型对应的 SVG 图标路径 */
export function getIconForType(blueprintType: string): string {
  return BLUEPRINT_TYPE_ICONS[blueprintType] || ICON_FALLBACK
}

/** @deprecated 向后兼容旧代码 */
export function getParentClassLabel(parentClass: string): string {
  return getBlueprintTypeLabel(parentClass)
}

/** 变量类型颜色映射（和 UE 编辑器一致） */
export const VARIABLE_TYPE_COLORS: Record<string, string> = {
  Boolean: '#8B0000',
  Byte: '#006464',
  Integer: '#1CB898',
  Integer64: '#11998E',
  Float: '#9ACD32',
  Double: '#7CBB3E',
  Name: '#9370DB',
  String: '#FF69B4',
  Text: '#FF1493',
  Vector: '#FFD700',
  Rotator: '#9999FF',
  Transform: '#F28C28',
  Color: '#FF4500',
  LinearColor: '#FF6347',
  Object: '#0078D7',
  Class: '#7B2FBE',
  Interface: '#B0C4DE',
  Enum: '#228B22',
  Struct: '#4169E1',
  Array: '#808080',
  Set: '#808080',
  Map: '#808080'
}

/** 获取变量类型颜色 */
export function getVariableTypeColor(type: string): string {
  return VARIABLE_TYPE_COLORS[type] || '#808080'
}

/** 变量类型中文名称映射 */
export const VARIABLE_TYPE_LABELS: Record<string, string> = {
  Boolean: '布尔',
  Byte: '字节',
  Integer: '整数',
  Integer64: '整数64',
  Float: '浮点',
  Double: '双精度',
  Name: 'Name',
  String: '字符串',
  Text: '文本',
  Vector: '向量',
  Rotator: '旋转体',
  Transform: '变换',
  Color: '颜色',
  LinearColor: '线性颜色',
  Object: '对象',
  Class: '类',
  Interface: '接口',
  Enum: '枚举',
  Struct: '结构体',
  Array: '数组',
  Set: '集合',
  Map: '映射'
}

/** 获取变量类型中文名（带兜底） */
export function getVariableTypeLabel(
  type: string,
  containerType?: string,
  subType?: string
): string {
  const baseLabel = VARIABLE_TYPE_LABELS[type] || type
  const displayLabel = subType || baseLabel
  if (containerType) {
    const containerLabel = VARIABLE_TYPE_LABELS[containerType] || containerType
    return `${containerLabel}<${displayLabel}>`
  }
  return displayLabel
}
