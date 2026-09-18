import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/Home/components/Project/ProjectSection.vue'),
  'utf8'
)

describe('ProjectSection header actions', () => {
  it('uses a storefront icon for the template market action', () => {
    expect(source).toMatch(
      /:title="t\('page\.home\.project\.createFromTemplate'\)"[\s\S]*?@click="handleClickCreateProject"[\s\S]*?<PhStorefront\s*\/>/
    )
  })

  it('uses a plus icon for importing an existing project', () => {
    expect(source).toMatch(
      /id="project-import-entry"[\s\S]*?:title="t\('page\.home\.project\.importExisting'\)"[\s\S]*?<PhPlus\s*\/>/
    )
  })
})
