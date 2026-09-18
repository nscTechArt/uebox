/**
 * 工程模板与社区模板源的共享类型。
 *
 * 界面上只有两种模板：**社区的**和**我自己的**。没有第三种。
 *
 * 磁盘上只有一个位置：`userData/templates`。安装包里**不带任何模板** ——
 * 用户自己打包的（origin: user）和从社区源下载来的（origin: community）都在这，
 * 靠同名 `.json` 边车文件里的 origin 字段区分。
 *
 * 让社区模板下载完就变成一个普通的本地模板，是刻意的：建工程那条路径
 * （解压 → 找 .uproject → 复制 → 改名）完全不需要知道模板是从哪来的。
 */

/** 模板来源。界面上只认这两种 */
export type TemplateOrigin = 'user' | 'community'

/**
 * 用途分类。界面按这几项出筛选标签。
 *
 * 出现一个标签里没有的值，那条模板就会在筛选时凭空消失 —— 所以任何来路的分类值
 * （边车 json、社区清单、按文件名猜的）都要先过 normalizeTemplateCategory。
 */
export const TEMPLATE_CATEGORIES = [
  'game',
  'render',
  'film',
  'architecture',
  'automotive',
  'other'
] as const

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]

/** 不认识的分类一律归到 other。历史上「猜不出来」写成过 'all'，那是筛选维度不是分类 */
export function normalizeTemplateCategory(raw: string | undefined): TemplateCategory {
  return TEMPLATE_CATEGORIES.includes(raw as TemplateCategory) ? (raw as TemplateCategory) : 'other'
}

/** 本地可用的模板（已经躺在磁盘上、可以直接拿来建工程的） */
export interface TemplateInfo {
  name: string
  /** 模板 zip 的绝对路径 */
  path: string
  size: number
  modifiedTime: number
  origin: TemplateOrigin
  category?: string
  previewImage?: string
  description?: string
  version?: string
  engineVersion?: string
  /** 社区模板专有：它来自哪个源、在清单里的 id。用来判断"这条已经下载过了" */
  sourceId?: string
  templateId?: string
  author?: string
  license?: string
}

/**
 * 社区模板源。
 *
 * 社区核心版**默认一个源都不启用** —— 内置源存在但 enabled 为 false，
 * 用户不点「启用」就永远不会发出任何网络请求，离线承诺不破。
 */
export interface TemplateSource {
  id: string
  name: string
  /** 清单地址。http/https 皆可（内网自建源常常是 http） */
  url: string
  enabled: boolean
  /** 内置源只能禁用，不能删除 */
  builtin: boolean
}

/** 清单里的一条模板 */
export interface CommunityTemplate {
  id: string
  name: string
  description: string
  category: string
  engineVersion: string
  /** 模板包地址，可以是相对于清单的相对路径 */
  packageUrl: string
  /** 包大小（字节）。下载前拿它提示用户，也用来算进度 */
  size: number
  /** 包的 sha256（小写十六进制）。**缺失的条目会被丢弃**，见 templateManifest.ts */
  sha256: string
  version: string
  author: string
  license: string
  previewUrl?: string
  homepage?: string
}

/** 一个源解析出来的清单 */
export interface TemplateManifest {
  /** 清单格式版本，当前只认 1 */
  formatVersion: number
  templates: CommunityTemplate[]
}

/** 某个源的抓取结果。失败不影响其它源，所以错误是逐源记录的 */
export interface CommunityFetchResult {
  sourceId: string
  sourceName: string
  templates: CommunityTemplate[]
  /** 抓取或解析失败时的原因；成功为 undefined */
  error?: string
  /** 被丢弃的非法条目数量，用来在界面上提示"这个源有脏数据" */
  skipped: number
}

/** 下载进度事件 */
export interface TemplateDownloadProgress {
  sourceId: string
  templateId: string
  received: number
  /** 清单声明的总大小；服务端给了 Content-Length 时以服务端为准 */
  total: number
  /** 0-100 */
  percent: number
}
