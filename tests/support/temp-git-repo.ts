import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function git(cwd: string, args: string[], options: { input?: string } = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    input: options.input
  }).trim()
}

export function initTempGitRepo(
  tracker: string[],
  prefix: string,
  identity = { email: 'test@example.test', name: 'Test' }
): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tracker.push(root)
  try {
    git(root, ['init', '-b', 'main'])
  } catch {
    git(root, ['init'])
  }
  git(root, ['config', 'user.email', identity.email])
  git(root, ['config', 'user.name', identity.name])
  git(root, ['config', 'core.autocrlf', 'false'])
  return root
}

export function writeRepoFile(root: string, relative: string, content: string): void {
  const full = join(root, relative)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

export function commitAll(root: string, message: string): string {
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

export function removeTempRepos(tracker: string[]): void {
  while (tracker.length > 0) {
    const dir = tracker.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}
