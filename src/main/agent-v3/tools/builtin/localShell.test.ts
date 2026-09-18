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

it.each(['darwin', 'win32'] as const)('gives the %s build script in shell guidance', (platform) => {
  vi.stubGlobal('process', { ...process, platform })
  try {
    const description = createShellTool().description
    expect(description).toContain(platform === 'darwin' ? 'Mac/Build.sh' : 'Build.bat')
    if (platform === 'darwin') expect(description).not.toContain('Live Coding 开着')
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
})

describe('三个工具的风险等级', () => {
  /**
   * 它们动的是**用户自己的硬盘**，不是虚幻工程里可以重新生成的资产。
   * 标成 mutating 的话，默认的 auto-edit 模式会静默放行 —— 静默改用户源码
   * 这件事不做。这条断言是防止以后有人为了少弹几次窗把它降级。
   */
  it.each(['write_local_file', 'edit_local_file', 'run_shell_command'])(
    '%s 始终需要审批',
    (name) => {
      const tool = toolNamed(name) as unknown as { unrealBox: { risk: string } }
      expect(tool.unrealBox.risk).toBe('destructive')
    }
  )
})
