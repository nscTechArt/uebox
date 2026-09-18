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
    expect(composer).toMatch(/await aiProviderAPI\.setAgentRole\(\s+settings\.roles/)
    expect(composer).toMatch(/setAgentRole\([\s\S]*?await loadThinkingSupport\(\)/)
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
