import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/Assistant/components/InputComposer.vue'),
  'utf8'
)

describe('InputComposer skill menu on click focus', () => {
  it('reopens the skill menu when clicking the textarea while a / query is active', () => {
    expect(source).toContain('@click="handleTextareaClick"')
    expect(source).toMatch(
      /function handleTextareaClick\(\): void \{[\s\S]*?showSkillMenu\.value = skillQuery\.value !== null/
    )
  })
})
