/**
 * @vitest-environment node
 *
 * `ue_get_project_info` 要报出插件的构建指纹。
 *
 * 这条是从一次真实的白跑里长出来的：插件代码改完但没出包，回归测试跑在旧
 * DLL 上，得出「修复未生效」的结论，接下来整整一轮排查都在找一个不存在的 bug。
 * 插件版本号救不了这个场景——它几个月才动一次，改十次代码它都不变。
 *
 * 所以验证插件改动的第一步必须是「确认跑着的是不是我刚编的那份」，
 * 而这需要工具把指纹摆出来。旧插件不返回这个字段时也要说话，
 * 因为「字段缺失」本身就是「插件是旧的」这个结论。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

// 随包 zip 里的指纹。真实实现要读 Electron 的 app 目录，测试里给一个固定值
vi.mock('../../../../utils/UnrealPathManager', () => ({
  default: { readBundledPluginFingerprint: vi.fn(() => 'bundled-fp') }
}))

import { createGetProjectInfoTool } from './getProjectInfo'

const BASE_RESPONSE = {
  projectName: 'MyGame',
  projectPath: 'H:/Dev/MyGame',
  projectFile: 'H:/Dev/MyGame/MyGame.uproject',
  contentDir: 'H:/Dev/MyGame/Content',
  configDir: 'H:/Dev/MyGame/Config',
  savedDir: 'H:/Dev/MyGame/Saved',
  pluginsDir: 'H:/Dev/MyGame/Plugins',
  engineVersion: '5.5.4'
}

type Executable = {
  execute: (id: string, input: unknown) => Promise<Record<string, unknown>>
}

const run = async (extra: Record<string, unknown>): Promise<Record<string, unknown>> => {
  callRequest.mockResolvedValue({ ...BASE_RESPONSE, ...extra })
  const tool = createGetProjectInfoTool() as unknown as Executable
  return await tool.execute('c1', { include_disabled_plugins: false })
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('ue_get_project_info 的插件构建指纹', () => {
  it('插件报了指纹就原样透出来', async () => {
    const result = await run({ pluginBuild: '651ef506e38bebbb' })

    expect(result.pluginBuild).toBe('651ef506e38bebbb')
  })

  /**
   * 缺字段不能静默成 undefined —— 那样读的人看不出「这里本来该有个值」，
   * 会默认插件是新的然后接着往下测。
   */
  it('旧插件不报这个字段时，明说它是旧的', async () => {
    const result = await run({})

    expect(String(result.pluginBuild)).toContain('插件较旧')
  })

  it('其余字段照常返回，没被这次改动影响', async () => {
    const result = await run({ pluginBuild: 'abc123' })

    expect(result.success).toBe(true)
    expect(result.projectName).toBe('MyGame')
    expect(result.engineVersion).toBe('5.5.4')
  })
})

/**
 * 引擎与源码位置。
 *
 * 这四个字段是给「写 UE C++」用的：没有 `engineSourceDir`，模型想核对一个 UE API
 * 的真实签名时不知道该往哪儿 grep，只能凭记忆写 —— 而 UE 的 API 在 5.0–5.8 之间
 * 会漂。`hasCode` 则是一条保命判断：纯蓝图工程走引擎的建类路会弹模态对话框，
 * 而命令跑在游戏线程上，弹出来就是编辑器和调用一起卡死。
 */
describe('ue_get_project_info 的引擎与源码位置', () => {
  it('插件报了就原样透出来', async () => {
    const result = await run({
      engineDir: 'D:/UE_5.5/Engine/',
      engineSourceDir: 'D:/UE_5.5/Engine/Source/',
      projectSourceDir: 'H:/Dev/MyGame/Source/',
      hasCode: true
    })

    expect(result.engineDir).toBe('D:/UE_5.5/Engine/')
    expect(result.engineSourceDir).toBe('D:/UE_5.5/Engine/Source/')
    expect(result.projectSourceDir).toBe('H:/Dev/MyGame/Source/')
    expect(result.hasCode).toBe(true)
  })

  it('纯蓝图工程的 hasCode=false 要如实传下去，不能被当成缺失', async () => {
    const result = await run({ hasCode: false })

    expect(result.hasCode).toBe(false)
  })

  /**
   * 老插件不返回这几个字段时**留空**，不要猜一个路径出来。
   *
   * 猜出来的路径模型会拿去 grep，然后拿到「目录不存在」，再花一轮猜下一个。
   * 说「不知道」比猜错便宜。这里和上面 pluginBuild 的处理**故意不一样**：
   * 那个字段缺失本身是有意义的结论（「插件是旧的」），值得写一句话；
   * 路径缺失没有等价的结论可讲，填一句中文进去反而会被当成路径用。
   */
  it('老插件不报这几个字段时留空，不编造路径', async () => {
    const result = await run({})

    expect(result.engineDir).toBeUndefined()
    expect(result.engineSourceDir).toBeUndefined()
    expect(result.projectSourceDir).toBeUndefined()
    expect(result.hasCode).toBeUndefined()
  })
})

/**
 * 插件新不新、Python 能不能用，会话开头就要讲清楚。
 *
 * 新用户那一轮：装的插件比盒子自带的旧，Python 因此永远失败，模型把一整段时间
 * 花在改 .uproject、重启编辑器上。这两个字段让它第一次问工程信息时就知道
 * 该绕开什么、该让用户更新什么。
 */
describe('ue_get_project_info 的插件新旧与 Python 可用性', () => {
  it('指纹和随包一致：up to date，不啰嗦', async () => {
    const result = await run({ pluginBuild: 'bundled-fp' })

    expect(result.pluginUpToDate).toBe(true)
    expect(result.pluginHint).toBeUndefined()
    expect(String(result.message)).not.toContain('更新插件')
  })

  it('指纹对不上：明说插件旧了，让用户去设置里更新', async () => {
    const result = await run({ pluginBuild: 'stale-fp' })

    expect(result.pluginUpToDate).toBe(false)
    expect(String(result.pluginHint)).toContain('更新插件')
    expect(String(result.message)).toContain('更新插件')
  })

  it('连指纹都不报的老插件也算旧', async () => {
    const result = await run({})

    expect(result.pluginUpToDate).toBe(false)
    expect(String(result.pluginHint)).toContain('更新插件')
  })

  it('插件报 "unknown"（没有构建戳）是无法判断，不是旧，别让用户重装', async () => {
    const result = await run({ pluginBuild: 'unknown' })

    expect(result.pluginUpToDate).toBeUndefined()
    expect(String(result.pluginHint)).toContain('无法判断')
    expect(String(result.message)).not.toContain('更新插件')
  })

  it('引擎没 Python 时直说，别让模型去启插件重启编辑器', async () => {
    const result = await run({ pluginBuild: 'bundled-fp', pythonAvailable: false })

    expect(result.pythonAvailable).toBe(false)
    expect(String(result.pythonHint)).toContain('ue_run_python_script')
    expect(String(result.message)).toContain('Python')
  })

  it('有 Python 就只报 true，不加提示', async () => {
    const result = await run({ pluginBuild: 'bundled-fp', pythonAvailable: true })

    expect(result.pythonAvailable).toBe(true)
    expect(result.pythonHint).toBeUndefined()
  })
})
