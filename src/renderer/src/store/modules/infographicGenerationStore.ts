import { defineStore } from 'pinia'
import { ref, computed, toValue } from 'vue'
import {
  createInfographicService,
  type InfographicState,
  type InfographicConfig,
  DEFAULT_INFOGRAPHIC_CONFIG,
  InfographicService
} from '@renderer/services/infographic'

/**
 * 信息图生成 Store
 * 用于管理全局的信息图生成进程和状态
 */
export const useInfographicGenerationStore = defineStore('infographicGeneration', () => {
  /** 当前的信息图生成服务实例 */
  const service = ref<InfographicService>(createInfographicService())

  /** 当前正在生成的 Output ID */
  const currentOutputId = ref<string | null>(null)

  /** 默认状态 */
  const defaultState: InfographicState = {
    status: 'idle',
    progress: 0,
    message: ''
  }

  /**
   * 获取当前服务状态
   */
  const state = computed<InfographicState>(() => {
    const svc = service.value
    if (!svc || !svc.state) return defaultState
    // 使用 toValue 解包响应式 ref
    const stateValue = toValue(svc.state)
    return stateValue ?? defaultState
  })

  /**
   * 是否正在生成
   */
  const isGenerating = computed<boolean>(() => {
    const status = state.value?.status
    if (!status) return false
    return status !== 'idle' && status !== 'completed' && status !== 'failed'
  })

  /**
   * 开始新的生成会话
   * @param outputId 产出 ID
   */
  function startGeneration(outputId: string): void {
    service.value.reset()
    currentOutputId.value = outputId
  }

  /**
   * 清空生成状态
   */
  function clearGeneration(): void {
    currentOutputId.value = null
    service.value.reset()
  }

  /**
   * 检查指定 outputId 是否正在生成
   * @param outputId 产出 ID
   */
  function isOutputGenerating(outputId: string): boolean {
    return currentOutputId.value === outputId && isGenerating.value
  }

  /** 当前配置 */
  const config = ref<InfographicConfig>({
    ...DEFAULT_INFOGRAPHIC_CONFIG
  })

  function normalizeConfig(savedConfig: Record<string, unknown>): Partial<InfographicConfig> {
    const normalizedConfig: Partial<InfographicConfig> = {}
    if (typeof savedConfig.imageSize === 'string') {
      normalizedConfig.imageSize = savedConfig.imageSize as InfographicConfig['imageSize']
    }
    if (typeof savedConfig.aspectRatio === 'string') {
      normalizedConfig.aspectRatio = savedConfig.aspectRatio as InfographicConfig['aspectRatio']
    }
    if (typeof savedConfig.providerId === 'string' && savedConfig.providerId.trim()) {
      normalizedConfig.providerId = savedConfig.providerId
    }
    if (typeof savedConfig.modelId === 'string' && savedConfig.modelId.trim()) {
      normalizedConfig.modelId = savedConfig.modelId
    }
    if (typeof savedConfig.prompt === 'string' && savedConfig.prompt.trim()) {
      normalizedConfig.prompt = savedConfig.prompt
    }
    // 旧版把四个官方预设的 provider/model 写进这里；它们不等于用户配置，
    // 故意不迁移。第一次打开选择器时会按当前「生图」绑定或首个可用模型选中。
    return normalizedConfig
  }

  /**
   * 从localStorage加载配置
   */
  function loadConfig(): void {
    try {
      const saved = localStorage.getItem('infographic_model_config')
      console.log('[InfographicStore] 加载配置:', saved)
      if (saved) {
        const savedConfig = normalizeConfig(JSON.parse(saved) as Partial<InfographicConfig>)
        config.value = { ...DEFAULT_INFOGRAPHIC_CONFIG, ...savedConfig }
        console.log('[InfographicStore] 配置已加载:', config.value)
        saveConfig()
        // 使用加载的配置重新创建服务
        service.value = createInfographicService(config.value)
      }
    } catch (error) {
      console.error('[InfographicStore] 加载配置失败:', error)
    }
  }

  /**
   * 保存配置到localStorage
   */
  function saveConfig(): void {
    try {
      localStorage.setItem('infographic_model_config', JSON.stringify(config.value))
    } catch (error) {
      console.error('[InfographicStore] 保存配置失败:', error)
    }
  }

  /**
   * 更新配置
   * @param newConfig 新配置（部分）
   */
  function updateConfig(newConfig: Partial<InfographicConfig>): void {
    console.log('[InfographicStore] 更新配置:', newConfig)
    config.value = { ...config.value, ...newConfig }
    console.log('[InfographicStore] 新配置值:', config.value)
    // 保存配置
    saveConfig()
    // 重新创建服务实例
    service.value = createInfographicService(config.value)
  }

  // 初始化时加载配置
  loadConfig()

  return {
    service,
    currentOutputId,
    state,
    isGenerating,
    startGeneration,
    clearGeneration,
    isOutputGenerating,
    config: computed(() => config.value),
    updateConfig
  }
})
