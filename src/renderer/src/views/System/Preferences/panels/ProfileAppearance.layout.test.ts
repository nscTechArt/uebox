import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appearanceSource = readFileSync(resolve(__dirname, 'ProfileAppearance.vue'), 'utf8')
const generalSource = readFileSync(resolve(__dirname, 'ProfileGeneral.vue'), 'utf8')

describe('ProfileAppearance layout', () => {
  it('places the theme label and selector in the same horizontal setting row', () => {
    expect(appearanceSource).toMatch(
      /<div class="setting-item theme-setting">[\s\S]*?<div class="setting-label">[\s\S]*?<a-select[\s\S]*?class="theme-select"/
    )
    expect(appearanceSource).not.toContain('class="settings-grid"')
  })

  it('keeps the language and theme selectors compact', () => {
    expect(generalSource).toMatch(
      /\.language-select\s*{[\s\S]*?flex:\s*0 1 160px;[\s\S]*?min-width:\s*0;/
    )
    expect(appearanceSource).toMatch(
      /\.theme-select\s*{[\s\S]*?flex:\s*0 1 160px;[\s\S]*?min-width:\s*0;/
    )
  })
})
