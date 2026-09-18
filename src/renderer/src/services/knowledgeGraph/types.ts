/**
 * 知识图谱类型定义
 * 针对虚幻引擎和数字内容创作领域的领域专用实体分类
 */

/**
 * 实体类别
 * - 核心引擎层: class, feature, node, asset
 * - 生产管线层: workflow, format, setting
 * - 生态环境层: tool, platform, plugin
 * - 问题解决层: issue, solution, concept
 */
import i18n from '@renderer/i18n'

export type EntityCategory =
  | 'class'
  | 'feature'
  | 'node'
  | 'asset'
  | 'workflow'
  | 'format'
  | 'setting'
  | 'tool'
  | 'platform'
  | 'plugin'
  | 'issue'
  | 'solution'
  | 'concept'

/**
 * 关系类型
 * - 结构关系: is_a, contains, part_of
 * - 流程与逻辑: requires, outputs, uses, solves, conflicts_with
 */
export type RelationType =
  | 'is_a' // 分类 (A 是 B 的一种)
  | 'contains' // 包含 (A 包含 B)
  | 'part_of' // 从属 (A 属于 B)
  | 'requires' // 依赖/前置条件
  | 'outputs' // 输出/生成
  | 'uses' // 使用
  | 'solves' // 解决
  | 'conflicts_with' // 冲突/互斥
  // 兼容旧版本
  | 'prerequisite'
  | 'unlocks'
  | 'fixes'
  | 'exports'

/**
 * 实体类别配置（颜色和图标）
 */
/**
 * 实体分类配置。
 *
 * **只有图标和颜色。** 这里原来还带一份写死的英文 `label`（`'Class/API'`、
 * `'Workflow'`…），而它是图例和节点提示上唯一的文字 —— 中文用户看到的是
 * 中文连线配英文图例，正好是隔壁 `RELATION_CONFIG` 刚修掉那个问题的镜像。
 *
 * 文案挪到 `notebook.graph.categories.*`，分类名本身就是 key。
 */
export const CATEGORY_CONFIG: Record<EntityCategory, { icon: string; color: string }> = {
  // 核心引擎层
  class: { icon: '🧩', color: '#2196F3' },
  feature: { icon: '✨', color: '#9C27B0' },
  node: { icon: '🔗', color: '#00BCD4' },
  asset: { icon: '📦', color: '#607D8B' },
  // 生产管线层
  workflow: { icon: '⚗️', color: '#4CAF50' },
  format: { icon: '💾', color: '#795548' },
  setting: { icon: '🔧', color: '#9E9E9E' },
  // 生态环境层
  tool: { icon: '🛠️', color: '#FF9800' },
  platform: { icon: '🖥️', color: '#3F51B5' },
  plugin: { icon: '🔌', color: '#E91E63' },
  // 问题解决层
  issue: { icon: '🐞', color: '#F44336' },
  solution: { icon: '💊', color: '#8BC34A' },
  concept: { icon: '💡', color: '#FFC107' }
}

/** 分类在界面上叫什么。认不出的原样显示 —— 图谱是模型生成的 */
export function categoryLabel(category: EntityCategory | string): string {
  const key = `notebook.graph.categories.${category}`
  const copy = i18n.global.t(key)
  return copy === key ? String(category) : copy
}

export const RELATION_CONFIG: Record<RelationType, { color: string }> = {
  // 结构关系
  is_a: { color: '#03A9F4' },
  contains: { color: '#2196F3' },
  part_of: { color: '#3F51B5' },
  // 流程与逻辑
  requires: { color: '#FF5722' },
  outputs: { color: '#4CAF50' },
  uses: { color: '#9C27B0' },
  solves: { color: '#8BC34A' },
  conflicts_with: { color: '#F44336' },
  // 兼容旧版本
  prerequisite: { color: '#FF5722' },
  unlocks: { color: '#4CAF50' },
  fixes: { color: '#8BC34A' },
  exports: { color: '#795548' }
}

/**
 * 边上那个词。
 *
 * 认不出的关系类型原样显示 —— 图谱是模型生成的，它可能造出一个我们没见过的
 * 关系名。那时显示它自己的名字（`depends_on`）比显示一个空白的连线有用。
 */
export function relationLabel(relation: RelationType | string): string {
  const key = `notebook.graph.relations.${relation}`
  const copy = i18n.global.t(key)
  return copy === key ? String(relation) : copy
}

/**
 * 知识图谱节点
 */
export interface KGNode {
  id: string
  label: string
  category: EntityCategory
  description?: string
  /** 节点权重 (可选，用于表示重要性) */
  weight?: number
}

/**
 * 知识图谱边
 */
export interface KGEdge {
  id: string
  source: string
  target: string
  relation: RelationType
}

/**
 * 知识图谱数据
 */
export interface KnowledgeGraphData {
  /** 知识图谱主题/标题 */
  title?: string
  nodes: KGNode[]
  edges: KGEdge[]
}

/**
 * 知识图谱服务状态
 */
export interface KnowledgeGraphState {
  status: 'idle' | 'collecting' | 'generating' | 'completed' | 'failed'
  progress: number
  message: string
  error?: string
  data?: KnowledgeGraphData
}
