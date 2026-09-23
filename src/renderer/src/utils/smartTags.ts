/**
 * 智能标签规则引擎（前端版本）
 * 根据资产文件名自动推断隐式标签，无需手动打标签
 * 这些智能标签不会存入数据库，而是运行时动态计算
 */

import { smartTagNameKey, smartTagPatternHits } from '@core/shared/smartTagMatch'

/** 智能标签的分类 */
export type SmartTagCategory =
  | 'texture'
  | 'mesh'
  | 'blueprint'
  | 'animation'
  | 'audio'
  | 'material'
  | 'other'

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
  /** 标签分类 */
  category?: SmartTagCategory
}

/**
 * 分类 → 调色板变量。
 *
 * 原来每条规则各自硬编码一个 Material Design 十六进制色（#F44336 之类），前景色却
 * 固定成 --color-text-primary：深色主题下白字配 #9E9E9E 只有 2.61:1，浅色主题下
 * 黑字配深紫同样不达标，两个主题各挂一半，而且这些值在 .ts 里，颜色门禁扫不到。
 *
 * 现在颜色只出现在标签前面那个 6px 的小色点上，文字始终在中性底上，对比度由
 * token 保证；色相直接复用资产类型那套（见 utils/tool.ts），同一个概念一套颜色。
 */
export const SMART_TAG_CATEGORY_COLOR: Record<SmartTagCategory, string> = {
  texture: 'var(--color-uetype-texture)',
  mesh: 'var(--color-uetype-static-mesh)',
  blueprint: 'var(--color-uetype-blueprint)',
  animation: 'var(--color-uetype-anim-sequence)',
  audio: 'var(--color-uetype-sound)',
  material: 'var(--color-uetype-material)',
  other: 'var(--color-uetype-unknown)'
}

/**
 * 取智能标签的色点颜色
 * @param rule 智能标签规则
 * @returns 调色板变量表达式
 */
export function getSmartTagColor(rule: SmartTagRule): string {
  return SMART_TAG_CATEGORY_COLOR[rule.category ?? 'other']
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
    category: 'texture'
  },
  {
    name: 'Normal Map',
    patterns: ['_N', '_Normal', '_Nrm', '_NormalMap'],
    tag: 'NormalMap',
    category: 'texture'
  },
  {
    name: 'Roughness',
    patterns: ['_R', '_Roughness', '_Rough', '_Rgh'],
    tag: 'Roughness',
    category: 'texture'
  },
  {
    name: 'Metallic',
    patterns: ['_M', '_Metallic', '_Metal', '_Met'],
    tag: 'Metallic',
    category: 'texture'
  },
  {
    name: 'AO/Occlusion',
    patterns: ['_AO', '_Occlusion', '_AmbientOcclusion'],
    tag: 'AO',
    category: 'texture'
  },
  {
    name: 'Emissive',
    patterns: ['_E', '_Emissive', '_Emit', '_Glow'],
    tag: 'Emissive',
    category: 'texture'
  },
  {
    name: 'ORM (Packed)',
    patterns: ['_ORM', '_ARM', '_RMA'],
    tag: 'ORM',
    category: 'texture'
  },

  // ========== 蓝图类型 ==========
  {
    name: 'Blueprint Actor',
    patterns: ['BP_'],
    tag: 'Blueprint',
    category: 'blueprint'
  },
  {
    name: 'Widget Blueprint',
    patterns: ['WBP_', 'W_', 'Widget_'],
    tag: 'Widget',
    category: 'blueprint'
  },
  {
    name: 'Animation Blueprint',
    patterns: ['ABP_', 'AnimBP_'],
    tag: 'AnimBlueprint',
    category: 'blueprint'
  },

  // ========== 网格体类型 ==========
  {
    name: 'Static Mesh',
    patterns: ['SM_', 'S_'],
    tag: 'StaticMesh',
    category: 'mesh'
  },
  {
    name: 'Skeletal Mesh',
    patterns: ['SK_', 'SKM_'],
    tag: 'SkeletalMesh',
    category: 'mesh'
  },

  // ========== 动画类型 ==========
  {
    name: 'Animation Sequence',
    patterns: ['A_', 'Anim_', 'AS_'],
    tag: 'Animation',
    category: 'animation'
  },
  {
    name: 'Animation Montage',
    patterns: ['AM_', 'Montage_'],
    tag: 'Montage',
    category: 'animation'
  },

  // ========== 材质类型 ==========
  {
    name: 'Material',
    patterns: ['M_', 'Mat_'],
    tag: 'Material',
    category: 'material'
  },
  {
    name: 'Material Instance',
    patterns: ['MI_', 'MatInst_'],
    tag: 'MaterialInstance',
    category: 'material'
  },

  // ========== 音频类型 ==========
  {
    name: 'Sound Wave',
    patterns: ['Sound_', 'SFX_'],
    tag: 'Sound',
    category: 'audio'
  },
  {
    name: 'Sound Cue',
    patterns: ['SC_', 'Cue_'],
    tag: 'SoundCue',
    category: 'audio'
  },

  // ========== 其他常见类型 ==========
  {
    name: 'Texture',
    patterns: ['T_', 'Tex_'],
    tag: 'Texture',
    category: 'texture'
  },
  {
    name: 'Particle/Niagara',
    patterns: ['P_', 'PS_', 'NS_', 'Niagara_', 'Particle_'],
    tag: 'Particle',
    category: 'other'
  },
  {
    name: 'Data Asset',
    patterns: ['DA_', 'Data_'],
    tag: 'DataAsset',
    category: 'other'
  }
]

/**
 * 根据资产名称计算智能标签
 * @param assetName 资产名称（如 T_Hero_D.uasset）
 * @param rules 规则库，默认使用 DEFAULT_SMART_TAG_RULES
 * @returns 匹配到的智能标签列表
 */
export function computeSmartTags(
  assetName: string,
  rules: SmartTagRule[] = DEFAULT_SMART_TAG_RULES
): SmartTagRule[] {
  if (!assetName) return []

  const matchedTags: SmartTagRule[] = []
  // 和主进程同一个判据（见 `shared/smartTagMatch.ts`）。原来这里是裸子串匹配：
  // 详情面板把 `SM_Door_01` 标成 Diffuse + Material，和导入时落库的标签对不上
  const nameUpper = smartTagNameKey(assetName)

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (smartTagPatternHits(nameUpper, pattern.toUpperCase())) {
        matchedTags.push(rule)
        break // 一个规则只添加一次
      }
    }
  }

  return matchedTags
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
