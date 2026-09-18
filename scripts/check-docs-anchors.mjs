#!/usr/bin/env node
/**
 * 文档站锚点检查。
 *
 * VitePress 的 `ignoreDeadLinks: false` 只查**页面存不存在**，不查 `#锚点` ——
 * 拿一条不存在的锚点去构建，照样是绿的。手册里有几十条跨页锚点链接
 * （「见 xxx#某某小节」），改个标题就会静默变成「跳过去停在页首」。
 * 对着目录点了半天找不到那一段的人，不会意识到是链接坏了。
 *
 * 不自己实现 slugify：VitePress 的中文锚点规则藏在 @mdit-vue/shared 里，
 * 照抄一份必然和上游漂移。改成**读构建产物**里真实生成的 heading id ——
 * 那就是浏览器里会用的那一份，不存在口径差异。
 *
 * 用法：
 *   pnpm site:build && node scripts/check-docs-anchors.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = join(ROOT, 'website')
const DIST = join(SITE, '.vitepress', 'dist')

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (name === 'node_modules' || name === '.vitepress') continue
    if (statSync(full).isDirectory()) walk(full, ext, out)
    else if (name.endsWith(ext)) out.push(full)
  }
  return out
}

function walkDist(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walkDist(full, out)
    else if (name.endsWith('.html')) out.push(full)
  }
  return out
}

if (!existsSync(DIST)) {
  console.error('ERROR 没有构建产物，先跑 pnpm site:build')
  process.exit(1)
}

/** 路由路径（/guide/xxx）→ 这一页真实存在的 heading id 集合 */
const anchorsByRoute = new Map()
for (const file of walkDist(DIST)) {
  const rel = relative(DIST, file).replace(/\\/g, '/')
  // cleanUrls: true —— guide/xxx.html 对应 /guide/xxx，index.html 对应目录本身
  const route = '/' + rel.replace(/index\.html$/, '').replace(/\.html$/, '')
  const html = readFileSync(file, 'utf8')
  const ids = new Set()
  for (const match of html.matchAll(/<h[1-6][^>]*\bid="([^"]+)"/g)) ids.add(match[1])
  anchorsByRoute.set(route.replace(/\/$/, '') || '/', ids)
}

const failures = []

for (const file of walk(SITE, '.md')) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf8')
  // 只看站内链接：]( / 开头，带 #
  for (const match of text.matchAll(/\]\((\/[^)\s]*#[^)\s]+)\)/g)) {
    const [target, rawAnchor] = match[1].split('#')
    const anchor = decodeURIComponent(rawAnchor)
    const route = (target.replace(/\/$/, '') || '/').replace(/\.md$/, '')
    const ids = anchorsByRoute.get(route)
    if (!ids) {
      failures.push(`${rel}: 链接指向不存在的页面 ${target}`)
      continue
    }
    // 产物里的 id 是原样的中文，链接里可能是 encodeURIComponent 过的
    const hit = ids.has(anchor) || ids.has(rawAnchor)
    if (!hit) {
      const near = [...ids].filter((id) => id.includes(anchor.slice(0, 2))).slice(0, 3)
      failures.push(
        `${rel}: ${target}#${anchor} —— 这一页没有这个锚点` +
          (near.length ? `（相近的有：${near.join('、')}）` : '')
      )
    }
  }
}

if (failures.length > 0) {
  for (const line of failures) console.error(`ERROR ${line}`)
  console.error(`\n共 ${failures.length} 条坏锚点。改标题时链接要跟着改。`)
  process.exit(1)
}

const total = [...anchorsByRoute.values()].reduce((n, s) => n + s.size, 0)
console.log(`锚点检查通过（${anchorsByRoute.size} 页，${total} 个锚点）。`)
