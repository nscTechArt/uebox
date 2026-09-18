import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sideMenuSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/layout/components/SideMenu.vue'),
  'utf8'
)
const brandMarkSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/BrandMark.vue'),
  'utf8'
)
const appIconSource = readFileSync(resolve(process.cwd(), 'build/icon.svg'), 'utf8')
const darkAppIconSource = readFileSync(resolve(process.cwd(), 'build/icon-dark.svg'), 'utf8')
const horizontalLogoSources = [
  'src/renderer/src/assets/imgs/logos/logo_lang_blackText.svg',
  'src/renderer/src/assets/imgs/logos/logo_lang_whiteText.svg'
].map((file) => readFileSync(resolve(process.cwd(), file), 'utf8'))
const brandSurfaces = [
  'src/renderer/src/layout/components/SideMenu.vue',
  'src/renderer/src/views/MiniChat/MiniChatWindow.vue',
  'src/renderer/src/views/System/Preferences/panels/ProfileAbout.vue',
  'src/renderer/src/views/System/Onboarding/LanguageGate.vue'
].map((file) => readFileSync(resolve(process.cwd(), file), 'utf8'))

describe('Unreal Box brand mark', () => {
  it('uses the shared viewport mark on every in-app brand surface', () => {
    const viewportPath = 'M27 10H10v17M37 10h17v17M54 37v17H37M27 54H10V37'

    expect(brandMarkSource).toContain(viewportPath)
    expect(appIconSource).toContain(viewportPath)
    expect(darkAppIconSource).toContain(viewportPath)
    horizontalLogoSources.forEach((source) => expect(source).toContain(viewportPath))
    expect(brandMarkSource).toContain('color: var(--color-text-muted)')
    expect(sideMenuSource).toContain('class="brand-wordmark"')
    brandSurfaces.forEach((source) => expect(source).toContain('<BrandMark'))
  })

  it('does not load the old raster box logo on those surfaces', () => {
    brandSurfaces.forEach((source) => {
      expect(source).not.toContain('assets/imgs/logos')
      expect(source).not.toContain('assets/images/logo')
    })
  })

  it('keeps runtime, installer, and compatibility icon files on the same new app icon', () => {
    const appIcon = readFileSync(resolve(process.cwd(), 'build/icon.png'))
    const copies = [
      'resources/icon.png',
      'src/renderer/src/assets/imgs/logos/logo.png',
      'src/renderer/src/assets/imgs/logos/logo_with_blackText.png',
      'src/renderer/src/assets/imgs/logos/logo_with_whiteText.png'
    ]

    copies.forEach((file) => {
      expect(readFileSync(resolve(process.cwd(), file))).toEqual(appIcon)
    })
    expect(readFileSync(resolve(process.cwd(), 'resources/icon.ico'))).toEqual(
      readFileSync(resolve(process.cwd(), 'build/icon.ico'))
    )
    expect(readFileSync(resolve(process.cwd(), 'resources/icon-dark.ico'))).toEqual(
      readFileSync(resolve(process.cwd(), 'build/icon-dark.ico'))
    )
  })

  it('keeps the dark icon geometry identical while reversing the plate contrast', () => {
    expect(appIconSource).toContain('transform="translate(16 16) scale(7.5)"')
    expect(darkAppIconSource).toContain('transform="translate(16 16) scale(7.5)"')
    expect(darkAppIconSource).toContain('fill="#17191c"')
    expect(darkAppIconSource).toContain('stroke="#f2f1ed"')
    expect(darkAppIconSource).toContain('stroke="#9aa0a6"')
  })
})
