#!/usr/bin/env node
/**
 * 只对改动涉及的那一侧做类型检查 / Typecheck only the side you touched.
 *
 * 仓库有两个 TS 工程：主进程（`typecheck:node`，13 秒）和渲染层
 * （`typecheck:web`，走 vue-tsc，25 秒）。改主进程的时候没有理由等 vue-tsc 跑完，
 * 反过来也是。
 *
 * 只给 `pnpm verify:changed` 用。完整门禁照旧两侧都跑 —— 两个工程之间有共享
 * 类型（`src/shared`、`src/preload/index.d.ts`），只查一侧漏得掉跨侧的破坏，
 * 所以这是「迭代中途的快照」，不是替代品。
 */
import { execFileSync, spawnSync } from 'node:child_process'

const isWindows = process.platform === 'win32'

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
    return (git(['merge-base', 'HEAD', candidate]) || candidate).trim()
  }
  return 'HEAD'
}

function changedFiles(base) {
  const tracked = (git(['diff', '--name-only', '--diff-filter=ACMR', base]) || '').split('\n')
  const untracked = (git(['ls-files', '--others', '--exclude-standard']) || '').split('\n')
  return [...new Set([...tracked, ...untracked])].map((file) => file.trim()).filter(Boolean)
}

const files = changedFiles(resolveBase())

/**
 * 共享的那几处两侧都要查。
 *
 * `src/shared/**` 和 preload 的类型声明是两个工程的接缝 —— 改了它只查一侧，
 * 恰恰漏掉最容易坏的那种：主进程改了 IPC 的形状，渲染层还照旧写。
 */
const touchesShared = files.some(
  (file) => file.startsWith('src/shared/') || file.startsWith('src/preload/')
)
const touchesNode = touchesShared || files.some((file) => file.startsWith('src/main/'))
const touchesWeb = touchesShared || files.some((file) => file.startsWith('src/renderer/'))
// CLI 是第三个 TS 工程，另外两份 tsconfig 的 include 都够不着它（见 tsconfig.cli.json）
const touchesCli = files.some((file) => file.startsWith('packages/cli/'))

// 什么都没改（或只改了文档/脚本）时，三侧都跑一遍最省心 —— 这一步本来就不贵
const targets =
  touchesNode || touchesWeb || touchesCli
    ? [
        touchesNode && 'typecheck:node',
        touchesWeb && 'typecheck:web',
        touchesCli && 'typecheck:cli'
      ].filter(Boolean)
    : ['typecheck:node', 'typecheck:web', 'typecheck:cli']

console.log(`类型检查（按改动挑）：${targets.join(' + ')}`)

for (const target of targets) {
  const result = spawnSync('pnpm', ['-s', 'run', target], { stdio: 'inherit', shell: isWindows })
  const code = typeof result.status === 'number' ? result.status : 1
  if (code !== 0) process.exit(code)
}
