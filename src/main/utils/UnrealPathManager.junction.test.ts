import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 装插件不许穿过目录联接。
 *
 * 开发机上宿主工程的 `Plugins/UnrealAgentLink` 是指向本仓库的 Junction
 * （`plugin/UnrealAgentLink/DEVELOPING.md` 就是这么教的）。`fse.emptyDir` 会顺着联接
 * 进到目标目录里清空 —— 实测触发过两次，两次都把仓库里的插件源码连同未提交的改动删光。
 *
 * 这个文件用真实文件系统，不 mock fs-extra：要钉住的正是 fs-extra 对联接的实际行为。
 */

const appRoot = mkdtempSync(join(tmpdir(), 'ualink-junction-'))
const bundledPluginsDir = join(appRoot, 'resources', 'plugins')

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => join(tmpdir(), 'ualink-userdata')),
    getAppPath: vi.fn(() => appRoot),
    isPackaged: false
  }
}))

vi.mock('../sqliteDataBase', () => ({
  getPublicDatabase: vi.fn(() => null)
}))

vi.mock('../sqliteDataBase/models/customEngine', () => ({
  addCustomEngine: vi.fn(),
  getAllCustomEngines: vi.fn(async () => []),
  removeCustomEngine: vi.fn()
}))

import UnrealPathManagerUtil from './UnrealPathManager'

/**
 * 造一份随包 zip。布局照 `scripts/build-plugin.mjs` 的真实产物来：**平铺**，
 * `.uplugin` 和 `.ual-build` 都在根上，不套一层 `UnrealAgentLink/`。
 *
 * 这层不能想当然：套一层的话 `readBundledPluginFingerprint` 读不到指纹，
 * 「已是最新」会提前返回，安装根本走不到 emptyDir —— 那样这条用例就算把防护
 * 拆了也照样绿，等于什么都没测。
 */
function writeBundledZip(engine: string): void {
  const zip = new AdmZip()
  zip.addFile('UnrealAgentLink.uplugin', Buffer.from(JSON.stringify({ VersionName: '1.2.8' })))
  zip.addFile(
    '.ual-build',
    Buffer.from(JSON.stringify({ fingerprint: 'zipzipzipzipzip1', engine }))
  )
  zip.addFile('Binaries/UnrealAgentLink.dll', Buffer.from('payload'))
  zip.writeZip(
    join(
      bundledPluginsDir,
      `UnrealAgentLink${engine.replace('.', '')}${process.platform === 'darwin' ? '-Mac' : ''}.zip`
    )
  )
}

/** 造一份「仓库里的插件源码」，就是联接要指向的那一头 */
function writeRepoCheckout(dir: string): string {
  mkdirSync(join(dir, 'Source', 'UnrealAgentLink'), { recursive: true })
  writeFileSync(join(dir, 'UnrealAgentLink.uplugin'), JSON.stringify({ VersionName: '1.2.8' }))
  writeFileSync(join(dir, 'DEVELOPING.md'), '# 本地开发')
  writeFileSync(join(dir, 'README.md'), '# UnrealAgentLink')
  writeFileSync(join(dir, 'Source', 'UnrealAgentLink', 'UAL_Uncommitted.cpp'), '// 还没提交的改动')
  return dir
}

beforeAll(() => {
  mkdirSync(bundledPluginsDir, { recursive: true })
  writeFileSync(
    join(bundledPluginsDir, 'ualink-config.json'),
    JSON.stringify({ bundledVersion: '1.2.8' })
  )
  writeBundledZip('5.5')
})

afterAll(() => {
  rmSync(appRoot, { recursive: true, force: true })
})

describe('installPluginToProject 遇到目录联接', () => {
  it('不覆盖开发用联接，联接目标里的文件一个不少', async () => {
    const repo = writeRepoCheckout(join(appRoot, 'repo-checkout', 'UnrealAgentLink'))
    const projectDir = join(appRoot, 'proj-junction')
    const targetPath = join(projectDir, 'Plugins', 'UnrealAgentLink')
    mkdirSync(join(projectDir, 'Plugins'), { recursive: true })
    // Windows 上建 junction 不需要管理员权限；POSIX 上退化成普通符号链接，行为一致
    symlinkSync(repo, targetPath, 'junction')

    const result = await UnrealPathManagerUtil.installPluginToProject(projectDir, '5.5')

    // 核心断言：联接目标里的东西必须原样还在
    expect(readdirSync(repo).sort()).toEqual([
      'DEVELOPING.md',
      'README.md',
      'Source',
      'UnrealAgentLink.uplugin'
    ])
    expect(existsSync(join(repo, 'Source', 'UnrealAgentLink', 'UAL_Uncommitted.cpp'))).toBe(true)
    // 联接本身也没被换成真实目录
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(true)
    // zip 载荷一点都没铺进去
    expect(existsSync(join(repo, 'Binaries'))).toBe(false)
    expect(existsSync(join(repo, '.ual-build'))).toBe(false)

    expect(result).toEqual({ success: true, code: 'DEV_SYMLINK_SKIPPED' })
  })

  it('目标是普通目录时照常装（这道门没把正常安装一起挡掉）', async () => {
    const projectDir = join(appRoot, 'proj-normal')
    const targetPath = join(projectDir, 'Plugins', 'UnrealAgentLink')
    mkdirSync(targetPath, { recursive: true })
    writeFileSync(join(targetPath, 'stale.txt'), '上一次装的残留')

    const result = await UnrealPathManagerUtil.installPluginToProject(projectDir, '5.5')

    expect(result).toEqual({ success: true })
    expect(existsSync(join(targetPath, 'UnrealAgentLink.uplugin'))).toBe(true)
    expect(existsSync(join(targetPath, 'Binaries', 'UnrealAgentLink.dll'))).toBe(true)
    // 普通目录还是要先清空的，残留不能留下
    expect(existsSync(join(targetPath, 'stale.txt'))).toBe(false)
  })
})

describe('uninstallUNTLink 遇到目录联接', () => {
  it('只摘掉联接，联接目标里的源码不动', async () => {
    const repo = writeRepoCheckout(join(appRoot, 'repo-engine-side', 'UnrealAgentLink'))
    const engineRoot = join(appRoot, 'UE_5.5')
    const enginePluginPath = join(engineRoot, 'Engine', 'Plugins', 'UnrealAgentLink')
    mkdirSync(join(engineRoot, 'Engine', 'Plugins'), { recursive: true })
    symlinkSync(repo, enginePluginPath, 'junction')

    const result = await UnrealPathManagerUtil.uninstallUNTLink(engineRoot)

    expect(result.success).toBe(true)
    expect(existsSync(enginePluginPath)).toBe(false)
    expect(readdirSync(repo).sort()).toEqual([
      'DEVELOPING.md',
      'README.md',
      'Source',
      'UnrealAgentLink.uplugin'
    ])
  })
})
