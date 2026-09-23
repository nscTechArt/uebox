import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 单色图标守卫。
 *
 * assets/icon 里的字形是单色的 —— 要么写死白色，要么写死黑色。
 * 通过 <img src> 渲染时颜色改不了，所以它们只在某一个主题下能看见：
 * 白字形在浅色模式里消失，黑字形在深色模式里消失。
 *
 * 正确做法是 .mono-icon（CSS mask）：只取图片的形状，颜色来自 currentColor。
 * 厂商品牌标是明确例外：provider-logos 可能被 Vite 内联成 data URL，放进 CSS mask
 * 变量后解析失败，只能用原生 img + 主题 filter。例外按「有没有 import providerLogos」
 * 认，不按文件名 —— 图标查表是共用的，第三个地方用上它不该再把这条测试顶红。
 *
 * 这个测试守两条，防止其他地方图省事又写回 <img>：
 *
 *   1. 单色资源不许出现在 <img> 的 src 上
 *   2. 不许用 filter: invert()/brightness(0) 这类「照着某一个主题写死」的补丁
 *      —— 那正是 ProviderCatalogModal 之前的做法，深色下好看，浅色下同样看不见
 */

const ROOT = process.cwd()
const RENDERER = resolve(ROOT, 'src/renderer/src')

function sourceFiles(): string[] {
  const tracked = execSync('git ls-files src/renderer', { cwd: ROOT, encoding: 'utf8' })
    .trim()
    .split('\n')
  const untracked = execSync('git ls-files --others --exclude-standard src/renderer', {
    cwd: ROOT,
    encoding: 'utf8'
  })
    .trim()
    .split('\n')
  return [...tracked, ...untracked]
    .filter((f) => /\.(vue|css)$/.test(f))
    .filter((f) => f && existsSync(resolve(ROOT, f)))
}

/** assets/icon 下的所有资源都是单色字形。 */
function monoAssetNames(): string[] {
  const dirs = ['assets/icon']
  const names: string[] = []
  for (const dir of dirs) {
    const full = resolve(RENDERER, dir)
    if (!existsSync(full)) continue
    names.push(...readdirSync(full).filter((n) => /\.(png|svg)$/.test(n)))
  }
  return names
}

describe('单色图标', () => {
  it('.mono-icon 工具类还在', () => {
    const css = readFileSync(resolve(RENDERER, 'assets/styles/global.css'), 'utf8')
    expect(css).toContain('.mono-icon')
    expect(css).toMatch(/mask:\s*var\(--mono-icon\)/)
    expect(css).toMatch(/background-color:\s*currentColor/)
  })

  it('单色资源不通过 <img src> 渲染', () => {
    const assets = monoAssetNames()
    expect(assets.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const text = readFileSync(resolve(ROOT, file), 'utf8')
      // 找出「资源名 → 本文件里的导入变量名」，再看那个变量有没有落到 <img :src> 上
      for (const asset of assets) {
        const importMatch = new RegExp(
          `import\\s+(\\w+)\\s+from\\s+['"][^'"]*${asset.replace('.', '\\.')}['"]`
        ).exec(text)
        if (!importMatch) continue
        const varName = importMatch[1]
        const imgSrc = new RegExp(`<img[^>]*:src=["']${varName}["']`, 's')
        if (imgSrc.test(text)) offenders.push(`${file}: <img :src="${varName}">（${asset}）`)
      }
    }

    expect(offenders).toEqual([])
  })

  it('不用 filter 把图标刷成某一个主题专属的颜色', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      // 注释要先剥掉 —— 否则「解释我们为什么不再这么写」的那段注释
      // 本身就会被当成违规抓出来
      const raw = readFileSync(resolve(ROOT, file), 'utf8')
      const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      // 用厂商品牌标的那些文件（providerLogos 查表）吃例外，见文件头
      const usesProviderLogos = /from\s+['"][^'"]*providerLogos['"]/.test(raw)
      for (const m of text.matchAll(/filter:\s*([^;]*)/g)) {
        const value = m[1]
        // drop-shadow 只是投影，不改图标本身的颜色，放行
        if (/^\s*drop-shadow/.test(value)) continue
        const isProviderLogoThemeFilter =
          usesProviderLogos &&
          (value.trim() === 'brightness(0)' || value.trim() === 'brightness(0) invert(1)')
        if (!isProviderLogoThemeFilter && /\binvert\(|\bbrightness\(0\)/.test(value))
          offenders.push(`${file}: filter: ${value.trim()}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
