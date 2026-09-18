import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/Home/components/Project/ImportProjectModal.vue'),
  'utf8'
)

describe('ImportProjectModal visual hierarchy', () => {
  it('uses one calm, keyboard-accessible project list instead of competing cards', () => {
    expect(source).toContain('class="project-list-inner"')
    expect(source).toContain('class="project-row"')
    expect(source).toContain(':disabled="project.isImported"')
    expect(source).toMatch(/\.project-row\s*\{[\s\S]*border-bottom:/)
    expect(source).toMatch(/\.project-row[\s\S]*&:focus-visible/)
    expect(source).not.toContain('grid-template-columns: repeat(2')
    expect(source).not.toContain('@accent:')
  })
})
