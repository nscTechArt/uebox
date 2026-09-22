/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import {
  buildCandidates,
  formatFailure,
  formatSuccess,
  httpUrlCandidates,
  validateServerId
} from './addServer'
import { isHttpConfig } from './types'

describe('地址怎么猜', () => {
  // 用户说的就是「端口 9876」。要求他给完整 URL 等于把问题原样推回去 ——
  // 路径藏在 server 的 README 里，他多半也不知道
  it('只给端口号：先试事实标准的 /mcp，再试根路径', () => {
    expect(httpUrlCandidates('9876')).toEqual([
      'http://127.0.0.1:9876/mcp',
      'http://127.0.0.1:9876/'
    ])
  })

  it('主机加端口同样补全', () => {
    expect(httpUrlCandidates('localhost:9876')).toEqual([
      'http://localhost:9876/mcp',
      'http://localhost:9876/'
    ])
  })

  // `localhost:9876` 长得就像「协议 + 内容」。先认主机端口的那一步要是漏了，
  // 这里会被当成一个叫 localhost 的协议，然后整条路径静默失败
  it('像协议头的主机名不会被当成协议', () => {
    for (const url of httpUrlCandidates('localhost:9876')) {
      expect(url.startsWith('http://localhost:9876')).toBe(true)
    }
  })

  it('没写协议的主机名补 http', () => {
    expect(httpUrlCandidates('example.com')).toEqual([
      'http://example.com/mcp',
      'http://example.com/'
    ])
  })

  // 他知道自己的 server 挂在哪。替他改路径只会让报错指向一个他没说过的地址
  it('用户自己写了路径就只试那一条', () => {
    expect(httpUrlCandidates('http://127.0.0.1:9876/api/mcp')).toEqual([
      'http://127.0.0.1:9876/api/mcp'
    ])
  })

  it('https 原样保留', () => {
    expect(httpUrlCandidates('https://mcp.example.com/v1')).toEqual(['https://mcp.example.com/v1'])
  })

  // 盒子只会说 HTTP(S)。在这儿挡掉比让 SDK 抛一句看不懂的传输层错误强
  it('非 http 协议不接', () => {
    expect(httpUrlCandidates('ws://127.0.0.1:9876')).toEqual([])
    expect(httpUrlCandidates('file:///tmp/x')).toEqual([])
  })

  it('空串和看不懂的写法回空', () => {
    expect(httpUrlCandidates('   ')).toEqual([])
    expect(httpUrlCandidates('http://')).toEqual([])
  })
})

describe('标识校验', () => {
  // 它会成为工具名的一部分，厂商要求 ^[a-zA-Z0-9_-]{1,64}$
  it('放行合法标识', () => {
    expect(validateServerId('filesystem')).toBeUndefined()
    expect(validateServerId('my-server_2')).toBeUndefined()
  })

  it('挡住带非法字符和超长的', () => {
    expect(validateServerId('my server')).toContain('不合法')
    expect(validateServerId('github.com/foo')).toContain('不合法')
    expect(validateServerId('x'.repeat(33))).toContain('不合法')
    expect(validateServerId('')).toContain('不合法')
  })
})

describe('请求 → 候选配置', () => {
  it('command 走 stdio，args / env / cwd 原样带上', () => {
    const built = buildCandidates({
      id: 'fs',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/assets'],
      env: { TOKEN: 'x' },
      cwd: 'D:/work'
    })
    if ('error' in built) throw new Error(built.error)

    expect(built.candidates).toHaveLength(1)
    const config = built.candidates[0].config
    if (isHttpConfig(config)) throw new Error('应该是 stdio')
    expect(config).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/assets'],
      env: { TOKEN: 'x' },
      cwd: 'D:/work'
    })
    // 报给用户看的是完整命令行，不是光秃秃一个 npx
    expect(built.candidates[0].target).toContain('server-filesystem')
  })

  it('url 走 http，只给端口时给出两条候选', () => {
    const built = buildCandidates({ id: 'x', url: '9876', headers: { Authorization: 'Bearer t' } })
    if ('error' in built) throw new Error(built.error)

    expect(built.candidates.map((c) => c.target)).toEqual([
      'http://127.0.0.1:9876/mcp',
      'http://127.0.0.1:9876/'
    ])
    for (const candidate of built.candidates) {
      expect(candidate.config).toMatchObject({
        type: 'http',
        headers: { Authorization: 'Bearer t' }
      })
    }
  })

  it('allowedTools 带进每一条候选 —— 工具太多被拒时靠它收窄', () => {
    const built = buildCandidates({ id: 'x', url: '9876', allowedTools: ['a'] })
    if ('error' in built) throw new Error(built.error)
    for (const candidate of built.candidates) {
      expect(candidate.config.allowedTools).toEqual(['a'])
    }
  })

  // 替用户挑一种的话，他会连上一个没打算连的东西，而报告里看不出做过选择
  it('两种形态都给了就不替他挑', () => {
    const built = buildCandidates({ id: 'x', url: '9876', command: 'npx' })
    expect('error' in built && built.error).toContain('只能选一种')
  })

  it('两种形态都没给时说清楚该给什么', () => {
    const built = buildCandidates({ id: 'x' })
    expect('error' in built && built.error).toContain('command')
  })

  it('标识不合法时根本不去试连接', () => {
    const built = buildCandidates({ id: 'bad id', url: '9876' })
    expect('error' in built && built.error).toContain('不合法')
  })

  it('空白参数当没给', () => {
    const built = buildCandidates({ id: 'x', command: '   ', url: '  ' })
    expect('error' in built && built.error).toContain('既没有 url 也没有 command')
  })
})

describe('成功了怎么说', () => {
  const base = {
    id: 'fs',
    target: 'npx -y server-filesystem',
    toolCount: 3,
    toolNames: ['mcp_fs_read', 'mcp_fs_write', 'mcp_fs_list'],
    settingsPath: 'C:/u/mcp.json'
  }

  it('报出工具数、前缀和配置落点', () => {
    const text = formatSuccess(base)
    expect(text).toContain('fs')
    expect(text).toContain('3 个工具')
    expect(text).toContain('mcp_fs_')
    expect(text).toContain('C:/u/mcp.json')
  })

  /**
   * 这条是整块改动要守的东西。
   *
   * 工具清单每条消息开头装配一次，接进来的工具本轮不在清单里。不明说的话，
   * 模型下一步就去调 `mcp_fs_read`，拿到「工具不存在」，然后把一次成功的
   * 接入报成失败 —— 用户以为白忙了，其实配置已经好了。
   */
  it('明确说清楚工具本轮还不能调', () => {
    const text = formatSuccess(base)
    expect(text).toContain('本轮还不在你手里')
    expect(text).toContain('下一条消息')
  })

  it('工具太多时只列前几个，但把总数说清楚', () => {
    const many = Array.from({ length: 30 }, (_, i) => `mcp_fs_t${i}`)
    const text = formatSuccess({ ...base, toolCount: 30, toolNames: many })
    expect(text).toContain('还有 18 个')
    expect(text).not.toContain('mcp_fs_t29')
  })

  // 连上了但没写成盘：这一轮是真能用的，谎称失败更糟；但"重启后就没了"必须说
  it('写盘失败时不谎称成功，也不谎称失败', () => {
    const text = formatSuccess({ ...base, persistError: 'EACCES' })
    expect(text).toContain('EACCES')
    expect(text).toContain('重启')
    expect(text).not.toContain('下次启动会自动连上')
  })

  it('server 自报的名字带上，没有时不印 undefined', () => {
    expect(formatSuccess({ ...base, serverName: 'echo', serverVersion: '1.2' })).toContain(
      'echo 1.2'
    )
    expect(formatSuccess(base)).not.toContain('undefined')
  })
})

describe('失败了怎么说', () => {
  const text = formatFailure('x', [
    { target: 'http://127.0.0.1:9876/mcp', error: 'fetch failed' },
    { target: 'http://127.0.0.1:9876/', error: '连接超时' }
  ])

  // 用户唯一能拿去排查的就是这两行
  it('试过的每一条地址和各自的原因都原样列出', () => {
    expect(text).toContain('http://127.0.0.1:9876/mcp')
    expect(text).toContain('fetch failed')
    expect(text).toContain('连接超时')
  })

  it('说清楚盘上什么都没留 —— 可以放心重试', () => {
    expect(text).toContain('没有写入')
  })

  // 用户的原话就是「端口 9876」，而 9876 恰好是 Blender 插件自己的通道。
  // 不点破的话模型的下一步通常是换个端口再试，那次一样不会通
  it('点破「端口通不等于那是 MCP 端点」和 stdio 才是主流', () => {
    expect(text).toContain('端口通不代表')
    expect(text).toContain('stdio')
  })
})
