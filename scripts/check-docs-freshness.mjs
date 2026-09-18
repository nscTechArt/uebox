#!/usr/bin/env node
/**
 * 文档保鲜检查 / Documentation freshness report.
 *
 * **这不是门禁，是巡检工具。** 它不在 `pnpm verify` 里，不会卡任何人的提交。
 *
 * 为什么刻意不做成门禁：这类检查天然会误报 —— 文档里举例说「比如
 * `src/foo.ts`」时那个路径本来就不该存在。把它接进质检机，头几天就会有人
 * 来要求关掉它，而一道被关掉的门禁比没有更糟。
 *
 * 它做两件事：
 *   1. 文档里提到的代码路径，现在还存不存在（存在 = 文档大概率还准）；
 *   2. Markdown 链接指向的文件在不在（死链一定是错的）。
 *
 * 建议用法：季度清理时跑一次，或者删了一批代码之后跑一次。
 *
 *   node scripts/check-docs-freshness.mjs
 *   node scripts/check-docs-freshness.mjs --dead-links-only   只看死链（零误报）
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const DEAD_LINKS_ONLY = process.argv.includes('--dead-links-only')

/** 要扫描的文档位置：根目录的 .md，加上 docs/ 与各 Agent 接入面 */
const DOC_ROOTS = ['docs', '.claude', '.agents', '.codex']
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'coverage'])

/** 文档里长得像「仓库内代码路径」的东西 */
const CODE_PATH =
  /(?:^|[\s`([])((?:src|tests|scripts|resources|build)\/[A-Za-z0-9_.\-/]+\.(?:ts|tsx|vue|js|mjs|cjs|json|css))/g
/** Markdown 链接里指向本地 .md 的部分 */
const MD_LINK = /\[[^\]]*\]\(([^)#\s]+\.md)\)/g

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(md|rules)$/.test(name)) out.push(full)
  }
  return out
}

function collectDocs() {
  const files = []
  for (const name of readdirSync(ROOT)) {
    if (name.endsWith('.md') && statSync(join(ROOT, name)).isFile()) files.push(join(ROOT, name))
  }
  for (const dir of DOC_ROOTS) walk(join(ROOT, dir), files)
  return files
}

const rel = (p) => relative(ROOT, p).split('\\').join('/')

const docs = collectDocs()
let deadLinks = 0
const stale = []

for (const file of docs) {
  const text = readFileSync(file, 'utf-8')

  // 1) 死链：一定是错的，没有误报空间
  for (const match of text.matchAll(MD_LINK)) {
    const target = resolve(dirname(file), match[1])
    if (!existsSync(target)) {
      console.log(`死链   ${rel(file)}  ->  ${match[1]}`)
      deadLinks++
    }
  }

  if (DEAD_LINKS_ONLY) continue

  // 2) 失效的代码路径：只是「可能过期」的信号，不是错误
  const paths = [...new Set([...text.matchAll(CODE_PATH)].map((m) => m[1]))]
  if (paths.length === 0) continue
  const missing = paths.filter((p) => !existsSync(join(ROOT, p)))
  if (missing.length === 0) continue
  stale.push({
    file: rel(file),
    total: paths.length,
    missing,
    pct: Math.round((missing.length / paths.length) * 100)
  })
}

if (!DEAD_LINKS_ONLY && stale.length > 0) {
  console.log('\n提到的代码路径已不存在（比例越高，文档越可能已经过期）：\n')
  stale.sort((a, b) => b.pct - a.pct || b.missing.length - a.missing.length)
  for (const row of stale) {
    console.log(`${String(row.pct).padStart(3)}%  ${row.missing.length}/${row.total}  ${row.file}`)
    for (const p of row.missing.slice(0, 3)) console.log(`         · ${p}`)
    if (row.missing.length > 3) console.log(`         · …另有 ${row.missing.length - 3} 处`)
  }
  console.log(
    '\n注意：这一列有误报 —— 文档里作为「举例」写的路径本来就不存在。' +
      '\n判断标准是比例：一份文档超过一半的路径都没了，基本可以确定它在描述已经不存在的东西。'
  )
}

console.log('')
if (deadLinks > 0) {
  console.log(`✖ ${deadLinks} 处死链必须修（链接指向的文件不存在）。`)
} else {
  console.log('✓ 没有死链。')
}
if (!DEAD_LINKS_ONLY) {
  console.log(
    stale.length > 0
      ? `ℹ ${stale.length} 份文档提到了已不存在的代码路径，请人工判断是否该更新或删除。`
      : 'ℹ 所有文档提到的代码路径都还在。'
  )
}

// 巡检工具不改变退出码语义：死链才算失败，「可能过期」只是报告
process.exit(deadLinks > 0 ? 1 : 0)
