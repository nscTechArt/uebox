/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  connectionFromEnv,
  hostConfigCandidates,
  isLoopbackHost,
  readCliConfig,
  readHostConfig,
  writeCliConfig
} from './config.js'
import { exitCodeFor, type UeboxError } from './errors.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(name = 'uebox-'): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), name))
  dirs.push(dir)
  return dir
}

describe('hostConfigCandidates', () => {
  /**
   * 开发版和正式安装包的 userData 目录名不一样：前者是 package.json 的
   * `name`，后者是 electron-builder 的 `productName`。两个都得查。
   */
  it('查两个明确候选，不扫用户目录', () => {
    const candidates = hostConfigCandidates({ APPDATA: 'C:/Users/x/AppData/Roaming' })

    expect(candidates).toHaveLength(2)
    expect(candidates.some((p) => p.includes('unreal-box'))).toBe(true)
    expect(candidates.some((p) => p.includes('虚幻盒子'))).toBe(true)
    expect(candidates.every((p) => p.endsWith('mcp-server.json'))).toBe(true)
  })
})

describe('readHostConfig', () => {
  it('从端口拼出回环地址，并取出令牌', async () => {
    const dir = await tempDir()
    const path = join(dir, 'mcp-server.json')
    await fs.writeFile(path, JSON.stringify({ enabled: true, port: 17861, token: 'abc123' }))

    expect(await readHostConfig(path)).toMatchObject({
      url: 'http://127.0.0.1:17861/',
      token: 'abc123'
    })
  })

  /** Windows 上用记事本存出来的 JSON 默认带 BOM，不摘掉的话 JSON.parse 直接抛 */
  it('带 BOM 的配置也读得了', async () => {
    const dir = await tempDir()
    const path = join(dir, 'mcp-server.json')
    await fs.writeFile(path, `\uFEFF${JSON.stringify({ port: 17861, token: 'abc' })}`, 'utf8')

    expect((await readHostConfig(path)).token).toBe('abc')
  })

  it('文件不在时报 CONFIG_MISSING 并给出下一步', async () => {
    const dir = await tempDir()
    try {
      await readHostConfig(join(dir, 'nope.json'))
      expect.unreachable('应该抛出')
    } catch (error) {
      expect((error as UeboxError).code).toBe('CONFIG_MISSING')
      expect((error as UeboxError).hint).toContain('--host-config')
    }
  })

  /**
   * 真机上被一个外部 Agent（Codex，沙箱里读不到 %APPDATA%）撞出来的：
   * 「读不了」被一律报成「还没有配置过」+「先运行 setup」，于是它照着提示
   * 反复怀疑盒子没装没启动，绕了一大圈。
   *
   * 「文件不在」和「我不许看」要走完全不同的下一步。
   */
  it('路径是目录（存在但读不了）时报 CONFIG_UNREADABLE，不谎称没配置过', async () => {
    const dir = await tempDir()
    try {
      await readHostConfig(dir)
      expect.unreachable('应该抛出')
    } catch (error) {
      const failed = error as UeboxError
      expect(failed.code).toBe('CONFIG_UNREADABLE')
      expect(failed.message).not.toContain('还没有配置过')
      expect(failed.message).toContain('目录')
    }
  })

  it('两种配置错误的退出码都是 3 —— 只看退出码的脚本行为不变', () => {
    expect(exitCodeFor('CONFIG_MISSING')).toBe(3)
    expect(exitCodeFor('CONFIG_UNREADABLE')).toBe(3)
  })

  /** 坏配置报错，**不重建** —— 那个文件是盒子的，越权去写可能把用户的令牌换掉 */
  it('内容坏掉时报 CONFIG_INVALID，不自行重建', async () => {
    const dir = await tempDir()
    const path = join(dir, 'mcp-server.json')
    await fs.writeFile(path, '{ 这不是 JSON')

    await expect(readHostConfig(path)).rejects.toThrow(/不是合法 JSON/)
    // 文件必须原封不动
    expect(await fs.readFile(path, 'utf8')).toBe('{ 这不是 JSON')
  })

  it('没有令牌时明确报出来', async () => {
    const dir = await tempDir()
    const path = join(dir, 'mcp-server.json')
    await fs.writeFile(path, JSON.stringify({ port: 17861, token: '   ' }))

    await expect(readHostConfig(path)).rejects.toThrow(/没有访问令牌/)
  })
})

describe('connectionFromEnv', () => {
  it('两个都没设时返回 undefined，走配置文件', () => {
    expect(connectionFromEnv({})).toBeUndefined()
  })

  /**
   * 从一个来源取地址、另一个来源取令牌，等于把令牌发给一个没人核对过的地址。
   * 所以只设一个是配置错误，不是「另一半去文件里找」。
   */
  it('只设一个时报错，不去文件里补另一半', () => {
    expect(() => connectionFromEnv({ UEBOX_URL: 'http://127.0.0.1:1/' })).toThrow(/必须同时提供/)
    expect(() => connectionFromEnv({ UEBOX_TOKEN: 'x' })).toThrow(/必须同时提供/)
  })

  it('成对时用它，并标明来源不是文件', () => {
    const connection = connectionFromEnv({
      UEBOX_URL: 'http://127.0.0.1:17861/',
      UEBOX_TOKEN: 'tok'
    })

    expect(connection).toMatchObject({ token: 'tok' })
    // 来源里不能出现令牌本身
    expect(connection?.source).not.toContain('tok')
  })

  /** 盒子只监听回环。出现别的地址只可能是配错或被人改过，不能把令牌发过去 */
  it('非回环地址一律拒绝', () => {
    for (const url of ['http://192.168.1.5:17861/', 'http://example.com/', 'https://10.0.0.1/']) {
      expect(() => connectionFromEnv({ UEBOX_URL: url, UEBOX_TOKEN: 'tok' })).toThrow(/回环/)
    }
  })

  it('localhost 和 ::1 都算回环', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('192.168.1.5')).toBe(false)
  })
})

describe('CLI 配置', () => {
  it('只存路径引用，不存令牌', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config.json')
    await writeCliConfig(path, { version: 1, hostConfigPath: 'C:/box/mcp-server.json' })

    const text = await fs.readFile(path, 'utf8')
    expect(JSON.parse(text)).toEqual({ version: 1, hostConfigPath: 'C:/box/mcp-server.json' })
    expect(text).not.toContain('token')
  })

  it('带中文和空格的路径能存能读', async () => {
    const dir = await tempDir('uebox 中文-')
    const path = join(dir, 'config.json')
    const hostConfigPath = 'D:/我的 工程/虚幻盒子/mcp-server.json'

    await writeCliConfig(path, { version: 1, hostConfigPath })
    expect((await readCliConfig(path)).hostConfigPath).toBe(hostConfigPath)
  })

  it('没配置过时报 CONFIG_MISSING 并让人去 setup', async () => {
    const dir = await tempDir()
    try {
      await readCliConfig(join(dir, 'config.json'))
      expect.unreachable('应该抛出')
    } catch (error) {
      expect((error as UeboxError).code).toBe('CONFIG_MISSING')
      expect((error as UeboxError).hint).toContain('uebox setup')
    }
  })

  it('缺 hostConfigPath 的配置算损坏', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config.json')
    await fs.writeFile(path, JSON.stringify({ version: 1 }))

    await expect(readCliConfig(path)).rejects.toThrow(/hostConfigPath/)
  })

  /** 写到一半断电留下半个 JSON 的话，下次运行看到的是「配置损坏」 */
  it('写入是原子的，不留临时文件', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config.json')
    await writeCliConfig(path, { version: 1, hostConfigPath: 'C:/a.json' })

    expect(await fs.readdir(dir)).toEqual(['config.json'])
  })
})
