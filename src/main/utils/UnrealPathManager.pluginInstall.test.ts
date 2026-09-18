/**
 * 插件安装是原子的：新的铺好了才换掉旧的。
 *
 * 红灯用例来自一次评审：原实现先 `emptyDir` 清空插件目录，再打开 zip 解压。旧插件在新
 * 插件连打开都还没打开的时候就已经没了，于是 zip 损坏、磁盘写满、编辑器占着 DLL……
 * 任何一步失败，用户的工程都会失去插件；而 `.uproject` 里的引用还在，下次打开工程就是
 * `Unable to find plugin 'UnrealAgentLink'`。
 *
 * 这里用真实文件系统跑，因为要验的正是「失败之后磁盘上还剩什么」。
 */
import AdmZip from 'adm-zip'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ appPath: '' }))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => mocks.appPath,
    getPath: () => join(tmpdir(), 'ualink-userdata'),
    isPackaged: false
  }
}))

const UnrealPathManager = (await import('./UnrealPathManager')).default

let workDir = ''
let projectDir = ''
let pluginDir = ''
let zipPath = ''

/** 造一份随包 zip：resources/plugins/UnrealAgentLink55.zip */
function writeBundledZip(entries: Array<[string, string]>): void {
  const zip = new AdmZip()
  for (const [name, content] of entries) zip.addFile(name, Buffer.from(content, 'utf-8'))
  zip.writeZip(zipPath)
}

/** 造一份「已经装好的旧插件」 */
function writeExistingPlugin(marker: string): void {
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'UnrealAgentLink.uplugin'), marker)
  mkdirSync(join(pluginDir, 'Source'), { recursive: true })
  writeFileSync(join(pluginDir, 'Source', 'old.cpp'), marker)
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ualink-install-'))
  mocks.appPath = join(workDir, 'app')
  projectDir = join(workDir, 'MyGame')
  pluginDir = join(projectDir, 'Plugins', 'UnrealAgentLink')
  zipPath = join(
    mocks.appPath,
    'resources',
    'plugins',
    process.platform === 'darwin' ? 'UnrealAgentLink55-Mac.zip' : 'UnrealAgentLink55.zip'
  )
  mkdirSync(join(mocks.appPath, 'resources', 'plugins'), { recursive: true })
  mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('installPluginToProject', () => {
  it('正常安装：新插件就位，暂存目录不留痕', async () => {
    writeBundledZip([
      ['UnrealAgentLink.uplugin', '{"VersionName":"1.2.9"}'],
      ['Source/new.cpp', 'new']
    ])

    const result = await UnrealPathManager.installPluginToProject(projectDir, '5.5')

    expect(result.success).toBe(true)
    expect(readFileSync(join(pluginDir, 'UnrealAgentLink.uplugin'), 'utf-8')).toContain('1.2.9')
    expect(readFileSync(join(pluginDir, 'Source', 'new.cpp'), 'utf-8')).toBe('new')
    // 暂存和让位用的目录都不该留下来
    const leftovers = readdirSync(join(projectDir, 'Plugins')).filter((n) =>
      n.startsWith('_ualink_')
    )
    expect(leftovers).toEqual([])
  })

  /**
   * 暂存和退休目录都不许出现在 `Plugins/` 里。
   *
   * 它们内部各有一份完整的 `.uplugin`。留在 `Plugins/` 下面时，引擎会在同一个工程里
   * 发现两个同名插件 —— `FPluginManager::CreatePluginObject` 只打一句
   * 「second location will be ignored」就按扫描顺序挑一个，而顺序不保证。
   * 清理失败（编辑器占着 DLL）或进程崩在中途时，用户升级完可能还在跑旧插件，
   * 盒子这边却判「已是最新」不再重装 —— 不报错也不自愈。
   *
   * 所以这里扫的不是「有没有清理干净」（上一条已经扫了），而是**一开始就没建在那**。
   */
  it('暂存目录建在 Plugins 之外 —— 崩在中途也不会变成第二个同名插件', async () => {
    writeExistingPlugin('OLD')
    // 坏包：解压这一步就炸，暂存目录留在原地，正好用来看它建在了哪
    writeFileSync(zipPath, 'this is not a zip')

    await UnrealPathManager.installPluginToProject(projectDir, '5.5')

    expect(readdirSync(join(projectDir, 'Plugins'))).toEqual(['UnrealAgentLink'])
  })

  it('zip 里没有 .uplugin（包损坏/不完整）时，旧插件原封不动', async () => {
    writeExistingPlugin('OLD')
    // 一个「能解压但内容不对」的包 —— 校验这一步要拦住它
    writeBundledZip([['README.txt', 'not a plugin']])

    const result = await UnrealPathManager.installPluginToProject(projectDir, '5.5')

    expect(result.success).toBe(false)
    expect(readFileSync(join(pluginDir, 'UnrealAgentLink.uplugin'), 'utf-8')).toBe('OLD')
    expect(readFileSync(join(pluginDir, 'Source', 'old.cpp'), 'utf-8')).toBe('OLD')
  })

  it('zip 文件本身是坏的时，旧插件原封不动', async () => {
    writeExistingPlugin('OLD')
    writeFileSync(zipPath, 'this is not a zip')

    const result = await UnrealPathManager.installPluginToProject(projectDir, '5.5')

    expect(result.success).toBe(false)
    expect(existsSync(join(pluginDir, 'UnrealAgentLink.uplugin'))).toBe(true)
    expect(readFileSync(join(pluginDir, 'UnrealAgentLink.uplugin'), 'utf-8')).toBe('OLD')
  })

  it('随包 zip 根本不存在时，旧插件原封不动', async () => {
    writeExistingPlugin('OLD')

    const result = await UnrealPathManager.installPluginToProject(projectDir, '5.5')

    expect(result.success).toBe(false)
    expect(readFileSync(join(pluginDir, 'UnrealAgentLink.uplugin'), 'utf-8')).toBe('OLD')
  })

  it('zip 多包一层同名目录时也能正确铺开', async () => {
    writeBundledZip([
      ['UnrealAgentLink/UnrealAgentLink.uplugin', '{"VersionName":"1.3.0"}'],
      ['UnrealAgentLink/Source/new.cpp', 'nested']
    ])

    const result = await UnrealPathManager.installPluginToProject(projectDir, '5.5')

    expect(result.success).toBe(true)
    expect(readFileSync(join(pluginDir, 'UnrealAgentLink.uplugin'), 'utf-8')).toContain('1.3.0')
    expect(readFileSync(join(pluginDir, 'Source', 'new.cpp'), 'utf-8')).toBe('nested')
  })
})
