/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { UeboxError } from './errors.js'
import {
  canonicalizeProjectPath,
  findProjectUpwards,
  normalize,
  resolveProject,
  type RegisteredProject
} from './project.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function projectDir(name = 'Demo'): Promise<string> {
  // 目录名带空格和中文：真机上这两样最容易出问题，而它们完全是常态
  const root = await fs.mkdtemp(join(tmpdir(), 'uebox 工程-'))
  dirs.push(root)
  const dir = join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, `${name}.uproject`), '{}')
  return dir.replace(/\\/g, '/')
}

function registered(...paths: string[]): RegisteredProject[] {
  return paths.map((path, index) => ({
    connectionId: `conn-${index}`,
    name: path.split('/').pop() ?? 'Demo',
    path
  }))
}

describe('canonicalizeProjectPath', () => {
  it('给目录就用目录', async () => {
    const dir = await projectDir()
    expect(await canonicalizeProjectPath(dir)).toBe(dir)
  })

  /** 用户手上有哪个就给哪个，逼他先想清楚该给哪种是没必要的负担 */
  it('给 .uproject 文件就落到它所在的目录', async () => {
    const dir = await projectDir()
    expect(await canonicalizeProjectPath(join(dir, 'Demo.uproject'))).toBe(dir)
  })

  it('带空格和中文的路径照常处理', async () => {
    const dir = await projectDir('我的工程')
    expect(await canonicalizeProjectPath(dir)).toBe(dir)
    expect(dir).toContain(' ')
  })

  it('路径不存在时报 INVALID_ARGUMENT', async () => {
    try {
      await canonicalizeProjectPath(join(tmpdir(), 'uebox-不存在-12345'))
      expect.unreachable('应该抛出')
    } catch (error) {
      expect((error as UeboxError).code).toBe('INVALID_ARGUMENT')
    }
  })

  it('目录里没有 .uproject 时说清楚', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'uebox-empty-'))
    dirs.push(root)

    await expect(canonicalizeProjectPath(root)).rejects.toThrow(/没有 \.uproject/)
  })

  it('一个目录里有两个 .uproject 时报歧义，并教用户指到文件', async () => {
    const dir = await projectDir()
    await fs.writeFile(join(dir, 'Second.uproject'), '{}')

    try {
      await canonicalizeProjectPath(dir)
      expect.unreachable('应该抛出')
    } catch (error) {
      expect((error as UeboxError).code).toBe('PROJECT_AMBIGUOUS')
      expect((error as UeboxError).hint).toContain('--project')
    }
  })
})

describe('findProjectUpwards', () => {
  it('从子目录逐层往上找到工程根', async () => {
    const dir = await projectDir()
    const deep = join(dir, 'Content', 'Maps')
    await fs.mkdir(deep, { recursive: true })

    expect(await findProjectUpwards(deep)).toBe(dir)
  })

  /** 找不到不是错误，只是「这次没有本地线索」，会落到第三级 */
  it('一直到根都没有时返回 undefined，不报错', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'uebox-nowhere-'))
    dirs.push(root)

    expect(await findProjectUpwards(root)).toBeUndefined()
  })
})

describe('resolveProject', () => {
  it('显式路径在线时就用它', async () => {
    const dir = await projectDir()
    const result = await resolveProject(dir, registered(dir))

    expect(result).toMatchObject({ path: dir, source: 'explicit' })
  })

  /**
   * 这是整个模块最重要的一条。
   *
   * 用户说了「这个工程」，那就是这个工程。旁边另一个工程在线不是改发给它的
   * 理由 —— 那一幕的表现是：命令返回成功，用户回到编辑器发现什么都没变，
   * 而他另一个项目的关卡被动了。
   */
  it('显式指定的工程没连上时失败，绝不回退到另一个在线工程', async () => {
    const mine = await projectDir('Mine')
    const other = await projectDir('Other')

    try {
      await resolveProject(mine, registered(other))
      expect.unreachable('应该抛出')
    } catch (error) {
      expect((error as UeboxError).code).toBe('PROJECT_NOT_CONNECTED')
      expect((error as UeboxError).hint).toContain('不会改发给别的工程')
    }
  })

  it('当前目录识别出的工程没连上时，同样不回退', async () => {
    const mine = await projectDir('Mine')
    const other = await projectDir('Other')
    const deep = join(mine, 'Content')
    await fs.mkdir(deep, { recursive: true })

    await expect(resolveProject(undefined, registered(other), deep)).rejects.toThrow(/没有连接/)
  })

  it('从当前目录往上找到并且在线时，source 是 cwd', async () => {
    const dir = await projectDir()
    const deep = join(dir, 'Content')
    await fs.mkdir(deep, { recursive: true })

    expect(await resolveProject(undefined, registered(dir), deep)).toMatchObject({
      path: dir,
      source: 'cwd'
    })
  })

  /** 「恰好一个」意味着没有别的选项，猜不错 */
  it('没有本地线索但只有一个工程在线时自动采用', async () => {
    const nowhere = await fs.mkdtemp(join(tmpdir(), 'uebox-nowhere-'))
    dirs.push(nowhere)
    const online = await projectDir()

    expect(await resolveProject(undefined, registered(online), nowhere)).toMatchObject({
      source: 'single'
    })
  })

  it('没有本地线索且两个工程在线时报歧义，不挑一个', async () => {
    const nowhere = await fs.mkdtemp(join(tmpdir(), 'uebox-nowhere-'))
    dirs.push(nowhere)
    const a = await projectDir('A')
    const b = await projectDir('B')

    try {
      await resolveProject(undefined, registered(a, b), nowhere)
      expect.unreachable('应该抛出')
    } catch (error) {
      expect((error as UeboxError).code).toBe('PROJECT_AMBIGUOUS')
      expect((error as UeboxError).hint).toContain('uebox projects list')
    }
  })

  it('一个工程都没连时报 PROJECT_NOT_CONNECTED', async () => {
    const nowhere = await fs.mkdtemp(join(tmpdir(), 'uebox-nowhere-'))
    dirs.push(nowhere)

    try {
      await resolveProject(undefined, [], nowhere)
      expect.unreachable('应该抛出')
    } catch (error) {
      expect((error as UeboxError).code).toBe('PROJECT_NOT_CONNECTED')
    }
  })

  it('同一路径匹配到多条连接时不猜', async () => {
    const dir = await projectDir()

    await expect(resolveProject(dir, registered(dir, dir))).rejects.toThrow(/匹配到 2 条/)
  })
})

describe('normalize', () => {
  it('抹平斜杠方向和结尾斜杠', () => {
    expect(normalize('D:\\Games\\Demo\\')).toBe(normalize('D:/Games/Demo'))
  })

  /** 规则要和服务端 externalTarget.ts 保持一致：Windows 不分大小写，别的平台分 */
  it('大小写按平台处理', () => {
    const same = normalize('D:/Games/DEMO') === normalize('D:/Games/demo')
    expect(same).toBe(process.platform === 'win32')
  })
})
