// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- The package-format module has no TypeScript declaration.
import { sourceFingerprint } from '../../scripts/plugin-package-format.mjs'
// @ts-expect-error -- The standalone verify script has no TypeScript declaration.
import { runVerifyPlugin } from '../../scripts/verify-plugin.mjs'
import {
  copyPluginScripts,
  fixtureEnv,
  linkNodeModules,
  writeStampZip
} from '../support/plugin-fixture'
import {
  commitAll,
  initTempGitRepo,
  removeTempRepos,
  writeRepoFile
} from '../support/temp-git-repo'

const PLUGIN_SOURCE = 'plugin/UnrealAgentLink/Source/Foo.cpp'
const repos: string[] = []

afterEach(() => removeTempRepos(repos))

/** 一个已提交的仓库，工作区里改了 changedPath */
function repoWithChange(changedPath: string): { root: string; base: string } {
  const root = initTempGitRepo(repos, 'ual-verify-plugin-')
  writeRepoFile(root, changedPath, 'base')
  const base = commitAll(root, 'base')
  writeRepoFile(root, changedPath, 'changed')
  return { root, base }
}

interface RunOptions {
  argv?: string[]
  env?: Record<string, string>
  engines?: string[]
  inspection?: { status: number; output: string }
}

function run(
  root: string,
  base: string,
  {
    argv = [],
    env = {},
    engines = [],
    inspection = { status: 0, output: 'inspected' }
  }: RunOptions = {}
): { status: number; output: string; inspected: string[] } {
  const inspected: string[] = []
  const result = runVerifyPlugin({
    argv,
    env: { VERIFY_BASE: base, ...env },
    cwd: root,
    inspect: (engine: string) => {
      inspected.push(engine)
      return inspection
    },
    detectEngines: () => engines
  })
  return { ...result, inspected }
}

describe('verify:plugin', () => {
  it.each(['docs/guide.md', 'scripts/build-plugin.mjs', 'plugin/UnrealAgentLink/LICENSE'])(
    'is not applicable when only %s changed, even with an invalid target',
    (path) => {
      const { root, base } = repoWithChange(path)
      const outcome = run(root, base, { env: { VERIFY_PLUGIN_ENGINE: 'not-a-version' } })
      expect(outcome.status).toBe(0)
      expect(outcome.inspected).toEqual([])
      expect(outcome.output).toContain('not applicable')
    }
  )

  it('fails a packaged-input change when no target is selected', () => {
    const { root, base } = repoWithChange(PLUGIN_SOURCE)
    const outcome = run(root, base)
    expect(outcome.status).toBe(1)
    expect(outcome.inspected).toEqual([])
    expect(outcome.output).toContain(PLUGIN_SOURCE)
    expect(outcome.output).toContain('VERIFY_PLUGIN_ENGINE')
  })

  it('names the comparison base on failure and hints at a stale fork', () => {
    const { root, base } = repoWithChange(PLUGIN_SOURCE)
    const failed = run(root, base)
    expect(failed.output).toContain(`vs ${base}`)
    expect(failed.output).toContain('VERIFY_BASE=<target branch>')

    const passed = run(root, base, { env: { VERIFY_PLUGIN_ENGINE: '5.7' } })
    expect(passed.status).toBe(0)
    expect(passed.output).not.toContain('VERIFY_BASE=<target branch>')
  })

  it('names an unsupported VERIFY_PLUGIN_ENGINE value', () => {
    const { root, base } = repoWithChange(PLUGIN_SOURCE)
    const outcome = run(root, base, { env: { VERIFY_PLUGIN_ENGINE: '9.9' } })
    expect(outcome.status).toBe(1)
    expect(outcome.output).toContain("'9.9'")
    expect(outcome.inspected).toEqual([])
  })

  it('inspects the --engine target over VERIFY_PLUGIN_ENGINE and keeps its exit status', () => {
    const { root, base } = repoWithChange(PLUGIN_SOURCE)
    const passed = run(root, base, {
      argv: ['--engine', '5.7'],
      env: { VERIFY_PLUGIN_ENGINE: '5.5' }
    })
    expect(passed.status).toBe(0)
    expect(passed.inspected).toEqual(['5.7'])
    expect(passed.output).toContain('Plugin package check: passed (UE 5.7)')
    expect(passed.output).toContain('Native build/runtime: NOT RUN')

    const failed = run(root, base, {
      env: { VERIFY_PLUGIN_ENGINE: '5.7' },
      inspection: { status: 2, output: 'stale package' }
    })
    expect(failed.status).toBe(2)
    expect(failed.output).toContain('stale package')
    expect(failed.output).toContain('Plugin package check: failed (UE 5.7)')
  })

  it('reports NOT RUN and passes when none is declared and no engine is installed', () => {
    const { root, base } = repoWithChange(PLUGIN_SOURCE)
    const outcome = run(root, base, { env: { VERIFY_PLUGIN_ENGINE: 'none' } })
    expect(outcome.status).toBe(0)
    expect(outcome.inspected).toEqual([])
    expect(outcome.output).toContain(PLUGIN_SOURCE)
    expect(outcome.output).toContain('NOT RUN (declared: no Unreal on this machine)')
  })

  it('rejects none when a supported engine is installed', () => {
    const { root, base } = repoWithChange(PLUGIN_SOURCE)
    const outcome = run(root, base, { argv: ['--engine', 'none'], engines: ['5.5', '5.7'] })
    expect(outcome.status).toBe(1)
    expect(outcome.inspected).toEqual([])
    expect(outcome.output).toContain('5.5、5.7')
    expect(outcome.output).toContain('pnpm plugin:build --engine 5.7')
  })

  it('rejects unknown options and unsupported --engine values before resolving scope', () => {
    const { root } = repoWithChange('docs/guide.md')
    for (const argv of [['--unknown'], ['--engine'], ['--engine', '5.9'], ['--ci']]) {
      expect(run(root, 'no-such-ref', { argv }).status, argv.join(' ')).toBe(1)
    }
  })

  it('fails when the change scope cannot be resolved', () => {
    const { root } = repoWithChange(PLUGIN_SOURCE)
    const outcome = run(root, 'no-such-ref', { env: { VERIFY_PLUGIN_ENGINE: '5.7' } })
    expect(outcome.status).toBe(1)
    expect(outcome.output).toContain('VERIFY_BASE')
  })
})

/** 真正起一次子进程：verify-plugin → plugin-check 的连线，和所选包的真实检查。 */
describe('verify:plugin command', () => {
  function setupFixture(): string {
    const root = initTempGitRepo(repos, 'ual-verify-plugin-cmd-')
    writeRepoFile(root, 'plugin/UnrealAgentLink/UnrealAgentLink.uplugin', '{"VersionName":"1.0.0"}')
    writeRepoFile(root, PLUGIN_SOURCE, 'base')
    writeRepoFile(root, '.gitignore', 'node_modules\nresources/plugins\n')
    copyPluginScripts(root, [
      'build-plugin.mjs',
      'plugin-check.mjs',
      'plugin-package-format.mjs',
      'plugin-platform.mjs',
      'verify-change-scope.mjs',
      'verify-plugin.mjs'
    ])
    commitAll(root, 'base')
    linkNodeModules(root)
    mkdirSync(join(root, 'resources/plugins'), { recursive: true })
    writeFileSync(join(root, PLUGIN_SOURCE), 'changed')
    return root
  }

  function runCommand(root: string): { status: number | null; output: string } {
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/verify-plugin.mjs'), '--engine', '5.7'],
      { cwd: root, encoding: 'utf8', env: fixtureEnv({ VERIFY_BASE: 'HEAD' }) }
    )
    return { status: result.status, output: result.stdout + result.stderr }
  }

  it.each([
    { kind: 'fresh', status: 0 },
    { kind: 'stale', status: 1 },
    { kind: 'missing', status: 1 }
  ])('checks the selected package when it is $kind', ({ kind, status }) => {
    const root = setupFixture()
    const fingerprint = sourceFingerprint(join(root, 'plugin/UnrealAgentLink'))
    if (kind !== 'missing') {
      writeStampZip(join(root, 'resources/plugins'), 'UnrealAgentLink57.zip', {
        fingerprint: kind === 'fresh' ? fingerprint : 'old',
        engine: '5.7'
      })
    }
    const result = runCommand(root)
    expect(result.status, result.output).toBe(status)
    expect(result.output).toContain('UnrealAgentLink57.zip')
    expect(result.output).toContain(
      `Plugin package check: ${status === 0 ? 'passed' : 'failed'} (UE 5.7)`
    )
  })
})
