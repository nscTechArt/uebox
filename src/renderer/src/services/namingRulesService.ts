/**
 * 命名规则配置管理服务（渲染进程）
 */
import type { CustomRuleMatch, NamingRulesConfig } from '../types/namingRules'
import { DEFAULT_NAMING_RULES_CONFIG } from '../types/namingRules'

// 配置缓存
let cachedConfig: NamingRulesConfig | null = null
let loadingPromise: Promise<NamingRulesConfig> | null = null

/**
 * 加载命名规则配置
 */
export async function loadNamingRulesConfig(): Promise<NamingRulesConfig> {
  // 如果已有缓存，直接返回
  if (cachedConfig) {
    return cachedConfig
  }

  // 如果正在加载，等待加载完成
  if (loadingPromise) {
    return loadingPromise
  }

  // 开始加载
  loadingPromise = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = await (window as any).api.namingRules.loadConfig()
      cachedConfig = config
      return config
    } catch (error) {
      console.error('[NamingRulesService] 加载配置失败:', error)
      // 失败时使用默认配置
      cachedConfig = { ...DEFAULT_NAMING_RULES_CONFIG }
      return cachedConfig
    } finally {
      loadingPromise = null
    }
  })()

  return loadingPromise
}

/**
 * 清理配置对象，确保只包含可序列化的数据
 * 使用 JSON 序列化/反序列化来移除 Vue 响应式代理和不可序列化的内容
 */
function sanitizeConfig(config: NamingRulesConfig): NamingRulesConfig {
  try {
    // 使用 JSON 序列化/反序列化来创建纯 JavaScript 对象
    // 这会移除 Vue 的响应式代理和任何不可序列化的内容
    const jsonString = JSON.stringify(config)
    const parsed = JSON.parse(jsonString) as Partial<NamingRulesConfig>

    // 确保所有必需字段都存在，使用默认值填充
    const sanitized: NamingRulesConfig = {
      version: String(parsed.version || '1.0.0'),
      assetPrefixes: parsed.assetPrefixes || {},
      textureSuffixPatterns: (parsed.textureSuffixPatterns || []).map((pattern) => ({
        pattern: String(pattern.pattern || ''),
        suffix: String(pattern.suffix || ''),
        type: String(pattern.type || ''),
        enabled: pattern.enabled !== false // 默认为 true
      })),
      assetTypeToDirectory: parsed.assetTypeToDirectory || {},
      libraryAssetTypeToDirectory: parsed.libraryAssetTypeToDirectory || {},
      extensionToAssetType: parsed.extensionToAssetType || {},
      namingConvention: (parsed.namingConvention ||
        'pascalCase') as NamingRulesConfig['namingConvention'],
      autoAddPrefix: parsed.autoAddPrefix !== undefined ? Boolean(parsed.autoAddPrefix) : true,
      autoDetectTextureType:
        parsed.autoDetectTextureType !== undefined ? Boolean(parsed.autoDetectTextureType) : true,
      customRules: (parsed.customRules || []).map((rule) => ({
        name: String(rule.name || ''),
        // 只认这三个位置，别的一律回落到「包含」—— 这份 sanitize 是存盘前的最后一道，
        // 放一个不认识的值进去，整理那边 switch 会走 default，跟用户看到的选项不是一件事
        match: (['startsWith', 'endsWith', 'contains'] as const).includes(
          rule.match as CustomRuleMatch
        )
          ? rule.match
          : 'contains',
        text: String(rule.text || ''),
        replacement: String(rule.replacement || ''),
        enabled: rule.enabled !== false,
        description: rule.description ? String(rule.description) : undefined
      }))
    }

    return sanitized
  } catch (error) {
    console.error('[NamingRulesService] 清理配置对象失败:', error)
    // 如果序列化失败，返回默认配置
    return { ...DEFAULT_NAMING_RULES_CONFIG }
  }
}

/**
 * 保存命名规则配置
 */
export async function saveNamingRulesConfig(config: NamingRulesConfig): Promise<boolean> {
  try {
    // 清理配置对象，确保可序列化
    const sanitized = sanitizeConfig(config)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const success = await (window as any).api.namingRules.saveConfig(sanitized)
    if (success) {
      // 更新缓存（使用清理后的配置）
      cachedConfig = sanitized
      // 触发配置更新事件
      window.dispatchEvent(
        new CustomEvent('naming-rules-config-changed', {
          detail: sanitized
        })
      )
    }
    return success
  } catch (error) {
    console.error('[NamingRulesService] 保存配置失败:', error)
    console.error('[NamingRulesService] 配置对象:', config)
    return false
  }
}

/**
 * 获取当前配置（同步，从缓存读取）
 */
export function getNamingRulesConfig(): NamingRulesConfig {
  if (cachedConfig) {
    return cachedConfig
  }
  // 如果没有缓存，返回默认配置（异步加载会在后台进行）
  return { ...DEFAULT_NAMING_RULES_CONFIG }
}

/**
 * 重置为默认配置
 */
export async function resetNamingRulesConfig(): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const success = await (window as any).api.namingRules.resetConfig()
  if (success) {
    cachedConfig = { ...DEFAULT_NAMING_RULES_CONFIG }
    window.dispatchEvent(
      new CustomEvent('naming-rules-config-changed', {
        detail: cachedConfig
      })
    )
  }
  return success
}

/**
 * 强制刷新配置
 */
export async function refreshNamingRulesConfig(): Promise<NamingRulesConfig> {
  cachedConfig = null
  loadingPromise = null
  return loadNamingRulesConfig()
}
