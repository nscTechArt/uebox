import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('InputComposer goal mode', () => {
  const composer = read('src/renderer/src/views/Assistant/components/InputComposer.vue')
  const zhCN = read('src/renderer/src/i18n/locales/zh-CN.ts')
  const enUS = read('src/renderer/src/i18n/locales/en-US.ts')

  it('shows a target icon and the same framed mode control used by image generation', () => {
    expect(composer).toMatch(
      /<button\s+v-if="isGoalMode"[\s\S]*?class="tool-indicator goal-mode"[\s\S]*?<PhTarget \/>/
    )
    expect(composer).toMatch(/\.tool-indicator\.image-mode,\s+\.tool-indicator\.goal-mode/)
    expect(zhCN).toContain("goalMode: '目标'")
    expect(enUS).toContain("goalMode: 'Goal'")
  })

  it('hides only the command prefix while keeping the real goal command in the draft', () => {
    expect(composer).toContain('v-model:value="composerContent"')
    expect(composer).toContain('parseGoalCommandDraft(content.value)')
    expect(composer).toContain('buildGoalCommandDraft(value)')
    expect(composer).toContain('const hasContent = composerContent.value.trim().length > 0')
  })

  it('turns goal mode off without discarding the objective text', () => {
    expect(composer).toContain('@click="cancelGoalMode"')
    expect(composer).toMatch(
      /function cancelGoalMode\(\): void \{\s+const objective = parseGoalCommandDraft\(content\.value\)\s+if \(objective === null\) return\s+content\.value = objective\s+\}/
    )
    expect(zhCN).toContain("exitGoalMode: '退出目标模式'")
    expect(enUS).toContain("exitGoalMode: 'Exit goal mode'")
  })
})
