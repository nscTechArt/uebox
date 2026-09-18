import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * 智能推荐芯片 Composable
 * 根据用户输入的关键词推荐下一步操作
 */
export function useContextChips() {
  const { t } = useI18n()
  const contextChips = ref<string[]>([])

  /**
   * 基于最近一次用户意图更新上下文建议芯片
   * @param lastUserText 最近用户输入文本
   */
  function updateContextChips(lastUserText: string): void {
    const lowerText = lastUserText.toLowerCase()
    const hit = (keys: string[]): boolean => keys.some((k) => lowerText.includes(k))

    if (hit(['budget', '预算'])) {
      contextChips.value = [
        t('assistant.contextChips.budget.0'),
        t('assistant.contextChips.budget.1'),
        t('assistant.contextChips.budget.2')
      ]
    } else if (hit(['analytics', '分析', 'dashboard', '仪表盘'])) {
      contextChips.value = [
        t('assistant.contextChips.analytics.0'),
        t('assistant.contextChips.analytics.1'),
        t('assistant.contextChips.analytics.2')
      ]
    } else if (hit(['blueprint', '蓝图', 'bp'])) {
      contextChips.value = [
        t('assistant.contextChips.blueprint.0'),
        t('assistant.contextChips.blueprint.1'),
        t('assistant.contextChips.blueprint.2')
      ]
    } else if (hit(['material', '材质', 'shader', '着色器'])) {
      contextChips.value = [
        t('assistant.contextChips.material.0'),
        t('assistant.contextChips.material.1'),
        t('assistant.contextChips.material.2')
      ]
    } else if (hit(['niagara', '粒子'])) {
      contextChips.value = [
        t('assistant.contextChips.niagara.0'),
        t('assistant.contextChips.niagara.1'),
        t('assistant.contextChips.niagara.2')
      ]
    } else if (hit(['physics', '物理', '碰撞'])) {
      contextChips.value = [
        t('assistant.contextChips.physics.0'),
        t('assistant.contextChips.physics.1'),
        t('assistant.contextChips.physics.2')
      ]
    } else if (hit(['animation', '动画', 'sequencer'])) {
      contextChips.value = [
        t('assistant.contextChips.animation.0'),
        t('assistant.contextChips.animation.1'),
        t('assistant.contextChips.animation.2')
      ]
    } else if (hit(['package', '打包', 'build', '构建', '部署'])) {
      contextChips.value = [
        t('assistant.contextChips.package.0'),
        t('assistant.contextChips.package.1'),
        t('assistant.contextChips.package.2')
      ]
    } else if (hit(['performance', '性能', '优化'])) {
      contextChips.value = [
        t('assistant.contextChips.performance.0'),
        t('assistant.contextChips.performance.1'),
        t('assistant.contextChips.performance.2')
      ]
    } else if (hit(['ai', '行为树', 'pathfinding', '寻路'])) {
      contextChips.value = [
        t('assistant.contextChips.ai.0'),
        t('assistant.contextChips.ai.1'),
        t('assistant.contextChips.ai.2')
      ]
    } else if (hit(['input', '绑定', '控件'])) {
      contextChips.value = [
        t('assistant.contextChips.input.0'),
        t('assistant.contextChips.input.1'),
        t('assistant.contextChips.input.2')
      ]
    } else {
      contextChips.value = [
        t('assistant.contextChips.default.0'),
        t('assistant.contextChips.default.1'),
        t('assistant.contextChips.default.2')
      ]
    }
  }

  return {
    contextChips,
    updateContextChips
  }
}
