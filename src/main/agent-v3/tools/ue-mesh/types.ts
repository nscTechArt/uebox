/**
 * `mesh.describe` 的响应形状。
 *
 * 与 `plugin/UnrealAgentLink/Source/UnrealAgentLink/Private/Commands/UAL_MeshCommands.cpp`
 * 一一对应。改一边必须改另一边 —— 这里所有字段都是可选的，因为老版本插件
 * 连不上新字段，而插件升级和 App 升级不保证同一时刻发生。
 */

export interface MeshLod {
  index: number
  triangles?: number
  vertices?: number
  sections?: number
  uv_channels?: number
  screen_size?: number
  /** 仅静态网格：这一级是导入的还是引擎生成的。决定 mesh_optimize 能不能覆盖它 */
  source?: 'imported' | 'generated'
}

export interface MeshMaterialSlot {
  index: number
  slot_name?: string
  material?: string
}

export interface MeshSocket {
  name?: string
  /** 仅骨骼网格 */
  bone?: string
}

export interface MeshDescribeResponse {
  path?: string
  name?: string
  type?: 'static' | 'skeletal'
  lods?: MeshLod[]
  material_slots?: MeshMaterialSlot[]
  sockets?: MeshSocket[]
  /**
   * 资产局部空间的包围盒。`min` / `max` 是**相对原点**的角点坐标 ——
   * 原点在哪（居中 / 底面 / 角点）只有它们答得出来，而拼模块化套件必须知道。
   * 老插件只回 size，两个角点缺席时下面的原点判断会整段跳过。
   */
  bounds?: {
    size?: { x: number; y: number; z: number }
    min?: { x: number; y: number; z: number }
    max?: { x: number; y: number; z: number }
    space?: 'asset'
    unit?: 'cm'
  }

  // --- 仅静态网格 ---
  collision?: {
    primitives?: number
    convex_hulls?: number
    complexity?: string
    has_any?: boolean
  }
  nanite?: { enabled?: boolean }
  lightmap?: {
    coordinate_index?: number
    lod0_uv_channels?: number
    index_valid?: boolean
  }

  // --- 仅骨骼网格 ---
  skeleton?: string
  bones?: { count?: number; root?: string; max_depth?: number }
  physics_asset?: string
  has_physics_asset?: boolean
  /** 骨骼网格的正面朝向，插件从参考姿势的左右骨骼对推出来；认不出来时 known=false */
  facing?: {
    known?: boolean
    from_bones?: string
    forward_local?: { x: number; y: number; z: number }
    /** 正面偏离组件 +X 轴多少度 */
    yaw_offset?: number
    hint?: string
    reason?: string
  }
  morph_targets?: string[]
}
