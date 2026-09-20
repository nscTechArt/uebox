import { beforeEach, describe, expect, it, vi } from 'vitest'
import { adaptV2Tool } from '../../adaptV2Tool'
import { createRunPythonScriptTool } from './runPythonScript'
import { runEditorPython } from '../../../core/editorPython'

vi.mock('../../../core/editorPython', () => ({ runEditorPython: vi.fn() }))
vi.mock('../../builtin/pathBoundary', () => ({ assertScriptAllowed: () => undefined }))

const mockRun = vi.mocked(runEditorPython)

const adapted = (): ReturnType<typeof adaptV2Tool> =>
  adaptV2Tool(createRunPythonScriptTool(), {
    name: 'ue_run_python_script',
    namespace: 'ue-system',
    risk: 'destructive'
  })

/** 失败走 isError 那条路，适配器会抛出来 —— 接住拿文本 */
const errorTextOf = async (input: unknown): Promise<string> => {
  try {
    await adapted().execute('test', input)
    return '(没有抛出)'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

beforeEach(() => {
  mockRun.mockReset()
})

describe('ue_run_python_script', () => {
  it('经过真实适配器后模型仍能看到失败前的回读诊断', async () => {
    mockRun.mockResolvedValue({
      success: false,
      error: '布尔失败',
      stdout: 'source_closed=False; before=2'
    })
    await expect(adapted().execute('test', { script: 'pass' })).rejects.toThrow(
      'source_closed=False; before=2'
    )
  })

  /**
   * 排查指引只该出现在「没确认上」那一档。
   *
   * 脚本自己抛异常时，下一步是改脚本再跑；而超时/丢结果时连「跑没跑」都不知道，
   * 重发可能把同一个修改做两遍。两种情况给同一段话，等于把「别重发」这个最要紧的
   * 提示稀释掉。指引拼在这一层而不是 runEditorPython 里，是因为那个 error
   * 还有两条路会原样弹给用户看，而这段话点名了一个用户调不到的工具。
   */
  it('没确认上时补排查指引', async () => {
    mockRun.mockResolvedValue({
      success: false,
      unconfirmed: true,
      error: 'Python 执行未确认（改材质）：timeout。请先回读，勿重复执行修改。'
    })

    const text = await errorTextOf({ script: 'pass' })
    expect(text).toContain('ue_session_health')
    expect(text).toContain('不要再发命令试探')
  })

  it('脚本自己报错时不补排查指引', async () => {
    mockRun.mockResolvedValue({
      success: false,
      error: 'NameError: name “foo” is not defined'
    })

    const text = await errorTextOf({ script: 'foo()' })
    expect(text).toContain('NameError')
    expect(text).not.toContain('ue_session_health')
  })

  /** 用户自己按的停止，不是引擎卡了 —— 不能冲他喊「请重启编辑器」 */
  it('中止时按 aborted 处理，不补排查指引', async () => {
    mockRun.mockResolvedValue({
      success: false,
      aborted: true,
      unconfirmed: true,
      error: '已停止等待（改材质）：已停止等待。编辑器里的脚本可能仍在执行，先回读再操作。'
    })

    const text = await errorTextOf({ script: 'pass' })
    expect(text).toContain('先回读再操作')
    expect(text).not.toContain('请用户重启编辑器')
  })
})
