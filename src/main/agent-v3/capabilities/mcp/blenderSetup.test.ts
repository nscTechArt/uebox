import { describe, expect, it } from 'vitest'

import {
  BLENDER_MCP_REVISION,
  BLENDER_SERVER_ID,
  blenderInstallRoot,
  configuredBlenderServer,
  describeMissing,
  mergeBlenderServer,
  meetsVersion,
  MIN_BLENDER_VERSION,
  MIN_PYTHON_VERSION,
  parseBlenderEntry,
  parseVersion,
  summarizeState,
  type BlenderPrerequisite
} from './blenderSetup'
import type { McpSettings } from './types'

const ok = (id: BlenderPrerequisite['id']): BlenderPrerequisite => ({ id, ok: true })
const missing = (id: BlenderPrerequisite['id']): BlenderPrerequisite => ({
  id,
  ok: false,
  problem: 'missing'
})

describe('安装目录', () => {
  // 目录名取 revision 前 8 位，对不上就会把已经装好的那份当成「别人的目录」
  // 拒绝复用，然后在旁边再装一份
  it('目录名与两个安装脚本约定的 revision 前 8 位一致', () => {
    const win = blenderInstallRoot(
      'win32',
      { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' },
      'C:\\Users\\a'
    )
    expect(win).toContain(BLENDER_MCP_REVISION.slice(0, 8))
    expect(win).toContain('UnrealBox')
  })

  it('LOCALAPPDATA 取不到时退回 home 下的同一段路径', () => {
    const win = blenderInstallRoot('win32', {}, 'C:\\Users\\a')
    expect(win).toContain('AppData')
    expect(win).toContain(BLENDER_MCP_REVISION.slice(0, 8))
  })

  it('macOS 落在 Application Support 下，和 setup_mcp.py 的默认值一致', () => {
    const mac = blenderInstallRoot('darwin', {}, '/Users/a')
    expect(mac).toBe(
      `/Users/a/Library/Application Support/UnrealBox/BlenderMcp/${BLENDER_MCP_REVISION.slice(0, 8)}`
    )
  })
})

describe('版本解析', () => {
  it('认得出 blender --version 的输出', () => {
    expect(parseVersion('Blender 5.2.1\n\tbuild date: 2025-01-01', 'Blender')).toEqual({
      major: 5,
      minor: 2
    })
  })

  it('认得出 python --version 的输出', () => {
    expect(parseVersion('Python 3.12.4', 'Python')).toEqual({ major: 3, minor: 12 })
  })

  // 抠不出来要返回 undefined，不能当成 0.0 —— 否则「问不出版本」会被报成
  // 「版本太低」，用户去升级一个本来就够新的东西
  it('抠不出版本号时返回 undefined', () => {
    expect(parseVersion('command not found', 'Blender')).toBeUndefined()
  })

  it('按主次版本比大小', () => {
    expect(meetsVersion({ major: 5, minor: 1 }, MIN_BLENDER_VERSION)).toBe(true)
    expect(meetsVersion({ major: 5, minor: 0 }, MIN_BLENDER_VERSION)).toBe(false)
    expect(meetsVersion({ major: 6, minor: 0 }, MIN_BLENDER_VERSION)).toBe(true)
    expect(meetsVersion({ major: 3, minor: 10 }, MIN_PYTHON_VERSION)).toBe(false)
    expect(meetsVersion({ major: 3, minor: 11 }, MIN_PYTHON_VERSION)).toBe(true)
  })
})

describe('状态判定', () => {
  it('已配置优先于一切 —— 装没装过都不影响「已经能用了」', () => {
    expect(summarizeState('win32', [missing('git')], true)).toBe('configured')
  })

  it('三项齐了才是 ready', () => {
    expect(summarizeState('win32', [ok('blender'), ok('git'), ok('python')], false)).toBe('ready')
    expect(summarizeState('win32', [ok('blender'), missing('git'), ok('python')], false)).toBe(
      'blocked'
    )
  })

  it('Linux 没有安装脚本', () => {
    expect(summarizeState('linux', [ok('blender'), ok('git'), ok('python')], false)).toBe(
      'unsupported'
    )
  })
})

describe('认出已经配好的 Blender', () => {
  const withEnv = (id: string, env: Record<string, string>): McpSettings => ({
    version: 1,
    mcpServers: { [id]: { type: 'stdio', command: 'blender-mcp', env } }
  })

  it('按 BLENDER_PATH 认，不按 server 名字认，并把 id 一起带回来', () => {
    // 用户把这条改名成 blender-52 之后它仍然是一条配好的 Blender。
    // 按 id 找会让一键按钮又冒出来，点下去再装一遍
    expect(configuredBlenderServer(withEnv('blender-52', { BLENDER_PATH: 'C:\\b.exe' }))).toEqual({
      id: 'blender-52',
      path: 'C:\\b.exe'
    })
  })

  it('叫 blender 但没有 BLENDER_PATH 的不算 —— 自动拉起认不出它', () => {
    expect(configuredBlenderServer(withEnv(BLENDER_SERVER_ID, { OTHER: '1' }))).toBeUndefined()
  })

  /**
   * 判据必须和 `blenderBridgeTarget` 是同一个。非回环 host 那边是不认的，
   * 这边要是认了，界面把整块一键收起来、自动拉起又静默不挂载 ——
   * 用户得到的正是这一页反复防的那种没有任何解释的空白。
   */
  it('host 不是回环地址的不算 —— 和自动拉起同一条判据', () => {
    expect(
      configuredBlenderServer(
        withEnv('blender', { BLENDER_PATH: '/b', BLENDER_MCP_HOST: '192.168.1.20' })
      )
    ).toBeUndefined()
  })

  it('端口不合法的不算', () => {
    expect(
      configuredBlenderServer(withEnv('blender', { BLENDER_PATH: '/b', BLENDER_MCP_PORT: '99999' }))
    ).toBeUndefined()
  })

  // 停用的那条提供 0 个工具，算成「已配好」等于对着一个没有 Blender 工具的
  // 会话说「装好了」
  it('用户停用了的不算', () => {
    expect(
      configuredBlenderServer({
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
    ).toBeUndefined()
  })

  it('一条都没配时返回 undefined', () => {
    expect(configuredBlenderServer({ version: 1, mcpServers: {} })).toBeUndefined()
  })

  it('http 形态的 server 不参与判断', () => {
    expect(
      configuredBlenderServer({
        version: 1,
        mcpServers: { remote: { type: 'http', url: 'https://example.com' } }
      })
    ).toBeUndefined()
  })
})

describe('解析安装脚本写出来的 mcp-entry.json', () => {
  const entry = {
    mcpServers: {
      blender: {
        type: 'stdio',
        command: 'C:\\...\\venv\\Scripts\\blender-mcp.exe',
        args: ['--transport', 'stdio'],
        env: {
          BLENDER_MCP_HOST: '127.0.0.1',
          BLENDER_MCP_PORT: '9876',
          BLENDER_PATH: 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe'
        }
      }
    }
  }

  it('读出命令、参数和三个环境变量', () => {
    expect(parseBlenderEntry(entry)).toEqual({
      type: 'stdio',
      command: 'C:\\...\\venv\\Scripts\\blender-mcp.exe',
      args: ['--transport', 'stdio'],
      env: entry.mcpServers.blender.env
    })
  })

  // 端口在别处的配置里常写成数字。收下并转成字符串，比让用户回去改一遍强
  it('端口写成数字也收', () => {
    const numeric = {
      mcpServers: {
        blender: { command: 'x', env: { BLENDER_MCP_PORT: 9876, BLENDER_PATH: '/b' } }
      }
    }
    expect(parseBlenderEntry(numeric)).toMatchObject({
      env: { BLENDER_MCP_PORT: '9876', BLENDER_PATH: '/b' }
    })
  })

  // 缺 BLENDER_PATH 的配置写进去只是半条：自动拉起 Blender 的整段逻辑
  // 认不出它是本机 Blender，静默不挂载
  it('没有 BLENDER_PATH 的条目不算数', () => {
    expect(
      parseBlenderEntry({ mcpServers: { blender: { command: 'x', env: {} } } })
    ).toBeUndefined()
  })

  it('形状不对时返回 undefined 而不是抛', () => {
    expect(parseBlenderEntry(null)).toBeUndefined()
    expect(parseBlenderEntry({})).toBeUndefined()
    expect(parseBlenderEntry({ mcpServers: { blender: {} } })).toBeUndefined()
  })
})

describe('并进现有配置', () => {
  const incoming = { type: 'stdio' as const, command: 'new', env: { BLENDER_PATH: '/new' } }

  it('不动用户自己配的其他 server', () => {
    const before: McpSettings = {
      version: 1,
      mcpServers: { filesystem: { type: 'stdio', command: 'npx' } }
    }
    const after = mergeBlenderServer(before, incoming)
    expect(after.mcpServers.filesystem).toEqual(before.mcpServers.filesystem)
    expect(after.mcpServers[BLENDER_SERVER_ID]).toEqual(incoming)
  })

  // 重装通常意味着换了 Blender 或换了安装目录。留着旧 env 合并会得到一条
  // 「新 command + 旧 BLENDER_PATH」的缝合配置，失败的样子和装坏了一模一样
  it('同名已存在时整条换掉，不合并旧的 env', () => {
    const before: McpSettings = {
      version: 1,
      mcpServers: {
        [BLENDER_SERVER_ID]: { type: 'stdio', command: 'old', env: { BLENDER_PATH: '/old' } }
      }
    }
    expect(mergeBlenderServer(before, incoming).mcpServers[BLENDER_SERVER_ID]).toEqual(incoming)
  })

  it('但用户主动停用过的，重装不把它又打开', () => {
    const before: McpSettings = {
      version: 1,
      mcpServers: { [BLENDER_SERVER_ID]: { type: 'stdio', command: 'old', disabled: true } }
    }
    expect(mergeBlenderServer(before, incoming).mcpServers[BLENDER_SERVER_ID].disabled).toBe(true)
  })

  /**
   * 「整条换掉」只对安装脚本真的会写的 command/args/env 成立。其余几项
   * 脚本从不写，全是用户手加的 —— 尤其 `allowedTools`：官方 Blender server
   * 有 26 个工具，丢掉白名单等于 26 个 destructive 工具当场全部回来，
   * 而且没有任何提示。同 `PreservedServerFields` 那次事故。
   */
  it('界面管不到的字段原样留住', () => {
    const before: McpSettings = {
      version: 1,
      mcpServers: {
        [BLENDER_SERVER_ID]: {
          type: 'stdio',
          command: 'old',
          cwd: 'D:\\work',
          allowedTools: ['get_scene_info'],
          readOnlyTools: ['get_scene_info']
        }
      }
    }
    const after = mergeBlenderServer(before, incoming).mcpServers[BLENDER_SERVER_ID]

    expect(after.allowedTools).toEqual(['get_scene_info'])
    expect(after.readOnlyTools).toEqual(['get_scene_info'])
    expect(after).toMatchObject({ cwd: 'D:\\work', command: 'new' })
  })
})

describe('缺前置时的说法', () => {
  // 「环境不满足」等于让用户自己去猜 —— 那正是安装脚本原来的失败样子
  it('点名说缺哪个、去哪装', () => {
    const text = describeMissing([ok('blender'), missing('git'), missing('python')])
    expect(text).toContain('Git')
    expect(text).toContain('git-scm.com')
    expect(text).toContain('Python 3.11+')
    expect(text).not.toContain('Blender')
  })

  it('版本太低和没装是两句不同的话', () => {
    const text = describeMissing([
      { id: 'blender', ok: false, found: 'Blender 4.5', problem: 'too-old' }
    ])
    expect(text).toContain('Blender 4.5')
    expect(text).toContain('升级')
  })

  it('全过时返回空串', () => {
    expect(describeMissing([ok('blender'), ok('git'), ok('python')])).toBe('')
  })
})
