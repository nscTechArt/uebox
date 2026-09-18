/**
 * 格式化文件大小
 */
export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * UE5 资产类型颜色编码映射表。
 *
 * 值是语义变量，不是写死的 hex —— 色相沿用 UE 编辑器（蓝图是蓝的、纹理是红的），
 * 但亮度彩度由 scripts/gen-palette.mjs 按主题各算一份。
 * 以前这里是照抄 UE 深色编辑器的原值，比如静态网格体 rgba(0,255,255,0.8)，
 * 在亮色模式的白底上只有 1.3:1 —— 那条资产色条等于没画。
 */
const ASSET_TYPE_COLORS: Record<string, string> = {
  StaticMesh: 'var(--color-uetype-static-mesh)', // 静态网格体 - 青色
  SkeletalMesh: 'var(--color-uetype-skeletal-mesh)', // 骨骼网格体 - 粉色
  Texture2D: 'var(--color-uetype-texture)', // 纹理2D - 红色
  Material: 'var(--color-uetype-material)', // 材质 - 绿色
  Blueprint: 'var(--color-uetype-blueprint)', // 蓝图 - 蓝色
  World: 'var(--color-uetype-world)', // 关卡 - 橙色
  Skeleton: 'var(--color-uetype-skeleton)', // 骨骼 - 浅蓝色
  NiagaraSystem: 'var(--color-uetype-niagara)', // Niagara特效 - 亮蓝色
  ParticleSystem: 'var(--color-uetype-particle)', // 粒子系统 - 灰色
  AnimSequence: 'var(--color-uetype-anim-sequence)', // 动画序列 - 绿色
  AnimBlueprint: 'var(--color-uetype-anim-blueprint)', // 动画蓝图 - 橙红色
  SoundWave: 'var(--color-uetype-sound)' // 音波 - 粉色
}

/**
 * 根据资产类型获取颜色条颜色（UE5 标准配色）
 * @param className 资产类名（如 "Blueprint", "Material", "Texture2D" 等）
 * @param assetName 资产名称（用于辅助判断）
 * @returns 颜色值（hex或rgba格式）
 */
export const getAssetTypeColor = (className?: string, assetName?: string): string => {
  const classNameStr = String(className || '').trim()
  const assetNameStr = String(assetName || '').toLowerCase()

  // 优先使用精确匹配
  if (classNameStr) {
    // 直接匹配类名
    if (ASSET_TYPE_COLORS[classNameStr]) {
      return ASSET_TYPE_COLORS[classNameStr]
    }

    // 模糊匹配（不区分大小写）
    const classNameLower = classNameStr.toLowerCase()
    for (const [key, color] of Object.entries(ASSET_TYPE_COLORS)) {
      if (
        classNameLower.includes(key.toLowerCase()) ||
        key.toLowerCase().includes(classNameLower)
      ) {
        return color
      }
    }
  }

  // 通过文件扩展名判断
  if (assetNameStr) {
    // Texture 相关
    if (assetNameStr.match(/\.(tga|dds|png|jpg|jpeg|bmp|exr|hdr|tiff)$/)) {
      return ASSET_TYPE_COLORS['Texture2D']
    }

    // Sound 相关
    if (assetNameStr.match(/\.(wav|mp3|ogg|flac|aac|m4a)$/)) {
      return ASSET_TYPE_COLORS['SoundWave']
    }

    // Level/Map 相关
    if (
      assetNameStr.endsWith('.umap') ||
      assetNameStr.includes('level') ||
      assetNameStr.includes('map')
    ) {
      return ASSET_TYPE_COLORS['World']
    }

    // Blueprint 相关
    if (
      assetNameStr.endsWith('.uasset') &&
      (assetNameStr.includes('bp_') || assetNameStr.includes('blueprint'))
    ) {
      return ASSET_TYPE_COLORS['Blueprint']
    }

    // 代码文件
    if (assetNameStr.match(/\.(cpp|h|hpp|cs|ts|js|tsx|jsx|vue|py|java)$/)) {
      return 'var(--color-uetype-code)' // 灰色
    }
  }

  // 默认颜色（中性灰）
  return 'var(--color-uetype-unknown)'
}
