// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- The package-format module has no TypeScript declaration.
import { sourceFingerprint } from '../../scripts/plugin-package-format.mjs'
import {
  copyPluginScripts,
  fixtureEnv,
  linkNodeModules,
  readOperations,
  writeStampZip
} from '../support/plugin-fixture'

interface ScriptOptions {
  target?: string
  platform?: string
}

interface ScriptResult {
  status: number | null
  output: string
}

const packageScripts = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).scripts

let root: string
let dist: string
let fingerprint: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ual-release-test-'))
  dist = join(root, 'resources/plugins')
  mkdirSync(dist, { recursive: true })
  mkdirSync(join(root, 'plugin/UnrealAgentLink'), { recursive: true })
  writeFileSync(
    join(root, 'plugin/UnrealAgentLink/UnrealAgentLink.uplugin'),
    '{"VersionName":"1.0.0"}'
  )
  copyPluginScripts(root, [
    'plugin-check.mjs',
    'plugin-package-format.mjs',
    'plugin-platform.mjs',
    'verify.mjs'
  ])
  linkNodeModules(root)
  fingerprint = sourceFingerprint(join(root, 'plugin/UnrealAgentLink'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function putZip(name: string, stamp: Record<string, string> = {}, entries: string[] = []): void {
  writeStampZip(dist, name, { fingerprint, engine: '5.5', ...stamp }, entries)
}

/** Personal targets and Git scope are set to junk: release checks must not read them. */
function runScript(
  script: string,
  args: string[],
  { target = '5.7', platform = 'win32' }: ScriptOptions = {}
): ScriptResult {
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(join(root, 'operations.mts')).href, join(root, script), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: fixtureEnv({
        VERIFY_PLUGIN_ENGINE: target,
        VERIFY_BASE: 'nonexistent-personal-base',
        PLUGIN_RELEASE_TEST_PLATFORM: platform
      })
    }
  )
  return { status: result.status, output: result.stdout + result.stderr }
}

const RELEASE_PACKAGES = [
  'UnrealAgentLink50.zip',
  'UnrealAgentLink51.zip',
  'UnrealAgentLink52.zip',
  'UnrealAgentLink53.zip',
  'UnrealAgentLink54.zip',
  'UnrealAgentLink55.zip',
  'UnrealAgentLink56.zip',
  'UnrealAgentLink57.zip',
  'UnrealAgentLink58.zip'
]

function putComplete(platform = 'win32'): void {
  RELEASE_PACKAGES.forEach((name, minor) => {
    if (platform === 'darwin') {
      putZip(name.replace('.zip', '-Mac.zip'), { engine: `5.${minor}`, platform: 'Mac' }, [
        'Binaries/Mac/UnrealEditor-UnrealAgentLink.dylib'
      ])
    } else {
      putZip(name, { engine: `5.${minor}` }, ['Binaries/Win64/UnrealEditor-UnrealAgentLink.dll'])
    }
  })
}

function damage(name: string, kind: string): void {
  const path = join(dist, name)
  const zip = new AdmZip(path)
  const stamp = JSON.parse(zip.readAsText('.ual-build'))
  if (kind === 'wrong platform') stamp.platform = 'Win64'
  zip.updateFile('.ual-build', Buffer.from(JSON.stringify(stamp)))
  if (kind === 'missing dylib') zip.deleteFile('Binaries/Mac/UnrealEditor-UnrealAgentLink.dylib')
  if (kind === 'dSYM') zip.addFile('Binaries/Mac/plugin.dSYM/symbols', Buffer.from('debug symbols'))
  zip.writeZip(path)
}

describe('explicit development package command', () => {
  const [, script, ...args] = packageScripts['plugin:check'].split(' ')

  it('inspects the selected Mac package on macOS', () => {
    putZip('UnrealAgentLink57-Mac.zip', { engine: '5.7', platform: 'Mac' }, [
      'Binaries/Mac/UnrealEditor-UnrealAgentLink.dylib'
    ])
    writeFileSync(join(dist, 'UnrealAgentLink57.zip'), 'not a ZIP')
    const result = runScript(script, [...args, '--engine', '5.7'], { platform: 'darwin' })
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('UnrealAgentLink57-Mac.zip')
  })

  it.each(
    [
      [],
      ['--engine'],
      ['--engine', '5.7', '--all'],
      ['--engine', '5.7', '--unknown'],
      ['--engine', '5.7', 'extra'],
      ['--check', '--all'],
      ['--engine', '5.9']
    ].map((selection) => ({ selection }))
  )('rejects invalid check arguments $selection', ({ selection }) => {
    putComplete()
    const result = runScript(script, [...args, ...selection])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('Usage:')
  })

  it('explains explicit selection', () => {
    const result = runScript(script, [...args, '--help'])
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('pnpm plugin:check --engine 5.7')
    expect(result.output).toContain('no default')
  })
})

describe('installer complete-set command', () => {
  // Execute the actual package-script command, replacing only its Node executable.
  const [, script, ...args] = packageScripts['plugin:check:all'].split(' ')

  it.each(['win32', 'darwin'])(
    'requires the complete current set on %s without Unreal',
    (platform) => {
      putZip(
        platform === 'darwin' ? 'UnrealAgentLink55-Mac.zip' : 'UnrealAgentLink55.zip',
        { platform: 'Mac' },
        ['Binaries/Mac/UnrealEditor-UnrealAgentLink.dylib']
      )
      const result = runScript(script, args, { platform })
      expect(result.status, result.output).toBe(1)
      expect(result.output).toContain(
        platform === 'darwin' ? 'UnrealAgentLink58-Mac.zip' : 'UnrealAgentLink58.zip'
      )
    }
  )

  it.each(['win32', 'darwin'])('passes the complete set on %s', (platform) => {
    putComplete(platform)
    const result = runScript(script, args, { platform, target: 'invalid-personal-target' })
    expect(result.status, result.output).toBe(0)
  })

  it.each(['wrong platform', 'missing dylib', 'dSYM'])('rejects a Mac package with %s', (kind) => {
    putComplete('darwin')
    damage('UnrealAgentLink58-Mac.zip', kind)
    const result = runScript(script, args, { platform: 'darwin' })
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('UnrealAgentLink58-Mac.zip')
  })
})

describe('gate wiring', () => {
  const pluginSteps = (): unknown[] =>
    readOperations(root).filter((op) => op.args?.some((arg) => /plugin/.test(arg)))

  it('runs the scoped plugin step locally without a hard-coded engine', () => {
    const result = runScript('scripts/verify.mjs', ['--changed'])
    expect(result.status, result.output).toBe(0)
    expect(pluginSteps()).toEqual([{ command: 'pnpm', args: ['-s', 'run', 'verify:plugin'] }])
  })

  it('does not run the plugin step in CI and reports it as NOT RUN', () => {
    const result = runScript('scripts/verify.mjs', ['--ci'])
    expect(result.status, result.output).toBe(0)
    expect(pluginSteps()).toEqual([])
    expect(result.output).toMatch(/NOT RUN.*plugin package/)
  })
})
