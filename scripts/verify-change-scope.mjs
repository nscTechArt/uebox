/**
 * 这次改动碰了哪些路径 —— verify:plugin 和相关单测共用这一份。
 *
 * 比较基准：VERIFY_BASE → origin/main → main → HEAD，取与 HEAD 的 merge-base。
 * 路径是「索引 vs 基准」与「工作区 vs 基准」的并集，再加未跟踪文件，所以
 * 已提交、已暂存、未暂存都算，暂存后又在工作区改回去的也算（那份改动会被提交）。
 * `--no-renames` 让改名同时列出新旧两侧；冲突中的文件也在里面。
 *
 * VERIFY_BASE 无效、git 跑不起来都直接报错 —— 范围算不出来不能当成「没改东西」。
 */
import { spawnSync } from 'node:child_process'

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw new Error(`Git failed: ${result.error.message}`)
  return result
}

function gitOutput(cwd, args) {
  const result = git(cwd, args)
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Git command failed: git ${args.join(' ')}`)
  }
  return result.stdout
}

function resolveBase(cwd, env) {
  const explicit = String(env.VERIFY_BASE || '').trim()
  for (const ref of explicit ? [explicit] : ['origin/main', 'main']) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', ref]).status !== 0) continue
    return { base: gitOutput(cwd, ['merge-base', 'HEAD', ref]).trim(), label: ref }
  }
  if (explicit) throw new Error(`VERIFY_BASE=${explicit} 不是一个有效的 git ref。`)
  return { base: gitOutput(cwd, ['rev-parse', 'HEAD']).trim(), label: 'HEAD（仅未提交的改动）' }
}

export function resolveChangeScope({ cwd = process.cwd(), env = process.env } = {}) {
  const { base, label } = resolveBase(cwd, env)
  const list = (args) => gitOutput(cwd, args).split('\0').filter(Boolean)
  const paths = new Set([
    ...list(['diff', '-z', '--name-only', '--no-renames', '--cached', base]),
    ...list(['diff', '-z', '--name-only', '--no-renames', base]),
    ...list(['ls-files', '-z', '--others', '--exclude-standard'])
  ])
  return { paths: [...paths], base, label }
}
