// @vitest-environment node
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveChangeScope } from '../../scripts/verify-change-scope.mjs'
import {
  commitAll,
  git,
  initTempGitRepo,
  removeTempRepos,
  writeRepoFile
} from '../support/temp-git-repo'

const repos: string[] = []

afterEach(() => {
  removeTempRepos(repos)
})

function initRepo(): string {
  return initTempGitRepo(repos, 'ual-scope-', {
    email: 'scope@example.test',
    name: 'Scope Test'
  })
}

const write = writeRepoFile
const commit = commitAll

function scope(root: string, env: Record<string, string> = {}): string[] {
  return resolveChangeScope({ cwd: root, env }).paths
}

describe('local change scope', () => {
  it('unions committed, staged, unstaged, and untracked paths including Chinese and spaces', () => {
    const root = initRepo()
    write(root, 'docs/base.md', 'base')
    write(root, 'plugin/UnrealAgentLink/Source/kept.cpp', 'kept')
    const base = commit(root, 'base')
    write(root, 'plugin/UnrealAgentLink/Source/committed.cpp', 'committed')
    commit(root, 'committed plugin file')
    write(root, 'plugin/UnrealAgentLink/Source/staged.cpp', 'staged')
    git(root, ['add', 'plugin/UnrealAgentLink/Source/staged.cpp'])
    write(root, 'plugin/UnrealAgentLink/Source/kept.cpp', 'unstaged edit')
    write(root, 'plugin/UnrealAgentLink/Resources/中文 空格.md', 'resource')

    expect(scope(root, { VERIFY_BASE: base }).sort()).toEqual(
      [
        'plugin/UnrealAgentLink/Resources/中文 空格.md',
        'plugin/UnrealAgentLink/Source/committed.cpp',
        'plugin/UnrealAgentLink/Source/kept.cpp',
        'plugin/UnrealAgentLink/Source/staged.cpp'
      ].sort()
    )
  })

  it('retains a staged plugin change whose worktree copy was reverted to HEAD', () => {
    const root = initRepo()
    write(root, 'plugin/UnrealAgentLink/Source/Foo.cpp', 'original')
    const base = commit(root, 'base')
    write(root, 'plugin/UnrealAgentLink/Source/Foo.cpp', 'changed')
    git(root, ['add', 'plugin/UnrealAgentLink/Source/Foo.cpp'])
    git(root, ['restore', '--source=HEAD', '--worktree', 'plugin/UnrealAgentLink/Source/Foo.cpp'])

    expect(git(root, ['diff', '--name-status', 'HEAD'])).toBe('')
    expect(scope(root, { VERIFY_BASE: base })).toContain('plugin/UnrealAgentLink/Source/Foo.cpp')
  })

  it('keeps deletions and both sides of a rename out of the plugin tree', () => {
    const root = initRepo()
    write(root, 'plugin/UnrealAgentLink/Source/Foo.cpp', 'src')
    write(root, 'plugin/UnrealAgentLink/LICENSE', 'license')
    const base = commit(root, 'base')
    git(root, ['rm', 'plugin/UnrealAgentLink/LICENSE'])
    mkdirSync(join(root, 'docs'), { recursive: true })
    git(root, ['mv', 'plugin/UnrealAgentLink/Source/Foo.cpp', 'docs/Foo.cpp'])

    expect(scope(root, { VERIFY_BASE: base })).toEqual(
      expect.arrayContaining([
        'plugin/UnrealAgentLink/LICENSE',
        'plugin/UnrealAgentLink/Source/Foo.cpp',
        'docs/Foo.cpp'
      ])
    )
  })

  it('includes a path in an unresolved merge conflict', () => {
    const root = initRepo()
    write(root, 'plugin/UnrealAgentLink/Source/Foo.cpp', 'base')
    commit(root, 'base')
    git(root, ['branch', '-M', 'main'])
    git(root, ['checkout', '-b', 'other'])
    write(root, 'plugin/UnrealAgentLink/Source/Foo.cpp', 'other')
    commit(root, 'other')
    git(root, ['checkout', 'main'])
    write(root, 'plugin/UnrealAgentLink/Source/Foo.cpp', 'main')
    commit(root, 'main')
    try {
      git(root, ['merge', 'other'])
    } catch {
      // expected conflict
    }

    expect(scope(root, { VERIFY_BASE: 'HEAD' })).toContain('plugin/UnrealAgentLink/Source/Foo.cpp')
  })

  it('uses merge-base against origin/main when VERIFY_BASE is unset', () => {
    const root = initRepo()
    write(root, 'docs/base.md', 'base')
    commit(root, 'main base')
    git(root, ['branch', '-M', 'main'])
    const fork = git(root, ['rev-parse', 'HEAD'])
    git(root, ['update-ref', 'refs/remotes/origin/main', fork])
    git(root, ['checkout', '-b', 'topic'])
    write(root, 'docs/topic.md', 'topic')
    commit(root, 'topic commit')
    git(root, ['checkout', 'main'])
    write(root, 'docs/main-only.md', 'main')
    commit(root, 'main moved')
    git(root, ['checkout', 'topic'])

    const resolved = resolveChangeScope({ cwd: root, env: {} })
    expect(resolved.base).toBe(fork)
    expect(resolved.label).toBe('origin/main')
    expect(resolved.paths).toContain('docs/topic.md')
    expect(resolved.paths).not.toContain('docs/main-only.md')
  })

  it('reports nothing for a clean checkout', () => {
    const root = initRepo()
    write(root, 'docs/base.md', 'base')
    commit(root, 'base')
    expect(scope(root, { VERIFY_BASE: 'HEAD' })).toEqual([])
  })

  it('fails on an invalid explicit VERIFY_BASE', () => {
    const root = initRepo()
    write(root, 'docs/base.md', 'base')
    commit(root, 'base')
    expect(() => scope(root, { VERIFY_BASE: 'not-a-ref' })).toThrow(/VERIFY_BASE/)
  })

  it('fails when git cannot run in the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ual-not-git-'))
    repos.push(dir)
    expect(() => scope(dir, {})).toThrow()
  })
})
