import { mkdtempSync, mkdirSync, writeFileSync, rmSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import {
  discoverMacEngineRoots,
  normalizeEngineRoot,
  readEngineBuildVersion,
  resolveInsightsExecutable,
  resolveEngineExecutable
} from './unrealEnginePlatform'

const mocks = vi.hoisted(() => ({ save: vi.fn(), records: vi.fn(() => []) }))
vi.mock('electron', () => ({ app: { getPath: vi.fn(), getAppPath: vi.fn() } }))
vi.mock('../sqliteDataBase', () => ({ getPublicDatabase: vi.fn(() => null) }))
vi.mock('../sqliteDataBase/models/customEngine', () => ({
  addCustomEngine: mocks.save,
  getAllCustomEngines: mocks.records,
  removeCustomEngine: vi.fn()
}))
import UnrealPathManager from './UnrealPathManager'
import * as platformPaths from './unrealEnginePlatform'

let directory: string
function write(relative: string, content = ''): string {
  const file = join(directory, relative)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, { mode: 0o755 })
  return file
}
function macEngine(name: string, editor = 'UnrealEditor'): string {
  write(
    `${name}/Engine/Build/Build.version`,
    JSON.stringify({ MajorVersion: 5, MinorVersion: 6, PatchVersion: 1 })
  )
  write(`${name}/Engine/Binaries/Mac/${editor}.app/Contents/MacOS/${editor}`)
  return join(directory, name)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'uebox-mac-engine-'))
  vi.mocked(app.getPath).mockReturnValue(directory)
  mocks.save.mockClear()
  mocks.records.mockReturnValue([])
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(directory, { recursive: true, force: true })
})

describe('platform engine paths', () => {
  it('finds the command-line Insights binary in a Mac bundle and keeps the Windows path', async () => {
    const windows = write('Engine/Binaries/Win64/UnrealInsights.exe')
    expect(await resolveInsightsExecutable(directory, 'win32')).toBe(windows)
    expect(await resolveInsightsExecutable(directory, 'darwin')).toBeNull()
    const mac = write('Engine/Binaries/Mac/UnrealInsights.app/Contents/MacOS/UnrealInsights')
    expect(await resolveInsightsExecutable(directory, 'darwin')).toBe(mac)
  })

  it('accepts a standalone Mac Insights executable', async () => {
    const executable = write('Engine/Binaries/Mac/UnrealInsights')
    expect(await resolveInsightsExecutable(directory, 'darwin')).toBe(executable)
  })

  it.each(['UnrealEditor', 'UE4Editor'])(
    'resolves a complete %s bundle for shell.openPath',
    async (editor) => {
      const root = macEngine('带空格 UE', editor)
      const bundle = join(root, 'Engine', 'Binaries', 'Mac', `${editor}.app`)
      expect(await resolveEngineExecutable(root, 'darwin')).toBe(bundle)
      for (const candidate of [
        root,
        `${root}/Engine/`,
        bundle,
        `${bundle}/Contents/MacOS/${editor}`
      ]) {
        expect(normalizeEngineRoot(candidate)).toBe(root)
      }
    }
  )

  it('rejects an incomplete bundle, a directory posing as an executable, and a missing root', async () => {
    mkdirSync(join(directory, 'Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor'), {
      recursive: true
    })
    expect(await resolveEngineExecutable(directory, 'darwin')).toBeNull()
    expect(await resolveEngineExecutable('', 'darwin')).toBeNull()
  })

  it('rejects an executable when access is denied', async () => {
    const root = macEngine('no-permission')
    vi.spyOn(fs, 'access').mockRejectedValue(Object.assign(new Error('Denied'), { code: 'EACCES' }))
    expect(await resolveEngineExecutable(root, 'darwin')).toBeNull()
  })

  it('preserves Windows editor discovery and does not accept it as a Mac editor', async () => {
    const executable = write('Engine/Binaries/Win64/UE4Editor.exe')
    expect(await resolveEngineExecutable(directory, 'win32')).toBe(executable)
    expect(await resolveEngineExecutable(directory, 'darwin')).toBeNull()
    expect(normalizeEngineRoot(executable)).toBe(directory)
  })

  it('reads version metadata and rejects malformed or absent metadata', async () => {
    const root = macEngine('source-build')
    expect(await readEngineBuildVersion(root)).toBe('5.6.1')
    write('source-build/Engine/Build/Build.version', '{')
    expect(await readEngineBuildVersion(root)).toBeNull()
    write('source-build/Engine/Build/Build.version', '{"MajorVersion":"5","MinorVersion":6}')
    expect(await readEngineBuildVersion(root)).toBeNull()
    expect(await readEngineBuildVersion(join(directory, 'missing'))).toBeNull()
  })

  it('scans only immediate installation children and tolerates missing directories', async () => {
    const root = macEngine('UE_5.6')
    write('not-an-install.txt')
    expect(await discoverMacEngineRoots([join(directory, 'missing'), directory])).toEqual([root])
  })
})

describe('Mac engine registration', () => {
  beforeEach(() => vi.stubGlobal('process', { ...process, platform: 'darwin' }))

  it('adds a bundle, stores its canonical root and reloads it from the custom index', async () => {
    const root = macEngine('Custom UE')
    const bundle = join(root, 'Engine/Binaries/Mac/UnrealEditor.app')
    const engine = await UnrealPathManager.addCustomPath(bundle)
    expect(engine).toMatchObject({ rootPath: root, enginePath: bundle, version: '5.6.1' })
    expect(mocks.save).toHaveBeenCalledWith(null, {
      rootPath: root,
      name: 'UE_5.6.1',
      version: '5.6.1'
    })
    mocks.records.mockReturnValue([{ rootPath: root, name: 'UE_5.6.1', version: '5.6.1' }] as never)
    expect(await UnrealPathManager.mergeCustomEngines([])).toEqual([engine])
    expect(await UnrealPathManager.inspectInvalidCustomEngines()).toEqual([])
  })

  it('does not fall back to PowerShell or save a broken installation', async () => {
    const root = macEngine('broken')
    write('broken/Engine/Build/Build.version', '{}')
    const getVersion = vi.spyOn(UnrealPathManager, 'getExeVersion')
    expect(await UnrealPathManager.addCustomPath(root)).toBeNull()
    expect(await UnrealPathManager.addCustomPath([])).toBeNull()
    expect(getVersion).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('discovers valid Mac installations and filters non-engine directories', async () => {
    const root = macEngine('UE_5.6')
    vi.spyOn(platformPaths, 'discoverMacEngineRoots').mockResolvedValue([
      root,
      join(directory, 'not-an-engine')
    ])
    const engines = await UnrealPathManager.findUnrealEnginePaths()
    expect(engines).toHaveLength(1)
    expect(engines[0]).toMatchObject({ rootPath: root, version: '5.6', appVersion: '5.6.1' })
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
