/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findFreshCrash, parseCrashContext } from './crashReport'
import { monitoredPid, parseProcessRows } from './processes'
import {
  decodeRestoreJson,
  restorablePaths,
  stashPackageRestoreData,
  unstashPackageRestoreData
} from './restoreData'

let root: string
let savedLocalAppData: string | undefined

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'uebox-crash-'))
  // 引擎级崩溃目录指到临时目录里，别去读这台机器上真的那一份
  savedLocalAppData = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = path.join(root, 'LocalAppData')
})

afterEach(async () => {
  process.env.LOCALAPPDATA = savedLocalAppData
  await fs.rm(root, { recursive: true, force: true })
})

/** 引擎写这个文件的样子：每字符两字节、不带 BOM 的 UTF-16LE（真机文件开头 `7b 00 0d 00`） */
function engineJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, '\t').replace(/\n/g, '\r\n'), 'utf16le')
}

function crashXml(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<FGenericCrashContext><RuntimeProperties>${body}</RuntimeProperties></FGenericCrashContext>`
}

async function writeCrash(dir: string, xml: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'CrashContext.runtime-xml'), xml)
}

describe('崩溃报告', () => {
  it('解出错误和调用栈开头，实体要还原', () => {
    const parsed = parseCrashContext(
      crashXml({
        CrashType: 'Crash',
        IsEnsure: 'false',
        ErrorMessage: 'Assertion failed: A &amp;&amp; B',
        CallStack: Array.from({ length: 20 }, (_, i) => `Frame${i}`).join('\n')
      })
    )
    expect(parsed?.errorMessage).toBe('Assertion failed: A && B')
    expect(parsed?.callStackHead.split('\n')).toHaveLength(8)
  })

  it('ensure 和卡顿不是崩溃 —— 编辑器还活着', () => {
    expect(parseCrashContext(crashXml({ CrashType: 'Ensure', IsEnsure: 'true' }))).toBeNull()
    expect(parseCrashContext(crashXml({ CrashType: 'Stall', IsEnsure: 'false' }))).toBeNull()
  })

  // 任务管理器结束进程也会留这种报告：用户自己关的，不能当崩溃替他重开
  it('AbnormalShutdown 不算崩溃', () => {
    expect(parseCrashContext(crashXml({ CrashType: 'AbnormalShutdown' }))).toBeNull()
  })

  it('只要这次连接之后出现的；引擎级目录里只认同名工程', async () => {
    const project = path.join(root, 'TDGuardians')
    const old = path.join(project, 'Saved', 'Crashes', 'UECC-old')
    await writeCrash(old, crashXml({ CrashType: 'Crash', ErrorMessage: 'old' }))
    const past = new Date(Date.now() - 3_600_000)
    await fs.utimes(old, past, past)

    const engineLevel = path.join(root, 'LocalAppData', 'UnrealEngine', '5.5', 'Saved', 'Crashes')
    await writeCrash(
      path.join(engineLevel, 'UECC-other'),
      crashXml({ CrashType: 'Crash', GameName: 'UE-OtherGame', ErrorMessage: 'other' })
    )

    const since = Date.now() - 60_000
    expect(await findFreshCrash(project, 'TDGuardians', since)).toBeNull()

    await writeCrash(
      path.join(engineLevel, 'UECC-ours'),
      crashXml({ CrashType: 'Crash', GameName: 'UE-TDGuardians', ErrorMessage: 'ours' })
    )
    expect((await findFreshCrash(project, 'TDGuardians', since))?.errorMessage).toBe('ours')
  })
})

describe('恢复记录', () => {
  it('认得不带 BOM 的 UTF-16LE', () => {
    const json = decodeRestoreJson(engineJson({ RestoreEnabled: false, Packages: [] }))
    expect(JSON.parse(json)).toEqual({ RestoreEnabled: false, Packages: [] })
  })

  it('记录关着就没有可恢复的', () => {
    expect(
      restorablePaths('{"RestoreEnabled": false, "Packages": [{"AutoSavePath": "a"}]}')
    ).toEqual([])
    expect(restorablePaths('not json')).toEqual([])
  })

  it('有可恢复的包：连同存档一起备份，再把记录挪走', async () => {
    const project = path.join(root, 'TDGuardians')
    const autosaves = path.join(project, 'Saved', 'Autosaves')
    await fs.mkdir(path.join(autosaves, 'Game', 'Maps'), { recursive: true })
    await fs.writeFile(path.join(autosaves, 'Game', 'Maps', 'Main_Auto1.umap'), 'map-bytes')
    await fs.writeFile(
      path.join(autosaves, 'PackageRestoreData.json'),
      engineJson({
        RestoreEnabled: true,
        Packages: [
          { PackagePathName: '/Game/Maps/Main', AutoSavePath: 'Game/Maps/Main_Auto1.umap' },
          { PackagePathName: '/Game/Gone', AutoSavePath: 'Game/Gone_Auto1.uasset' },
          // 引擎写的文件也防一手越界
          { PackagePathName: '/Game/Evil', AutoSavePath: '../../../outside.uasset' }
        ]
      })
    )

    const stashed = await stashPackageRestoreData(project, new Date(2026, 8, 25, 10, 15, 0))

    expect(stashed?.backupDir).toBe(
      path.join(project, 'Saved', 'UEBoxCrashRecovery', '20260925-101500')
    )
    expect(stashed?.packageCount).toBe(3)
    expect(stashed?.missingFiles).toEqual(['Game/Gone_Auto1.uasset'])
    const backup = path.join(stashed!.backupDir, 'Autosaves')
    expect(await fs.readFile(path.join(backup, 'Game', 'Maps', 'Main_Auto1.umap'), 'utf8')).toBe(
      'map-bytes'
    )
    // 记录原样备份（拷回去引擎就照常弹恢复窗口），原位置没了 → 这次启动不弹
    expect(
      restorablePaths(
        decodeRestoreJson(await fs.readFile(path.join(backup, 'PackageRestoreData.json')))
      )
    ).toHaveLength(3)
    await expect(fs.access(path.join(autosaves, 'PackageRestoreData.json'))).rejects.toThrow()
    // 存档本身不动
    await expect(
      fs.access(path.join(autosaves, 'Game', 'Maps', 'Main_Auto1.umap'))
    ).resolves.toBeUndefined()
    await expect(fs.access(path.join(root, 'outside.uasset'))).rejects.toThrow()

    // 重开失败时放回去，引擎下次启动照常问
    await unstashPackageRestoreData(project, stashed!)
    expect(
      restorablePaths(
        decodeRestoreJson(await fs.readFile(path.join(autosaves, 'PackageRestoreData.json')))
      )
    ).toHaveLength(3)
  })

  it('没有可恢复的包就什么都不做', async () => {
    const project = path.join(root, 'Clean')
    const autosaves = path.join(project, 'Saved', 'Autosaves')
    await fs.mkdir(autosaves, { recursive: true })
    await fs.writeFile(
      path.join(autosaves, 'PackageRestoreData.json'),
      engineJson({ RestoreEnabled: false, Packages: [] })
    )

    expect(await stashPackageRestoreData(project)).toBeNull()
    await expect(
      fs.access(path.join(autosaves, 'PackageRestoreData.json'))
    ).resolves.toBeUndefined()
    await expect(fs.access(path.join(project, 'Saved', 'UEBoxCrashRecovery'))).rejects.toThrow()
  })
})

describe('进程表', () => {
  it('PowerShell 只有一个结果时给的是对象', () => {
    expect(
      parseProcessRows(
        '{"ProcessId":12,"Name":"UnrealEditor.exe","CommandLine":null,"ExecutablePath":"D:\\\\UE\\\\UnrealEditor.exe"}'
      )
    ).toEqual([
      {
        pid: 12,
        name: 'UnrealEditor.exe',
        commandLine: '',
        executablePath: 'D:\\UE\\UnrealEditor.exe'
      }
    ])
    expect(parseProcessRows('')).toEqual([])
  })

  it('只有崩溃报告程序的 -MONITOR 才算', () => {
    const row = { pid: 1, name: '', commandLine: '-MONITOR=4242', executablePath: '' }
    expect(monitoredPid({ ...row, name: 'CrashReportClientEditor.exe' })).toBe(4242)
    expect(monitoredPid({ ...row, name: 'UnrealEditor.exe' })).toBeNull()
  })
})
