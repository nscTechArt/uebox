/**
 * 库浏览器的数据契约。
 *
 * 资产库、蓝图库、材质库长得几乎一样：左边文件夹树、中间网格、上面筛选栏、
 * 右边详情。不一样的只有两处 —— **筛选栏里有哪些字段**，和**双击之后打开谁**。
 * 所以浏览器只做一个，各库把自己的领域对象映射成这里的 {@link BrowserItem}。
 *
 * 这一层刻意**不认识**蓝图节点、材质图、贴图分辨率。领域模型换了它不用改；
 * 反过来说，任何需要在这里加 `if (kind === 'blueprint')` 的需求，
 * 都说明那件事该做成一个模块（见 `moduleRegistry.ts`）而不是塞进壳里。
 */

/** 一个可浏览的东西：蓝图包、材质包、贴图、模型、音频…… */
export interface BrowserItem {
  id: string
  name: string
  /** 类型。决定双击打开谁、显示什么图标，由各库自己定义取值。 */
  kind: string
  /** 封面 URL（`local-resource://` / http / data）。没有就用 {@link coverStyle} */
  thumbnail?: string
  /**
   * 封面的兜底样式，是**整段 CSS 文本**（`background-image: url(...); background-size: cover`），
   * 不是某一个属性的值 —— 绑的时候直接 `:style="item.coverStyle"`，
   * 包成 `{ background: ... }` 会得到一段无效声明，封面变成一块灰的。
   */
  coverStyle?: string
  /** 所在文件夹。空串表示保管库根目录。 */
  folderKey: string
  tags: string[]
  isFavorite: boolean
  createdAt: number
  updatedAt: number
  /** 卡片副标题，如「Actor 蓝图 · UE 5.5」 */
  subtitle?: string
  /** 卡片上的补充信息行，如「2 图表」「1.4 MB」 */
  meta?: string[]
  /**
   * 原始领域对象。
   *
   * 壳层只负责把它原样带着走，交给编辑器和模块去解释 ——
   * 这样壳层不需要知道蓝图长什么样，也能把蓝图交给蓝图编辑器。
   */
  source: unknown
}

/** 文件夹树上的一个节点。就是保管库磁盘上的一个目录。 */
export interface BrowserFolder {
  key: string
  name: string
  /** 根级为 null */
  parentKey: string | null
}

/** 筛选栏上的一个下拉。类型专属的字段靠它表达，而不是在壳里写分支。 */
export interface BrowserFacet {
  key: string
  /** i18n key */
  label: string
  options: Array<{ value: string; label: string; count?: number }>
  /** 允许多选 */
  multiple?: boolean
}

export type BrowserViewMode = 'grid' | 'list'
export type BrowserSortType = 'recent' | 'name' | 'created'

/**
 * 浏览器的重量。
 *
 * 资产库里可能有几万个文件，蓝图库里可能只有十几个 —— 差三个数量级。
 * 给十几个东西配一整套面包屑、筛选胶囊、详情面板，是这套界面看起来
 * 「怪」的真正来源：不是三个库长得一样，是小东西套了大壳。
 *
 * - `full`：浏览本身就是目的。文件夹树常驻、面包屑、详情面板、筛选胶囊。
 * - `light`：浏览只是打开某个东西之前的一步。搜索 + 网格，分组栏默认收起。
 *
 * **由 scope 声明，不按条目数量推断。** 界面自己变形比多点一下更糟 ——
 * 今天打开是这样、明天多了两百条变成那样，工具就没法用了。
 */
export type BrowserDensity = 'full' | 'light'

/**
 * 当前浏览的是什么。
 *
 * 「蓝图库」「材质库」「资产库」不是三个页面，是同一个浏览器的三个 scope ——
 * 侧边栏点哪个入口，就换一份 scope 进来。用户自己存的智能集合同理。
 */
export interface BrowserScope {
  /** 稳定标识，用来记住这个视图的排序/视图模式偏好 */
  id: string
  /** i18n key */
  title: string
  /** 只显示这些 kind；空数组表示不限 */
  kinds: string[]
  /** 这个视图要显示哪些筛选字段 */
  facets: BrowserFacet[]
  /** 界面重量，见 {@link BrowserDensity}。不填按 `full`。 */
  density?: BrowserDensity
  /** 单击直接打开条目，不进入选择状态。默认仍为单击选择、双击打开。 */
  openOnClick?: boolean
  /** 打开一个条目时做什么。各库在这里跳自己的编辑器。 */
  open?: (item: BrowserItem) => void
}

/** 壳层暴露给模块的当前状态 */
export interface BrowserContext {
  scope: BrowserScope
  /** 当前选中的文件夹，空串表示根 */
  folderKey: string
  /** 当前选中的条目 */
  selection: BrowserItem[]
  /** 当前视图里的全部条目（已筛选） */
  items: BrowserItem[]
}
