import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  macAssociation: vi.fn(async () => null),
  macRoots: vi.fn(async (): Promise<string[]> => []),
  pathExists: vi.fn(async () => false)
}))

vi.mock('./macEngineInstallations', () => ({
  registeredMacEngineRoots: mocks.macRoots,
  resolveMacEngineAssociation: mocks.macAssociation
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\Users\\test'),
    getAppPath: vi.fn(() => 'C:\\app')
  }
}))

vi.mock('fs-extra', () => ({
  default: { pathExists: mocks.pathExists },
  pathExists: mocks.pathExists
}))

vi.mock('child_process', () => ({
  default: { exec: mocks.exec },
  exec: mocks.exec
}))

vi.mock('../sqliteDataBase', () => ({
  getPublicDatabase: vi.fn(() => null)
}))

vi.mock('../sqliteDataBase/models/customEngine', () => ({
  addCustomEngine: vi.fn(),
  getAllCustomEngines: vi.fn(() => []),
  removeCustomEngine: vi.fn()
}))

import UnrealPathManagerUtil, {
  dedupeEnginesByRootPath,
  parseEngineManifest,
  parseLauncherInstalledDat
} from './UnrealPathManager'

describe('UnrealPathManagerUtil.resolveEngineVersionFromGUID', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    mocks.exec.mockReset()
    mocks.macAssociation.mockReset()
  })

  it('does not guess a source-build GUID from unrelated installed engine versions', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mocks.exec.mockImplementation((_command, _options, callback) => {
      callback(null, '', '')
      return {} as never
    })
    vi.spyOn(UnrealPathManagerUtil, 'findUnrealEnginePaths').mockResolvedValueOnce([
      {
        name: 'UE_5.6',
        rootPath: 'T:\\UE_5.6',
        appVersion: '5.6',
        version: '5.6',
        pluginPath: 'T:\\UE_5.6\\Engine\\Plugins',
        enginePath: 'T:\\UE_5.6\\Engine\\Binaries\\Win64\\UnrealEditor.exe'
      }
    ])
    vi.spyOn(UnrealPathManagerUtil, 'readVersionFromBuildFile').mockResolvedValueOnce('5.6')

    const result = await UnrealPathManagerUtil.resolveEngineVersionFromGUID(
      '{8B9CFD84-40B9-FE7A-CB9A-7C8F4167186F}'
    )

    expect(result).toBeNull()
  })

  it('routes Mac source builds to Install.ini without starting PowerShell', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const guid = '8B9CFD84-40B9-FE7A-CB9A-7C8F4167186F'
    mocks.macAssociation.mockResolvedValueOnce(null)
    expect(UnrealPathManagerUtil.isSourceBuildGUID(guid)).toBe(true)
    expect(UnrealPathManagerUtil.isSourceBuildGUID(`{${guid}}`)).toBe(true)
    expect(UnrealPathManagerUtil.isSourceBuildGUID('5.5')).toBe(false)
    await UnrealPathManagerUtil.resolveEngineVersionFromGUID(guid)
    expect(mocks.macAssociation).toHaveBeenCalledWith(guid, 'C:\\Users\\test')
    expect(mocks.exec).not.toHaveBeenCalled()
  })
})

it('discovers an externally registered Mac engine and ignores an incomplete installation', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'uebox-external-engine-'))
  const root = join(directory, 'External Source')
  const binary = join(root, 'Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor')
  try {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    await fs.mkdir(join(root, 'Engine/Build'), { recursive: true })
    await fs.writeFile(
      join(root, 'Engine/Build/Build.version'),
      JSON.stringify({ MajorVersion: 5, MinorVersion: 5, PatchVersion: 4 })
    )
    await fs.mkdir(join(root, 'Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS'), {
      recursive: true
    })
    await fs.writeFile(binary, 'fixture', { mode: 0o755 })
    const alias = join(directory, 'Alias')
    await fs.symlink(root, alias, 'junction')
    mocks.macRoots.mockResolvedValueOnce([root, alias, join(directory, 'Incomplete')])
    const engines = await UnrealPathManagerUtil.findUnrealEnginePaths()
    expect(engines).toContainEqual(
      expect.objectContaining({
        rootPath: root,
        version: '5.5',
        appVersion: '5.5.4',
        enginePath: join(root, 'Engine/Binaries/Mac/UnrealEditor.app')
      })
    )
    expect(engines.some((engine) => engine.rootPath === join(directory, 'Incomplete'))).toBe(false)
    expect(engines.filter((engine) => [root, alias].includes(engine.rootPath))).toHaveLength(1)
  } finally {
    vi.restoreAllMocks()
    mocks.macRoots.mockReset().mockResolvedValue([])
    await fs.rm(directory, { recursive: true, force: true })
  }
})

describe('parseLauncherInstalledDat', () => {
  it('keeps engine entries and drops plugin entries that share the engine directory', () => {
    const engines = parseLauncherInstalledDat(
      JSON.stringify({
        InstallationList: [
          {
            ArtifactId: 'QuixelBridge_5.8',
            AppName: 'QuixelBridge_5.8',
            AppVersion: '5.8.0',
            InstallLocation: 'I:\\UE_5.8'
          },
          {
            ArtifactId: 'UE_5.7',
            AppName: 'UE_5.7',
            AppVersion: '5.7.4-51494982+++UE5+Release-5.7-Windows',
            InstallLocation: 'I:\\UE_5.7'
          },
          {
            ArtifactId: 'UE_4.27',
            AppName: 'UE_4.27',
            AppVersion: '4.27.2',
            InstallLocation: 'C:\\Program Files\\Epic Games\\UE_4.27'
          }
        ]
      })
    )

    expect(engines.map((e) => e.version)).toEqual(['5.7', '4.27'])
    expect(engines[0].pluginPath).toBe(join('I:\\UE_5.7', 'Engine', 'Plugins'))
    // 4.x 用的是 UE4Editor.exe，不是 UnrealEditor.exe
    expect(engines[1].enginePath).toContain('UE4Editor.exe')
  })
})

describe('parseEngineManifest', () => {
  const manifest = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      AppName: 'UE_5.8',
      AppVersionString: '5.8.2-56702186+++UE5+Release-5.8-Windows',
      InstallLocation: 'I:\\UE_5.8',
      bIsIncompleteInstall: false,
      ...extra
    })

  it('reads an engine that LauncherInstalled.dat has not caught up with yet', () => {
    const engine = parseEngineManifest(manifest())

    expect(engine).toMatchObject({
      name: 'UE_5.8',
      version: '5.8',
      rootPath: 'I:\\UE_5.8',
      appVersion: '5.8.2-56702186+++UE5+Release-5.8-Windows'
    })
  })

  it('ignores half-installed engines', () => {
    expect(parseEngineManifest(manifest({ bIsIncompleteInstall: true }))).toBeNull()
  })

  it('ignores plugin manifests that live in the engine directory', () => {
    expect(parseEngineManifest(manifest({ AppName: 'FabPlugin_5.8' }))).toBeNull()
  })
})

describe('dedupeEnginesByRootPath', () => {
  it('keeps the first entry when both launcher records describe the same install', () => {
    const fromManifest = parseEngineManifest(
      JSON.stringify({
        AppName: 'UE_5.8',
        AppVersionString: '5.8.2',
        InstallLocation: 'I:\\UE_5.8'
      })
    )!
    const fromDat = { ...fromManifest, rootPath: 'i:\\ue_5.8', appVersion: 'stale' }

    const unique = dedupeEnginesByRootPath([fromManifest, fromDat], 'win32')

    expect(unique).toHaveLength(1)
    expect(unique[0].appVersion).toBe('5.8.2')
  })

  it('does not merge distinct case-sensitive Mac paths', () => {
    const engine = parseEngineManifest(
      JSON.stringify({ AppName: 'UE_5.5', InstallLocation: '/missing/UE' })
    )!
    expect(
      dedupeEnginesByRootPath([engine, { ...engine, rootPath: '/missing/ue' }], 'darwin')
    ).toHaveLength(2)
  })
})

describe('UnrealPathManagerUtil.installPluginToProject', () => {
  afterEach(() => {
    mocks.pathExists.mockReset()
    mocks.pathExists.mockResolvedValue(false)
  })

  it('lets a newer engine through the version gate and fails only on a missing package', async () => {
    // 5.8 出来时这里曾经被一份写死的白名单挡掉，报的是 UNSUPPORTED_VERSION，
    // 哪怕 zip 已经发了也装不上
    mocks.pathExists.mockResolvedValue(false)

    const result = await UnrealPathManagerUtil.installPluginToProject('D:\\Proj', '5.8')

    // 文案后面还会带上 zip 路径和出包提示，这里只认「不是版本门挡的」这件事
    expect(result).toMatchObject({
      success: false,
      code: expect.stringContaining('插件包不存在')
    })
    expect(result.code).not.toContain('UNSUPPORTED_VERSION')
  })
})
