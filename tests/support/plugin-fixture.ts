import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import AdmZip from 'adm-zip'

export interface Operation {
  command?: string
  args?: string[]
}

/**
 * Copy the named scripts from scripts/ into <root>/scripts and the subprocess hook to
 * <root>/operations.mts. A test that copies a script this way is invisible to import analysis:
 * register it in SPAWNED_SCRIPT_TESTS in scripts/test-related.mjs.
 */
export function copyPluginScripts(root: string, names: string[]): void {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const name of names) {
    copyFileSync(new URL(`../../scripts/${name}`, import.meta.url), join(root, 'scripts', name))
  }
  copyFileSync(
    new URL('./plugin-release-operations.mts', import.meta.url),
    join(root, 'operations.mts')
  )
}

/** Junction to the real node_modules so copied scripts resolve their dependencies. */
export function linkNodeModules(root: string): void {
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction')
}

/** Synthetic package: a `.ual-build` stamp plus optional placeholder entries. */
export function writeStampZip(
  dist: string,
  name: string,
  stamp: Record<string, string>,
  entries: string[] = []
): void {
  const zip = new AdmZip()
  zip.addFile('.ual-build', Buffer.from(JSON.stringify(stamp)))
  for (const entry of entries) zip.addFile(entry, Buffer.from('synthetic binary'))
  zip.writeZip(join(dist, name))
}

export function readOperations(root: string): Operation[] {
  const log = join(root, 'operations.jsonl')
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : []
}

/**
 * Fixture repos are temporary checkouts; personal targets and gate overrides inherited
 * from the real process would point at SHAs that do not exist there. Strip every gate/scope
 * override before spawning a subprocess.
 */
export function fixtureEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (/^(VERIFY_BASE|VERIFY_PLUGIN_ENGINE|PLUGIN_RELEASE_TEST_PLATFORM)$/.test(k)) continue
    env[k] = v
  }
  return { ...env, ...overrides }
}
