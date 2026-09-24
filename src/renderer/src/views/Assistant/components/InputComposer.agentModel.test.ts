import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('InputComposer Agent model selector', () => {
  const composer = read('src/renderer/src/views/Assistant/components/InputComposer.vue')
  const zhCN = read('src/renderer/src/i18n/locales/zh-CN.ts')
  const enUS = read('src/renderer/src/i18n/locales/en-US.ts')

  it('把快捷入口放在输入栏右侧、语音按钮之前', () => {
    const rightTools = composer.indexOf('<div class="right-tools">')
    const modelSelector = composer.indexOf('class="agent-model-selector"', rightTools)
    const voiceButton = composer.indexOf('class="voice-slot"', rightTools)

    expect(rightTools).toBeGreaterThan(-1)
    expect(modelSelector).toBeGreaterThan(rightTools)
    expect(modelSelector).toBeLessThan(voiceButton)
    expect(composer.slice(rightTools, modelSelector)).toContain('v-if="!isImageGenerationMode"')
    expect(composer).toContain('class="mode-dropdown agent-model-dropdown"')
    expect(composer).toContain('class="mode-option agent-model-option"')
  })

  it('任务执行中锁住切换，选择后同时刷新思考档位', () => {
    expect(composer).toContain(
      '() => !!props.disabled || !!props.isGenerating || agentModelSaving.value'
    )
    // 只把选中的那个模型交出去；别的角色由主进程在最新配置上保留，不从这里带整张表
    expect(composer).toMatch(
      /await aiProviderAPI\.setAgentRole\(\s+\{\s+providerId: option\.providerId/
    )
    expect(composer).toMatch(/setAgentRole\([\s\S]*?await loadThinkingSupport\(\)/)
  })

  it('弹窗高度按触发器上方的剩余空间收窄，欢迎页不会顶出窗口', () => {
    expect(composer).toContain('ref="agentModelSelectorEl"')
    expect(composer).toContain(':style="{ maxBlockSize: agentModelDropdownMaxHeight }"')
    expect(composer).toMatch(
      /function syncAgentModelDropdownHeight[\s\S]*?agentModelSelectorEl\.value\?\.getBoundingClientRect\(\)\.top/
    )
    expect(composer).toMatch(
      /function syncAgentModelDropdownHeight[\s\S]*?Math\.min\(available, window\.innerHeight \* 0\.5\)/
    )
    expect(composer).toMatch(
      /showAgentModelDropdown\.value\) \{\s+syncAgentModelDropdownHeight\(\)/
    )
    // 弹窗用 bottom: 100% 向上展开，锚点必须是触发器本身而不是整个输入框。
    expect(composer).toMatch(/\.agent-model-selector \{\s+position: relative;/)
  })

  it('加载、空态、失败和成功提示均提供双语文案', () => {
    expect(zhCN).toContain("select: '选择模型'")
    expect(enUS).toContain("select: 'Select model'")
    for (const source of [zhCN, enUS]) {
      expect(source).toContain('switchFailed:')
      expect(source).toContain('loadFailed:')
      expect(source).toContain('empty:')
    }
  })
})
