import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf-8')

describe('首次打开的新手引导已移除', () => {
  it('不再携带首页和 AI 聊天引导实现', () => {
    for (const relative of [
      'src/renderer/src/views/Home/composables/useHomeOnboardingGuide.ts',
      'src/renderer/src/views/Assistant/composables/useOnboardingGuide.ts'
    ]) {
      expect(existsSync(join(ROOT, relative)), relative).toBe(false)
    }
  })

  it('首页和 AI 聊天不再启动引导或保留专用组件接口', () => {
    const sources = [
      read('src/renderer/src/views/Home/Home.vue'),
      read('src/renderer/src/views/Home/components/Project/ProjectSection.vue'),
      read('src/renderer/src/views/Assistant/Welcome.vue'),
      read('src/renderer/src/views/Assistant/components/InputComposer.vue')
    ]

    for (const source of sources) {
      expect(source).not.toContain('startOnboarding')
      expect(source).not.toContain('welcomeInputComposerRef')
      expect(source).not.toContain('driver.js')
    }
  })

  it('不再携带引导文案、一次性标记和专用依赖', () => {
    const sources = [
      read('src/renderer/src/i18n/locales/zh-CN.ts'),
      read('src/renderer/src/i18n/locales/en-US.ts'),
      read('scripts/local-storage.baseline.json'),
      read('tests/manual/verify-chat-resume.mjs'),
      read('tests/manual/verify-chat-v3-features.mjs'),
      read('tests/manual/verify-preferences-panels.mjs')
    ]

    for (const source of sources) {
      expect(source).not.toContain('ai_chat_onboarding_completed')
      expect(source).not.toContain('home_onboarding_completed')
    }
    expect(read('package.json')).not.toContain('driver.js')
  })
})
