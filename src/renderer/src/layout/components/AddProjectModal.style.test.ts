import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const componentSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/layout/components/AddProjectModal.vue'),
  'utf8'
)
const paletteSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/assets/styles/palette.generated.css'),
  'utf8'
)

describe('add project option card states', () => {
  it('keeps the border fixed and prevents hover from overriding selection', () => {
    expect(componentSource).toMatch(/border:\s*1px solid var\(--color-border-option\);/)
    expect(componentSource).toMatch(/background:\s*var\(--color-bg-option\);/)
    expect(componentSource).toMatch(
      /&:not\(\.selected\):hover\s*\{\s*background:\s*var\(--color-bg-option-hover\);/s
    )
    expect(componentSource).toMatch(
      /&\.selected\s*\{\s*background:\s*var\(--color-bg-option-selected\);/s
    )
  })

  it('uses the requested light-theme gray values', () => {
    expect(paletteSource).toMatch(/--n-70:\s*#f3f3f3;/)
    expect(paletteSource).toMatch(/--n-90:\s*#efefef;/)

    const lightTheme = paletteSource.slice(paletteSource.indexOf("[data-theme='light']"))
    expect(lightTheme).toMatch(/--color-bg-option-hover:\s*var\(--n-70\);/)
    expect(lightTheme).toMatch(/--color-bg-option-selected:\s*var\(--n-90\);/)
    expect(lightTheme).toMatch(/--color-border-option:\s*var\(--n-90\);/)
  })

  it('uses the requested dark-theme gray values', () => {
    expect(paletteSource).toMatch(/--n-865:\s*#2f2f2f;/)
    expect(paletteSource).toMatch(/--n-880:\s*#2a2a2a;/)
    expect(paletteSource).toMatch(/--n-910:\s*#222222;/)

    const darkTheme = paletteSource.slice(
      paletteSource.indexOf("[data-theme='dark']"),
      paletteSource.indexOf("[data-theme='light']")
    )
    expect(darkTheme).toMatch(/--color-bg-option:\s*var\(--n-910\);/)
    expect(darkTheme).toMatch(/--color-bg-option-hover:\s*var\(--n-880\);/)
    expect(darkTheme).toMatch(/--color-bg-option-selected:\s*var\(--n-865\);/)
    expect(darkTheme).toMatch(/--color-border-option:\s*var\(--n-865\);/)
  })

  it('reuses the compact project-picker list for covers, search, and scrolling', () => {
    expect(componentSource).toContain('class="add-project-search"')
    expect(componentSource).toContain('type="search"')
    expect(componentSource).toMatch(
      /\.add-project-list\s*\{[\s\S]*height:\s*calc\(var\(--space-20\) \* 3 \+ var\(--space-6\)\);/
    )
    expect(componentSource).toMatch(/\.add-project-list\s*\{[\s\S]*overflow:\s*auto;/)
    expect(componentSource).toMatch(/\.add-project-cover\s*\{[\s\S]*width:\s*var\(--space-12\);/)
    expect(componentSource).toMatch(/\.add-project-cover\s*\{[\s\S]*height:\s*var\(--space-10\);/)
    expect(componentSource).toMatch(/\.add-project-cover[\s\S]*object-fit:\s*cover;/)
  })
})
