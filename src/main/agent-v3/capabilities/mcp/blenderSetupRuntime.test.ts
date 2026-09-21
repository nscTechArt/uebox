import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'blender-setup-'))

vi.mock('electron', () => ({
  app: { getPath: (): string => root, isPackaged: false, getAppPath: (): string => root }
}))

import { inspectBlenderSetup, runBlenderSetup } from './blenderSetupRuntime'
import { mcpSettingsPath, writeMcpSettings } from './store'
import { blenderInstallRoot } from './blenderSetup'

afterAll(() => rmSync(root, { recursive: true, force: true }))

const linux = { platform: 'linux' as NodeJS.Platform, env: {}, home: root }
const windows = { platform: 'win32' as NodeJS.Platform, env: { LOCALAPPDATA: root }, home: root }

/**
 * 假安装器。
 *
 * **不能让测试真去跑 `setup_mcp.ps1`。** 第一版没有这个注入口，于是任何
 * 装了 git 和 Python 的机器（几乎所有开发机和 CI）跑到这两个用例时都会
 * 真的 `execFile('powershell', …)`，真的 `git fetch` 官方仓库、真的建 venv
 * 跑 pip —— 挂在一个 15 分钟的超时下面，而断言两边都过，所以没有任何东西
 * 会报出来。
 */
function fakeInstaller(
  write?: () => void,
  stdout = 'BLMCP_ONLINE=True\n'
): {
  runInstaller: () => Promise<string>
  calls: number
} {
  const fake = {
    calls: 0,
    runInstaller: async (): Promise<string> => {
      fake.calls += 1
      write?.()
      return stdout
    }
  }
  return fake
}

/** 安装脚本装完会写的那份配置 */
function writeEntryFile(installRoot: string, blenderPath: string): void {
  mkdirSync(installRoot, { recursive: true })
  writeFileSync(join(installRoot, 'installed-revision.txt'), 'x\n', 'utf8')
  writeFileSync(
    join(installRoot, 'mcp-entry.json'),
    JSON.stringify({
      mcpServers: {
        blender: {
          type: 'stdio',
          command: join(installRoot, 'venv', 'Scripts', 'blender-mcp.exe'),
          args: ['--transport', 'stdio'],
          env: {
            BLENDER_MCP_HOST: '127.0.0.1',
            BLENDER_MCP_PORT: '9876',
            BLENDER_PATH: blenderPath
          }
        }
      }
    }),
    'utf8'
  )
}

beforeEach(async () => {
  rmSync(blenderInstallRoot('win32', { LOCALAPPDATA: root }, root), {
    recursive: true,
    force: true
  })
  await writeMcpSettings({ version: 1, mcpServers: {} })
})

describe('检查现状', () => {
  // 配好之后 git 和 Python 就不再需要了（server 跑在自己的 venv 里）。
  // 这时候还去探、还报「缺 git」，用户会以为配置坏了
  it('已经配过就直接返回 configured，不再探依赖', async () => {
    await writeMcpSettings({
      version: 1,
      mcpServers: {
        anything: { type: 'stdio', command: 'blender-mcp', env: { BLENDER_PATH: '/b' } }
      }
    })

    const status = await inspectBlenderSetup(linux)
    expect(status.state).toBe('configured')
    expect(status.configuredBlenderPath).toBe('/b')
    // 界面要拿这个 id 去查这条连上没有
    expect(status.configuredServerId).toBe('anything')
    expect(status.prerequisites).toEqual([])
  })

  /**
   * 停用的那条提供 0 个工具（`McpClientManager` 的 connectAll 把它滤掉），
   * 把它算成「已配好」等于对着一个没有任何 Blender 工具的会话说「装好了」。
   */
  it('停用的那条不算已配好', async () => {
    await writeMcpSettings({
      version: 1,
      mcpServers: {
        blender: {
          type: 'stdio',
          command: 'blender-mcp',
          env: { BLENDER_PATH: '/b' },
          disabled: true
        }
      }
    })

    expect((await inspectBlenderSetup(linux)).state).not.toBe('configured')
  })

  /**
   * 非回环的 host `blenderBridgeTarget` 是不认的（自动拉起会静默不挂载）。
   * 这边要是认了，界面就把整块收起来，用户得到一片没有任何解释的空白。
   */
  it('host 不是回环地址时不算已配好 —— 那条自动拉起也认不出来', async () => {
    await writeMcpSettings({
      version: 1,
      mcpServers: {
        blender: {
          type: 'stdio',
          command: 'blender-mcp',
          env: { BLENDER_PATH: '/b', BLENDER_MCP_HOST: '192.168.1.20' }
        }
      }
    })

    expect((await inspectBlenderSetup(linux)).state).not.toBe('configured')
  })

  it('没有安装脚本的平台报 unsupported，而不是让用户白点按钮', async () => {
    const status = await inspectBlenderSetup(linux)
    expect(status.state).toBe('unsupported')
  })

  it('支持的平台上把三项前置都查一遍', async () => {
    const status = await inspectBlenderSetup(windows)
    expect(status.prerequisites.map((item) => item.id)).toEqual(['blender', 'git', 'python'])
    // 这台机器上有什么不确定，但状态只可能是这两种之一
    expect(['ready', 'blocked']).toContain(status.state)
  })

  /**
   * 探到的 Python 必须是绝对路径。
   *
   * `setup_mcp.ps1` 拿到它之后做 `Resolve-Path -LiteralPath`，那个命令
   * **不查 PATH** —— 递一个 `python` 过去，脚本在第 20 行就抛，而界面
   * 刚刚才说「Python 3.12 ✓」。整个 Windows 一键安装就是这么从来没成功过的。
   */
  it('探到 Python 时给的是绝对路径，不是 PATH 上的名字', async () => {
    const python = (await inspectBlenderSetup(windows)).prerequisites.find(
      (item) => item.id === 'python'
    )
    // 这台机器上有没有 Python 不确定；有的话路径必须是绝对的
    if (python?.ok) {
      expect(python.path).toBeDefined()
      expect(['python', 'python3', 'py']).not.toContain(python.path)
      expect(python.path?.length).toBeGreaterThan('python3'.length)
    }
  })

  it('安装目录跟着传进来的环境走', async () => {
    const status = await inspectBlenderSetup(windows)
    expect(status.installRoot.startsWith(root)).toBe(true)
  })
})

describe('一键安装的拒绝路径', () => {
  it('平台不支持时不跑脚本，并说清楚哪两个平台有', async () => {
    const fake = fakeInstaller()
    const result = await runBlenderSetup({}, linux, fake)
    expect(result.success).toBe(false)
    expect(result.message).toContain('Windows')
    expect(fake.calls).toBe(0)
  })

  // 用户给的路径不存在是最常见的手填错误。直接跑脚本的话，报错会是
  // PowerShell 的 Resolve-Path 异常，用户读不出「路径写错了」
  it('指定的 Blender 不存在时点名说那个位置没有文件', async () => {
    const fake = fakeInstaller()
    const result = await runBlenderSetup({ blenderPath: join(root, 'nope.exe') }, windows, fake)
    expect(result.success).toBe(false)
    expect(result.message).toContain('nope.exe')
    expect(fake.calls).toBe(0)
  })

  /**
   * 重装是插件装坏之后唯一的修复路径，不能被「已经配过了」挡掉。
   *
   * 真踩过的坑：`inspectBlenderSetup` 在已配置时短路成 `prerequisites: []`，
   * 而 `runBlenderSetup` 原来拿那个返回值当前置检查 —— **空列表里当然找不到
   * Python**，于是每一次重装都稳定地失败在「没找到 Python 3.11+」，
   * 而那台机器上 Python 好好装着。所以它现在自己探一次。
   */
  it('已经配过的机器上重装，前置判断和没配过时一模一样', async () => {
    const exe = join(root, 'blender.exe')
    writeFileSync(exe, '')
    const installRoot = blenderInstallRoot('win32', { LOCALAPPDATA: root }, root)

    const fresh = await runBlenderSetup(
      { blenderPath: exe },
      windows,
      fakeInstaller(() => writeEntryFile(installRoot, exe))
    )

    await writeMcpSettings({
      version: 1,
      mcpServers: { blender: { type: 'stdio', command: 'x', env: { BLENDER_PATH: '/b' } } }
    })
    const repair = await runBlenderSetup(
      { blenderPath: exe },
      windows,
      fakeInstaller(() => writeEntryFile(installRoot, exe))
    )

    // 这台机器上有没有 git / Python 不确定，所以不断言具体是哪种结果；
    // 断言的是**已配置这件事不该改变前置判断** —— 短路那版在这里会得到
    // 一个只在「已经配过」时出现的「没找到 Python 3.11+」
    expect(repair.error).toBe(fresh.error)
  })
})

describe('写配置', () => {
  const exe = join(root, 'blender.exe')
  const installRoot = blenderInstallRoot('win32', { LOCALAPPDATA: root }, root)

  /** 跳过前置检查：直接看装完之后配置写成了什么样 */
  async function installOnce(stdout?: string): Promise<{ success: boolean; message: string }> {
    writeFileSync(exe, '')
    return runBlenderSetup(
      { blenderPath: exe },
      windows,
      fakeInstaller(() => writeEntryFile(installRoot, exe), stdout)
    )
  }

  function diskServers(): Record<string, Record<string, unknown>> {
    return JSON.parse(readFileSync(mcpSettingsPath(), 'utf8')).mcpServers
  }

  /**
   * `readMcpSettings` 会丢掉 id 不合规的条目（只留一行 warn）。读回来再整份
   * 写出去，丢弃就变成了删除 —— 用户从 Claude Desktop 抄来的那条没了，
   * 而 `mergeBlenderServer` 的说明里写着「用户自己配的其他 server 原样保留」。
   */
  it('不删 id 不合规的那些手写条目', async () => {
    const raw = {
      version: 1,
      mcpServers: {
        'github.com/foo': { type: 'stdio', command: 'npx', args: ['-y', 'foo'] }
      }
    }
    const { promises: fs } = await import('fs')
    await fs.writeFile(mcpSettingsPath(), JSON.stringify(raw, null, 2), 'utf8')

    const result = await installOnce()
    if (!result.success) return // 这台机器缺 git/Python，装不了，跳过

    expect(diskServers()['github.com/foo']).toBeDefined()
    expect(diskServers().blender).toBeDefined()
  })

  /**
   * 官方 Blender server 有 26 个工具，手写白名单是唯一的收敛办法。
   * 重装（= 修一修）把它抹掉的话，26 个 destructive 工具当场全部回来，
   * 而且没有任何提示。
   */
  it('重装保住手写的 allowedTools 和停用标记', async () => {
    await writeMcpSettings({
      version: 1,
      mcpServers: {
        blender: {
          type: 'stdio',
          command: 'old',
          allowedTools: ['get_scene_info'],
          readOnlyTools: ['get_scene_info'],
          disabled: true
        }
      }
    })

    const result = await installOnce()
    if (!result.success) return

    const blender = diskServers().blender
    expect(blender.allowedTools).toEqual(['get_scene_info'])
    expect(blender.readOnlyTools).toEqual(['get_scene_info'])
    expect(blender.disabled).toBe(true)
    // 脚本真会写的那三项照样换成新的
    expect(blender.command).not.toBe('old')
  })
})

/**
 * 「允许在线访问」默认是关的，而插件把开桥当联机行为，关着就拒绝监听端口。
 *
 * 盒子自己拉 Blender 带 `--online-mode`，走盒子这条路不受影响；但用户装完
 * 的下一件事常常是**自己双击打开 Blender**，那个 Blender 永远没有桥。
 * 安装脚本在装完那一秒就读回过这项状态 —— 原先 stdout 被整个扔掉，于是
 * 这个已知的事实要等到第一次工具调用失败才由 `blenderBridge` 兜底说出来。
 */
describe('装完就把「允许在线访问」是关的说出来', () => {
  const exe = join(root, 'blender.exe')
  const installRoot = blenderInstallRoot('win32', { LOCALAPPDATA: root }, root)

  async function installWith(stdout: string): Promise<{ success: boolean; message: string }> {
    writeFileSync(exe, '')
    return runBlenderSetup(
      { blenderPath: exe },
      windows,
      fakeInstaller(() => writeEntryFile(installRoot, exe), stdout)
    )
  }

  it('关着的时候在成功回执里点名，并说清两条出路', async () => {
    const result = await installWith('Add-on verified.\nBLMCP_ONLINE=False\n')
    if (!result.success) return // 这台机器缺 git/Python，装不了，跳过

    expect(result.message).toContain('允许在线访问')
    expect(result.message).toContain('网络')
  })

  it('开着的时候不啰嗦', async () => {
    const result = await installWith('Add-on verified.\nBLMCP_ONLINE=True\n')
    if (!result.success) return

    expect(result.message).not.toContain('允许在线访问')
  })

  /**
   * 脚本最后那句 `Add the generated server entry in Box MCP settings` 是写给
   * 手动装的人看的 —— 盒子已经替用户填完了，原样透传会让他再去手填一遍。
   * 所以这里不转发 stdout，只取 `BLMCP_ONLINE` 这一个事实。
   */
  it('不把脚本的 stdout 原样转给用户', async () => {
    const result = await installWith(
      'BLMCP_ONLINE=False\nAdd the generated server entry in Box MCP settings and reconnect.\n'
    )
    if (!result.success) return

    expect(result.message).not.toContain('Box MCP settings')
  })
})

describe('装到一半留下的目录', () => {
  const exe = join(root, 'blender.exe')
  const installRoot = blenderInstallRoot('win32', { LOCALAPPDATA: root }, root)

  /**
   * 断掉的安装会留下一个没有 `installed-revision.txt` 的目录，脚本从此
   * 每次都抛「Choose a new directory」—— 而盒子根本没有「换一个目录」这个
   * 入口。不清掉的话按钮就永久卡死。
   */
  it('认得出的残留自己清掉，安装照常往下走', async () => {
    writeFileSync(exe, '')
    mkdirSync(join(installRoot, 'source'), { recursive: true })

    const fake = fakeInstaller(() => writeEntryFile(installRoot, exe))
    const result = await runBlenderSetup({ blenderPath: exe }, windows, fake)

    if (result.message.includes('还差这些')) return // 缺 git/Python，到不了这一步
    expect(fake.calls).toBe(1)
  })

  // 脚本拒绝复用陌生目录的理由是对的（可能是别人的文件），所以不无脑删
  it('夹着不认识的文件就不动它，改成告诉用户路径', async () => {
    writeFileSync(exe, '')
    mkdirSync(installRoot, { recursive: true })
    writeFileSync(join(installRoot, '我的论文.docx'), '')

    const fake = fakeInstaller()
    const result = await runBlenderSetup({ blenderPath: exe }, windows, fake)

    if (result.message.includes('还差这些')) return
    expect(result.success).toBe(false)
    expect(result.message).toContain(installRoot)
    expect(result.message).toContain('我的论文.docx')
    expect(fake.calls).toBe(0)
  })
})
