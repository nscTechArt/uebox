import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('InputComposer image generation mode', () => {
  const composer = read('src/renderer/src/views/Assistant/components/InputComposer.vue')
  const welcome = read('src/renderer/src/views/Assistant/Welcome.vue')
  const zhCN = read('src/renderer/src/i18n/locales/zh-CN.ts')
  const enUS = read('src/renderer/src/i18n/locales/en-US.ts')

  it('renders the active mode as a semantic button without the banana icon', () => {
    expect(composer).toMatch(
      /<button\s+v-if="isImageGenerationMode"\s+type="button"\s+class="tool-indicator image-mode"/
    )
    expect(composer).toContain("t('assistant.composer.imageGen')")
    expect(zhCN).toContain("imageGen: '图片生成'")
    expect(zhCN).not.toContain('🍌图片生成')
  })

  it('cancels and persists image generation mode when the active chip is clicked', () => {
    expect(composer).toContain('@click="emit(\'cancel-image-generation\')"')
    expect(composer).toContain("(e: 'cancel-image-generation'): void")
    expect(welcome.match(/@cancel-image-generation="handleCancelImageGeneration"/g)).toHaveLength(2)
    expect(welcome).toMatch(
      /function handleCancelImageGeneration\(\): void \{\s+isImageGenerationMode\.value = false\s+chatStore\.setImageGenerationMode\(sid\.value, false\)\s+\}/
    )
  })

  it('explains the toggle action to pointer and keyboard users in both languages', () => {
    expect(composer).toContain(':title="t(\'assistant.composer.exitImageGen\')"')
    expect(composer).toContain('aria-pressed="true"')
    expect(composer).toContain('&:focus-visible')
    expect(zhCN).toContain("exitImageGen: '退出图片生成模式'")
    expect(enUS).toContain("exitImageGen: 'Exit image generation mode'")
  })
})
