import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { createLocalWriteTools, createShellTool } from './localShell'

/**
 * 这里只测**被挡住**的那一半。
 *
 * 放行的那一半没法在单元测试里跑 —— 真放行就等于在测试机上执行命令、写文件。
 * 而这三个工具的边界检查全在 `inner.execute` 之前，挡住的路径根本碰不到
 * 底层实现，所以这样测是可信的：断言的正是「有没有走到那一步」。
 */
interface ExecutableTool {
  execute: (id: string, params: unknown) => Promise<{ isError?: boolean; content?: unknown[] }>
}

const toolNamed = (name: string): ExecutableTool => {
  const all = [...createLocalWriteTools(), createShellTool()]
  return all.find((t) => t.name === name) as unknown as ExecutableTool
}

const textOf = (result: { content?: unknown[] }): string =>
  ((result.content?.[0] as { text?: string })?.text ?? '') as string

it.each(['darwin', 'win32'] as const)('points %s full rebuilds at cpp_full_rebuild', (platform) => {
  vi.stubGlobal('process', { ...process, platform })
  try {
    const description = createShellTool().description
    // 完整重编走 cpp_full_rebuild，不再教模型自己拼 Build 脚本、让用户关编辑器
    expect(description).toContain('cpp_full_rebuild')
    expect(description).not.toContain('先请用户关掉编辑器')
    if (platform === 'darwin') expect(description).not.toContain('Live Coding 开着')
    else expect(description).toContain('Live Coding 开着')
  } finally {
    vi.unstubAllGlobals()
  }
})

/**
 * 真正的洞：写文件那边锁着的门，跑命令这边从旁边走过去就是了。
 * 原因是 `wrap()` 当时收的是 `guardPath: boolean`，而命令没有 path 参数，
 * 于是顺理成章地填了 false。
 */
describe('run_shell_command 的敏感位置边界', () => {
  it.each([
    'cat ~/.ssh/id_rsa',
    'cat $HOME/.aws/credentials',
    'cd ~ && cat .netrc',
    'ls "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data"'
  ])('拒绝执行 %s', async (command) => {
    const result = await toolNamed('run_shell_command').execute('call-1', { command })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/命令/)
  })

  // 拒绝要说清楚「别改写路径再试」，否则模型会换引号、换 $HOME、拆成多条
  it('拒绝时明说不要改写重试', async () => {
    const result = await toolNamed('run_shell_command').execute('call-1', {
      command: 'cat ~/.ssh/id_rsa'
    })

    expect(textOf(result)).toMatch(/不要改写路径再试/)
  })
})

describe('写文件工具的敏感位置边界', () => {
  it.each(['write_local_file', 'edit_local_file'])('%s 不给往凭据目录写', async (name) => {
    const result = await toolNamed(name).execute('call-1', {
      path: 'C:/Users/me/.ssh/authorized_keys',
      content: 'x',
      edits: [{ oldText: 'a', newText: 'b' }]
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/不允许访问/)
  })
  // 盒子自己的配置能读不能写：写进去等于 agent 绕过设置页给自己换权限
  it.each(['write_local_file', 'edit_local_file'])('%s 不给改盒子自己的配置', async (name) => {
    const result = await toolNamed(name).execute('call-1', {
      path: 'C:/Users/me/AppData/Roaming/unreal-box/app-settings.json',
      content: '{}',
      edits: [{ oldText: 'a', newText: 'b' }]
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/设置页/)
  })
})

describe('三个工具的风险等级', () => {
  /**
   * 写 / 改文件有改前改后快照，按 mutating 走（auto-edit 下放行）；
   * 命令没有快照兜得住，始终要问。这条断言防止以后有人为了少弹几次窗把命令降级。
   */
  it.each([
    ['write_local_file', 'mutating'],
    ['edit_local_file', 'mutating'],
    ['run_shell_command', 'destructive']
  ])('%s 的风险等级是 %s', (name, risk) => {
    const tool = toolNamed(name) as unknown as { unrealBox: { risk: string } }
    expect(tool.unrealBox.risk).toBe(risk)
  })
})

describe('建工程提醒不拦路', () => {
  // 写在临时目录里：放行就是真写，正是要断言的那件事
  it('write_local_file 写 .uproject 照常写入，结果后面带上 create_project 提醒', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const dir = mkdtempSync(join(tmpdir(), 'ual-uproject-'))
    try {
      const file = join(dir, 'MyGame.uproject')
      const result = await toolNamed('write_local_file').execute('call-1', {
        path: file,
        content: '{"FileVersion": 3}'
      })

      expect(result.isError).toBeFalsy()
      expect(readFileSync(file, 'utf8')).toBe('{"FileVersion": 3}')
      const texts = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '')
      expect(texts.at(-1)).toContain('create_project')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
