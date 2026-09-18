// 资产管理相关类型定义

export interface FormattedAsset {
  name: string
  type: string
  path?: string
  assetKey: string
  folderKey: string
  folder?: string
  size?: number
  /** 用户写的备注。annotate_asset 的 note 是覆盖语义，改之前必须先看见它 */
  note?: string
  /** 已有标签，逗号分隔 */
  tags?: string
  /**
   * 这个资产是哪个引擎版本存的（如 `5.7.0`）。**.uasset 只能往同版本或更高版本导**，
   * 所以这一栏是「能不能进我这个工程」的唯一判据。
   *
   * 它一度不在返回里，而 `search_assets` 的入参**早就支持按 engineVersion 过滤** ——
   * 于是挑素材的时候完全是盲的：实测批量导入时，
   * 34 成 17 败，其中 16 条全是「资产引擎版本 (UE 5.7) 高于目标项目版本 (UE 5.5)」。
   * 而这件事本来在挑的时候就能看出来。
   *
   * 库里没记录的资产（老库、非 .uasset 的外部文件）这一栏不出现，不编。
   */
  engineVersion?: string
  /** 资产图片 URL，用于图生图功能 */
  imageUrl?: string
  /**
   * 资产在本地磁盘的真实路径（绝对路径）。
   * 优先是保管库里的那一份，其次才是导入来源，缩略图只在前两者都没有时垫底。
   */
  realPath?: string
  /** 同 realPath，兼容下划线命名 */
  real_path?: string
}

export interface AssetSearchParams {
  query?: string
  assetType?: string | string[]
  fileSize?: { min?: number; max?: number }
  fileFormat?: string | string[]
  engineVersion?: string | string[]
  hasNoTags?: boolean
  /**
   * 下面这几个筛选**底层一直支持**（见 models/assetSearch.ts 的 AssetSearchCriteria），
   * 但工具层长期没有透出来，于是「Trees 文件夹里有什么」「按标签筛」「我收藏的」
   * 这类最普通的问法只能靠全库翻页去凑。这里补上透传。
   */
  /** 只搜这个文件夹（folderKey）。'ALL' 或不给 = 全库 */
  folderKey?: string
  /** 连子文件夹一起搜。缺省 true —— 用户说「角色文件夹里有什么」通常包含下级 */
  includeSubfolders?: boolean
  /** 按标签筛。标签 id 由调用方解析好（工具层负责把标签名换成 id） */
  tagFilter?: {
    includeTagIds?: number[]
    excludeTagIds?: number[]
    matchMode?: 'any' | 'all'
  }
  /** 只看收藏 / 只看没收藏 */
  favoriteStatus?: 'all' | 'favorite' | 'unfavorite'
  /** 按最近一次变动时间筛。两端都要有值，底层才会生效 */
  dateRange?: { start?: string; end?: string }
  /** 这一页要几个。缺省 100，上限 500 */
  limit?: number
  /** 跳过前几个，用来翻页。缺省 0 */
  offset?: number
}

export interface AssetSearchSuccessResult {
  success: true
  /** 符合条件的总数（不受 limit 影响） */
  count: number
  /** 这一页实际返回的数量 */
  returnedCount?: number
  /** 这一页从第几个开始 */
  offset?: number
  /** 这一页最多取几个 */
  limit?: number
  /** 后面还有没有。为真时用 nextOffset 再调一次就能接着往下看 */
  hasMore?: boolean
  /** 下一页的 offset */
  nextOffset?: number
  assets: FormattedAsset[]
  /**
   * 指定的类型/格式一个都没命中，结果是自动放宽后拿到的。
   *
   * 为真时 `assets` 里的东西**不是**调用方要的那个类型 —— 必须据此
   * 向用户说明，不能当成筛选结果汇报。
   */
  relaxed?: boolean
  message?: string
}

export interface AssetSearchErrorResult {
  success: false
  error: string
  count: number
  assets: FormattedAsset[]
}

export type AssetSearchResult = AssetSearchSuccessResult | AssetSearchErrorResult

export interface AssetNoteParams {
  assetKey: string
  note?: string
  tagNames?: string[]
}

export interface AssetTagsParams {
  assetKey: string
  tagNames?: string | string[]
  tagIds?: number | number[]
}

export interface JumpToFolderParams {
  folderKey: string
}

// 资产类型映射
export const ASSET_TYPE_MAP: Record<string, string[]> = {
  // === 基础核心资源 ===
  StaticMesh: ['StaticMesh'],
  SkeletalMesh: ['SkeletalMesh'],

  // === 贴图 / 材质 ===
  Texture2D: ['Texture2D', 'Texture'],
  Material: [
    'Material',
    'MaterialInstanceConstant',
    'MaterialFunction',
    'MaterialParameterCollection'
  ],

  // === 逻辑 / 蓝图 / 动画 / 特效 ===
  Blueprint: [
    'Blueprint',
    'BlueprintGeneratedClass',
    'WidgetBlueprint',
    'EditorUtilityWidgetBlueprint',
    'BlueprintFunctionLibrary'
  ],
  Animation: ['AnimSequence', 'AnimBlueprint', 'BlendSpace1D', 'LevelSequence'],
  Niagara: ['NiagaraSystem', 'Niagara'],
  Particle: ['ParticleSystem'],

  // === 关卡 ===
  Level: ['World', 'Level'],

  // === 声音 ===
  Sound: ['SoundWave'],

  // === 其他 ===
  Physics: ['PhysicsAsset'],
  Skeleton: ['Skeleton'],

  // === 通用文件（fbx/obj 等扫描为 File 时用）===
  File: ['File']
}

/**
 * 文件格式映射字典
 * 将语义化的关键词映射到具体的文件格式（扩展名）和虚幻引擎资产类型
 */
/**
 * 别名里**不要放 `uasset`**。
 *
 * 每个虚幻资产落盘都是 `.uasset`，把它列进某个别名，那个别名就会匹配
 * 库里所有 UE 资产 —— 筛选等于没做。真机上量到的：问「有哪些模型」，
 * 返回里混着 Material 和 AnimSequence；「蓝图」「特效」「材质」同理，
 * 六个别名都受影响。
 *
 * 类型名（StaticMesh / Material / Blueprint…）本来就会去匹配 assetType，
 * UE 资产靠它就能正确命中，不需要再兜一层扩展名。
 */
export const FORMAT_ALIAS_MAP: Record<string, string[]> = {
  // === 3D 模型 ===
  模型: ['fbx', 'obj', 'glb', 'gltf', 'StaticMesh', 'SkeletalMesh'],
  静态模型: ['fbx', 'obj', 'StaticMesh'],
  骨骼模型: ['fbx', 'SkeletalMesh'],
  网格: ['fbx', 'obj', 'glb', 'gltf', 'StaticMesh', 'SkeletalMesh'],

  // === 贴图/材质 ===
  贴图: ['png', 'jpg', 'jpeg', 'tga', 'exr', 'hdr', 'Texture2D', 'Texture'],
  纹理: ['png', 'jpg', 'jpeg', 'tga', 'exr', 'hdr', 'Texture2D', 'Texture'],
  材质: ['Material', 'MaterialInstanceConstant', 'MaterialFunction'],
  图片: ['png', 'jpg', 'jpeg', 'bmp', 'tga', 'tiff'],

  // === 动画 ===
  动画: ['AnimSequence', 'AnimBlueprint', 'BlendSpace1D', 'fbx'],
  动作: ['AnimSequence', 'fbx'],

  // === 蓝图 ===
  蓝图: ['Blueprint', 'BlueprintGeneratedClass', 'WidgetBlueprint'],
  UI: ['WidgetBlueprint'],

  // === 粒子/特效 ===
  特效: ['NiagaraSystem', 'Niagara', 'ParticleSystem'],
  粒子: ['NiagaraSystem', 'Niagara', 'ParticleSystem'],

  // === 声音 ===
  音频: ['wav', 'mp3', 'ogg', 'SoundWave'],
  声音: ['wav', 'mp3', 'ogg', 'SoundWave'],

  // === 关卡 ===
  关卡: ['World', 'Level', 'umap'],
  地图: ['World', 'Level', 'umap'],

  // === 其他常用 ===
  资产: ['uasset'],
  虚幻资产: ['uasset'],
  文档: ['txt', 'md', 'pdf', 'doc', 'docx'],
  配置: ['json', 'xml', 'ini', 'cfg']
}
