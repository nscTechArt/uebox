import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 装不上就别写 .uproject。
 *
 * 这里以前是「插件文件安装失败也继续写引用」，UE 下次打开工程会因为找不到
 * 这个插件先弹一个报错框 —— 用户什么都没做就先撞上错误，对还没出包的引擎版本
 * 和 GUID 解析失败的自编译引擎是必现的。
 */

const mocks = vi.hoisted(() => ({
  installPluginToProject: vi.fn(),
  findUnrealEnginePaths: vi.fn(async () => []),
  uninstallUNTLink: vi.fn(async () => ({ success: true })),
  isUALinkOptedOut: vi.fn(() => false),
  ensurePluginIgnored: vi.fn(async () => ({ gitignore: false, p4ignore: false }))
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => join(tmpdir(), 'ualink-userdata')), getAppPath: vi.fn(() => '.') }
}))

vi.mock('../index', () => ({ getPublicDatabase: vi.fn(() => null) }))
vi.mock('../models/project', () => ({
  createProject: vi.fn(),
  getProjectByKey: vi.fn(),
  getProjectById: vi.fn(),
  getAllProjects: vi.fn(() => []),
  updateProject: vi.fn(),
  deleteProjectByKey: vi.fn(),
  projectExists: vi.fn(),
  searchProjects: vi.fn(),
  getProjectByPath: vi.fn(),
  projectExistsByPath: vi.fn()
}))
vi.mock('../../appWindows', () => ({ getAppWindows: vi.fn(() => []) }))
vi.mock('../../utils/fileProcessor/UnrealAssetProcessor', () => ({
  UnrealAssetProcessor: class {}
}))
vi.mock('../../utils/ThumbnailManager', () => ({ default: {} }))
vi.mock('../../appSettingsManager', () => ({
  appSettingsManager: {
    isUALinkOptedOut: mocks.isUALinkOptedOut,
    getAutoEnableUnrealAgentLink: vi.fn(() => true),
    setUALinkOptOut: vi.fn()
  }
}))
vi.mock('../../utils/UnrealPathManager', () => ({
  default: {
    installPluginToProject: mocks.installPluginToProject,
    findUnrealEnginePaths: mocks.findUnrealEnginePaths,
    uninstallUNTLink: mocks.uninstallUNTLink,
    isSourceBuildGUID: (value: string) => /^\{[A-Fa-f0-9-]+\}$/.test(value),
    resolveEngineVersionFromGUID: vi.fn(async () => null),
    loadUALinkConfig: () => ({ bundledVersion: '1.2.8' }),
    isProjectPluginUpToDate: vi.fn(async () => false)
  }
}))
vi.mock('../../utils/pluginVcsIgnore', () => ({ ensurePluginIgnored: mocks.ensurePluginIgnored }))

import { ensureUnrealAgentLinkPlugin, installUnrealAgentLinkPlugin } from './project'

let projectDir = ''
let uprojectPath = ''

/** 读回 .uproject 里的 Plugins 数组 */
function readPlugins(): Array<{ Name: string; Enabled?: boolean }> {
  const data = JSON.parse(readFileSync(uprojectPath, 'utf-8')) as {
    Plugins?: Array<{ Name: string; Enabled?: boolean }>
  }
  return data.Plugins || []
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ualink-proj-'))
  uprojectPath = join(projectDir, 'MyGame.uproject')
  writeFileSync(
    uprojectPath,
    JSON.stringify({ FileVersion: 3, EngineAssociation: '5.5' }, null, '\t')
  )
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
  vi.clearAllMocks()
  mocks.isUALinkOptedOut.mockReturnValue(false)
})

describe('ensureUnrealAgentLinkPlugin', () => {
  it('插件包装不上时不往 .uproject 里写引用', async () => {
    mocks.installPluginToProject.mockResolvedValue({ success: false, code: '插件包不存在' })

    await ensureUnrealAgentLinkPlugin(uprojectPath)

    expect(readPlugins()).toEqual([])
  })

  it('安装报成功但磁盘上没有 .uplugin 时同样不写引用', async () => {
    mocks.installPluginToProject.mockResolvedValue({ success: true })

    await ensureUnrealAgentLinkPlugin(uprojectPath)

    expect(readPlugins()).toEqual([])
  })

  it('插件文件真的落盘了才写入并启用', async () => {
    mocks.installPluginToProject.mockImplementation(async () => {
      const dir = join(projectDir, 'Plugins', 'UnrealAgentLink')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'UnrealAgentLink.uplugin'), JSON.stringify({ VersionName: '1.2.8' }))
      return { success: true }
    })

    await ensureUnrealAgentLinkPlugin(uprojectPath)

    expect(readPlugins()).toEqual([{ Name: 'UnrealAgentLink', Enabled: true }])
  })

  it('右键手动安装：装不上就不许报成功', async () => {
    mocks.installPluginToProject.mockResolvedValue({ success: false, code: '插件包不存在' })

    const result = await installUnrealAgentLinkPlugin(uprojectPath)

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('右键手动安装：文件真的到位了才报成功', async () => {
    mocks.installPluginToProject.mockImplementation(async () => {
      const dir = join(projectDir, 'Plugins', 'UnrealAgentLink')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'UnrealAgentLink.uplugin'), JSON.stringify({ VersionName: '1.2.8' }))
      return { success: true }
    })

    expect(await installUnrealAgentLinkPlugin(uprojectPath)).toEqual({ success: true })
  })

  /**
   * 中文工程被 UE 存成 UTF-16 之后照样要装得上。
   *
   * 引擎保存 `.uproject` 走 `SaveStringToFile` 的 AutoDetect：内容里有一个非 ASCII
   * 字符就整份翻成 UTF-16LE。盒子这边曾经写死按 utf-8 读，于是中文工程一导入就报
   * `Unexpected token '�'`，插件装不上，AI 从此看不见引擎 —— 2026-09-17 的真实事故。
   */
  it('工程文件是 UTF-16 时照样装得上', async () => {
    writeFileSync(
      uprojectPath,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(
          JSON.stringify(
            { FileVersion: 3, EngineAssociation: '5.5', Description: '纯蓝图工程' },
            null,
            '\t'
          ),
          'utf16le'
        )
      ])
    )
    mocks.installPluginToProject.mockImplementation(async () => {
      const dir = join(projectDir, 'Plugins', 'UnrealAgentLink')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'UnrealAgentLink.uplugin'), JSON.stringify({ VersionName: '1.2.8' }))
      return { success: true }
    })

    const outcome = await ensureUnrealAgentLinkPlugin(uprojectPath)

    expect(outcome.pluginFailure).toBeNull()
    expect(mocks.installPluginToProject).toHaveBeenCalledWith(projectDir, '5.5')
    expect(readPlugins()).toEqual([{ Name: 'UnrealAgentLink', Enabled: true }])
    // 写回去用 UTF-8 不带 BOM：引擎没有 BOM 时按 UTF-8 解（FileHelper.cpp，5.0–5.8 一致），
    // 中文描述不会丢
    const rewritten = readFileSync(uprojectPath)
    expect(rewritten[0]).not.toBe(0xff)
    expect(rewritten.toString('utf8')).toContain('纯蓝图工程')
  })

  it('用户点过「移除」的项目一步都不做', async () => {
    mocks.isUALinkOptedOut.mockReturnValue(true)

    await ensureUnrealAgentLinkPlugin(uprojectPath)

    expect(mocks.installPluginToProject).not.toHaveBeenCalled()
    expect(readPlugins()).toEqual([])
  })
})
