#!/usr/bin/env node
/**
 * 双语文档同步守卫 / Bilingual docs sync guard.
 *
 * 仓库里几份关键文档有中英两份。双份最容易出的问题不是翻译质量，而是**脱节**：
 * 有人改了英文版，中文版还停在三个月前，于是中文用户和他的 Agent 按错的规范干活。
 *
 * 这个脚本只做两件很笨但很有效的事：
 *   1. 成对的文件必须都存在；
 *   2. 一次改动里如果动了其中一份，另一份也必须一起动。
 *
 * 它不检查翻译是否准确 —— 那是 review 的事。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** 必须成对维护的文档 */
const PAIRS = [
  ['AGENTS.md', 'AGENTS.zh-CN.md'],
  ['CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md'],
  ['docs/contributing/vibe-coding.md', 'docs/contributing/vibe-coding.zh-CN.md'],
  ['docs/contributing/definition-of-done.md', 'docs/contributing/definition-of-done.zh-CN.md'],
  ['README.md', 'README.en.md']
]

/**
 * 故意只有单语版本的文档，列在这里是为了让后来的人知道「这不是漏了」。
 * 双语是维护成本，不是越多越好 —— 只有面向所有贡献者的入口文档才值得双份。
 *
 *   docs/contributing/vertical-slice.md  中文正文 + 英文 TL;DR
 *   docs/contributing/testing.md         中文正文 + 英文 TL;DR
 */

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function revExists(ref) {
  return git(['rev-parse', '--verify', '--quiet', ref]) !== null
}

function resolveBase() {
  const explicit = String(process.env.VERIFY_BASE || '').trim()
  const candidates = explicit ? [explicit] : ['origin/main', 'main']
  for (const candidate of candidates) {
    if (!revExists(candidate)) continue
    const mergeBase = git(['merge-base', 'HEAD', candidate])
    return (mergeBase || candidate).trim()
  }
  return 'HEAD'
}

const problems = []

// 1. 成对存在
for (const [en, zh] of PAIRS) {
  for (const file of [en, zh]) {
    if (!existsSync(file)) {
      problems.push(`缺少文件：${file}（它与 ${file === en ? zh : en} 必须成对存在）`)
    }
  }
}

// 2. 成对改动
const base = resolveBase()
const changed = new Set(
  [
    ...(git(['diff', '--name-only', base]) || '').split('\n'),
    // 还没 git add 的新文件也算「改动过」，否则只新增了一侧时检测不到
    ...(git(['ls-files', '--others', '--exclude-standard']) || '').split('\n')
  ]
    .map((line) => line.trim())
    .filter(Boolean)
)

for (const [en, zh] of PAIRS) {
  const enChanged = changed.has(en)
  const zhChanged = changed.has(zh)
  if (enChanged !== zhChanged) {
    const touched = enChanged ? en : zh
    const missed = enChanged ? zh : en
    problems.push(`改了 ${touched} 但没改 ${missed} —— 两份必须同步更新。`)
  }
}

if (problems.length === 0) {
  console.log('✓ docs:check — 双语文档成对且同步。')
  process.exit(0)
}

console.error('✖ docs:check 失败：\n')
for (const problem of problems) console.error(`  · ${problem}`)
console.error(
  '\n为什么卡这一步：中英文档脱节会让另一半贡献者（和他们的 Agent）照着过期的规范干活。'
)
console.error(
  '如果这次确实只需要改一侧（比如只修了英文的拼写），也请在另一侧做等价改动或补一句说明。'
)
process.exit(1)
