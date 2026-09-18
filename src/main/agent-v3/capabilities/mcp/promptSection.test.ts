/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { buildMcpSection } from './promptSection'
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
  // 一个 server 都没配的用户占多数，不该为一件不存在的事付 token
  it('没配过任何 server 时一个字都不输出', () => {
    expect(buildMcpSection([])).toBe('')
    expect(buildMcpSection()).toBe('')
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
