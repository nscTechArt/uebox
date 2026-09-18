/**
 * 资产命名和分类规则类型定义
 */

/**
 * 命名约定类型
 */
export type NamingConvention = 'pascalCase' | 'camelCase' | 'snake_case' | 'kebab-case'

/**
 * 纹理后缀模式配置
 */
export interface TextureSuffixPattern {
  /** 正则表达式字符串 */
  pattern: string
  /** 应用的后缀 */
  suffix: string
  /** 纹理类型标识（如 Albedo, Normal, Roughness 等） */
  type: string
  /** 是否启用 */
  enabled?: boolean
}

/**
 * 自定义改名规则的匹配位置。
 *
 * **故意不是正则。** 这里原先是一个自由填写的正则框，2026-09-11 实测下来那条路走不通：
 * JS 的 `String.replace` 一旦跑起来**中断不了**（没有超时、没有信号），而灾难性回溯
 * 压根不需要写出括号 —— `a+a+a+a+a+a+a+a+a+a+$` 在 49 个字符的名字上实测 34 秒，
 * 主进程连同 UI、IPC、Agent 一起停住，只能从任务管理器杀。
 *
 * 试过按「形状」拦（拒掉带量词的组），两个方向都错：上面那条不带组的照样过得去，
 * 而 `\(\d+\)+$`（剥掉 Windows 复制文件时加的 `(1)`）实测 0.0003 毫秒却被判成危险。
 * 判据每补一条就有下一类构造绕过去 —— 这类东西没法靠认形状放行。
 *
 * 所以换成三个固定位置 + 纯文本。用户真正想做的事（去掉 `_FINAL` / `_v2` / `_copy`、
 * 把 `Temp_` 换成 `WIP_`、清拼音残留）全是「在开头/结尾/中间找一段原文换掉」，
 * 一个正则都用不上；而这么一换，卡死的可能性从代码里消失了，不是被挡住了。
 */
export type CustomRuleMatch = 'startsWith' | 'endsWith' | 'contains'

/**
 * 自定义规则
 */
export interface CustomRule {
  /** 规则名称 */
  name: string
  /** 匹配位置：开头 / 结尾 / 任意位置 */
  match: CustomRuleMatch
  /** 要找的原文，**纯文本按字面匹配**，不是正则 */
  text: string
  /** 换成什么，留空表示删掉这一段 */
  replacement: string
  /** 是否启用 */
  enabled?: boolean
  /** 规则描述 */
  description?: string
}

/**
 * 命名规则配置
 */
export interface NamingRulesConfig {
  /** 配置版本 */
  version: string
  /** 资产类型到前缀的映射 */
  assetPrefixes: Record<string, string>
  /** 纹理后缀检测规则 */
  textureSuffixPatterns: TextureSuffixPattern[]
  /** 资产类型到目录的映射 */
  assetTypeToDirectory: Record<string, string>
  /** 资产库内部的分类目录映射 (相对路径) */
  libraryAssetTypeToDirectory: Record<string, string>
  /** 文件扩展名到资产类型的映射 */
  extensionToAssetType: Record<string, string>
  /** 命名约定 */
  namingConvention: NamingConvention
  /** 自定义规则 */
  customRules?: CustomRule[]
  /** 是否自动添加前缀（如果资产名已包含前缀则跳过） */
  autoAddPrefix?: boolean
  /** 是否自动检测纹理类型 */
  autoDetectTextureType?: boolean
}

/**
 * 默认配置（基于 UE5 标准）
 */
export const DEFAULT_NAMING_RULES_CONFIG: NamingRulesConfig = {
  version: '1.0.0',
  assetPrefixes: {
    StaticMesh: 'SM_',
    SkeletalMesh: 'SK_',
    Texture: 'T_',
    Material: 'M_',
    MaterialInstance: 'MI_',
    SoundWave: 'A_',
    SoundCue: 'A_',
    MediaSource: 'MS_',
    FileMediaSource: 'MS_',
    Blueprint: 'BP_',
    ParticleSystem: 'PS_',
    AnimSequence: 'A_',
    AnimMontage: 'AM_'
  },
  textureSuffixPatterns: [
    {
      pattern: '[-_](diffuse|albedo|basecolor|base_color|color|col|diff|d)$',
      suffix: '_D',
      type: 'Albedo',
      enabled: true
    },
    {
      pattern: '[-_](normal|norm|nrm|n)$',
      suffix: '_N',
      type: 'Normal',
      enabled: true
    },
    {
      pattern: '[-_](roughness|rough|rgh|r)$',
      suffix: '_R',
      type: 'Roughness',
      enabled: true
    },
    {
      pattern: '[-_](metallic|metal|met|m)$',
      suffix: '_M',
      type: 'Metallic',
      enabled: true
    },
    {
      pattern: '[-_](ao|ambient|occlusion|occ|o)$',
      suffix: '_AO',
      type: 'AO',
      enabled: true
    },
    {
      pattern: '[-_](height|displacement|disp|h)$',
      suffix: '_H',
      type: 'Height',
      enabled: true
    },
    {
      pattern: '[-_](emissive|emit|e)$',
      suffix: '_E',
      type: 'Emissive',
      enabled: true
    },
    {
      pattern: '[-_](opacity|alpha|a)$',
      suffix: '_A',
      type: 'Opacity',
      enabled: true
    },
    {
      pattern: '[-_](mask)$',
      suffix: '_Mask',
      type: 'Mask',
      enabled: true
    }
  ],
  assetTypeToDirectory: {
    StaticMesh: '/Game/Imported/Meshes/Static',
    SkeletalMesh: '/Game/Imported/Meshes/Skeletal',
    Texture: '/Game/Imported/Textures',
    Material: '/Game/Imported/Materials',
    MaterialInstance: '/Game/Imported/Materials/Instances',
    SoundWave: '/Game/Imported/Audio/SFX',
    SoundCue: '/Game/Imported/Audio/Cues',
    FileMediaSource: '/Game/Imported/Media/Video',
    Blueprint: '/Game/Imported/Blueprints',
    ParticleSystem: '/Game/Imported/Effects',
    AnimSequence: '/Game/Imported/Animations',
    AnimMontage: '/Game/Imported/Animations/Montages'
  },
  libraryAssetTypeToDirectory: {
    StaticMesh: 'Meshes/Static',
    SkeletalMesh: 'Meshes/Skeletal',
    Texture: 'Textures',
    Material: 'Materials',
    MaterialInstance: 'Materials/Instances',
    SoundWave: 'Audio/SFX',
    SoundCue: 'Audio/Cues',
    FileMediaSource: 'Media/Video',
    Blueprint: 'Blueprints',
    ParticleSystem: 'Effects',
    AnimSequence: 'Animations',
    AnimMontage: 'Animations/Montages',
    World: 'Levels'
  },
  extensionToAssetType: {
    fbx: 'StaticMesh',
    obj: 'StaticMesh',
    glb: 'StaticMesh',
    gltf: 'StaticMesh',
    png: 'Texture',
    jpg: 'Texture',
    jpeg: 'Texture',
    tga: 'Texture',
    exr: 'Texture',
    hdr: 'Texture',
    bmp: 'Texture',
    tiff: 'Texture',
    wav: 'SoundWave',
    mp3: 'SoundWave',
    ogg: 'SoundWave',
    flac: 'SoundWave',
    mp4: 'FileMediaSource',
    mov: 'FileMediaSource',
    avi: 'FileMediaSource',
    wmv: 'FileMediaSource',
    mkv: 'FileMediaSource',
    webm: 'FileMediaSource'
  },
  namingConvention: 'pascalCase',
  autoAddPrefix: true,
  autoDetectTextureType: true,
  customRules: []
}
