#!/usr/bin/env node
/**
 * 全量 lint 棘轮门禁。
 *
 * ## 为什么不是「lint 全绿」
 *
 * 这个仓库有十万行存量代码，一次全量 lint 报出七千多条问题。要求归零是不现实的：
 * 唯一的结果是有人把 `lint` 的检查范围缩到十几个文件，让门禁看上去是绿的 ——
 * 那样这道门禁等于不存在，而且比没有门禁更糟，因为它是**假的**。
 *
 * 所以这里换一种做法：**范围是全量的，标准是棘轮的**。
 * 记一份逐文件的存量基线，只保证不再新增；每清理一批就把基线调小，单向收紧。
 * 于是「`pnpm lint` 检查了多少文件」这个问题有了诚实的答案：全部。
 *
 * ## 棘轮只能往一个方向转
 *
 * `--update` **只接受变小**。想让基线变大会被直接拒绝 —— 否则任何卡在这道门禁上的人
 * （尤其是 AI Agent）最省事的做法就是跑一下 --update 把红灯刷成绿灯。
 *
 * 变少也会让门禁变红，提示你跑 --update 收紧基线。这不是找麻烦：
 * 基线不跟着收紧，棘轮就会一点点松掉，几个月后又退化成摆设。
 *
 * ## 和 lint:changed 的分工
 *
 * 这道门禁管**存量不再变差**，`pnpm lint:changed` 管**新代码零容忍**。
 * 两道都得过：你可以不修别人留下的问题，但不能自己写出新的。
 *
 * 用法：
 *   node scripts/check-lint-baseline.mjs           校验
 *   node scripts/check-lint-baseline.mjs --update  收紧基线（仅允许变小）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BASELINE = join(ROOT, 'scripts', 'lint.baseline.json')

/** 全量范围。忽略规则统一在 eslint.config.mjs 的 ignores 里，不在这里维护第二份。 */
const TARGETS = [
  'src',
  'tests',
  'scripts',
  'electron.vite.config.ts',
  'vitest.config.ts',
  'eslint.config.mjs'
]

/** 统一成正斜杠，免得基线在 Windows 与 CI 之间来回变动 */
function toKey(absolutePath) {
  return relative(ROOT, absolutePath).split(sep).join('/')
}

async function collect() {
  // 不用 --cache：棘轮的数字必须是当下真实的全量结果。
  // 缓存一旦和实际状态脱节（换分支、改 eslint.config.mjs、另一个进程写过 .eslintcache），
  // 报出来的数会**偏小**，于是门禁在存量变差时照样绿 —— 那正是这道门禁要防的事。
  const eslint = new ESLint({ cache: false, cwd: ROOT })
  const results = await eslint.lintFiles(TARGETS)

  const counts = {}
  for (const result of results) {
    if (result.errorCount === 0 && result.warningCount === 0) continue
    counts[toKey(result.filePath)] = {
      errors: result.errorCount,
      warnings: result.warningCount
    }
  }

  // 键排序，让基线文件的 diff 只反映真实变化
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

/** 读基线；读不到返回 null（首次 bootstrap 用） */
function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf-8'))
  } catch {
    return null
  }
}

const EMPTY = { errors: 0, warnings: 0 }

function totals(counts) {
  return Object.values(counts).reduce(
    (sum, entry) => ({
      errors: sum.errors + entry.errors,
      warnings: sum.warnings + entry.warnings
    }),
    { ...EMPTY }
  )
}

function describe(counts) {
  const { errors, warnings } = totals(counts)
  return `${Object.keys(counts).length} 个文件 / ${errors} errors / ${warnings} warnings`
}

/** 逐文件比对，返回「比 allowed 更差」的清单 */
function findGrown(current, allowed) {
  const grown = []
  for (const [file, count] of Object.entries(current)) {
    const budget = allowed[file] ?? EMPTY
    if (count.errors > budget.errors) {
      grown.push(`${file}: errors ${budget.errors} → ${count.errors}`)
    }
    if (count.warnings > budget.warnings) {
      grown.push(`${file}: warnings ${budget.warnings} → ${count.warnings}`)
    }
  }
  return grown
}

/** 逐文件比对，返回「比 baseline 更好」的清单 */
function findShrunk(current, baseline) {
  const shrunk = []
  for (const [file, budget] of Object.entries(baseline)) {
    const count = current[file] ?? EMPTY
    if (count.errors < budget.errors) {
      shrunk.push(`${file}: errors ${budget.errors} → ${count.errors}`)
    }
    if (count.warnings < budget.warnings) {
      shrunk.push(`${file}: warnings ${budget.warnings} → ${count.warnings}`)
    }
  }
  return shrunk
}

const current = await collect()

if (process.argv.includes('--update')) {
  const previous = readBaseline()

  if (previous === null) {
    // 首次落地：还没有基线可比，直接写入
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, 'utf-8')
    console.log(`已建立初始基线：${describe(current)}。`)
    process.exit(0)
  }

  const grown = findGrown(current, previous)
  if (grown.length > 0) {
    console.error('✖ 拒绝写入基线：棘轮只能收紧，不能放松。\n')
    for (const line of grown.slice(0, 20)) console.error(`  · ${line}`)
    if (grown.length > 20) console.error(`  · …还有 ${grown.length - 20} 条`)
    console.error(
      '\n--update 的用途是「清理了一批存量问题之后，把基线调小」，' +
        '\n不是「写出了新的 lint 问题之后，把基线调大让门禁变绿」。' +
        '\n\n先把上面这些文件里新增的问题修掉：npx eslint --fix <文件路径>'
    )
    process.exit(1)
  }

  const before = totals(previous)
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, 'utf-8')
  const after = totals(current)
  console.log(
    `基线已收紧：errors ${before.errors} → ${after.errors}，` +
      `warnings ${before.warnings} → ${after.warnings}。`
  )
  process.exit(0)
}

const baseline = readBaseline()
if (baseline === null) {
  console.error(`读不到基线文件 ${relative(ROOT, BASELINE)}。首次使用请先跑 --update。`)
  process.exit(1)
}

const grown = findGrown(current, baseline)
if (grown.length > 0) {
  console.error('✖ 全量 lint 棘轮未通过：存量问题变多了。\n')
  for (const line of grown.slice(0, 20)) console.error(`  · ${line}`)
  if (grown.length > 20) console.error(`  · …还有 ${grown.length - 20} 条`)
  console.error(
    '\n这些文件里新增了 lint 问题。先看具体是什么：' +
      '\n  npx eslint <文件路径>' +
      '\n能自动修的：' +
      '\n  npx eslint --fix <文件路径>' +
      '\n\n注意：基线只准变小。不要为了让门禁变绿去跑 --update。'
  )
  process.exit(1)
}

const shrunk = findShrunk(current, baseline)
if (shrunk.length > 0) {
  console.error(`✖ 有 ${shrunk.length} 处存量问题变少了，请收紧基线：\n`)
  for (const line of shrunk.slice(0, 20)) console.error(`  · ${line}`)
  if (shrunk.length > 20) console.error(`  · …还有 ${shrunk.length - 20} 条`)
  console.error('\n跑这条命令，然后把改动的 scripts/lint.baseline.json 一起提交：')
  console.error('  pnpm lint:baseline:update')
  process.exit(1)
}

console.log(`全量 lint 棘轮通过（${describe(current)}，均在基线内）。`)
