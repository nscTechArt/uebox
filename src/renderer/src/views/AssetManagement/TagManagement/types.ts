// 标签管理相关的类型定义

export interface TagGroup {
  id?: number
  name: string
  color?: string
  sort_order?: number
  tagCount?: number
}

export interface Tag {
  id?: number
  name: string
  group_id?: number | null
  color?: string
  is_favorite?: boolean
}

export interface TagGroupForm {
  name: string
}

export interface TagForm {
  name: string
  group_id: number | null
  is_favorite?: boolean
}

export interface TagsByPinyin {
  [key: string]: Tag[]
}

/**
 * 新建分组 / 标签的默认颜色。
 *
 * 这两个值会**存进数据库**，之后由用户自由改 —— 所以不能写成 CSS 变量 ——
 * 变量名存进 SQLite 之后没人认得。它们是调色板里 --accent-solid / --success-solid 的取值，
 * 手抄一份，改调色板时记得同步。原来这里是 antd 的 #1890ff / #52c41a，
 * 跟应用其它地方的蓝绿都不是一个色。
 */
export const DEFAULT_TAG_GROUP_COLOR = '#1a73e2'
export const DEFAULT_TAG_COLOR = '#1d8742'
