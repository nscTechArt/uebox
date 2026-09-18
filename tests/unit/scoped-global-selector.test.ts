import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `<style scoped>` 里 `:global()` 的用法守卫。
 *
 * ## 这条守的是什么
 *
 * Vue 的 scoped 编译器处理 `:global()` 时，做的是「把**整条**选择器换成括号里的
 * 内容」（`compiler-sfc/src/style/pluginScoped.ts`）：
 *
 *     if (value === ':global' || value === '::v-global') {
 *       selector.replaceWith(n.nodes[0])
 *       return false
 *     }
 *
 * 所以括号外面的部分——不管在前还是在后——都会被**静默丢掉**，连 `[data-v-xxx]`
 * 也不补（`return false` 跳过了加作用域那一步）：
 *
 *     :global([data-theme='dark']) .logo   →   [data-theme='dark']
 *     .editor :global(.tooltip)            →   .tooltip
 *
 * 这不是 bug，是 RFC 0023 定义的行为：`:global()` 是**整条规则**的逃生舱，
 * 不是能拼在选择器中间的组合子。坑在于它跟 CSS Modules 的同名写法语义相反，
 * 而且编译结果不会有任何警告。
 *
 * ## 为什么值得单独立一道门
 *
 * 2026-08-30 就踩过一次：ProviderCatalogModal 写了
 * `:global([data-theme='dark']) .catalog-card-logo-image { filter: brightness(0) invert(1) }`,
 * 编译出来是光秃秃的 `[data-theme='dark']`——也就是 `<html>` 自己。一条本来只想
 * 把厂商图标刷白的 filter 落在了整个文档上，打开偏好设置就整屏纯白。
 *
 * 代价是白屏，肉眼看代码却完全正常，靠 review 拦不住。
 * 现成的 eslint-plugin-vue-scoped-css 只有 `no-parent-of-v-global`，
 * 管的是 `.a :global(.b)` 这一半，管不到我们踩的 `:global(.a) .b`，所以自己写。
 *
 * ## 正确写法
 *
 * 想按组件外的祖先（主题、根节点的 data 属性）改本组件的样式，祖先选择器直接裸写：
 *
 *     [data-theme='dark'] .catalog-card-logo-image { ... }
 *
 * scoped 只给选择器**末段**补 `[data-v-xxx]`，本来就只命中本组件。
 * `:global()` 只在「这条规则整条都要全局生效」时用，且必须包住整条选择器。
 */

const ROOT = process.cwd()

function vueFiles(): string[] {
  const list = (cmd: string): string[] =>
    execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim().split('\n')

  return [...list('git ls-files src'), ...list('git ls-files --others --exclude-standard src')]
    .filter((f) => f.endsWith('.vue'))
    .filter((f) => f && existsSync(resolve(ROOT, f)))
}

/** 取出所有 scoped 样式块的正文（`<style scoped>` / `<style scoped lang="less">` 等）。 */
function scopedStyleBlocks(source: string): string[] {
  const blocks: string[] = []
  for (const m of source.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)) {
    if (!/\bscoped\b/.test(m[1])) continue
    blocks.push(m[2])
  }
  return blocks
}

/**
 * 逐条取出规则头（`{` 前面那段）。
 *
 * 注释要先剥掉——本文件顶上这段解释里就写着反面例子，不剥的话它自己就会被抓出来。
 */
function selectorHeaders(css: string): string[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const headers: string[] = []
  // 字符类里不能排除括号 —— `:global(...)` 本身就带括号，排掉就永远匹配不到它
  for (const m of stripped.matchAll(/([^{};]*)\{/g)) {
    const header = m[1].replace(/\s+/g, ' ').trim()
    if (header) headers.push(header)
  }
  return headers
}

/**
 * 按**顶层**逗号切开选择器列表。
 *
 * 不能直接 `split(',')`：`:global(html, body, #app)` 括号里的逗号一切就碎，
 * 切出来的 `:global(html` 会被当成违规。
 */
function splitSelectorList(header: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of header) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((s) => s.trim()).filter(Boolean)
}

/** `:global(...)` / `::v-global(...)` 必须**独占**整条选择器，前后都不能再挂东西。 */
const GLOBAL_ALONE = /^(:global|::v-global)\([\s\S]*\)$/

describe('scoped 样式里的 :global()', () => {
  it('必须包住整条选择器，前后不能再挂别的部分', () => {
    const offenders: string[] = []

    for (const file of vueFiles()) {
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      for (const block of scopedStyleBlocks(source)) {
        for (const header of selectorHeaders(block)) {
          if (!/(^|[\s>+~,]):{1,2}(v-)?global\(/.test(header)) continue
          for (const selector of splitSelectorList(header)) {
            if (!selector.includes('global(')) continue
            if (GLOBAL_ALONE.test(selector)) continue
            offenders.push(`${file}: ${selector}`)
          }
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
