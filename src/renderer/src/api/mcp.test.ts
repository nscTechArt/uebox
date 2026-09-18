import { describe, expect, it } from 'vitest'

import {
  formatCommandLine,
  formatEnvText,
  isValidServerId,
  parseCommandLine,
  parseEnvText,
  toFormValues,
  toSettings
} from './mcp'

describe('parseCommandLine', () => {
  // 用户从文档复制的是一整行命令，让他手拆成 command/args 数组既反直觉又易错
  it('拆分普通命令', () => {
    expect(parseCommandLine('npx -y @modelcontextprotocol/server-filesystem')).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem']
    })
  })

  it('路径带空格时靠引号保住', () => {
    expect(parseCommandLine('node "C:/Program Files/app/server.js" --port 1')).toEqual({
      command: 'node',
      args: ['C:/Program Files/app/server.js', '--port', '1']
    })
  })

  it('单引号同样支持', () => {
    expect(parseCommandLine("sh -c 'echo hi'")).toEqual({
      command: 'sh',
      args: ['-c', 'echo hi']
    })
  })

  it('多余空白不产生空参数', () => {
    expect(parseCommandLine('  npx    -y   x  ')).toEqual({ command: 'npx', args: ['-y', 'x'] })
  })

  it('空字符串不炸', () => {
    expect(parseCommandLine('')).toEqual({ command: '', args: [] })
  })
})

describe('formatCommandLine', () => {
  it('带空格的部分补引号，复制出去能直接用', () => {
    expect(formatCommandLine('node', ['C:/Program Files/x.js'])).toBe(
      'node "C:/Program Files/x.js"'
    )
  })

  it('与 parseCommandLine 往返一致', () => {
    const line = 'npx -y "my server" --flag'
    const { command, args } = parseCommandLine(line)
    expect(formatCommandLine(command, args)).toBe(line)
  })
})

describe('parseEnvText', () => {
  it('每行一条 KEY=VALUE', () => {
    expect(parseEnvText('A=1\nB=two').env).toEqual({ A: '1', B: 'two' })
  })

  // Windows 路径里全是反斜杠和冒号，不能被当成分隔符切坏
  it('值里的等号和反斜杠原样保留', () => {
    expect(parseEnvText('BLENDER_PATH=H:\\Game\\Blender\\blender.exe\nQ=a=b').env).toEqual({
      BLENDER_PATH: 'H:\\Game\\Blender\\blender.exe',
      Q: 'a=b'
    })
  })

  it('文档里抄来的引号去掉，否则会跟着进子进程', () => {
    expect(parseEnvText('P="C:/Program Files/x.exe"').env).toEqual({
      P: 'C:/Program Files/x.exe'
    })
  })

  it('空行和 # 注释跳过', () => {
    expect(parseEnvText('\n# 说明\nA=1\n\n').env).toEqual({ A: '1' })
  })

  // 用户手上另一种来源就是 Claude Desktop / 技能文档里的 JSON 片段
  it('整块 JSON 也收，数字转成字符串', () => {
    const { env, invalid } = parseEnvText('{"BLENDER_MCP_PORT": 9876, "H": "127.0.0.1"}')
    expect(env).toEqual({ BLENDER_MCP_PORT: '9876', H: '127.0.0.1' })
    expect(invalid).toEqual([])
  })

  // 整个 bug 的根子是「悄悄丢掉」，所以读不懂的必须报出来让界面挡住保存
  it('读不成的行进 invalid，而不是被静默丢掉', () => {
    const { env, invalid } = parseEnvText('OK=1\n随便写一行\n有中文=2')
    expect(env).toEqual({ OK: '1' })
    expect(invalid).toEqual(['随便写一行', '有中文=2'])
  })

  it('JSON 语法坏了整段算无效，不去猜用户想写什么', () => {
    const { env, invalid } = parseEnvText('{"A": }')
    expect(env).toEqual({})
    expect(invalid).toHaveLength(1)
  })

  it('空输入不炸也不报错', () => {
    expect(parseEnvText('  ')).toEqual({ env: {}, invalid: [] })
  })
})

describe('formatEnvText', () => {
  it('与 parseEnvText 往返一致', () => {
    const env = { A: '1', BLENDER_PATH: 'H:\\Game\\Blender\\blender.exe' }
    expect(parseEnvText(formatEnvText(env)).env).toEqual(env)
  })

  it('首尾有空白的值补引号，往返才不变', () => {
    expect(parseEnvText(formatEnvText({ A: ' x ' })).env).toEqual({ A: ' x ' })
  })

  it('没有环境变量时是空串', () => {
    expect(formatEnvText(undefined)).toBe('')
  })
})

describe('toSettings / toFormValues', () => {
  it('stdio 条目往返一致', () => {
    const values = [
      {
        id: 'fs',
        transport: 'stdio' as const,
        commandLine: 'npx -y srv',
        url: '',
        disabled: false,
        env: '',
        preserved: {}
      }
    ]
    const settings = toSettings(values)
    expect(settings.mcpServers.fs).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'srv'] })
    expect(toFormValues(settings)).toEqual(values)
  })

  it('http 条目往返一致', () => {
    const values = [
      {
        id: 'remote',
        transport: 'http' as const,
        commandLine: '',
        url: 'https://x/mcp',
        disabled: true,
        env: '',
        preserved: {}
      }
    ]
    const settings = toSettings(values)
    expect(settings.mcpServers.remote).toEqual({
      type: 'http',
      url: 'https://x/mcp',
      disabled: true
    })
    expect(toFormValues(settings)).toEqual(values)
  })

  /**
   * 这一条是本次事故的回归测试。
   *
   * 界面原来只认四个字段，保存时把其余的全丢了 —— 用户手写进 mcp.json 的
   * BLENDER_PATH 被抹掉，自动拉起 Blender 的逻辑因此认不出这是本机 Blender，
   * 静默不挂载。表现是「配了，没生效，没人说」。
   */
  it('界面管不到的字段原样带回磁盘', () => {
    const settings = {
      version: 1 as const,
      mcpServers: {
        blender: {
          type: 'stdio' as const,
          command: 'blender-mcp.exe',
          args: ['--transport', 'stdio'],
          env: { BLENDER_PATH: 'H:\\Game\\Blender\\blender.exe' },
          cwd: 'H:/work',
          allowedTools: ['execute_blender_code'],
          readOnlyTools: ['get_objects_summary']
        }
      }
    }
    expect(toSettings(toFormValues(settings))).toEqual(settings)
  })

  it('http 的 headers 同样不丢', () => {
    const settings = {
      version: 1 as const,
      mcpServers: {
        remote: {
          type: 'http' as const,
          url: 'https://x/mcp',
          headers: { Authorization: 'Bearer t' },
          allowedTools: ['a']
        }
      }
    }
    expect(toSettings(toFormValues(settings))).toEqual(settings)
  })

  // 换连接方式时，另一形态专属的字段跟着串过去会写出一条自相矛盾的配置
  it('改成 http 后不带上 stdio 专属的 cwd 和环境变量', () => {
    const [value] = toFormValues({
      version: 1,
      mcpServers: {
        x: { type: 'stdio', command: 'srv', env: { A: '1' }, cwd: 'H:/work' }
      }
    })
    const settings = toSettings([{ ...value, transport: 'http', url: 'https://x/mcp' }])
    expect(settings.mcpServers.x).toEqual({ type: 'http', url: 'https://x/mcp' })
  })

  // 写一条坏配置进去，用户下次打开会看到一个连不上又不知道为什么的 server
  it('跳过填不全的条目', () => {
    const blank = { url: '', disabled: false, env: '', preserved: {} }
    const settings = toSettings([
      { id: '', transport: 'stdio', commandLine: 'x', ...blank },
      { id: 'no-command', transport: 'stdio', commandLine: '   ', ...blank },
      { id: 'no-url', transport: 'http', commandLine: '', ...blank }
    ])
    expect(settings.mcpServers).toEqual({})
  })
})

describe('isValidServerId', () => {
  // serverId 会成为工具名的一部分，非法字符会让整个模型请求被厂商拒掉
  it.each([
    ['filesystem', true],
    ['my-server_2', true],
    ['有中文', false],
    ['with space', false],
    ['with.dot', false],
    ['', false],
    ['x'.repeat(33), false]
  ])('%s → %s', (id, valid) => {
    expect(isValidServerId(id)).toBe(valid)
  })
})
