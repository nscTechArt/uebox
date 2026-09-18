/**
 * 资产依赖的共享类型。
 *
 * 主进程只负责回答「这条依赖解析到什么」，不负责回答「它该是什么颜色、
 * 该显示哪个中文词」—— 主进程既不知道用户开的是深色还是浅色主题，
 * 也不知道界面语言。所以这里出现的全是语义字段，没有颜色和文案。
 */

/**
 * 一条导入依赖的解析结果。
 *
 * - `in-vault`：softPath 在当前保管库里命中了资产，可以跳过去
 * - `unresolved`：库里没有。可能是引用断了，也可能资产在库外的磁盘上 ——
 *   区分这两者需要读盘，代价太高，留给依赖关系图去做
 */
export type AssetImportStatus = 'in-vault' | 'unresolved'

/** 单条导入依赖 */
export interface AssetImportItem {
  /** 原始软路径，例如 /Game/EasyFog/Textures/Mountain/T_MountainMask_02 */
  softPath: string
  /** 末段资产名，例如 T_MountainMask_02。真正要看的就是这个 */
  name: string
  /** 末段之外的目录部分，例如 /Game/EasyFog/Textures/Mountain */
  folder: string
  status: AssetImportStatus
  /** 命中时才有，用来在面板内跳转 */
  assetKey?: string
  /** 命中时才有，用来上类型色 */
  className?: string
  /** 命中时才有，用来定位到所在文件夹 */
  folderKey?: string
}

/** 一个资产的全部导入依赖 */
export interface AssetImportStatusSummary {
  total: number
  /** 库里没找到的条数，用来在标题上报警 */
  unresolvedCount: number
  items: AssetImportItem[]
}

/**
 * 依赖关系图里一个节点的语义类别。
 * 渲染层据此决定颜色和文案。
 */
export type DependencyNodeKind =
  /** 正在查看的那个资产 */
  | 'root'
  /** 在当前保管库里 */
  | 'in-vault'
  /** 库里没有，但顺着磁盘路径读到了真文件 */
  | 'external'
  /** 两头都没有，引用断了 */
  | 'missing'

/** 依赖关系图里一条边的语义类别 */
export type DependencyEdgeKind =
  /** 当前资产 → 它引用的 */
  | 'depends-on'
  /** 引用当前资产的 → 当前资产 */
  | 'referenced-by'
  /** 指向一个断掉的引用 */
  | 'missing'

/** 依赖关系图的一个节点 */
export interface DependencyGraphNode {
  id: string
  /** 资产名。缺失节点这里是从软路径末段推出来的名字，前缀/后缀由渲染层加 */
  label: string
  kind: DependencyNodeKind
  className?: string
  classNameCn?: string
  softPath?: string
  imgLocalPath?: string
  customPoster?: string
  assetKey?: string
  folderKey?: string
  /** 0 = 当前资产，1 = 它引用的，-1 = 引用它的 */
  level: number
  isRoot?: boolean
  isMissing?: boolean
  isExternal?: boolean
}

/** 依赖关系图的一条边 */
export interface DependencyGraphEdge {
  from: string
  to: string
  kind: DependencyEdgeKind
  arrows?: string
  dashes?: boolean
}

/**
 * 从软路径里拆出「资产名」和「所在目录」。
 *
 * UE 的软路径末段可能带 `.ObjectName` 后缀（/Game/A/B.B），这里一并剥掉 ——
 * 用户想看的是 B，不是 B.B。
 */
export function splitSoftPath(softPath: string): { name: string; folder: string } {
  if (!softPath) return { name: '', folder: '' }
  const normalized = softPath.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  const folder = lastSlash > 0 ? normalized.slice(0, lastSlash) : ''
  const tail = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized
  const dot = tail.indexOf('.')
  const name = dot > 0 ? tail.slice(0, dot) : tail
  return { name: name || tail || normalized, folder }
}
