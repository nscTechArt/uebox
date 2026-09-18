#!/usr/bin/env node
/**
 * 只跑和改动有关的单测 / Run only the tests related to what changed.
 *
 * 全量单测的时间几乎不花在「跑测试」上：实测 126 秒里，真正执行只有 43 秒，
 * 其余 80 多秒是模块加载和环境准备（386 个测试文件，每个都要建一遍环境）。
 * 而改一两个模块时，真正相关的往往只有三五个文件 —— 那是 1~2 秒的事。
 *
 * 所以迭代中途用这个，交活前再跑一次 `pnpm verify` 的全量。
 * 它**不是**全量的替代品：改动的间接影响面（谁 import 了谁的谁）vitest 能算出
 * 一层，但跨包的运行时耦合算不出来。
 *
 * 用法：
 *   node scripts/test-related.mjs            # 对比默认 base
 *   VERIFY_BASE=origin/main node scripts/test-related.mjs
 *
 * base 解析和 lint-changed.mjs 完全一致：$VERIFY_BASE → origin/main → main → HEAD。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

/** vitest 的 related 只认源码和测试文件 */
const RELEVANT = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|vue)$/

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
    return { ref: (mergeBase || candidate).trim(), label: candidate }
  }

  if (explicit) {
    console.error(`✖ VERIFY_BASE=${explicit} 不是一个有效的 git ref。`)
    process.exit(1)
  }
  return { ref: 'HEAD', label: 'HEAD（仅未提交的改动）' }
}

function changedFiles(base) {
  const tracked = (git(['diff', '--name-status', '--diff-filter=ACMR', base]) || '')
    .split('\n')
    .filter((line) => line.trim())
    // 重命名是 "R100\told\tnew"，取最后一段就是当前路径
    .map((line) => line.split('\t').pop())

  const untracked = (git(['ls-files', '--others', '--exclude-standard']) || '').split('\n')

  return [...new Set([...tracked, ...untracked])]
    .map((file) => (file || '').trim())
    .filter((file) => file && RELEVANT.test(file))
}

const base = resolveBase()
const files = changedFiles(base.ref)

if (files.length === 0) {
  console.log(`相关单测 — 相对 ${base.label} 没有改动任何源码，跳过。`)
  process.exit(0)
}

console.log(`相关单测 — 相对 ${base.label} 有 ${files.length} 个文件改动，跑与之相关的测试…`)

/**
 * `--run` 必须显式给：`vitest related` 默认进 watch 模式，在门禁里会挂住不退。
 *
 * `--passWithNoTests`：改的可能是一个还没有测试的模块（比如纯配置），
 * 那不该让这一步变红 —— 全量门禁里的「新功能必须有测试」是另一条规则，
 * 由 review 和 `pnpm verify` 把关。
 */
const vitestBin = resolve('node_modules', 'vitest', 'vitest.mjs')

// 直接跑 vitest 的入口，不经 npx：Windows 上 spawnSync 拿 `npx.cmd` 需要 shell，
// 而带 shell 又要给 77 个文件名逐个加引号 —— 直接调入口省掉整件事
const result = spawnSync(
  process.execPath,
  [vitestBin, 'related', '--run', '--passWithNoTests', ...files],
  { stdio: 'inherit' }
)

process.exit(result.status ?? 1)
