// @vitest-environment node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  parseMacInstallations,
  registeredMacEngineRoots,
  resolveMacEngineAssociation
} from './macEngineInstallations'

let home: string
let ini: string
const guid = '12345678-1234-1234-1234-123456789ABC'
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'uebox-install-'))
  ini = path.join(home, 'Library/Application Support/Epic/UnrealEngine/Install.ini')
  await fs.mkdir(path.dirname(ini), { recursive: true })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(home, { recursive: true, force: true })
})

it('combines source and Launcher registrations, filtering plugins and relative paths', async () => {
  await fs.writeFile(ini, '[Installations]\nSource=/Volumes/工作/UE Source')
  const launcher = path.join(
    home,
    'Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat'
  )
  await fs.mkdir(path.dirname(launcher), { recursive: true })
  await fs.writeFile(
    launcher,
    JSON.stringify({
      InstallationList: [
        { AppName: 'UE_5.5', InstallLocation: '/Volumes/工作/UE Launcher' },
        { ArtifactId: 'FabPlugin_5.5', AppName: 'UE_5.5', InstallLocation: '/plugin' },
        { ArtifactId: 'UE_5.6', InstallLocation: '../relative' },
        { ArtifactId: 'UE_5.5', InstallLocation: '/Volumes/工作/UE Source' }
      ]
    })
  )
  expect(await registeredMacEngineRoots(home)).toEqual([
    '/Volumes/工作/UE Source',
    '/Volumes/工作/UE Launcher'
  ])
})

it('keeps source registrations when Launcher metadata is malformed', async () => {
  await fs.writeFile(ini, '[Installations]\nSource=/Volumes/UE')
  const launcher = path.join(
    home,
    'Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat'
  )
  await fs.mkdir(path.dirname(launcher), { recursive: true })
  await fs.writeFile(launcher, '{broken')
  expect(await registeredMacEngineRoots(home)).toEqual(['/Volumes/UE'])
})

it('parses only installations, preserving spaces and equals signs in paths', () => {
  const entries = parseMacInstallations(
    `\uFEFF[Other]\nBad=/other\n[Installations]\r\n; comment\n{${guid}} = "/Users/中文 Engine=A"\nRelative=../bad\n[Else]\nIgnored=/ignored`
  )
  expect([...entries]).toEqual([[guid.toLowerCase(), '/Users/中文 Engine=A']])
})

it('resolves braced and unbraced GUIDs using the registered build metadata', async () => {
  // Install.ini 里只认绝对 POSIX 路径，所以引擎根目录必须是字面量：宿主可能是
  // Windows，tmpdir() 造出来的是 C:\...，落进 ini 会被当成相对路径直接丢掉。
  // 路径不落盘，Build.version 的内容就直接喂给读取那一步。
  const engine = '/Volumes/工作/中文 Source Engine'
  const buildVersion = path.join(engine, 'Engine/Build/Build.version')
  const readFile = fs.readFile.bind(fs)
  vi.spyOn(fs, 'readFile').mockImplementation((target, options) =>
    String(target) === buildVersion
      ? // 不传编码读，拿到的是原始字节（编码按 BOM 判，见 utils/ueTextFile.ts）
        Promise.resolve(
          Buffer.from(JSON.stringify({ MajorVersion: 5, MinorVersion: 5, PatchVersion: 4 }))
        )
      : readFile(target, options)
  )
  await fs.writeFile(ini, `[Installations]\n${guid}=${engine}`)
  expect(await resolveMacEngineAssociation(`{${guid.toLowerCase()}}`, home)).toEqual({
    version: '5.5',
    engineRootPath: engine
  })
  expect(await resolveMacEngineAssociation('different', home)).toBeNull()
})

it('returns null for missing registration, stale paths, or malformed build metadata', async () => {
  expect(await resolveMacEngineAssociation(guid, home)).toBeNull()
  await fs.writeFile(ini, `[Installations]\n${guid}=${home}/gone`)
  expect(await resolveMacEngineAssociation(guid, home)).toBeNull()
  await fs.mkdir(path.join(home, 'gone/Engine/Build'), { recursive: true })
  await fs.writeFile(path.join(home, 'gone/Engine/Build/Build.version'), '{broken')
  expect(await resolveMacEngineAssociation(guid, home)).toBeNull()
})
