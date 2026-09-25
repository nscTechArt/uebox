/**
 * `landscape.*` 的响应形状。
 *
 * 与 `plugin/UnrealAgentLink/Source/UnrealAgentLink/Private/Commands/UAL_LandscapeCommands.cpp`
 * 一一对应，改一边必须改另一边。描述状态的字段全是插件改完之后从引擎读回的，
 * 只有 `requested` 里是调用方传来的原值。
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Vec2 {
  x: number
  y: number
}

export interface Box {
  min: Vec3
  max: Vec3
}

export type RvtKind = 'color' | 'height'

export interface RvtVolumeInfo {
  label: string
  bounds?: Box
  /** 体积水平方向罩没罩住整块地形（容差 1% 或 1 米） */
  covers_xy: boolean
  /** 竖直方向。只有高度 RVT 在乎 —— 罩不住的高度会被截断 */
  covers_z: boolean
  /** 只在 setup 的结果里有：这次新生成的还是复用的 */
  created?: boolean
}

export interface RvtAssignment {
  /** RVT 资产的包路径 */
  asset: string
  /** 引擎枚举名，如 BaseColor_Normal_Specular / WorldHeight */
  material_type: string
  kind: RvtKind | 'other'
  on_landscape_actor: boolean
  /** 装着地形块的代理里，有几块往这张 RVT 里画 */
  proxies_with: number
  proxies_total: number
  volumes: RvtVolumeInfo[]
}

export interface RvtMaterialOutput {
  material: string
  found: boolean
  /** `no_material` = 地形没挂材质；`graph_and_functions` = 搜了材质图和材质函数（不含材质图层） */
  searched: 'no_material' | 'graph_and_functions'
  functions_searched?: number
  pins?: {
    base_color: boolean
    normal: boolean
    roughness: boolean
    specular: boolean
    world_height: boolean
  }
}

export interface LandscapeRvtState {
  material_output: RvtMaterialOutput
  assigned: RvtAssignment[]
}

export interface LandscapeInfo {
  label: string
  name: string
  path: string
  location: Vec3
  scale: Vec3
  quad_size_m: number
  /** 16 位高度图满量程对应的总落差（米），由高度缩放决定 */
  heightmap_range_m: number
  quads_per_section: number
  sections_per_component: number
  component_size_quads: number
  /** 已加载部分的顶点分辨率和块数。World Partition 下未加载的格子不在里面 */
  loaded_extent?: { resolution: Vec2; component_count: Vec2 }
  streaming_proxies_loaded: number
  /** 世界包围盒（厘米），含未加载的区域 */
  bounds?: Box
  size_m?: Vec3
  material: string
  rvt?: LandscapeRvtState
}

export interface LevelFacts {
  world_partition: boolean
  level_package: string
  /** 项目设置里的「启用虚拟纹理支持」（r.VirtualTextures），改了要重启编辑器 */
  project_virtual_texturing: boolean
}

export interface RvtSetupResult {
  kind: RvtKind
  ok: boolean
  error?: string
  asset_path?: string
  asset_created?: boolean
  material_type?: string
  on_landscape_actor?: boolean
  proxies_with?: number
  proxies_total?: number
  volume?: RvtVolumeInfo
}

export interface LandscapeCreateResponse extends LevelFacts {
  landscape: LandscapeInfo
  undoable: boolean
  wp_grid_size?: number
  heightmap?: {
    path: string
    source_resolution: Vec2
    resolution: Vec2
    resampled: boolean
    candidate_resolutions: number
    engine_message?: string
  }
  requested: {
    size_x_m?: number
    size_y_m?: number
    quad_size_m: number
    height_range_m: number
    material?: string
  }
  rvt_results?: RvtSetupResult[]
  failed_count: number
}

export interface LandscapeSetupRvtResponse extends LevelFacts {
  landscape: LandscapeInfo
  rvt_results: RvtSetupResult[]
  failed_count: number
}

export interface LandscapeListResponse extends LevelFacts {
  landscapes: LandscapeInfo[]
}
