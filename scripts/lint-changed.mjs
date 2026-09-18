#!/usr/bin/env node
/**
 * Diff 感知的 ESLint 门禁 / Diff-aware ESLint gate.
 *
 * 为什么需要它：仓库里的存量代码有大量历史 lint 问题（随手抽 5 个文件就有 60 个 error），
 * 所以 `pnpm lint` 只能做到「存量不再变多」的棘轮（见 scripts/check-lint-baseline.mjs）。
 * 光有棘轮还不够：它允许你在一个本来就有 30 个问题的文件里，把问题改成另外 30 个。
 *
 * 这个脚本把门禁从「按文件」改成「按行」：
 *   - 你**新增**的文件 → 全文件零容忍
 *   - 你**改动**的文件 → 只检查你改动的那些行，存量问题不算你头上
 *
 * 用法：
 *   node scripts/lint-changed.mjs            # 对比默认 base（见下）
 *   VERIFY_BASE=origin/main node scripts/lint-changed.mjs
 *
 * base 解析顺序：$VERIFY_BASE → origin/main → main → HEAD
 * 比较范围是 base → **工作区**，所以还没 commit 的改动也会被检查到。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { ESLint } from 'eslint'

const LINTABLE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|vue)$/

/** 跑 git，失败返回 null 而不是抛出 */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** 某个 ref 是否存在 */
function revExists(ref) {
  return git(['rev-parse', '--verify', '--quiet', ref]) !== null
}

/**
 * 决定跟谁比。
 * CI 上 PR 会显式传 VERIFY_BASE=origin/<目标分支>；本地开发多半没有 remote，
 * 于是退到本地 main，再退到 HEAD（= 只检查未提交的改动）。
 */
function resolveBase() {
  const explicit = String(process.env.VERIFY_BASE || '').trim()
  const candidates = explicit ? [explicit] : ['origin/main', 'main']

  for (const candidate of candidates) {
    if (!revExists(candidate)) continue
    const mergeBase = git(['merge-base', 'HEAD', candidate])
    if (mergeBase) return { ref: mergeBase.trim(), label: candidate }
    return { ref: candidate, label: candidate }
  }

  if (explicit) {
    console.error(`✖ VERIFY_BASE=${explicit} 不是一个有效的 git ref。`)
    process.exit(1)
  }
  return { ref: 'HEAD', label: 'HEAD（仅检查未提交的改动）' }
}

/** base → 工作区之间新增/修改/重命名的文件 */
function changedTrackedFiles(base) {
  const raw = git(['diff', '--name-status', '--diff-filter=ACMR', base]) || ''
  const files = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    // 重命名是 "R100\told\tnew"，取最后一段就是当前路径
    const file = parts[parts.length - 1]
    if (file && LINTABLE.test(file)) files.push(file)
  }
  return files
}

/** 还没 git add 的新文件也要管，否则 Agent 新写的文件会漏检 */
function untrackedFiles() {
  const raw = git(['ls-files', '--others', '--exclude-standard']) || ''
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((file) => file && LINTABLE.test(file))
}

/**
 * 解析某个文件被改动的行号区间。
 * `git diff -U0` 的 hunk 头形如 `@@ -12,3 +12,5 @@`，我们只关心 `+` 那一侧。
 * 返回 null 表示「整个文件都算」（新文件 / 未跟踪文件）。
 */
function changedLineRanges(base, file) {
  const raw = git(['diff', '-U0', base, '--', file])
  if (raw === null) return null

  const ranges = []
  for (const line of raw.split('\n')) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!match) continue
    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    if (count === 0) continue // 纯删除，没有新增行
    ranges.push([start, start + count - 1])
  }
  return ranges
}

function inRanges(line, ranges) {
  if (ranges === null) return true
  return ranges.some(([start, end]) => line >= start && line <= end)
}

async function main() {
  const { ref: base, label } = resolveBase()

  const tracked = changedTrackedFiles(base)
  const untracked = untrackedFiles()
  const all = [...new Set([...tracked, ...untracked])].filter((file) => existsSync(file))

  if (all.length === 0) {
    console.log(`✓ lint:changed — 相对 ${label} 没有需要检查的改动。`)
    return
  }

  const eslint = new ESLint({ cache: false })

  // eslint.config.mjs 里 ignore 掉的目录（dist/out/coverage…）直接跳过
  const targets = []
  for (const file of all) {
    if (await eslint.isPathIgnored(file)) continue
    targets.push(file)
  }

  if (targets.length === 0) {
    console.log(`✓ lint:changed — 改动的文件都在 ESLint ignore 列表里，无需检查。`)
    return
  }

  console.log(`lint:changed — 相对 ${label} 检查 ${targets.length} 个文件的改动行…`)

  const results = await eslint.lintFiles(targets)

  let errorCount = 0
  let warningCount = 0
  let fixableCount = 0
  const report = []
  /** 真正报出问题的文件，用来给出精确的修复命令（而不是把所有改动文件都列一遍） */
  const offenders = []

  for (const result of results) {
    const relative = path.relative(process.cwd(), result.filePath).replace(/\\/g, '/')
    const isUntracked = untracked.includes(relative)
    const ranges = isUntracked ? null : changedLineRanges(base, relative)

    const relevant = result.messages.filter((msg) => inRanges(msg.line ?? 0, ranges))
    if (relevant.length === 0) continue

    offenders.push(relative)
    const lines = [`\n  ${relative}`]
    for (const msg of relevant) {
      const level = msg.severity === 2 ? 'error  ' : 'warning'
      if (msg.severity === 2) errorCount++
      else warningCount++
      if (msg.fix) fixableCount++
      lines.push(`    ${msg.line}:${msg.column}  ${level}  ${msg.message}  ${msg.ruleId ?? ''}`)
    }
    report.push(lines.join('\n'))
  }

  if (report.length > 0) console.log(report.join('\n'))

  if (errorCount === 0) {
    const suffix = warningCount > 0 ? `（${warningCount} 个 warning 不阻塞，但建议一起修掉）` : ''
    console.log(`\n✓ lint:changed 通过${suffix}`)
    return
  }

  console.error(`\n✖ lint:changed 失败：改动的行上有 ${errorCount} 个 error。`)
  console.error('\n怎么修：')
  if (fixableCount > 0) {
    console.error(`  1. 先自动修（可修 ${fixableCount} 处）：`)
    console.error(`     npx eslint --fix ${offenders.join(' ')}`)
    console.error('  2. 再跑 pnpm format 统一格式，剩下的按上面的提示手动改。')
  } else {
    console.error('  按上面每一条的 ruleId 手动修改。常见两类：')
    console.error('    · explicit-function-return-type → 给函数补上返回类型，如 `(): void`')
    console.error('    · no-unused-vars → 删掉没用到的变量，或改名为 `_xxx`')
  }
  console.error('\n注意：只有你**改动的行**会被检查，报出来的都是你这次写的代码。')
  process.exit(1)
}

main().catch((error) => {
  console.error('✖ lint:changed 执行异常：', error)
  process.exit(1)
})
