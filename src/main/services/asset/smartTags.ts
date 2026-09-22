/**
 * 智能标签规则引擎
 * 根据资产文件名自动推断隐式标签，无需手动打标签
 * 这些智能标签不会存入数据库，而是运行时动态计算
 */

/**
 * 智能标签规则定义
 */
export interface SmartTagRule {
  /** 规则名称（用于调试） */
  name: string
  /** 匹配模式：文件名中包含这些关键词时匹配（不区分大小写） */
  patterns: string[]
  /** 生成的智能标签名称 */
  tag: string
  /** 标签颜色（可选，用于前端显示） */
  color?: string
  /** 标签分类（可选） */
  category?: 'texture' | 'mesh' | 'blueprint' | 'animation' | 'audio' | 'material' | 'other'
}

/**
 * 默认智能标签规则库
 * 基于 UE 资产命名规范，零成本自动分类
 */
export const DEFAULT_SMART_TAG_RULES: SmartTagRule[] = [
  // ========== 纹理类型 ==========
  {
    name: 'Diffuse/BaseColor',
    patterns: ['_D', '_Diffuse', '_BaseColor', '_Albedo', '_BC'],
    tag: 'Diffuse',
    color: '#4CAF50',
    category: 'texture'
  },
  {
    name: 'Normal Map',
    patterns: ['_N', '_Normal', '_Nrm', '_NormalMap'],
    tag: 'NormalMap',
    color: '#7B68EE',
    category: 'texture'
  },
  {
    name: 'Roughness',
    patterns: ['_R', '_Roughness', '_Rough', '_Rgh'],
    tag: 'Roughness',
    color: '#795548',
    category: 'texture'
  },
  {
    name: 'Metallic',
    patterns: ['_M', '_Metallic', '_Metal', '_Met'],
    tag: 'Metallic',
    color: '#9E9E9E',
    category: 'texture'
  },
  {
    name: 'AO/Occlusion',
    patterns: ['_AO', '_Occlusion', '_AmbientOcclusion'],
    tag: 'AO',
    color: '#607D8B',
    category: 'texture'
  },
  {
    name: 'Emissive',
    patterns: ['_E', '_Emissive', '_Emit', '_Glow'],
    tag: 'Emissive',
    color: '#FF5722',
    category: 'texture'
  },
  {
    name: 'Opacity/Alpha',
    patterns: ['_O', '_Opacity', '_Alpha', '_Mask'],
    tag: 'Opacity',
    color: '#00BCD4',
    category: 'texture'
  },
  {
    name: 'ORM (Packed)',
    patterns: ['_ORM', '_ARM', '_RMA'],
    tag: 'ORM',
    color: '#FF9800',
    category: 'texture'
  },
  {
    name: 'Height/Displacement',
    patterns: ['_H', '_Height', '_Displacement', '_Disp'],
    tag: 'Height',
    color: '#8BC34A',
    category: 'texture'
  },

  // ========== 蓝图类型 ==========
  {
    name: 'Blueprint Actor',
    patterns: ['BP_'],
    tag: 'Blueprint',
    color: '#2196F3',
    category: 'blueprint'
  },
  {
    name: 'Widget Blueprint',
    patterns: ['WBP_', 'W_', 'Widget_'],
    tag: 'Widget',
    color: '#E91E63',
    category: 'blueprint'
  },
  {
    name: 'Animation Blueprint',
    patterns: ['ABP_', 'AnimBP_'],
    tag: 'AnimBlueprint',
    color: '#9C27B0',
    category: 'blueprint'
  },

  // ========== 网格体类型 ==========
  {
    name: 'Static Mesh',
    patterns: ['SM_', 'S_'],
    tag: 'StaticMesh',
    color: '#00796B',
    category: 'mesh'
  },
  {
    name: 'Skeletal Mesh',
    patterns: ['SK_', 'SKM_'],
    tag: 'SkeletalMesh',
    color: '#5D4037',
    category: 'mesh'
  },

  // ========== 动画类型 ==========
  {
    name: 'Animation Sequence',
    patterns: ['A_', 'Anim_', 'AS_'],
    tag: 'Animation',
    color: '#673AB7',
    category: 'animation'
  },
  {
    name: 'Animation Montage',
    patterns: ['AM_', 'Montage_'],
    tag: 'Montage',
    color: '#512DA8',
    category: 'animation'
  },

  // ========== 材质类型 ==========
  {
    name: 'Material',
    patterns: ['M_', 'Mat_'],
    tag: 'Material',
    color: '#F44336',
    category: 'material'
  },
  {
    name: 'Material Instance',
    patterns: ['MI_', 'MatInst_'],
    tag: 'MaterialInstance',
    color: '#EF5350',
    category: 'material'
  },

  // ========== 音频类型 ==========
  {
    name: 'Sound Wave',
    patterns: ['S_', 'Sound_', 'SFX_'],
    tag: 'Sound',
    color: '#3F51B5',
    category: 'audio'
  },
  {
    name: 'Sound Cue',
    patterns: ['SC_', 'Cue_'],
    tag: 'SoundCue',
    color: '#303F9F',
    category: 'audio'
  },

  // ========== 其他常见类型 ==========
  {
    name: 'Texture',
    patterns: ['T_', 'Tex_'],
    tag: 'Texture',
    color: '#4CAF50',
    category: 'texture'
  },
  {
    name: 'Particle/Niagara',
    patterns: ['P_', 'PS_', 'NS_', 'Niagara_', 'Particle_'],
    tag: 'Particle',
    color: '#FFEB3B',
    category: 'other'
  },
  {
    name: 'Data Asset',
    patterns: ['DA_', 'Data_'],
    tag: 'DataAsset',
    color: '#009688',
    category: 'other'
  }
]

/**
 * 根据资产名称计算智能标签
 * @param assetName 资产名称（如 T_Hero_D.uasset）
 * @param softPath 可选的软路径（如 /Game/Characters/Hero/Textures/T_Hero_D）
 * @param rules 规则库，默认使用 DEFAULT_SMART_TAG_RULES
 * @returns 匹配到的智能标签列表
 */
export function computeSmartTags(
  assetName: string,
  _softPath?: string,
  rules: SmartTagRule[] = DEFAULT_SMART_TAG_RULES
): SmartTagRule[] {
  const matchedTags: SmartTagRule[] = []
  // 后缀族要判「到名字结尾了没有」，所以先把扩展名摘掉：
  // `T_Rock_D.png` 的通道位是 `_D`，不摘扩展名就永远匹配不上
  const nameUpper = assetName.replace(/\.[A-Za-z0-9]{2,5}$/, '').toUpperCase()

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (patternHits(nameUpper, pattern.toUpperCase())) {
        matchedTags.push(rule)
        break // 一个规则只添加一次
      }
    }
  }

  return matchedTags
}

/**
 * 一条 pattern 命中没有。
 *
 * ## 原来是怎么错的
 *
 * 原来的判据里有一条 `nameUpper.includes(patternUpper)` —— **任意位置的裸子串**。
 * 它让前面两条更严的判据完全失效，结果是规则在几乎每个资产上开火，而且打出来的
 * 大半是错的。真机（5500 个资产的素材库）上抽出来的样子：
 *
 * | 资产名 | 打出的标签 |
 * |---|---|
 * | `SM_Door_01` | **Diffuse**（`_D` 撞上 `_DOOR`）、StaticMesh、**Material**（`M_` 撞上 `SM_`）|
 * | `SM_Rock_Large` | **Roughness**（`_R` 撞 `_ROCK`）|
 * | `SK_Mannequin` | **Metallic** |
 * | `A_METACITY_Ring` | **Roughness、Metallic**、Animation —— 三个里两个是撞出来的 |
 * | `T_Grass_D` | Diffuse ✓、**StaticMesh、Sound**（`S_`？没有。是 `_S` 撞 `GRASS_`）|
 *
 * 「每个 StaticMesh 都带 Material」就是 `SM_` 里那个 `M_` 造成的。
 *
 * ## 现在的判据
 *
 * 规则表里每条 pattern 都只有两种形状，没有第三种：
 *
 * - **前缀族**（`BP_` / `SM_` / `T_`，以 `_` 结尾）—— UE 约定里它在**名字开头**。
 *   只认 `startsWith`。这样 `SM_DOOR` 不再命中 `M_`、`S_`。
 * - **后缀族**（`_D` / `_NORMAL` / `_ORM`，以 `_` 开头）—— 它是**通道位**，
 *   在名字末尾或末尾数字之前（`T_Rock_D` / `T_Rock_D_01`）。所以后面必须是
 *   结尾或另一个 `_`，`_D` 才不会去撞 `_DOOR`。
 *
 * 只会减少命中，不会增加：真正以 `_D` 结尾的仍然命中，被砍掉的全是撞出来的。
 *
 * **已经写进库里的错标签不会自己消失** —— `autoTagAsset` 是导入时落库的。
 * 这次只修「以后算出来的」和运行时动态计算的那部分。
 */
function patternHits(nameUpper: string, patternUpper: string): boolean {
  // 前缀族：`BP_` `SM_` `MI_` …
  if (patternUpper.endsWith('_')) return nameUpper.startsWith(patternUpper)

  // 后缀族：`_D` `_NORMAL` `_ORM` …
  if (patternUpper.startsWith('_')) {
    let from = 0
    for (;;) {
      const at = nameUpper.indexOf(patternUpper, from)
      if (at === -1) return false
      const after = nameUpper[at + patternUpper.length]
      // 到头了，或者下一段是新的 `_` 分节（`_D_01`）—— 两种都算这一位
      if (after === undefined || after === '_') return true
      from = at + 1
    }
  }

  // 规则表里目前没有第三种形状。真加了也不该悄悄放宽成裸子串
  return nameUpper === patternUpper
}

/**
 * 从软路径中提取路径层级作为智能标签
 * @param softPath 虚幻软路径，如 /Game/Characters/Hero/Textures/T_Hero_D
 * @returns 路径层级标签数组，如 ['Characters', 'Hero', 'Textures']
 */
export function extractPathTags(softPath: string): string[] {
  if (!softPath) return []

  // 移除开头的 /Game/ 或 /Script/ 等前缀
  const cleanPath = softPath.replace(/^\/(Game|Script|Engine)\//, '')

  // 按 / 分割并过滤掉空字符串和最后的文件名
  const parts = cleanPath.split('/').filter(Boolean)

  // 移除最后一个元素（文件名）
  if (parts.length > 0) {
    parts.pop()
  }

  return parts
}
