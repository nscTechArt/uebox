import { describe, expect, it, vi } from 'vitest'

import {
  blenderBridgeTarget,
  createBlenderLauncher,
  isBridgeDownMessage,
  type BlenderLaunchDeps
} from './blenderBridge'
import type { McpServerConfig } from './types'

const blenderConfig = (env: Record<string, string> = {}): McpServerConfig => ({
  type: 'stdio',
  command: 'C:\\env\\Scripts\\blender-mcp.exe',
  args: ['--transport', 'stdio'],
  env: {
    BLENDER_MCP_HOST: '127.0.0.1',
    BLENDER_MCP_PORT: '9876',
    BLENDER_PATH: 'H:\\Game\\Blender\\blender.exe',
    ...env
  }
})

describe('blenderBridgeTarget', () => {
  it('按 BLENDER_PATH 认出本机 Blender server', () => {
    expect(blenderBridgeTarget(blenderConfig())).toEqual({
      host: '127.0.0.1',
      port: 9876,
      exe: 'H:\\Game\\Blender\\blender.exe'
    })
  })

  it('只配了 BLENDER_PATH 时，主机和端口用官方默认值', () => {
    const config: McpServerConfig = {
      type: 'stdio',
      command: 'blender-mcp',
      env: { BLENDER_PATH: 'H:\\Game\\Blender\\blender.exe' }
    }
    expect(blenderBridgeTarget(config)).toMatchObject({ host: '127.0.0.1', port: 9876 })
  })

  // 判据是 BLENDER_PATH 而不是 server 叫什么：名字是用户随手起的
  it('普通 server 不认', () => {
    expect(
      blenderBridgeTarget({ type: 'stdio', command: 'npx', args: ['-y', 'foo'] })
    ).toBeUndefined()
  })

  it('http server 不认 —— 那种形态下没有可执行文件给我们拉', () => {
    expect(blenderBridgeTarget({ type: 'http', url: 'https://example.com/mcp' })).toBeUndefined()
  })

  // 别人机器上的 Blender，我们既拉不起来也不该去拉
  it('非回环地址不认', () => {
    expect(blenderBridgeTarget(blenderConfig({ BLENDER_MCP_HOST: '192.168.1.20' }))).toBeUndefined()
  })

  it('端口写坏了不认，而不是拿 NaN 去连', () => {
    expect(blenderBridgeTarget(blenderConfig({ BLENDER_MCP_PORT: '不是数字' }))).toBeUndefined()
    expect(blenderBridgeTarget(blenderConfig({ BLENDER_MCP_PORT: '99999' }))).toBeUndefined()
  })
})

describe('isBridgeDownMessage', () => {
  it('认出官方的连接被拒文案', () => {
    expect(
      isBridgeDownMessage(
        'Cannot connect to Blender at 127.0.0.1:9876. Ensure Blender is running with the MCP addon enabled and the server started.'
      )
    ).toBe(true)
    expect(isBridgeDownMessage('Empty response from Blender')).toBe(true)
  })

  // 超时表示结果未知，重试可能把一次几何修改做两遍
  it('超时不算桥断 —— 不能拿它当重试的理由', () => {
    expect(isBridgeDownMessage('Blender connection timed out at 127.0.0.1:9876')).toBe(false)
  })

  it('普通业务错误不误伤', () => {
    expect(isBridgeDownMessage('AttributeError: bpy.ops.mesh has no attribute foo')).toBe(false)
  })
})

/** 造一套全假的依赖，默认「端口不通、Blender 没开、文件在、插件一切正常」 */
function makeDeps(overrides: Partial<BlenderLaunchDeps> = {}): BlenderLaunchDeps & {
  launch: ReturnType<typeof vi.fn>
} {
  let clock = 0
  return {
    probe: vi.fn().mockResolvedValue('closed'),
    isRunning: vi.fn().mockResolvedValue(false),
    launch: vi.fn(),
    exists: vi.fn().mockReturnValue(true),
    diagnose: vi.fn().mockResolvedValue({ installed: true, enabled: true, online: true }),
    now: () => clock,
    sleep: vi.fn(async (ms: number) => {
      clock += ms
    }),
    ...overrides
  } as BlenderLaunchDeps & { launch: ReturnType<typeof vi.fn> }
}

describe('createBlenderLauncher', () => {
  it('不是本机 Blender 的 server 拿不到启动器', () => {
    expect(createBlenderLauncher({ type: 'stdio', command: 'npx' })).toBeUndefined()
  })

  it('端口已经通就什么都不做', async () => {
    const deps = makeDeps({ probe: vi.fn().mockResolvedValue('bridge') })
    const ensure = createBlenderLauncher(blenderConfig(), deps)!

    expect(await ensure()).toEqual({ ok: true, launched: false })
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it('端口不通就拉起 Blender，等到桥通了才算成功', async () => {
    // 第一次探不通（触发启动），起来后第三次探通
    const probe = vi
      .fn()
      .mockResolvedValueOnce('closed')
      .mockResolvedValueOnce('closed')
      .mockResolvedValue('bridge')
    const deps = makeDeps({ probe })
    const ensure = createBlenderLauncher(blenderConfig(), deps)!

    expect(await ensure()).toEqual({ ok: true, launched: true })
    expect(deps.launch).toHaveBeenCalledWith('H:\\Game\\Blender\\blender.exe')
  })

  // 再开一个窗口解决不了问题，只会让用户桌面上多一个 Blender
  it('Blender 开着但桥没起：不重复启动，直接给出可执行的解法', async () => {
    const deps = makeDeps({ isRunning: vi.fn().mockResolvedValue(true) })
    const ensure = createBlenderLauncher(blenderConfig(), deps)!

    const outcome = await ensure()
    expect(outcome.ok).toBe(false)
    expect(deps.launch).not.toHaveBeenCalled()
    if (!outcome.ok) {
      expect(outcome.reason).toContain('Start Server')
      // 兜底路径要一并告诉模型：批处理本来就不需要这座桥
      expect(outcome.reason).toContain('execute_blender_code_for_cli')
    }
  })

  it('可执行文件不在就报路径，而不是默默失败', async () => {
    const deps = makeDeps({ exists: vi.fn().mockReturnValue(false) })
    const ensure = createBlenderLauncher(blenderConfig(), deps)!

    const outcome = await ensure()
    expect(outcome.ok).toBe(false)
    expect(deps.launch).not.toHaveBeenCalled()
    if (!outcome.ok) expect(outcome.reason).toContain('H:\\Game\\Blender\\blender.exe')
  })

  it('启动了但桥一直不通：报超时并给出兜底路径', async () => {
    const deps = makeDeps()
    const ensure = createBlenderLauncher(blenderConfig(), deps)!

    const outcome = await ensure()
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('execute_blender_code_for_cli')
  })

  // 模型会连着重试；没有冷却就会一次开出好几个 Blender
  it('失败后进入冷却期，不会反复拉起', async () => {
    const deps = makeDeps()
    const ensure = createBlenderLauncher(blenderConfig(), deps)!

    await ensure()
    expect(deps.launch).toHaveBeenCalledTimes(1)

    const again = await ensure()
    expect(again.ok).toBe(false)
    expect(deps.launch).toHaveBeenCalledTimes(1)
  })

  // 端口被别的程序占着时插件绑不上，再开 Blender 也没用
  describe('端口上不是 Blender', () => {
    it('一上来就发现端口被别人占：不启动，直接说换端口', async () => {
      const deps = makeDeps({ probe: vi.fn().mockResolvedValue('foreign') })
      const outcome = await createBlenderLauncher(blenderConfig(), deps)!()

      expect(outcome.ok).toBe(false)
      expect(deps.launch).not.toHaveBeenCalled()
      if (!outcome.ok) expect(outcome.reason).toContain('BLENDER_MCP_PORT')
    })

    // 插件绑不上端口时 Blender 照样起得来，轮询会看到那个占位的程序
    it('启动后才发现端口被占：不把它当成启动成功', async () => {
      const deps = makeDeps({
        probe: vi.fn().mockResolvedValueOnce('closed').mockResolvedValue('foreign')
      })
      const outcome = await createBlenderLauncher(blenderConfig(), deps)!()

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toContain('不是 Blender 的 MCP 桥')
    })
  })

  // 真机踩过的坑：四层链路断哪一层，症状都只有一句 Cannot connect to Blender
  describe('失败时说清楚断在哪一层', () => {
    const reasonOf = async (deps: BlenderLaunchDeps): Promise<string> => {
      const outcome = await createBlenderLauncher(blenderConfig(), deps)!()
      return outcome.ok ? '' : outcome.reason
    }

    it('插件没装：直接说没装，并指到 setup 脚本', async () => {
      const reason = await reasonOf(
        makeDeps({
          diagnose: vi.fn().mockResolvedValue({ installed: false, enabled: false, online: true })
        })
      )
      expect(reason).toContain('没装')
      expect(reason).toContain('setup_mcp.ps1')
    })

    it('装了没启用：说去勾启用，不叫人重装', async () => {
      const reason = await reasonOf(
        makeDeps({
          diagnose: vi.fn().mockResolvedValue({ installed: true, enabled: false, online: true })
        })
      )
      expect(reason).toContain('没启用')
      expect(reason).not.toContain('setup_mcp.ps1')
    })

    // 整条链路里最隐蔽的一环：默认关着，用户双击开的 Blender 基本都连不上
    it('用户自己开的 Blender 没开在线访问：点名这一项', async () => {
      const reason = await reasonOf(
        makeDeps({
          isRunning: vi.fn().mockResolvedValue(true),
          diagnose: vi.fn().mockResolvedValue({ installed: true, enabled: true, online: false })
        })
      )
      expect(reason).toContain('在线访问')
      expect(reason).toContain('--online-mode')
    })

    // 盒子自己拉的那个带了 --online-mode，这一项不可能是原因，别误导
    it('盒子自己拉的失败时不赖到在线访问头上', async () => {
      const reason = await reasonOf(
        makeDeps({
          diagnose: vi.fn().mockResolvedValue({ installed: true, enabled: true, online: false })
        })
      )
      expect(reason).not.toContain('在线访问')
      expect(reason).toContain('控制台')
    })

    it('问不出状态就承认问不出，不瞎猜', async () => {
      const reason = await reasonOf(makeDeps({ diagnose: vi.fn().mockResolvedValue(undefined) }))
      expect(reason).toContain('问不出')
    })
  })

  // MCP 工具是 parallel 模式，同一时刻可能有好几个调用一起踩到桥断
  it('并发调用只拉起一个 Blender', async () => {
    const probe = vi.fn().mockResolvedValueOnce('closed').mockResolvedValue('bridge')
    const deps = makeDeps({ probe })
    const ensure = createBlenderLauncher(blenderConfig(), deps)!

    const [a, b] = await Promise.all([ensure(), ensure()])

    expect(a).toEqual({ ok: true, launched: true })
    expect(b).toEqual({ ok: true, launched: true })
    expect(deps.launch).toHaveBeenCalledTimes(1)
  })
})
