/**
 * @vitest-environment node
 *
 * 崩溃恢复的地基：引擎不在的时候，「这条搬迁到底做成了没有」只能问磁盘。
 *
 * 这几条性质说错了，恢复流程会给出**反的**结论 —— 比没有这个工具更糟：
 *   - 算不出磁盘路径 ≠ 文件不存在
 *   - 旧位置还留着东西 ≠ 没搬成（多半是重定向器）
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkMoveOnDisk, probePackageOnDisk, projectDirOf } from './diskCheck'

let projectDir: string

async function writeAsset(packagePath: string, bytes: number, ext = '.uasset'): Promise<void> {
  const relative = packagePath.slice('/Game/'.length)
  const file = path.join(projectDir, 'Content', `${relative}${ext}`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, Buffer.alloc(bytes, 1))
}

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(tmpdir(), 'ual-disk-'))
})

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true })
})

describe('probePackageOnDisk', () => {
  it('找得到 .uasset', async () => {
    await writeAsset('/Game/Props/SM_Rock', 2048)
    const probe = await probePackageOnDisk(projectDir, '/Game/Props/SM_Rock')
    expect(probe.kind).toBe('found')
    if (probe.kind === 'found') expect(probe.file.bytes).toBe(2048)
  })

  it('关卡是 .umap，一样找得到', async () => {
    await writeAsset('/Game/Maps/L_Main', 4096, '.umap')
    const probe = await probePackageOnDisk(projectDir, '/Game/Maps/L_Main')
    expect(probe.kind).toBe('found')
  })

  it('对象路径后缀不影响查找', async () => {
    await writeAsset('/Game/Props/SM_Rock', 100)
    const probe = await probePackageOnDisk(projectDir, '/Game/Props/SM_Rock.SM_Rock')
    expect(probe.kind).toBe('found')
  })

  /**
   * 这一条最要紧：插件挂载点算不出磁盘位置。
   * 报成 absent 的话，调用方会以为资产没搬过去，然后重搬一遍。
   */
  it('不是 /Game 下的包报 unknown，不报 absent', async () => {
    const probe = await probePackageOnDisk(projectDir, '/MyPlugin/Props/SM_Rock')
    expect(probe.kind).toBe('unknown')
  })

  it('真的不在就是 absent', async () => {
    const probe = await probePackageOnDisk(projectDir, '/Game/Nope/SM_Missing')
    expect(probe.kind).toBe('absent')
  })
})

describe('checkMoveOnDisk', () => {
  it('目标在、源没了 = 搬完了', async () => {
    await writeAsset('/Game/New/SM_Rock', 2048)
    const check = await checkMoveOnDisk(projectDir, '/Game/Old/rock', '/Game/New/SM_Rock')
    expect(check.state).toBe('moved')
  })

  it('源还在、目标没有 = 没搬', async () => {
    await writeAsset('/Game/Old/rock', 2048)
    const check = await checkMoveOnDisk(projectDir, '/Game/Old/rock', '/Game/New/SM_Rock')
    expect(check.state).toBe('not_moved')
  })

  /**
   * 真机上崩溃后看到的就是这一幕：新名字的文件 25 KB（真资产），
   * 旧名字的文件 1.3 KB（重定向器）。结论是**搬完了**，不是搬了一半。
   */
  it('两边都有、旧的那个很小 = 搬完了，旧位置剩个重定向器', async () => {
    await writeAsset('/Game/Old/rock', 1300)
    await writeAsset('/Game/New/SM_Rock', 25_600)
    const check = await checkMoveOnDisk(projectDir, '/Game/Old/rock', '/Game/New/SM_Rock')

    expect(check.state).toBe('both')
    expect(check.source_looks_like_redirector).toBe(true)
    expect(check.detail).toContain('重定向器')
  })

  it('两边都有、旧的那个也很大 = 要人看一眼', async () => {
    await writeAsset('/Game/Old/rock', 30_000)
    await writeAsset('/Game/New/SM_Rock', 25_600)
    const check = await checkMoveOnDisk(projectDir, '/Game/Old/rock', '/Game/New/SM_Rock')

    expect(check.state).toBe('both')
    expect(check.source_looks_like_redirector).toBe(false)
  })

  it('两边都没有 = neither，并说清有哪几种可能', async () => {
    const check = await checkMoveOnDisk(projectDir, '/Game/Old/rock', '/Game/New/SM_Rock')
    expect(check.state).toBe('neither')
    expect(check.detail).toContain('可能')
  })

  it('任一边算不出路径就报 unknown，不下结论', async () => {
    const check = await checkMoveOnDisk(projectDir, '/MyPlugin/Old/rock', '/Game/New/SM_Rock')
    expect(check.state).toBe('unknown')
  })
})

describe('projectDirOf', () => {
  it('给 .uproject 取它所在目录', () => {
    expect(projectDirOf('D:/P/P.uproject')).toBe(path.dirname('D:/P/P.uproject'))
  })

  it('给目录就原样用', () => {
    expect(projectDirOf('D:/P')).toBe('D:/P')
  })
})
