/**
 * 智能标签规则引擎
 * 根据资产文件名自动推断隐式标签，无需手动打标签
 * 这些智能标签不会存入数据库，而是运行时动态计算
 */

import { smartTagNameKey, smartTagPatternHits } from '../../../shared/smartTagMatch'

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
  // 判据和渲染层共用一份，见 `shared/smartTagMatch.ts`（原来的错法和改法都写在那边）。
  // 已经写进库里的错标签不会自己消失 —— 这里只管以后算出来的
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
