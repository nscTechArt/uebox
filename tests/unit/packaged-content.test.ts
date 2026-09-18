// @vitest-environment node
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error build script has no TypeScript declarations
import {
  checkPackagedContent,
  findPackagedDependencySource,
  unexpectedPackagedFiles
} from '../../scripts/check-packaged-content.mjs'

const require = createRequire(import.meta.url)
const { createPackage } = require('@electron/asar')
const { getMainFileMatchers, getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher')
const config = require('js-yaml').load(readFileSync('electron-builder.yml', 'utf8'))
const root = resolve('.')
const temp = mkdtempSync(join(tmpdir(), 'packaged-content-'))
afterAll(() => rmSync(temp, { recursive: true, force: true }))
const packager = {
  config,
  debugLogger: { isEnabled: false },
  info: {
    projectDir: root,
    buildResourcesDir: 'build',
    config,
    isPrepackedAppAsar: false,
    debugLogger: { isEnabled: false }
  }
}
const mainFilter = getMainFileMatchers(
  root,
  join(root, 'dist/test-app'),
  (v: string) => v,
  {},
  packager,
  join(root, 'dist'),
  false
)[0].createFilter()
const fileStat = { isDirectory: () => false }

describe('installer file selection', () => {
  it.each([
    'uploads/private.png',
    '.claude/settings.local.json',
    '.cache/private.log',
    '.env.production',
    '.env.local',
    '.doc/private.md',
    'edition-private/module.js',
    'plugin/UnrealAgentLink/Binaries/Win64/UnrealEditor-UnrealAgentLink.dll',
    'prototype/draft.html'
  ])('excludes local development content: %s', (name) => {
    expect(mainFilter(join(root, name), fileStat)).toBe(false)
    expect(unexpectedPackagedFiles([name])).toEqual([name])
  })

  it.each([
    'out/main/index.js',
    'out/renderer/index.html',
    'resources/icon.ico',
    'resources/plugins/UnrealAgentLink55.zip',
    'resources/plugins/ualink-config.json',
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
    'licenses/EPL-2.0.txt'
  ])('retains runtime files and legal notices: %s', (name) => {
    expect(mainFilter(join(root, name), fileStat)).toBe(true)
    expect(unexpectedPackagedFiles([name])).toEqual([])
  })

  it('preserves LICENSE.md and NOTICE.md inside dependencies', () => {
    const filter = getNodeModuleFileMatcher(
      root,
      join(root, 'dist/test-app'),
      (v: string) => v,
      {},
      packager
    ).createFilter()
    for (const name of ['node_modules/elkjs/LICENSE.md', 'node_modules/example/NOTICE.md']) {
      expect(filter(join(root, name), fileStat)).toBe(true)
    }
  })
})

const required = [
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'licenses/EPL-2.0.txt',
  'licenses/LGPL-3.0.txt',
  'licenses/GPL-3.0.txt',
  'licenses/MPL-2.0.txt',
  'licenses/LGPL-2.1.txt',
  'licenses/libvips-Windows-NOTICES.md'
]
async function archive(name: string, additions: string[] = [], omitted?: string): Promise<string> {
  const source = join(temp, name)
  for (const file of [...required, ...additions].filter((f) => f !== omitted)) {
    const path = join(source, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.endsWith('package.json') ? '{}' : 'fixture contents')
  }
  const target = `${source}.asar`
  await createPackage(source, target)
  return target
}

describe('actual packaged archive gate', () => {
  it('checks the packaged version instead of a different workspace version', () => {
    const workspace = join(temp, 'versions')
    const direct = join(workspace, 'node_modules/example')
    const actual = join(workspace, 'node_modules/.pnpm/example@1.0.0/node_modules/example')
    for (const [directory, version] of [
      [direct, '2.0.0'],
      [actual, '1.0.0']
    ]) {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'example', version }))
    }
    expect(
      findPackagedDependencySource(
        'node_modules/example',
        { name: 'example', version: '1.0.0' },
        workspace
      )
    ).toBe(actual)
    expect(
      findPackagedDependencySource(
        'node_modules/example',
        { name: 'example', version: '3.0.0' },
        workspace
      )
    ).toBeNull()
  })
  it('accepts a clean archive with its required notices', async () => {
    const path = await archive('clean')
    expect(() => checkPackagedContent(path)).not.toThrow()
  })
  it('does not mistake a module-scope package.json for a dependency root', async () => {
    const path = await archive('module-scope', ['node_modules/example/dist/esm/package.json'])
    expect(() => checkPackagedContent(path)).not.toThrow()
  })
  it('rejects private data that slipped into an actual archive', async () => {
    const path = await archive('leak', ['uploads/private.txt'])
    expect(() => checkPackagedContent(path)).toThrow('uploads/private.txt')
  })
  it('rejects a missing required license', async () => {
    const path = await archive('missing', [], 'licenses/EPL-2.0.txt')
    expect(() => checkPackagedContent(path)).toThrow('licenses/EPL-2.0.txt')
  })
  it('rejects a dropped dependency LICENSE.md', async () => {
    const path = await archive('missing-dependency', ['node_modules/elkjs/package.json'])
    expect(() => checkPackagedContent(path)).toThrow('node_modules/elkjs/LICENSE.md')
  })
})
