import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

/**
 * 「已装的插件是不是随包的那一份」——只比 VersionName 是不够的。
 *
 * 插件源码改了但 .uplugin 的版本号没动是常态，只比版本号的话，装过 1.2.8 的
 * 用户永远拿不到后来重编的 1.2.8。下面这几条钉住指纹这一层。
 */

const appRoot = mkdtempSync(join(tmpdir(), 'ualink-freshness-'))
const pluginsDir = join(appRoot, 'resources', 'plugins')

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => join(tmpdir(), 'ualink-userdata')),
    getAppPath: vi.fn(() => appRoot)
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

/** 造一个随包 zip：带 .uplugin，指纹可选 */
function writeBundledZip(engine: string, versionName: string, fingerprint?: string): void {
  const zip = new AdmZip()
  zip.addFile('UnrealAgentLink.uplugin', Buffer.from(JSON.stringify({ VersionName: versionName })))
  if (fingerprint) {
    zip.addFile('.ual-build', Buffer.from(JSON.stringify({ fingerprint, engine })))
  }
  zip.writeZip(
    join(
      pluginsDir,
      `UnrealAgentLink${engine.replace('.', '')}${process.platform === 'darwin' ? '-Mac' : ''}.zip`
    )
  )
}

/** 造一个「已装到项目里」的插件目录 */
function writeInstalledPlugin(dir: string, versionName: string, fingerprint?: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'UnrealAgentLink.uplugin'), JSON.stringify({ VersionName: versionName }))
  if (fingerprint) {
    writeFileSync(join(dir, '.ual-build'), JSON.stringify({ fingerprint }))
  }
  return dir
}

beforeAll(() => {
  mkdirSync(pluginsDir, { recursive: true })
  writeFileSync(join(pluginsDir, 'ualink-config.json'), JSON.stringify({ bundledVersion: '1.2.8' }))
})

afterAll(() => {
  rmSync(appRoot, { recursive: true, force: true })
})

describe('UnrealPathManagerUtil.isProjectPluginUpToDate', () => {
  it('版本号一样但源码指纹不一样时判为过期', async () => {
    writeBundledZip('5.5', '1.2.8', 'bbbbbbbbbbbbbbbb')
    const installed = writeInstalledPlugin(
      join(appRoot, 'proj-stale', 'Plugins', 'UnrealAgentLink'),
      '1.2.8',
      'aaaaaaaaaaaaaaaa'
    )

    expect(await UnrealPathManagerUtil.isProjectPluginUpToDate(installed, '5.5')).toBe(false)
  })

  it('版本号和指纹都对上才算最新', async () => {
    writeBundledZip('5.4', '1.2.8', 'cccccccccccccccc')
    const installed = writeInstalledPlugin(
      join(appRoot, 'proj-fresh', 'Plugins', 'UnrealAgentLink'),
      '1.2.8',
      'cccccccccccccccc'
    )

    expect(await UnrealPathManagerUtil.isProjectPluginUpToDate(installed, '5.4')).toBe(true)
  })

  it('已装的那份没有指纹标记（老版本装的）时判为过期，让它被覆盖一次', async () => {
    writeBundledZip('5.3', '1.2.8', 'dddddddddddddddd')
    const installed = writeInstalledPlugin(
      join(appRoot, 'proj-nostamp', 'Plugins', 'UnrealAgentLink'),
      '1.2.8'
    )

    expect(await UnrealPathManagerUtil.isProjectPluginUpToDate(installed, '5.3')).toBe(false)
  })

  it('随包 zip 里没有指纹时退回到只比版本号，不会每次启动都重装', async () => {
    writeBundledZip('5.2', '1.2.8')
    const installed = writeInstalledPlugin(
      join(appRoot, 'proj-oldpack', 'Plugins', 'UnrealAgentLink'),
      '1.2.8'
    )

    expect(await UnrealPathManagerUtil.isProjectPluginUpToDate(installed, '5.2')).toBe(true)
  })

  it('找不到随包 zip（自编译引擎的 GUID）时不下结论，交给完整安装流程', async () => {
    const installed = writeInstalledPlugin(
      join(appRoot, 'proj-guid', 'Plugins', 'UnrealAgentLink'),
      '1.2.8',
      'eeeeeeeeeeeeeeee'
    )

    expect(
      await UnrealPathManagerUtil.isProjectPluginUpToDate(
        installed,
        '{A1B2C3D4-1234-1234-1234-123456789ABC}'
      )
    ).toBe(false)
  })

  it('已装的版本比随包的旧时判为过期', async () => {
    writeBundledZip('5.1', '1.2.8', 'ffffffffffffffff')
    const installed = writeInstalledPlugin(
      join(appRoot, 'proj-old', 'Plugins', 'UnrealAgentLink'),
      '1.2.6',
      'ffffffffffffffff'
    )

    expect(await UnrealPathManagerUtil.isProjectPluginUpToDate(installed, '5.1')).toBe(false)
  })
})
