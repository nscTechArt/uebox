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
 * 改动范围走 verify-change-scope.mjs，和 verify:plugin 是同一份实现。
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { resolveChangeScope } from './verify-change-scope.mjs'

/** vitest 的 related 只认源码和测试文件 */
const RELEVANT = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|vue)$/

/**
 * 把脚本复制到临时目录再用子进程跑的测试。import 分析看不到它们和脚本的关系，
 * 只能在这里登记 —— 新写这类测试、或给它多复制一个脚本时，要同步这张表。
 * 测试文件直接 import 的脚本不用登记，vitest 自己算得出来。
 */
const SPAWNED_SCRIPT_TESTS = new Map([
  [
    'scripts/plugin-check.mjs',
    ['tests/unit/plugin-commands.test.ts', 'tests/unit/verify-plugin.test.ts']
  ],
  ['scripts/verify.mjs', ['tests/unit/plugin-commands.test.ts']],
  ['tests/support/plugin-release-operations.mts', ['tests/unit/plugin-commands.test.ts']]
])

let scope
try {
  scope = resolveChangeScope()
} catch (error) {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const extraTests = scope.paths.flatMap((file) => SPAWNED_SCRIPT_TESTS.get(file) ?? [])
const targets = [...new Set([...scope.paths.filter((file) => RELEVANT.test(file)), ...extraTests])]

if (targets.length === 0) {
  console.log(`相关单测 — 相对 ${scope.label} 没有改动任何源码，跳过。`)
  process.exit(0)
}

console.log(`相关单测 — 相对 ${scope.label} 有 ${scope.paths.length} 个文件改动，跑与之相关的测试…`)

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
  [vitestBin, 'related', '--run', '--passWithNoTests', ...targets],
  { stdio: 'inherit' }
)

process.exit(result.status ?? 1)
