/**
 * UE 连上时补登记进项目库。
 *
 * 重点在路径解析：插件报上来的 `projectPath` 有时是工程目录、有时是
 * `.uproject` 文件，只认一种的话另一种会**静默地什么都不做** —— 这类错最难发现，
 * 因为它不报错，只是工程永远不出现在首页。
 */

import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const registerProjectByUproject = vi.fn()

vi.mock('../../sqliteDataBase/ipc/project', () => ({
  registerProjectByUproject: (filePath: string) => registerProjectByUproject(filePath)
}))

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const { autoRegisterConnectedProject, resolveUprojectPath } = await import('./autoRegister')

describe('resolveUprojectPath', () => {
  let root: string
  let projectDir: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ua-auto-register-'))
    projectDir = path.join(root, 'MyGame')
    await fs.mkdir(path.join(projectDir, 'Content'), { recursive: true })
    await fs.writeFile(path.join(projectDir, 'MyGame.uproject'), '{}', 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('给工程目录时，在根目录这一层找到 .uproject', async () => {
    await expect(resolveUprojectPath(projectDir)).resolves.toBe(
      path.join(projectDir, 'MyGame.uproject')
    )
  })

  it('给 .uproject 文件时原样返回', async () => {
    const file = path.join(projectDir, 'MyGame.uproject')
    await expect(resolveUprojectPath(file)).resolves.toBe(file)
  })

  it('不往子目录里递归 —— Content 里塞着的示例工程不是这个工程', async () => {
    const nested = path.join(root, 'Wrapper')
    await fs.mkdir(path.join(nested, 'Inner'), { recursive: true })
    await fs.writeFile(path.join(nested, 'Inner', 'Inner.uproject'), '{}', 'utf-8')
    await expect(resolveUprojectPath(nested)).resolves.toBeUndefined()
  })

  it('路径不存在 / 为空 / 不是工程文件时给 undefined，不抛', async () => {
    await expect(resolveUprojectPath(path.join(root, 'nope'))).resolves.toBeUndefined()
    await expect(resolveUprojectPath('')).resolves.toBeUndefined()
    await expect(resolveUprojectPath('   ')).resolves.toBeUndefined()

    const notProject = path.join(root, 'readme.txt')
    await fs.writeFile(notProject, 'hi', 'utf-8')
    await expect(resolveUprojectPath(notProject)).resolves.toBeUndefined()
  })
})

describe('autoRegisterConnectedProject', () => {
  let root: string
  let projectDir: string

  beforeEach(async () => {
    registerProjectByUproject.mockReset()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ua-auto-register-run-'))
    projectDir = path.join(root, 'MyGame')
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'MyGame.uproject'), '{}', 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('库里没有就登记进去', async () => {
    registerProjectByUproject.mockResolvedValue({ success: true })
    await expect(autoRegisterConnectedProject(projectDir)).resolves.toBe('registered')
    expect(registerProjectByUproject).toHaveBeenCalledWith(path.join(projectDir, 'MyGame.uproject'))
  })

  it('库里已经有了就什么都不做，不建第二条记录', async () => {
    registerProjectByUproject.mockResolvedValue({ success: false, alreadyRegistered: true })
    await expect(autoRegisterConnectedProject(projectDir)).resolves.toBe('already')
  })

  it('找不到 .uproject 时不去调登记', async () => {
    await expect(autoRegisterConnectedProject(path.join(root, 'nope'))).resolves.toBe('not-found')
    expect(registerProjectByUproject).not.toHaveBeenCalled()
  })

  it('登记失败只报 failed，不往外抛 —— 连引擎是主路径，不能被入库拖垮', async () => {
    registerProjectByUproject.mockResolvedValue({ success: false, error: '数据库锁着' })
    await expect(autoRegisterConnectedProject(projectDir)).resolves.toBe('failed')
  })

  it('登记时抛异常也不会漏出去', async () => {
    registerProjectByUproject.mockRejectedValue(new Error('boom'))
    await expect(autoRegisterConnectedProject(projectDir)).resolves.toBe('failed')
  })
})
