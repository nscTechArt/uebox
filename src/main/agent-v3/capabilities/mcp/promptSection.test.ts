/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { BLENDER_INSTALLABLE, buildMcpSection, installableIntegrations } from './promptSection'
import type { McpServerStatus } from './types'

const connected = (id: string, toolCount = 3): McpServerStatus => ({
  id,
  connected: true,
  toolCount,
  serverName: `${id}-server`
})

const failed = (id: string, error: string): McpServerStatus => ({
  id,
  connected: false,
  toolCount: 0,
  error
})

const disabled = (id: string): McpServerStatus => ({
  id,
  connected: false,
  toolCount: 0,
  disabled: true
})

describe('MCP 状态进系统提示词', () => {
  // 没有 MCP 管理器 = 不知道，不是「一个都没配」。一个字都不该说
  it('没有 MCP 管理器时一个字都不输出', () => {
    expect(buildMcpSection()).toBe('')
    expect(buildMcpSection(undefined, [BLENDER_INSTALLABLE])).toBe('')
  })

  // 有管理器但列表是空的：可能真没配，也可能是发现流程失败被吞了。
  // 所以措辞是「没有连上的」，不是「你一个都没配」
  it('列表为空且没有可装的东西时也不输出', () => {
    expect(buildMcpSection([])).toBe('')
  })

  /**
   * 模型最容易把「还没连」说成「做不到」：真机上用户说「我装了 Blender，
   * 连一下」，它回「我没有连 Blender 的工具」，而设置页里就摆着一键接入。
   *
   * **这段话不能挂在「一条 server 都没有」上。** `statuses` 里还混着引擎
   * 自动发现的和插件带来的 server，开着 UE 5.8 工程的用户长度不为 0 ——
   * 而他正是会来问这句话的人。
   */
  it('可以一键装的东西，不管已经连着几个 server 都要说', () => {
    const texts = [
      buildMcpSection([], [BLENDER_INSTALLABLE]),
      buildMcpSection([connected('ue-official', 3)], [BLENDER_INSTALLABLE])
    ]
    for (const text of texts) {
      expect(text).toContain('Settings → MCP can install these')
      expect(text).toContain('Blender')
      // 不能只说「没有」就完了 —— 那正是模型自己的默认反应
      expect(text).toContain('do NOT tell the user such a capability is impossible')
    }
  })

  describe('算哪些东西现在真能一键装', () => {
    // Linux 也是发行目标。在那儿把模型指到一个不存在的按钮前面，
    // 和原来说「做不到」一样是假话，只是换了个方向
    it('没有安装脚本的平台上不提', () => {
      expect(installableIntegrations([], 'linux')).toEqual([])
    })

    it('Windows 和 macOS 上提', () => {
      expect(installableIntegrations([], 'win32')).toEqual([BLENDER_INSTALLABLE])
      expect(installableIntegrations([], 'darwin')).toEqual([BLENDER_INSTALLABLE])
    })

    // 已经连上了就不必再提「可以装」，describe 那几行已经把工具数讲清楚了
    it('已经连上的就不再提', () => {
      expect(installableIntegrations([connected('blender', 26)], 'win32')).toEqual([])
    })

    it('配了但没连上的照样提 —— 那正是要修的状态', () => {
      expect(installableIntegrations([failed('blender', 'boom')], 'win32')).toEqual([
        BLENDER_INSTALLABLE
      ])
    })
  })

  /**
   * 再接一台现在是模型自己能办的事（`connect_mcp_server`），但开着工具搜索时
   * 它不常驻 —— 模型不知道有这个东西可搜的时候不会去搜，于是又回到那句
   * 「我没有连接 MCP 的能力」。
   */
  it('告诉模型可以自己接一台，以及新工具下一条消息才到', () => {
    const texts = [buildMcpSection([]), buildMcpSection([connected('filesystem', 7)])]
    for (const text of texts) {
      if (text === '') continue
      expect(text).toContain('connect_mcp_server')
      expect(text).toContain('NEXT user message')
    }
    // 连着 server 的那份一定非空，上面的 continue 不能把这条测试掏空
    expect(buildMcpSection([connected('filesystem', 7)])).toContain('connect_mcp_server')
  })

  it('连上的 server 报出 id、工具数和工具名前缀', () => {
    const text = buildMcpSection([connected('filesystem', 7)])
    expect(text).toContain('`filesystem`')
    expect(text).toContain('7 tool(s)')
    expect(text).toContain('mcp_filesystem_')
  })

  it('全部连上时不追加那段纠错指示 —— 没有可纠的错', () => {
    const text = buildMcpSection([connected('a'), connected('b')])
    expect(text).not.toContain('FAILED')
    expect(text).not.toContain('do NOT say you lack the capability')
  })

  /**
   * 这条是整个改动要守的东西。
   *
   * 连不上的时候模型看不到 `mcp_filesystem_*`，默认反应是回一句
   * 「我没有访问文件系统的能力」—— 那是假话，用户会照着这个方向白排查。
   */
  it('有 server 连不上时，明确禁止模型答「我没有这个能力」', () => {
    const text = buildMcpSection([failed('filesystem', 'spawn npx ENOENT')])
    expect(text).toContain('FAILED TO CONNECT')
    expect(text).toContain('do NOT say you lack the capability')
    expect(text).toContain('Settings → MCP')
  })

  // 失败原因是用户唯一能拿去排查的东西，必须原样带上
  it('失败原因原样出现在提示词里', () => {
    expect(buildMcpSection([failed('x', 'spawn npx ENOENT')])).toContain('spawn npx ENOENT')
  })

  it('没给原因时也不能印出 undefined', () => {
    const text = buildMcpSection([{ id: 'x', connected: false, toolCount: 0 }])
    expect(text).toContain('no reason reported')
    expect(text).not.toContain('undefined')
  })

  /**
   * 「用户自己停用的」和「连不上」是两回事。
   * 混为一谈会让用户去排查一个根本不存在的连接故障。
   */
  it('停用的 server 说成停用，不说成连接失败', () => {
    const text = buildMcpSection([disabled('filesystem')])
    expect(text).toContain('disabled by the user')
    expect(text).not.toContain('FAILED TO CONNECT')
  })

  it('停用的同样要触发那段纠错指示 —— 它一样是「本该有却没有」', () => {
    expect(buildMcpSection([disabled('x')])).toContain('do NOT say you lack the capability')
  })

  it('混合状态时每个 server 各报各的', () => {
    const text = buildMcpSection([connected('ok', 2), failed('bad', 'timeout'), disabled('off')])
    expect(text).toContain('`ok`')
    expect(text).toContain('connected, 2 tool(s)')
    expect(text).toContain('`bad`')
    expect(text).toContain('timeout')
    expect(text).toContain('`off`')
    expect(text).toContain('disabled by the user')
  })
})

/**
 * 引擎内置 server 的用法说明。
 *
 * 不讲清楚就等于没接：模型只看到 3 个工具名，猜不到后面还挂着约 900 个，
 * 会直接判定「这个 server 没什么用」然后再也不碰。
 */
describe('UE 5.8 官方工具集那一段', () => {
  it('连上时讲清两段式用法和背后的规模', () => {
    const text = buildMcpSection([connected('ue-official', 3)])
    expect(text).toContain('list_toolsets')
    expect(text).toContain('describe_toolset')
    expect(text).toContain('call_tool')
    expect(text).toContain('900')
  })

  it('明确要求先查 list_toolsets 再下「没有这个能力」的结论', () => {
    const text = buildMcpSection([connected('ue-official', 3)])
    expect(text).toContain('Do not conclude a capability is missing')
  })

  it('定死优先级：能用内建 ue.* 就别绕道引擎工具集', () => {
    // 同一件事两条路时模型会左右摇摆，而内建工具跨版本测过、
    // 接了资产快照和撤销，默认该走那边
    expect(buildMcpSection([connected('ue-official', 3)])).toContain('`ue.*`')
  })

  it('多项目时带项目名后缀的 id 同样认得出来', () => {
    expect(buildMcpSection([connected('ue-official-MyGame', 3)])).toContain('list_toolsets')
  })

  it('没有引擎内置 server 时一个字都不多说', () => {
    const text = buildMcpSection([connected('filesystem', 7)])
    expect(text).not.toContain('list_toolsets')
  })

  // 名字像但不是的，不能误触发
  it('前缀相近的第三方 id 不触发', () => {
    expect(buildMcpSection([connected('ue-officially-mine', 3)])).not.toContain('list_toolsets')
  })

  // 连不上的时候讲用法没有意义，该走的是 FAILED 那条路径
  it('连不上时不讲用法', () => {
    const text = buildMcpSection([failed('ue-official', 'ECONNREFUSED')])
    expect(text).not.toContain('list_toolsets')
    expect(text).toContain('FAILED TO CONNECT')
  })
})
